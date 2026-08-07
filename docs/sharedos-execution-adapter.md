# SharedOS execution adapter (PACT side)

Status: **contract + mock + real `sharedos-embedded` binding**, verified
against SharedOS source at commit `846cbf6` (Aicoo-Team/SharedOS).

This completes O007's PACT-side prerequisites: Node floor raised to
20.11, execution adapter implemented against the production kernel, and
fresh-world/gold isolation enforced and tested.

## Boundary

SharedOS executes exactly one bounded, permission-filtered agent turn.
Everything around that turn is PACT policy and stays in this repository —
this matches the ownership table in the SharedOS repo's
`docs/integrations/pact.md`:

| PACT owns (host policy)                  | SharedOS owns (runtime)                       |
| ---------------------------------------- | --------------------------------------------- |
| tick cadence, retries, budgets, stopping | one bounded turn with default/max timeout     |
| fresh world + namespace per run          | permission filtering, deny-by-default grants  |
| gold labels, judges, metrics, evaluation | tool execution gate, memory/workspace tools   |
| collection gates, provenance assertions  | execution/denial/audit event emission         |

Two adapter boundaries must not be conflated (per the integration guide):

1. `PactAdapterV1` (`src/protocol/v1/`) — the boundary to the untrusted
   agent/model being tested. In an embedded SharedOS integration this
   participant plugs into SharedOS's `AgentTurnDriver` port.
2. `SharedOsExecutionAdapterV1` (`src/execution/sharedos/v1/`) — the
   runner's boundary to the execution substrate itself.

## Contract mapping (verified 2026-08-05)

| PACT-side (this repo)                         | SharedOS source (`@sharedos/contracts`, `@sharedos/runtime`) |
| --------------------------------------------- | ------------------------------------------------------------ |
| `DEFAULT_TURN_TIMEOUT_MS_V1 = 120_000`        | `TurnExecutor` `defaultTimeoutMs ?? 120_000`                 |
| `MAX_TURN_TIMEOUT_MS_V1 = 300_000`            | `MAX_EXECUTION_TIMEOUT_MS`                                   |
| `MAX_TURN_STEPS_V1 = 1_000`                   | `ExecutionOptionsSchema.maxSteps.max(1_000)`                 |
| `sharedOsIdentifierV1Schema` (trim, 1–256)    | `IdentifierSchema` (`z.string().trim().min(1).max(256)`)     |
| `sharedOsJsonValueV1Schema` (JSON-safe)       | `JsonValueSchema` (rejects undefined/bigint/Date/NaN/±Inf)   |
| recipient: agent address only                 | `ExecutionRequestSchema.agent` = `AgentAddressSchema`        |
| address `{kind: 'agent'\|'human', …}`         | `AddressSchema` discriminated union (also group/service)     |
| `namespaceId` on world init/handle            | `AccessContext.namespaceId` (fresh namespace per run)        |
| message `{intent, purpose, payload}`          | `MessageEnvelope` model-relevant fields; purpose required,   |
|                                               | intent/purpose trimmed, payload `JsonValueSchema`            |
| status `succeeded\|denied\|failed\|cancelled` | `ExecutionResultSchema` discriminants (timeout ⇒ cancelled)  |
| `events[]` passthrough                        | append-only `ExecutionEvent[]` on every result               |
| `adapterId` + `protocolVersion` on results    | integration guide: results retain adapter id + version      |

Drift between the PACT mirror and the SharedOS source is guarded by
**differential conformance fixtures**
(`tests/execution/sharedos-conformance.test.ts`): the same fixtures are
parsed by both schema sets and the accept/reject decision must agree.
The seed fixtures are the three drift cases caught in review — a human
execution recipient, a bigint payload, and a whitespace-only identifier
— plus boundary cases (256/257-char ids, extra keys, NaN/Infinity/Date)
and a full PACT-turn → SharedOS `ExecutionRequest` mapping check. The
fixtures run whenever a SharedOS build is reachable and are enforced in
CI against a pinned SharedOS commit (see below). They are the interim
substitute for consuming `@sharedos/contracts` directly, which awaits
the lead's packaging decision.

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
- **`expectedVisibleTools` is enforced, not advisory**: before any turn
  runs, the adapter compares the effective (permission-filtered) tool
  set against the expectation declared at init and fails closed
  (`visible_tools_mismatch`) on disagreement. SharedOS stays the
  authority on what the model sees; PACT refuses to run when authority
  and expectation disagree.
- **A world handle is a claim, not a lookup key**: `runTurn` verifies
  the caller-provided handle's `namespaceId` and `worldDigestAtInit`
  against what init recorded and fails closed (`handle_mismatch`) on
  any difference.

**Digest scope (deliberately narrow):** `workspaceDigest` /
`worldDigestAtInit` attest the *declarative* canonical world value and
nothing else. The world factory's imperative `setup()` and grant wiring
can materialize kernel state the digest does not cover; that code is
versioned with the suite in this repository, so reproducibility of the
executable world is **digest + suite code version**, never the digest
alone. We chose narrowing the claim over digesting the full materialized
world: hashing imperative setup output would require a canonical
serialization of kernel state (providers, handlers, grants — including
functions), which SharedOS does not define and PACT would have to
invent, creating a second drift surface. The narrow claim is honest,
cheap, and auditable.

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
  tools, and sender grants. World factories must emit public task state
  only — never gold labels or evaluator channels.
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
`PACT_SHAREDOS_DIR`, defaulting to `../sharedos-repo` — through minimal
structural types (`embedded-types.ts`). Switching to a proper
workspace/git dependency is a lead decision; the adapter body is
unaffected by that swap.

**CI enforcement:** locally, integration/conformance tests skip with an
explicit logged reason when no SharedOS build is present. In CI that is
no longer sufficient — the required `sharedos-conformance` job
(`.github/workflows/ci.yml`) checks out Aicoo-Team/SharedOS **pinned to
commit `846cbf6`**, builds it, and runs `npm run test:execution` with
`PACT_REQUIRE_SHAREDOS=1`, under which an unavailable SharedOS build is
a hard failure instead of a skip. The job needs the
`SHAREDOS_CHECKOUT_TOKEN` repository secret (a PAT with read access to
the private cross-org Aicoo-Team/SharedOS repo); a missing secret fails
the job rather than skipping it, so schema drift can never merge green.

## Runner wiring (done)

All three follow-ups above the line are implemented in
`src/suites/pact-pair/sharedos-execution.ts` (see its header comment for
the semantic decisions and their rationale):

1. **Driver binding** — the PACT harness is bridged into SharedOS's
   `AgentTurnDriver` port; one trial executes as exactly one bounded
   kernel turn while PACT keeps owning budgets and cadence.
2. **PACT-Pair world** — the nine deterministic Pair tools register as
   SharedOS host tools (kernel-filtered registry + invocation gate at
   surface granularity; folder-level scoping stays in
   `executePactPairToolV1`), with grants host-constructed per trial from
   the granted boundary plan.
3. **Runner wiring** — `benchmark.execution.adapter:
   'pact-public-runner' | 'sharedos-embedded'` in `pact-run/v1`
   (optional; absence keeps existing config digests byte-identical and
   selects the public runner). CLI override: `--execution.adapter`.
   Result rows carry a public `sharedOs` identity block; kernel
   runtime/audit events go to the private trace artifact. The default
   stays `pact-public-runner` until 600-task parity between the paths is
   demonstrated.

Node floor: this repository declares `node >= 20.11`, matching the
SharedOS supported floor (CI already tests Node 22).

Post-merge package, CI, provenance, Harbor, and public-submission work is
tracked in [SharedOS runner follow-ups](sharedos-runner-follow-ups.md).
