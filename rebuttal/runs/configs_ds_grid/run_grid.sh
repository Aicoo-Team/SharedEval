#!/bin/zsh
# DeepSeek V4 Flash 0731 single-turn grid: R0-R4 x 600 PACT-Pair tasks.
# Sequential; each persona's summary line is appended to grid_progress.log.
set -uo pipefail
cd /Users/zhx/Desktop/aicoo/pact
export PACT_SHAREDOS_DIR=/Users/zhx/Desktop/aicoo/sharedos-846cbf6
set -a; source .env; set +a
export PACT_MODEL_API_KEY="$OPENROUTER_API_KEY"
LOG=rebuttal/runs/configs_ds_grid/grid_progress.log
echo "=== grid start $(date -u +%FT%TZ)" >> "$LOG"
for R in R0 R1 R2 R3 R4; do
  echo "[$(date -u +%FT%TZ)] $R starting" >> "$LOG"
  node_modules/.bin/tsx src/runner/v1/cli.ts \
    --config rebuttal/runs/configs_ds_grid/full_${R}.yaml \
    > rebuttal/runs/configs_ds_grid/full_${R}.stdout.json 2> rebuttal/runs/configs_ds_grid/full_${R}.stderr.log
  code=$?
  D=$(ls -dt rebuttal/runs/out/ds_grid_${R}/pact-* 2>/dev/null | head -1)
  python3 - "$R" "$code" "$D" >> "$LOG" <<'PYEOF'
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
done
echo "=== grid done $(date -u +%FT%TZ)" >> "$LOG"
