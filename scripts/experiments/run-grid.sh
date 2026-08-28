#!/usr/bin/env bash
# Runs a directory of cell configs through scripts/experiments/run-cell.sh with
# bounded concurrency (default 2, hard cap 8; raised from 4 for task sharding).
#
# Usage:
#   run-grid.sh --config-dir <dir> --image <ref> --out <dir under $HOME> \
#               [--concurrency 2] [--run-prefix grid]
#
# SHAREDEVAL_MODEL_API_KEY must be exported. Each cell gets its own run id and
# output directory; per-cell stdout/stderr land next to the run artifacts.
# Already-completed cells (a cell-provenance.json exists) are skipped, so the
# script is resumable.

set -uo pipefail

repo_root="$HOME/aicoo/pact"
config_dir=""
image_ref=""
out_root=""
concurrency=2
run_prefix="grid"

die() { printf 'run-grid: %s\n' "$1" >&2; exit 1; }

# A cell-provenance.json is written even when the run fails -- it records the
# failure (cliExitCode) rather than proving success. Treating its existence as
# "ok" reported four green cells for a grid in which all four died.
cell_exit_code() {
  [ -f "$1" ] || return 0
  python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["cliExitCode"])
except Exception: pass' "$1" 2>/dev/null
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) config_dir="$2"; shift 2 ;;
    --image) image_ref="$2"; shift 2 ;;
    --out) out_root="$2"; shift 2 ;;
    --concurrency) concurrency="$2"; shift 2 ;;
    --run-prefix) run_prefix="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$config_dir" ] || die '--config-dir is required'
[ -n "$image_ref" ] || die '--image is required'
[ -n "$out_root" ] || die '--out is required'
[ -n "${SHAREDEVAL_MODEL_API_KEY:-}" ] || die 'SHAREDEVAL_MODEL_API_KEY must be exported'
[ "$concurrency" -ge 1 ] && [ "$concurrency" -le 8 ] \
  || die 'concurrency must be between 1 and 8 (raised for task sharding)'

mkdir -p "$out_root"

run_one() {
  local cfg="$1"
  local slug
  slug="$(basename "$cfg" .yaml)"
  local run_id="${run_prefix}.${slug}"
  local cell_out="$out_root/$slug"

  local prior
  prior="$(cell_exit_code "$cell_out/$run_id/cell-provenance.json")"
  if [ "$prior" = "0" ]; then
    printf '[skip] %s (already completed)\n' "$slug"
    return 0
  fi
  if [ -n "$prior" ]; then
    # run-cell.sh refuses a pre-existing cell dir, so this cannot be retried in
    # place; say so loudly instead of skipping it as though it had passed.
    printf '[SKIP-FAILED] %s (earlier run exited %s; rm -rf %s to retry)\n' \
      "$slug" "$prior" "$cell_out/$run_id"
    return 1
  fi

  mkdir -p "$cell_out"
  printf '[start] %s at %s\n' "$slug" "$(date -u +%H:%M:%S)"
  # The image runs as node (uid 1000). On a Linux host whose invoking user is
  # not uid 1000, the run volume that run-cell.sh creates would be unwritable
  # to the container. run-cell.sh refuses a pre-existing cell directory, so the
  # only hook is the umask it inherits: 000 makes its mkdir -p produce 0777.
  ( umask 000
  if "$repo_root/scripts/experiments/run-cell.sh" \
      --config "$cfg" \
      --run-id "$run_id" \
      --output-dir "$cell_out" \
      --image "$image_ref" \
      > "$cell_out/$slug.log" 2>&1; then
    printf '[ok]    %s at %s\n' "$slug" "$(date -u +%H:%M:%S)"
  else
    printf '[FAIL]  %s at %s (see %s)\n' "$slug" "$(date -u +%H:%M:%S)" "$cell_out/$slug.log"
  fi
  )
}

configs=()
while IFS= read -r line; do configs+=("$line"); done < <(find "$config_dir" -maxdepth 1 -name '*.yaml' | sort)
[ "${#configs[@]}" -gt 0 ] || die "no .yaml configs in $config_dir"

printf 'running %d cells at concurrency %d\n' "${#configs[@]}" "$concurrency"
printf 'image: %s\n' "$image_ref"

running=0
for cfg in "${configs[@]}"; do
  run_one "$cfg" &
  running=$((running + 1))
  if [ "$running" -ge "$concurrency" ]; then
    wait -n 2>/dev/null || wait
    running=$((running - 1))
  fi
done
wait

printf '\n=== grid complete at %s ===\n' "$(date -u +%H:%M:%S)"
failed=0
for cfg in "${configs[@]}"; do
  slug="$(basename "$cfg" .yaml)"
  prov="$out_root/$slug/${run_prefix}.${slug}/cell-provenance.json"
  code="$(cell_exit_code "$prov")"
  if [ "$code" = "0" ]; then
    printf '%-40s ok\n' "$slug"
  elif [ -n "$code" ]; then
    printf '%-40s FAILED (cliExitCode=%s)\n' "$slug" "$code"
    failed=$((failed + 1))
  elif [ -f "$prov" ]; then
    printf '%-40s UNREADABLE PROVENANCE\n' "$slug"
    failed=$((failed + 1))
  else
    printf '%-40s MISSING\n' "$slug"
    failed=$((failed + 1))
  fi
done
[ "$failed" -eq 0 ] || printf '\n%d of %d cells did not complete\n' \
  "$failed" "${#configs[@]}"
exit $(( failed == 0 ? 0 : 1 ))
