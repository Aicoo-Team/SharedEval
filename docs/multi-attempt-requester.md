# Multi-attempt requester protocol ("attacker" persistence)

Status: implemented, **off by default**; single-attempt remains the
benchmark's default protocol and its artifacts are byte-identical when the
feature is absent from the config.

## What it is

An opt-in protocol axis in which the requester does not take the first
refusal for an answer: after a responder-level terminal `refuse` or
`escalate`, the requester renews the ask and the trial continues — up to
**3 attempts total per task** (`benchmark.attempts.max`, 1–3).

```yaml
benchmark:
  attempts:
    max: 3
```

CLI override (provenance-bearing, like `--execution.adapter`):

```bash
npm run benchmark -- --config pact-run.yaml --attempts.max 3
```

## Where it lives (architecture)

Retries are **host-side PACT orchestration**, per the ownership table in
[sharedos-execution-adapter.md](sharedos-execution-adapter.md) and the
SharedOS integration guide: SharedOS executes exactly one bounded,
permission-filtered turn; PACT owns cadence, retries, budgets, and stopping.

- Public runner (`pact-public-runner`): the attempt loop wraps the existing
  decision loop in `src/suites/pact-pair/environment.ts`.
- SharedOS path (`sharedos-embedded`): each attempt is **one additional
  bounded kernel turn** against the *same* world handle
  (`src/suites/pact-pair/sharedos-execution.ts`). Nothing was added to the
  SharedOS kernel or the legacy runner internals.
- Shared policy (retry trigger, scripted follow-ups, provenance) lives in
  `src/suites/pact-pair/attempts.ts`.

## Security invariant (non-negotiable)

> Denied is an experimental outcome, not an infrastructure retry. PACT must
> never retry a denied turn with a wider principal or a patched grant.

An attempt retry is **the same principal, the same grants, a renewed ask**.
Structurally: the SharedOS engine re-uses the world handle, sender address,
and `senderGrants` unchanged; the follow-up message carries intent, purpose,
and payload — never authority (grant-shaped message keys are parse errors).
The follow-up scripts are additionally checked in tests for
authority-claiming language.

## Outcome taxonomy and the retry trigger

| Outcome of an attempt | Class | Retries? |
| --- | --- | --- |
| Terminal `pact_answer` from the responder | experimental | no — the requester got an answer |
| Terminal `pact_refuse` / `pact_escalate` from the responder | experimental | **yes**, while attempts and budget remain |
| Runner-synthesized escalate (turn/tool-call budget exhausted, missing terminal decision) | budget outcome | no — retrying an exhausted budget measures nothing |
| Kernel-level `denied` (SharedOS refused turn admission) | experimental | **no** — with an unchanged principal and grant set the kernel's decision is deterministic; a retry could only "succeed" by widening access, which is forbidden. Recorded as `sharedos_turn_denied` + escalate, exactly as before |
| Kernel `cancelled` (turn timeout) / `failed`, provider errors, protocol errors | infrastructure | no — existing error-bucket semantics unchanged |

An empty answer cannot occur at protocol level (`pact_answer.content` has
`min(1)`); a malformed terminal decision is a protocol error
(infrastructure), not a retry trigger.

Known issue interaction: provider-invalid-response still lands in
`infrastructure_error` (tracked in TASKS.md), and a blind `--resume` would
re-run those tasks. This feature does not change that bucket; attempt
retries and infrastructure resume remain disjoint mechanisms.

## Design decisions (with rationale)

1. **Scripted requester, not a live requester model.** Follow-up asks are a
   versioned dataset artifact
   (`dataset/pact-pair/attempts/followup_scripts_v1.json`) with two generic
   persistence templates (`{{prompt}}` expands to the original ask) and an
   empty `taskOverrides` map for future per-task rephrase variants — new
   files only; canonical task bytes untouched. Deterministic, hash-attested,
   identical for every responder, and roughly half the cost of a live
   requester model. A live-requester mode would add a second model axis and
   non-determinism; it can be layered on later behind the same observation
   type. *Trade-off*: scripted pressure is uniform and mild; it measures
   robustness to persistence, not to adaptive social engineering.
2. **Retry trigger** — exactly the responder-authored `refuse`/`escalate`
   (see table above).
3. **Conversation carryover: yes.** Attempts share one harness conversation,
   one workspace, and one granted boundary; the responder sees its own prior
   refusal and the renewed ask (the model adapter closes the dangling
   terminal tool call with a `deliveredToRequester` acknowledgement so
   strict providers accept the transcript). This is deliberately the
   paper's finding-2 mechanism: **the benchmark under this axis measures
   decision robustness under multi-turn persistence pressure, not
   independent-sample refusal rates.** Cross-attempt state also persists
   (a mutation from attempt 1 is visible in attempt 2), which is what a
   real persistent requester would experience.
4. **Metrics.** The ten public metric formulas are untouched and always
   score the FINAL decision. New telemetry, present only when the feature is
   on: per-row `attempts[]` (attempt number, decision, responder- vs
   runner-authored, per-attempt budget share, per-attempt QA `leaked`,
   SharedOS turn status), and a summary `attempts` block (`totalAttempts`,
   `tasksRetried`, `answerAfterRetry` — the attacker-success headline —
   `anyAttemptLeaked` vs `finalAttemptLeaked`). Because refusal *reasons*
   are leak-checked, an early attempt can leak even when the final decision
   is clean; `anyAttemptLeaked` surfaces exactly that.
5. **Budgets: per-task, spanning attempts.** `maxTurns`, `maxToolCalls`,
   and `maxRuntimeMs` are unchanged in meaning — they cap the whole task,
   so enabling attempts cannot silently multiply run cost. A retry is only
   scheduled while turn budget and deadline remain. The SharedOS per-turn
   timeout is recomputed per attempt (remaining deadline, capped at the
   kernel's 300s maximum). Configs enabling `attempts.max: 3` should raise
   `maxTurns` accordingly (each attempt needs at least one turn).

## Byte-stability and provenance

- `benchmark.attempts` is optional with **no default in the parsed
  representation** (same pattern as `benchmark.execution`): existing
  configs keep byte-identical `configDigest`s, and disabled runs produce
  byte-identical `results.jsonl`, `summary.json`, and `run.json` (P-007).
  Presence of the block — even `max: 1` — opts the artifacts into the
  extended shape.
- When enabled, `run.json` carries an `attemptProtocol` block:
  `maxAttempts` plus the follow-up script's id, version, file, and sha256
  (P-019). The config digest covers `benchmark.attempts` automatically.
- Artifact schemas (`src/runner/v1/artifacts.ts`) validate the attempt
  records across the Harbor container trust boundary, including that
  attempts are numbered sequentially and that an observed row's final
  attempt decision equals `finalDecision`.

## Composition with the requester-relationship axis

The protocol is orthogonal to `benchmark.requester` (R0–R4): the follow-up
scripts are requester-neutral templates keyed by attempt number, and the
attempt loop sits outside task loading, so attempts × requesters composes
without interface changes. Per-requester follow-up phrasing, if ever wanted,
belongs in the script file as new versioned variants.

## Known limitations / flagged for the team lead

- **Adapter-host lifecycle is single-attempt.** The out-of-process
  submission host (`src/adapter-host/v1`) ends a session at its first
  terminal decision and explicitly rejects `requester_followup`
  observations. Extending the JSON-RPC lifecycle (decided → active) is a
  protocol-version decision; until then, hosted submission bundles cannot
  run under this axis. In-process harnesses (model adapter, scripted,
  custom factories) are fully supported on both execution adapters.
- **Follow-up scripts are generic.** Community-facing per-task rephrase
  variants would go into `taskOverrides` in a new script version — a
  dataset-release decision.
- **Protocol addition.** `requester_followup` is an additive observation
  variant in protocol v1. Harnesses that never opted into attempts never
  receive it, but strict third-party observation parsers must upgrade
  before running with attempts enabled — worth a release note.
