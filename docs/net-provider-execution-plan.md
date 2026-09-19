# NET provider and authored-case follow-ups

This is the next implementation plan after the bounded native NET stack. It is
not a claim that provider execution or a second registered case is implemented.
The inspected baselines are NET PR65 `5da4785c781cd660fd3c41cc42cdbe137f895f32`
and dataset/main `dc5d482403bd5dfb38ab6af92db399d6cbea3121`. PAIR recovery in
PR67 also changes the shared driver and actor-context store; implement the
provider work on the reviewed combined baseline and validate the combination.

## First PR: provider execution through the public NET entry

The first useful increment connects the existing P-01 adapter to an actual
OpenAI-compatible provider transport. A local HTTP test server can exercise this
path without paid model calls. Keep general inventory selection and additional
case registration as separate completion gates.

At the inspected baseline, `src/runner/net/config.ts` accepts only
`scripted-procurement/v1`, and `src/runner/net/cli.ts` constructs that scripted
driver. `PilotDriverFactory` already supplies the native `SoTurnDriver` seam.
`FileModelDriver` has the provider transport, cancellation and telemetry, but
also injects PAIR file/MEMORY instructions. Its existing provider session does
not consume NET's `request.state.history`.

Use an explicit trusted host strategy for protocol messages, authorized tool
schemas and prior-turn history. Preserve PAIR's current default strategy. The
NET strategy receives only the actor's authorized initial projection and
durable history. Keep native dispatch and authorization in SharedOS and its
existing tool/message handlers; neither provider text nor a tool result grants
authority.

NET's `journalDriver` already owns begin/append/finish for each turn. It must
remain the sole journal owner. Passing the same actor store into another driver
that also opens the turn would duplicate lifecycle ownership. Preserve PR67's
settlement-before-abort behavior for received, identity-validated results and
its rejection of unknown or closed-turn results.

| Area | Planned change |
| --- | --- |
| `src/runner/v1/file-model-driver.ts` | Add the host protocol strategy while retaining PAIR behavior and transport checks |
| `src/runner/net/provider.ts` | Adapt the existing provider transport to the NET driver factory and authorized history |
| `src/runner/net/config.ts`, `cli.ts`, `artifacts.ts` | Add an explicit provider choice, validate it before execution, and bind its identity to the run |
| Pilot/world binding and evidence metadata | Record the selected driver honestly; provider runs must not emit a scripted-only evidence identity |
| P-01 evidence schema and evaluation projector | Add explicit validation and post-hoc projection for versioned provider evidence while preserving the legacy scripted path |
| Driver and public CLI tests | Exercise HTTP requests, native effects, cancellation, authority denial and cold-process continuation |

Provider identity must be reproducible without storing credentials. Record the
model/protocol/adapter identity and non-secret endpoint configuration; resolve
credentials using the existing host configuration. Define any new binding or
evidence version in an ADR. Preserve old scripted configurations and retained
artifacts explicitly instead of silently reinterpreting them as provider runs.

The current P-01 evaluation projector accepts only
`scripted-native-runtime-pilot` evidence. Include an explicit versioned P-01
provider evidence projector in this first PR: it must validate the provider-bound
committed runtime evidence before producing the P-01 evaluation submission.
Preserve the existing scripted projector and PR65's evaluator provenance/output
checks. Provider scoring must return a typed unsupported error until that
projector is available; changing an evidence label or sharing a JSON shape is
not registration. This change does not register any additional case or rubric.

The first PR does not close the general-inventory gate: it establishes the
public provider path for an already supported case. A later inventory adapter
must validate selected authored tasks and their source projections.

## Second-case source gate

PAY-01 and F-08 are distinct authored candidates with existing rubrics. Choose
the case whose reviewed execution-source bundle becomes complete first; actor
count alone does not determine readiness. Neither current bundle establishes
validated full-success execution.

- [PAY-01 initial state](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/executable_core/PAY-01/initial_state.json#L2)
  supplies case PAY-778, a due timestamp and `amount: 236000`, but no currency
  or amount unit. It cannot yet be compared with a USD authority threshold.
- [Sarah's systems configuration](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/sarah_martinez/systems.json#L18)
  lists banking read access and, separately, a USD 25,000 spend-approval limit
  with larger spending referred to the board. Spend approval is not payment
  release authority, and neither entry supplies PAY-778-specific delegation.
- Carlos's existing [Procurement Policy](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/carlos_reyes/data.json#L35)
  already describes purchase-approval tiers and board notification. His
  [Audit Prep with Elena](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/carlos_reyes/data.json#L83)
  already describes vendor-payment maker/checker roles and bank dual-signature
  controls. These are general source policies; board notification is not a
  delegation, and these notes do not establish the case-specific action grants.
- The [PAY-01 manifest](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/executable_core/PAY-01/manifest.json#L150)
  asks for review of the materiality threshold, Sarah's payment authority,
  callback ownership and approver/releaser separation. The
  [task inventory](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/pact_net_tasks_v2.json#L18938)
  also lacks a PAY-01 assigned-mode support entry, unlike P-01 and F-08.
- PAY still needs case-bound vendor/payee, contract and invoice records and an
  authoritative callback source/result. The personal mortgage note referenced
  by its privacy probe is not supplier-verification evidence.

F-08 has four actors, explicit assigned support and no Alex external-corpus
dependency. Its [initial state](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/executable_core/F-08/initial_state.json#L2)
already supplies period `2026-08` and the three BR entry IDs and amounts.
Hannah's [March close note](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/hannah_brix/data.json#L5)
describes three possible explanations without mapping them to those August
entries. It does not establish BR-441/442/443 classifications. Her
[policy](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/hannah_brix/POLICY.md#L29)
already requires client sign-off before posting and forbids self-approval.
What remains missing is case-bound evidence and sign-off mapped to the actual
approval/posting operations, not the existence of a general sign-off rule.
PAY-01 and F-08 share three actors and could support future continuity checks
once their execution sources and registrations are ready.

Preserve the selected access profile when producing minimum-necessary evidence.
Under `structural_tight`, the existing notes grants from
[Carlos](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/carlos_reyes/grants.json#L200)
and [Sarah](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/sarah_martinez/grants.json#L201)
allow Hannah to read only the `Shared` folder. The separately declared
`structural_loose` profile has broader folders. Do not silently widen folders or
switch profiles to obtain missing facts. Any evidence-summary publication must
itself be authorized for the source, fields and recipient.

| Candidate | Minimum author decisions and source records |
| --- | --- |
| PAY-01 | Define currency/amount unit and bind the due timestamp to the execution clock; supply case-bound vendor/payee, contract and invoice records plus independent callback source/result; resolve applicable policy and name the delegated verifier, preparer, approver, master-data writer and payment releaser with scope and separation rules; declare assigned-mode support and any evidence-unavailable variant |
| F-08 | Preserve the existing August period, entry IDs and amounts; define currency/units and execution clock; supply the per-entry classification, date, approval ID and accounting treatment with source references; provide authorized minimum-necessary summaries and case-bound client sign-off; map preparation, review and posting to explicit grants and separation rules |

The versioned execution-source bundle must bind source identities/hashes,
currency and clock semantics, the selected access profile, and delegation for
each operation, including any hold operation. It must also identify the
projection, adapter, reducer, audit projection and rubric versions. Declare
separately whether sources are synthetic, the adapter is engineering-registered,
a partial variant is supported, scoring is registered, and domain/gold review
is complete. A general policy note or a gold result cannot fill a missing fact
or grant.

Malformed bundles, missing required references and unsupported variants fail
preflight. A complete, explicitly supported `evidence-unavailable` variant may
instead run and report a named blocker without claiming success. Refusing a
release or posting operation leaves its resource unchanged; it does not itself
create a `held` state. Any hold mutation requires its own authorized operation,
reducer transition and audit evidence. A supported denied/partial path does not
establish validated full-success readiness, and engineering registration does
not upgrade draft gold to practitioner-validated gold.

## Authored-case registration and heterogeneous worlds

Register each supported task through an explicit adapter. Proposed modules are
`src/suites/pact-net/authored/{schemas,inventory,projection,authority,registry}.ts`,
case adapters under `authored/cases/`, and separate authored session, evaluation
and scoring modules. Keep the historical loader and existing P-01 scoring
contract intact.

Each registration binds the task and source revision, initial/private source
hashes, currency/clock semantics, selected access and trusted authority profiles,
projection/adapter/reducer/audit versions and its own rubric hash. It records the
declared source, engineering, partial-path, scoring and domain-review statuses
separately. Gold and rubric content remain evaluator-only. Synthetic assigned/world
procurement fixtures must not inherit an authored task's registration by name.

The existing world session assumes procurement events and audit closure.
Heterogeneous worlds need per-adapter event validation, replay and completion.
The Python evaluator accepts task IDs, but PR65 deliberately binds its launcher
and result validation to P-01; the authored scoring path needs explicit
registered-case dispatch and matching output validation.

## Acceptance evidence

Run the actual NET CLI against a local OpenAI-compatible HTTP server with a
dummy credential. The server supplies provider responses; the native runtime
executes the resulting operations. This proves transport/runtime integration,
not model reasoning quality.

1. `check` produces no run artifacts or HTTP calls. Malformed bundles, missing
   required references, unsupported variants, runtime mismatch and invalid
   declared authority fail at their documented preflight boundary. An explicitly
   supported evidence-unavailable variant is validated as such, rather than
   rejected merely because the requested business evidence is unavailable.
2. Each actor's request stream contains its own projection and exact committed
   later-turn history under the selected access profile. Rubric, gold and
   unrelated private evidence are absent. Evidence summaries do not bypass
   folder/field/recipient grants; test the `Shared`-only profile without widening it.
3. Real tool calls create authorized effects. Wrong actors, ungranted recipients,
   revoked grants and fabricated completion claims cannot create those effects.
   Test approval and release/posting as distinct permissions, with case,
   currency, amount, clock and separation rules bound. Denied release/posting
   leaves the resource unchanged; a held-state transition is accepted only when
   its separately authorized hold operation actually commits.
4. A fresh process resumes committed history without duplicate execution. Actual
   results received before abort are retained; unknown/pending effects remain
   fail-closed and are not silently replayed.
5. After the second source bundle is accepted, one configuration runs two
   registered cases, resumes across their boundary and emits independently bound
   per-case scores. Multi retains authorized world history; Single resets the
   complete world between cases. Include the registered unavailable-evidence
   path separately from any full-success path, and retain its partial/scoring/
   domain status in the result rather than treating a denied action as completion.
6. Scoring makes zero provider requests, preserves checkpoints, uses the matching
   registered rubric and rejects pending or indeterminate execution.

Record the final SharedEval source/tree identity, SharedOS revision/digest, Node
version, provider kind, commands, exit codes, test totals and artifact hashes.
Keep synthetic wire captures with the acceptance artifact and publish sanitized
summaries. Run a fresh native-required `pnpm check` on the final implementation;
separate successful checks from skips, earlier failures and model experiments.
