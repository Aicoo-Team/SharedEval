# Running PACT locally

The standalone runner evaluates a model directly as Alex's
defender/responder agent. It loads the public PACT-Pair tasks, gives the model
runner-owned notes/todos tools, evaluates the final answer or state diff, and
writes a local report. Pulse, a database, and an Aicoo account are not
required.

This is not the Pulse production A2A path. Requests are fixed benchmark
artifacts, so a standalone run has a responder-model axis but no
attacker/requester-model axis.

## 1. Configure a model

Copy the example and change the model or base URL if needed. The example runs
one QA task and one action task so the first invocation stays small:

```bash
cp examples/pact-run.openai-compatible.yaml pact-run.yaml
```

The complete model-control surface is shown below for reference. Do not copy
all optional controls into a real config unless that endpoint supports them:

```yaml
model:
  provider: openai-compatible
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: gpt-5-mini
  temperature: 0
  seed: 20260728
  reasoning:
    effort: low
  providerRouting:
    requireParameters: true
    allowFallbacks: false
    only: [example/provider]
  maxOutputTokens: 4096
```

`temperature`, `seed`, `reasoning`, and `providerRouting` are optional.
Configure only controls supported by the selected endpoint. The reasoning
effort is one of `none`, `minimal`, `low`, `medium`, `high`, or `max`.
`providerRouting` is intended for OpenRouter-compatible endpoints and accepts
`requireParameters`, `allowFallbacks`, `order`, and `only`.

`maxOutputTokens` is sent as the OpenRouter-compatible Chat Completions
`max_tokens` request ceiling. It limits generated output and
reasoning tokens per model call; it is not a measured billing or run-wide token
budget.

`apiKeyEnv` must be the dedicated `PACT_MODEL_API_KEY` alias. A run config
cannot select another process secret, and a literal API key is not a valid
configuration field. Export the key in the shell that starts the runner:

```bash
export PACT_MODEL_API_KEY="your-provider-key"
```

Compatible endpoints must implement Chat Completions function tools, Bearer
authentication, `tool_choice`, and `max_tokens`. The runner does
not send or require the `parallel_tool_calls` option. It accepts a missing or
`null` tool-call list and serializes multiple runner-tool calls returned in one
assistant message. A response that mixes runner-tool calls with a terminal
answer/refusal call is rejected as ambiguous.

The runner posts to `<baseUrl>/chat/completions`; remote endpoints must use
HTTPS, while plain HTTP is accepted only for loopback local model servers. A
local server without authentication still needs a non-empty placeholder value
for `PACT_MODEL_API_KEY`. Treat the config as trusted because it chooses the
endpoint that receives this model credential.

Transient network failures and HTTP 408/409/429/5xx responses are retried up to
three attempts within the per-task runtime budget. Unambiguous permanent
credential or endpoint failures (401/402/403/404/405) stop the selection after
the first failed task instead of repeating bad configuration across the
benchmark; other 4xx responses remain isolated to the affected task.

## 2. Choose a policy and grading contract

Start with a limit because a complete policy/requester condition contains 600
tasks and can incur substantial provider cost:

```yaml
benchmark:
  dataset: pact-pair
  policy: D2_SUBMITTED
  requester: R1
  gradingMode: category
  tasks:
    kind: all       # all, qa, or action
    limit: 10
```

The policy registry contains:

- `D0` and `D1`;
- `D2`–`D5`, the expanded public-runner variants;
- `D2_SUBMITTED`–`D5_SUBMITTED`, exact copies of the prompt policies used by
  the submitted experiments;
- `A_LONG_GENERIC`, `A_CATEGORY_ONLY`, and `A_CATEGORY_EXAMPLES`, the
  equal-length specificity ablation;
- `REL_R0`–`REL_R4`, the requester-specific relationship policies.

Use `*_SUBMITTED` when reproducing the submitted-paper conditions. The exact
policy source, word counts, and loaded-text SHA-256 values are recorded in
`dataset/pact-pair/policies/EXPERIMENT_POLICIES.md`.

`gradingMode: category` uses the policy dial's category-level labels.
`gradingMode: relationship` uses the selected requester's relationship label
where one exists and otherwise falls back to the category-level label. Keep
the mode explicit in experiment configs.

Each `REL_Rx` policy must be paired with requester `Rx`,
`gradingMode: relationship`, and `tasks.kind: qa`; configuration parsing
rejects any other combination. `D2_SUBMITTED` is the relationship-agnostic
comparator and can be scored with the relationship contract. The prespecified
rebuttal sweep restricts this comparison to the 99 Files items with the
intended requester-conditioned labels.

### Fixed benchmark metrics versus policy compliance

Every loaded QA task carries the active `expectedBehavior` and a separate
policy-independent `benchmarkExpectedBehavior`, and is evaluated against both
contracts:

- The **fixed benchmark contract** is always the submitted-D2 category
  allow/restrict split, regardless of the active policy or grading mode. The
  top-level `informationUtility`, `informationSecurity`, `leakRate`, and the
  information component of `falseRefusalRate` use this contract. Their task
  sets therefore stay fixed across D0/D1, submitted defenses, and ablations,
  making policy operating points directly comparable.
- The **active policy-compliance contract** follows `expectedBehavior` for the
  configured policy and grading mode. It is reported separately as
  `policyComplianceInformationUtility`,
  `policyComplianceInformationSecurity`,
  `policyComplianceLeakRate`, and
  `policyComplianceFalseRefusalRate`. These denominators can change with a
  policy or requester and can be zero, in which case `value` is `null`.

The same distinction appears in `summary.qa`: `benchmarkAllowed`,
`benchmarkProtected`, and the corresponding benchmark counts use the fixed
contract, while `expectedAnswer`, `expectedRefuse`, `correctAnswers`,
`protectedNoLeak`, and `leaks` use active-policy compliance.

For the 99-task relationship block, all selected Files items are protected
under the fixed submitted-D2 category contract. Consequently,
`informationUtility` has denominator zero and `value: null`; this is expected,
not missing data. Report the `policyCompliance*` metrics for the primary
relationship-aware L/P/B analysis: L contributes to allowed utility, P to
protected security/leakage, and B (`either`) to neither denominator. The fixed
`informationSecurity`/`leakRate` can still be shown as a secondary
category-contract comparator, but they must not be described as
relationship-conditioned utility or security.

Optional task IDs use `Q<number>`, `A<number>`, or the full public IDs
`PAIR-Q<number>` and `PAIR-A<number>`:

```yaml
tasks:
  kind: all
  ids: [Q1, Q101, A1]
```

Remove `limit` and `ids` only when you intend to run the complete selection.

`budget.maxTurns`, `budget.maxToolCalls`, and `budget.maxRuntimeMs` are enforced
per task. Token and dollar budgets are not runner config fields because
compatible providers do not return consistent accounting. The rebuttal sweep
adds a separate conservative dollar scheduler around the runner.

## 3. Validate and run one config

Install dependencies and validate the config/task selection without calling
the model:

```bash
npm install
npm run benchmark -- --config pact-run.yaml --check
```

Then run it:

```bash
npm run benchmark -- --config pact-run.yaml
```

The command exits nonzero if any selected task has an infrastructure error.
Those failures are recorded as `status: infrastructure_error` with no
evaluation and are excluded from every utility/security metric denominator.
Use `summary.attempted`, `summary.observed`, and `summary.errors` to audit the
gap; do not report a cell with errors as a complete result.

## 4. Run the prespecified rebuttal sweep

Run these commands from the repository root in order. The self-test and dry
run make no provider or credits request:

```bash
python3 rebuttal/runs/run_experiments.py --self-test
python3 rebuttal/runs/run_experiments.py --dry-run
```

The no-spend preflight checks credentials/credits, current endpoint metadata,
the pinned provider routes, source provenance, policy hashes, every generated
config, task counts, and smoke-set balance. It does not call a model:

```bash
python3 rebuttal/runs/validate_setup.py --no-spend
```

The paid preflight runs bounded Files and Actions smokes for each requested
model, plus the DeepSeek relationship-policy and ablation smokes. It requires
zero infrastructure errors by default and verifies persisted served-model,
provider, response-ID, usage, and artifact-cost provenance:

```bash
python3 rebuttal/runs/validate_setup.py \
  --budget 100 \
  --campaign-id rebuttal-20260728 \
  --preflight-reserve 5
```

Do not start the sweep unless the paid preflight prints that every strict check
passed. Commit the exact implementation first; experiment runs reject a dirty
worktree unless `--allow-dirty` is explicitly supplied.

Inspect the current default matrix and reservations again immediately before
launch:

```bash
python3 rebuttal/runs/run_experiments.py \
  --dry-run \
  --budget 100 \
  --concurrency 4 \
  --per-model-concurrency 2
```

Launch the same matrix only after the dry-run output is accepted:

```bash
python3 rebuttal/runs/run_experiments.py \
  --budget 100 \
  --campaign-id rebuttal-20260728 \
  --concurrency 4 \
  --per-model-concurrency 2
```

The default scheduler cap is $100, leaving $10 outside the scheduler from the
$110 research envelope. The paid preflight and sweep use the same campaign ID,
cap, lock, and account-usage baseline; its default smoke reservation is $5.
The sweep reserves `1.5 ×` each cell's conservative estimate before launch and
limits work to four cells globally and two per model. Per-cell charges come
from persisted provider telemetry. Missing cost telemetry makes a cell invalid
and retains its full reservation rather than treating it as free. Account-level
usage is retained only as a cumulative campaign guard and aggregate audit;
overlapping account deltas are never attributed to individual concurrent
cells.

Every sweep cell pins `temperature: 0`, the exact provider endpoint, and
`reasoning.effort: low`. DeepSeek and GLM also receive paired seeds; the pinned
BaseTen Kimi endpoint does not advertise seed support, so Kimi configs
explicitly omit it. Automatic paid repair is disabled: a failed cell is
persisted as invalid and must be reconsidered only after its recorded spend is
reviewed.

Available `--blocks` are `anchors`, `replications`,
`todo_robustness`, `relationships`, `actions`, and optional `defenses`.
Available model aliases are `deepseek`, `glm`, and `kimi`. The script prints
the authoritative current cell/task count, projected cost, skipped cells, and
estimated wall time; do not copy an older hard-coded matrix size into a run
decision.

A cell is reusable only when its latest manifest row passed the strict gate
and its model/policy/requester/surface/replicate, configuration, task set,
policy hash, and exact source-state provenance still match. Failed, partial,
stale, or changed cells remain pending and run into a new unique output
directory. The runner checkpoints task artifacts, but it does not continue an
interrupted cell in place.

## Optional Harbor execution backend

Run configs may select an execution backend. Omitting `backend` is equivalent
to `backend: { kind: local }`, so existing model-backed configs are unchanged.
The Harbor backend can materialize and run any PACT-Pair task selection (up to
the full dataset), but every containerized trial currently runs the bundled
no-network scripted parity harness — real-model execution inside containers is
deferred until the secret-injection and container-networking decisions land:

```bash
uv tool install harbor==0.5.0
bash scripts/verify_harbor.sh
```

The backend enforces the pinned orchestrator: it checks `harbor --version`
and refuses to run under anything other than Harbor 0.5.0, because the task
packages rely on that release's `allow_internet = false` network-isolation
semantics. `run.json` records the execution provenance for every run — the
backend, the effective executor (`scripted-harness` for containerized parity
trials, never the caller-selected model), the Harbor version, and the
immutable image identity.

The script builds the authoritative TypeScript environment as a Node image,
runs the six-task smoke set through Harbor's local Docker backend, compares
the canonical results with committed local golden artifacts, and then runs a
denied-egress probe that fails if a Harbor-run container can reach the
network. It prints `SKIP` and exits successfully if Docker or Harbor is
unavailable; set `PACT_HARBOR_SMOKE_REQUIRE=1` (as CI does) to fail instead of
skipping when the prerequisites are expected. See
`examples/pact-run.harbor-smoke.yaml` for the smoke configuration and
`examples/pact-run.harbor-split-01.yaml` for a curated 60-task split.

## Isolation and privacy

Each task receives a fresh clone of
`dataset/pact-pair/data_spec/alex_data_store.json`. The model sees the public requester,
target, prompt, policy, tool schemas, and results of tools it calls. It does
not receive categories, source pointers, gold facts, expected verdicts, gold
checks, or P/L/B evaluator labels.

The runner enforces the effective notes/todos boundary before every tool call.
Action state is evaluated from before/after snapshots and then discarded. No
task can mutate the fixture used by a later task.

The provider key remains in process memory and request authentication only. It
is not copied into the config snapshot, traces, results, or error messages.

## Outputs and provenance

Every run creates a collision-resistant
`pact-<timestamp>-<UUID>` directory below `output.directory`. An existing
explicit run ID is rejected instead of overwritten. The directory contains:

- `run.json` — sanitized requested config, run status, selected-task count,
  Git revision, config/task-set digests, policy file/hash, execution
  provenance (backend, effective executor, and — for Harbor — orchestrator
  version and immutable image identity), and aggregate actual
  provider/model/token/cost provenance;
- `results.jsonl` — appended after every task, including that task's requested
  model, actual served model/provider, response identifiers, tokens, and cost
  when supplied by the endpoint. An exhausted provider request also records
  its sanitized HTTP status, retryability, and total attempt count;
- `checkpoint.json` — rewritten after every task with completion/error counts
  and finalized with the run status;
- `summary.json` — aggregate QA/action utility and safety counts plus provider
  accounting completeness;
- `private/trace.jsonl` — appended task decisions and tool events, only when
  `output.saveTraces` is `true`;
- `private/evaluation.jsonl` — the full per-task evaluations (including gold
  facts) and metric contributions, only when `output.saveTraces` is `true`.

The directory root is the public artifact set and never contains gold labels,
gold facts, or raw workspace content. Everything derived from private gold
lives under `private/` and is only persisted when the `output.saveTraces`
retention switch is on; treat that subdirectory as sensitive and never publish
it with a run.

The requested model string is intent; `providerTelemetry` and
`summary.provider.servedModels/providers` are the observed route. Token/cost
fields are present only when the endpoint returns valid usage, while
`usageComplete` and `costComplete` state whether every provider request was
accounted for.

Traces can contain synthetic private workspace records returned by tools. They
are disabled by default and should still be handled as sensitive evaluation
artifacts.

Local results use released tasks and labels and are intended for development
and reproducibility. They are not an official held-out leaderboard score.

## Local run config versus submission manifest

`pact-run.yaml` tells this runner which model endpoint and benchmark condition
to execute. `pact.yaml` is a different contract: it describes a runnable agent
artifact implementing the Adapter Protocol. Neither file is a hosted
submission API, and an Aicoo API key is not needed for local runs.
