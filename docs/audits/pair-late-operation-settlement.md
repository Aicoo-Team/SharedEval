# PAIR Cancellation and Late-Operation Settlement

Scope: local, no-model repair evidence from the recovery worktree based on
`63bb010`. The historical experiment, journals, delivery evidence, and commits
are not changed. The runtime dependency remains pinned to SharedOS
`3aa07e33999b656a10ace294fd4e41df8cbc318e`.

## Confirmed Driver Defect

`OpenAICompatibleFileTurnSessionV1.next` used to test `signal.aborted` before
accepting its input. A real tool operation could finish, and its matching result
could already have been passed to `next`, yet cancellation discarded that result
before the actor journal append. The pending call then caused
`context_turn_incomplete` during close.

The minimal fix in `src/runner/v1/file-model-driver.ts:542` lets an already
supplied `tool_result` pass the existing session-open, pending-call, exact call
ID, and exact tool-name checks, and durably appends it. It then honors
cancellation before any further provider request. A `start` input still checks
cancellation immediately. It neither creates a result nor extends a deadline.

This fix applies only when the actual result reaches the driver before close.
It cannot recover a result that the runtime never delivered. A closed turn is
not reopened, a mismatched result cannot settle its pending call, and a failed
append is not converted into a successful finish.

## RED to GREEN

The following command was run before the production edit:

```sh
SHAREDEVAL_SHAREDOS_DIR=/Users/wangxiang/.cache/codex/audits/sharedos-multi-pin-20260910 /Users/wangxiang/.nvm/versions/node/v24.18.0/bin/node --import tsx --test --test-concurrency=1 tests/execution/pair-late-operation-driver.test.ts
```

RED: exit 1, four tests, three passed and one failed, zero skips, 683.984667 ms.
The failure was the assertion that `session.close('cancelled')` should resolve
after the actual result had already been passed to the driver. Its actual error
was `ActorContextError: context_turn_incomplete`; the journal still had a pending
tool call. This was a behavioral failure, not a loader or type-check failure.

After the production edit, the same command passed all five tests then present:
exit 0, five passed, zero skips, 821.544583 ms. The narrow driver suite plus the
31 pre-existing file-model-driver tests also passed: 36/36, zero skips,
4130.274083 ms. With the additional cancellation negatives and delivered-reply
lifecycle test, the final expanded command passed 38/38, zero skips, 6704.676167 ms:

```sh
SHAREDEVAL_SHAREDOS_DIR=/Users/wangxiang/.cache/codex/audits/sharedos-multi-pin-20260910 /Users/wangxiang/.nvm/versions/node/v24.18.0/bin/node --import tsx --test --test-concurrency=1 tests/execution/pair-late-operation-driver.test.ts tests/execution/pair-late-operation-delivery.test.ts tests/runner-v1/file-model-driver.test.ts
```

Tests use a real pinned SharedOS kernel and explicitly scoped grants. The MEMORY
handler writes only a fresh temporary fixture. Injected provider fetches return
fixed scripted decisions and never access the network; the only configured key
is the literal dummy `not-a-secret`. The denied-grant case verifies that no
MEMORY mutation occurs.

## Cases That Remain Fail-Closed

`tests/execution/pair-late-operation-driver.test.ts` covers:

- A completed, matching result delivered before close is journaled exactly once;
  cancellation prevents a second provider request.
- An already-started storage operation can complete after cancellation. If its
  result was never delivered, the journal retains the unmatched call and no
  fabricated result or finish, even though the temporary MEMORY bytes changed.
- An unrelated call ID or unknown tool cannot settle the pending call.
- A result delivered only after session close cannot backfill or reopen it.
- A denied MEMORY capability prevents the actual storage operation.

The deterministic fixtures use deferred promises and explicit cancellation,
not wall-clock sleeps or altered production timeouts. Executor timeout and
external cancellation share the abort controller at
`packages/runtime/src/executor.ts:207`; the regression directly exercises
cancellation, not a claim that every possible timeout interleaving is fixed.

## SharedOS Ownership Evidence

The last driver test uses the real pinned `StandardRuntime` and executor with a
deferred session close. After close starts, aborting the execution causes
`execute` to return `cancelled` while that close is still pending. The test then
releases and awaits close so it leaves no background work.

Relevant pinned SharedOS source locations:

- `packages/runtime/src/executor.ts:308` races the kernel operation against the
  abort signal. A losing operation may still run to completion.
- `packages/runtime/src/executor.ts:353` races the entire runtime against the
  same signal. The cancelled return at line 428 does not await the losing runtime
  promise; the `finally` at line 436 deactivates the host and closes authority.
- `packages/runtime/src/standard-runtime.ts:163` awaits `host.invokeTool` before
  constructing the next `tool_result` input. Its `finally` at line 185 awaits
  `closeSession`; line 276 bounds close separately and suppresses close errors.
- SharedEval `src/runner/v1/sharedos-file-session.ts:430` awaits executor
  completion and then checks actor settlement at line 433. Executor completion alone is not
  evidence that runtime session cleanup is complete.

This is a bounded upstream ownership reproduction, not a SharedOS fix. No
SharedOS source, host permissions, close timeout, or operation authorization was
changed. Safely defining cancellation acknowledgement versus cleanup completion
requires separate runtime-level work and its own review.

## Delivered Reply Versus Committed Tick

`tests/execution/pair-late-operation-delivery.test.ts` uses the real PAIR multi
workflow, pinned runtime, message transport, file provider, and actor journals
with a local scripted provider. It delivers a real responder reply to the
requester, then injects a failure specifically at the requester's subsequent
MEMORY result journal append. No host response is fabricated.

The injected append verifies that the actual MEMORY tool result says
`status: succeeded` and `output.outcome: committed` before failing. The
requester's durable contact result must equal the durable reply payload exactly,
not merely contain similar text; `replyTo` must identify the retained request.

The test requires the request/reply message records and the requester's received
contact-result journal entry to remain durable, while the tick has no committed
record and no terminal actor finish. A second workflow entry must reject before
creating another driver, making another provider request, modifying these
records, or appending a tick commit. This distinguishes actual exposure from
committed evaluation output; the fixture is not an instruction to retry an
uncertain historical operation.

These repairs do not make either historical incomplete run safe to resume.
Existing unmatched calls, delivered tail replies, and uncommitted heartbeats
must remain separately reported. No missing result, heartbeat commit, or model
outcome may be inferred from this test's success.

## CI Runtime Boundary

The two new execution test files use the existing optional-build convention:
without `SHAREDEVAL_REQUIRE_SHAREDOS`, a missing runtime build is skipped. A
present build still goes through revision/digest verification; the test does
not replace an invalid runtime with a mock. The required SharedOS CI step now
includes both files and sets `SHAREDEVAL_REQUIRE_SHAREDOS=1`.

The following missing-runtime checks used only the fresh synthetic path
`/tmp/sharedeval-deliberately-missing-runtime-pair-recovery`:

- REQUIRE unset: exit 0, seven skipped, zero failures, 299.833708 ms.
- REQUIRE set to `1`: exit 1, all seven failed loader verification, zero skips,
  246.210708 ms. This intentional failure proves the mandatory gate stays closed.

Both used Node 24 with `--import tsx --test --test-concurrency=1` and the two
`tests/execution/pair-late-operation-*.test.ts` paths. Passing pinned-runtime
verification remains separately required; a skip is never an acceptance pass.
