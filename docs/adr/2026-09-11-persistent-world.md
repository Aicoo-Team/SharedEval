# Persistent Worlds over the File Protocol

Status: accepted for implementation on `codex/sharedeval-world-first`.
Base: `14463247af15641b1d4231537d7f263e5105a8e7` (PR 53).

## Decision

Multi is a world with persistent actor-local conversation history. Single is
the same lifecycle instantiated separately for each task, with at most one
logical contact. A contact can require many model calls and tool operations.
History continues across tasks within one world, not only across retries of
one question. Each actor sees only messages and tool results it actually saw.

`AGENT.md`, `HEARTBEAT.md`, `POLICY.md`, and `MEMORY.md` remain the file
interface. Admission still requires fresh current-turn file reads. MEMORY is
agent-authored working state, not a replacement for the host's exact journal.
History does not grant authority. Each turn uses freshly authorized tools.

SharedOS remains a host-neutral, one-turn runtime. SharedEval owns world
lifecycle, durable conversation journals, scheduling, and benchmark adapters.
The generic context/world modules must not import PAIR or NET tasks, labels,
tools, policies, or evaluators. PAIR owns its fixed-recipient protocol and
scoring. This change does not implement a NET scheduler.

## Protocol and Compatibility

Existing `sharedeval-run/v1` configurations retain reset-context semantics.
New `sharedeval-run/v2` configurations default to multi and bounded full
actor history. The context protocol, bounds, and scope are part of run
identity; new runs cannot resume an old reset-context experiment silently.
Retry strategy (`multiTurn`) is separate from history persistence.

The first implementation retains the full semantic transcript, including
terminal replies, refusals, assistant tool calls, and tool results. No silent
truncation or summarization is permitted. A context-byte limit stops further
model calls with a typed error; it is not a provider token-window guarantee.

Journal writes precede dispatch of recorded tool calls and later model calls.
Observed tool results remain durable even when they exceed the next-call
budget. Incomplete external work fails closed; no automatic replay is added.
Journal frontiers are bound into heartbeat inputs and commits. A journal is
private evidence, never a public report or source of new permissions.

## Scoped Commit Plan

1. Repair attempted MEMORY-write budgets without refunding failed operations.
2. Accept authorized tool-catalog subsets while checking every invocation.
3. Add durable actor journals and tests for integrity, isolation, and crashes.
4. Continue native conversations through the model driver, including close
   failure propagation and exact-message tests.
5. Add versioned world profiles, lifecycle composition, heartbeat context
   binding, and per-task Single isolation.
6. Retain sanitized failure stage/status evidence without altering commits.
7. Exercise the actual PAIR/SharedOS path with scripted model responses,
   review the changes, and document verified behavior and remaining limits.

No merges, pushes, paid grid, identity/policy redesign, NET scheduler, or
SharedOS authorization changes are included.

## Verification

Use Node 24 and the pinned SharedOS checkout. The initial Node 23 baseline
passed 702 tests with no assertion failures, but cancelled 11 tests after an
unreferenced provider-timeout timer. The complete driver baseline passes
23/23 on Node 24. Full type checking and the complete pinned-runtime test
suite must run after implementation. Scripted tests must inspect actual
provider messages, not infer continuity only from final scores.
