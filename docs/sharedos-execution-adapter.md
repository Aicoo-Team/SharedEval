# SharedOS execution adapter (PACT side)

Status: **contract + mock only.** The real binding needs read access to the
private `Aicoo-Team/SharedOS` repository and is deliberately deferred.

## Boundary

SharedOS executes exactly one bounded, permission-filtered agent turn.
Everything around that turn is PACT policy and stays in this repository:

| PACT owns (host policy)                  | SharedOS owns (runtime)                       |
| ---------------------------------------- | --------------------------------------------- |
| tick cadence, retries, budgets, stopping | one bounded turn with default/max timeout     |
| fresh world per task, world digest       | permission filtering, deny-by-default grants  |
| gold labels, judges, metrics, evaluation | tool execution gate, memory/workspace tools   |
| collection gates, provenance assertions  | privileged audit of exact denials             |

The adapter interface lives in `src/execution/sharedos/v1/`:

- `contracts.ts` — strict Zod schemas for world init, turn request/result,
  tool-call records, and three-layer model provenance
  (requested → resolved → served, mirroring the pulse experiment-platform).
- `adapter.ts` — `SharedOsExecutionAdapterV1`: `initWorld` (fail-closed
  world gate) / `runTurn` (one turn per call, results as an array so
  duplicate emissions surface) / optional `closeWorld`.
- `mock-adapter.ts` — deterministic in-memory mock with the six injectable
  incident classes from the pulse P0 platform (timeout, no-response,
  duplicate emission, served-model drift, transient-then-success,
  empty world).

Security semantics encoded structurally, matching the SharedOS
architecture handoff:

- A turn message carries **intent and context, never authority**. The
  schemas are strict; a grant-shaped key is a parse error.
- Turn timeouts have a default and a hard maximum; an above-maximum
  request is rejected at parse time, not clamped.
- Absent, undiscoverable, and exhausted tools all surface as the same
  public `tool_unavailable`; the public vocabulary cannot express grant
  state.

Verify behaviorally with:

```bash
npm run test:execution
```

## Deferred until SharedOS repository access

1. **Real adapter binding** — wrap `@sharedos` runtime/client (embedded
   library first, per the SharedOS integration plan) behind
   `SharedOsExecutionAdapterV1`. The packages are private and unpublished;
   consumption mechanics (workspace link vs. git dependency) are a lead
   decision.
2. **Contract verification** — the following were written from the
   compiled handoff, not from source, and must be checked against
   `docs/integrations/pact.md` in the SharedOS repository:
   timeout default/max values, address shape, turn result field names,
   and the exact world/permission setup calls.
3. **Runner wiring** — exposing the adapter as an opt-in execution
   backend in the runner config is an explicit future config version;
   the current `pact-run/v1` config stays PACT-Pair-shaped for
   compatibility.

Node floor: this repository now declares `node >= 20.11`, matching the
SharedOS supported floor (CI already tests Node 22).
