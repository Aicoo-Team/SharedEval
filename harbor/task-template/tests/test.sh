#!/usr/bin/env bash
set -euo pipefail

node /tests/verify.mjs "/app/pact-output/harbor-{{TASK_ID}}"
