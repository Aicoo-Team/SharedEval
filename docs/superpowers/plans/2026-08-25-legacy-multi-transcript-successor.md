# Legacy Multi-Transcript Successor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the reviewed historical persistent-transcript experiment as
an explicit, safe `legacy-multi-transcript` workflow without importing its
unsafe stacked ancestry.

**Architecture:** A dedicated legacy package owns strict config/asset preflight,
requester drivers, a persistent provider transcript, a persistent world port,
the trajectory engine, and a separate artifact lane. The engine depends on
small injected ports so local and SharedOS-embedded execution share authority,
retry, snapshot, and cardinality rules; the public ShareEval dispatcher calls a
single preflight-first entry point.

**Tech Stack:** TypeScript/Node.js, Zod, Node test runner, existing PACT-Pair
task loader/evaluator/workspace, existing SharedOS embedded adapter, and the
extracted OpenAI-compatible transport helpers.

**Spec:** `docs/superpowers/specs/2026-08-25-legacy-multi-transcript-successor.md`

## Global Constraints

- Work only from GitHub main `7627bf4678b58df111892abb813e4d0c5979cd42`
  in the isolated branch; do not import old stacked commits.
- Preserve the scripted driver bytes at SHA-256
  `b7debe7e21e4d62cb3595e428a78b0a128028cb980f9ffe19afada04a4997510`.
- No public PR #27 exchange/task protocol types.
- No production behavior is added before a test fails for the intended reason.
- No GitHub mutation is part of this plan.
- Commits use Conventional Commits and the tree is clean at handoff.

---

### Task 1: Freeze the legacy contract, config, and assets

**Files:**
- Create: `dataset/pact-pair/legacy-transcript/scripted_driver_v1.json`
- Create: `src/suites/pact-pair/legacy-transcript/contracts.ts`
- Create: `src/suites/pact-pair/legacy-transcript/config.ts`
- Create: `src/suites/pact-pair/legacy-transcript/assets.ts`
- Create: `tests/suites/pact-pair/legacy-transcript-config.test.ts`
- Create: `tests/suites/pact-pair/legacy-transcript-assets.test.ts`

**Interfaces:**
- Produces `loadLegacyMultiConfigV1`, `applyLegacyMultiOverridesV1`,
  `freezeLegacyMultiInputsV1`, and strict public/private schema types.
- Consumes existing `pactModelConfigV1Schema`, task filter/budget schemas, and
  task loader without changing `pactRunConfigV1Schema`.

- [ ] Write config tests whose literal fixtures cover strict valid parsing,
  every unsupported route, explicit blocks, unique task overrides,
  `phase2StartTick === selectedTasks + 1`, and `--resume` zero-side-effect
  rejection.
- [ ] Run the focused tests and verify RED because the dedicated parser does
  not exist.
- [ ] Implement the strict config schema and deterministic effective digest;
  keep task resolution separate so phase validation occurs after one frozen
  load.
- [ ] Write asset tests for regular files, raw byte/hash/length provenance,
  exact canonical script digest, symlink/root symlink/FIFO/path escape,
  oversized/invalid UTF-8, and an injected post-read mutation signal.
- [ ] Run and verify RED because the secure freezer does not exist.
- [ ] Implement descriptor-based open/fstat/read/fstat loading beneath a real
  root, UTF-8 fatal decoding, byte limits, stable relative provenance, and one
  immutable frozen-input object.
- [ ] Run focused tests, type check, validation, and commit
  `feat(pact-pair): define legacy transcript inputs`.

### Task 2: Add persistent requester and responder sessions

**Files:**
- Create: `src/runner/v1/openai-compatible-client.ts`
- Create: `src/suites/pact-pair/legacy-transcript/requester-driver.ts`
- Create: `src/suites/pact-pair/legacy-transcript/model-requester.ts`
- Create: `src/suites/pact-pair/legacy-transcript/responder-session.ts`
- Create: `tests/suites/pact-pair/legacy-requester-driver.test.ts`
- Create: `tests/suites/pact-pair/legacy-responder-session.test.ts`
- Create: `tests/suites/pact-pair/legacy-provider-safety.test.ts`

**Interfaces:**
- Produces `LegacyRequesterDriverV1` and
  `PersistentLegacyResponderSessionV1`.
- The session consumes only frozen persona bytes, frozen model configuration,
  a deadline, visible tools, and a tool-execution port; continuation is an
  internal method, never a `PactObservationV1` value.

- [ ] Write scripted-driver RED tests proving ordered first pass, retry only
  responder-authored refuse/escalate, no retry of failed/denied/cancelled/
  budget/action-side-effect rows, same task/principal/grant, and narrowing-only
  replans.
- [ ] Implement the scripted driver over the exact frozen JSON asset.
- [ ] Write responder RED tests with literal provider messages proving one
  result for every terminal/parallel/budget-truncated tool call, rejection of
  mixed terminal/ordinary calls, and no continuation with pending calls.
- [ ] Extract only the already-reviewed transport helpers and implement the
  legacy session with a persistent message array, bounded tool/turn/deadline
  loops, stable sanitized errors, and separate telemetry.
- [ ] Write provider-safety RED tests for redirect, retry status, network
  failure, `Retry-After`, stalled/oversized/malformed/hostile JSON, abort, late
  completion, and credential/sentinel redaction.
- [ ] Implement the model requester with the same transport, strict JSON
  decisions, off-list/FSM rejection, and no scripted fallback.
- [ ] Run focused tests, adapter regressions, type check, and commit
  `feat(pact-pair): persist legacy provider transcripts`.

### Task 3: Add the engine, world adapters, and artifact lane

**Files:**
- Create: `src/suites/pact-pair/legacy-transcript/world.ts`
- Create: `src/suites/pact-pair/legacy-transcript/engine.ts`
- Create: `src/suites/pact-pair/legacy-transcript/artifacts.ts`
- Create: `src/suites/pact-pair/legacy-transcript/runner.ts`
- Create: `src/suites/pact-pair/legacy-transcript/index.ts`
- Modify: `src/suites/pact-pair/sharedos-execution.ts`
- Modify: `src/execution/sharedos/v1/contracts.ts`
- Modify: `src/execution/sharedos/v1/embedded-adapter.ts`
- Create: `tests/suites/pact-pair/legacy-transcript-engine.test.ts`
- Create: `tests/suites/pact-pair/legacy-transcript-artifacts.test.ts`
- Create: `tests/execution/legacy-transcript-sharedos.test.ts`

**Interfaces:**
- `runLegacyMultiTranscriptEngineV1` consumes only preflight-frozen inputs,
  one requester driver, one persistent responder session, and one world port.
- `runLegacyMultiTranscriptBenchmarkV1` is the sole production orchestration
  entry point; artifact creation happens only after preflight succeeds.

- [ ] Write engine RED tests for persistent state/transcript, per-tick exact
  reauthorization, tool visibility parity, stable unique authority, off-list
  FSM, same-grant/narrowing retry, action before/after evaluation, side-effect-
  before-failure stop, all terminal/error paths, and exact cardinality.
- [ ] Implement local and embedded world ports; add an optional per-turn
  expected-visible-tools gate to the PACT-side SharedOS request mirror and
  preserve all single-turn behavior.
- [ ] Implement the trajectory engine and evaluate each tick against its exact
  snapshots while keeping full evaluations private.
- [ ] Write artifact RED tests for no `results.jsonl`, public/private field
  allowlists, unique rows, source/asset/model/SharedOS provenance, exact metric
  denominators, exclusive run directory, atomic terminal files, and simulated
  write failures.
- [ ] Implement immutable tick/trajectory ledgers plus atomic projection files;
  summarize only legacy trajectory rows.
- [ ] Run focused, SharedOS-mock/embedded-skippable, Harbor regression, type,
  validate, and commit `feat(pact-pair): run legacy transcript trajectories`.

### Task 4: Wire the explicit SharedEval route

**Files:**
- Create: `src/suites/pact-pair/legacy-transcript/cli.ts`
- Modify after the file-default branch is present:
  `src/runner/v1/sharedeval-cli.ts`
- Modify after the file-default branch is present: `src/runner/v1/index.ts`
- Test: `tests/runner-v1/legacy-multi-dispatch.test.ts`

**Interfaces:**
- Produces `runLegacyMultiTranscriptCliV1` for the existing SharedEval
  dispatcher.
- Accepts exactly `multi --legacy --config ... [--task|--tasks]
  [--max-ticks] [--check]`; `single --legacy` remains the unchanged golden
  runner.

- [ ] Write route RED tests proving all four command cells stay distinct,
  legacy multi receives only its supported overrides, `--check` causes no
  directory/factory/spend, and `--resume` fails first.
- [ ] Implement the legacy CLI entry and plug it into the SharedEval dispatcher
  once that dispatcher is available on the integration base; do not create a
  no-flag legacy fallback.
- [ ] Run command tests, legacy-single golden, two scripted smoke trajectories,
  full tests, type check, validate, Harbor build/smoke, and diff/status gates.
- [ ] Commit `feat(runner): dispatch legacy transcript workflow` and write the
  handoff report with RED/GREEN evidence, commit SHAs, excluded ancestry, and
  any integration-base dependency.

