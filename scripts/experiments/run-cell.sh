#!/usr/bin/env bash
# Runs one experiment cell (= one SharedEval run) inside the run-level Docker
# sandbox: an internal-network-only runner plus a CONNECT-only forward proxy
# that allowlists exactly the cell's model endpoint host on port 443.
#
# Usage:
#   scripts/experiments/run-cell.sh \
#     --config <sharedeval-run.yaml> \
#     --run-id <id> \
#     --output-dir <directory under $HOME> \
#     --image <experiment image ref> \
#     [--proxy-image <proxy image ref>]   # default: <image>-proxy:<tag>
#     [--resume]                          # re-enter an existing cell directory
#
# --resume relaunches an interrupted cell: the collision guard is skipped, the
# existing cell config must be byte-identical to --config, and a cell whose
# cell-provenance.json already records cliExitCode 0 is refused. The runner
# resumes from its committed ledger records; cell-provenance.json is rewritten
# to describe the latest attempt.
#
# Requirements and guarantees:
#   - SHAREDEVAL_MODEL_API_KEY must be exported by the caller; it reaches the
#     runner container only via `docker compose run -e SHAREDEVAL_MODEL_API_KEY`
#     (value taken from this environment, never on a command line, never baked
#     into image, compose file, or logs).
#   - The output directory must live under $HOME: macOS dev machines run
#     colima, which can bind-mount only $HOME. /tmp and /var/folders are
#     refused (they silently fail to propagate writes).
#   - The egress probe runs BEFORE any model spend; a failing probe aborts the
#     cell with provenance written and no CLI invocation.
#   - cell-provenance.json (image digest, allowlisted egress, probe report,
#     exit code) is written next to the run artifacts, exactly once.
#   - The production CLI's exit code is propagated.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
compose_file="$repo_root/docker/experiments/compose.yaml"
proxy_port=8888

die() {
  printf 'run-cell: %s\n' "$1" >&2
  exit 1
}

usage() {
  die 'usage: run-cell.sh --config <sharedeval-run.yaml> --run-id <id> --output-dir <dir under $HOME> --image <ref>'
}

config_path=""
run_id=""
output_dir=""
image_ref=""
resume=0
while [ $# -gt 0 ]; do
  case "$1" in
    --resume)
      resume=1
      shift
      ;;
    --config)
      [ $# -ge 2 ] || usage
      config_path="$2"
      shift 2
      ;;
    --run-id)
      [ $# -ge 2 ] || usage
      run_id="$2"
      shift 2
      ;;
    --output-dir)
      [ $# -ge 2 ] || usage
      output_dir="$2"
      shift 2
      ;;
    --image)
      [ $# -ge 2 ] || usage
      image_ref="$2"
      shift 2
      ;;
    --proxy-image)
      [ $# -ge 2 ] || usage
      proxy_image_ref="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done
[ -n "$config_path" ] && [ -n "$run_id" ] && [ -n "$output_dir" ] && [ -n "$image_ref" ] || usage
# Default: the proxy image built alongside the runner image by build-image.sh.
[ -n "${proxy_image_ref:-}" ] || proxy_image_ref="${image_ref%:*}-proxy:${image_ref##*:}"

# Must be a valid production CLI run id (mirrors RUN_ID_PATTERN in
# src/runner/v1/sharedeval-production.ts).
printf '%s' "$run_id" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' \
  || die "run id '$run_id' is not a valid Sharedeval run id"

# --- output directory guard (colima: bind mounts must live under $HOME) -----
[ -n "${HOME:-}" ] || die 'HOME is not set'
case "$output_dir" in
  /tmp | /tmp/* | /private/tmp | /private/tmp/* | /var/folders | /var/folders/* | /private/var/folders | /private/var/folders/*)
    die "output dir '$output_dir' is refused: /tmp and /var/folders cannot be bind-mounted under colima; choose a directory under \$HOME"
    ;;
esac
case "$output_dir" in
  "$HOME"/*) : ;;
  *)
    die "output dir '$output_dir' must live under \$HOME ($HOME)"
    ;;
esac

[ -f "$config_path" ] || die "config not found: $config_path"

# --- derive the single allowed egress host from the config itself ----------
endpoint_json="$(node "$script_dir/run-cell-lib.mjs" derive-endpoint "$config_path")" \
  || die 'config endpoint derivation failed'
endpoint_host="$(node -p 'JSON.parse(process.argv[1]).endpointHost' "$endpoint_json")"
mode="$(node -p 'JSON.parse(process.argv[1]).mode' "$endpoint_json")"
output_relative="$(node -p 'JSON.parse(process.argv[1]).outputDirectory' "$endpoint_json")"
task_concurrency="$(node -p 'JSON.parse(process.argv[1]).taskConcurrency ?? 1' "$endpoint_json")"

# --- prepare the cell directory (collision-refusing, symlink-checked) -------
# Runs before the docker/image checks so collision and resume guards need no
# container runtime and never mask a guard failure behind an environment one.
mkdir -p "$output_dir"
output_dir="$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$output_dir")"
home_real="$(node -p 'require("node:fs").realpathSync(process.argv[1])' "$HOME")"
case "$output_dir" in
  "$home_real"/*) : ;;
  *) die "resolved output dir '$output_dir' escapes \$HOME" ;;
esac

cell_dir="$output_dir/$run_id"
if [ -e "$cell_dir" ]; then
  [ "$resume" -eq 1 ] \
    || die "cell directory already exists (refusing to overwrite run evidence; pass --resume to re-enter it): $cell_dir"
  [ -f "$cell_dir/config.yaml" ] \
    || die "cannot resume: $cell_dir/config.yaml is missing"
  cmp -s "$config_path" "$cell_dir/config.yaml" \
    || die "cannot resume: $cell_dir/config.yaml differs from --config (a resumed cell must keep its exact config)"
  if [ -f "$cell_dir/cell-provenance.json" ]; then
    prior_exit="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).cliExitCode ?? ""' "$cell_dir/cell-provenance.json" 2>/dev/null || printf '')"
    [ "$prior_exit" = "0" ] && die "cannot resume: cell already completed with cliExitCode 0: $cell_dir"
  fi
fi
command -v docker >/dev/null 2>&1 || die 'docker is required'
[ -n "${SHAREDEVAL_MODEL_API_KEY:-}" ] \
  || die 'SHAREDEVAL_MODEL_API_KEY must be exported (it is passed to the runner only via docker compose run -e)'

image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")" \
  || die "image not found locally: $image_ref (build it with scripts/experiments/build-image.sh)"
docker image inspect --format '{{.Id}}' "$proxy_image_ref" >/dev/null \
  || die "proxy image not found locally: $proxy_image_ref (build it with scripts/experiments/build-image.sh)"

mkdir -p "$cell_dir/proxy"
cp "$config_path" "$cell_dir/config.yaml"
node "$script_dir/run-cell-lib.mjs" write-proxy-config "$cell_dir/proxy" "$endpoint_host" "$task_concurrency"

export SHAREDEVAL_EXPERIMENT_IMAGE="$image_ref"
export SHAREDEVAL_EXPERIMENT_PROXY_IMAGE="$proxy_image_ref"
export SHAREDEVAL_EXPERIMENT_CELL_DIR="$cell_dir"
export SHAREDEVAL_EXPERIMENT_PROXY_DIR="$cell_dir/proxy"

project="sharedeval-cell-$(printf '%s' "$run_id" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
project="${project:0:60}"

compose() {
  docker compose -f "$compose_file" -p "$project" "$@"
}

cleanup() {
  compose down --remove-orphans --timeout 10 >/dev/null 2>&1 || true
}
trap cleanup EXIT

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose up -d proxy

# Validate the config inside the runner and capture its deterministic
# configDigest. --check performs no model call and no SharedOS work.
check_json="$(compose run -T --rm --no-deps runner \
  npm run -s sharedeval -- "$mode" --config /sharedeval-cell/config.yaml --check)" \
  || die 'config --check failed inside the runner container'
config_digest="$(node -p 'JSON.parse(process.argv[1]).configDigest' "$check_json")"

# --- egress probe BEFORE any model spend ------------------------------------
probe_exit=0
compose run -T --rm --no-deps runner \
  node scripts/experiments/egress-probe.mjs \
  --endpoint-host "$endpoint_host" \
  --proxy-url "http://proxy:$proxy_port" \
  > "$cell_dir/egress-probe.json" || probe_exit=$?

cli_exit=""
if [ "$probe_exit" -eq 0 ]; then
  set +e
  compose run -T --rm --no-deps -e SHAREDEVAL_MODEL_API_KEY runner \
    npm run -s sharedeval -- "$mode" --config /sharedeval-cell/config.yaml --run-id "$run_id"
  cli_exit=$?
  set -e
fi

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node "$script_dir/run-cell-lib.mjs" write-provenance \
  --out "$cell_dir/cell-provenance.json" \
  --run-id "$run_id" \
  --image-ref "$image_ref" \
  --image-id "$image_id" \
  --allowlisted "$endpoint_host:443" \
  --config-digest "$config_digest" \
  --probe-file "$cell_dir/egress-probe.json" \
  --probe-exit-code "$probe_exit" \
  ${cli_exit:+--cli-exit-code "$cli_exit"} \
  --run-root "$cell_dir/$output_relative/$run_id" \
  --started-at "$started_at" \
  --finished-at "$finished_at"

if [ "$probe_exit" -ne 0 ]; then
  die "egress probe failed; the cell was aborted before any model spend (see $cell_dir/egress-probe.json)"
fi
exit "$cli_exit"
