# PAIR Multi Recovery Work

## Frozen Inputs

This work is based on `63bb010`, after ten experiment-helper commits on PAIR
PR57 (`4eede49a83cf43da146664bd67c8c2c405aecc11`). The original two failed runs,
their configurations, journals, outputs, and uploaded handoff archive stay
unchanged. No paid model or new live experiment is authorized for this work.
SharedOS stays pinned to `3aa07e33999b656a10ace294fd4e41df8cbc318e`.

The PR structure separates the historical helpers from new recovery changes.
Both remain draft; neither is merged as part of this work.

## Acceptance Scope

1. Reproduce cancellation with real local SharedOS authorization and scripted
   model decisions. Distinguish an actual tool result already supplied to the
   driver from a tool whose external effect remains unknown. Record known
   results without dispatching another model request; keep unknown operations
   fail-closed without replay, fabricated results, or retroactive commits.
2. Preserve the difference between a durable delivered reply and a committed
   tick when later MEMORY work fails. Add a local scripted regression, with no
   imported private traces.
3. Add an explicitly versioned, opt-in first-contact coverage protocol. Count
   proven accepted requests, not clock ticks or administrative finalization.
   MEMORY repair and no-contact turns cannot silently exhaust first-contact
   coverage. Preserve original protocol behavior and binding identities.
4. Measure history validation before optimizing. Keep full history, raw bytes,
   actor isolation, hash-chain checks, and detection of same-size/mtime-preserved
   tampering. Report unchanged disk-read costs separately from CPU savings.
5. Run focused regressions, `pnpm check`, required pinned-SharedOS tests, and
   independent review. Record exact commands and failures without increasing
   production deadlines to make a test pass.

## Baseline

Node 24.18.0, frozen dependency installation reused read-only.

```sh
node --import tsx --test --test-concurrency=1 tests/experiments/*.test.ts tests/runner-v1/actor-context-store.test.ts tests/suites/pact-pair/files-multi.test.ts
```

Before production edits: 193 tests passed, zero failed/cancelled/skipped,
39,166 ms. This is a focused baseline, not a claim that every repository test
was run at this checkpoint.

## Ownership Boundaries

- Driver cancellation and native runtime reproduction: file-model-driver and
  dedicated local execution tests. SharedOS-owned outer cancellation is reported
  with a minimal reproduction, not patched around in SharedEval.
- PAIR coverage: opt-in configuration, heartbeat assets, scheduler-derived
  progress, and matching public ledger projections.
- History validation: actor-context-store plus synthetic measurement and
  equivalence/tamper regressions.
- Integration: check entry point, fixed-source verification, review, draft PRs,
  and sanitized SharedNet updates. No raw private run evidence is committed.
