import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  fileWorkflowHeartbeatPayloadV1Schema,
  type FileWorkflowHeartbeatPayloadV1,
} from './file-workflow-artifacts.js';
import type { FileWorkflowLedgerRecordV1 } from './file-workflow-ledger.js';

const opaqueIdSchema = z.string().min(1).max(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'must be a safe opaque identifier',
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.object({
  eventId: opaqueIdSchema,
  runId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  tick: z.number().int().safe().nonnegative(),
  actorId: opaqueIdSchema,
  traceId: opaqueIdSchema,
}).strict();

export const fileWorkflowHeartbeatStartV1Schema = z.object({
  event: eventSchema,
  inputDigest: sha256Schema,
}).strict();

export const fileWorkflowHeartbeatStartMarkerV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-heartbeat-start/v1'),
  bindingDigest: sha256Schema,
  event: eventSchema,
  inputDigest: sha256Schema,
  markerDigest: sha256Schema,
}).strict();

export type FileWorkflowHeartbeatStartV1 = z.infer<
  typeof fileWorkflowHeartbeatStartV1Schema
>;

export type FileWorkflowHeartbeatStartMarkerV1 = z.infer<
  typeof fileWorkflowHeartbeatStartMarkerV1Schema
>;

export type FileWorkflowHeartbeatBeginResultV1 =
  | { kind: 'execute' }
  | { kind: 'committed'; record: FileWorkflowLedgerRecordV1 }
  | FileWorkflowHeartbeatIndeterminateResultV1;

export type FileWorkflowHeartbeatRecoveryResultV1 =
  | { kind: 'committed'; record: FileWorkflowLedgerRecordV1; replayed: boolean }
  | FileWorkflowHeartbeatIndeterminateResultV1;

type FileWorkflowHeartbeatIndeterminateResultV1 = Readonly<{
  kind: 'indeterminate_external_operation';
  errorCode: 'indeterminate_external_operation';
  /**
   * Sanitized description of the underlying failure, when one exists: an
   * internal label, or an error's constructor name plus its enumerated
   * code field. Never a raw error message — provider failures can carry
   * credential-bearing text, and this result reaches public error surfaces.
   */
  causeSummary?: string;
}>;

/**
 * The only commit failure the recovery coordinator may sanitize. It means the
 * durable start authority itself became unreadable after external work began.
 */
export class FileWorkflowHeartbeatMarkerAuthorityErrorV1 extends Error {
  constructor() {
    super('Heartbeat marker authority is indeterminate');
    this.name = 'FileWorkflowHeartbeatMarkerAuthorityErrorV1';
  }
}

export async function runFileWorkflowHeartbeatV1(input: {
  ledger: {
    beginHeartbeat(
      start: FileWorkflowHeartbeatStartV1,
    ): Promise<FileWorkflowHeartbeatBeginResultV1>;
    commitHeartbeat(payload: FileWorkflowHeartbeatPayloadV1): Promise<{
      outcome: 'committed' | 'replayed';
      record: FileWorkflowLedgerRecordV1;
    }>;
  };
  start: FileWorkflowHeartbeatStartV1;
  execute: () => Promise<FileWorkflowHeartbeatPayloadV1>;
}): Promise<FileWorkflowHeartbeatRecoveryResultV1> {
  let start: FileWorkflowHeartbeatStartV1;
  try {
    start = fileWorkflowHeartbeatStartV1Schema.parse(input.start);
  } catch {
    return indeterminateFileWorkflowHeartbeatResultV1();
  }

  const recovery = await input.ledger.beginHeartbeat(start);
  if (recovery.kind === 'committed') {
    return { kind: 'committed', record: recovery.record, replayed: true };
  }
  if (recovery.kind === 'indeterminate_external_operation') return recovery;

  let payload: FileWorkflowHeartbeatPayloadV1;
  try {
    payload = fileWorkflowHeartbeatPayloadV1Schema.parse(await input.execute());
    if (
      !isDeepStrictEqual(payload.event, start.event)
      || payload.inputDigest !== start.inputDigest
    ) {
      return indeterminateFileWorkflowHeartbeatResultV1('heartbeat_payload_identity_diverged');
    }
  } catch (error) {
    return indeterminateFileWorkflowHeartbeatResultV1(error);
  }

  try {
    const committed = await input.ledger.commitHeartbeat(payload);
    return {
      kind: 'committed',
      record: committed.record,
      replayed: committed.outcome === 'replayed',
    };
  } catch (error) {
    if (error instanceof FileWorkflowHeartbeatMarkerAuthorityErrorV1) {
      return indeterminateFileWorkflowHeartbeatResultV1();
    }
    throw error;
  }
}

export function indeterminateFileWorkflowHeartbeatResultV1(
  cause?: unknown,
): FileWorkflowHeartbeatIndeterminateResultV1 {
  return {
    kind: 'indeterminate_external_operation',
    errorCode: 'indeterminate_external_operation',
    ...(cause === undefined ? {} : { causeSummary: sanitizedCauseSummary(cause) }),
  };
}

/**
 * Reduce a failure to leak-safe identity: an internal string label passes
 * through, an Error contributes its constructor name plus any enumerated
 * `code`/`errorCode` field, everything else only its type. Raw messages are
 * deliberately dropped — they can carry provider credentials.
 */
function sanitizedCauseSummary(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) {
    const coded = cause as Error & { code?: unknown; errorCode?: unknown };
    const code = typeof coded.code === 'string'
      ? coded.code
      : typeof coded.errorCode === 'string'
        ? coded.errorCode
        : undefined;
    return code ? `${cause.name}:${code}` : cause.name;
  }
  return typeof cause;
}
