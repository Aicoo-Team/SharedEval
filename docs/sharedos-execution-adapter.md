# SharedOS execution adapter (PACT side)

Status: **contract + mock + real `sharedos-embedded` binding**, verified
against SharedOS source at commit `373b634` (Aicoo-Team/SharedOS).

This completes O007's PACT-side prerequisites: Node floor raised to
20.11, execution adapter implemented against the production kernel, and
fresh-world/gold isolation enforced and tested.

## Boundary

SharedOS executes exactly one bounded, permission-filtered agent turn.
Everything around that turn is PACT policy and stays in this repository —
this matches the ownership table in the SharedOS repo's
`docs/integrations/pact.md`:

| PACT owns (host policy)                  | SharedOS owns (runtime)                         |
| ---------------------------------------- | ----------------------------------------------- |
| tick cadence, retries, budgets, stopping | one bounded turn with default/max timeout       |
| fresh world + namespace per run          | permission filtering, deny-by-default grants    |
| gold labels, judges, metrics, evaluation | tool execution gate, files and namespaced tools |
| collection gates, provenance assertions | execution/denial/audit event emission           |

Two adapter boundaries must not be conflated (per the integration guide):

1. `PactAdapterV1` (`src/protocol/v1/`) — the boundary to the untrusted
   agent/model being tested. In an embedded SharedOS integration this
   participant plugs into SharedOS's `AgentTurnDriver` port.
2. `SharedOsExecutionAdapterV1` (`src/execution/sharedos/v1/`) — the
   runner's boundary to the execution substrate itself.

## Contract mapping (verified 2026-08-13)

| PACT-side (this repo)                         | SharedOS source (`@sharedos/contracts`, `@sharedos/runtime`) |
| --------------------------------------------- | ------------------------------------------------------------ |
| `DEFAULT_TURN_TIMEOUT_MS_V1 = 120_000`        | `TurnExecutor` `defaultTimeoutMs ?? 120_000`                 |
| `MAX_TURN_TIMEOUT_MS_V1 = 300_000`            | `MAX_EXECUTION_TIMEOUT_MS`                                   |
| `MAX_TURN_STEPS_V1 = 1_000`                   | `ExecutionOptionsSchema.maxSteps.max(1_000)`                 |
| address `{kind: 'agent'\|'human', …}`         | `AddressSchema` discriminated union (also group/service)     |
| `namespaceId` on world init/handle            | `AccessContext.namespaceId` (fresh namespace per run)        |
| message `{intent, purpose, payload}`          | `MessageEnvelope` model-relevant fields; purpose required    |
| status `succeeded\|denied\|failed\|cancelled` | `ExecutionResultSchema` discriminants (timeout ⇒ cancelled)  |
| `events[]` passthrough                        | append-only `ExecutionEvent[]` on every result               |
| `adapterId` + `protocolVersion` on results    | integration guide: results retain adapter id + version      |

Adapter identifiers follow the guide: `sharedos-embedded`,
`sharedos-http`, `pact-public-runner`, plus `mock-sharedos` for the mock.
Absolute outcome rates from different adapters must not be combined
unless equivalence has been demonstrated.

Security semantics encoded structurally:

- A turn message carries **intent, purpose, and payload — never
  authority**. Grants travel separately through the `AccessContext` the
  real adapter builds host-side per tick (including the per-tick
  target-agent execution grant). Strict schemas make a grant-shaped
  message key a parse error.
- **`denied` is an experimental outcome**, not an infrastructure retry.
  The mock keeps denials deterministic across attempts; PACT must never
  retry a denied turn with a wider principal or a patched grant.
- Turn timeouts default to 120s and cap at 300s; above-maximum requests
  are rejected at parse time. A timed-out turn surfaces as `cancelled`
  (the runtime aborts with "turn timeout").
- Absent, undiscoverable, and exhausted tools all surface as the same
  public `tool_unavailable`; the public vocabulary cannot express grant
  state.

The mock (`MockSharedOsAdapterV1`) injects seven incident classes:
timeout, no-response, denied, duplicate emission, served-model drift,
transient-then-success, empty world — the six pulse experiment-platform
classes plus SharedOS's first-class permission denial.

Verify behaviorally with:

```bash
npm run test:execution
```

## The `sharedos-embedded` binding

`EmbeddedSharedOsAdapterV1` (`embedded-adapter.ts`) runs turns through
the real SharedOS kernel and `TurnExecutor`:

- `initWorld` verifies the world factory's canonical bytes against the
  host-measured digest (fail-closed), then builds one fresh kernel per
  world and lets the suite-owned `EmbeddedWorldV1` register providers,
  tools, enabled tool namespaces, and sender grants. World factories must emit
  public task state only — never gold labels or evaluator channels.
- `runTurn` issues the per-tick recipient-scoped execution grant
  (`agentExecutionCapability`), builds the `AccessContext` +
  `MessageEnvelope` + permission-filtered tool list, executes one
  bounded turn, and maps the `ExecutionResult` (status, events, public
  tool statuses) into `SharedOsTurnResultV1`. A world can set
  `executionGrant: 'withheld'` to make permission denial the expected
  experimental condition.
- The agent under test plugs in as SharedOS's `AgentTurnDriver` port;
  SharedOS sanitizes the model-facing request itself (no grants, no
  issuing authority — integration-tested).

**Package consumption (interim):** `@sharedos/*` is private and
unpublished, so the binding dynamically loads a locally built checkout —
`PACT_SHAREDOS_DIR`, otherwise the first existing sibling at `../SharedOS` or
`../sharedos-repo` — through minimal structural types (`embedded-types.ts`).
The loader pins commit `373b6347559e39e00b2a4f6bc934373833b40266` and fails
closed on a different revision, tracked source changes, or a mismatch in the
digest of the executable `dist/*.js` tree. Integration tests skip with an
explicit logged reason when no checkout is present; a required pinned CI job
remains necessary before this becomes an official execution path.

## Runner integration

`src/suites/pact-pair/sharedos.ts` now provides the suite-owned world factory
and `PactAdapterV1` → `AgentTurnDriver` bridge. The runner accepts the opt-in
selector `execution.adapter: sharedos-embedded`; omission preserves the
existing `pact-public-runner` behavior and config digest. Each selected task
gets one fresh namespace, one digest-bound declarative world, and one bounded
SharedOS turn. SharedOS-filtered tools are also applied to the model adapter's
visible catalog before its first step.

`npm run test:sharedos` is the fail-not-skip conformance entrypoint. The next
production gate is wiring that command into a required CI job with authenticated
access to the pinned SharedOS source. After that, replace the interim sibling
checkout with exact `@sharedos/*` package dependencies when SharedOS is licensed
and published. The adapter already targets the current `createFileTools` API and
the default-off tool namespace control plane; only package delivery remains
interim.

Node floor: this repository declares `node >= 20.11`, matching the
SharedOS supported floor (CI already tests Node 22).
