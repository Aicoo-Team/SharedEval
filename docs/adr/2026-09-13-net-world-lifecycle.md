# Assigned NET world lifecycle

Status: proposed with implementation, stacked on the assigned procurement adapter.

## Decision

SharedEval owns an ordered collection of assigned procurement cases, one scheduler,
and the persistence boundary for all actors. SharedOS continues to own individual
turn execution and capability checks. No SharedOS package gains case, benchmark,
or scheduler knowledge.

The new `pact-net-procurement-world/v1` experiment profile freezes the ordered case
profiles, all initial resource versions, the union of actor identities, the actor
context budget, the Multi/Single condition, and an explicit public-state disclosure
policy. Changing any of these inputs or the verified SharedOS revision/runtime
digest requires a different run. This format does not change the legacy pilot
profile, checkpoint, or P-01 evaluation contract.

## State and authority

Multi uses a persistent actor context store and case-partitioned resource state.
Actor identity owns history; assigning a different role in a later case does not
move that history to another actor. A fresh private SharedOS kernel and capability
namespace belong to each case execution. Current grants, case/resource bindings,
and validated owner evidence determine whether a tool can act. Old messages,
receipts, and previous roles confer no authority.

Single creates a new world epoch for each case. Every actor starts with empty
history, every resource partition starts from its declared initial state, and
queues and grants are initialized for the new case. Completed case evidence is
retained for host inspection, outside the next epoch's model-visible resources.
Archives are never copied into the next actor context.

The `net.world_read_public` tool allows an explicit set of readers to inspect an
explicit set of case partitions through a real SharedOS grant. Its projection
contains identifiers, status, and boolean control markers only. It contains no
approval receipts, private owner evidence, blocker text, or execution archives.
In Multi, it can expose an earlier committed resource effect. In Single, the same
read of an earlier case sees its initial state. Discovery filtering and invocation
authorization both apply; the profile alone is not an alternative permission engine.

## Commit and recovery

One checksummed coordinator checkpoint is authoritative for the current case,
global turn cursor, pending work, delivery queue, per-case event archives, and the
latest complete actor frontier vector. Case event sequences are local to their
partition; execution and message identifiers remain globally unique within the run.
Archived case frontier intervals document history but cannot authorize reopening
the active context store at an older frontier.

A durable pending marker precedes every provider call and side effect. Only a
finished actor journal and committed whole-world frontier permit clearing it.
Uncertain effects or unfinished journals stop the world; switching cases or Single
epochs cannot recover around that uncertainty. There is no automatic replay of an
indeterminate turn, stale-lock deletion, history truncation, or context summarization.

A domain audit closes mutation of one case. Its queued observer turns still run.
Only an audited, fully drained case advances the coordinator. A drained case without
an audit is blocked, regardless of the driver's claimed completion. A held but
audited case may advance; experiment completion is separate from business success.

For Single, the transition durably selects the next empty epoch before creating
its context store or executing its first turn. Reopening that empty epoch is safe
if its context store is absent or still empty; nonzero uncommitted history fails
frontier validation. Previous epoch directories remain intact as host evidence.
The checkpoint explicitly distinguishes a prepared epoch from one with recorded
store-generated genesis hashes. Administrative revocation waits for that short
initialization boundary; revocation during an ordinary turn remains immediate.

## Consequences and limits

The dedicated CLI can stop and reopen between any committed turns, including the
case boundary. Execution remains serialized and uses the scripted provider over
the pinned native runtime. This is a bounded procurement integration: it supplies
neither a general NET scheduler/config interface nor a registered procurement
scoring rubric or real-model benchmark result. Capability lifetimes and owner
evidence validity remain enforced, so an expired incomplete run may fail to act.

Checksums detect accidental corruption and mismatched bindings. They do not
authenticate storage against an adversary able to rewrite the checkpoint and its
hash. Filesystem state is a trusted host responsibility.
