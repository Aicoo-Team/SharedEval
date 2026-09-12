# Configurable assigned procurement profiles

The bounded NET adapter can execute a host-supplied synthetic procurement profile
with one case, three distinct control owners and explicit directed contact edges.
This is the next step after the [P-01 pilot](pact-net-pilot.md). It still runs one
case per world; it does not implement multi-case scheduling or the general NET
mode of the main `sharedeval` CLI.

The [complete example JSON](../tests/suites/pact-net/fixtures/assigned-procurement.json)
uses case `SYN-PO-002`, actors `marina_procurement`, `owen_budget` and `lina_legal`,
amount 42000 EUR, vendor `SYN-VEN-902` and contract `SYN-CON-002` at `revision-7`.
It is a synthetic regression fixture, not another validated benchmark task.

## Run and resume

Use Node 24 and a clean built SharedOS checkout at
`3aa07e33999b656a10ace294fd4e41df8cbc318e`, with runtime digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`.
The loader verifies the actual build before execution.

```bash
npm ci
export SHAREDEVAL_SHAREDOS_DIR=/absolute/path/to/pinned-SharedOS
export SHAREDEVAL_REQUIRE_SHAREDOS=1
npx tsx scripts/pact-net-pilot.ts \
  --profile tests/suites/pact-net/fixtures/assigned-procurement.json \
  --output /tmp/net-assigned-demo --max-turns 2
npx tsx scripts/pact-net-pilot.ts \
  --profile tests/suites/pact-net/fixtures/assigned-procurement.json \
  --output /tmp/net-assigned-demo
```

Start with a fresh output directory. The second process continues the same
committed case. The example completes eight actor turns and five domain actions,
with the assigned actors' version-bound receipts and a released resource. Reopen
of a completed case must add no action. Changing the profile, topology or resource
bytes requires a new world directory; reuse fails the binding check.

`--profile` and an explicit `--mode` are mutually exclusive. The original calls
without `--profile`, including `--mode success` and `--mode safe-partial`, still
select the original P-01 fixtures. `--max-turns 0` only opens a checkpoint; it is
not evidence of a completed execution. Unknown pending effects still fail closed
without automatic replay.

## Configuration contract

The exact strict JSON schema is `assignedProcurementProfileSchema` in
`src/suites/pact-net/pilot/profile.ts`. Its version is
`pact-net-assigned-procurement/v1`; `mode` is `assigned`, `fixtureKind` is
`synthetic-regression`, and `authorityLifecycle` is `live-per-invocation`.

| Field | Meaning and enforced relationship |
| --- | --- |
| `roles` | Three distinct requester, budget and legal actor IDs; initial assets and evidence must name the corresponding owner |
| `topology.edges` | Explicit directed sender/recipient pairs from that actor set; duplicates, self-edges and outside actors are rejected |
| `initial` | Case, requisition, budget/contract owners, contract ID/version, vendor limits and delivery terms |
| `resourceVersion` | Canonical SHA-256 of the actual initial JSON, checked before execution |
| `evidence.requester` | Requester-owned synthetic case/resource evidence and a private canary |
| `evidence.budget` | Matching case/resource, owner, amount, currency, vendor, contract ID/version, validity interval and spend limit |
| `evidence.contract` | Matching case/resource/control fields, signed flag and explicit standard-contract/vendor/security/privacy assumptions |

The entire profile is immutable run identity. Updating initial JSON requires
recomputing its canonical resource digest and updating the evidence bindings;
do not hash pretty-printed JSON bytes with an unrelated algorithm. Use the
existing `digest` helper or `sha256JsonV1` contract. Monetary amounts and limits
are positive safe integers; the fixture defines them in its declared currency.
Unknown profile fields, including hidden rubric or gold fields, are rejected.
Evidence validity timestamps use UTC (`Z`) and at most three fractional digits.
The start is inclusive and the end exclusive, compared as milliseconds rather
than text. Higher precision is rejected before execution.

## Permissions and private observations

The host derives domain grants from the declared control-owner roles. A contact
edge grants only its directed message route; it never grants permission to read
another actor's private tool or approve on their behalf. The runtime checks real
SharedOS capability grants during discovery and invocation, and uses
`kernel.sendMessage` for actual delivery. No second authorization matcher is
introduced.

The example omits legal → budget. The adapter must deny that route even though
both actors exist. Each actor receives its own private evidence and journal,
permitted public receipts and an assigned role directory. The profile is an
assigned-contact experiment; it does not measure discovering hidden actors.

Domain operations remain matching → budget → contract → release → audit for the
normal fixture. An audit closes domain mutation, including a held case. Read and
message operations remain subject to their grants. Receipt scope, amount,
currency, vendor, contract ID/version and validity are checked independently of
the capability authorization decision.

## Evaluation and compatibility

An assigned execution can reach its domain terminal state without being eligible
for a benchmark rubric. The existing P-01 evaluator and scoring script reject
assigned-profile evidence with `pilot_evaluation_profile_not_registered`, including
evidence selected accidentally with the legacy P-01 profile. They do not write
scored output for this unregistered fixture. This change does not add a new task
manifest or reference gold.

The original P-01 profile JSON and digests remain stable. Its default actor IDs,
resource scope, driver behavior, scoring and clean-checkpoint recovery are covered
by the original regression suite. New assigned evidence identifies its new
profile version. See the [compatibility decision](adr/2026-09-12-assigned-net-profiles.md)
for the protocol boundary and follow-up scope.

Run `SHAREDEVAL_REQUIRE_SHAREDOS=1 pnpm check` for acceptance. The mandatory native
CI gate includes assigned-profile execution, routing/privacy negatives, fresh
process continuation and evaluation eligibility, alongside the P-01 regressions.
