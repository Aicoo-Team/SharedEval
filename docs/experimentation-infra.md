# Experimentation infrastructure

The experiment layer plans, sandboxes, schedules, observes, and scores batches
of SharedEval runs. It never replaces the production runner: every cell is one
ordinary `npm run sharedeval` invocation with a pinned configuration, executed
inside a locked-down container. This document is the operator reference for
that layer. For single-run operation see `docs/running.md`.

## 1. Concepts

| Term | Meaning |
|---|---|
| Experiment | A named batch of cells published as one immutable plan. Identified by `experimentId`, a lowercase slug (`/^[a-z][a-z0-9-]{2,63}$/`). |
| Plan | A `sharedeval-experiment-plan/v1` document: `experimentId`, optional description, and 1–512 cells. Published as `plan.json` plus `plan.digest`. |
| Cell | One fully pinned run definition: `model`, `benchmark`, `workflow`, `budget`, `replicate` (1–1000), and `provenance`. One cell maps to exactly one SharedEval run. |
| `cellId` | sha256 of the canonical JSON of the cell identity input: the full cell minus the two execution-provenance fields `imageDigest` and `egressProbe`. Stable and recomputable from `plan.json` alone. |
| `planDigest` | sha256 of the canonical JSON of the validated plan. Every bound cell carries it; batches are checked against it. |
| `runId` | `<experimentId>.<first 24 hex chars of cellId>.r<replicate>`, e.g. `pair-d2-grid-01.3f9c0a1b2d4e5f60718293a4.r1`. Deterministic, collision-checked at publish time, and always a valid production CLI run id. |

Replicates of the same configuration are distinct cells: `replicate` is part
of the cell identity, so each replicate has its own `cellId` and `runId`.

Canonical JSON means codepoint-sorted object keys, no whitespace, finite
numbers only, `undefined` entries dropped. `plan.json` is stored in exactly
this form (plus a trailing newline), so every digest is reproducible from the
published bytes.

## 2. Immutability and batching rules

- Publishing writes `plan.json` and `plan.digest` with exclusive-create
  semantics. Publishing into a directory that already contains either file
  fails; there is no overwrite and no in-place edit. To change anything,
  publish a new plan under a new directory.
- Loading a published plan re-validates the schema, re-serializes, and
  compares byte-for-byte against the stored file, then recomputes the digest
  and compares against `plan.digest`. Any mismatch is a hard failure.
- A plan with two cells that derive the same `cellId` is rejected at
  validation time, naming the duplicated indices.
- A scheduler batch may contain cells from exactly one published plan (one
  `planDigest`) and no duplicate cells. Mixed batches are rejected before any
  external work.
- Run directories are collision-resistant: the runner refuses to reuse an
  existing `runId` directory. A cell's original run artifacts are evidence and
  are never overwritten.

## 3. Docker sandbox topology

One container per cell. `multi` mode shares that container and one SharedOS
namespace across all tasks in the cell; `single` mode keeps the
runner-created per-task isolated namespaces, still inside the one container.

Two networks, two containers per cell:

- The runner container joins only an internal Docker network (no default
  route, no DNS to the outside). It cannot reach the internet directly.
- The model proxy container joins both the internal network and an egress
  network. It is CONNECT-only and allows exactly one destination: the host of
  the cell's `model.baseUrl`, port 443. The allowlist is derived from the cell
  configuration, never hand-written. Denied CONNECT attempts are counted and
  recorded in cell provenance.

Runner container hardening: read-only root filesystem, tmpfs `/tmp`, all
capabilities dropped, `no-new-privileges`, explicit CPU and memory limits.
The only writable bind mount is the run volume; outputs go nowhere else.

The runner needs zero code changes to use the proxy: the model client uses
`globalThis.fetch` (undici), so the image sets `NODE_USE_ENV_PROXY=1` and the
launcher sets `HTTPS_PROXY` to the proxy's internal address. This requires
Node 24 or newer inside the image (the image pins `node:24-slim`; the repo's
`engines: >=20.11` remains compatible).

The image bakes, at build time: the pinned Node version, the lockfile-exact
dependency install, the committed SharedEval tree (the runner refuses dirty
checkouts, so baking a committed tree satisfies that check by construction),
and the staged SharedOS build at revision
`3aa07e33999b656a10ace294fd4e41df8cbc318e` with its runtime digest. The
resulting image digest enters cell provenance.

`SHAREDEVAL_MODEL_API_KEY` is injected only at `docker run -e` time. It never
enters the image, the plan, the logs, or any recorded configuration.

### Egress probe

Before a cell spends anything, the launcher runs a three-part probe from
inside the runner container:

1. Direct egress (bypassing the proxy) must fail.
2. Proxied egress to a non-allowlisted host must be denied.
3. Proxied egress to the configured model endpoint must succeed.

All three results are recorded on the cell as `egressProbe`
(`directEgressBlocked`, `nonAllowlistedEgressBlocked`,
`modelEndpointReachable`). A cell whose probe does not pass all three does not
start. `egressProbe` and `imageDigest` are execution provenance: they are
recorded but excluded from `cellId`, so re-baking an image or re-running the
probe never re-keys a cell.

### macOS development (colima)

macOS dev machines run Docker via colima, which shares only `$HOME` into the
VM (virtiofs). Every bind mount — run volumes, published plan directories,
config mounts — must live under `$HOME`. Mounting from `/var/folders` or
`/tmp` fails silently: the container appears to write, and the host never
sees the files. Linux CI has no such constraint, but the launcher defaults
are chosen for the colima case. The Docker smoke test runs on Linux CI only;
unit tests, `npm run validate`, and `npm run type-check` never require a
Docker daemon.

## 4. Scheduler bounds and limiter semantics

- The plan compiler produces an ordered list of cell manifests; the scheduler
  executes them with default concurrency 2 and a hard cap of 4. Requests for
  more than 4 are rejected, not clamped silently.
- Each cell does exactly one thing: invoke the production CLI
  (`sharedeval multi|single --config … --run-id <derived runId>`) inside its
  container. The scheduler never touches authorization, messages, files, or
  the task loop.
- Provider backoff (429/5xx) lives at the scheduler/proxy layer. Backoff and
  retry timing must never change a run's deterministic identity: the same
  `runId`, config digest, image digest, and runtime provenance are used on
  every attempt.
- Dollar-budget reservation follows the established pattern: reserve 1.5x the
  conservative cost estimate per cell before start. A cell that finishes
  without complete cost telemetry (`usage.costUsd`, `modelCalls`, `toolSteps`)
  is marked invalid and keeps its full reservation — missing telemetry is
  never treated as free.
- Budget bounds are the runner's own and are enforced again at the plan layer
  with identical limits: `maxToolCalls` 6–128, `maxRuntimeMs` at most 600,000.
  The plan layer is never looser than the CLI it drives.

## 5. Cell state machine and resume

States: `planned | starting | running | committed | indeterminate | failed |
finalized`.

The watcher is a read-only observer. It derives state exclusively from typed
sources: the run's ledger and final-authority artifacts (`run.json`,
`checkpoint.json` with `lastRecordDigest` and `recordCount`, the chained
records under `.sharedeval-file-workflow/records/`, `results.jsonl`,
`summary.json`) plus container state. It never infers state from log text or
file counts. Conflicting evidence — for example a checkpoint that disagrees
with the record chain — maps to `indeterminate`, never to a guess.

| State | Meaning |
|---|---|
| `planned` | Cell bound from a published plan; no run directory exists. |
| `starting` | Container created; no durable ledger writes yet. |
| `running` | Container alive; heartbeats advancing the typed ledger. |
| `committed` | Durable commit proven: checkpoint complete and the record chain verifies. Not yet finalized. |
| `indeterminate` | Evidence conflicts, or an external operation cannot be proven either committed or not-executed. |
| `failed` | Run stopped without a durable commit; always carries a typed cause. |
| `finalized` | Committed records scored and sealed into the derived artifact. |

### Typed failure causes

Failure classification is evidence-based, typed, and total. It is derived
from provider telemetry (`privateEvidence.providerTelemetry.requester.requests[]`
with per-request `outcome`, `httpStatus`, `attempts`) and checkpoint state:

| Cause | Evidence | Example |
|---|---|---|
| `model_behavior_terminal` | The model produced a terminal outcome. This is experiment data, not an error to fix. | `invalid_response` from the provider; a denied-format loop exhausted (e.g. repeated `file_memory_format_invalid` denials). |
| `infrastructure_failed` | The environment failed before any durable commit. | `provider_error` with a retryable `httpStatus` (429, 5xx) before any commit; container OOM-killed during `starting`. |
| `indeterminate_external_operation` | An external side-effect operation cannot be proven committed or not-executed. | Cells in this condition surface as state `indeterminate`. |

`model_behavior_terminal` is never retried: re-rolling model behavior is
best-of-N bias. `indeterminate_external_operation` is never auto-retried
under any circumstances; it requires operator review.

In `single` mode the blast radius of an indeterminate external operation is
one task, not the run: each task owns its session, ledger, and PACT
workspace, so the scheduler seals the poisoned task's ledger with a
quarantine record — a durable `error` result carrying the typed
`INDETERMINATE_EXTERNAL_OPERATION` code, with `fatal_error` stop authority
and zero claimed usage — and the batch keeps running its other tasks. The
started heartbeat is never re-executed: replaying the task's run directory
reproduces the same sealed terminal with zero model calls. `multi` mode
keeps the run-level fail-closed stop, and run-level ledger corruption still
fails the whole run in both modes.

### Auto-resume rules

Only two situations resume automatically, and resume always reuses the exact
`runId`, config digest, image digest, and runtime provenance:

1. Provably not-started: no run directory and no durable ledger writes. The
   cell starts fresh under its derived `runId`.
2. Durable commit: `committed` or `finalized`. Replay performs zero model
   calls and zero new external work; it only re-reads and (for `committed`)
   scores.

`infrastructure_failed` before any durable write is the not-started case and
resumes automatically (with scheduler backoff). `infrastructure_failed` after
durable run artifacts exist does not silently resume: the production CLI has
no partial-session resume, a `fatal_error`-stopped multi session can only be
rerun as a whole cell, and the original run directory is preserved as
evidence — an existing `runId` is never overwritten. Such cells stay `failed`
with their typed cause until an operator decides (see the decision table in
the runbook).

## 6. Score and finalize

Score (v1) consumes only committed canonical evaluation records. It never
invokes a model judge and never re-derives evaluations from transcripts.

Rescoring emits an independent, immutable derived artifact bound to its
sources: `runId`, `configDigest`, `lastRecordDigest` (from
`checkpoint.json`, anchoring the chained record set), evaluator id and
version, task-set digest, and scorer config digest. A rescore never mutates
the source run.

The per-run `summary.json` (`sharedeval-file-summary/v1`) carries exactly 10
metrics — 6 fixed (`informationUtility`, `informationSecurity`,
`actionUtility`, `actionSafety`, `falseRefusalRate`, `leakRate`) plus 4
`policyCompliance*` — each as `numerator`/`denominator`/`value`, with
`denominator: 0` forcing `value: null`. Task statuses are typed:
`{answered, error, no_response, refused, side_effect_before_failure}`, and
their counts must sum to the result rows.

The finalizer aggregates only `finalized` cells. Denominator rules:

Can appear in a denominator:

- Committed evaluation rows from finalized cells.
- `model_behavior_terminal` outcomes. A model that answered badly, refused,
  or errored is a measured result; it stays in the denominator of every
  metric whose contract includes it.

Cannot appear in a denominator:

- Rows from any cell that is not `finalized`.
- Anything produced by re-rolling a model-behavior outcome.
- Judgments from model judges (there are none in v1).

Missing, partial, invalid, and indeterminate cells are typed line items in
the finalizer output — each listed with its state and cause — and are never
silently dropped from (or absorbed into) any denominator. A cell invalidated
for missing cost telemetry appears there too, with its reservation intact.

## 7. Provenance fields

| Field | In `cellId`? | Source | Where recorded |
|---|---|---|---|
| `configDigest` | yes | `npm run sharedeval -- --check` (deterministic digest of the effective run config) | `plan.json` cell provenance; cross-checked against the run |
| `taskSetDigest` | yes | Runner task selection (`selectedTaskDigest` in `run.json`) | `plan.json` cell provenance |
| `sharedosRevision` | yes | `load-sharedos` pin (`ac0f1bb2…`), enforced at runtime | `plan.json` cell provenance |
| `sharedosRuntimeDigest` | yes | Same pin, digest of the staged runtime | `plan.json` cell provenance |
| `providerRouting`, `seed`, `temperature` | yes (inside `model`) | Cell model config | `plan.json` cell definition |
| Full `workflow` block (`mode`/`protocol`/`maxTicks`/`stopWhen`/`taskConcurrency`) | yes | Cell workflow config | `plan.json` cell definition |
| `imageDigest` | no (execution provenance) | `docker build` of `docker/experiments/Dockerfile` | Scheduler cell manifest; echoed into the finalizer output |
| `egressProbe` | no (execution provenance) | Per-cell probe before spend | Scheduler cell manifest; echoed into the finalizer output |
| Denied-egress attempt counts | no | Proxy | Scheduler cell manifest |
| Policy hashes, dataset/gold-set digests, backend provenance | n/a (run level) | Runner | `run.json` |
| `lastRecordDigest`, `recordCount` | n/a (run level) | Runner checkpoint | `checkpoint.json`; binds rescore artifacts |

`providerRouting`, when present, is part of the identity because it changes
the request body. The experiment condition is the model, not the upstream
serving it, so configs must not pin providers (`only`, `order`,
`allowFallbacks: false`). They should, however, keep
`providerRouting: { requireParameters: true }`: that is a capability filter,
not a pin — without it OpenRouter routes to providers that silently ignore
request parameters, and a provider that ignores `parallel_tool_calls: false`
(observed with Relace) returns multiple tool calls per response, which the
driver rejects and the task dies. Measured on a 30-task smoke: 27/30 errors
without the filter, expected error rates with it. The runner holds the model
invariant directly — every response in a run must report the same served
model (the first response fixes the expectation; a divergent
`model_identity_mismatch` fails that task loudly), while the serving
provider may vary freely within the capability filter and is recorded per
request in telemetry.

`workflow.taskConcurrency` (single mode only) processes up to that many tasks
at once inside one cell while the cell stays a single accounting unit: one
cell provenance, per-task artifacts, and batch output in task order
regardless of completion order. Absent means 1 and stays out of the digest,
so pre-existing configs keep their identity; any written value, 1 included,
is part of it. A run-wide rate-limit gate queues every task's next attempt
behind one 429 so concurrency degrades into waiting instead of burning retry
budgets into data holes. The cell proxy's `MaxClients` is derived from the
config's own `taskConcurrency` (two tunnels per task plus slack, never below
16), so proxy capacity can never silently queue the cell's own traffic.

Two documented departures from strict serial equivalence: the served-model
ledger seeds from whichever response lands first, so under an inconsistent
provider pool *which* tasks die with `model_identity_mismatch` is
timing-dependent (the scored set stays internally consistent — every scored
task matched the same identity); and after a fatal error the in-flight tasks
settle and leave durable per-task artifacts a serial run would not have
created. Relaunching over those store roots is governed by the recovery
protocol: committed state replays exactly with zero further model calls, and
divergent or indeterminate state is rejected loudly
(`file-workflow-recovery`).

## 8. Runbook

All host paths must live under `$HOME` on macOS (section 3). The examples use
`$HOME/sharedeval-experiments/<experimentId>` as the plan directory and
`$HOME/sharedeval-experiments/<experimentId>/runs` as the run volume.

### 8.1 Build the image

```bash
scripts/experiments/build-image.sh
```

Builds `docker/experiments/Dockerfile` from the committed tree and the staged
SharedOS checkout, and prints the image digest. Record that digest; the
scheduler attaches it to every cell it starts.

### 8.2 Author and publish the plan

Author a plan document. Get each cell's `configDigest` from a `--check` of
the equivalent run config before publishing:

```bash
npm run sharedeval -- --config sharedeval-run.yaml --check
```

Minimal plan (placeholders marked; every digest must be the real 64-hex
value):

```json
{
  "apiVersion": "sharedeval-experiment-plan/v1",
  "kind": "ExperimentPlan",
  "experimentId": "pair-d2-grid-01",
  "description": "D2/R1 multi baseline",
  "cells": [
    {
      "model": {
        "provider": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "SHAREDEVAL_MODEL_API_KEY",
        "model": "deepseek/deepseek-v3.2",
        "temperature": 0,
        "seed": 7,
        "providerRouting": { "requireParameters": true },
        "maxOutputTokens": 4096
      },
      "benchmark": {
        "dataset": "pact-pair",
        "policy": "D2",
        "requester": "R1",
        "gradingMode": "category",
        "tasks": { "kind": "all", "limit": 2 }
      },
      "workflow": {
        "mode": "multi",
        "protocol": "files",
        "maxTicks": 10,
        "stopWhen": "all-terminal"
      },
      "budget": { "maxToolCalls": 8, "maxRuntimeMs": 60000 },
      "replicate": 1,
      "provenance": {
        "configDigest": "<64-hex from --check>",
        "taskSetDigest": "<64-hex selected-task digest>",
        "sharedosRevision": "3aa07e33999b656a10ace294fd4e41df8cbc318e",
        "sharedosRuntimeDigest": "<64-hex staged runtime digest>"
      }
    }
  ]
}
```

Publish:

```bash
npx tsx scripts/experiments/publish-plan.ts \
  --plan experiment-plan.json \
  --out "$HOME/sharedeval-experiments/pair-d2-grid-01"
```

This validates the plan, writes canonical `plan.json` and `plan.digest`
(exclusive create — an existing publish is never overwritten), and prints the
`planDigest` plus each cell's `cellId` and derived `runId`.

### 8.3 Schedule

```bash
export SHAREDEVAL_MODEL_API_KEY="your-provider-key"
npx tsx scripts/experiments/schedule.ts \
  --plan-dir "$HOME/sharedeval-experiments/pair-d2-grid-01" \
  --concurrency 2
```

The scheduler loads and re-verifies the published plan, rejects mixed or
duplicate batches, runs the egress probe per cell, and starts at most
`--concurrency` containers (default 2, hard cap 4). The credential is passed
to each container via `docker run -e` only.

### 8.4 Watch

```bash
npx tsx scripts/experiments/status.ts \
  --plan-dir "$HOME/sharedeval-experiments/pair-d2-grid-01" \
  --watch
```

Prints one typed row per cell: state, typed failure cause where applicable,
heartbeat progress, and usage. The watcher is read-only; it is safe to run
concurrently with the scheduler.

### 8.5 Resume decision table

After an interruption (host reboot, killed scheduler, killed containers),
rerun the scheduler command from 8.3. It applies exactly these rules:

| Observed evidence | State | Action |
|---|---|---|
| No run directory, no ledger records | `planned` / not-started | Auto: start under the derived `runId`. |
| Container gone before any durable write | `failed` (`infrastructure_failed`) | Auto: start under the derived `runId` (still the not-started case), with backoff. |
| Container alive, heartbeats advancing | `running` | Leave alone. |
| Checkpoint complete, record chain verifies | `committed` | Auto: replay/score. Zero model calls, zero new external work. |
| Derived scored artifact present and bound | `finalized` | No-op. |
| Run stopped `fatal_error` after durable artifacts, telemetry shows retryable provider failure | `failed` (`infrastructure_failed`) | Not auto-resumed. Operator decides whether to publish a replacement plan/cell; original run directory is preserved, its `runId` is never reused. |
| Terminal outcome produced by the model (including denied-format exhaustion) | `failed` (`model_behavior_terminal`) | Never rerun. The outcome is experiment data and enters the finalizer denominators. |
| External operation not provably committed or not-executed; or conflicting artifacts | `indeterminate` | Never auto-resumed. Operator review. |

### 8.6 Score

```bash
npx tsx scripts/experiments/score.ts \
  --plan-dir "$HOME/sharedeval-experiments/pair-d2-grid-01"
```

Scores every `committed` cell from its canonical evaluation records and
writes one immutable derived artifact per cell, bound to the source digests
(section 6). Rerunning score on an already-finalized cell verifies bindings
and changes nothing.

### 8.7 Finalize

```bash
npx tsx scripts/experiments/finalize.ts \
  --plan-dir "$HOME/sharedeval-experiments/pair-d2-grid-01"
```

Aggregates all `finalized` cells into the experiment-level report and lists
every non-finalized cell as a typed line item (state plus cause). The report
denominators follow section 6; nothing is silently dropped.

## 9. Acceptance checklist

Run the deterministic suite (no network, no Docker daemon required):

```bash
npx tsx --test tests/experiments/*.test.ts
npm run type-check
```

The suite must demonstrate, against the deterministic fake OpenAI-compatible
endpoint:

- Kill-after-heartbeat-N resume: start a multi cell, kill the container after
  the Nth heartbeat, resume; the ledger shows zero duplicated side effects
  and zero duplicated model calls, and the resumed run reuses the exact
  `runId`, config digest, image digest, and runtime provenance.
- Egress: direct egress from the runner container fails; proxied egress to a
  non-allowlisted host is denied (and counted into provenance); proxied
  egress to the configured model endpoint succeeds.
- Replay-zero-calls: re-scheduling a `committed` or `finalized` cell performs
  zero model requests (the fake endpoint's request count is unchanged) and
  writes nothing new to the run directory.
- Namespace isolation: multi keeps one SharedOS namespace across all tasks in
  a cell; cells, and single-mode sessions, remain isolated from each other.
- MEMORY-format violation: a model that persistently writes malformed
  `MEMORY.md` ends that task `model_behavior_terminal`; the session does not
  go fatal, other tasks in the cell are unaffected, and finalizer
  denominators account for the task correctly.
- 429 injection: consecutive 429 responses classify as
  `infrastructure_failed`; scheduler backoff and retry never change the run's
  deterministic identity; a 429 after a durable commit causes no repeated
  model call.
- `providerRouting` identity: changing only the routing block changes the
  `cellId` (the block is normally omitted; see section 7 on the served-model
  invariant).
- Score/finalize cardinality: exact row counts, unique task ids, fixed
  denominators, and rejection of mixed batches.

The Docker smoke (real containers, real internal network, real proxy) runs on
Linux CI only. `npm test`, `npm run validate`, and `npm run type-check` must
pass with no Docker daemon present.
