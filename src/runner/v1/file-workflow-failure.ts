import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { sha256JsonV1, type JsonValue } from '../../contracts/json.js';

const MAX_FAILURE_ARTIFACT_BYTES = 16 * 1024;

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

export const fileWorkflowFailureStageV1Schema = z.enum([
  'sharedos_execution',
  'context_settlement',
  'evidence_projection',
  'heartbeat_planning',
  'ledger_commit',
]);

export const fileWorkflowFailureCodeV1Schema = z.enum([
  'sharedos_execution_failed',
  'context_settlement_failed',
  'evidence_projection_failed',
  'heartbeat_planning_failed',
  'heartbeat_payload_invalid',
  'heartbeat_payload_identity_diverged',
  'ledger_commit_failed',
  'marker_authority_indeterminate',
  'context_budget_exhausted',
  'context_integrity_error',
  'context_turn_incomplete',
  'actor_context_actor_mismatch',
]);

export type FileWorkflowFailureStageV1 = z.infer<
  typeof fileWorkflowFailureStageV1Schema
>;
export type FileWorkflowFailureCodeV1 = z.infer<
  typeof fileWorkflowFailureCodeV1Schema
>;
export const fileWorkflowFailureNoticeV1Schema = z.object({
  stage: fileWorkflowFailureStageV1Schema,
  code: fileWorkflowFailureCodeV1Schema,
}).strict().superRefine((notice, context) => {
  if (!validFailureCodes(notice.stage).has(notice.code)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['code'],
      message: 'failure code does not match its stage',
    });
  }
});

export type FileWorkflowFailureNoticeV1 = z.infer<
  typeof fileWorkflowFailureNoticeV1Schema
>;

export const fileWorkflowFailureRecordV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-failure/v1'),
  bindingDigest: sha256Schema,
  event: eventSchema,
  inputDigest: sha256Schema,
  stage: fileWorkflowFailureStageV1Schema,
  code: fileWorkflowFailureCodeV1Schema,
  executionStatus: z.literal('indeterminate_external_operation'),
  evaluationStatus: z.literal('incomplete'),
  failureDigest: sha256Schema,
}).strict();

export const fileWorkflowExecutionStatusV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-execution-status/v1'),
  bindingDigest: sha256Schema,
  runId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  tick: z.number().int().safe().nonnegative(),
  inputDigest: sha256Schema,
  executionStatus: z.literal('indeterminate_external_operation'),
  evaluationStatus: z.literal('incomplete'),
  failureStage: fileWorkflowFailureStageV1Schema,
  failureCode: fileWorkflowFailureCodeV1Schema,
  failureRecordDigest: sha256Schema,
}).strict();

export type FileWorkflowFailureRecordV1 = z.infer<
  typeof fileWorkflowFailureRecordV1Schema
>;
export type FileWorkflowExecutionStatusV1 = z.infer<
  typeof fileWorkflowExecutionStatusV1Schema
>;

export async function writeFileWorkflowFailureV1(input: Readonly<{
  runDirectory: string;
  bindingDigest: string;
  start: Readonly<{
    event: z.infer<typeof eventSchema>;
    inputDigest: string;
  }>;
  failure: FileWorkflowFailureNoticeV1;
}>): Promise<Readonly<{
  record: FileWorkflowFailureRecordV1;
  status: FileWorkflowExecutionStatusV1;
}>> {
  if (!isAbsolute(input.runDirectory)) {
    throw new Error('Failure artifact run directory must be absolute');
  }
  const validated = z.object({
    bindingDigest: sha256Schema,
    start: z.object({ event: eventSchema, inputDigest: sha256Schema }).strict(),
    failure: fileWorkflowFailureNoticeV1Schema,
  }).strict().parse({
    bindingDigest: input.bindingDigest,
    start: input.start,
    failure: input.failure,
  });

  await requireDirectory(input.runDirectory, 'Failure artifact run directory');
  const failureDirectory = join(input.runDirectory, '.sharedeval-file-failures');
  await ensureDirectory(failureDirectory, 'Failure artifact lane');

  const recordWithoutDigest = {
    apiVersion: 'sharedeval-file-failure/v1' as const,
    bindingDigest: validated.bindingDigest,
    event: validated.start.event,
    inputDigest: validated.start.inputDigest,
    stage: validated.failure.stage,
    code: validated.failure.code,
    executionStatus: 'indeterminate_external_operation' as const,
    evaluationStatus: 'incomplete' as const,
  };
  const record = fileWorkflowFailureRecordV1Schema.parse({
    ...recordWithoutDigest,
    failureDigest: sha256JsonV1(recordWithoutDigest as unknown as JsonValue),
  });
  const status = fileWorkflowExecutionStatusV1Schema.parse({
    apiVersion: 'sharedeval-file-execution-status/v1',
    bindingDigest: record.bindingDigest,
    runId: record.event.runId,
    eventId: record.event.eventId,
    tick: record.event.tick,
    inputDigest: record.inputDigest,
    executionStatus: record.executionStatus,
    evaluationStatus: record.evaluationStatus,
    failureStage: record.stage,
    failureCode: record.code,
    failureRecordDigest: record.failureDigest,
  });

  await publishImmutableFile(
    failureDirectory,
    join(
      failureDirectory,
      `failure-${String(record.event.tick).padStart(12, '0')}.json`,
    ),
    `${canonicalJson(record)}\n`,
    'Failure record',
  );
  await publishLatestStatus(
    input.runDirectory,
    join(input.runDirectory, 'execution-status.json'),
    status,
  );

  return deepFreeze({
    record: structuredClone(record),
    status: structuredClone(status),
  });
}

export async function clearFileWorkflowFailureStatusV1(input: Readonly<{
  runDirectory: string;
  bindingDigest: string;
}>): Promise<boolean> {
  if (!isAbsolute(input.runDirectory)) {
    throw new Error('Failure status run directory must be absolute');
  }
  const bindingDigest = sha256Schema.parse(input.bindingDigest);
  await requireDirectory(input.runDirectory, 'Failure status run directory');
  const path = join(input.runDirectory, 'execution-status.json');
  const source = await readOptionalBoundedRegular(
    path,
    MAX_FAILURE_ARTIFACT_BYTES,
    'Execution status projection',
  );
  if (source === undefined) return false;
  const status = parseCanonicalStatus(source);
  if (status.bindingDigest !== bindingDigest) {
    throw new Error('Execution status projection has a foreign binding');
  }
  await unlink(path);
  await syncDirectory(input.runDirectory);
  return true;
}

function validFailureCodes(
  stage: FileWorkflowFailureStageV1,
): ReadonlySet<FileWorkflowFailureCodeV1> {
  const payloadBoundaryCodes: FileWorkflowFailureCodeV1[] = [
    'heartbeat_payload_invalid',
    'heartbeat_payload_identity_diverged',
  ];
  switch (stage) {
    case 'sharedos_execution':
      return new Set(['sharedos_execution_failed', ...payloadBoundaryCodes]);
    case 'context_settlement':
      return new Set([
        'context_settlement_failed',
        'context_budget_exhausted',
        'context_integrity_error',
        'context_turn_incomplete',
        'actor_context_actor_mismatch',
        ...payloadBoundaryCodes,
      ]);
    case 'evidence_projection':
      return new Set(['evidence_projection_failed', ...payloadBoundaryCodes]);
    case 'heartbeat_planning':
      return new Set(['heartbeat_planning_failed', ...payloadBoundaryCodes]);
    case 'ledger_commit':
      return new Set(['ledger_commit_failed', 'marker_authority_indeterminate']);
  }
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  await requireDirectory(path, label);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
}

async function publishImmutableFile(
  directory: string,
  destination: string,
  contents: string,
  label: string,
): Promise<void> {
  if (await matchesExisting(destination, contents, label)) return;
  const stage = await writeStage(directory, contents);
  try {
    try {
      await link(stage, destination);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      if (!await matchesExisting(destination, contents, label)) {
        throw new Error(`${label} has conflicting immutable authority`);
      }
    }
    await syncDirectory(directory);
  } finally {
    await unlink(stage).catch(error => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
  }
}

async function publishLatestStatus(
  directory: string,
  destination: string,
  status: FileWorkflowExecutionStatusV1,
): Promise<void> {
  const contents = `${canonicalJson(status)}\n`;
  const existingSource = await readOptionalBoundedRegular(
    destination,
    MAX_FAILURE_ARTIFACT_BYTES,
    'Execution status projection',
  );
  if (existingSource !== undefined) {
    const existing = parseCanonicalStatus(existingSource);
    if (existing.bindingDigest !== status.bindingDigest) {
      throw new Error('Execution status projection has a foreign binding');
    }
    if (existing.tick > status.tick) {
      throw new Error('Execution status projection cannot move to an earlier failure');
    }
    if (existing.tick === status.tick) {
      if (existingSource !== contents) {
        throw new Error('Execution status projection has conflicting failure authority');
      }
      return;
    }
  }
  const stage = await writeStage(directory, contents);
  try {
    await rename(stage, destination);
    await syncDirectory(directory);
  } finally {
    await unlink(stage).catch(error => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
  }
}

async function writeStage(directory: string, contents: string): Promise<string> {
  if (Buffer.byteLength(contents) > MAX_FAILURE_ARTIFACT_BYTES) {
    throw new Error('Failure artifact exceeds its byte limit');
  }
  const stage = join(directory, `.failure-stage-${randomUUID()}.json`);
  const handle = await open(
    stage,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  return stage;
}

async function matchesExisting(
  path: string,
  expected: string,
  label: string,
): Promise<boolean> {
  const source = await readOptionalBoundedRegular(
    path,
    Buffer.byteLength(expected),
    label,
    Buffer.byteLength(expected),
  );
  if (source === undefined) return false;
  if (source !== expected) {
    throw new Error(`${label} has conflicting immutable authority`);
  }
  return true;
}

async function readOptionalBoundedRegular(
  path: string,
  maximumBytes: number,
  label: string,
  expectedBytes?: number,
): Promise<string | undefined> {
  try {
    return await readBoundedRegular(path, maximumBytes, label, expectedBytes);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readBoundedRegular(
  path: string,
  maximumBytes: number,
  label: string,
  expectedBytes?: number,
): Promise<string> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY
        | constants.O_NONBLOCK
        | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (hasCode(error, 'ELOOP')) {
      throw new Error(`${label} must be a regular file, not a symlink`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maximumBytes) throw new Error(`${label} exceeds its byte limit`);
    if (expectedBytes !== undefined && before.size !== expectedBytes) {
      throw new Error(`${label} has conflicting immutable authority`);
    }
    const content = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || offset !== before.size
    ) {
      throw new Error(`${label} changed during its bounded read`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true })
        .decode(content.subarray(0, offset));
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

function parseCanonicalStatus(source: string): FileWorkflowExecutionStatusV1 {
  let parsed: FileWorkflowExecutionStatusV1;
  try {
    parsed = fileWorkflowExecutionStatusV1Schema.parse(JSON.parse(source));
  } catch {
    throw new Error('Execution status projection is malformed');
  }
  if (source !== `${canonicalJson(parsed)}\n`) {
    throw new Error('Execution status projection is not canonical');
  }
  return parsed;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => (
    `${JSON.stringify(key)}:${canonicalJson(entry)}`
  )).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
