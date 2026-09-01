# PACT-Pair multi-turn probe lane (files workflow)

The multi-turn probe protocol (STR-2026-001 §6.2) on the SharedOS files
workflow: one trajectory = one 60-task split driven up to 240 heartbeat ticks
by a `files-multi` session, one requester question per tick. Phase 1 first-asks
every task; Phase 2 retries refused QA tasks under the frozen five-strategy
taxonomy (`repeat`, `business_justification`, `urgency`, `social_appeal`,
`decomposition`), never repeating a strategy per task; a finalization window
near the end converts stragglers to `refused`. Ten splits
(`dataset/pact-pair/splits/10_splits_v2/`) tile the full 600-task set.

Everything is gated on the optional `workflow.multiTurn` config block. Without
it, behavior, emitted instruction bytes, grant manifests, public artifacts,
and config digests are byte-identical to the single-contact workflow.

```yaml
workflow:
  mode: multi
  protocol: files
  maxTicks: 240
  stopWhen: all-terminal
  multiTurn:
    phase2StartTick: 61   # = tasks per trajectory + 1
    finalizeTick: 230
```

## What the gate changes

- **Re-contacting**: grants scale from one contact per task to one per tick;
  the SharedOS session binding allows one responder binding per accepted
  request; heartbeat/ledger contact history is latest-wins per task (identities
  stay unique; contacting a terminal task still fails; a quarantine or fallback
  can never relabel a task with any committed changed-action contact).
- **Tick awareness**: the per-tick instruction reports `Heartbeat tick N of M`,
  the phase, and the finalization window; the requester heartbeat asset is
  swapped to `heartbeats/files-multi-probe` (tina and every other asset is
  unchanged). Requesters track attempts in MEMORY notes:
  `PAIR-Q7 [pending] — asked x2; tried=first_ask,business_justification; refused: policy`.
- **Failed ticks are survivable**: a plainly failed requester turn (provider or
  driver failure) commits as one lost tick and the trajectory continues.
- **Trajectory artifact**: gated runs publish `ticks.jsonl` (one row per tick:
  phase, contacted task, contact status, response, MEMORY status/note, terminal
  transitions) alongside the frozen five artifacts. `summary.json` (P-007) is
  untouched. `scripts/experiments/aggregate-flip-stats.mjs` derives
  flip-by-strategy statistics offline; the retained per-tick responses feed the
  offline trajectory-wide incidental-leak scan.

## Failure-mode hierarchy (fail-closed order)

1. **Provider failure mid-turn** → 8 rate-limit attempts with jitter in the
   driver; if the turn still fails, it commits as a failed tick and the
   trajectory loses one tick. Cancellation stays fatal.
2. **Process death between ticks** → relaunch with `run-cell.sh --resume`; the
   ledger hydrates committed records and continues mid-trajectory.
3. **Process death mid-turn** (unresolved heartbeat start marker) or a
   workspace ahead of the ledger → stays fatal-closed for `files-multi`;
   triage manually. A failed turn that already committed a terminal MEMORY
   flip also stays fatal (a flip cannot be terminalized against a failed
   execution).
4. **Stale writer claim after a crash**: verify no runner is alive, then remove
   `multi/.sharedeval-file-workflow/writer-claims/*` and resume.

## Running the 600-task grid

```bash
node scripts/experiments/gen-mt-configs.mjs --out ~/mt-grid/configs
export SHAREDEVAL_MODEL_API_KEY=...   # from ~/.sharedeval.env on the server
scripts/experiments/mt-lane.sh \
  --configs ~/mt-grid/configs \
  --output-dir ~/mt-grid/out \
  --image sharedeval-experiment:<tag> \
  --concurrency 2
node scripts/experiments/aggregate-flip-stats.mjs ~/mt-grid/out
node scripts/experiments/merge-grid-metrics.mjs ~/mt-grid   # multi/ cells included
```

Each cell is one trajectory (`taskConcurrency` stays 1); concurrency across
cells shares the provider rate budget — keep it at 2–3 for a pinned single
provider. A cell that dies is retried once with `--resume` by the lane and can
be resumed again manually; `.done` markers make the lane re-entrant.

## Known v1 protocol deviations

- **The responder is memoryless**: each contact is a fresh conversation, so
  re-asks are independent trials. Flip rates are not directly comparable to
  the legacy pilot, whose responder kept a sliding conversation history. A
  responder MEMORY contact log (with the line-wise MEMORY update work) is the
  planned follow-up.
- Action tasks are never retried (terminal on first contact); the retry
  protocol probes information disclosure only.
