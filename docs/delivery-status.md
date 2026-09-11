# SharedEval delivery acceptance

Updated 2026-09-12. This record distinguishes design, initial implementation,
independent execution and remaining expansion gates. See the
[PAIR/NET execution plan](multi-execution-plan.md).

| Deliverable | State | Evidence / next gate |
| --- | --- | --- |
| Complete PAIR and NET Multi design | Published for review | PR58; lifecycle, actor views, authority modes, schedules, reset/recovery and acceptance matrix |
| PAIR persistent world | Draft [PR57](https://github.com/Aicoo-Team/SharedEval/pull/57) | Final owner head `4eede49a`; independent 789/789 at preceding `9c4d18a`; final delta only adds a CI gate/test |
| NET runtime and scoring | Draft [PR59](https://github.com/Aicoo-Team/SharedEval/pull/59) | Native three-actor P-01, private journals, authorized effects and separate post-hoc evaluator; general NET CLI remains a later gate |
| PAIR e2e | Independently reproduced | Required pinned SharedOS; Multi history continuity, Single reset, deny and failure lifecycle |
| NET e2e | Independently reproduced | At `5dc60fd`, full 810/810 and success/held/cold-process CLI runs; subsequent CI-only base synchronization tracked in PR59 |
| Repository conventions | Draft [PR58](https://github.com/Aicoo-Team/SharedEval/pull/58) | AGENTS, CONTRIBUTING, PR template, architecture/validation conventions and `pnpm check`; green local and remote checks |
| Real-provider e2e | Not run | Scripted native tests do not establish model quality, provider availability or spend |
| General/practitioner-validated NET | Not accepted | Further tasks, topologies, resource evolution, domain-owner validation and experiment cells remain |
| Integration with current main | Separate gate | Historical PAIR stack and newer main data must be combined and checked at one final SHA before merge |

No PR has been merged by the supervisor. Room review and independent checks are
recorded separately from author reports. Idle status or a message saying done
is not an acceptance signal.

## Fixed baselines

- Main: `dc5d482403bd5dfb38ab6af92db399d6cbea3121`.
- PAIR PR57 base: `14463247af15641b1d4231537d7f263e5105a8e7` (PR53).
- PAIR final owner head: `4eede49a83cf43da146664bd67c8c2c405aecc11`.
- NET initially accepted code head: `5dc60fdc4d1c5df5a1eddaf61d35b017f8d81e66`,
  based on `9c4d18a`; subsequent base/CI synchronization is recorded on PR59.
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
head; its fresh remote result is recorded on PR57.

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
