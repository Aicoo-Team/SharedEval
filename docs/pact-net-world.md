# NET procurement worlds

The bounded world adapter runs an ordered list of assigned procurement cases
through the pinned SharedOS runtime. The supplied two-case synthetic profiles use
the same three actors and fresh case/resource/evidence identities for each case.
`multi` preserves actor histories and resource effects; `single` starts a fresh
world for each case. Both conditions use the same case order, context budget, and
explicit public-state disclosure policy.

The [native NET commands](pact-net-native-cli.md) provide a versioned configuration
for this adapter. The dedicated script below remains available for legacy runs.

The complete PAIR and NET execution plan is maintained in
[the governance PR](https://github.com/Aicoo-Team/SharedEval/pull/58).
This adapter implements its persistent NET world and Single reset stage.
See the [lifecycle decision](adr/2026-09-13-net-world-lifecycle.md) for authority,
commit, and recovery boundaries.

## Run and resume

Use Node 24, `npm ci`, and a built copy of SharedOS at the repository's verified
pin. Set `SHAREDEVAL_SHAREDOS_DIR` to that checkout and
`SHAREDEVAL_REQUIRE_SHAREDOS=1` to make an unavailable runtime fail the checks.

```sh
npm exec -- tsx scripts/pact-net-world.ts \
  --profile tests/suites/pact-net/fixtures/procurement-world-multi.json \
  --output /tmp/net-world-multi --max-turns 8

# A separate invocation resumes at the committed case boundary.
npm exec -- tsx scripts/pact-net-world.ts \
  --profile tests/suites/pact-net/fixtures/procurement-world-multi.json \
  --output /tmp/net-world-multi --max-turns 40

npm exec -- tsx scripts/pact-net-world.ts \
  --profile tests/suites/pact-net/fixtures/procurement-world-single.json \
  --output /tmp/net-world-single --max-turns 40
```

Use a fresh output directory for a new experiment. Reuse the same profile and
directory to resume. `--max-turns 0` opens and reports the committed checkpoint;
the default is 40, with a maximum of 1000 per invocation. Reopening a completed
world does not schedule extra effects. A limit is a pause at a committed turn;
an incomplete pending turn is a recovery error.

## Profile and visible state

A world profile contains `version`, `mode`, `context`, `cases`, and `publicState`.
There are 1–8 unique cases. Each case independently satisfies the
[assigned procurement contract](pact-net-assigned-profiles.md). The world freezes
the sorted union of actor identities before opening any context store.

`publicState.caseIds` lists exactly which partitions may be inspected through
`net.world_read_public`; `publicState.readers` lists the actors granted that read.
Empty lists express no disclosure. The supplied fixtures grant only the requester.
Budget and legal actors may read their own case views and private evidence under
their case grants, but cannot invoke the world read merely because it exists.

The public world read includes only `case_id`, `resource_version`, `status`,
`records_matched`, `budget_verified`, `contract_verified`, and `audit_written`.
In Multi, reading case A during case B can observe A's committed release. In
Single, that resource partition has returned to its initial state. A person's own
private history persists in Multi, while another actor's private evidence remains
excluded from that person's observations. History never authorizes an operation.

## Evidence and acceptance

`evidence.json` records the experiment profile digest, verified runtime identity,
global progress, case event/execution/audit archives, current resource state,
context epochs and frontier intervals. Completion requires all cases to finish
their domain audit and drain their queues. `terminal_success` additionally
requires each archived case to have released successfully. A held case can finish
and permit the next case to run.

The native regression gate exercises persistence and reset, actor-role changes,
explicit public read allow/deny and revocation, case/resource/receipt isolation,
binding changes, and pending-work recovery. It also preserves existing pilot
regressions after extracting shared adapter helpers.

```sh
pnpm check
npm exec -- tsx --test --test-concurrency=2 tests/suites/pact-net/world-*.test.ts
npm exec -- tsx scripts/verify-pact-net-world.ts --output /tmp/net-world-acceptance
```

The verification script requires a new output directory and launches independent
CLI processes for both conditions: 8 turns through case A, one turn into case B,
completion at 16 turns, and a completion reopen. It saves each checkpoint evidence
snapshot, exact commands, current Git HEAD, runtime identity, and asserted results.
The native unit regressions separately test actual public-tool allow/deny and
private model observations; the CLI harness checks persisted effects and context
frontiers. Run against a clean commit when recording acceptance evidence.

This evidence is scripted native integration. The fixtures have no registered
benchmark rubric, so P-01 evaluation is not applicable. Broader NET task/provider
integration, real-model execution, broad task coverage, and practitioner validation
remain separate work. The ordinary CI job may skip native tests when SharedOS is
absent; the dedicated pinned-runtime CI job requires them.
