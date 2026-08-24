#!/usr/bin/env bash
set -euo pipefail

node /opt/pact/dist/src/runner/v1/container-entrypoint.js \
  --dataset "{{DATASET}}" \
  --task-id "{{TASK_ID}}" \
  --output-directory /app/pact-output \
  --policy "{{POLICY}}" \
  --max-turns "{{MAX_TURNS}}" \
  --max-tool-calls "{{MAX_TOOL_CALLS}}" \
  --max-runtime-ms "{{MAX_RUNTIME_MS}}"
