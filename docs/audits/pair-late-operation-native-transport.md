# Native Transport Cancellation and Close Evidence

This is a no-model repair of the experimental native Codex transport. It does
not identify a proven cause of historical tick 26, alter historical sidecars,
resume either failed run, or change SharedOS cancellation semantics.

## Reproduction and Fix

The transport previously checked health, selected a native decision, awaited its
sidecar write, and returned a successful chat-completions-shaped response. An
abort during that write set the transport failure and closed the peer but did
not prevent the subsequent 200 response.

A deterministic test gates `node:fs/promises.writeFile` after the first native
decision exists, aborts the caller signal, then releases the real write. The mock
is confined to this test process and restored with `syncBuiltinESMExports` in
`finally`; there is no production test hook or paid/native process invocation.

The fix rechecks both cancellation and transport health after the awaited write,
before returning any response. Sidecar saves are serialized so an older fetch
snapshot cannot overwrite a later close snapshot. Neither a tool result nor a
native completion is fabricated on cancellation.

Command used for RED and GREEN:

```sh
/Users/wangxiang/.nvm/versions/node/v24.18.0/bin/node --import tsx --test --test-concurrency=1 tests/experiments/codex-app-server-transport.test.ts
```

Initial RED: exit 1, 18 tests, 15 passed and 3 failed, zero skips,
197.379750 ms. The cancellation case failed with `Missing expected rejection`;
the other two tests demonstrated missing close schema/timestamps.
Initial GREEN: 18/18 passed, zero skips, 534.601209 ms.

Further close-boundary REDs were observed before their fixes:

- A failed peer close left the persisted sidecar saying `open`, without its
  actual outer close cause: 19 tests, 18 passed / 1 failed, 759.562542 ms.
- Closing during a gated RPC factory open did not account for the late-created
  peer in awaited cleanup: 20 tests, 19 passed / 1 failed, 144.378167 ms.

The corresponding fix persists the close snapshot even when cleanup throws,
without inventing completion timestamps. Close also stops an existing peer,
waits for the pending open to settle, and closes any peer created during that
open before marking cleanup complete. Open checks closing state after scratch
creation and after the RPC factory returns, before initialization. These are
transport resource-lifecycle changes, not a SharedOS runtime timeout fix.

All 20 native tests then passed, zero skips, 251.832625 ms. Final combined
verification passed all 58 tests with zero skips in 6737.522333 ms: the 20 native
tests, seven new execution regressions, and 31 existing file-model-driver tests.
This run set `SHAREDEVAL_REQUIRE_SHAREDOS=1` and used the unchanged pinned build.
Node 24 `tsc --noEmit --pretty false` also completed with exit 0.

## Version 2 Evidence

New sidecars declare `apiVersion: sharedeval-native-codex-evidence/v2`.
Existing fields and their meanings remain; in particular the legacy `closed`
boolean means close was requested, not that cleanup has completed.

- `closeState` distinguishes `open`, `closing`, `closed`, and `failed`.
- `lifecycle.closeRequestedAt` and `closeSource` describe the first close request.
- `peerClosedAt` is observed only after the relevant peer close promises settle.
  `cleanupCompletedAt` follows peer shutdown and scratch removal. These are
  host-observed timestamps, not OS-exact process exit times. The latter excludes
  the subsequent sidecar write; `close()` itself awaits that write.
- `cleanupError` is a fixed category when cleanup fails; private error text is
  not copied. Missing completion timestamps must not be interpreted as success.
- `lifecycle.outer` records an observed session close callback: execution ID,
  the runtime's outcome, actor settlement success/failure, and whether the
  original runtime signal was aborted. This is independent of native completion.
- Native `startedAt` and `completedAt` come from observed native turn events.
  `completed` still requires the actual successful `turn/completed` event.
- First failure and abort-source metadata distinguish transport observations
  from the outer runtime result. An absent `failure` is not proof of a successful
  outer turn, committed heartbeat, or absence of externally visible effects.

The wrapper passes actual session outcomes even when actor settlement fails.
When cleanup also fails, it does not replace the original actor settlement
error. A later run-cleanup call does not overwrite the first close cause. A
transport that closed on its own failure can attach a subsequently observed
outer session outcome without rewriting its original close timestamps.

Limitations: the outer SharedOS abort can return before a delayed session close.
If run cleanup has already released the wrapper's transport reference, that
later callback is not retrospectively attached. Missing `outer` means unobserved,
not success. Sidecar persistence can itself fail; no in-memory evidence field
proves durability if `close()` rejects during the write.

## Unchanged Bounds

`timeouts` reports three distinct limits, without changing enforcement:

- `runtimeTurnMs` is the actual host-declared SharedOS request timeout, 300000 in
  the original experiment, or `null` if not supplied. The transport does not
  enforce this field.
- `bridgeFetchMs` remains 180000 by default per bridge fetch, with the existing
  explicit transport option override.
- `rpcRequestMs` remains 30000 per RPC request.

Bridge exchanges are not native model-call counts. Native token usage is not a
substitute for a billed cost, and the requested chat-completions output-token cap
remains explicitly unenforced by this native transport.

No model calls, host credential reads, old evidence rewrites, deadline increases,
synthetic tool results, heartbeat commits, or uncertain-operation replays were
performed for this repair.
