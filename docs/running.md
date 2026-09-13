# Running SharedEval

SharedEval defaults to the `multi` PACT-Pair workflow; `single` is the explicit
per-task-isolation mode. Both use the same SharedOS execution boundary.
New `sharedeval-run/v2` configurations retain both actors' conversations across
ticks and tasks. Existing `v1` configurations remain reset-context experiments.

For the bounded scripted NET adapters, use the separate
[`net check|run|score` commands and `pact-net-native-run/v1` configuration](pact-net-native-cli.md).
The PACT-Pair configuration below does not select a NET adapter.

## 1. Install and validate

Use Node.js 24 for the test suite and pinned runtime. The package accepts Node
20.11 or newer, but Node 23 can cancel the provider timeout tests prematurely.

```bash
npm ci
npm run validate
npm test
npm run type-check
```

`npm run validate` checks the complete dataset catalog. The two suite-specific
smokes are useful while editing one dataset:

```bash
npm run smoke:pact-pair
npm run smoke:pact-net
```

## 2. Create a run configuration

Save the following as `sharedeval-run.yaml` and change the endpoint, model, and
task selection as needed:

```yaml
apiVersion: sharedeval-run/v2
kind: RunConfig

model:
  provider: openai-compatible
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: gpt-5-mini
  maxOutputTokens: 4096

workflow:
  mode: multi
  protocol: files
  maxTicks: 10
  stopWhen: all-terminal
  world:
    protocol: actor-context/v1
    maxContextBytes: 1048576

benchmark:
  dataset: pact-pair
  policy: D2
  requester: R1
  gradingMode: category
  tasks:
    kind: all
    limit: 2

budget:
  maxToolCalls: 8
  maxRuntimeMs: 60000

output:
  directory: runs
  saveTraces: false
```

The only credential field is the fixed alias `SHAREDEVAL_MODEL_API_KEY`. A literal
secret or an arbitrary environment-variable name is rejected. HTTPS is
required except for loopback model servers.

`maxToolCalls` must be between 6 and 128. `maxRuntimeMs` is bounded at 600,000
milliseconds. Start with a small task limit before running a large selection.

In v2, omitted `workflow.mode` means `multi`; omitted `world` means the profile
shown above. History is actor-local, full, and bounded. The byte ceiling is not
a tokenizer or a guarantee that the provider's context window can hold it.
No automatic summary, truncation, or context reset occurs when the limit is
reached. Each turn still reads all four current files and receives a newly
authorized tool catalog. `MEMORY.md` remains agent-authored progress.

Persistence and retry scheduling are separate: `multiTurn` still selects the
PAIR retry/finalization protocol. See [the bounded example](pair-world-multi.md).
The historical `scripts/experiments/gen-mt-configs.mjs` generator still emits
v1 reset-context configurations. Check `apiVersion` before spending; use v2
and a new run ID for a persistent-world experiment.
Single uses the same history machinery in a new world for each task and permits
only one logical contact, not just one model API call. Never compare a new v2
result as though it were a continuation of a v1 experiment.

## 3. Check before spending

Omitting the mode selects `multi`:

```bash
npm run sharedeval -- --config sharedeval-run.yaml --check
```

`--check` parses the configuration, applies command overrides, validates the
workflow boundary, and prints a deterministic configuration digest. It does
not call a model or SharedOS.

Useful bounded overrides are:

```bash
npm run sharedeval -- multi \
  --config sharedeval-run.yaml \
  --tasks PAIR-Q1,PAIR-A1 \
  --max-ticks 4 \
  --check
```

## 4. Run

Export the dedicated model credential and use the same checked command without
`--check`:

```bash
export SHAREDEVAL_MODEL_API_KEY="your-provider-key"
npm run sharedeval -- --config sharedeval-run.yaml --run-id d2-r1-multi-01
```

For one isolated SharedOS session per task, set `workflow.mode: single` and run:

```bash
npm run sharedeval -- single --config sharedeval-run.yaml --run-id d2-r1-single-01
```

Contradictory command/config modes, unsupported datasets, unsupported workflow
protocols, backend selectors, and out-of-range budgets fail before external
work.

Each session stores private conversation records under
`.sharedeval-actor-context/`. Before/after actor journal frontiers are committed
with each heartbeat. A clean reopen verifies the latest committed frontier;
incomplete external work, corrupt history, or an abandoned context writer lock
fails closed rather than repeating model/tool work. Do not manually remove
locks or edit raw records to force a resume.

The quota repair also changes the grant manifest. Keep old runs immutable and
use a fresh run ID rather than resuming them under a new source revision.

Failures after heartbeat start produce sanitized immutable observations in
`.sharedeval-file-failures/` and a current `execution-status.json` projection.
They distinguish execution, context settlement, evidence projection, planning,
and commit failure, without turning an incomplete run into a scored zero.
The committed ledger/checkpoint remains authoritative: a commit can succeed
before public report generation fails. Successful replay/finalization clears
the stale current failure projection but retains historical failure records.
Diagnostic publication is best effort; disk failures never trigger automatic
model retries or replace the original failure.

## 5. Verify the SharedOS build

Production execution is pinned to SharedOS revision
`3aa07e33999b656a10ace294fd4e41df8cbc318e`. Build that checkout with pnpm
9.15.0, then point SharedEval at it:

```bash
git clone https://github.com/Aicoo-Team/SharedOS.git ../SharedOS
git -C ../SharedOS checkout 3aa07e33999b656a10ace294fd4e41df8cbc318e
corepack pnpm --dir ../SharedOS install --frozen-lockfile
corepack pnpm --dir ../SharedOS build
SHAREDEVAL_SHAREDOS_DIR=../SharedOS npm run test:sharedos
```

The check validates the exact revision, a clean tracked checkout, the expected
runtime digest, the four production package names, and every required export.
Missing or mismatched code is a hard failure.

## 6. Export PACT-Pair

```bash
npm run export:huggingface:pact-pair
```

The check regenerates the canonical 600-row public export and verifies it is
deterministic. To inspect files, pass an explicit output directory to
`scripts/huggingface/export-pact-pair.mjs`.
