#!/usr/bin/env bash
# Run the multi-turn probe lane: one run-cell.sh invocation per split config,
# with bounded concurrency, .done markers, and --resume retries.
#
# Usage:
#   scripts/experiments/mt-lane.sh \
#     --configs <dir with split_NN.yaml>   # from gen-mt-configs.mjs
#     --output-dir <dir under $HOME> \
#     --image <experiment image ref> \
#     [--concurrency 2]                    # trajectories in flight (default 2)
#     [--run-prefix mt]                    # run id = <prefix>.<config basename>
#
# SHAREDEVAL_MODEL_API_KEY must be exported (as for run-cell.sh). A cell that
# exits non-zero is retried once with --resume; a cell whose .done marker
# exists is skipped, so relaunching the lane resumes where it stopped.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  printf 'mt-lane: %s\n' "$1" >&2
  exit 1
}

configs_dir=""
output_dir=""
image_ref=""
concurrency=2
run_prefix="mt"
while [ $# -gt 0 ]; do
  case "$1" in
    --configs) configs_dir="$2"; shift 2 ;;
    --output-dir) output_dir="$2"; shift 2 ;;
    --image) image_ref="$2"; shift 2 ;;
    --concurrency) concurrency="$2"; shift 2 ;;
    --run-prefix) run_prefix="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$configs_dir" ] && [ -n "$output_dir" ] && [ -n "$image_ref" ] \
  || die 'usage: mt-lane.sh --configs <dir> --output-dir <dir under $HOME> --image <ref>'
printf '%s' "$concurrency" | grep -Eq '^[1-9][0-9]?$' || die 'concurrency must be 1..99'
[ -n "${SHAREDEVAL_MODEL_API_KEY:-}" ] || die 'SHAREDEVAL_MODEL_API_KEY must be exported'

configs=("$configs_dir"/*.yaml)
[ -e "${configs[0]}" ] || die "no .yaml configs under $configs_dir"
mkdir -p "$output_dir"

run_one() {
  local config="$1"
  local name
  name="$(basename "$config" .yaml)"
  local run_id="$run_prefix.$name"
  local cell_dir="$output_dir/$run_id"
  local log="$output_dir/$run_id.log"
  if [ -e "$cell_dir/.done" ]; then
    echo "=== CELL $run_id SKIP (done) ==="
    return 0
  fi
  echo "=== CELL $run_id START $(date -u '+%F %H:%M:%S') ==="
  local resume_flag=()
  [ -e "$cell_dir" ] && resume_flag=(--resume)
  ( umask 000
    "$script_dir/run-cell.sh" \
      --config "$config" \
      --run-id "$run_id" \
      --output-dir "$output_dir" \
      --image "$image_ref" \
      "${resume_flag[@]}" ) >>"$log" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -e "$cell_dir" ]; then
    echo "=== CELL $run_id RETRY (exit=$rc) $(date -u '+%F %H:%M:%S') ==="
    ( umask 000
      "$script_dir/run-cell.sh" \
        --config "$config" \
        --run-id "$run_id" \
        --output-dir "$output_dir" \
        --image "$image_ref" \
        --resume ) >>"$log" 2>&1
    rc=$?
  fi
  echo "=== CELL $run_id EXIT=$rc $(date -u '+%F %H:%M:%S') ==="
  [ "$rc" -eq 0 ] && touch "$cell_dir/.done"
  return "$rc"
}

pids=()
failures=0
active=0
for config in "${configs[@]}"; do
  run_one "$config" &
  pids+=($!)
  active=$((active + 1))
  if [ "$active" -ge "$concurrency" ]; then
    if wait -n; then :; else failures=$((failures + 1)); fi
    active=$((active - 1))
  fi
done
for pid in "${pids[@]}"; do
  if wait "$pid" 2>/dev/null; then :; else
    rc=$?
    # wait on an already-reaped pid returns 127; only count real failures.
    [ "$rc" -ne 127 ] && failures=$((failures + 1))
  fi
done

echo "=== LANE COMPLETE failures=$failures $(date -u '+%F %H:%M:%S') ==="
[ "$failures" -eq 0 ]
