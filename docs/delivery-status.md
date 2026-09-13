# SharedEval delivery acceptance

Updated 2026-09-13. This record distinguishes design, initial implementation,
independent execution and remaining expansion gates. See the
[PAIR/NET execution plan](multi-execution-plan.md).

| Deliverable | State | Evidence / next gate |
| --- | --- | --- |
| Complete PAIR and NET Multi design | Published for review | PR58; lifecycle, actor views, authority modes, schedules, reset/recovery and acceptance matrix |
| PAIR persistent world | Draft [PR57](https://github.com/Aicoo-Team/SharedEval/pull/57) | Final owner head `4eede49a`; independent 789/789 at preceding `9c4d18a`; final delta only adds a CI gate/test |
| NET runtime and scoring | Draft [PR59](https://github.com/Aicoo-Team/SharedEval/pull/59) | Native three-actor P-01, private journals, authorized effects and separate registered P-01 evaluator; bounded unified entry tracked separately below |
| Assigned NET profiles | Draft [PR62](https://github.com/Aicoo-Team/SharedEval/pull/62) | `8381465`: strict case/actor/topology/evidence binding, full required 841/841, original P-01 compatibility and unregistered-scoring rejection |
| Persistent NET world / Single reset | Draft [PR63](https://github.com/Aicoo-Team/SharedEval/pull/63) | `c13e620`: two cases, full serial 867/867 and mandatory native CI green; local parallel 866/867 remains disclosed |
| Bounded unified native NET entry | Draft [PR64](https://github.com/Aicoo-Team/SharedEval/pull/64) | `4f8d8c0` on `c13e620`: unified check/run/resume/P-01 score; full serial 889/889, CI and four fixed-head CLI runs pass; local parallel 888/889 remains disclosed |
| PAIR e2e | Independently reproduced | Required pinned SharedOS; Multi history continuity, Single reset, deny and failure lifecycle |
| NET e2e | Independently reproduced after review fix | Final `a883f51`: full 814/814, success/held/cold-process CLI runs, and native adversarial audit-order denial |
| NET cross-case e2e | Reproduced at `c13e620` | Both conditions: separate CLI processes 8→9→16 turns, five actions per case, completed reopen unchanged; Multi retains history/effect, Single resets all histories/resources |
| Repository conventions | Draft [PR58](https://github.com/Aicoo-Team/SharedEval/pull/58) | AGENTS, CONTRIBUTING, PR template, architecture/validation conventions and `pnpm check`; green local and remote checks |
| Real-provider e2e | PAIR preflight reported; full-run acceptance pending | PAIR owner retains the current 60-task run; the two-case preflight does not establish completion. Final wrapper/projection/request, protocol-deviation and full-run coverage evidence remain pending. No live NET run is claimed |
| General NET task/provider and multiple-case scoring | Pending | Broader inventory/provider extension and at least two registered case rubrics remain separate gates; assigned/world fixtures are unregistered |
| General/practitioner-validated NET | Not accepted | Further tasks, topologies, resource evolution, domain-owner validation and experiment cells remain |
| Integration with current main | Separate gate | Historical PAIR stack and newer main data must be combined and checked at one final SHA before merge |

No PR has been merged by the supervisor. Room review and independent checks are
recorded separately from author reports. Idle status or a message saying done
is not an acceptance signal.

## Assigned profiles and cross-case extension

PR62 head `83814655575d093ff59c2ae35ca329646f097e9f` passed required-native
`pnpm check`: validation/type-check plus 841/841 tests, zero failures or skips.
Separate CLI processes completed an assigned case and preserved the legacy
success/held P-01 paths. Assigned cases are explicitly ineligible for the P-01
rubric. A later independent reviewer ran 51/51 targeted tests at that same head.

PR63 final head `c13e6204669cd4fdca05af7beff13c46e72db566` adds a frozen ordered
world profile, actor-owned histories, case resource partitions, per-case native
grants and explicit public-state disclosure. Single creates an empty whole-world
epoch while retaining completed case evidence only for the host. Audited cases
drain observer messages before advancing; an audited held case can advance without
claiming business success. Unknown effects and unreleased writer locks fail closed.

At that fixed head, validation/type-check passed and the full serial command
(`npm exec -- tsx --test --test-concurrency=1` with all package test globs) passed
**867/867**, zero failures/cancellations/skips, 242.952 seconds.
[CI 34734349666](https://github.com/Aicoo-Team/SharedEval/actions/runs/34734349666)
passed both jobs: ordinary 808 passed/59 native skips; mandatory runtime10,
world4, old NET50 and new world26 all passed with zero skips.

The same-head local `pnpm check` passed 866/867 tests: one old unsigned-contract
case raised `pilot_pending_turn_incomplete`. That exact isolated case passed
1/1, followed by the complete successful serial run. This record does not label
the parallel check green or claim that the timing cause is fixed. Production
deadlines remain unchanged. The implementation-head check also passed 866/867,
with only the new-script allowlist missing; the final commit registers the two
supported scripts and updates their README.

The committed [CLI verification script](https://github.com/Aicoo-Team/SharedEval/blob/c13e6204669cd4fdca05af7beff13c46e72db566/scripts/verify-pact-net-world.ts)
ran at the final head with Node24 and the required world pin. Both Multi and Single
used separate processes for 8→9→16 turns and a completed reopen, with five actions
per case and the prior event archive unchanged. At B's start, Multi actor frontiers
were 20/40/20 and A's resource was released; Single frontiers were 0/0/0 and A's
resource was initial. The script saves source/runtime identities, exact commands
and snapshots in a new output directory. Native tests separately verify real tool
allow/deny, private observations, role changes, stale approvals and recovery.

Independent source review found no actionable remaining issue in legacy helper
compatibility, late-effect publication or Single public projection. Another room
reviewer independently ran 77/77 targeted tests, the CLI harness and six narrow
recovery/revocation probes at implementation head `bee3e73`; their results remain
separate from root's final-head execution. They verified the final delta affects
only the script allowlist test and README. The recovery fixtures reconstruct
durable boundaries with writer ownership released; they are not power-loss tests.

The bounded config-check/execution/resume/P-01-scoring entry is implemented in
draft PR64, with fixed-head execution evidence and the local parallel-check limitation recorded below.
Broader NET task/provider integration and scoring across multiple registered cases
remain open; synthetic assigned profiles have no benchmark rubric.

The PAIR owner's current 60-task run remains under that owner. Its reported
two-case live preflight does not establish full-run completion or acceptance.
Final acceptance still needs separately frozen wrapper/projection code, actual
model-request hashes, journal frontiers and context-size evidence. A frozen
runner SHA alone does not identify an added provider-side compression path.

The owner reported in room message 64 that an HTTP 520 at tick 23 left the final
requester `MEMORY` uncommitted. Tick 24 recovered history but encountered
`publication_limit`; tick 25 made no new contact while recovering Q234. Preserve
these deviations under the existing configuration rather than resetting or
relabeling the trial. Fixed tick 61 may begin re-asks before 60 distinct first
contacts, so final acceptance must show actual task coverage and contact-to-task
mapping. Track delivered replies separately from committed MEMORY: a failed
MEMORY update does not undo exposure from a delivered response. Q103 remains
‘original gold match; semantic leakage under review’. Freeze the actual scorer
version and distinguish question echo, new private facts and unauthorized
confirmation; overlapping question/gold wording alone settles none of these.
Reviewer messages 66–67 contain synthetic matcher probes, not actual-trace
rescoring. The runtime helper/wrapper also needs a fetchable frozen commit or
reviewable sanitized patch bound to its per-file hashes. These are reported
observations and acceptance requirements, not accepted full-run results.

## Bounded unified native NET entry

Draft [PR64](https://github.com/Aicoo-Team/SharedEval/pull/64), branch
`codex/sharedeval-net-cli`, is fixed at
`4f8d8c07a7e088ac25fc27c14137bcb9a6acb027`, based on PR63
`c13e6204669cd4fdca05af7beff13c46e72db566`. It adds
`sharedeval net check|run|score` with strict `pact-net-native-run/v1` configs over
the existing P-01, assigned and procurement-world adapters. The provider remains
`scripted-procurement/v1`; no general NET task inventory or live model provider
is enabled. The
[fixed-head command guide](https://github.com/Aicoo-Team/SharedEval/blob/4f8d8c07a7e088ac25fc27c14137bcb9a6acb027/docs/pact-net-native-cli.md)
contains the five runnable example configs and the new command/artifact contract.

Config identity excludes file locations while binding run ID, provider, adapter,
materialized profile and required SharedOS revision/runtime digest. Command and
native writer ownership protect the run manifest, execution receipt and scoring
publication. Missing legacy manifests, pending effects, mismatched bindings and
stale/corrupt evidence receipts fail closed. There is no automatic legacy-run
adoption, stale-lock deletion or unknown-effect replay. P-01 scoring is explicitly
post-hoc; assigned profiles and two-case worlds have no registered rubric.

The development subset passed **18/18**, followed by the added legacy/unified
Multi/Single parity and bootstrap/YAML regressions. The fixed-head results below
supersede those development checks for this delivery; all runs remain distinct.

[CI 34736719097](https://github.com/Aicoo-Team/SharedEval/actions/runs/34736719097)
passed both jobs at `4f8d8c0`: ordinary **822 passed / 67 native skipped** (889
total); mandatory runtime **10/10**, PAIR world **4/4**, old NET **50/50**, NET
world **26/26**, and unified NET CLI **22/22**, with zero failures, cancellations
or skips in every mandatory step.

| Fixed-head local gate at `4f8d8c0` | Result |
| --- | --- |
| Required-runtime `pnpm check` | Validation and type-check passed; tests **888/889**, zero skips/cancellations, **836.815 s**, exit 1 |
| Exact failed CLI success case alone | **1/1**, zero failures/cancellations/skips, **10.679 s**, exit 0 |
| Complete package test list with `--test-concurrency=1` | **889/889**, zero failures/cancellations/skips, **532.061 s**, exit 0 |
| Four fixed-head CLI artifact runs | Passed in separate processes; P-01 success/held and world Multi/Single; immutable completed reopen and expected scoring eligibility |

The parallel failure was the resumed P-01 success command returning
`pilot_pending_turn_incomplete`. The native session, journal wrapper, scripted
driver and actor context store are unchanged from `c13e620`; this CLI adds no
native deadline. Existing 30-second execution and 1-second close deadlines, or a
journal finish failure, can reach the same fail-closed guard. The preserved log
cannot distinguish them, and successful reruns do not establish host load as the
cause. No production deadline or test assertion was weakened. The parallel
`pnpm check` remains failed; the full serial run and CI are separate evidence.

The fixed-head CLI artifact set records source/runtime identity, configs,
per-command stdout/stderr and per-phase execution receipts. P-01 success and held
runs each go **2 → 8 → 8** turns, retain prior events, and score **1 / 0.175**
without changing the execution checkpoint. World Multi and Single each go
**8 → 9 → 16 → 16**, with five actions per case and earlier event archives
preserved. At case B's start, Multi retains actor frontiers **20/40/20** and case
A's released resource; Single starts at **0/0/0** and resets A's resource. Both
worlds reject unregistered scoring. These are scripted native results with no
model calls, not benchmark performance or power-loss acceptance.

The committed CLI conformance tests reproduce those paths plus assigned-case
execution, malformed/stale/pending receipt rejection and intact-run relocation.
They also mix legacy and unified world entry points across cold processes and
require complete snapshot equality, including context frontiers, resource state,
authorization audit and archived events. Independent source review reproduced a
manifest-publication/native-writer race, now fixed by holding native ownership
through manifest publication and protected by a targeted regression. The reviewer
reported no further actionable finding; their source review is not a separate
native test run.

The former third follow-up is split explicitly. Its bounded command entry is
implemented and exercised in PR64 with the parallel-check limitation above. General NET
inventory/provider integration and check → two registered cases → cold resume →
per-case scoring remain separate pending work. The existing world's two synthetic
cases are not two registered benchmark cases. The PR63 same-head parallel
866/867 limitation, complete serial 867/867 result and separate native CI evidence
above remain unchanged and are not relabelled by this newer development run.

## Fixed baselines

- Main: `dc5d482403bd5dfb38ab6af92db399d6cbea3121`.
- PAIR PR57 base: `14463247af15641b1d4231537d7f263e5105a8e7` (PR53).
- PAIR final owner head: `4eede49a83cf43da146664bd67c8c2c405aecc11`.
- Original P-01 pilot final code head: `a883f51cc573e87fb003fd39d5c40e138af5d2d5`, based on
  PAIR `4eede49a`. Earlier tested `5dc60fd` and CI-only `c02e7fc` are historical
  baselines; neither includes the later audit-order fix.
- Bounded unified NET entry: `4f8d8c07a7e088ac25fc27c14137bcb9a6acb027`,
  based on PR63 `c13e6204669cd4fdca05af7beff13c46e72db566`; serial full tests,
  fixed-head CLI artifacts and CI pass, with the parallel failure retained above.
- Governance tested code head: `a09b50c9b3495a120d30b0cf2e20a494de2ad323`,
  based on main; subsequent changes to this record and the plan are documentation.

World/NET use SharedOS `3aa07e33999b656a10ace294fd4e41df8cbc318e`, runtime digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`.
Governance uses main-compatible SharedOS
`a303d97fe974c149d4575b1f5d6426aee6f37367`. These pins are intentionally different;
never substitute one runtime merely to make a test run.

## Independently reproduced PAIR evidence

At `9c4d18ac2dd62a4b177881c1a6daf49b3abc4008`, Node 24.18.0, a clean built
world-compatible SharedOS and `SHAREDEVAL_REQUIRE_SHAREDOS=1`:

```bash
npm test
npm run type-check
npm run validate
```

All commands exited 0: **789/789 tests**, zero failed/cancelled/skipped, 68.03
seconds for tests. This includes actual runtime mediation and provider-input
inspection through a scripted provider, rather than only a three-actor store.

Historical initial inspection remains distinct: at
`58461fd736d70f776d21082dbac67409bb329ca9`, the four world session/ledger/native/
failure-lifecycle files passed **10/10**, zero skipped, 22.98 seconds. This result
has not been relabelled as a test of a later commit.

PR57 Actions run [34630460756](https://github.com/Aicoo-Team/SharedEval/actions/runs/34630460756)
passed both jobs at `9c4d18a`. Its ordinary test job had 780 passed and 9 native
skips; the pinned mandatory job had 10/10. The final `4eede49a` adds a mandatory
world continuity/failure lifecycle step and one YAML regression, closing that CI
coverage gap. The owner reports 790/790 plus the separate 4/4 world gate at this
head. Final Actions run [34631195720](https://github.com/Aicoo-Team/SharedEval/actions/runs/34631195720)
passed: ordinary tests 781 passed / 9 native skipped; mandatory runtime 10/10
and world 4/4, with zero native skips. The supervisor checked the final delta:
only CI YAML and its regression changed from independently tested `9c4d18a`.

## Independently reproduced NET evidence

At `5dc60fd`, Node 24.18.0, Python 3, required clean world-compatible SharedOS:

```bash
pnpm check
```

Catalog validation and type-check passed; **810/810 tests**, zero failed,
cancelled or skipped, 100.56 seconds. These include native allow/deny, private
actor canaries, recipient scopes, revocation after discovery, escalation audit,
receipt scope/version/expiry, safe partial, clean process restart, duplicate
suppression, corrupt history and indeterminate-effect denial.

Post-hoc checks replay committed events and require one-to-one matching of
successful domain effects and SharedOS tool/authorization audit. A review found
that a successful release could be omitted from the scored log while remaining
in audit; the regression first reproduced that inconsistency, then passed after
bidirectional matching was added. No remaining blocker was found in that narrow
independent review. Missing audit, a wrong actor, contradictory state, pending
work and undrained queues are also rejected before scoring.

Fresh CLI process results at this exact code head:

| Mode | Committed turns | Domain actions | Final state | P-01 rubric score |
| --- | ---: | ---: | --- | ---: |
| Success | 8 | 5 | released | 1.0 |
| Unsigned-contract safe partial | 8 | 3 | held | 0.175 |
| Restart after budget, then after legal | 8 | 5 | released | 1.0 |

Each completed directory was started again. Parsed evidence remained identical:
no extra event, message, turn or approval appeared. JSON object-key order can
change during schema parsing on reopen; byte identity is not the acceptance
criterion. Scores were produced in a separate process from actual committed
state/events, not copied from reference gold. The exact execution and post-hoc
commands appear in the plan and the PR59 pilot guide.

PR59 Actions run [34631033111](https://github.com/Aicoo-Team/SharedEval/actions/runs/34631033111)
passed at `5dc60fd`: ordinary validation **781 passed / 29 native skipped**;
mandatory pinned boundary **10/10**; native PAIR-world plus scored NET e2e
**30/30**, with zero skips in both native steps. These are separate from the
local full native 810/810 run.

### Review-discovered audit-order defect and fix

The NET room reviewer then tested the real replaceable provider seam with
`write_audit_record` before `release_po`. At `5dc60fd`/`c02e7fc`, all tool records
were authentic, but the result became released while its audit remained held;
the original scorer still gave 1.0. The supervisor independently reproduced
this exact failure. The earlier green suites and normal CLI runs did not cover
this case, so they were not treated as final acceptance.

Commits `22bf5fd` and `a883f51` close the gap. A persisted audit ends domain
mutation; later release, matching, approval and another audit are rejected.
Post-hoc projection also verifies audit status, final position and event count.
Three new native regressions cover swapped finalization, an early audit followed
by otherwise legal actions, and the real runtime-to-Python scoring path. They
were observed failing before the fix and passing after it.

The independent probe at `a883f51` now produces a held resource and held audit,
with no release event, `terminal_success: false`, `full_completion: false` and
partial score 0.375. The normal-order control remains released with score 1.0.
This denial is a domain closure check after capability authorization, not a
claim that the actor lacked its release grant. The published PR records the
final full-check and Actions results for this fixed SHA.

Final independent acceptance at **`a883f51`**: Node 24.18.0, Python 3 and required
clean pinned SharedOS; `pnpm check` exited 0 with validation, type-check and
**814/814 tests**, zero failed/cancelled/skipped, 66.91 seconds for tests.
All three ordinary CLI rows above were rerun on this final SHA with the same
turn/action/state/score results and no semantic change on repeated startup.
The separate adversarial-order probe also exited 0 with the held result above.
Final Actions run [34631865536](https://github.com/Aicoo-Team/SharedEval/actions/runs/34631865536)
passed both jobs at this SHA, including mandatory native runtime, world continuity
and scored NET regressions: ordinary tests 782 passed / 32 native skipped;
mandatory native steps 10/10, 4/4 and 23/23, all with zero skips.
The PR remains a draft for review; passing this pilot
does not close the general NET or live-model gates.

The pilot uses synthetic owner evidence and a scripted provider. P-01 has an
empty forbidden-disclosure set: its safety pass does not establish task-level
privacy performance. It proves only the stated adapter and rubric integration.
Recovery covers clean committed boundaries; unknown effects fail closed without
automatic reconciliation. Dynamic receipt/resource mutation, grant widening,
persistent quotas, concurrent scheduling and adversarial-storage authentication
are not implemented by this pilot.

## Governance and CI evidence

At tested governance head `a09b50c`, Node 24.18.0 and required main-compatible
SharedOS, `pnpm check` passed validation/type-check and **668/668 tests**, no
failures/cancellations/skips, 42.57 seconds. An earlier full run exposed two tight
unchanged-main test setup budgets. Both files passed in isolation (52/52); the
branch adopted the exact test-only allowances already on the world branch.
Production deadlines and atomic-publication assertions remain unchanged.

PR58 Actions run [34630043844](https://github.com/Aicoo-Team/SharedEval/actions/runs/34630043844)
also passed: Node22 ordinary tests **661 passed / 7 native skipped**, and its
mandatory native step **10/10, no skips**. These are not the local Node24 full
native result. The PAIR owner independently reviewed PR58 with no blocking issue.

The prior CI failure was a supplied checkout-credential failure against the public
SharedOS repository. Standard read-only checkout credentials fixed it while
preserving the exact pin, mandatory runtime verifier and `persist-credentials:
false`. Both PR57 and PR58 verified this fix in remote Actions.
