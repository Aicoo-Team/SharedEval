#!/usr/bin/env bash
# One-task PACT-Pair files-single smoke with the RESPONDER driven by the real
# Codex CLI (docs/codex-responder-bridge.md). This spends model credit and
# needs the real `codex` binary, so it refuses to run unless explicitly armed:
#
#   SHAREDEVAL_CODEX_SMOKE=1 \
#   SHAREDEVAL_MODEL_API_KEY=... \
#   SHAREDEVAL_SHAREDOS_DIR=../SharedOS \
#   scripts/experiments/codex-responder-smoke.sh
#
# Optional overrides:
#   SHAREDEVAL_CODEX_SMOKE_TASK      task id            (default PAIR-Q1)
#   SHAREDEVAL_CODEX_SMOKE_MODEL     model id           (default deepseek/deepseek-chat)
#   SHAREDEVAL_CODEX_SMOKE_BASE_URL  OpenAI-compatible base URL (default OpenRouter)
#   SHAREDEVAL_CODEX_SMOKE_CODEX     codex executable   (default codex, via PATH)
#   SHAREDEVAL_CODEX_SMOKE_OUT       output root        (default: a new temp dir)
#   SHAREDEVAL_CODEX_SMOKE_CHECK_ONLY=1  stop after --check (no spend)
set -euo pipefail

: "${SHAREDEVAL_CODEX_SMOKE:?set SHAREDEVAL_CODEX_SMOKE=1 to confirm a paid run with the real Codex CLI}"
: "${SHAREDEVAL_MODEL_API_KEY:?SHAREDEVAL_MODEL_API_KEY must be exported (never written to disk)}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
task="${SHAREDEVAL_CODEX_SMOKE_TASK:-PAIR-Q1}"
model="${SHAREDEVAL_CODEX_SMOKE_MODEL:-deepseek/deepseek-chat}"
base_url="${SHAREDEVAL_CODEX_SMOKE_BASE_URL:-https://openrouter.ai/api/v1}"
codex_bin="${SHAREDEVAL_CODEX_SMOKE_CODEX:-codex}"
out_root="${SHAREDEVAL_CODEX_SMOKE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/sharedeval-codex-smoke.XXXXXX")}"
mkdir -p "$out_root"

if ! command -v "$codex_bin" >/dev/null 2>&1; then
  echo "codex executable not found: $codex_bin" >&2
  exit 2
fi
echo "codex: $(command -v "$codex_bin") ($("$codex_bin" --version 2>/dev/null || echo 'version unknown'))"

config="$out_root/sharedeval-run.yaml"
cat >"$config" <<EOF
apiVersion: sharedeval-run/v1
kind: RunConfig

model:
  provider: openai-compatible
  baseUrl: $base_url
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: $model
  maxOutputTokens: 4096

workflow:
  mode: single
  protocol: files
  maxTicks: 4
  stopWhen: all-terminal

benchmark:
  dataset: pact-pair
  policy: D2
  requester: R1
  gradingMode: category
  tasks:
    ids: [$task]

budget:
  maxToolCalls: 16
  maxRuntimeMs: 300000

output:
  directory: runs
  saveTraces: false

harness:
  responder: codex
  codex:
    command: $codex_bin
EOF
echo "config: $config"

cd "$repo_root"
npm run --silent sharedeval -- single --config "$config" --check
if [ "${SHAREDEVAL_CODEX_SMOKE_CHECK_ONLY:-0}" = "1" ]; then
  echo "check-only; not running"
  exit 0
fi

run_id="codex-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
echo "run id: $run_id"
npm run --silent sharedeval -- single --config "$config" --run-id "$run_id"
echo "artifacts: $out_root/runs/$run_id"
