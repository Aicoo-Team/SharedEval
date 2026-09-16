import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  fileWorkflowHeartbeatPayloadV1Schema,
  type FileWorkflowHeartbeatPayloadV1,
} from './file-workflow-artifacts.js';
import type { FileWorkflowLedgerRecordV1 } from './file-workflow-ledger.js';
import {
  fileWorkflowFailureStageV1Schema,
  type FileWorkflowFailureCodeV1,
  type FileWorkflowFailureNoticeV1,
  type FileWorkflowFailureStageV1,
} from './file-workflow-failure.js';

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
  diagnosticStatus?: 'unavailable';
  /**
   * Fixed, allowlisted description of the underlying failure, when one exists.
   * This result reaches public error surfaces, so arbitrary thrown values and
   * their properties must never be reflected here.
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
  onFailure?: (failure: FileWorkflowFailureNoticeV1) => Promise<void>;
  executionStage?: () => FileWorkflowFailureStageV1;
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

  let unparsedPayload: FileWorkflowHeartbeatPayloadV1;
  try {
    unparsedPayload = await input.execute();
  } catch (error) {
    const contextFailure = contextFailureNotice(error);
    const stage = contextFailure?.stage ?? executionStage(input.executionStage);
    const failure = contextFailure ?? {
      stage,
      code: stageFailureCode(stage),
    };
    reportUnsanitizedCause(failure.code, error);
    const diagnosticAvailable = await notifyFailure(input.onFailure, failure);
    return indeterminateFileWorkflowHeartbeatResultV1(failure.code, diagnosticAvailable);
  }

  let payload: FileWorkflowHeartbeatPayloadV1;
  try {
    payload = fileWorkflowHeartbeatPayloadV1Schema.parse(unparsedPayload);
  } catch {
    const diagnosticAvailable = await notifyFailure(input.onFailure, {
      stage: executionStage(input.executionStage),
      code: 'heartbeat_payload_invalid',
    });
    return indeterminateFileWorkflowHeartbeatResultV1(
      'heartbeat_payload_invalid',
      diagnosticAvailable,
    );
  }
  if (
    !isDeepStrictEqual(payload.event, start.event)
    || payload.inputDigest !== start.inputDigest
  ) {
    const diagnosticAvailable = await notifyFailure(input.onFailure, {
      stage: executionStage(input.executionStage),
      code: 'heartbeat_payload_identity_diverged',
    });
    return indeterminateFileWorkflowHeartbeatResultV1(
      'heartbeat_payload_identity_diverged',
      diagnosticAvailable,
    );
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
      const diagnosticAvailable = await notifyFailure(input.onFailure, {
        stage: 'ledger_commit',
        code: 'marker_authority_indeterminate',
      });
      return indeterminateFileWorkflowHeartbeatResultV1(undefined, diagnosticAvailable);
    }
    await notifyFailure(input.onFailure, {
      stage: 'ledger_commit',
      code: 'ledger_commit_failed',
    });
    throw error;
  }
}

function contextFailureNotice(error: unknown): FileWorkflowFailureNoticeV1 | undefined {
  const code = safeStringProperty(error, 'code');
  if (
    code !== 'context_budget_exhausted'
    && code !== 'context_integrity_error'
    && code !== 'context_turn_incomplete'
    && code !== 'actor_context_actor_mismatch'
  ) return undefined;
  return { stage: 'context_settlement', code };
}

function safeStringProperty(value: unknown, key: string): string | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    const field = Reflect.get(value, key);
    return typeof field === 'string' ? field : undefined;
  } catch {
    return undefined;
  }
}

function executionStage(
  readStage: (() => FileWorkflowFailureStageV1) | undefined,
): FileWorkflowFailureStageV1 {
  if (!readStage) return 'sharedos_execution';
  try {
    const parsed = fileWorkflowFailureStageV1Schema.safeParse(readStage());
    return parsed.success ? parsed.data : 'sharedos_execution';
  } catch {
    return 'sharedos_execution';
  }
}

function stageFailureCode(stage: FileWorkflowFailureStageV1): FileWorkflowFailureCodeV1 {
  switch (stage) {
    case 'sharedos_execution': return 'sharedos_execution_failed';
    case 'context_settlement': return 'context_settlement_failed';
    case 'evidence_projection': return 'evidence_projection_failed';
    case 'heartbeat_planning': return 'heartbeat_planning_failed';
    case 'ledger_commit': return 'ledger_commit_failed';
  }
}

async function notifyFailure(
  callback: ((failure: FileWorkflowFailureNoticeV1) => Promise<void>) | undefined,
  failure: FileWorkflowFailureNoticeV1,
): Promise<boolean> {
  if (!callback) return true;
  try {
    await callback(failure);
    return true;
  } catch {
    // Failure publication cannot replace the primary result; callers receive
    // only this fixed availability bit, never the callback's raw error.
    return false;
  }
}

export function indeterminateFileWorkflowHeartbeatResultV1(
  cause?: unknown,
  diagnosticAvailable = true,
): FileWorkflowHeartbeatIndeterminateResultV1 {
  return {
    kind: 'indeterminate_external_operation',
    errorCode: 'indeterminate_external_operation',
    ...(diagnosticAvailable ? {} : { diagnosticStatus: 'unavailable' as const }),
    ...(cause === undefined ? {} : { causeSummary: sanitizedCauseSummary(cause) }),
  };
}

const allowedCauseSummaries = new Set<string>([
  'sharedos_execution_failed',
  'context_settlement_failed',
  'evidence_projection_failed',
  'heartbeat_planning_failed',
  'ledger_commit_failed',
  'heartbeat_payload_invalid',
  'heartbeat_payload_identity_diverged',
  'context_budget_exhausted',
  'context_integrity_error',
  'context_turn_incomplete',
  'actor_context_actor_mismatch',
]);

/**
 * Cause summaries are sanitized to a fixed vocabulary before they reach a
 * record, which is right for the artifact and blinding while developing: the
 * stage survives and the reason does not. This writes the raw error to stderr
 * only — never to a notice, a payload, or the ledger — and only when asked.
 */
function reportUnsanitizedCause(code: string, error: unknown): void {
  if (!process.env['SHAREDEVAL_DEBUG_HEARTBEAT_CAUSE']) return;
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[heartbeat ${code}] ${detail}\n`);
}

function sanitizedCauseSummary(cause: unknown): string {
  return typeof cause === 'string' && allowedCauseSummaries.has(cause)
    ? cause
    : 'unclassified_failure';
}
