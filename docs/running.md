# Running PACT locally

The standalone runner evaluates a model directly as Alex's agent. It loads the
public PACT-Pair tasks, gives the model runner-owned notes/todos tools, evaluates
the final answer or state diff, and writes a local report. Pulse, a database,
and an Aicoo account are not required.

## 1. Configure a model

Copy the example and change the model or base URL if needed. The example runs
one QA task and one action task so the first invocation stays small:

```bash
cp examples/pact-run.openai-compatible.yaml pact-run.yaml
```

The relevant fields are:

```yaml
model:
  provider: openai-compatible
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: gpt-5-mini
  maxOutputTokens: 4096
```

`temperature` is optional and is forwarded only when present. Leave it unset
to use the provider/model default; this is the most portable choice for newer
reasoning models and third-party compatible endpoints.

`maxOutputTokens` is sent as the current Chat Completions
`max_completion_tokens` request ceiling. It limits generated output and
reasoning tokens per model call; it is not a measured billing or run-wide token
budget.

`apiKeyEnv` must be the dedicated `PACT_MODEL_API_KEY` alias. A run config
cannot select another process secret, and a literal API key is not a valid
configuration field. Export the key in the shell that starts the runner:

```bash
export PACT_MODEL_API_KEY="your-provider-key"
```

Compatible endpoints must implement Chat Completions function tools, Bearer
authentication, `tool_choice`, `parallel_tool_calls`, and
`max_completion_tokens`. Change `baseUrl` and `model` for a different provider.
The runner posts to `<baseUrl>/chat/completions`; remote endpoints must use
HTTPS, while plain HTTP is accepted only for loopback local model servers. A
local server without authentication still needs a non-empty placeholder value
for `PACT_MODEL_API_KEY`. Treat the config as trusted because it chooses the
endpoint that receives this model credential.

Transient network failures and HTTP 408/409/429/5xx responses are retried up to
three attempts within the per-task runtime budget. Unambiguous permanent
credential or endpoint failures (401/403/404/405) stop the selection after the
first failed task instead of repeating bad configuration across the benchmark;
other 4xx responses remain isolated to the affected task.

## 2. Select a small run

Start with a limit because a complete policy/requester condition contains 600
tasks and can incur substantial provider cost:

```yaml
benchmark:
  policy: D2
  requester: R1
  tasks:
    kind: all       # all, qa, or action
    limit: 10
```

`policy` selects `D0` through `D5`. `requester` selects public identity profile
`R0` through `R4`. Optional task IDs use `Q<number>`, `A<number>`, or the full
public IDs `PAIR-Q<number>` and `PAIR-A<number>`:

```yaml
tasks:
  kind: all
  ids: [Q1, Q101, A1]
```

Remove `limit` and `ids` only when you intend to run the complete selection.

`budget.maxTurns`, `budget.maxToolCalls`, and `budget.maxRuntimeMs` are enforced
per task. Token and dollar budgets are intentionally not accepted because many
compatible providers do not return consistent accounting data.

## 3. Run

```bash
npm install
npm run benchmark -- --config pact-run.yaml
```

Validate configuration and show the selected task count without calling the
model:

```bash
npm run benchmark -- --config pact-run.yaml --check
```

### Optional P0 Harbor smoke backend

Run configs may select an execution backend. Omitting `backend` is equivalent
to `backend: { kind: local }`, so existing model-backed configs are unchanged.
The initial Harbor backend is deliberately limited to a fixed six-task,
no-network scripted parity set while the local runner remains the default:

```bash
uv tool install harbor==0.5.0
bash scripts/verify_harbor.sh
```

The script builds the authoritative TypeScript environment as a Node image,
runs the six tasks through Harbor's local Docker backend, and compares the
canonical results with committed local golden artifacts. It prints `SKIP` and
exits successfully if Docker or Harbor is unavailable. See
`examples/pact-run.harbor-smoke.yaml` for the backend configuration. Full
model-backed Harbor execution is deferred until the P1 agent/environment
decomposition.

## Isolation and privacy

Each task receives a fresh clone of
`pact_pair/data_spec/alex_data_store.json`. The model sees the public requester,
target, prompt, policy, tool schemas, and results of tools it calls. It does not
receive categories, source pointers, gold facts, expected verdicts, gold
checks, or P/L/B evaluator labels.

The runner enforces the effective notes/todos boundary before every tool call.
Action state is evaluated from before/after snapshots and then discarded. No
task can mutate the fixture used by a later task.

The provider key remains in process memory and request authentication only. It
is not copied into the config snapshot, traces, results, or error messages.

## Outputs

Every run creates a timestamped directory under `output.directory` (default:
`runs`) containing:

- `run.json` — sanitized configuration and run metadata;
- `results.jsonl` — one decision and evaluation record per task;
- `summary.json` — aggregate QA/action utility and safety counts;
- `trace.jsonl` — model decisions and tool events, only when
  `output.saveTraces` is `true`.

Traces can contain synthetic private workspace records returned by tools. They
are disabled by default and should still be handled as sensitive evaluation
artifacts.

Local results use released tasks and labels and are intended for development
and reproducibility. They are not an official held-out leaderboard score.

## Local run config versus submission manifest

`pact-run.yaml` tells this runner which model endpoint and benchmark condition
to execute. `pact.yaml` is a different contract: it describes a runnable agent
artifact implementing the Adapter Protocol. Neither file is a hosted submission
API, and an Aicoo API key is not needed for local runs.
