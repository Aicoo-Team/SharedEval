#!/usr/bin/env bash
# Builds the run-level experiment image from committed state only.
#
#   - SharedEval tree: `git archive HEAD` into a temp build context under
#     $HOME (colima-safe), never the working tree. Pinned, shallow git
#     metadata for exactly HEAD is reconstructed inside the context so the
#     runner's clean-tracked-checkout gate holds inside the image and
#     sourceRevision reports the true commit.
#   - SharedOS: the checkout is verified against the pinned revision (clean,
#     with packages/*/dist present), staged minus .git, and stamped with
#     sharedos-provenance.json (commit + runtime digest) computed by the
#     repo's own loader code. Everything fails closed.
#   - SHAREDEVAL_MODEL_API_KEY is never read, baked, or logged here.
#
# Usage:
#   scripts/experiments/build-image.sh [--tag <image ref>] [--sharedos-dir <dir>]
# Prints a single-line JSON summary (including the image digest) on success.
set -euo pipefail

SHAREDOS_PINNED_REVISION="ac0f1bb210baa3ba4b7e0d0baaf2291bbe9ffd05"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

die() {
  printf 'build-image: %s\n' "$1" >&2
  exit 1
}

tag=""
sharedos_dir="${SHAREDEVAL_SHAREDOS_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || die '--tag requires a value'
      tag="$2"
      shift 2
      ;;
    --sharedos-dir)
      [ $# -ge 2 ] || die '--sharedos-dir requires a value'
      sharedos_dir="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "${HOME:-}" ] || die 'HOME is not set'
command -v docker >/dev/null 2>&1 || die 'docker is required'
command -v node >/dev/null 2>&1 || die 'node is required'
command -v npx >/dev/null 2>&1 || die 'npx is required'
command -v git >/dev/null 2>&1 || die 'git is required'

head="$(git -C "$repo_root" rev-parse --verify HEAD)" || die 'unable to resolve repository HEAD'
[ -n "$tag" ] || tag="sharedeval-experiment:${head:0:12}"
[ -n "$sharedos_dir" ] || sharedos_dir="$repo_root/../SharedOS"
[ -d "$sharedos_dir" ] || die "SharedOS directory not found: $sharedos_dir"
sharedos_dir="$(cd "$sharedos_dir" && pwd)"

# --- verify the SharedOS checkout (fail closed) -----------------------------
[ -e "$sharedos_dir/.git" ] || die "SharedOS directory is not a git checkout: $sharedos_dir"
sharedos_revision="$(git -C "$sharedos_dir" rev-parse --verify HEAD)" \
  || die 'unable to resolve SharedOS HEAD'
[ "$sharedos_revision" = "$SHAREDOS_PINNED_REVISION" ] \
  || die "SharedOS revision mismatch: expected $SHAREDOS_PINNED_REVISION, found $sharedos_revision"
[ -z "$(git -C "$sharedos_dir" status --porcelain --untracked-files=no)" ] \
  || die 'SharedOS checkout has tracked local changes; refusing an unverified runtime'
for package in contracts core os runtime; do
  [ -f "$sharedos_dir/packages/$package/package.json" ] \
    || die "SharedOS package $package is missing package.json"
  [ -f "$sharedos_dir/packages/$package/dist/index.js" ] \
    || die "SharedOS package $package has no dist build; run 'pnpm install --frozen-lockfile && pnpm build' at the pinned revision"
done

# --- assemble the build context under $HOME ---------------------------------
context="$(mktemp -d "$HOME/.sharedeval-experiment-build.XXXXXX")" \
  || die 'unable to create build context under $HOME'
cleanup() {
  rm -rf "$context"
}
trap cleanup EXIT

mkdir "$context/sharedeval" "$context/sharedos"

# Committed SharedEval tree only: git archive of HEAD, never the worktree.
git -C "$repo_root" archive --format=tar "$head" | tar -xf - -C "$context/sharedeval"

# Reconstruct pinned, shallow git metadata for exactly HEAD: the commit object
# plus its full tree closure, packed locally (no transport, no history). The
# runner requires `git rev-parse HEAD` == a real revision and a clean tracked
# status; this makes both hold inside the image for the true commit hash.
git -C "$context/sharedeval" init -q -b experiment-image
{
  echo "$head"
  git -C "$repo_root" rev-parse "$head^{tree}"
  git -C "$repo_root" ls-tree -r -t "$head" | awk '{ print $3 }'
} | git -C "$repo_root" pack-objects -q --stdout > "$context/sharedeval-objects.pack"
git -C "$context/sharedeval" unpack-objects -q < "$context/sharedeval-objects.pack"
rm -f "$context/sharedeval-objects.pack"
git -C "$context/sharedeval" update-ref refs/heads/experiment-image "$head"
echo "$head" > "$context/sharedeval/.git/shallow"
git -C "$context/sharedeval" read-tree "$head"
[ -z "$(git -C "$context/sharedeval" status --porcelain --untracked-files=no)" ] \
  || die 'archived tree does not match HEAD (check .gitattributes export rules)'

# --- stage the SharedOS build (tracked tree + build outputs, minus .git) ----
tar -C "$sharedos_dir" --exclude=.git -cf - . | tar -xf - -C "$context/sharedos"
(cd "$repo_root" && npx --no-install tsx \
  scripts/experiments/stage-sharedos-provenance.ts "$context/sharedos") \
  || die 'SharedOS provenance staging failed (run npm ci first?)'
runtime_digest="$(node -p \
  'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).runtimeDigest' \
  "$context/sharedos/sharedos-provenance.json")"

# --- build ------------------------------------------------------------------
docker build \
  --file "$repo_root/docker/experiments/Dockerfile" \
  --build-arg "SHAREDEVAL_SOURCE_REVISION=$head" \
  --build-arg "SHAREDOS_REVISION=$SHAREDOS_PINNED_REVISION" \
  --build-arg "SHAREDOS_RUNTIME_DIGEST=$runtime_digest" \
  --tag "$tag" \
  "$context" \
  || die 'docker build failed'

image_id="$(docker image inspect --format '{{.Id}}' "$tag")" \
  || die 'built image not found'

# The proxy image bakes tinyproxy at build time so cell startup needs no
# network. Its context is the Dockerfile directory alone.
proxy_tag="${tag%:*}-proxy:${tag##*:}"
docker build \
  --file "$repo_root/docker/experiments/proxy.Dockerfile" \
  --tag "$proxy_tag" \
  "$repo_root/docker/experiments" \
  || die 'proxy docker build failed'
proxy_image_id="$(docker image inspect --format '{{.Id}}' "$proxy_tag")" \
  || die 'built proxy image not found'

printf '{"imageTag":"%s","imageDigest":"%s","proxyImageTag":"%s","proxyImageDigest":"%s","sourceRevision":"%s","sharedosRevision":"%s","sharedosRuntimeDigest":"%s"}\n' \
  "$tag" "$image_id" "$proxy_tag" "$proxy_image_id" "$head" "$SHAREDOS_PINNED_REVISION" "$runtime_digest"
