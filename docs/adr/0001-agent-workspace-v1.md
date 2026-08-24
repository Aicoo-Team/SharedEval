# ADR 0001: File-driven agent workspace v1

- Status: Proposed
- Date: 2026-08-24
- Owners: SharedEval maintainers

## Context

The current PACT runner constructs the benchmark policy prompt, creates a
task-local in-memory workspace, and drives the participant loop. The checked-in
`agent_configs` files are only used by a legacy experiment path. This makes it
impossible to distinguish an agent that inspected its own instructions from a
host that preloaded those instructions into the model prompt.

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

`contact_agent` is a host adapter over recipient-scoped SharedOS messaging. It
does not grant authority through message content. The host binds sender,
recipient, purpose, and trace, starts the recipient turn, and records the causal
relationship between both turns.

Whether an agent also receives scheduled heartbeats is a run configuration;
contacting it never grants access to another agent's workspace.

### Evaluation boundary

Gold answers, relationship labels, expected decisions, grading rubrics, and
canonical before/after state remain outside every agent workspace, prompt, tool
catalogue, and capability grant. `POLICY.md` is behavioural benchmark content;
it is not a SharedOS authorization policy and can never grant a capability.

## Compatibility

The existing `COO.md` files remain temporarily as legacy experiment inputs.
Canonical agent templates now also provide `AGENT.md`; the v1 loader ignores
`COO.md`. Removing the legacy files and loader is a later migration after the
legacy experiment path is retired.

Any experimental runner that preloads `COO.md`, `POLICY.md`, or `MEMORY.md`
into a prompt is not an implementation of `sharedeval/agent-workspace/v1` and
must use a distinct compatibility-mode name.

The existing public runner, SharedOS-embedded runner, and Harbor backend are
unchanged by this proposal. They will adopt the contract incrementally.

## Delivery sequence

1. Land this explicit template contract and canonical `AGENT.md` seeds.
2. Add a run-scoped persistent resource provider and versioned memory writes.
3. Add the fresh-turn heartbeat scheduler and minimal bootstrap prompt.
4. Add the recipient-scoped `contact_agent` router and causal trace.
5. Move all formal runner modes, including Harbor, onto the same lifecycle.

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
