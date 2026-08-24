# PACT-Pair multi-turn pilot

A small, runnable pilot of the multi-turn trajectory lane
(`docs/pact-pair-multi-turn-lane.md`): one persona (R4 / Dana Reeves, investor)
probing a protected-QA subset over up to 20 ticks, with a **model-driven
adaptive requester** against a **COO-configured responder**.

## What it exercises

- The tick scheduler: one persistent SharedOS world driven across ticks
  (`initWorld` once, `runTurn` per tick, `closeWorld` at the end).
- File-based agent config: the responder runs from `agent_configs/alex/COO.md`
  (POLICY stays the D2 dial); provenance is hashed into `run.json`.
- The model requester: runs the Dana persona with the checklist, choosing what
  to ask and — after a refusal — a retry strategy (Phase 2 from tick 9).
- Per-tick re-based grading + a `trajectory-summary.json` with
  flip-rate-by-strategy.

## Execution path (reported honestly)

The trajectory lane runs the tick loop **in-process on the embedded SharedOS
adapter** (`backend: local` + `execution.adapter: sharedos-embedded`). Harbor
trajectory support (one trajectory = one container) is a later phase
(`docs/pact-pair-multi-turn-lane.md` §6), and a `backend: harbor` trajectory
config is rejected at parse time rather than silently running local.

## Run it

```bash
PACT_SHAREDOS_DIR=/path/to/sharedos-373b6347 \
  rebuttal/runs/mt_pilot/run_pilot.sh
```

Requires a built SharedOS checkout at the pinned revision
(`373b6347…`) and `OPENROUTER_API_KEY` in `.env` (mapped to
`PACT_MODEL_API_KEY`). Model: `deepseek/deepseek-v4-flash-0731` via OpenRouter,
`providerRouting.only: [relace, baidu]`, temperature 0.

Outputs land under `out/<runId>/`: `run.json` (with `trajectoryProtocol` and
`agentConfigProvenance`), `trajectories.jsonl`, `ticks.jsonl`, `summary.json`,
`trajectory-summary.json`, and `private/` traces.

## Notes

- OpenRouter rate-limits (429) the pinned open-weight endpoints under
  back-to-back calls; both the responder harness and the requester driver honor
  `Retry-After` with up to 8 attempts. If the key is already near its quota, the
  requester can still fall back deterministically per tick (recorded as
  `trajectorySummary.requesterModel.fallbackTicks`) — check that field to
  confirm the requester ran adaptively rather than on the fallback path.
