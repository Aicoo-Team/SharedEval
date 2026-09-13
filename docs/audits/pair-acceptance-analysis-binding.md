# PAIR Acceptance Analysis Binding Audit

## Defect

The run-level analyzer previously checked a ledger's internal hash chain and a failure marker's run ownership separately. It did not require the ledger to belong to the current lane binding. A foreign, internally consistent ledger could therefore contribute a tick and reply to the current run, with a valid current-run failure marker still reported as verified. The same foreign ledger was accepted without any failure evidence. Actor-journal manifests also lacked an independent current-binding check.

The current lane authority is `.sharedeval-file-workflow/binding.json`, not a file literally named `run.binding.json`. Internal consistency is not sufficient evidence of ownership by that binding.

## Changes

Run-level analysis now loads the lane's strict binding envelope and validates its existing run-binding schema and digest before reading records or classifying failure. It checks `run.json` run ID and exact ordered task selection against this authority, plus workflow/task metadata when present. An abbreviated public manifest containing the correct run ID and selection remains supported; public aggregate counters are not treated as the committed frontier.

Every committed record must match the current binding digest, run ID, session ID, requester actor, sequential tick and tick budget. Contact, transition, MEMORY-row, accepted-message task references and action snapshots must remain within the bound selection; contact kind must match the selected task. Existing ledger-chain and private-evidence digest checks remain in force. Failure status and markers use this same unconditional authority, including when no failure artifact exists.

An existing actor-context manifest must match the binding digest, namespace/world ID, exact sorted actor set, protocol and context limit. The existing world-context validator checks every committed before/after frontier from the bound journal genesis, not only the final frontier. Committed journal records retain their hash/sequence/actor checks, with filenames also checked against sequence. An absent journal directory remains `actorJournalsPresent: false`; an existing directory with a missing manifest is rejected instead of silently omitting its evidence. Rejection happens before creating or publishing report files.

Run-level summary output is now `pair-acceptance-analysis/v2` and includes `runBinding` with run ID, session ID and binding digest. The pure `analyzeAcceptance` function remains `pair-acceptance-analysis/v1`; its caller-supplied in-memory evidence is not independently authenticated. Scoring, gold matching, contact interpretation and committed-only extraction semantics are unchanged. No historical run, journal, report, or downloaded review artifact is rewritten.

## Reproduction

The parent independently ran the unchanged reviewer probe against immutable source `63bb010` using fresh synthetic scratch data. The results were:

| Ledger | Failure | Historical Result |
| --- | --- | --- |
| Current | Current | Accepted: 1 tick, 1 reply, verified failure marker |
| Foreign | Current | Incorrectly accepted: 1 tick, 1 reply, verified failure marker |
| Current | Foreign | Rejected |
| Foreign | Absent | Incorrectly accepted: 1 tick, 1 reply, no verified failure marker |

That historical probe's exit zero asserted the old behavior; it is not GREEN evidence for the fix. Its unchanged SHA-256 is `9f9cb7e86487c21ee41ce62b9c402132aa756cfff9a6ae7546641155d10db9f2`. The accompanying downloaded review report SHA-256 is `49e5f35075bf6005513ff5eb8fb27dd6151c4490a5656192458be1ac4f9dcd6e`.

The new regression tests were first run against the pre-fix analyzer on repair base `f06b637ad63046345efc2edc4d25e53748825927`. RED was 2 passed and 3 failed: current evidence and legitimate absent journals passed, while foreign-ledger/current-failure, foreign-ledger/no-failure, and foreign-journal/matching-frontier controls all failed with `Missing expected rejection`. The foreign fixtures retained internally valid hashes rather than relying on corrupted-chain failures.

## Verification

```bash
/Users/wangxiang/.nvm/versions/node/v24.18.0/bin/node --import tsx --test --test-concurrency=1 tests/experiments/pair-acceptance.test.ts
/Users/wangxiang/.nvm/versions/node/v24.18.0/bin/node node_modules/typescript/bin/tsc --noEmit --pretty false
git diff --check
```

GREEN: the focused file passed 28/28, zero skipped or failed, in 660.763 ms; the parent independently repeated 28/28 in 660.606 ms. TypeScript and whitespace checks passed. Additional controls isolate run ID, session ID, actor ID, a later record's foreign digest, record task selection, public selection order, journal world/actor/context/protocol mismatches, a missing journal manifest, and genesis continuity. Matching abbreviated public manifests and genuinely absent journals remain positive controls.

Separately, the parent adapted only the two foreign-ledger expected-rejection flags and a comment in a new copy of the reviewed four-control probe (SHA-256 `0331e4a53cc15b3f633aa5872607b86f49151dee37971f7390858f09d7ef1239`). Against the new analyzer, the matching current case still yielded 1 tick, 1 reply, a verified marker, and absent journals; all three foreign combinations were rejected. The original download stayed unchanged. This is synthetic local verification, not a rescore of either frozen failed experiment or evidence of full-run acceptance.

Independent read-only review of the frozen analyzer and tests found no actionable issue within this provenance-anchoring scope.

## Limits

This fix establishes ownership and integrity relative to the supplied current lane binding. It does not establish external authenticity if an entire run directory and its authority are replaced together, nor substitute for full runtime authorization validation or the separate continuity validator. It does not validate complete journal turn semantics, captured prompt continuity, or native internal model visibility. Missing journals remain explicit missing evidence. Uncommitted replies may still have been delivered and require separate tail analysis; committed-only extraction must not be interpreted as proving that no uncommitted exposure occurred.
