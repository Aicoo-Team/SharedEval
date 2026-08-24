# SharedEval File-Driven Default Workflow Design

- Status: Proposed
- Date: 2026-08-25
- Depends on: ADR 0001 (`sharedeval/agent-workspace/v1`)
- Replaces as the default: host-injected, single-task PACT execution

## Summary

SharedEval will make the file-driven agent lifecycle the default benchmark
workflow. A fresh agent turn receives only a minimal bootstrap instruction,
reads its own `AGENT.md` and `HEARTBEAT.md`, follows the heartbeat to inspect
`POLICY.md` and `MEMORY.md`, contacts other agents through an authorized host
port, and replaces `MEMORY.md` to persist explicit progress. Model transcript
and process-local state never carry between heartbeats.

The previous host-injected workflows remain reproducible only behind an
explicit `--legacy` flag. Legacy results and new file-driven results use
different workflow identifiers and must never be pooled into one headline
metric.

This design is a migration program with independently reviewable delivery
phases. The first implementation makes the command model, registry, artifacts,
and PACT-Pair local workflow real. SharedOS parity, Harbor session execution,
and PACT-Net multi-agent scheduling follow as separately gated phases.

## Goals

1. Make file-driven multi-heartbeat execution the no-flag default.
2. Provide an explicit file-driven single-task command for isolation and debug.
3. Preserve both historical execution methods behind `--legacy`.
4. Version every policy and memory seed used by an experiment.
5. Save the exact rendered initial and final workspace bytes and hashes.
6. Make `MEMORY.md` the only continuity channel between fresh heartbeats.
7. Keep evaluator gold physically outside every agent-readable workspace.
8. Preserve current legacy outputs byte-for-byte where feasible and always
   preserve their scoring semantics.
9. Consolidate open PRs by merging valid work and closing superseded branches
   with an auditable replacement link.

## Non-goals

- Rewriting historical run directories to pretend they satisfy the new
  provenance contract.
- Putting benchmark scheduling, task semantics, or gold in SharedOS.
- Treating `POLICY.md` as a capability grant. It is model-visible behavioural
  content only.
- Carrying chat transcript between fresh heartbeats.
- Claiming Harbor or PACT-Net parity before their required session runtime and
  workspace assets exist.

## Command model

The public executable is named `sharedeval`. During repository migration,
`npm run sharedeval -- ...` is the canonical wrapper. The former
`npm run benchmark -- ...` wrapper may remain temporarily as a deprecated alias
to the same CLI, but it does not silently select legacy behaviour.

The command space is a two-by-two matrix:

| Command | Workflow ID | Meaning |
| --- | --- | --- |
| `sharedeval multi` | `files-multi` | One run-scoped workspace processes an ordered task set across fresh heartbeats. |
| `sharedeval single` | `files-single` | Every selected task gets an independent file-driven workspace and heartbeat sequence. |
| `sharedeval multi --legacy` | `legacy-multi-transcript` | Historical Pulse/#35 host-preload workflow with persistent transcript. |
| `sharedeval single --legacy` | `legacy-single-prompt` | Current PACT host-injected, per-task workflow. |

Calling `sharedeval` without a subcommand is exactly equivalent to
`sharedeval multi`. There is no implicit legacy fallback.

Examples:

```bash
# New default: file-driven multi-heartbeat trajectory.
npm run sharedeval -- --config configs/pair/d2-r4.yaml

# The same command, written explicitly.
npm run sharedeval -- multi --config configs/pair/d2-r4.yaml

# File-driven isolated task/session.
npm run sharedeval -- single \
  --config configs/pair/d2-r4.yaml \
  --task PAIR-Q-0101

# Exact current PACT execution semantics.
npm run sharedeval -- single --legacy \
  --config configs/pair/d2-r4.yaml

# Historical host-preloaded multi-turn experiment semantics.
npm run sharedeval -- multi --legacy \
  --config configs/pair/d2-r4.yaml
```

`--task`, `--tasks`, and `--max-ticks` are effective-config overrides. Their
resolved values must be stored in `run.json` and included in the reproducibility
digest. Contradictory command/config values fail; they are not silently merged.

## Configuration and protocol identifiers

New file-driven configurations use `sharedeval-run/v1`. Historical
`pact-run/v1` configurations are accepted only with `--legacy`, with an
actionable error otherwise. Legacy protocol, dataset, and research IDs remain
valid in provenance; compatibility identifiers are not globally rewritten.

The effective workflow object is strict and JSON-safe:

```yaml
workflow:
  mode: multi             # multi | single
  protocol: files         # files | legacy-prompt | legacy-transcript
  maxTicks: 240
  stopWhen: all-terminal  # fixed in v1
```

The CLI subcommand and `--legacy` select the effective values. The config form
exists so Harbor packages, resumes, and machine-generated runs carry the same
explicit state. Adapter selection remains orthogonal:

```yaml
benchmark:
  execution:
    adapter: pact-public-runner # or sharedos-embedded
```

Workflow describes agent lifecycle. Adapter describes the authorization and
execution substrate. Neither implies the other.

## Canonical asset registry

PACT and Pulse currently duplicate base agent files and reuse `D*`, `M*`, and
`P*` identifiers for incompatible policy families. SharedEval establishes one
versioned registry and treats all Pulse copies as legacy references.

```text
dataset/shared-eval/workspaces/v1/
├── registry.json
├── agents/
│   └── <agent-id>/
│       └── base/
│           ├── AGENT.md
│           ├── HEARTBEAT.md
│           ├── POLICY.md
│           └── MEMORY.md
├── policies/
│   └── <policy-family>/<policy-id>/<version>/POLICY.md
├── memory-seeds/
│   └── <scenario-id>/<version>/MEMORY.md
├── heartbeats/
│   └── <workflow-id>/<version>/HEARTBEAT.md
└── relationships/
    └── <relationship-id>/<version>.md
```

The registry identifies assets by semantic family rather than inferring meaning
from filenames. At minimum every entry records:

- stable ID and semantic version;
- actor role (`requester`, `responder`, or both);
- source path, byte count, and SHA-256;
- compatibility aliases for the historical name;
- status (`active`, `legacy`, `draft`, or `incomplete`);
- compatible dataset and workflow IDs.

The existing five PACT-Pair agent templates become the source of truth.
`COO.md` and `USER.md` remain legacy-only and are never substituted for
`AGENT.md`. Draft M6-M8 policies remain non-executable. PACT-Net profiles are
registered as incomplete until all required v1 files exist.

### Actor-specific policy rendering

`POLICY.md` has different content for different actors but the same file role:

- Requester `POLICY.md` contains the ordered, public task queue selected for
  this run. It contains no expected decision, category gold, relationship gold,
  answer, or evaluator rubric.
- Responder `POLICY.md` contains the selected privacy/behaviour policy variant,
  such as D0, D2, D2R, D6, or a relationship-conditioned policy.

The host renders these files before the run, freezes their exact bytes, and
records their registry references and hashes. The host does not interpolate
their content into the model prompt.

## Run-scoped workspace and artifacts

Templates are immutable. Every run materializes an isolated workspace for each
actor. Only `MEMORY.md` is writable. Sensitive workspace bytes and contact
payloads are private artifacts; the public manifest contains hashes and counts,
not their contents.

```text
runs/<run-id>/
├── run.json
├── checkpoint.json
├── results.jsonl
├── summary.json
├── events.jsonl
└── private/
    ├── workspaces/
    │   ├── initial/<agent-id>/
    │   │   ├── AGENT.md
    │   │   ├── HEARTBEAT.md
    │   │   ├── POLICY.md
    │   │   └── MEMORY.md
    │   └── final/<agent-id>/
    │       ├── AGENT.md
    │       ├── HEARTBEAT.md
    │       ├── POLICY.md
    │       └── MEMORY.md
    ├── ticks.jsonl
    ├── contacts.jsonl
    └── evaluator/
        ├── evaluation.jsonl
        ├── trace.jsonl
        └── gold-manifest.json
```

`run.json` records:

- `workflow.id`, `freshTurns`, effective tick budget, and stop reason;
- dataset, split, ordered task-set digest, and source revision;
- every actor, template reference, policy reference, and memory-seed reference;
- initial and final hash/byte metadata for all four files;
- model requested/resolved identity for requester and responder turns;
- adapter/backend provenance;
- a gold-set identifier and digest, never gold content.

Private artifacts are produced only when the existing private-retention switch
is enabled. When private retention is disabled, the runner still computes and
stores hashes in public provenance, then discards private bytes after scoring.

## `files-multi` lifecycle

One multi run owns one ordered public task set and one workspace per actor.

1. Resolve registry references and render all actor workspaces.
2. Freeze initial bytes and hashes before any model call.
3. Start requester heartbeat 1 with only: “Read `AGENT.md` and
   `HEARTBEAT.md`, then follow the heartbeat.”
4. Authorize file discovery/read for the requester's four files. File content
   is never preloaded by the host.
5. The requester reads its `POLICY.md` and `MEMORY.md`, selects the next pending
   task, and may call `contact_agent`.
6. `contact_agent` starts a fresh recipient turn with the same minimal
   bootstrap. The recipient can read only its own workspace and authorized task
   data. The message grants no authority.
7. The requester replaces its complete `MEMORY.md` using compare-and-swap
   against the version it observed.
8. End the model turn and destroy all transcript/process-local state.
9. Start the next heartbeat from the committed workspace only.
10. Stop immediately when every selected task has a terminal status, the
    explicit tick budget is exhausted, or a fatal run error occurs.

The host never continues to `maxTicks` after all tasks are terminal.

### MEMORY format and validation

The requester memory seed contains one canonical row per selected task in
ordered form. v1 statuses are `pending`, `answered`, `refused`, and `error`.
Every replacement must preserve the exact task-ID set, uniqueness, and order.
The agent may append bounded notes to each row but cannot add hidden tasks,
delete tasks, or mutate another agent's memory.

The runner derives stop state from this validated document plus correlated
contact/terminal events. A malformed replacement is rejected and consumes the
current heartbeat's tool budget; it never partially commits.

### Contact port

PACT/SharedEval owns a host-neutral port:

```ts
interface ContactAgentPortV1 {
  contact(input: {
    senderId: string;
    recipientId: string;
    message: string;
    intent: string;
    purpose: string;
    traceId: string;
    deadlineMs: number;
  }): Promise<{
    status: 'completed' | 'denied' | 'failed' | 'cancelled';
    response?: string;
    errorCode?: string;
    recipientTraceId: string;
  }>;
}
```

Pulse code is not imported. The public runner supplies an in-process reference
implementation; SharedOS supplies an adapter implementation using the same
contract. Recipient recursion, total contacts, timeout, and tool calls are
host-budgeted. A message never expands resource scope.

## `files-single` lifecycle

Every selected task is an independent session. A batch of 100 tasks creates
100 workspaces; no memory, transcript, or responder state crosses task
boundaries.

The requester `POLICY.md` contains exactly one public task. The initial
`MEMORY.md` contains exactly one pending row. One heartbeat is the default, but
an explicit small `maxTicks` may permit retry or recovery. The same file-read,
fresh-turn, contact, CAS, artifact, and gold-isolation invariants apply.

This mode is the preferred smoke/debug and matched single-task comparison mode.
It is not an alias for legacy execution.

## Legacy workflows

### `legacy-single-prompt`

This is the current PACT runner. It injects the selected policy and public task
into system/user messages and executes each task in an isolated workspace. The
implementation remains mechanically unchanged behind the dispatcher, and its
existing golden tests must remain byte-identical.

### `legacy-multi-transcript`

This is the Pulse/#35 family. The host preloads identity/policy/memory content
and preserves conversation transcript between ticks. It may be retained for
historical reproduction, but:

- every run and report is labeled `legacy-multi-transcript`;
- it cannot use the `sharedeval/agent-workspace/v1` compliance claim;
- it cannot be pooled with `files-multi` results;
- legacy chat history is stored only in private artifacts;
- no new features are added except correctness, security, and reproducibility
  fixes.

## Evaluation semantics

Both file-driven modes still emit one result and one evaluation row per
selected benchmark task. Multi changes execution context, not denominator
identity.

- A task is evaluated only after it reaches a correlated terminal event.
- Tick exhaustion leaves remaining tasks as explicit no-response/error rows;
  it does not silently drop them.
- Action evaluation uses the exact before/after snapshot associated with that
  action, not the final accumulated workspace alone.
- Infrastructure errors remain outside metric denominators under the existing
  evaluator contract.
- Model refusal, policy refusal, and infrastructure failure remain distinct.
- Public results contain no gold facts or full private messages.

Multi and single metrics are reported separately even when policy, model, and
task set match.

## Resume and atomicity

Only one process may own a run directory. Fresh start and resume acquire the
same run lock before reading or writing checkpoints.

A completed heartbeat checkpoint atomically commits:

- the task/result event;
- the new `MEMORY.md` version and hash;
- the tick record;
- progress counts and last durable event ID.

If any part fails, resume replays from the last complete event without
duplicating public results or memory transitions. Provider/model failures are
not automatically classified as resumable infrastructure failures.

This atomic checkpoint requirement also governs the fix required before PR #13
can merge.

## Backend and dataset gates

### Local public runner

The first implementation target. It must satisfy the same resource and contact
ports as SharedOS and must not bypass file-read evidence.

### SharedOS embedded

The workflow scheduler remains host-owned. Each heartbeat becomes one bounded
SharedOS agent turn. SharedOS owns authorization, filtered tool discovery,
resource access, CAS memory commit, recipient-scoped messaging, and audit. It
does not learn benchmark gold or task scheduling.

The new default cannot be declared SharedOS-conformant until differential tests
prove equivalent public outcomes and audit invariants on the pinned revision.

### Harbor

Legacy single-task Harbor remains supported. File-driven multi fails closed on
Harbor until a session package runs the entire tick sequence inside one
container/state volume. Splitting ticks across independent containers is not
parity because it loses memory continuity.

### PACT-Net

PACT-Net's 25 profiles lack complete v1 `AGENT.md`, `HEARTBEAT.md`, and
`MEMORY.md` assets. They are registered as incomplete. Until the network
scheduler and assets land, file-driven PACT-Net commands fail with an explicit
instruction to use `single --legacy`; there is no empty-file fallback.

## Open-PR consolidation

The migration closes the open queue by preserving valid work, not by merging
conflicting branches verbatim.

1. **#36** — already merged; target workspace contract.
2. **#29** — rebase, verify, and merge the schema-v2 relationship data/evaluator
   baseline.
3. **#13 → #14** — fix atomic checkpoint idempotency, failure taxonomy, and a
   shared run lock; then rebase/verify/merge #13 followed by #14.
4. **#21** — close as superseded by #29/#30 after any unique evaluator tests are
   accounted for.
5. **#27** — close as absorbed by #35; any useful protocol primitive is
   reimplemented under the new workflow contract.
6. **#20** — extract any unique dangling-tool-call correctness fix; otherwise
   close as superseded. Host-side follow-up remains legacy-only.
7. **#30** — after #29, split and merge pure loader/evaluator/rescore and
   side-effect hardening. Old trajectory scaffolding moves to legacy or is
   replaced by the new scheduler.
8. **#31** — retarget after its data/evaluator dependencies and merge only after
   reports/manifests clearly label all results `legacy-single-prompt`.
9. **#35** — do not merge verbatim. Rebase onto the new scheduler, retain its
   historical runner as `legacy-multi-transcript`, and move the pilot under a
   legacy-labeled artifact path. The new default implementation must use the
   v1 workspace/resource contract.

An original PR may be closed as superseded after its valid commits are merged
through a corrective PR. This counts as consolidation; duplicating the same
code through every historical branch does not.

## Delivery phases

Phases are review and dependency boundaries, not permission to expose a broken
intermediate default. Phase 1 may land as internal/schema scaffolding, but the
no-flag CLI switches to `files-multi` only in the same merge that makes the
Phase 2 PACT-Pair executor usable. Phase 1 and Phase 2 may therefore be stacked
PRs, with the public default switch kept in the second PR.

### Phase 1: Contracted command and artifact surface

- `sharedeval` CLI and strict workflow schema;
- default `multi`, explicit `single`, and `--legacy` mapping;
- registry schema and PACT-Pair canonical asset migration;
- run manifest and initial/final workspace hashing;
- legacy-single dispatcher with golden compatibility;
- fail-closed gates for unsupported Harbor/PACT-Net combinations.

### Phase 2: PACT-Pair file-driven execution

- local resource provider and versioned memory store;
- fresh requester and responder turns;
- `ContactAgentPortV1` reference implementation;
- files-multi and files-single lifecycle;
- per-task evaluation and private tick/contact artifacts.

### Phase 3: SharedOS parity and robust resume

- SharedOS resource/message adapters;
- CAS and audit receipts;
- atomic event/checkpoint transaction and locking;
- differential conformance tests.

### Phase 4: Harbor and PACT-Net

- session-scoped Harbor runtime;
- complete 25-agent Net workspace assets;
- multi-agent network heartbeat scheduler;
- local/SharedOS/Harbor parity gates.

## Test strategy

### CLI and config

- no subcommand resolves to `files-multi`;
- `single` resolves to `files-single`;
- `--legacy` maps each command to its distinct legacy ID;
- old config without `--legacy` fails with an actionable message;
- effective overrides appear in config digest and `--check` output;
- unsupported combinations fail before a run directory or model call.

### Workspace and registry

- exact four-file loading with no `COO.md` fallback;
- only `MEMORY.md` writable;
- exact rendered bytes and raw-byte SHA-256 retained;
- initial/final snapshots isolated per run and agent;
- policy/memory variants resolve by registry ID, never ambiguous filename;
- missing, symlinked, oversized, special, invalid UTF-8, or draft assets fail.

### Fresh-turn semantics

- tick N receives no message/transcript from tick N-1;
- tick N+1 observes only committed workspace changes;
- process/harness-local hidden state is destroyed;
- requester and recipient both obey fresh-turn semantics;
- all-terminal stops immediately; max-tick exhaustion produces explicit rows.

### Memory and contact safety

- CAS conflict requires reread and consumes budget;
- malformed or partial memory replacement never commits;
- task IDs/order cannot change;
- message text never grants capability;
- sender/recipient/purpose/deadline/trace are bound and audited;
- recursion, contact count, tool count, and timeout are bounded.

### Evaluation and artifacts

- one selected task always maps to exactly one durable result/evaluation row;
- action snapshots correlate to the correct action;
- public artifacts contain no memory contents, private messages, credentials,
  tool payloads, or gold;
- private retention saves the exact initial/final files and traces;
- resume after every checkpoint failure boundary is idempotent;
- legacy golden outputs remain unchanged.

## Success criteria

The migration is complete when:

1. `sharedeval --config ...` runs `files-multi` without hidden prompt preload.
2. File-read and memory-write evidence proves the four-file lifecycle.
3. No transcript crosses a fresh heartbeat.
4. Every run identifies and hashes the exact policy and initial/final memory.
5. Every selected task produces exactly one durable outcome row.
6. Legacy single and legacy multi are explicit, reproducible, and separately
   reported.
7. Unsupported backends/datasets fail closed rather than falling back.
8. The open PR queue contains no duplicate or semantically conflicting
   implementation: valid work is merged and superseded branches are closed with
   replacement links.
