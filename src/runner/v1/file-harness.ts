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

const approvedFileTurnPublicMessagesV1 = new Set([
  'A fresh file harness instance is required for every turn',
  'Agent contact failed',
  'Agent contact is not authorized for this file turn',
  'Agent contact returned an invalid result',
  'File harness creation failed',
  'File harness finalization failed',
  'File harness returned an invalid turn decision',
  'File harness step failed',
  'File model provider request failed',
  'File model provider responded with a redirect; refusing to resend credentials',
  'File model provider response stream failed',
  'File model provider returned an invalid first choice',
  'File model provider returned an invalid response envelope',
  'File model provider returned an invalid turn decision',
  'File model provider returned duplicate tool-call identifiers',
  'File model provider returned invalid contact_agent arguments',
  'File model provider returned invalid files_list arguments',
  'File model provider returned invalid files_read arguments',
  'File model provider returned invalid files_replace_memory arguments',
  'File model provider returned invalid reasoning details',
  'File model provider returned malformed tool arguments',
  'File model provider returned multiple parallel tool calls',
  'File model provider returned no tool call',
  'File model provider returned no turn decision',
  'File model provider returned invalid JSON',
  'File model provider reused a prior tool-call identifier',
  'File model provider selected an unauthorized logical path',
  'File model provider selected an unavailable tool',
  'File model timeout must be a positive integer up to 3600000ms',
  'File model tool result exceeds 2097152 bytes',
  'File model tool result is invalid',
  'File turn contact budget exhausted',
  'File turn input is invalid',
  'File turn runtime deadline exceeded',
  'File turn tool-step budget exhausted',
  'File workspace MEMORY replacement failed',
  'File workspace read failed',
  'File workspace returned a mismatched read receipt',
  'File workspace returned an invalid MEMORY replacement result',
  'File workspace returned an invalid read result',
  'MEMORY replacement is not authorized for this file turn',
  'MEMORY replacement is limited to one successful publication per file turn',
  'MEMORY replacement requires the expected version observed by a read in this file turn',
  'Requested model identity is invalid',
]);

function approvedFileTurnPublicMessageV1(message: string): string {
  if (approvedFileTurnPublicMessagesV1.has(message)) return message;
  if (/^File model provider timed out after [1-9][0-9]{0,6}ms$/.test(message)) {
    return message;
  }
  if (/^File model provider request failed with HTTP [1-5][0-9]{2}$/.test(message)) {
    return message;
  }
  if (/^File model provider response exceeds [1-9][0-9]{0,8} bytes$/.test(message)) {
    return message;
  }
  return 'File turn failed';
}

/** @internal Fixed runtime-authored failures that are safe to expose publicly. */
export class InternalFileTurnPublicErrorV1 extends Error {
  constructor(message: string) {
    super(approvedFileTurnPublicMessageV1(message));
    this.name = 'FileTurnErrorV1';
  }
}

/** @internal Converts schema failures at model/host boundaries to fixed text. */
export function parseExternalFileTurnValueV1<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  publicMessage: string,
): z.infer<Schema> {
  let parsed: z.SafeParseReturnType<unknown, z.infer<Schema>>;
  try {
    parsed = schema.safeParse(value);
  } catch {
    throw new InternalFileTurnPublicErrorV1(publicMessage);
  }
  if (!parsed.success) throw new InternalFileTurnPublicErrorV1(publicMessage);
  return parsed.data;
}

/** @internal Shared by the file-turn wrapper and its concrete adapter only. */
export class InternalFileTurnDeadlineV1 {
  private readonly controller = new AbortController();
  private readonly absoluteDeadlineAtMs: number;
  private readonly deadlineFailure: Error;
  private readonly timer: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    timeoutMs: number,
    private readonly publicMessage = 'File turn runtime deadline exceeded',
  ) {
    this.absoluteDeadlineAtMs = Date.now() + timeoutMs;
    this.deadlineFailure = new InternalFileTurnPublicErrorV1(publicMessage);
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get deadlineAtMs(): number {
    return this.absoluteDeadlineAtMs;
  }

  remainingMs(): number {
    const remaining = this.absoluteDeadlineAtMs - Date.now();
    if (this.controller.signal.aborted || remaining <= 0) {
      throw this.error();
    }
    return remaining;
  }

  ownsFailure(error: unknown): boolean {
    return error === this.deadlineFailure;
  }

  settle<T>(
    operation: PromiseLike<T>,
    discardLateValue?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    const observed = Promise.resolve(operation);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (continuation: () => void) => {
        if (settled) return false;
        settled = true;
        this.controller.signal.removeEventListener('abort', onAbort);
        continuation();
        return true;
      };
      const onAbort = () => {
        finish(() => reject(this.error()));
      };

      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      observed.then(
        value => {
          if (finish(() => resolve(value))) return;
          if (discardLateValue) {
            try {
              void Promise.resolve(discardLateValue(value)).catch(() => {});
            } catch {
              // Late-result disposal is best-effort and never reopens a turn.
            }
          }
        },
        error => {
          finish(() => reject(error));
          // The rejection callback intentionally observes late failures too.
        },
      );
      if (this.controller.signal.aborted) onAbort();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
  }

  private error(): Error {
    return this.deadlineFailure;
  }
}

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
  const parsed = parseExternalFileTurnValueV1(
    fileTurnInputV1Schema,
    input,
    'File turn input is invalid',
  );
  let harness: FreshFileHarnessV1;
  try {
    harness = factory();
  } catch {
    throw new InternalFileTurnPublicErrorV1('File harness creation failed');
  }
  const deadline = new InternalFileTurnDeadlineV1(parsed.deadlineMs);
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
    return parseExternalFileTurnValueV1(
      fileTurnDecisionV1Schema,
      await deadline.settle(harness.step(parsed)),
      'File harness returned an invalid turn decision',
    );
  } catch (error) {
    turnFailure = error instanceof InternalFileTurnPublicErrorV1
      ? error
      : new InternalFileTurnPublicErrorV1('File harness step failed');
    throw turnFailure;
  } finally {
    try {
      let finalization: Promise<void>;
      try {
        finalization = Promise.resolve(harness.finalize());
      } catch (error) {
        finalization = Promise.reject(error);
      }
      await deadline.settle(finalization);
    } catch (finalizeFailure) {
      if (turnFailure === undefined) {
        throw finalizeFailure instanceof InternalFileTurnPublicErrorV1
          ? finalizeFailure
          : new InternalFileTurnPublicErrorV1('File harness finalization failed');
      }
    } finally {
      deadline.close();
    }
  }
}
