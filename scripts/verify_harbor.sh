#!/usr/bin/env bash
# Offline deterministic parity check for the P0 Harbor backend.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
ROOT="$(pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: Docker is not installed"
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "SKIP: Docker daemon is not running"
  exit 0
fi
if ! command -v harbor >/dev/null 2>&1; then
  echo "SKIP: Harbor is not installed (run: uv tool install harbor==0.5.0)"
  exit 0
fi

if [ ! -d node_modules ]; then
  npm ci --silent
fi

echo "[1/2] build the Node image and run six PACT-Pair trials through Harbor"
OUTPUT="$(npm run --silent benchmark -- --config examples/pact-run.harbor-smoke.yaml)"
RUN_DIRECTORY="$(printf '%s' "$OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["outputDirectory"])')"
trap 'rm -rf "$RUN_DIRECTORY"' EXIT

echo "[2/2] compare canonical artifacts with normalized local golden"
python3 - "$RUN_DIRECTORY" "$ROOT/tests/golden/pact-pair-smoke-v1" <<'PY'
import json
import pathlib
import sys

actual_dir = pathlib.Path(sys.argv[1])
golden_dir = pathlib.Path(sys.argv[2])

actual_summary = json.loads((actual_dir / "summary.json").read_text())
golden_summary = json.loads((golden_dir / "summary.json").read_text())
assert actual_summary == golden_summary, "Harbor summary differs from local golden"

def load_results(path):
    results = [json.loads(line) for line in path.read_text().splitlines() if line]
    for result in results:
        result["budgetUsed"]["runtimeMs"] = 0
    return results

actual_results = load_results(actual_dir / "results.jsonl")
golden_results = load_results(golden_dir / "results.jsonl")
assert actual_results == golden_results, "Harbor results differ from local golden"
assert (actual_dir / "run.json").stat().st_size > 0
assert (actual_dir / "trace.jsonl").stat().st_size > 0
PY

echo "HARBOR OK — six Docker trials match the normalized local golden."
