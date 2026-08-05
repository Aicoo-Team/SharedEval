/**
 * PACT-side SharedOS execution contracts (v1).
 *
 * SharedOS executes exactly one bounded, permission-filtered agent turn;
 * PACT owns everything around it: tick cadence, retries, budgets, fresh
 * worlds, gold isolation, and evaluation. These schemas are the PACT side
 * of that boundary — a deliberate host-level abstraction over the
 * `@sharedos/contracts` wire schemas, verified against the SharedOS
 * repository at commit 846cbf6 (see docs/sharedos-execution-adapter.md
 * for the field-by-field mapping).
 *
 * Security semantics inherited from SharedOS and enforced structurally:
 *   - A message carries intent, purpose, and payload but never grants
 *     authority (strict schemas: a grant-shaped key is a parse error).
 *     Authority travels separately through the AccessContext that the
 *     real adapter builds host-side per tick.
 *   - Turn timeouts have a default (120s, the TurnExecutor default) and
 *     a hard maximum (300s, MAX_EXECUTION_TIMEOUT_MS); an above-maximum
 *     request is rejected at parse time rather than silently clamped.
 *   - `denied` is a first-class terminal outcome — an experimental
 *     result, never an infrastructure retry. PACT must not retry a
 *     denied turn with a wider principal or a silently patched grant.
 *   - Public tool-call status is a closed vocabulary in which absent,
 *     undiscoverable, and exhausted tools are indistinguishable
 *     (`tool_unavailable`); exact denials stay in SharedOS's privileged
 *     audit, never in benchmark artifacts.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Matches the SharedOS TurnExecutor default (`defaultTimeoutMs ?? 120_000`). */
export const DEFAULT_TURN_TIMEOUT_MS_V1 = 120_000;
/** Matches `MAX_EXECUTION_TIMEOUT_MS` in `@sharedos/contracts`. */
export const MAX_TURN_TIMEOUT_MS_V1 = 300_000;
/** Matches the `maxSteps` bound in the SharedOS ExecutionOptions schema. */
export const MAX_TURN_STEPS_V1 = 1_000;

/** Mirrors the SharedOS protocol version literal. */
export const SHAREDOS_PROTOCOL_VERSION_V1 = '1' as const;

/**
 * Execution adapter identifiers recommended by the SharedOS PACT
 * integration guide. Results always retain the adapter identifier;
 * absolute outcome rates from different adapters must not be combined
 * unless equivalence has been demonstrated.
 */
export const sharedOsAdapterIdV1Schema = z.enum([
  'sharedos-embedded',
  'sharedos-http',
  'pact-public-runner',
  'mock-sharedos',
]);
export type SharedOsAdapterIdV1 = z.infer<typeof sharedOsAdapterIdV1Schema>;

/**
 * Structured address, mirroring the SharedOS discriminated union.
 * Namespace is deliberately not part of the address — it lives on the
 * world (one fresh namespace per official run). SharedOS also defines
 * `group` and `service` kinds; PACT worlds only address humans and agents.
 */
export const sharedOsAddressV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('human'), userId: z.string().min(1) }).strict(),
]);
export type SharedOsAddressV1 = z.infer<typeof sharedOsAddressV1Schema>;

/**
 * Fresh-world initialization request. PACT measures the canonical world
 * bytes itself and passes only the digest; if what the runtime
 * materializes does not match, init must throw before any turn runs —
 * never "run first, explain later".
 *
 * The real adapter also seeds the world's provider ports here (grants —
 * including the per-tick target-agent execution grant — messages,
 * memory/workspace resources, deterministic tools, audit), with
 * run-local state only. Gold labels and evaluator channels never enter.
 */
export const sharedOsWorldInitV1Schema = z
  .object({
    worldId: z.string().min(1),
    taskId: z.string().min(1),
    /** One fresh namespace per official run; isolation boundary. */
    namespaceId: z.string().min(1),
    recipient: sharedOsAddressV1Schema,
    /** sha256 over the canonical world bytes, measured by the host. */
    workspaceDigest: sha256Schema,
    /**
     * Tool names the host expects to be visible after SharedOS permission
     * filtering. Expectation only — SharedOS remains the authority on what
     * the model actually sees.
     */
    expectedVisibleTools: z.array(z.string().min(1)),
  })
  .strict();
export type SharedOsWorldInitV1 = z.infer<typeof sharedOsWorldInitV1Schema>;

export const sharedOsWorldHandleV1Schema = z
  .object({
    worldId: z.string().min(1),
    namespaceId: z.string().min(1),
    /** Digest measured at init, after the world gate passed. */
    worldDigestAtInit: sha256Schema,
  })
  .strict();
export type SharedOsWorldHandleV1 = z.infer<typeof sharedOsWorldHandleV1Schema>;

/**
 * The message opening a turn: intent, purpose, and payload only —
 * mirroring the SharedOS MessageEnvelope's model-relevant fields.
 * `purpose` is required because it is one of the kernel's authorization
 * dimensions. Deliberately no field can carry grants, capabilities, or
 * tool definitions — strict parsing turns any such attempt into an error.
 */
export const sharedOsTurnMessageV1Schema = z
  .object({
    intent: z.string().min(1).max(512),
    purpose: z.string().min(1).max(512),
    payload: z.unknown().optional(),
  })
  .strict();
export type SharedOsTurnMessageV1 = z.infer<typeof sharedOsTurnMessageV1Schema>;

/** Mirrors the SharedOS ExecutionOptions bounds. */
export const sharedOsTurnOptionsV1Schema = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TURN_TIMEOUT_MS_V1)
      .default(DEFAULT_TURN_TIMEOUT_MS_V1),
    maxSteps: z.number().int().positive().max(MAX_TURN_STEPS_V1).optional(),
  })
  .strict();
export type SharedOsTurnOptionsV1 = z.infer<typeof sharedOsTurnOptionsV1Schema>;

export const sharedOsTurnRequestV1Schema = z
  .object({
    turnId: z.string().min(1),
    message: sharedOsTurnMessageV1Schema,
    options: sharedOsTurnOptionsV1Schema.default({}),
  })
  .strict();
export type SharedOsTurnRequestV1 = z.infer<typeof sharedOsTurnRequestV1Schema>;

/**
 * Public per-call status vocabulary. Absent, undiscoverable, and exhausted
 * tools all surface as `tool_unavailable`; anything finer-grained belongs
 * to SharedOS privileged audit and must never reach benchmark artifacts.
 */
export const sharedOsToolCallStatusV1Schema = z.enum([
  'ok',
  'error',
  'tool_unavailable',
]);
export type SharedOsToolCallStatusV1 = z.infer<
  typeof sharedOsToolCallStatusV1Schema
>;

export const sharedOsToolCallRecordV1Schema = z
  .object({
    callId: z.string().min(1),
    name: z.string().min(1),
    publicStatus: sharedOsToolCallStatusV1Schema,
  })
  .strict();
export type SharedOsToolCallRecordV1 = z.infer<
  typeof sharedOsToolCallRecordV1Schema
>;

/**
 * Three-layer model provenance, mirroring the pulse experiment-platform
 * contract: what PACT asked for, what the registry resolved, what the
 * provider reports having served. Downstream gates treat
 * `servedId !== resolvedId` as drift and the observation as invalid.
 */
export const sharedOsModelProvenanceV1Schema = z
  .object({
    requestedId: z.string().min(1),
    resolvedId: z.string().min(1),
    servedId: z.string().nullable(),
  })
  .strict();
export type SharedOsModelProvenanceV1 = z.infer<
  typeof sharedOsModelProvenanceV1Schema
>;

/**
 * Terminal turn statuses, exactly the SharedOS ExecutionResult
 * discriminants. A timed-out turn surfaces as `cancelled` (the runtime
 * aborts with "turn timeout"); a turn that produced nothing surfaces as
 * `failed`. `denied` is an experimental outcome, never a retry trigger.
 */
export const sharedOsTurnStatusV1Schema = z.enum([
  'succeeded',
  'denied',
  'failed',
  'cancelled',
]);
export type SharedOsTurnStatusV1 = z.infer<typeof sharedOsTurnStatusV1Schema>;

/**
 * Append-only execution/audit event passthrough. PACT consumes these
 * into the run transcript; they must be sufficient to reconstruct
 * authorization decisions.
 */
export const sharedOsTurnEventV1Schema = z
  .object({
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1).max(128),
    data: z.unknown(),
    occurredAt: z.string().min(1),
  })
  .strict();
export type SharedOsTurnEventV1 = z.infer<typeof sharedOsTurnEventV1Schema>;

export const sharedOsTurnResultV1Schema = z
  .object({
    turnId: z.string().min(1),
    worldId: z.string().min(1),
    /** Which execution substrate produced this row; never mix rates across adapters. */
    adapterId: sharedOsAdapterIdV1Schema,
    protocolVersion: z.literal(SHAREDOS_PROTOCOL_VERSION_V1),
    traceId: z.string().min(1),
    status: sharedOsTurnStatusV1Schema,
    /** Final model-facing output of the turn; null when nothing was produced. */
    output: z.string().nullable(),
    toolCalls: z.array(sharedOsToolCallRecordV1Schema),
    events: z.array(sharedOsTurnEventV1Schema),
    provenance: sharedOsModelProvenanceV1Schema,
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    latencyMs: z.number().nonnegative(),
    errorDetail: z.string().optional(),
  })
  .strict();
export type SharedOsTurnResultV1 = z.infer<typeof sharedOsTurnResultV1Schema>;

/** sha256 over key-sorted canonical JSON; mirrors pulse digestObject. */
export function digestObjectV1(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
