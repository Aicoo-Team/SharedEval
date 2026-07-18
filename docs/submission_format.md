# Submission Format

PACT-Bench compares agent architectures, not only model names. A submission is
a runnable system plus a `pact.yaml` manifest. Protocol v1 is intentionally
limited to the PACT-Pair responder track.

This document defines the submission artifact and adapter data plane. It does
not define a hosted intake API. Local model runs use the separate
[`pact-run.yaml` configuration](running.md).

The executable source of truth lives in `src/protocol/v1/`. All fixed protocol
objects use strict Zod schemas, and the TypeScript types are inferred from those
schemas. Unknown fields fail validation instead of being silently discarded.

## Manifest

Use `examples/submissions/typescript-basic/pact.yaml` as the format reference.
The required top-level fields are:

| Field | Meaning |
| --- | --- |
| `apiVersion` | Must be `pact-bench/v1` |
| `kind` | Must be `Submission` |
| `id` | Stable lowercase submission slug |
| `name` | Display name for the leaderboard |
| `version` | Semantic submission version |
| `track` | `pact-pair` in v1 |
| `mode` | `pair-responder` in v1 |
| `submitter` | Organization and optional contact |
| `model` | Provider and model name, with optional revision and temperature |
| `agent` | Architecture and source provenance |
| `capabilities` | Supported terminal/tool decisions |
| `runtime` | Trusted local TypeScript or isolated Docker invocation |
| `declarations` | External services, tools, memory, and framework disclosure |

The manifest never contains credentials. Official run budgets are fixed by the
runner and therefore are not submission-controlled manifest fields.

## Submission artifact

A submission artifact is a source tree containing `pact.yaml` and every file
referenced by its runtime declaration. Pin external evaluations to an immutable
source revision and record the resolved source and image digests. Do not put
credentials, generated dependency directories, or private benchmark data in
the artifact.

### Runtime modes

`local-ts` loads a TypeScript module in the runner process. It is only for
trusted local development and baseline tests.

`docker` is the official third-party boundary. Protocol v1 builds the submitted
source from its Dockerfile; prebuilt image submissions are intentionally not
accepted yet. Container messages use JSON-RPC 2.0, one JSON object per line over stdin/stdout, with transport name
`jsonrpc-stdio/v1`. Official policy may disable networking or expose only a
controlled model gateway.

All manifest paths are relative to the submitted repository root. Validation
resolves every referenced path and rejects missing files, directories where a
file is required, traversal, symlink escapes, and Dockerfiles outside their
declared build context.

## Adapter lifecycle

The runner creates one isolated adapter session per task:

```text
pact.initialize
  -> pact.planBoundary  (exactly once)
  -> pact.step          (initial task observation)
  -> pact.step          (zero or more tool results)
  -> pact.finalize      (best effort)
```

The equivalent trusted-local TypeScript interface is:

```ts
export interface PactAdapterV1 {
  initialize(init: PactRunInitV1): Promise<void>;
  planBoundary(task: PactTaskIntroV1): Promise<PactBoundaryPlanV1>;
  step(observation: PactObservationV1): Promise<PactDecisionV1>;
  finalize(): Promise<PactFinalizeReportV1>;
}
```

`planBoundary` requests a least-privilege access plan. The runner intersects the
request with the benchmark's maximum authorization; the submitted plan never
grants access by itself. A missing, invalid, or timed-out plan defaults to no
access. The first task observation reports the effective `grantedAccess`. In
protocol v1, write access requires corresponding read access; notes, todos, and
memory permissions remain independent from one another.

`step` returns exactly one decision:

- `answer` — terminal response;
- `refuse` — terminal refusal;
- `escalate` — terminal request for owner judgment;
- `tool_call` — non-terminal request for a runner-owned tool.

Tool names must come from the allowlist supplied by `pact.initialize`, and tool
inputs are validated against their advertised JSON Schema before execution. The
runner rejects a decision type not listed in the manifest's `capabilities`.

## Privacy boundary

Adapter-facing tasks use an explicit public allowlist: opaque task ID, prompt,
requester, target, task kind, operation when applicable, and surface. The runner
must never send world seeds, split assignments, source notes, gold facts,
expected verdicts, relationship-label matrices, evaluator state, or snapshots.

Submission `finalize` output is untrusted diagnostic status. It cannot contain
or override official scores. Task loading, effective permissions, tool
sandboxing, budgets, private traces, evaluation, and official results remain
runner-owned.

## Public vs official runs

Public smoke runs use released synthetic tasks and labels. Official leaderboard
runs use a held-out evaluator and isolated runtime. Passing public validation
means a submission conforms to the interface; it does not certify an official
score.

## What works today

From this repository root, the included starter can be checked with:

```bash
npm install
npm run validate:sample
npm run smoke:sample
docker build -f examples/submissions/typescript-basic/Dockerfile -t pact-typescript-basic .
```

These commands validate the bundle, exercise the repository-local TypeScript
sample, and prove that its Docker image builds. The standalone BYOK runner is
documented separately in [running.md](running.md); hosted intake is outside this
repository's contract.
