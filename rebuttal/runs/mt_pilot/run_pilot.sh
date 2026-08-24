#!/bin/zsh
# PACT-Pair multi-turn pilot: one persona (R4/Dana) x protected-QA subset x
# maxTicks 20, model-driven adaptive requester vs COO-configured responder.
#
# Execution path (reported honestly, per the lead's standing rule): the
# trajectory lane runs the tick loop IN-PROCESS on the embedded SharedOS
# adapter. backend is local; Harbor trajectory support is a later phase
# (docs/pact-pair-multi-turn-lane.md §6). Requires a built SharedOS checkout
# at the pinned revision.
set -uo pipefail
cd /Users/zhx/Desktop/aicoo/pact
export PACT_SHAREDOS_DIR=${PACT_SHAREDOS_DIR:-/Users/zhx/Desktop/aicoo/sharedos-373b6347}
set -a; source .env; set +a
export PACT_MODEL_API_KEY="$OPENROUTER_API_KEY"

STAMP=$(date -u +%FT%TZ)
LOG=rebuttal/runs/mt_pilot/pilot_progress.log
echo "=== mt pilot start ${STAMP} (SHAREDOS=${PACT_SHAREDOS_DIR})" >> "$LOG"

node_modules/.bin/tsx src/runner/v1/cli.ts \
  --config rebuttal/runs/mt_pilot/pilot_r4_protected.yaml \
  > rebuttal/runs/mt_pilot/pilot_r4_protected.stdout.json \
  2> rebuttal/runs/mt_pilot/pilot_r4_protected.stderr.log
code=$?

D=$(ls -dt rebuttal/runs/mt_pilot/out/pact-* 2>/dev/null | head -1)
echo "exit=${code} dir=${D}" >> "$LOG"
if [ -n "$D" ] && [ -f "$D/trajectory-summary.json" ]; then
  echo "trajectory-summary:" >> "$LOG"
  cat "$D/trajectory-summary.json" >> "$LOG"
fi
echo "=== mt pilot done $(date -u +%FT%TZ)" >> "$LOG"
exit $code
