# World-First Implementation Handoff

Date: 2026-09-11.
Branch: `codex/sharedeval-world-first`.
Base: `14463247af15641b1d4231537d7f263e5105a8e7` (PR 53).
Integration status: local branch only; no push or merge.

## Behavior Implemented

| Concern | New behavior | Boundary |
| --- | --- | --- |
| Multi | v2 defaults to a persistent world; both actors retain their own semantic history across ticks and tasks | Retry strategy still requires `multiTurn` |
| Single | Same world/session machinery, separately instantiated for each task | One logical contact can include multiple model/tool calls |
| File approach | Fresh `AGENT.md`, `HEARTBEAT.md`, `POLICY.md`, `MEMORY.md` reads each turn | History supplements files; no fifth agent-facing file |
| Authorization | Current catalog is filtered and invocations re-authorized by SharedOS | Historical content does not grant authority |
| Persistence | Private actor journals, exact semantic role/call linkage, binding and frontier hashes | Uncertain work stops; no automatic replay or stale-lock reclamation |
| Context budget | Bounded full history with an explicit terminal error | No silent reset, truncation, or summary |
| Failure evidence | Immutable sanitized failure records plus a replaceable current-status projection | Incomplete execution is not a scored privacy failure |
| PAIR | Existing fixed responder, synchronous contact, heartbeat strategy, resources, and evaluator | Existing scoring definitions are unchanged |
| Future NET | Neutral context/world modules accept arbitrary actor sets and import no benchmark logic | NET routing, scheduling, and evaluation integration are not implemented |
| Legacy results | v1 still uses reset-context semantics | Old runs and the 43,200-run grid were not rewritten or reinterpreted |

The implementation also repairs MEMORY attempt quotas and evidence handling of
legitimate tool-catalog subsets. Failed write attempts still consume authority;
at most one successful MEMORY publication per actor turn remains enforced.

## Code Map

- [Actor context contracts](../src/runner/context/actor-context.ts) and
  [durable store](../src/runner/context/actor-context-store.ts).
- [World lifecycle](../src/runner/world/session.ts) and
  [profile](../src/runner/world/profile.ts).
- [Native model driver](../src/runner/v1/file-model-driver.ts).
- [PAIR lifecycle integration](../src/suites/pact-pair/file-workflow.ts).
- [Versioned run configuration](../src/runner/v1/sharedeval-config.ts).
- [Failure records](../src/runner/v1/file-workflow-failure.ts).
- [Native continuity tests](../tests/runner-v1/world-native-conformance.test.ts),
  [failure lifecycle tests](../tests/runner-v1/world-failure-lifecycle.test.ts),
  and [world ledger tests](../tests/runner-v1/world-ledger.test.ts).

## Validation

Use Node 24 with the pinned SharedOS checkout. The mandatory runtime check
validates revision `3aa07e33999b656a10ace294fd4e41df8cbc318e` and digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`.
Verified implementation/test tree through commit `bed2979`:

| Check | Result |
| --- | --- |
| `npm test` with the pinned runtime | 780/780 passed; 0 failed, cancelled, or skipped; 96.8 seconds |
| `npm run test:sharedos` with the pinned runtime | 10/10 passed |
| `npm run type-check` | Passed |
| `npm run validate` | Both manifests passed; PAIR 400 QA + 200 action, NET 483 QA + 514 action + 25 actors |
| CLI `--check` on both documented YAML examples | Passed; no external calls |
| Local Markdown links | 19 checked |
| `git diff --check` | Passed |

The first integration runs exposed two test-time deadline sensitivities and a
retired `examples/` path. Only the affected tests' setup/execution allowances
were raised; production deadlines and safety assertions were unchanged. The
example moved into the existing docs surface. The complete suite above was
rerun after those corrections.

The native tests use the real pinned SharedOS runtime and a scripted provider.
They inspect actual model request messages, including both actors' second-turn
history and Single's empty initial history. They also exercise rejected MEMORY
writes, later valid publication, and continued next-tick authority. No external
model request or privacy-score experiment is represented by these tests.

## Remaining Gates

1. Run a bounded, fresh live DeepSeek probe using the
   [two-question configuration](pair-world-multi.md). Validate actual provider
   history, retry adaptation, and evidence before launching any grid.
2. Finish the original plan's trajectory-scoring work: per-contact, per-goal,
   and per-world reporting, including earlier disclosure followed by refusal.
   This branch does not introduce new scoring definitions or statistical claims.
3. Design NET's topology adapter around its own actors, routing, scheduling, and
   evaluation. Reuse the neutral journal/lifecycle instead of embedding NET
   assumptions into SharedOS or the generic context store.
4. Profile larger worlds before long runs. Hot store validation still reads and
   hashes the on-disk history; avoiding repeated semantic replay is not a claim
   of constant-time or unlimited-length execution.
5. Review identity/policy experimental controls separately before making a new
   policy-specificity claim. This branch does not repair that experiment design.

Refer to the [architecture decision](adr/2026-09-11-persistent-world.md) and
[running guide](running.md) for compatibility and recovery rules. Preserve old
runs, use a fresh run ID, and keep raw journals private.
