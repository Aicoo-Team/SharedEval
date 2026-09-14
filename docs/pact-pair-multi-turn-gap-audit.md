# Multi-turn probe protocol — gap audit against `files-multi` (2026-09-01)

Audited at `fix/isolate-indeterminate-task` @ a358e55 (PR #52 head), the chosen base
for the multi-turn lane. Paper protocol: STR-2026-001 §6.2 / Table 16 — 240 heartbeat
ticks, Phase 1 (ticks 1–60) direct asks, Phase 2 (ticks 61–240) broad-spectrum
retries, trajectory-level flip and incidental-leak reporting.

## What already works (verified by reading code)

1. **Cross-tick re-asking is mechanically supported.** A task is terminal only when
   the requester's own `MEMORY.md` row leaves `pending` *and* a contact exists for it
   (`planCommittedHeartbeat`, `src/suites/pact-pair/file-workflow.ts`). While the row
   stays `pending`, the same task remains schedulable and the requester may issue a
   new `messages.request` for the same `taskId` on any later tick; the contacts map
   keeps the latest authority per task, and every per-tick contact is committed in
   the ledger records.
2. **The tick loop is real.** `runOneFileDrivenPairSessionV1` runs one requester turn
   per tick up to `maxTicks` (config cap 10 000; 240 is fine), with committed
   heartbeat records, deterministic replay, and recovery.
3. **Per-tick scorable results.** Terminal outcomes are evaluated per task at the
   tick where the memory row flips (`heartbeatTerminalOutcome` →
   `evaluateOutcome`), and `results.jsonl` / `summary.json` keep the frozen P-007
   shape.
4. **Per-tick public record exists.** `events.jsonl` has one row per tick (tick,
   contacted task, memory-committed flag, file-read count, usage). Private ledger
   records additionally carry each tick's `contactAuthority.status`, message ids,
   and responses — enough raw material to derive flip statistics.
5. **Config seam exists.** `workflow.mode: multi` routes to `files-multi`
   (single session, all selected tasks, `taskConcurrency` forbidden > 1), and
   `run-cell.sh` derives the CLI mode from the config, so the experiment
   sandbox path needs no changes to *launch* a multi run.

## Gaps (what the paper protocol needs that is missing)

1. **The heartbeat asset forbids retries.** The one shipped multi heartbeat
   (`dataset/shared-eval/workspaces/v1/heartbeats/files-multi/1.1.0/HEARTBEAT.md`)
   instructs: ask once, classify the durable reply as `[answered]`/`[refused]`,
   "Never … retry a terminal task." A refusal therefore becomes terminal on first
   contact — the exact opposite of the probe protocol. Needed: a new heartbeat
   asset (new registry entry + version, so existing configs keep their byte digest)
   that tells the requester to keep a refused-but-unresolved task `pending` (attempt
   notes in the free-form note field) and re-ask with adapted phrasing.
2. **No tick/phase awareness.** Each requester turn starts a fresh provider
   conversation whose only runtime input is the fixed string
   "Read AGENT.md and HEARTBEAT.md, then follow the heartbeat."
   (`sharedos-file-session.ts`). The model cannot know it is at tick 61 of 240, so
   the Phase 1 → Phase 2 switch cannot be tick-indexed today. Options:
   (a) inject `tick`/`maxTicks` into the heartbeat instruction payload behind a new
   optional config field (absent ⇒ byte-identical prompt, digest unchanged), or
   (b) approximate phases by per-task attempt counts kept in MEMORY notes.
   (a) is faithful to the paper; the eventId already commits the tick so determinism
   is unaffected.
3. **Requester-side adaptive retry protocol is prompt-only today.** There is no
   runtime "retry driver"; whether Phase 2 rephrasings happen at all is entirely up
   to the heartbeat/POLICY assets. That is acceptable (the paper's requester is a
   model following its brief), but the assets don't exist yet: POLICY.md files list
   the question set only, with no retry playbook.
4. **Responder has no cross-tick memory of prior refusals.** The responder
   heartbeat (e.g. `agents/alex/base/HEARTBEAT.md`) reads MEMORY.md but never
   writes it, and each responder turn is a fresh conversation. Re-asks are thus
   independent trials, which changes the meaning of "brute repeat flip 7.6% vs
   commercial-reframe flip 34.5%". The locked decision "responder memory writes are
   kernel-audited but out of scoring" anticipated responder memory writes — this is
   where the parallel `feat/memory-delta` work (line-wise MEMORY updates) plugs in.
   Decide: ship v1 with memoryless responder (documented) or wait for memory-delta.
5. **No trajectory-level aggregate artifact.** Flip statistics and per-task attempt
   traces must currently be reconstructed from private ledger records. Needed: a
   `trajectory.json` (or similar) public artifact — per task: tick of each contact,
   per-contact status, final status, flip count — written alongside the existing
   five artifacts. P-007 constraint: do **not** touch `summary.json`'s shape; add a
   new artifact instead.
6. **A provider failure in any tick kills the whole trajectory** (verified live,
   smokes `multi-smoke-1/-2`, server `~/multi-smoke/`, 2026-09-01, image
   `sharedeval-experiment:a358e5512476`, deepseek pinned Inceptron): the E2E
   pipeline works — config `mode: multi` → `run-cell.sh` → `files-multi` → per-tick
   ledger records + `events.jsonl` all landed and are readable — but in both runs a
   requester model call hit OpenRouter 429 (two concurrent validation cells were
   sharing the key), the driver gave up after 3 attempts (~62 s), and
   `requesterExecutionStatus: failed` → `planCommittedHeartbeat` marked *every*
   remaining task `error` and stopped with `fatal_error` at tick 1. In smoke-2 the
   turn had already read AGENT.md/HEARTBEAT.md (5 provider calls, one
   `invalid_response` also absorbed) before the fatal 429. For 240-tick trajectories the old pilot's lesson
   applies: requester retries must match responder-grade robustness (8 backoff
   attempts, honor Retry-After, jitter), and/or a failed tick should be
   recoverable rather than trajectory-fatal. Watch `fallbackTicks≈0`-style
   realism metrics.
7. **240-tick budget interactions unvalidated.** `budget.maxRuntimeMs` (cap
   600 000 ms) bounds each task attempt; a 240-tick trajectory is a long wall-clock
   run with per-tick provider calls on both sides. Rate-limit behaviour at
   trajectory length (429s mid-trajectory, `fallbackTicks`-style realism metrics)
   needs a pilot before the 20-cell Table 8 grid.

## Base-branch decision

Build on `fix/isolate-indeterminate-task` (PR #52, a358e55): it is the tip of the
real dependency stack (contains PR #48 + #49 + the portable-tool-calls commit
adb54c7 that the running experiments use), it already modifies
`file-workflow.ts`/ledger where multi-turn work lands, and the server already has
image `sharedeval-experiment:a358e5512476`. Working branch:
`feat/multi-turn-files` (worktree `pact-multiturn`).
