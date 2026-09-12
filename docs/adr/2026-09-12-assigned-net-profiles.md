# Assigned NET procurement profiles

Status: implementation in `codex/sharedeval-net-profiles`, stacked on PR 59
at `a883f51cc573e87fb003fd39d5c40e138af5d2d5`.

## Decision

The bounded NET adapter accepts a versioned, host-supplied assigned procurement
profile. A profile binds one case, three distinct control-owner roles, explicit
directed contact edges, the initial resources and synthetic owner evidence.
Roles select the owners of existing procurement operations. They do not bypass
SharedOS authorization or grant rights through message content.

The new JSON version is `pact-net-assigned-procurement/v1`. It uses `mode: assigned`
and the existing explicit `live-per-invocation` authority lifecycle. The complete
validated profile and actual initial resource digest participate in the immutable
run binding. Case scope, evidence owners, amount, currency, vendor, contract
version and validity fields are checked before any driver is opened. Unknown
keys, duplicate owners/edges and edges outside the actor registry are rejected.
Evidence validity accepts UTC timestamps with zero to three fractional digits.
Comparisons use parsed milliseconds, include the start and exclude the end;
finer precision is rejected rather than silently truncated.

The host emits capability grants only for the declared roles and directed edges.
There is no implicit complete graph. Discovery and invocation still use the
actual pinned SharedOS kernel; every message is authorized by that kernel.
Each actor receives only its private projection, permitted public case receipts,
incoming messages and its own journal. A role assignment does not expose the
other actors' private evidence or history.

## Compatibility and evaluation

The original `createPilotProfile` / `loadPilotProfile` P-01 JSON remains unchanged.
Existing default CLI calls keep their behavior. Legacy profile digests and clean
checkpoints must still reopen under the same runtime pin. A new assigned profile
cannot resume a legacy or differently bound world merely because its run ID or
case ID matches. Unknown pending effects remain a hard stop.

The bounded execution script adds `--profile` for an explicit JSON file. It is
mutually exclusive with explicit `--mode`; neither silently overrides the other.
The new profile format is not a new mode of the main `sharedeval` CLI.

The existing P-01 post-hoc evaluator remains restricted to the original registered
P-01 profile. Assigned-profile execution evidence is not automatically eligible
for that rubric, including a synthetic profile that reuses the same case ID.
Execution success and benchmark evaluation eligibility are different claims.
The second case is an explicitly named synthetic regression fixture, not an
additional validated benchmark task. No gold or hidden rubric is a runtime input.

## Alternatives and scope

Changing legacy P-01 fields in place would silently change old profile identity
and recovery semantics. Duplicating a second fixed adapter would leave actor,
case and routing assumptions hidden in code. A separate strict configuration
version keeps the old pilot reproducible while testing the reusable boundary.

This change runs one case per world. Multiple cases sharing one persistent world,
whole-world Single reset, general NET CLI integration, discovery experiments,
live resource mutation and paid providers remain separate changes. SharedOS,
PAIR scheduling and the original Python rubric remain unchanged.

## Acceptance

- Original P-01 positive, negative, audit-order and scoring tests still pass.
- The legacy P-01 and an assigned configuration with different case/actor/resource identities run
  through the native runtime without hard-coded P-01 identity leakage.
- Role, case, resource-version and owner-evidence mismatches fail at the proper
  boundary; denied routing invokes no protected transport or side effect.
- Private projections remain actor-local, and changing a topology/profile cannot
  reuse an existing checkpoint binding.
- Legacy clean checkpoints reopen; unregistered assigned evidence cannot use the
  P-01 evaluator; indeterminate effects are never replayed.
- A fresh Node 24, pinned-runtime-required `pnpm check` records its exact source
  SHA, runtime digest, result and skip count before PR handoff.
