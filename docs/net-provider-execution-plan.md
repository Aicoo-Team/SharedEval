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

PAY-01 is the smallest distinct authored candidate: its existing manifest has
three actors, a separate payment-controls workflow and a separate rubric.
Its authored data does not yet establish a full-success execution source bundle.

- [PAY-01 initial state](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/executable_core/PAY-01/initial_state.json)
  describes a payment of 236,000.
- [Sarah's systems configuration](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/agent_configs/sarah_martinez/systems.json)
  limits spending authority to 25,000, sends larger amounts to the board and
  lists banking read access. The selected three actors have no documented board
  delegation for this payment.
- The [PAY-01 manifest](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/executable_core/PAY-01/manifest.json)
  itself leaves payment authority and approver/releaser separation for human
  review. The [task inventory](https://github.com/Aicoo-Team/SharedEval/blob/dc5d482403bd5dfb38ab6af92db399d6cbea3121/dataset/pact-net/tasks/pact_net_tasks_v2.json)
  also lacks a PAY-01 assigned-mode support entry, unlike P-01 and F-08.
- The selected actor stores do not contain PAY-778-specific vendor, callback or
  invoice records. A personal mortgage note referenced by the privacy probe is
  not supplier-verification evidence.

The dataset owner must supply and review a versioned execution-source bundle:
case-specific vendor and invoice records, authoritative verification sources,
approval/release authority or delegation, separation rules, and an assigned-mode
support declaration. Each record needs a source identity and an actor-visible
projection. The host must not derive missing permissions or facts from gold.

F-08 is a four-actor alternative with explicit assigned support and no Alex
external-corpus dependency. Its BR-441/442/443 classifications and source
approvals also need to be authored. PAY-01 and F-08 share three actors, making
them useful future continuity cases once both execution sources are ready.

| Candidate | Minimum author decisions and source records |
| --- | --- |
| PAY-01 | Case-bound vendor/payee/invoice records; independent callback source and result; authority covering the material payment or an enforced hold; named preparer, approver and releaser with separation rules; assigned-mode declaration |
| F-08 | BR-441/442/443 classifications, dates, amounts, approval IDs and accounting treatment; authorized minimum-necessary summaries from evidence holders; reconciliation approval/posting authority and an unresolved-entry hold path |

An unsupported binding should fail preflight. A supported partial path may
honestly hold or deny an operation. Neither result establishes validated
full-success readiness, and engineering registration does not upgrade draft
gold to practitioner-validated gold.

## Authored-case registration and heterogeneous worlds

Register each supported task through an explicit adapter. Proposed modules are
`src/suites/pact-net/authored/{schemas,inventory,projection,authority,registry}.ts`,
case adapters under `authored/cases/`, and separate authored session, evaluation
and scoring modules. Keep the historical loader and existing P-01 scoring
contract intact.

Each registration binds the task and source revision, initial/private source
hashes, trusted authority profile, reducer, audit projection and its own rubric
hash. Gold and rubric content remain evaluator-only. Synthetic assigned/world
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

1. `check` produces no run artifacts or HTTP calls. Unsupported configuration,
   missing source records, runtime mismatch and invalid declared authority fail
   at their documented preflight boundary.
2. Each actor's request stream contains its own projection and exact committed
   later-turn history. Rubric, gold and unrelated private evidence are absent.
3. Real tool calls create authorized effects. Wrong actors, ungranted recipients,
   revoked grants and fabricated completion claims cannot create those effects.
4. A fresh process resumes committed history without duplicate execution. Actual
   results received before abort are retained; unknown/pending effects remain
   fail-closed and are not silently replayed.
5. After the second source bundle is accepted, one configuration runs two
   registered cases, resumes across their boundary and emits independently bound
   per-case scores. Multi retains authorized world history; Single resets the
   complete world between cases.
6. Scoring makes zero provider requests, preserves checkpoints, uses the matching
   registered rubric and rejects pending or indeterminate execution.

Record the final SharedEval source/tree identity, SharedOS revision/digest, Node
version, provider kind, commands, exit codes, test totals and artifact hashes.
Keep synthetic wire captures with the acceptance artifact and publish sanitized
summaries. Run a fresh native-required `pnpm check` on the final implementation;
separate successful checks from skips, earlier failures and model experiments.
