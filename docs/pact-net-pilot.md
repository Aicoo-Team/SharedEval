# PACT-Net P-01 native-runtime pilot

This is a bounded, scripted integration pilot for `PO-27-0881`, with three actors
and one persistent world. It is not a general NET runner, a 166-task rollout,
a model benchmark score, or a practitioner-validated purchase-order workflow.
The public entry point is `scripts/pact-net-pilot.ts`; it makes no provider or
paid-model calls. P-01 has no forbidden facts. Private canaries test the adapter's
actor isolation, not task-level disclosure success.

## Pinned prerequisites and commands

Use Node 24 and `npm ci`. Set `SHAREDEVAL_SHAREDOS_DIR` to a built, clean SharedOS
checkout or provenance-bearing bundle. The existing loader rejects any executable
other than revision `3aa07e33999b656a10ace294fd4e41df8cbc318e`, runtime digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`.

The dataset prerequisite is P-01's `initial_state.json` from SharedEval
`dc5d482403bd5dfb38ab6af92db399d6cbea3121`, under
`dataset/pact-net/tasks/executable_core/P-01/`. The pilot reads only that file.
It never reads `manifest.json`, gold outputs, relationships/gold labels, other
actors' notes, or evaluator results to create grants or driver inputs.

```sh
npm ci
SHAREDEVAL_REQUIRE_SHAREDOS=1 npx tsx --test \
  tests/suites/pact-net/pilot-runtime.test.ts \
  tests/runner-v1/repository-surface.test.ts
npm run type-check
npx tsx scripts/pact-net-pilot.ts --output /tmp/net-p01-success --mode success
npx tsx scripts/pact-net-pilot.ts --output /tmp/net-p01-partial --mode safe-partial
```

A run may stop at a clean checkpoint and continue in a new process:

```sh
npx tsx scripts/pact-net-pilot.ts --output /tmp/net-p01-resume --max-turns 2
npx tsx scripts/pact-net-pilot.ts --output /tmp/net-p01-resume --max-turns 1
npx tsx scripts/pact-net-pilot.ts --output /tmp/net-p01-resume
```

Use a fresh output directory to change mode. Reusing a directory with another
mode/profile/run binding is rejected. A successful run has eight committed actor
turns, five domain actions, and no pending deliveries. Safe-partial also drains
eight turns but has three domain actions, `status: held`,
`terminal_success: false`, and Helen's `signed_contract_verification` blocker.
Each process writes `evidence.json` and prints its path and compact status.
`stop_reason: turn_limit` means work remains; it is not terminal success.
`--max-turns 0` only creates/reopens and inspects a checkpoint, with
`stop_reason: checkpoint_only`; it invokes no actor. Unknown or duplicate flags,
missing values and invalid mode/turn counts are rejected.

## Host profile and scope

`profile.ts` is an explicit synthetic host profile. The initial dataset records
budget and contract as `recorded_not_verified`; it cannot itself establish either
control. The profile adds separate synthetic owner evidence with content hashes.
Fixtures are labelled `synthetic-owner-evidence/v1`, valid during calendar 2026,
and bind case, immutable requisition version, amount 148000 USD, vendor VEN-204,
and contract version `CON-PO-27-0881-v1`. Every approval receipt also carries these
fields, the evidence hash, source and validity interval.

The fixture expressly assumes an existing active vendor (limit 150000), an
approved standard contract, and previously completed Security and Privacy review.
Helen verifies an already signed standard contract. Safe-partial changes the
synthetic signed-evidence flag to false. These declared assumptions make the
three-actor fixture bounded; they are not claims of source-document validation
or real-world legal/financial authority.

| Actor | Driver's private projection | Explicit domain grants |
| --- | --- | --- |
| Dmitri Sokolov | Requisition, vendor, delivery terms, own canary/history | Match records, release PO, write audit |
| Stephen Kowalczyk | Case-scoped budget evidence, spend limit, own canary/history | Approve budget |
| Helen Vasquez | Case-scoped contract evidence, preconditions, own canary/history | Verify signed contract |

All actors can read the case's public control state and minimal receipts. Private
read tools are separate exact resources and discovery exposes only one's own.
All three actors are mutually connected in the existing source contact graph;
the explicit pilot grants allow directed messages among these three actors.
The chosen schedule is Dmitri → Stephen → Helen → Dmitri, then observations and
acknowledgments. There is no claim that Dmitri → Helen is an absent contact.
An outside-profile recipient, or an explicitly revoked recipient scope, is denied.

## SharedOS boundary

Each turn runs through the actual pinned `SharedOSExecutor` and
`StandardRuntime`. The replaceable `SoTurnDriver` receives only its actor's
runtime-visible context, private projection, public case state, incoming payload,
filtered tools, and own journal history. The factory never receives full profile,
full world state, grant objects, gold or another actor's private history.
The included scripted driver uses exactly that provider seam.

The pinned executor supports a minimal `TurnKernel` port. The adapter forwards
`admitTurn`, `listTools`, and `invokeTool` as bound methods of the real kernel and
omits optional `openTurnAuthority`. The latter would freeze a grant snapshot
until the next turn at this pin. Omitting it selects the documented per-operation
resolution path, required here for revocation after discovery. The profile and binding explicitly record
`authorityLifecycle: live-per-invocation` and adapter version `net-p01-native/v1`;
the SharedOS SHA alone is insufficient to describe that host choice. No authorizer
or capability matcher is duplicated. Every invocation reloads the host grant source;
every delivery goes through real `kernel.sendMessage` authorization. Tests revoke
a visible tool and a recipient scope before execution and observe denial.

Actor/owner/authority/purpose/trace are host-built access context, never tool
arguments. Domain tool arguments accept only the fixed case and resource version;
extra actor or `authorized` fields fail schema validation. The host's revoke API
is not a driver-visible tool. At actual release, SharedOS also checks the two
approvers' current grants. The domain reducer separately verifies distinct
expected owners, current case/resource/evidence versions, amount/vendor/contract
binding and validity intervals. Domain validation is not a replacement permission
engine. Initial matching, budget approval, contract verification, release and audit
must occur in that order for this pilot; concurrent alternative orders are not
claimed or scored.

Messages carry an untrusted stage and optional minimal approval receipt. A message
can schedule a recipient; it never authorizes a domain operation or makes a
receipt trusted. Only kernel-authorized domain actions produce trusted receipts.

## State, evidence and recovery

`state.ts` reduces successful domain events; the driver's completion prose cannot
set `final_state` or `terminal_success`. Each event records sequence, operation ID,
trusted actor, action, case/resource version, trace, timestamp and approval receipt
where relevant. SharedOS execution events and authorization audit add authority
hash, grant, purpose, resource/action and message delivery evidence. Public state
is a projection of the reducer, not a copy of gold.

Snapshot `final_state`, events, queue, executions and frontiers describe only the
last committed checkpoint. `indeterminate` and `uncommitted_event_count` expose an
unfinished/failed transaction. `commit_status` is `committed` or `indeterminate`;
terminal success additionally requires a drained delivery queue. Uncommitted work cannot report terminal success even if its
in-memory release and audit tools returned success. The regression injects lost
completion after both release and audit and verifies this boundary.

`evidence.json` includes fixture/initial hashes, the runtime pin, action log,
authorization audit, execution results, reducer final state, delivery queue and
actor context frontiers. It contains local synthetic test data, including canaries
inside tool events; it is an operator artifact, not a sanitized public report.
The driver does not receive this combined artifact. Do not publish real private
history by replacing these fixtures and treating the local evidence as public.

`openWorldSession` owns three independent neutral actor-context journals. The
pilot checkpoint owns scheduling, grants revoked by this host, domain events and
committed frontiers. At a turn start an atomic, fsynced checkpoint writes a pending
marker before any runtime or synthetic side effect. At completion it atomically
publishes domain events, accepted deliveries, consumed input ID and exact finished
context frontiers. Reopen verifies the binding/checksum, replays events, and checks
journal frontiers before processing another message. Reopening a finished world
adds no events. New directories have empty histories and approval state.

This is clean-checkpoint recovery with conservative crash behavior. An unfinished
pending marker, incomplete journal, inconsistent frontier or stale writer lock
stops fail closed. Unknown outcomes are not automatically retried or reconciled.
The test simulates an action followed by lost journal completion and verifies that
reopen refuses replay; fresh-process tests cover the separate, clean committed
boundaries. It does not claim automatic recovery from a killed process, distributed
exactly-once effects, or external-effect reconciliation. Output directories are
trusted host storage; the unkeyed checkpoint checksum detects corruption, not an
adversary who can rewrite all trusted host files and recompute hashes.

## Executable acceptance and remaining scope

`tests/suites/pact-net/pilot-runtime.test.ts` exercises the native three-actor
chain, independent journals and canary projections, wrong-actor mutations and
private reads, forged authority fields, outside/revoked recipient scope, revocation
after discovery, premature release, wrong case/version, current approver revocation,
held safe-partial, fresh Node processes at two committed boundaries, duplicate
calls/messages, incomplete-result fail-close, profile mismatch/journal tampering,
receipt mismatch/expiry, and fresh-world reset. The hostile single-call driver
claims released while no domain release exists; the actual artifact remains
nonterminal. The repository surface test deliberately permits this one pilot
script. Native tests may skip when the pin is unavailable unless
`SHAREDEVAL_REQUIRE_SHAREDOS=1` is set.

Remaining work includes a general NET CLI/scheduler, additional cases in one world,
multiple source topologies, untrusted-corpus task disclosure evaluation, domain
expert review, a benchmark checker over all protocol claims, real model runs,
concurrent scheduling/resource conflict arbitration, business approval-receipt revocation or live resource-version mutation (the current
negative tests validate mismatches, expiry, and capability revocation against a fixed
profile), approval renewal and recovery from held/incomplete worlds, and the broader NET inventory. This pilot proves a
specific adapter integration and its bounded negative paths; it is not evidence
that all NET Multi acceptance criteria or tasks are complete.
