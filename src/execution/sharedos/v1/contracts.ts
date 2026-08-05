/**
 * PACT-side SharedOS execution contracts (v1).
 *
 * SharedOS executes exactly one bounded, permission-filtered agent turn;
 * PACT owns everything around it: tick cadence, retries, budgets, fresh
 * worlds, gold isolation, and evaluation. These schemas encode the PACT
 * side of that boundary so the tick loop and collection gates can be built
 * and tested before the private `@sharedos` packages are reachable.
 *
 * Security semantics inherited from the SharedOS architecture handoff and
 * enforced structurally here:
 *   - A message carries intent and context but never grants authority
 *     (strict schemas: a grant-shaped key is a parse error, not a no-op).
 *   - The turn request contains no authority material at all; SharedOS
 *     reconstructs authorization on its side of the boundary.
 *   - Turn timeouts have a default and a hard maximum; a request above the
 *     maximum is rejected at parse time rather than silently clamped.
 *   - Public tool-call status is a closed vocabulary in which absent,
 *     undiscoverable, and exhausted tools are indistinguishable
 *     (`tool_unavailable`); exact denials stay in SharedOS's privileged
 *     audit, never in benchmark artifacts.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Turn timeout bounds. SharedOS enforces its own default and maximum;
 * these mirror that contract on the PACT side and must be re-verified
 * against the SharedOS repository once it is reachable.
 */
export const DEFAULT_TURN_TIMEOUT_MS_V1 = 60_000;
export const MAX_TURN_TIMEOUT_MS_V1 = 300_000;

/** Agent identity as SharedOS addresses it: a namespaced id, nothing more. */
export const sharedOsAddressV1Schema = z
  .object({
    namespace: z.string().min(1),
    agentId: z.string().min(1),
  })
  .strict();
export type SharedOsAddressV1 = z.infer<typeof sharedOsAddressV1Schema>;

/**
 * Fresh-world initialization request. PACT measures the canonical world
 * bytes itself and passes only the digest; if what SharedOS materializes
 * does not match, init must throw before any turn runs — never
 * "run first, explain later".
 */
export const sharedOsWorldInitV1Schema = z
  .object({
    worldId: z.string().min(1),
    taskId: z.string().min(1),
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
    /** Digest measured at init, after the world gate passed. */
    worldDigestAtInit: sha256Schema,
  })
  .strict();
export type SharedOsWorldHandleV1 = z.infer<typeof sharedOsWorldHandleV1Schema>;

/**
 * The message opening a turn: intent and operational context only.
 * Deliberately no field can carry grants, capabilities, or tool
 * definitions — strict parsing turns any such attempt into an error.
 */
export const sharedOsTurnMessageV1Schema = z
  .object({
    intent: z.string().min(1),
    context: z.record(z.unknown()).optional(),
  })
  .strict();
export type SharedOsTurnMessageV1 = z.infer<typeof sharedOsTurnMessageV1Schema>;

export const sharedOsTurnRequestV1Schema = z
  .object({
    turnId: z.string().min(1),
    message: sharedOsTurnMessageV1Schema,
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TURN_TIMEOUT_MS_V1)
      .default(DEFAULT_TURN_TIMEOUT_MS_V1),
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

export const sharedOsTurnOutcomeV1Schema = z.enum([
  'completed',
  'timeout',
  'cancelled',
  'no_response',
  'infrastructure_error',
]);
export type SharedOsTurnOutcomeV1 = z.infer<typeof sharedOsTurnOutcomeV1Schema>;

export const sharedOsTurnResultV1Schema = z
  .object({
    turnId: z.string().min(1),
    worldId: z.string().min(1),
    outcome: sharedOsTurnOutcomeV1Schema,
    /** Final model-facing text of the turn; null when nothing was produced. */
    output: z.string().nullable(),
    toolCalls: z.array(sharedOsToolCallRecordV1Schema),
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
