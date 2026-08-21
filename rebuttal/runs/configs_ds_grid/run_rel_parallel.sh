#!/bin/zsh
# Diagonal relationship-policy arm: persona R_i x policy REL_R_i, 5-way parallel.
set -uo pipefail
cd /Users/zhx/Desktop/aicoo/pact-v2-wiring
source /Users/zhx/Desktop/aicoo/pact/.env >/dev/null 2>&1 || true
export PACT_SHAREDOS_DIR=/Users/zhx/Desktop/aicoo/sharedos-846cbf6
set -a; source /Users/zhx/Desktop/aicoo/pact/.env; set +a
export PACT_MODEL_API_KEY="$OPENROUTER_API_KEY"
LOG=/Users/zhx/Desktop/aicoo/pact/rebuttal/runs/configs_ds_grid/grid_progress.log
echo "=== rel diagonal R0-R4 start $(date -u +%FT%TZ)" >> "$LOG"

run_one() {
  local i=$1
  node_modules/.bin/tsx src/runner/v1/cli.ts \
    --config /Users/zhx/Desktop/aicoo/pact/rebuttal/runs/configs_ds_grid/rel_R${i}.yaml \
    > /Users/zhx/Desktop/aicoo/pact/rebuttal/runs/configs_ds_grid/rel_R${i}.stdout.json 2> /Users/zhx/Desktop/aicoo/pact/rebuttal/runs/configs_ds_grid/rel_R${i}.stderr.log
  local code=$?
  local D=$(ls -dt /Users/zhx/Desktop/aicoo/pact-v2-wiring/rebuttal/runs/out/ds_grid_rel_R${i}/pact-* 2>/dev/null | head -1)
  python3 - "REL_R${i}" "$code" "$D" >> "$LOG" <<'PYEOF'
import json, sys
r_, code, d = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    s = json.load(open(d + "/summary.json"))
    run = json.load(open(d + "/run.json"))
    qa, ac, p = s["qa"], s["actions"], run.get("provider", {})
    print(f"{r_} exit={code} dir={d} qa_scorable={qa['scorable']} qa_correct={qa['correct']} "
          f"qa_leaks={qa['leaks']} act_correct={ac['correct']} act_errors={ac['errors']} "
          f"errors_qa={qa['errors']} costUsd={p.get('costUsd')} costComplete={p.get('costComplete')} "
          f"served={p.get('servedModels')}")
except Exception as exc:
    print(f"{r_} exit={code} dir={d} SUMMARY_READ_FAILED {exc}")
PYEOF
}

for i in 0 1 2 3 4; do
  run_one $i &
done
wait
echo "=== rel diagonal done $(date -u +%FT%TZ)" >> "$LOG"
