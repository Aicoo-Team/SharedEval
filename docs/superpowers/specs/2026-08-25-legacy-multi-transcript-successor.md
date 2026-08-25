# Legacy Multi-Transcript Successor Specification

- Status: Approved for implementation
- Date: 2026-08-25
- Source branches inspected: PR #20 at
  `b313a3940ebb400ba4866d2967f7587564a1a7a2`, PR #27 at
  `ea0508133cb2633b6a1e7656eb48844e844a12c1`, and PR #35 at
  `226e47f6e3a01317a7046649bf5870f8b0533c1d`
- Parent design: SharedEval file-driven default workflow design

## Identity and isolation

The workflow ID is `legacy-multi-transcript`, the protocol ID is
`pact-pair/legacy-transcript-v1`, and its metrics use a dedicated legacy
trajectory family. Neither rows nor summaries may enter the files workflow or
legacy-single result lanes.

One trajectory owns one persistent responder provider transcript and one
persistent PACT-Pair workspace across ticks. The host preloads the selected
responder `COO.md`, `POLICY.md`, and `MEMORY.md`; this workflow deliberately
does not claim `sharedeval/agent-workspace/v1` compliance. The requester owns a
public checklist and is selected explicitly as either `scripted` or `model`.
The implementation must not import the PR #27 public exchange observation,
protocol extension, task FSM, or dataset changes.

## Retry and authority

Only a responder-authored terminal refusal or escalation is retry eligible:

```ts
terminalReceived && (decision.type === 'refuse' || decision.type === 'escalate')
```

Answers, kernel denials, cancellations, failures, provider or protocol errors,
timeouts, budget terminals, and side effects followed by failure are terminal.
Every retry uses the same requester principal and the same grant. Replanning
may retain or narrow that grant, never widen it. A requester message is
untrusted data and cannot carry authority.

## Provider transcript

The responder adapter is legacy-only and owns continuation internally; it does
not add a public `PactObservationV1` variant. Before requester continuation,
every prior assistant tool call has exactly one matching tool result, including
terminal calls, parallel ordinary calls, and ordinary calls truncated by a
tool budget. A response that mixes ordinary and terminal tool calls is a
protocol failure. A model requester failure does not fall back to the scripted
driver, and a run never mixes requester protocols.

Provider requests are bounded by one deadline and `AbortSignal`, never follow
redirects, bound streamed JSON bytes and structural complexity, retry only
408/409/429/5xx and transport failures, and redact credentials from every
error, response-derived header, decision, and artifact.

## Configuration and preflight

The command is:

```text
sharedeval multi --legacy --config <path> [--task <id>|--tasks <ids>]
  [--max-ticks <n>] [--check]
```

Only strict `pact-run/v1`, `pact-pair`, local backend, and
`pact-public-runner` or `sharedos-embedded` execution are accepted. The config
must explicitly select `benchmark.trajectory`, `benchmark.agentConfig`, and
`benchmark.trajectory.requesterDriver`. Selected tasks are non-empty and
unique. When phase 2 exists, `phase2StartTick` is exactly
`selectedTasks.length + 1`. `--resume` is rejected before assets, factories,
directories, credentials, or model calls.

All selected COO, POLICY, MEMORY, requester-persona, and script assets are
opened as regular files beneath the repository/config root and frozen once
before spend. Symlinks, path escapes, FIFOs and other special files, invalid
UTF-8, oversized files, mutation between open/fstat/read/fstat, and missing
assets are rejected. Provenance records raw SHA-256, byte length, repository-
relative path, and status. The canonical scripted asset remains byte-identical
with SHA-256
`b7debe7e21e4d62cb3595e428a78b0a128028cb980f9ffe19afada04a4997510`.

Preflight also freezes public tasks, the effective config/task digest, model
personas and credentials, tool visibility parity, source revision, and the
pinned SharedOS revision. Harbor, PACT-Net, public/adapter-host execution, an
unavailable or mismatched SharedOS build, missing credentials, and unsupported
tool parity fail before a run directory, factory, or spend.

## Execution and artifacts

Every tick reauthorizes the exact task boundary and snapshots the workspace
immediately before and after the tick. The responder session and world persist;
gold, evaluator state, and requester authority never enter either. A tick has
one stable `(trajectoryId, tick)` authority and exactly one terminal public
record. Infrastructure failures stop the trajectory. A mutation before a
failure remains privately evaluated and terminates the trajectory.

The separate artifact lane writes `run.json`, `ticks.jsonl`,
`trajectories.jsonl`, `trajectory-summary.json`, and optionally private
transcript/evaluation records. It never writes legacy-single `results.jsonl`
or calls `summarizeTaskRuns`. Public records contain workflow/protocol/metric
IDs, effective digests, source PR heads, exact asset provenance, requester
requested/served/prompt or script provenance, responder requested/served
provenance, SharedOS adapter/revision, separate usage, unique trajectory/tick
identity, public evaluation fields, and explicit denominators. They contain no
gold, prompts, answer/reason text, transcript, absolute asset paths,
credentials, or private tool payloads.

Trajectory metrics include item-level ever-answer and ever-leak, final outcome,
retry opportunity/attempt, flip and hold, plus exact trajectory, item, tick,
experimental-tick, and infrastructure-tick denominators. Errors remain visible
and never silently disappear from a denominator.

## Required adversarial matrix

- Four command routes and all unsupported gates prove zero factories, zero run
  directories, and zero model calls.
- Authority-shaped messages, off-list tasks, widening grants, asset races,
  symlinks/FIFOs/path escape/oversize/invalid UTF-8, and sentinel leakage fail.
- Strict transcript closure covers terminal, parallel, budget-truncated,
  mixed-call, and continuation cases.
- Redirects, bounded/stalled bodies, malformed/hostile JSON, retry status, one
  deadline, cancellation, and late completion are deterministic and redacted.
- Retry taxonomy, same-grant rules, phase FSM, action snapshots,
  side-effect-before-failure, cardinality, denominators, crash boundaries, and
  `--resume` fail-before-spend are covered.

