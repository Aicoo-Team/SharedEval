# ADR 0002: SharedOS-first execution plane

- Status: Accepted
- Date: 2026-08-26
- Owners: SharedEval and SharedOS maintainers
- Depends on: ADR 0001 (`sharedeval/agent-workspace/v1`)

## Decision

Every requester turn, responder turn, agent-visible tool or file operation, and
agent-to-agent message must pass through SharedOS. SharedEval owns scheduling,
host storage, datasets, gold, evaluation, and artifacts. It must not implement
a second authorization or agent runtime.

This applies to the two public workflows: `multi` and `single`. The historical
prompt-preload and transcript workflows are retired rather than ported. Their
history remains available in Git, but `--legacy` is not a supported product
surface and does not block the default switch.

## Why

The file-driven workflow currently builds its own tool catalogue, invokes
workspace ports directly, checks contact against a local tuple array, and calls
a responder harness in process. That code was a useful reference
implementation, but it bypasses SharedOS turn admission, tool filtering,
invocation-time authorization, messaging authorization, and audit. It cannot be
the production default.

SharedOS already provides the required kernel boundary. The missing work is to
connect SharedEval to it, not to build another platform beside it.

## Boundary

| SharedOS execution plane             | SharedEval control plane and host              |
| ------------------------------------ | ---------------------------------------------- |
| capability and message contracts     | datasets and task selection                    |
| grant matching and usage consumption | trusted per-run grant manifest                 |
| turn admission and bounded execution | heartbeat cadence and stopping                 |
| filtered tool discovery              | workspace and message-log storage              |
| invocation-time authorization        | benchmark tool implementations                 |
| message-send authorization           | local message routing and recipient scheduling |
| runtime and authorization audit      | gold, evaluation, and artifacts                |

Host-owned storage is not a bypass. SharedEval may store grants, messages, and
workspace versions, but only SharedOS decides whether an agent can use them.
SharedOS remains host-neutral and must never import benchmark tasks, policies,
gold, evaluators, or result schemas.

## Invariants

1. Messages carry data, never authority.
2. Grants come only from trusted run configuration, never model text.
3. Every turn consumes an explicit SharedOS execution grant.
4. The model sees only the catalogue returned by SharedOS.
5. Every tool call returns to the SharedOS kernel for exact authorization.
6. Every request and reply is a SharedOS `MessageEnvelope` with recipient,
   purpose, trace, and `replyTo` correlation. There is no second `intent`
   field: the tool name and JSON payload express message semantics.
7. On send, `context.actor` is the message sender. On receipt,
   `context.actor`, `request.agent`, and `message.receiver` are the executing
   recipient; `message.sender` may be a different principal.
8. A delivered message starts that recipient through SharedOS using the
   recipient's grants; the router never calls a responder model directly.
9. One operation has one authorization decision and one grant consumption.
10. Gold and evaluator state never enter messages, grants, tools, runtime state,
    or agent workspaces.
11. Unknown external completion fails closed; it is never retried silently.
12. SharedOS purpose is selected by the host. A model-supplied task ID is only
    untrusted correlation data and cannot select grants, identity, or workspace.

## Turn and tool flow

One file-driven session has one persistent SharedOS namespace and durable
session state. The kernel object may be recreated; namespace, grant usage,
message log, workspace versions, trace, and receipts must remain consistent.
Files-single creates a separate namespace and state for each physical task.

SharedEval chooses when an actor runs, resolves its fixed per-run grant
manifest, and submits one `ExecutionRequest`. SharedOS admits the turn, filters
the tools, executes the model driver, and reauthorizes every tool call.
For an inbound message, the executing actor is the recipient, not the sender.
The recipient therefore runs with its own execution and tool grants.

The model adapter becomes a pure SharedOS turn driver. It may translate provider
tool syntax, redact failures, and collect provider telemetry. It must not own a
workspace port, contact port, grant list, or tool dispatcher.

SharedEval keeps its durable workspace and benchmark tool implementations, but
exposes them only as SharedOS providers. File reads and MEMORY replacement use
SharedOS's canonical file tools and the existing host compare-and-swap store.

## Message flow

SharedOS exposes one canonical model-facing message/request tool. A send follows
one path:

1. the model supplies recipient and JSON-safe payload;
2. actor, purpose, trace, and message ID come from trusted context;
3. SharedOS checks and consumes the recipient-scoped send capability once;
4. a run-scoped SharedEval `MessageTransport` appends the authorized envelope to
   a durable message log;
5. the SharedEval scheduler invokes the recipient as another SharedOS turn,
   using only an accepted envelope from the durable message log;
6. the reply is another authorized envelope using `replyTo`; and
7. the router resolves the original tool call from that durable reply.

The first implementation is synchronous and local to one benchmark run. It
does not require a general queue service, mailbox product, or remote delivery.
Direct `sendMessage` and the model tool must share one post-authorization
delivery primitive so a message cannot be authorized or consumed twice.
SharedEval separately validates any payload task ID against the selected,
pending task set and preserves first-authoritative-contact semantics.

## Grants

SharedEval stores one immutable, versioned grant manifest per run and exposes
it through SharedOS's trusted `GrantSource` port. `AccessContext` carries
identity, purpose, time, trace, and namespace selection, but no authority.
SharedOS's authorizer, verifier, chain resolver, and `GrantUsageStore` remain
the only decision and usage authorities. SharedEval does not repeat their
checks.

The initial topology grants only exact actor execution, exact workspace
operations, requester-to-responder messaging, and explicit benchmark tools.
The responder has no recursive message-tool surface. Its recipient turn omits
the `messages` namespace and `messages.request`; after a valid terminal
decision, trusted host code uses `kernel.sendMessage` to consume the responder's
recipient-scoped reply grant.

The initial SharedEval topology uses only fixed run grants and does not issue
delegated grants. If a later workflow needs delegation, it must use SharedOS's
canonical derivation and chain-validation semantics; SharedEval must never
interpret or construct a parallel delegation model.

## Recovery

Task7a remains the append-only authority for already-completed benchmark
evidence. Task7b is added only after the SharedOS path exists and is limited to:

- stable heartbeat, turn, message, and state-changing operation IDs;
- replay of completed durable results without repeated work; and
- `indeterminate_external_operation` with no automatic retry when a model or
  external operation has no retrievable completion receipt.

Ordinary reads need SharedOS audit evidence, not a new generic receipt system.
The reviewed local heartbeat-marker prototype remains design input and is not
merged around the in-process contact callback.

Private evidence binds the pinned SharedOS revision and runtime digest,
namespace and grant-manifest digest, execution and trace IDs, request/reply
message IDs, and stable audit or operation references. Public artifacts expose
only sanitized runtime provenance.

## SharedOS foundation

SharedOS was changed only where integration proved an API was missing. The
pinned revision now closes the three concrete gaps:

- inbound execution identity binds `context.actor` to `request.agent` and
  `message.receiver`, rather than requiring the message sender to be the
  executing principal;
- the canonical model-facing message/request adapter shares one safe
  post-authorization delivery seam with `sendMessage`; and
- `MessageEnvelope` keeps the authorization-bound `purpose` and no longer has
  the redundant `intent` field.

The pinned SharedOS `GrantSource`, `AccessContext`, `CapabilityAuthorizer`,
chain resolver, `GrantUsageStore`, `MessageTransport`, `MessageEnvelope`, and
`replyTo` are reused first.

SharedEval retains scheduling, workspaces, task correlation, evaluation,
artifacts, recovery policy, and provider transport. It replaces:

- the in-process contact authorizer and direct responder call;
- model-adapter-owned tool catalogue construction and dispatch;
- direct model-initiated workspace calls;
- the competing fresh-harness timeout and turn lifecycle;
- responder-only request-preload tools; and
- production use of SharedOS testkit kernels; and
- both historical `--legacy` execution paths.

## Default-switch gates

Before files-multi becomes the default:

- requester and responder turns both run through a real pinned SharedOS build;
- file, MEMORY, benchmark tool, request, and reply paths have allow and deny
  tests with reconstructable audit;
- requester grants cannot read responder files, while the responder can read
  its own files during the delivered turn;
- a denied operation calls no model, provider, handler, or transport;
- grant-shaped message content cannot affect authority;
- forged task IDs and model-authored purpose cannot affect authority;
- grant usage, message causality, workspace versions, and traces survive ticks;
- files-single sessions share none of those authorities;
- completed recovery replays zero model/message/state-changing work;
- pending external work fails closed without retry;
- full tests, type checking, validation, and real SharedOS conformance pass
  without SharedOS skips; and
- `multi`, explicit `single`, and no-mode default dispatch have command-level
  end-to-end coverage and distinct artifacts.

## Deferred

General message queues, inbox products, receiver wake-up services, remote async
delivery, workflow-driven grant issuance/revocation, and generic distributed
receipt stores are not prerequisites. They require separate evidence and ADRs.

## Simplicity rules

- One concern has one authority: SharedOS authorizes; SharedEval evaluates.
- Prefer one message path, one grant manifest, and one session namespace.
- Keep storage behind host ports; keep benchmark code out of SharedOS.
- Delete retired compatibility paths instead of carrying a second runtime.
- Add a file only when its owner, consumer, and deletion condition are clear.
- Keep no production or maintained reference path that bypasses SharedOS.

## Rejected alternatives

- **Keep local contact and add SharedOS-shaped logs.** Logs do not authorize.
- **Move scheduling and scoring into SharedOS.** That breaks host neutrality.
- **Let the transport approve delivery.** That creates a second authorizer.
- **Merge heartbeat recovery first.** That makes the wrong callback boundary
  durable without adding real operation receipts.
