import { z } from 'zod';

export const FILE_TURN_BOOTSTRAP_V1 =
  'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.';

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be an opaque identifier');

export const fileTurnInputV1Schema = z
  .object({
    actorId: opaqueIdSchema,
    traceId: opaqueIdSchema,
    deadlineMs: z.number().int().safe().positive().max(3_600_000),
    maxToolSteps: z.number().int().safe().nonnegative().max(128),
    maxContactCalls: z.number().int().safe().nonnegative().max(64),
    cancelled: z.boolean().optional(),
  })
  .strict();

const fileTurnUsageV1Schema = z.object({
  toolSteps: z.number().int().safe().nonnegative(),
  contactCalls: z.number().int().safe().nonnegative(),
}).strict();

export const fileTurnDecisionV1Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('completed'),
    content: z.string().min(1).max(1_048_576),
    toolSteps: fileTurnUsageV1Schema.shape.toolSteps,
    contactCalls: fileTurnUsageV1Schema.shape.contactCalls,
  }).strict(),
  z.object({
    type: z.literal('denied'),
    reason: z.string().min(1).max(65_536),
    toolSteps: fileTurnUsageV1Schema.shape.toolSteps,
    contactCalls: fileTurnUsageV1Schema.shape.contactCalls,
  }).strict(),
  z.object({
    type: z.literal('cancelled'),
    reason: z.string().min(1).max(4_096),
    toolSteps: fileTurnUsageV1Schema.shape.toolSteps,
    contactCalls: fileTurnUsageV1Schema.shape.contactCalls,
  }).strict(),
]);

export type FileTurnInputV1 = z.infer<typeof fileTurnInputV1Schema>;
export type FileTurnDecisionV1 = z.infer<typeof fileTurnDecisionV1Schema>;

/**
 * One instance owns exactly one model-visible turn. The scheduler must create
 * a new instance for every heartbeat and recipient contact.
 */
export interface FreshFileHarnessV1 {
  step(input: FileTurnInputV1): Promise<FileTurnDecisionV1>;
  finalize(): Promise<void>;
}

export type FreshFileHarnessFactoryV1 = () => FreshFileHarnessV1;

/**
 * Runtime seam consumed by the file harness. Task 5 supplies the authorized
 * implementation; message text is data and never expands this port.
 */
export interface FileHarnessContactPortV1 {
  contact(input: {
    senderId: string;
    recipientId: string;
    message: string;
    intent: string;
    purpose: string;
    traceId: string;
    deadlineMs: number;
  }): Promise<{
    status: 'completed' | 'denied' | 'failed' | 'cancelled';
    response?: string;
    errorCode?: string;
    recipientTraceId: string;
  }>;
}

/**
 * Creates and disposes one fresh harness. Cleanup runs once on every path; a
 * cleanup failure never replaces the turn's original failure.
 */
export async function runFreshFileTurnV1(
  factory: FreshFileHarnessFactoryV1,
  input: FileTurnInputV1,
): Promise<FileTurnDecisionV1> {
  const parsed = fileTurnInputV1Schema.parse(input);
  const harness = factory();
  let turnFailure: unknown;
  try {
    if (parsed.cancelled) {
      return {
        type: 'cancelled',
        reason: 'The file turn was cancelled before it started.',
        toolSteps: 0,
        contactCalls: 0,
      };
    }
    return fileTurnDecisionV1Schema.parse(await harness.step(parsed));
  } catch (error) {
    turnFailure = error;
    throw error;
  } finally {
    try {
      await harness.finalize();
    } catch (finalizeFailure) {
      if (turnFailure === undefined) throw finalizeFailure;
    }
  }
}
