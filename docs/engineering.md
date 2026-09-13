# Engineering standard

This document defines design, review, and acceptance requirements. Current
behavior is documented in [architecture](architecture.md) and
[running](running.md); future plans must identify their implementation status.

## Boundaries and ownership

| Concern | Accountable layer | Required boundary |
| --- | --- | --- |
| One bounded turn; discovery, tool and message authorization | SharedOS | Hosts supply trusted grants and ports; SharedOS decides and audits access. |
| Scheduling, run identity, durable storage, budgets and artifacts | SharedEval runner/host | Invoke SharedOS for every actor turn; preserve immutable run bindings. |
| Agents, resources, topology and initial state | World definition and host adapters | Author reusable state separately from benchmark selection and scoring. |
| PAIR/NET task selection, policy condition, completion and metrics | Benchmark profile/suite | Consume explicit world/runtime contracts; keep gold in evaluation. |
| Provider transport and tool syntax | Model driver | Receive SharedOS-filtered tools and return decisions; hold no independent authority. |

The world/profile separation is a design constraint for new execution work,
not a claim that a generic world runner exists in this checkout. A profile
selects an experiment over a world; it must not create a competing authorization
engine. PAIR and NET may differ in task topology, scheduling requirements, and
scoring while using the same SharedOS boundary. Keep profile-specific behavior
out of reusable world code and all benchmark semantics out of SharedOS.

At the baseline `dc5d482`, PACT-Pair `multi` and `single` are production CLI
targets. PACT-Net has data/evaluator validation against `old/` and a separate
v2 Python fixture pilot; there is no integrated NET runner. A task called
"executable" in the authoring dataset does not establish runtime support.

Each change names an accountable author and an actual reviewer or affected
boundary owner. Parallel work declares file/module ownership. Review the
runtime boundary, evaluator semantics, and dataset validity with the appropriate
owners; do not invent CODEOWNERS accounts or count an unassigned reviewer as
completed review.

## Design records

A small local change can carry its design in the PR. For a feature crossing
boundaries, add a document under `docs/` with:

1. Status (`proposed`, `accepted`, `implemented`, or `superseded`), owner, base
   revision, and upstream dependencies.
2. Concrete problem and observable outcome; scope and exclusions.
3. Layer ownership, dependency direction, data flow, and public/persisted
   contracts, including version and JSON-safe runtime schema.
4. Authorization, visibility, failure, cancellation, and recovery behavior.
5. Alternatives and the tradeoff behind the decision; compatibility and
   migration/rollback implications.
6. Acceptance cases, actual command entrypoints, evidence tier, and remaining
   implementation gaps.

Use a numbered ADR in `docs/adr/` for breaking protocol, authorization,
persistence, execution-boundary, or profile-isolation decisions. Extend the
existing sequence; link the superseded decision rather than silently changing
its meaning. Accepted design is not implemented evidence. Mark implementation
complete only when the named acceptance cases have passing evidence.

Protocol and artifact changes must preserve explicit versions and reject
invalid input at trust boundaries. Do not silently reinterpret a versioned
field, remove a public export, or change digest/replay semantics. State how old
artifacts are read, migrated, or explicitly rejected. Payloads must serialize
as JSON without functions, class instances, cycles, or non-finite numbers.

## Security and recovery review

Permission changes need allow and deny cases with the relevant actor, authority,
resource scope, purpose, expiry, namespace, and trace. Discovery filtering alone
is insufficient: execution must reauthorize. An admission-denied turn starts no
model/provider work. A denied tool or message call invokes no protected resource
handler or transport and commits no protected state effect; the model may have
already run to request that denied call. Forged IDs or
grant-shaped message content cannot select trusted identity or authority.

Keep hidden gold, grading labels, rubrics, reference trajectories, and other
actors' private histories outside agent context. Agent workspaces expose only
approved resources. The current v1 fresh-turn protocol uses `MEMORY.md` for
continuity. A persistent-context protocol must version its contract and record
its ADR, isolate each actor's own journal, bind replay to durable history, and
retain audit provenance. Never inherit undocumented provider chat state or
another actor's journal. Evaluate observed trusted events rather than solver-authored
claims of authorization or completion. Public artifacts contain sanitized
provenance; private audit evidence retains the identifiers needed to reconstruct
authorization and message causality.

Recovery must distinguish proven completion, proven non-execution, and unknown
external completion. Preserve the unknown case as indeterminate without an
automatic retry. Replaying completed work must produce zero new model calls,
message sends, and state-changing operations. Evidence must bind run/config,
task selection, runtime provenance, durable operation/message IDs, and workspace
versions. Never overwrite a prior run to conceal a failed attempt or reroll a
terminal model outcome as if it were the same experiment.

## Validation and evidence

Install with `npm ci`; `package-lock.json` is authoritative. `npm run check`
runs `validate`, `type-check`, and `test` in sequence and stops on failure.
`pnpm check` can invoke this script after installation without migrating the
repository to pnpm. Record the Node and package-manager versions used. The
baseline engine requirement remains Node.js 20.11 or newer; use Node.js 24 for
world/native runtime acceptance unless the target branch pins another version.

| Change or claim | Existing command | What it verifies |
| --- | --- | --- |
| Every handoff | `npm run check` | Catalog validation, TypeScript types, and the current test suite; conditional SharedOS skips must be reported. |
| PAIR data/evaluator | `npm run smoke:pact-pair` | PAIR validation; no model execution. |
| NET canonical data/evaluator | `npm run smoke:pact-net` | NET validation; no integrated NET execution. |
| Public PAIR export | `npm run export:huggingface:pact-pair` | Deterministic canonical 600-row export. |
| Execution boundary | `SHAREDEVAL_SHAREDOS_DIR=/path/to/pinned/SharedOS npm run test:sharedos` | Required real SharedOS loader/conformance cases; missing builds fail. |
| Run configuration | `npm run sharedeval -- --config sharedeval-run.yaml --check` | Configuration and digest only; no SharedOS or model calls. |
| NET v2 authored world | `python3 dataset/pact-net/scripts/review.py dataset/pact-net` | World consistency, with disclosed warnings. |
| NET v2 evaluator pilot | `python3 dataset/pact-net/scripts/test_executable_core.py` | Draft evaluator fixtures in the script's own dataset tree; no configurable root, agent runner or practitioner validation. |

Use [running instructions](running.md) to build the exact SharedOS pin and to
execute a bounded real-model run. Read the loader constants in the checkout
being tested: baseline `dc5d482` uses revision
`a303d97fe974c149d4575b1f5d6426aee6f37367` and digest
`faefbf2ae61ffdcaf57f76e0c5b9b3f1438790213c0f16b3e02905bdbcba37cb`.
An alternate branch's SharedOS pin is a separate dependency; do not combine
results from different pins into one acceptance claim.

| Evidence tier | Required evidence | Claim limit |
| --- | --- | --- |
| Fixture/unit | Named fixtures, assertions and counts, with all substituted ports identified. | Proves local contracts or scoring; does not prove agent execution. |
| Scripted real-SharedOS integration | Verified pin/digest, real kernel, named scripted model/transport substitutions, allow/deny audit and zero required skips. | Proves the exercised runtime path; does not measure live model behavior. |
| Live-model execution | Real CLI/config/run identity, provider/model identity, budgets, usage, trusted traces, evaluation records, and sanitized artifacts. | Proves that bounded run; does not prove restart recovery. |
| Cold-process recovery | Distinct process launches, interruption point, durable bindings, reconstructed state, operation counts and artifact comparison. | Proves tested restart/replay cases; object reconstruction in one process is insufficient. |

Report live provider use and process boundaries independently: a cold-process
test may use a scripted provider. Use "end-to-end" only with the exact entrypoint,
layers traversed, substitutions, and tier stated. For runtime acceptance cover
requester → authorized request → recipient turn → authorized reply → scoring
and artifacts; include allow/deny isolation and relevant recovery cases. A
passing NET evaluator fixture cannot satisfy that path.

Each evidence record includes SharedEval base/head, SharedOS revision/digest
where used, environment, command, exit code, passed/failed/skipped counts, and
log/artifact locations. Record configuration/task-set identity for runs. Inspect
failed stages independently when `check` stops early. Keep original baseline
failure logs and distinguish unchanged failures, new failures, and unrun checks.
A red or skipped required gate remains open and must be visible in the PR.

## PR and integration gates

Use the [PR template](../.github/pull_request_template.md). Commit messages use
`<type>(<scope>): <subject>`. Each PR has a concrete outcome, deliberate exports,
clear ownership, design/ADR links when required, and evidence for its own head.

For a stack, record the immediate base branch/SHA, head branch/SHA, upstream PRs,
merge order, and external runtime prerequisites. Review the diff against that
base. After an upstream merge or rebase, update provenance, inspect the changed
diff, and rerun affected checks. Resolve dependencies and review findings before
merge; do not treat a downstream fixture pass as upstream availability or
production acceptance. Delivery notes distinguish merged code, runnable paths,
completed evidence, and still-open acceptance work.
