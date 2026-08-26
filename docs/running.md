# Running SharedEval

SharedEval defaults to the `multi` PACT-Pair workflow; `single` is the explicit
per-task-isolation mode. Both use the same SharedOS execution boundary.

## 1. Install and validate

SharedEval requires Node.js 20.11 or newer.

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
apiVersion: sharedeval-run/v1
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

## 5. Verify the SharedOS build

Production execution is pinned to SharedOS revision
`a303d97fe974c149d4575b1f5d6426aee6f37367`. Build that checkout with pnpm
9.15.0, then point SharedEval at it:

```bash
git clone https://github.com/Aicoo-Team/SharedOS.git ../SharedOS
git -C ../SharedOS checkout a303d97fe974c149d4575b1f5d6426aee6f37367
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
