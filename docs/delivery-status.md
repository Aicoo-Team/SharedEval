# SharedEval delivery acceptance

Updated 2026-09-12. This record distinguishes reviewed design, reported tests,
fresh execution evidence and work still in progress. See the
[PAIR/NET execution plan](multi-execution-plan.md).

| Deliverable | State | Evidence / next gate |
| --- | --- | --- |
| Complete PAIR and NET Multi design | Ready for review | `multi-execution-plan.md`; P-01 scope agreed with NET reviewer |
| PAIR persistent world PR | Owner publishing | Initially inspected `58461fd`; CI pin and error summaries being fixed; obtain published SHA and rerun |
| NET runtime code | Implementation in progress | P-01 three-actor pilot; general NET CLI remains absent |
| PAIR e2e | Independently checked on initial SHA | At `58461fd`, four world test files pass 10/10, no skips, with required pinned SharedOS; final published tree still needs a fresh full check |
| NET e2e | Not yet run | Require real SharedOS, private histories, three actors, allow/deny, state and recovery |
| Repository conventions | Implemented; publishing PR | Independent governance branch based on main `dc5d482`; standard check passes 668/668 including required native runtime |
| Real-provider e2e | Not run | Separate bounded experiment; scripted tests do not establish it |
| Practitioner-validated NET benchmark | Not accepted | Ten core references are draft; whole-dataset gold remains incomplete |

Acceptance requires a reproducible command, exact revision, observed result,
artifact and limitation for each item. A room message or an idle agent is not a
completion signal. Update this table after reviewing the concrete deliverable.

## Independently reproduced evidence

On `58461fd736d70f776d21082dbac67409bb329ca9`, Node 24.18.0, SharedOS
`3aa07e33999b656a10ace294fd4e41df8cbc318e`:

```bash
SHAREDEVAL_REQUIRE_SHAREDOS=1 npx tsx --test \
  tests/runner-v1/world-native-conformance.test.ts \
  tests/runner-v1/world-session.test.ts \
  tests/runner-v1/world-ledger.test.ts \
  tests/runner-v1/world-failure-lifecycle.test.ts
```

`SHAREDEVAL_SHAREDOS_DIR` pointed to a clean built checkout of that pin. Result:
exit 0, 10 passed, 0 failed/cancelled/skipped, 22.98 seconds. Native conformance
uses a scripted provider and inspects actual provider inputs. This does not
establish live-provider availability, attack success or a general NET runner.

The governance branch's complete `pnpm check` also passed with Node 24.18.0,
the main-compatible SharedOS pin `a303d97fe974c149d4575b1f5d6426aee6f37367`,
and `SHAREDEVAL_REQUIRE_SHAREDOS=1`: validation and type-check succeeded;
668/668 tests passed, no failures/cancellations/skips, 42.57 seconds for tests.
This is a different branch/runtime baseline from the PAIR world tests above.

An earlier full run exposed two unchanged main tests with tight setup budgets:
native roundtrip admission (10 seconds) and the libuv publication test (200 ms).
Both files passed when run in isolation (52/52). This branch carries the exact
test-only setup allowances already present in world-first `58461fd` (60 seconds
and 2 seconds); production deadlines and atomic publication assertions are
unchanged. The complete check above ran after that correction.

The main Actions checkout failure was separately traced to the supplied
SharedOS checkout credential, not to the loader or absent model keys. SharedOS
is public, so the workflow uses standard read-only GitHub checkout credentials
while retaining its exact pin and mandatory native verifier. Remote Actions
results must still be checked on the published PR.
