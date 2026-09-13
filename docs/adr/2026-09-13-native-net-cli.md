# Versioned native NET command adapter

Status: proposed with implementation, building on the P-01, assigned procurement
and procurement-world adapters.

## Context

The existing native adapters already own bounded actor execution, authorization
and durable case/world state. Their separate scripts do not supply a common run
configuration or bind an exported evidence snapshot to its current checkpoint.
A unified entry point must preserve those contracts and keep benchmark scoring
registration separate from the ability to execute a synthetic profile.

## Decision

Add `sharedeval net check|run|score --config FILE` with the strict
`pact-net-native-run/v1` JSON/YAML format. Supported adapter kinds are
`p01-pilot`, `assigned-pilot` and `procurement-world`. The sole provider is
`scripted-procurement/v1`. The main CLI dispatches these commands without changing
the existing PACT-Pair commands or accepting arbitrary NET tasks/model providers.

`check` validates the complete selected profile and reports identity without
opening a run or loading the native runtime. `run` verifies the pinned SharedOS
build, delegates turns to the existing native session, and publishes a committed
execution snapshot. Its turn limit is per invocation and allows clean resume.
SharedEval owns command dispatch, scheduling and artifacts; SharedOS remains the
host-neutral authority and single-turn execution boundary.

The configuration digest binds the schema version, run ID, explicit provider,
adapter kind, materialized profile digest and required SharedOS revision/runtime
digest. Input and output locations are excluded. This permits relocation of an
intact closed run without making profile content or execution conditions mutable.
Paths resolve relative to the config file. A changed mode, case order, resource,
role, disclosure policy or context budget changes the bound profile identity.

## Publication and ownership

`run-manifest.json` uses `pact-net-command-run/v1` and a checksum. It fixes the
command-level identity before native execution. An existing native checkpoint
without this manifest is not silently adopted. The native adapter remains
authoritative for `checkpoint.json`, pending markers and actor context journals.

`execution.json` uses `pact-net-execution/v1` and a checksum. It binds the exported
evidence to the configuration, exact committed checkpoint body and evidence
digest. It is a receipt for a particular native checkpoint, not a replacement
scheduler or an independently authoritative state store. A current committed
snapshot may be exported before all deliveries drain; that alone does not make
it eligible for scoring.

Commands hold an exclusive `command.lock` across manifest checks and artifact
publication. Manifest inspection/publication also holds `writer.lock`, then
releases it for the native session to acquire and verify its checkpoint binding.
Losing this handoff race fails at native open without an actor turn. Scoring
acquires that same native token for its full read/evaluate/publish operation.
This serializes unified commands and excludes a direct adapter writer from an
in-progress scoring operation. Neither layer automatically removes stale locks.

Reading a scoreable receipt checks manifest identity, checksums, evidence digest,
checkpoint digest and committed/pending state. Stale or corrupt receipts fail
closed before evaluation output is published. A clean native reopen can produce
a fresh receipt; it cannot reconcile indeterminate work or bypass native journal
validation. There is no automatic legacy-directory migration, lock deletion,
unknown-effect replay or journal repair.

## Scoring registration

Only the original P-01 pilot is registered for post-hoc evaluation. Its `success`
and `safe-partial` fixture modes share the registered contract. Assigned profiles
and procurement worlds are executable synthetic regressions without a registered
rubric; a released outcome does not make them eligible for P-01 scoring.

The CLI loads scoring code only for an explicit `score` command. The reusable
post-hoc API first applies the existing P-01 projection, including registration,
committed/drained closure, event replay and matching native authorization audit.
Only then does it write a temporary submission and invoke the existing Python
evaluator with argument-vector process execution. It validates the JSON result
and finite score shape, cleans the temporary directory on success or failure,
and returns values without writing caller-owned report paths.

The unified caller writes a bound `pact-net-evaluation/v1` report. The legacy
evaluation script retains its existing arguments and `submission.json` /
`evaluation.json` files. Evaluator/rubric material does not enter execution;
evaluation cannot schedule an actor turn or create an execution effect.

## Consequences and limits

Users can check, run, resume and inspect the existing bounded adapters through
one versioned surface. Moving storage does not change experiment identity, while
changing execution inputs still requires a new run. A held business outcome or
turn-limited invocation remains distinct from command failure and full completion.

This decision does not implement the broader NET task inventory, multiple
registered benchmark cases, model providers, concurrent domain scheduling or
crash reconciliation. Checksums provide integrity checks under trusted host
storage and do not authenticate files against a writer who can recompute them.
Legacy scripts remain available; their directories require their existing
operational workflow rather than implicit adoption by the new command layer.
