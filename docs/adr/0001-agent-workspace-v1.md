# ADR 0001: File-driven agent workspace v1

- Status: Accepted
- Date: 2026-08-24
- Owners: SharedEval maintainers

## Context

SharedEval previously had competing execution paths that preloaded instructions
or bypassed the canonical workspace. Those paths have been retired. This ADR
defines the single SharedOS-mediated execution boundary.

SharedEval needs to evaluate the agent runtime that users actually operate:
the host starts an agent, the agent reads its own identity and heartbeat, and
the agent persists explicit state for the next fresh heartbeat.

## Decision

SharedEval defines a versioned, host-neutral agent workspace containing exactly
four runtime files:

| Role | Path | Agent access | Purpose |
| --- | --- | --- | --- |
| Identity | `AGENT.md` | read-only | Persona and operating instructions |
| Schedule | `HEARTBEAT.md` | read-only | Work to perform during one heartbeat |
| Behaviour | `POLICY.md` | read-only | Questions and behavioural constraints |
| State | `MEMORY.md` | read-write | The only durable agent-authored state |

The protocol identifier is `sharedeval/agent-workspace/v1`. Template loading is
explicit: there is no directory discovery and no fallback to `COO.md`. Extra
files are not exposed merely because they share the template directory.
The template root is selected by the trusted host; the loader rejects a
symbolic-link root, symbolic-link files, and non-regular files before reading.
The host must keep the selected root and its ancestor directories immutable for
the duration of loading; they are outside the untrusted agent write boundary.

Each run copies the immutable template into a run-scoped, agent-scoped
workspace. The dataset source is never mounted writable and is never mutated in
place.

### Bootstrap

The host gives a fresh agent turn only this bootstrap instruction:

> Read `AGENT.md` and `HEARTBEAT.md`, then follow the heartbeat.

The host does not interpolate any of the four file contents into the model
prompt. File reads must go through the authorized resource plane so a trace can
prove which path and version the agent inspected.

`HEARTBEAT.md` may instruct the agent to read `POLICY.md` and `MEMORY.md`, contact
another agent, and replace `MEMORY.md`. The benchmark evaluates observed agent
behaviour; it does not treat the instruction text itself as proof that the
files were read.

### Heartbeat lifecycle

One heartbeat creates one new bounded agent turn. The model transcript and
process-local state do not carry into the next heartbeat. The run-scoped
workspace does carry over, making `MEMORY.md` the explicit continuity channel.

The host owns cadence, retry budgets, stop conditions, workspace provisioning,
and crash recovery. SharedOS continues to own authorization and one bounded
turn; it does not learn benchmark tasks or heartbeat scheduling.

### Persistence

`MEMORY.md` replacement will use the resource version observed by the agent as
an `expectedVersion`. A persistent provider must commit the replacement with
compare-and-swap semantics and return the new version. Conflicts require a
fresh read and consume the heartbeat retry budget.

The durable audit receipt for a file operation must include the run, agent,
trace, operation ID, path, action, observed or committed version, content hash,
byte count, and outcome. It must not include evaluator gold.

### Agent contact

The requester uses the canonical `messages.request` tool with only an authorized
recipient and JSON-safe payload. SharedOS supplies the trusted actor, purpose,
trace, and message identity, starts the recipient-owned turn, and records the
causal request/reply relationship. Message content never grants authority.

Whether an agent also receives scheduled heartbeats is a run configuration;
contacting it never grants access to another agent's workspace.

### Evaluation boundary

Gold answers, relationship labels, expected decisions, grading rubrics, and
canonical before/after state remain outside every agent workspace, prompt, tool
catalogue, and capability grant. `POLICY.md` is behavioural benchmark content;
it is not a SharedOS authorization policy and can never grant a capability.

## Compatibility

There is no compatibility execution mode. `files-multi` is the default,
`files-single` is selected explicitly, and retired flags fail before model
spend. Git history is the archive for removed runners and assets.

## Rejected alternatives

- **Host-preload all files into the prompt.** This cannot prove agent-driven
  inspection and bypasses file authorization evidence.
- **Mount the dataset directory directly.** This risks cross-run writes and
  exposing evaluator-only neighbours.
- **Persist model chat history.** This creates hidden state outside
  `MEMORY.md`, makes resume semantics provider-dependent, and weakens
  reproducibility.
- **Put scheduling or benchmark semantics in SharedOS.** Hosts depend on
  SharedOS; SharedOS must remain benchmark-neutral.
