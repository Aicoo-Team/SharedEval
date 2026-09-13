# First-Ask Coverage Protocol v2

Status: implemented for new explicitly configured runs; no historical run is migrated.

## Problem

The legacy multi-turn protocol starts retries at `phase2StartTick`, commonly 61 for a 60-task selection. A failed turn or a MEMORY-only repair consumes a tick without a new first request. Therefore tick 61 does not prove that 60 different tasks have been contacted. Repairing MEMORY and then contacting a new task in one turn also attempts a second publication, which the existing one-publication grant correctly denies.

## Decision

Select the new protocol explicitly:

```yaml
workflow:
  mode: multi
  protocol: files
  maxTicks: 300
  stopWhen: all-terminal
  multiTurn:
    protocol: first-ask-coverage/v2
    finalizeTick: 261
```

The complete example is [pair-multi-coverage-v2.yaml](../configs/pair-multi-coverage-v2.yaml). It is illustrative, not authorization to start a paid run. The run-config API version (`sharedeval-run/v1` or `/v2`) governs context persistence separately from this multi-turn protocol version.

Before each turn, one deterministic helper derives first-contact coverage from prior committed heartbeat records. A task counts once when its retained request envelope matches its committed contact ID, task ID, requester/responder identities, trace, and operation-bound accepted-message audit. The ledger has already validated the full consumed-grant and operation causality. A contact label, MEMORY note, or elapsed tick alone is insufficient. Missing retained evidence fails closed rather than inferring coverage.

Coverage is **request acceptance**, not reply completion or success. A typed denied reply follows an accepted request and counts. A committed failed contact can also count even without a reply; `incompleteReplyTaskIds` reports this separately. A transport failure before acceptance has no accepted request and remains uncovered. A delivered reply followed by requester/MEMORY failure counts when that heartbeat is safely committed.

Phase 1 ends only when every selected task has an accepted first request in committed evidence. The next heartbeat is phase 2. Finalization additionally requires `tick >= finalizeTick`; it cannot bypass remaining first asks. Scheduler input, heartbeat instructions, and public tick phase/finalization fields use the same derivation. The v2 progress is included in the heartbeat input digest. Current/uncommitted tail evidence is not counted.

The new `heartbeats/files-multi-coverage@2.0.0` asset instructs the requester to repair an unrecorded reply first, publish MEMORY once, and stop that turn without another contact. It prioritizes the ordered uncovered task IDs during phase 1. Accepted action requests must not be issued again, including requests with incomplete replies. Phase 2 retries QA only, preserving actual replies and distinguishing textual refusal from typed denial/provider failure. Incomplete or unasked work is not labeled defended.

## Boundaries

- Coverage v2 requires `retainPrivate: true` at the public ledger API, as the production workflow already does. The ledger rejects disabled retention before creating its run directory or publishing any authority. It never substitutes sanitized contact labels for retained accepted-request evidence. Legacy protocols continue to support disabled retention.
- `maxTicks` is still a hard bound. Coverage delays do not extend the tick budget. At exhaustion, unresolved tasks retain existing `no_response` or side-effect-before-failure outcomes, not inferred refusal.
- Phase 2 can begin with incomplete replies after all first requests were accepted. This is explicit and is not a claim that all tasks were answered or safely denied. Accepted actions remain excluded from re-issuance by the requester protocol.
- This change is a requester progression protocol, not a new action-idempotency mechanism or a guarantee that a model follows its instructions. It does not broaden or replace SharedOS authorization. Existing one-contact/one-MEMORY-publication turn limits and production deadlines are unchanged.
- Uncommitted indeterminate external effects still stop the run. V2 does not replay, quarantine, or repair those effects automatically. A resume against the unresolved start marker remains blocked.
- Gold-fact matches remain scorer diagnostics, not proof of novel private disclosure or semantic success. This protocol changes no grading, task gold, runtime result definitions, raw journals, or frozen experiment outputs.

## Compatibility

The old shape `{phase2StartTick, finalizeTick}` remains the legacy protocol with identical parsing output, heartbeat asset bytes, heartbeat text, phase semantics, and config/binding digest input shape. An absent multi-turn block remains absent. Existing examples are unchanged. The new version has no `phase2StartTick` field and rejects combining that field with `protocol: first-ask-coverage/v2`. New runs must use new bindings and output directories; historical bindings must not be rewritten.

### Public Binding Numeric Range

A follow-up compatibility audit found that sharing the bounded execution schema had incorrectly imposed the CLI's 10,000-tick ceiling on legacy public bindings. The public binding schema and validator are now separate from the execution schema. Legacy bindings retain safe-integer fields and the historical effective constraint `2 <= phase2StartTick <= finalizeTick <= scheduler.maxTicks`, including values above 10,000. For example, `maxTicks: 20000`, `phase2StartTick: 10001`, `finalizeTick: 20000` remains parseable and reopenable without rewriting its binding bytes. Although the old inner fields were positive integers, the old outer refinement already rejected phase 1/finalize 1; the effective minimum remains 2.

This restores an artifact-reading contract, not permission to execute a larger workload. CLI workflow limits and the existing execution schema/validator still reject values above 10,000 or phases below 2. The explicit coverage-v2 schema keeps its own 2..10,000 finalization range and requires finalization not to exceed the bound scheduler limit. Its strict versioned shape and evidence-retention requirement are unchanged.

Read-only imports of the immutable `63bb010` parser confirmed: the 20,000-tick legacy case was accepted there but rejected before this compatibility fix; the min-1 case was rejected by both, and min-2 accepted by both. The new targeted tests first produced RED with 1 pass and 2 failures, then GREEN within 53/53 focused coverage, config, and artifact tests (5,916.983 ms). They cover public safe-integer boundaries, actual ledger commit/close/reopen with unchanged binding bytes, unchanged CLI/execution caps, and v2 bounds. TypeScript passed. No historical binding or run was modified.

## Local Regression Evidence

Node 24.18.0, scripted local execution only:

```bash
/Users/wangxiang/.nvm/versions/node/v24.18.0/bin/node --import tsx --test --test-concurrency=1 tests/suites/pact-pair/first-ask-coverage.test.ts
```

RED before production changes: 0/2 passed because the legacy schema rejected the explicit coverage protocol and required a fixed phase tick. GREEN after implementation: 6/6 passed. The main eight-turn fixture includes no accepted request, a delivered reply followed by requester failure, MEMORY-only repair, a contactless failed turn, a distinct second task, its duplicate request, a third task's first request, and final MEMORY-only repair. Phase 1 remains active through tick 7 even though `finalizeTick` is 5; phase 2/finalization starts at tick 8. Scheduler progress, actual public tick phase/finalization, and heartbeat text agree.

Additional boundary fixtures verify accepted failed action/no reply coverage without a second action request and with `no_response`/null evaluation at exhaustion; authority-only evidence rejection; exclusion of the current frontier; indeterminate accepted-request failure followed by a blocked relaunch; and separate registry resolution with the frozen legacy asset hash unchanged. TypeScript `tsc --noEmit --pretty false` passed. These tests establish deterministic local protocol behavior, not model adaptivity, paid-run acceptance, or full-split success.

The retention follow-up first reproduced the missing initialization rejection (1 failed / 1 passed), then passed all 8 coverage tests after the guard. It checks that rejected v2 opens leave no run directory and that both absent and legacy fixed-phase protocols still commit/read records with private retention disabled.
