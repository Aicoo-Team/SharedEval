import { createHash, randomUUID } from 'node:crypto';
import { constants, linkSync, renameSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  PACT_PAIR_METRIC_NAMES_V1,
  pactPairMetricContributionsV1,
} from '../../suites/pact-pair/evaluation.js';
import { toPublicEvaluation } from '../../suites/pact-pair/environment.js';
import { MAX_AGENT_WORKSPACE_FILE_BYTES_V1 } from './agent-workspace.js';
import {
  assertMonotonicFileMemoryRowsV1,
  deriveFileMemoryTerminalStatusV1,
  parseFileMemoryV1,
  type FileMemoryRowV1,
} from './file-memory.js';
import {
  assertFileWorkflowFinalCardinalityV1,
  fileWorkflowCheckpointV1Schema,
  fileWorkflowContactAuthorityV1Schema,
  fileWorkflowFinalFilesV1Schema,
  fileWorkflowHeartbeatPayloadV1Schema,
  fileWorkflowMemoryAuthorityV1Schema,
  fileWorkflowPublicEventV1Schema,
  fileWorkflowPublicEvaluationRecordV1Schema,
  fileWorkflowPublicResultV1Schema,
  fileWorkflowRunBindingV1Schema,
  fileWorkflowRunManifestV1Schema,
  fileWorkflowSummaryV1Schema,
  type FileWorkflowHeartbeatPayloadV1,
  type FileWorkflowContactAuthorityV1,
  type FileWorkflowFinalFilesV1,
  type FileWorkflowMemoryAuthorityV1,
  type FileWorkflowPublicEvaluationRecordV1,
  type FileWorkflowPublicResultV1,
  type FileWorkflowRunBindingV1,
} from './file-workflow-artifacts.js';

export const FILE_WORKFLOW_INTERNAL_DIRECTORY_V1 = '.sharedeval-file-workflow' as const;
const RECORD_DIRECTORY = 'records';
const STAGING_DIRECTORY = 'staging';
const WRITER_CLAIMS_DIRECTORY = 'writer-claims';
const BINDING_FILE = 'binding.json';
const FINAL_FILE = 'final.json';
const MAX_LEDGER_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_ARTIFACT_BYTES = 32 * 1024 * 1024;
const recordNamePattern = /^record-([0-9]{12})\.json$/;
const writerClaimNamePattern = /^claim-([0-9]{12})\.json$/;
const stageNamePattern = /^stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const immutableAuthorityStageNamePattern = /^immutable-authority-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const fileWorkflowLedgerRecordV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-heartbeat-record/v1'),
  sequence: z.number().int().safe().nonnegative(),
  bindingDigest: sha256Schema,
  previousRecordDigest: sha256Schema.nullable(),
  payload: fileWorkflowHeartbeatPayloadV1Schema,
  recordDigest: sha256Schema,
}).strict();

export type FileWorkflowLedgerRecordV1 = z.infer<typeof fileWorkflowLedgerRecordV1Schema>;

const bindingEnvelopeSchema = z.object({
  apiVersion: z.literal('sharedeval-file-ledger-binding/v1'),
  bindingDigest: sha256Schema,
  retainPrivate: z.boolean(),
  binding: fileWorkflowRunBindingV1Schema,
}).strict();

const finalAuthoritySchema = z.object({
  apiVersion: z.literal('sharedeval-file-final-authority/v1'),
  bindingDigest: sha256Schema,
  stopReason: z.enum(['all_terminal', 'tick_exhausted', 'fatal_error']),
  recordCount: z.number().int().safe().nonnegative(),
  lastRecordDigest: sha256Schema.nullable(),
  finalFiles: fileWorkflowFinalFilesV1Schema,
  authorityDigest: sha256Schema,
}).strict();

const writerClaimSchema = z.object({
  apiVersion: z.literal('sharedeval-file-writer-claim/v1'),
  sequence: z.number().int().safe().nonnegative(),
  kind: z.enum(['acquire', 'release']),
  token: z.string().uuid(),
  pid: z.number().int().safe().positive(),
  previousClaimDigest: sha256Schema.nullable(),
  claimDigest: sha256Schema,
}).strict();

type WriterClaim = z.infer<typeof writerClaimSchema>;

type PublicArtifactName =
  | 'run.json'
  | 'events.jsonl'
  | 'results.jsonl'
  | 'summary.json'
  | 'checkpoint.json';

export type FileWorkflowLedgerFaultInjectionV1 = Readonly<{
  beforePublicArtifactForTest?: (name: PublicArtifactName) => void | Promise<void>;
  beforeWriterClaimPublicationForTest?: (
    kind: WriterClaim['kind'],
  ) => void | Promise<void>;
  afterWriterClaimPublicationForTest?: (
    kind: WriterClaim['kind'],
  ) => void | Promise<void>;
  afterPublicArtifactStageForTest?: (
    name: PublicArtifactName,
  ) => void | Promise<void>;
  beforeImmutableAuthorityPublicationForTest?: (
    name: 'binding.json' | 'final.json',
  ) => void | Promise<void>;
}>;

export type OpenFileWorkflowLedgerV1Options = Readonly<{
  runDirectory: string;
  binding: FileWorkflowRunBindingV1;
  retainPrivate: boolean;
  faults?: FileWorkflowLedgerFaultInjectionV1;
}>;

export type FileWorkflowCommitResultV1 = Readonly<{
  outcome: 'committed' | 'replayed';
  record: FileWorkflowLedgerRecordV1;
}>;

export interface FileWorkflowLedgerV1 {
  commitHeartbeat(payload: FileWorkflowHeartbeatPayloadV1): Promise<FileWorkflowCommitResultV1>;
  readRecords(): Promise<readonly FileWorkflowLedgerRecordV1[]>;
  repairPublicProjections(): Promise<void>;
  finalize(input: {
    stopReason: 'all_terminal' | 'tick_exhausted' | 'fatal_error';
    finalFiles: FileWorkflowFinalFilesV1;
  }): Promise<void>;
  close(): Promise<void>;
}

export async function openFileWorkflowLedgerV1(
  options: OpenFileWorkflowLedgerV1Options,
): Promise<FileWorkflowLedgerV1> {
  const binding = fileWorkflowRunBindingV1Schema.parse(options.binding);
  await ensureRunDirectory(options.runDirectory);
  await assertPublicLanePaths(options.runDirectory);
  await rejectForeignPublicRun(options.runDirectory, binding);
  const internalDirectory = await ensureChildDirectory(
    options.runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
  );
  const recordsDirectory = await ensureChildDirectory(internalDirectory, RECORD_DIRECTORY);
  const stagingDirectory = await ensureChildDirectory(internalDirectory, STAGING_DIRECTORY);
  const writerClaimsDirectory = await ensureChildDirectory(
    internalDirectory,
    WRITER_CLAIMS_DIRECTORY,
  );
  const lock = await acquireWriterLock({
    internalDirectory,
    writerClaimsDirectory,
    faults: options.faults,
  });
  try {
    const bindingDigest = digestCanonical(binding);
    await cleanupTornImmutableAuthorityStages(internalDirectory);
    await establishBinding({
      internalDirectory,
      binding,
      bindingDigest,
      retainPrivate: options.retainPrivate,
      faults: options.faults,
    });
    await cleanupTornStages(stagingDirectory);
    const records = await scanRecords({
      recordsDirectory,
      binding,
      bindingDigest,
      retainPrivate: options.retainPrivate,
    });
    const final = await readFinalAuthority(internalDirectory, bindingDigest);
    assertFinalMatchesRecords(final, records);
    if (final) assertFinalFilesBinding(records, binding, final.finalFiles);
    return new FileWorkflowLedgerImpl({
      runDirectory: options.runDirectory,
      internalDirectory,
      recordsDirectory,
      stagingDirectory,
      binding,
      bindingDigest,
      retainPrivate: options.retainPrivate,
      faults: options.faults,
      assertWriterOwned: lock.assertOwned,
      releaseLock: lock.release,
    });
  } catch (error) {
    await lock.release().catch(() => {});
    throw error;
  }
}

class FileWorkflowLedgerImpl implements FileWorkflowLedgerV1 {
  private closed = false;
  private closing = false;
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: {
    runDirectory: string;
    internalDirectory: string;
    recordsDirectory: string;
    stagingDirectory: string;
    binding: FileWorkflowRunBindingV1;
    bindingDigest: string;
    retainPrivate: boolean;
    faults?: FileWorkflowLedgerFaultInjectionV1;
    assertWriterOwned: () => Promise<void>;
    releaseLock: () => Promise<void>;
  }) {}

  commitHeartbeat(
    input: FileWorkflowHeartbeatPayloadV1,
  ): Promise<FileWorkflowCommitResultV1> {
    return this.enqueue(() => this.commitHeartbeatInternal(input));
  }

  readRecords(): Promise<readonly FileWorkflowLedgerRecordV1[]> {
    return this.enqueue(() => this.readRecordsInternal());
  }

  repairPublicProjections(): Promise<void> {
    return this.enqueue(() => this.repairPublicProjectionsInternal());
  }

  finalize(input: {
    stopReason: 'all_terminal' | 'tick_exhausted' | 'fatal_error';
    finalFiles: FileWorkflowFinalFilesV1;
  }): Promise<void> {
    return this.enqueue(() => this.finalizeInternal(input));
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const closing = this.operationTail
      .then(() => this.options.releaseLock())
      .then(() => {
        this.closed = true;
        this.closing = false;
        this.closePromise = undefined;
      }, error => {
        this.closing = false;
        this.closePromise = undefined;
        throw error;
      });
    this.closePromise = closing;
    this.operationTail = closing.then(() => undefined, () => undefined);
    return closing;
  }

  private async commitHeartbeatInternal(
    input: FileWorkflowHeartbeatPayloadV1,
  ): Promise<FileWorkflowCommitResultV1> {
    await this.options.assertWriterOwned();
    if (await readFinalAuthority(this.options.internalDirectory, this.options.bindingDigest)) {
      throw new Error('Completed file-workflow ledger cannot accept another heartbeat');
    }
    const parsed = fileWorkflowHeartbeatPayloadV1Schema.parse(input);
    if (parsed.privateEvidenceDigest && !parsed.privateEvidence) {
      throw new Error('Caller cannot supply a private evidence digest without source bytes');
    }
    if (
      parsed.privateEvidenceDigest
      && parsed.privateEvidence
      && parsed.privateEvidenceDigest !== digestCanonical(parsed.privateEvidence)
    ) {
      throw new Error('Caller private evidence digest conflicts with its source bytes');
    }
    validatePrivateEvidenceBinding(parsed, this.options.binding, {
      allowStrippedPrivateEvidence: false,
    });
    const contactAuthority = buildContactAuthority(parsed, this.options.binding);
    const memoryAuthority = buildMemoryAuthority(parsed, this.options.binding);
    if (
      parsed.contactAuthority
      && canonicalJson(parsed.contactAuthority) !== canonicalJson(contactAuthority)
    ) {
      throw new Error('Heartbeat contact authority conflicts with its private evidence');
    }
    if (
      parsed.memoryAuthority
      && canonicalJson(parsed.memoryAuthority) !== canonicalJson(memoryAuthority)
    ) {
      throw new Error('Heartbeat MEMORY authority conflicts with its private source bytes');
    }
    if (!memoryAuthority && parsed.memoryAuthority) {
      throw new Error('Heartbeat cannot inject MEMORY authority without a committed CAS');
    }
    const withDerivedAuthority = {
      ...parsed,
      ...(contactAuthority ? { contactAuthority } : {}),
      ...(memoryAuthority ? { memoryAuthority } : {}),
    };
    const privateEvidenceDigest = withDerivedAuthority.privateEvidence
      ? digestCanonical(withDerivedAuthority.privateEvidence)
      : withDerivedAuthority.privateEvidenceDigest;
    const normalized = fileWorkflowHeartbeatPayloadV1Schema.parse({
      ...withDerivedAuthority,
      ...(privateEvidenceDigest ? { privateEvidenceDigest } : {}),
    });
    validatePayloadBinding(normalized, this.options.binding, {
      allowStrippedContactAuthority: false,
      allowStrippedPrivateEvidence: false,
    });
    const payload = this.options.retainPrivate
      ? structuredClone(normalized)
      : stripPrivateEvidence(normalized);
    assertRetentionConsistency(payload, this.options.retainPrivate);
    const records = await scanRecords(this.options);
    const eventRecord = records.find(record => record.payload.event.eventId === payload.event.eventId);
    if (eventRecord) {
      if (canonicalJson(eventRecord.payload) !== canonicalJson(payload)) {
        throw new Error('Conflicting replay for committed heartbeat event authority');
      }
      await this.repairPublicProjectionsInternal();
      return { outcome: 'replayed', record: structuredClone(eventRecord) };
    }

    const existingByTask = terminalAuthorityByTask(records);
    for (const transition of payload.transitions) {
      const existing = existingByTask.get(transition.taskId);
      if (existing) {
        throw new Error(
          `Conflicting immutable terminal authority for ${transition.taskId}; `
          + 'only an identical heartbeat event may replay',
        );
      }
    }

    assertContactAuthorityHistory(
      [...records.map(record => record.payload), payload],
      this.options.binding,
    );
    assertNextHeartbeatLinearity(records, payload, this.options.binding);

    const sequence = records.length;
    const previousRecordDigest = records.at(-1)?.recordDigest ?? null;
    const recordWithoutDigest = {
      apiVersion: 'sharedeval-file-heartbeat-record/v1' as const,
      sequence,
      bindingDigest: this.options.bindingDigest,
      previousRecordDigest,
      payload,
    };
    const record = fileWorkflowLedgerRecordV1Schema.parse({
      ...recordWithoutDigest,
      recordDigest: digestCanonical(recordDigestMaterial(recordWithoutDigest)),
    });
    await this.options.assertWriterOwned();
    await publishRecordNoReplace({
      recordsDirectory: this.options.recordsDirectory,
      stagingDirectory: this.options.stagingDirectory,
      record,
    });
    await this.repairPublicProjectionsInternal();
    return { outcome: 'committed', record: structuredClone(record) };
  }

  private async readRecordsInternal(): Promise<readonly FileWorkflowLedgerRecordV1[]> {
    return structuredClone(await scanRecords(this.options));
  }

  private async repairPublicProjectionsInternal(): Promise<void> {
    await this.options.assertWriterOwned();
    const records = await scanRecords(this.options);
    const final = await readFinalAuthority(
      this.options.internalDirectory,
      this.options.bindingDigest,
    );
    assertFinalMatchesRecords(final, records);
    await publishPublicProjections({
      runDirectory: this.options.runDirectory,
      internalDirectory: this.options.internalDirectory,
      binding: this.options.binding,
      records,
      final,
      faults: this.options.faults,
      assertWriterOwned: this.options.assertWriterOwned,
    });
  }

  private async finalizeInternal(input: {
    stopReason: 'all_terminal' | 'tick_exhausted' | 'fatal_error';
    finalFiles: FileWorkflowFinalFilesV1;
  }): Promise<void> {
    await this.options.assertWriterOwned();
    const records = await scanRecords(this.options);
    const { results, evaluations } = terminalProjections(this.options.binding, records);
    assertFileWorkflowFinalCardinalityV1({
      selectedTaskIds: this.options.binding.selectedTaskIds,
      results,
      evaluations,
    });
    assertStopReasonMatchesResults(input.stopReason, results);
    const finalFiles = fileWorkflowFinalFilesV1Schema.parse(input.finalFiles);
    assertFinalFilesBinding(records, this.options.binding, finalFiles);
    const authorityWithoutDigest = {
      apiVersion: 'sharedeval-file-final-authority/v1',
      bindingDigest: this.options.bindingDigest,
      stopReason: input.stopReason,
      recordCount: records.length,
      lastRecordDigest: records.at(-1)?.recordDigest ?? null,
      finalFiles,
    } as const;
    const authority = finalAuthoritySchema.parse({
      ...authorityWithoutDigest,
      authorityDigest: digestCanonical(authorityWithoutDigest),
    });
    await this.options.assertWriterOwned();
    await establishImmutableJson(
      join(this.options.internalDirectory, FINAL_FILE),
      authority,
      finalAuthoritySchema,
      'final authority',
      this.options.faults,
    );
    await this.repairPublicProjectionsInternal();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) {
      return Promise.reject(new Error('File-workflow ledger is closed'));
    }
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validatePayloadBinding(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
  options: {
    allowStrippedContactAuthority: boolean;
    allowStrippedPrivateEvidence: boolean;
  } = {
    allowStrippedContactAuthority: false,
    allowStrippedPrivateEvidence: false,
  },
): void {
  if (payload.event.runId !== binding.runId) {
    throw new Error('Heartbeat record carries a foreign run binding');
  }
  if (payload.event.actorId !== binding.actors.requester.actorId) {
    throw new Error('Heartbeat record carries a foreign actor binding');
  }
  if (
    canonicalJson(payload.provider.requester)
      !== canonicalJson(binding.actors.requester.model)
    || (
      payload.provider.responder !== undefined
      && canonicalJson(payload.provider.responder)
        !== canonicalJson(binding.actors.responder.model)
    )
  ) {
    throw new Error('Heartbeat record carries foreign provider/model provenance');
  }
  const actorIds = new Set([
    binding.actors.requester.actorId,
    binding.actors.responder.actorId,
  ]);
  for (const receipt of payload.fileReads) {
    if (!actorIds.has(receipt.actorId)) {
      throw new Error('File-read receipt carries a foreign actor binding');
    }
    const actor = receipt.actorId === binding.actors.requester.actorId
      ? binding.actors.requester
      : binding.actors.responder;
    if (receipt.path !== 'MEMORY.md') {
      const expected = actor.initial[receipt.path];
      if (
        receipt.sha256 !== expected.sha256
        || receipt.byteLength !== expected.byteLength
      ) {
        throw new Error(`File-read receipt for ${receipt.path} conflicts with its run binding`);
      }
    }
  }
  if (
    payload.memoryTransition
    && payload.memoryTransition.actorId !== binding.actors.requester.actorId
  ) {
    throw new Error('MEMORY transition carries a foreign actor binding');
  }
  if ((payload.memoryTransition !== undefined) !== (payload.memoryAuthority !== undefined)) {
    throw new Error('MEMORY transition requires one derived sanitized MEMORY authority');
  }
  if (payload.memoryTransition && payload.memoryAuthority) {
    const transition = payload.memoryTransition;
    const authority = payload.memoryAuthority;
    if (
      authority.actorId !== transition.actorId
      || authority.previousVersion !== transition.previousVersion
      || authority.newVersion !== transition.newVersion
      || authority.previousSha256 !== transition.previousSha256
      || authority.newSha256 !== transition.newSha256
      || authority.previousRows.length !== binding.selectedTaskIds.length
      || authority.newRows.length !== binding.selectedTaskIds.length
      || authority.previousRows.some((row, index) => (
        row.taskId !== binding.selectedTaskIds[index]
        || authority.newRows[index]?.taskId !== row.taskId
      ))
    ) {
      throw new Error('Sanitized MEMORY authority conflicts with its CAS or run task binding');
    }
    assertMonotonicFileMemoryRowsV1(
      authority.previousRows.map(row => ({ ...row, note: '' })),
      authority.newRows.map(row => ({ ...row, note: '' })),
    );
  }
  if (payload.selectedTaskId && !binding.selectedTaskIds.includes(payload.selectedTaskId)) {
    throw new Error('Heartbeat selected task is outside the bound task set');
  }
  const selectedTasks = new Map(binding.selectedTasks.map(task => [task.taskId, task.kind]));
  const contactAuthority = payload.contactAuthority;
  if (contactAuthority) {
    if (
      contactAuthority.kind !== selectedTasks.get(contactAuthority.taskId)
      || contactAuthority.senderId !== binding.actors.requester.actorId
      || contactAuthority.recipientId !== binding.actors.responder.actorId
      || contactAuthority.eventId !== payload.event.eventId
      || contactAuthority.taskId !== payload.selectedTaskId
      || contactAuthority.contactId !== payload.correlatedContactId
    ) {
      throw new Error('Heartbeat contact authority carries foreign task/actor/event provenance');
    }
    if (
      !options.allowStrippedContactAuthority
      && payload.privateEvidence?.contactRequests.length !== 1
    ) {
      throw new Error('New contact authority requires its private contact evidence');
    }
    if (payload.usage.contactCalls !== 1) {
      throw new Error('One authoritative contact requires exactly one aggregate contact call');
    }
    assertCompleteContactReadCoverage(
      payload.fileReads,
      binding.actors.requester.actorId,
      'requester',
    );
    if (contactAuthority.status === 'completed' || contactAuthority.status === 'denied') {
      if (!payload.provider.responder) {
        throw new Error('Completed or denied contact authority requires responder provider provenance');
      }
      assertCompleteContactReadCoverage(
        payload.fileReads,
        binding.actors.responder.actorId,
        'responder',
      );
    }
  }
  for (const transition of payload.transitions) {
    if (!binding.selectedTaskIds.includes(transition.taskId)) {
      throw new Error('Terminal transition is outside the bound task set');
    }
    if (
      transition.result.workflowId !== binding.workflowId
      || transition.evaluation.workflowId !== binding.workflowId
      || transition.result.runId !== binding.runId
      || transition.evaluation.runId !== binding.runId
      || transition.result.sessionId !== payload.event.sessionId
      || transition.evaluation.sessionId !== payload.event.sessionId
      || transition.result.selectedTaskDigest !== binding.selectedTaskDigest
      || canonicalJson(transition.result.backend) !== canonicalJson(binding.backend)
      || transition.result.terminalTick !== payload.event.tick
      || transition.result.kind !== selectedTasks.get(transition.taskId)
    ) {
      throw new Error('Terminal transition carries foreign workflow/run/session provenance');
    }
  }
  validatePrivateEvidenceBinding(payload, binding, {
    allowStrippedPrivateEvidence: options.allowStrippedPrivateEvidence,
  });
  if (payload.privateEvidence?.memory) {
    const expected = buildMemoryAuthority(payload, binding);
    if (
      !expected
      || !payload.memoryAuthority
      || canonicalJson(payload.memoryAuthority) !== canonicalJson(expected)
    ) {
      throw new Error('Heartbeat MEMORY authority does not derive from its private source bytes');
    }
  }
  if (payload.privateEvidence?.contactRequests.length === 1) {
    const expected = buildContactAuthority(payload, binding);
    if (!contactAuthority || canonicalJson(contactAuthority) !== canonicalJson(expected)) {
      throw new Error('Heartbeat contact authority does not match its private contact/snapshot');
    }
  }
}

function validatePrivateEvidenceBinding(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
  options: { allowStrippedPrivateEvidence: boolean },
): void {
  const evidence = payload.privateEvidence;
  if (!evidence) {
    if (
      !options.allowStrippedPrivateEvidence
      && (
        payload.memoryTransition
        || payload.transitions.some(transition => transition.result.publicEvaluation !== null)
      )
    ) {
      throw new Error('A MEMORY CAS or scored terminal transition requires private source evidence');
    }
    return;
  }
  const selected = new Set(binding.selectedTaskIds);
  const assertUniqueSelectedTasks = (
    label: string,
    rows: readonly { taskId: string }[],
  ) => {
    const taskIds = rows.map(row => row.taskId);
    if (
      new Set(taskIds).size !== taskIds.length
      || taskIds.some(taskId => !selected.has(taskId))
    ) {
      throw new Error(`Private ${label} evidence has duplicate or foreign task binding`);
    }
  };
  assertUniqueSelectedTasks('contact', evidence.contactRequests);
  assertUniqueSelectedTasks('action snapshot', evidence.actionSnapshots);
  assertUniqueSelectedTasks('evaluation', evidence.fullEvaluations);
  if (evidence.contactRequests.length > 1) {
    throw new Error('Private heartbeat evidence may carry only one authoritative contact');
  }
  if (payload.memoryTransition && !evidence.memory) {
    throw new Error('A committed MEMORY CAS requires its private before/after source bytes');
  }
  const selectedKinds = new Map(binding.selectedTasks.map(task => [task.taskId, task.kind]));
  for (const contact of evidence.contactRequests) {
    if (
      contact.senderId !== binding.actors.requester.actorId
      || contact.recipientId !== binding.actors.responder.actorId
      || contact.purpose !== contact.taskId
      || contact.taskId !== payload.selectedTaskId
      || contact.recipientTraceId !== payload.correlatedContactId
      || contact.requestTraceId !== payload.event.traceId
    ) {
      throw new Error('Private contact evidence carries foreign actor/task provenance');
    }
    const snapshots = evidence.actionSnapshots.filter(snapshot => (
      snapshot.taskId === contact.taskId
    ));
    const kind = selectedKinds.get(contact.taskId);
    if (kind === 'action' && snapshots.length !== 1) {
      throw new Error('Private contacted action requires exactly one authoritative snapshot pair');
    }
    if (kind === 'qa' && snapshots.length !== 0) {
      throw new Error('Private QA contact cannot carry an action snapshot');
    }
    const snapshot = snapshots[0];
    if (snapshot && (
      snapshot.contactId !== contact.recipientTraceId
      || snapshot.actorId !== binding.actors.responder.actorId
      || snapshot.eventId !== payload.event.eventId
    )) {
      throw new Error('Private action snapshot carries foreign contact/actor/event provenance');
    }
  }
  const contacts = new Map(evidence.contactRequests.map(contact => [contact.taskId, contact]));
  const transitions = new Map(payload.transitions.map(transition => [
    transition.taskId,
    transition,
  ]));
  for (const snapshot of evidence.actionSnapshots) {
    const contact = contacts.get(snapshot.taskId);
    if (!contact || selectedKinds.get(snapshot.taskId) !== 'action') {
      throw new Error('Private action snapshot is not bound to its own action contact');
    }
  }
  for (const evaluation of evidence.fullEvaluations) {
    const transition = transitions.get(evaluation.taskId);
    if (!transition) {
      throw new Error('Private evaluation is not bound to a terminal task transition');
    }
    const fullEvaluation = evaluation.evaluation as Parameters<typeof toPublicEvaluation>[0];
    const expectedPublic = toPublicEvaluation(fullEvaluation);
    if (
      evaluation.evaluation.kind !== transition.result.kind
      || canonicalJson(expectedPublic) !== canonicalJson(transition.result.publicEvaluation)
      || canonicalJson(expectedPublic) !== canonicalJson(transition.evaluation.publicEvaluation)
    ) {
      throw new Error('Private evaluation does not derive its public task projection');
    }
    const expectedMetrics = pactPairMetricContributionsV1(fullEvaluation).map(metric => (
      transition.result.status === 'side_effect_before_failure'
        && metric.metric !== 'actionSafety'
        ? { ...metric, numerator: 0, denominator: 0 }
        : metric
    ));
    if (
      canonicalJson(evaluation.metrics) !== canonicalJson(expectedMetrics)
      || canonicalJson(transition.evaluation.metrics) !== canonicalJson(expectedMetrics)
    ) {
      throw new Error('Private evaluation metrics do not derive their public task metrics');
    }
  }
  for (const transition of payload.transitions) {
    const matches = evidence.fullEvaluations.filter(row => row.taskId === transition.taskId);
    if ((transition.result.publicEvaluation !== null ? 1 : 0) !== matches.length) {
      throw new Error('Scored terminal transitions require exactly one matching full evaluation');
    }
  }
  if (
    evidence.memory
    && evidence.memory.actorId !== binding.actors.requester.actorId
  ) {
    throw new Error('Private MEMORY evidence carries a foreign actor binding');
  }
  if (evidence.memory) {
    const transition = payload.memoryTransition;
    if (!transition) {
      throw new Error('Private MEMORY evidence requires a committed MEMORY transition');
    }
    const previous = decodeCanonicalBase64(
      evidence.memory.previousBytesBase64,
      'previous private MEMORY',
    );
    const next = decodeCanonicalBase64(
      evidence.memory.newBytesBase64,
      'new private MEMORY',
    );
    if (
      previous.byteLength > MAX_AGENT_WORKSPACE_FILE_BYTES_V1
      || next.byteLength > MAX_AGENT_WORKSPACE_FILE_BYTES_V1
    ) {
      throw new Error('Private MEMORY bytes exceed the workspace file limit');
    }
    const previousText = decodeStrictUtf8(previous, 'previous private MEMORY');
    const nextText = decodeStrictUtf8(next, 'new private MEMORY');
    const previousRows = parseFileMemoryV1({
      content: previousText,
      selectedTaskIds: binding.selectedTaskIds,
    });
    const nextRows = parseFileMemoryV1({
      content: nextText,
      selectedTaskIds: binding.selectedTaskIds,
    });
    assertMonotonicFileMemoryRowsV1(previousRows, nextRows);
    if (
      sha256Bytes(previous) !== transition.previousSha256
      || sha256Bytes(next) !== transition.newSha256
      || next.byteLength !== transition.byteLength
    ) {
      throw new Error('Private MEMORY bytes do not match the committed transition hashes');
    }
  }
}

function buildContactAuthority(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
): FileWorkflowContactAuthorityV1 | undefined {
  const contact = payload.privateEvidence?.contactRequests[0];
  if (!contact || payload.privateEvidence?.contactRequests.length !== 1) return undefined;
  const kind = binding.selectedTasks.find(task => task.taskId === contact.taskId)?.kind;
  if (!kind) throw new Error('Private contact evidence is outside the selected task metadata');
  const snapshot = payload.privateEvidence.actionSnapshots.find(value => (
    value.taskId === contact.taskId
  ));
  return fileWorkflowContactAuthorityV1Schema.parse({
    taskId: contact.taskId,
    contactId: contact.recipientTraceId,
    kind,
    status: contact.status,
    ...('errorCode' in contact ? { errorCode: contact.errorCode } : {}),
    senderId: contact.senderId,
    recipientId: contact.recipientId,
    eventId: payload.event.eventId,
    ...(snapshot ? {
      actionSnapshotDigest: digestCanonical(snapshot),
      stateChanged: !isDeepStrictEqual(snapshot.before, snapshot.after),
    } : {}),
  });
}

function buildMemoryAuthority(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
): FileWorkflowMemoryAuthorityV1 | undefined {
  const transition = payload.memoryTransition;
  if (!transition) return undefined;
  const memory = payload.privateEvidence?.memory;
  if (!memory) {
    throw new Error('A committed MEMORY CAS requires its private before/after source bytes');
  }
  const previousText = decodeStrictUtf8(
    decodeCanonicalBase64(memory.previousBytesBase64, 'previous private MEMORY'),
    'previous private MEMORY',
  );
  const nextText = decodeStrictUtf8(
    decodeCanonicalBase64(memory.newBytesBase64, 'new private MEMORY'),
    'new private MEMORY',
  );
  const previousRows = parseFileMemoryV1({
    content: previousText,
    selectedTaskIds: binding.selectedTaskIds,
  });
  const newRows = parseFileMemoryV1({
    content: nextText,
    selectedTaskIds: binding.selectedTaskIds,
  });
  assertMonotonicFileMemoryRowsV1(previousRows, newRows);
  return fileWorkflowMemoryAuthorityV1Schema.parse({
    actorId: transition.actorId,
    previousVersion: transition.previousVersion,
    newVersion: transition.newVersion,
    previousSha256: transition.previousSha256,
    newSha256: transition.newSha256,
    previousRows: previousRows.map(({ taskId, status }) => ({ taskId, status })),
    newRows: newRows.map(({ taskId, status }) => ({ taskId, status })),
  });
}

function assertCompleteContactReadCoverage(
  receipts: FileWorkflowHeartbeatPayloadV1['fileReads'],
  actorId: string,
  label: 'requester' | 'responder',
): void {
  const actorReceipts = receipts.filter(receipt => receipt.actorId === actorId);
  const byVersion = new Map<number, Set<typeof actorReceipts[number]['path']>>();
  const byVersionPath = new Map<string, { sha256: string; byteLength: number }>();
  for (const receipt of actorReceipts) {
    const paths = byVersion.get(receipt.version) ?? new Set();
    paths.add(receipt.path);
    byVersion.set(receipt.version, paths);
    const key = `${receipt.version}:${receipt.path}`;
    const existing = byVersionPath.get(key);
    if (
      existing
      && (
        existing.sha256 !== receipt.sha256
        || existing.byteLength !== receipt.byteLength
      )
    ) {
      throw new Error(`${label} contact reads conflict at one workspace version cursor`);
    }
    byVersionPath.set(key, {
      sha256: receipt.sha256,
      byteLength: receipt.byteLength,
    });
  }
  const logicalPaths = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const;
  const observedPaths = new Set(actorReceipts.map(receipt => receipt.path));
  if (!logicalPaths.every(path => observedPaths.has(path))) {
    throw new Error(
      `Authoritative contact requires complete ${label} four-file read coverage`,
    );
  }
  if (label === 'responder') {
    const versions = [...byVersion.keys()].sort((left, right) => left - right);
    if (
      versions.length > 2
      || (versions.length === 2 && versions[1] !== versions[0]! + 1)
    ) {
      throw new Error('Responder contact reads contain an unbound workspace version gap');
    }
  }
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error(`${label} bytes must use canonical base64`);
  }
  return bytes;
}

function decodeStrictUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} bytes must be valid UTF-8`);
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertNextHeartbeatLinearity(
  records: readonly FileWorkflowLedgerRecordV1[],
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
): void {
  const expectedTick = records.length + 1;
  if (payload.event.tick !== expectedTick) {
    throw new Error(`Heartbeat tick history must be contiguous; expected ${expectedTick}`);
  }
  const firstSessionId = records[0]?.payload.event.sessionId;
  if (firstSessionId && payload.event.sessionId !== firstSessionId) {
    throw new Error('Heartbeat record carries a foreign session identity');
  }
  if (records.some(record => (
    record.payload.event.eventId === payload.event.eventId
    || record.payload.event.traceId === payload.event.traceId
  ))) {
    throw new Error('Heartbeat event and trace identities must be unique');
  }

  const memory = memoryCursorAfter(records, binding);
  assertMemoryTransitionFrom(payload, memory, binding.actors.requester.actorId);
}

function memoryCursorAfter(
  records: readonly FileWorkflowLedgerRecordV1[],
  binding: FileWorkflowRunBindingV1,
): { version: number; sha256: string; byteLength: number } {
  const cursor = {
    version: 0,
    sha256: binding.actors.requester.initial['MEMORY.md'].sha256,
    byteLength: binding.actors.requester.initial['MEMORY.md'].byteLength,
  };
  for (const record of records) {
    assertMemoryTransitionFrom(
      record.payload,
      cursor,
      binding.actors.requester.actorId,
    );
  }
  return cursor;
}

function assertMemoryTransitionFrom(
  payload: FileWorkflowHeartbeatPayloadV1,
  cursor: { version: number; sha256: string; byteLength: number },
  requesterActorId: string,
): void {
  const transition = payload.memoryTransition;
  const permittedVersions = new Set([
    cursor.version,
    ...(transition ? [transition.newVersion] : []),
  ]);
  if (payload.fileReads.some(receipt => (
    receipt.actorId === requesterActorId
    && receipt.path !== 'MEMORY.md'
    && !permittedVersions.has(receipt.version)
  ))) {
    throw new Error(
      'Requester immutable-file reads must use the pre- or post-CAS workspace version cursor',
    );
  }
  const reads = payload.fileReads.filter(receipt => (
    receipt.actorId === requesterActorId && receipt.path === 'MEMORY.md'
  ));
  if (!transition) {
    if (reads.some(receipt => (
      receipt.version !== cursor.version
      || receipt.sha256 !== cursor.sha256
      || receipt.byteLength !== cursor.byteLength
    ))) {
      throw new Error('Requester MEMORY read receipt breaks the committed chain');
    }
    return;
  }
  if (
    transition.actorId !== requesterActorId
    || transition.previousVersion !== cursor.version
    || transition.previousSha256 !== cursor.sha256
  ) {
    throw new Error('MEMORY CAS previous version/hash breaks the committed chain');
  }
  if (transition.newVersion !== transition.previousVersion + 1) {
    throw new Error('MEMORY CAS version must advance by exactly one');
  }
  const observedPrevious = reads.some(receipt => (
    receipt.version === transition.previousVersion
    && receipt.sha256 === transition.previousSha256
    && receipt.byteLength === cursor.byteLength
  ));
  if (!observedPrevious) {
    throw new Error('MEMORY CAS requires a matching requester read receipt');
  }
  if (reads.some(receipt => !(
    (
      receipt.version === transition.previousVersion
      && receipt.sha256 === transition.previousSha256
      && receipt.byteLength === cursor.byteLength
    )
    || (
      receipt.version === transition.newVersion
      && receipt.sha256 === transition.newSha256
      && receipt.byteLength === transition.byteLength
    )
  ))) {
    throw new Error('Requester MEMORY read receipt is outside the committed CAS transition');
  }
  cursor.version = transition.newVersion;
  cursor.sha256 = transition.newSha256;
  cursor.byteLength = transition.byteLength;
}

function assertFinalFilesBinding(
  records: readonly FileWorkflowLedgerRecordV1[],
  binding: FileWorkflowRunBindingV1,
  finalFiles: FileWorkflowFinalFilesV1,
): void {
  const readOnlyPaths = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md'] as const;
  for (const role of ['requester', 'responder'] as const) {
    for (const path of readOnlyPaths) {
      if (
        canonicalJson(finalFiles[role][path])
        !== canonicalJson(binding.actors[role].initial[path])
      ) {
        throw new Error(`Declared final ${role} ${path} conflicts with its read-only initial file`);
      }
    }
  }
  const committed = memoryCursorAfter(records, binding);
  const declared = finalFiles.requester['MEMORY.md'];
  if (
    declared.sha256 !== committed.sha256
    || declared.byteLength !== committed.byteLength
  ) {
    throw new Error('Declared final MEMORY hash/byte length does not match the ledger CAS chain');
  }
}

function stripPrivateEvidence(
  payload: FileWorkflowHeartbeatPayloadV1,
): FileWorkflowHeartbeatPayloadV1 {
  const { privateEvidence: _private, ...publiclyCommitted } = payload;
  return structuredClone(publiclyCommitted);
}

function terminalAuthorityByTask(
  records: readonly FileWorkflowLedgerRecordV1[],
): Map<string, FileWorkflowLedgerRecordV1> {
  const authorities = new Map<string, FileWorkflowLedgerRecordV1>();
  for (const record of records) {
    for (const transition of record.payload.transitions) {
      if (authorities.has(transition.taskId)) {
        throw new Error(`Ledger contains duplicate terminal authority for ${transition.taskId}`);
      }
      authorities.set(transition.taskId, record);
    }
  }
  return authorities;
}

async function publishRecordNoReplace(input: {
  recordsDirectory: string;
  stagingDirectory: string;
  record: FileWorkflowLedgerRecordV1;
}): Promise<void> {
  const stagePath = join(input.stagingDirectory, `stage-${randomUUID()}.json`);
  const destination = join(input.recordsDirectory, recordName(input.record.sequence));
  await writeDurablyExclusive(stagePath, `${canonicalJson(input.record)}\n`, MAX_LEDGER_RECORD_BYTES);
  try {
    linkSync(stagePath, destination);
  } catch (error) {
    await durableUnlink(stagePath);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Ledger record destination already has commit authority');
    }
    throw error;
  }
  await syncDirectory(input.recordsDirectory);
  await durableUnlink(stagePath);
}

async function scanRecords(input: {
  recordsDirectory: string;
  binding: FileWorkflowRunBindingV1;
  bindingDigest: string;
  retainPrivate: boolean;
}): Promise<FileWorkflowLedgerRecordV1[]> {
  const names = await readdir(input.recordsDirectory);
  const indexed = names.map(name => {
    const match = recordNamePattern.exec(name);
    if (!match) throw new Error(`Ledger records contain unexpected entry ${name}`);
    return { name, sequence: Number(match[1]) };
  }).sort((left, right) => left.sequence - right.sequence);
  const records: FileWorkflowLedgerRecordV1[] = [];
  for (const [index, entry] of indexed.entries()) {
    if (entry.sequence !== index || entry.name !== recordName(index)) {
      throw new Error('Ledger record history must be contiguous and canonically named');
    }
    const record = await readBoundedJsonRegular(
      join(input.recordsDirectory, entry.name),
      MAX_LEDGER_RECORD_BYTES,
      fileWorkflowLedgerRecordV1Schema,
      `ledger record ${index}`,
    );
    if (
      record.sequence !== index
      || record.bindingDigest !== input.bindingDigest
      || record.payload.event.runId !== input.binding.runId
      || record.previousRecordDigest !== (records.at(-1)?.recordDigest ?? null)
    ) {
      throw new Error(`Ledger record ${index} has foreign binding or broken digest chain`);
    }
    validatePayloadBinding(record.payload, input.binding, {
      allowStrippedContactAuthority: !input.retainPrivate,
      allowStrippedPrivateEvidence: !input.retainPrivate,
    });
    const { recordDigest: _digest, ...withoutDigest } = record;
    if (record.recordDigest !== digestCanonical(recordDigestMaterial(withoutDigest))) {
      throw new Error(`Ledger record ${index} digest does not match its committed bytes`);
    }
    if (
      record.payload.privateEvidence
      && record.payload.privateEvidenceDigest
        !== digestCanonical(record.payload.privateEvidence)
    ) {
      throw new Error(`Ledger record ${index} private evidence digest does not match its committed bytes`);
    }
    assertRetentionConsistency(record.payload, input.retainPrivate, index);
    records.push(record);
  }
  terminalAuthorityByTask(records);
  assertLedgerLinearity(records, input.binding);
  assertContactAuthorityHistory(records.map(record => record.payload), input.binding);
  return records;
}

function assertRetentionConsistency(
  payload: FileWorkflowHeartbeatPayloadV1,
  retainPrivate: boolean,
  recordIndex?: number,
): void {
  const prefix = recordIndex === undefined ? 'Heartbeat' : `Ledger record ${recordIndex}`;
  if (!retainPrivate && payload.privateEvidence) {
    throw new Error(`${prefix} contains private evidence while retention is disabled`);
  }
  if (
    retainPrivate
    && payload.privateEvidenceDigest
    && !payload.privateEvidence
  ) {
    throw new Error(`${prefix} discarded private evidence despite retention`);
  }
  if (payload.contactAuthority && !payload.privateEvidenceDigest) {
    throw new Error(`${prefix} contact authority is missing its private evidence digest`);
  }
  if (payload.memoryTransition && !payload.privateEvidenceDigest) {
    throw new Error(`${prefix} MEMORY authority is missing its validated private evidence digest`);
  }
}

function assertLedgerLinearity(
  records: readonly FileWorkflowLedgerRecordV1[],
  binding: FileWorkflowRunBindingV1,
): void {
  const eventIds = new Set<string>();
  const traceIds = new Set<string>();
  const firstSessionId = records[0]?.payload.event.sessionId;
  for (const [index, record] of records.entries()) {
    if (record.payload.event.tick !== index + 1) {
      throw new Error('Heartbeat tick history must be contiguous');
    }
    if (
      record.payload.event.sessionId !== firstSessionId
      || eventIds.has(record.payload.event.eventId)
      || traceIds.has(record.payload.event.traceId)
    ) {
      throw new Error('Heartbeat session/event/trace history is conflicting');
    }
    eventIds.add(record.payload.event.eventId);
    traceIds.add(record.payload.event.traceId);
  }
  memoryCursorAfter(records, binding);
}

function assertContactAuthorityHistory(
  payloads: readonly FileWorkflowHeartbeatPayloadV1[],
  binding: FileWorkflowRunBindingV1,
): void {
  const byTask = new Map<string, FileWorkflowContactAuthorityV1>();
  const byContact = new Map<string, FileWorkflowContactAuthorityV1>();
  const terminalTasks = new Set<string>();
  let memoryRows: readonly Pick<FileMemoryRowV1, 'taskId' | 'status'>[] =
    binding.selectedTaskIds.map(taskId => ({ taskId, status: 'pending' as const }));
  for (const payload of payloads) {
    const current = payload.contactAuthority;
    if (current) {
      if (terminalTasks.has(current.taskId)) {
        throw new Error('Contact authority cannot be appended after terminal task authority');
      }
      if (byTask.has(current.taskId) || byContact.has(current.contactId)) {
        throw new Error('Distinct duplicate or conflicting contact/snapshot authority');
      }
      byTask.set(current.taskId, current);
      byContact.set(current.contactId, current);
    }
    if (payload.memoryAuthority) {
      if (canonicalJson(payload.memoryAuthority.previousRows) !== canonicalJson(memoryRows)) {
        throw new Error('Sanitized MEMORY authority breaks the ordered task-status history');
      }
      memoryRows = payload.memoryAuthority.newRows;
    }
    if (payload.correlatedContactId) {
      const referenced = byContact.get(payload.correlatedContactId);
      if (!referenced || referenced.taskId !== payload.selectedTaskId) {
        throw new Error('Heartbeat correlated contact does not resolve to committed task authority');
      }
    }
    for (const transition of payload.transitions) {
      const authority = byTask.get(transition.taskId);
      const memoryRow = memoryRows.find(row => row.taskId === transition.taskId);
      const derivedStatus = authority && memoryRow
        ? deriveFileMemoryTerminalStatusV1({
          memoryStatus: memoryRow.status,
          contactStatus: authority.status,
          stateChanged: authority.stateChanged ?? false,
        })
        : undefined;
      if (
        (transition.result.status === 'answered' || transition.result.status === 'refused')
        && (
          memoryRow?.status === 'pending'
          || !authority
          || derivedStatus !== transition.result.status
        )
      ) {
        throw new Error('Answered/refused transition conflicts with MEMORY and contact authority');
      }
      if (
        authority
        && memoryRow?.status !== 'pending'
        && derivedStatus !== transition.result.status
      ) {
        throw new Error('Terminal transition conflicts with Task6 MEMORY/contact derivation');
      }
      if (authority) {
        if (
          transition.contactId !== authority.contactId
          || transition.result.contactStatus !== authority.status
          || transition.result.kind !== authority.kind
        ) {
          throw new Error('Terminal task does not resolve its exact committed contact/snapshot authority');
        }
        if (
          authority.errorCode
          && (
            transition.result.status === 'error'
            || transition.result.status === 'side_effect_before_failure'
          )
          && transition.result.errorCode !== authority.errorCode
        ) {
          throw new Error('Terminal contact failure code conflicts with committed contact authority');
        }
        if (authority.kind === 'action') {
          const publicEvaluation = transition.result.publicEvaluation;
          if (
            publicEvaluation?.kind === 'action'
            && publicEvaluation.stateChanged !== authority.stateChanged
          ) {
            throw new Error('Action evaluation state change conflicts with snapshot authority');
          }
          if (
            transition.result.status === 'side_effect_before_failure'
            && authority.stateChanged !== true
          ) {
            throw new Error('Side-effect failure requires changed action snapshot authority');
          }
          if (
            authority.stateChanged === true
            && (
              transition.result.status === 'error'
              || transition.result.status === 'no_response'
            )
          ) {
            throw new Error('Changed action fallback must use side_effect_before_failure authority');
          }
        }
      } else if (
        transition.contactId !== undefined
        || transition.result.contactStatus !== undefined
      ) {
        throw new Error('Terminal task cites a contact without committed authority');
      }
      terminalTasks.add(transition.taskId);
    }
  }
  for (const authority of byTask.values()) {
    if (!binding.selectedTaskIds.includes(authority.taskId)) {
      throw new Error('Contact authority is outside the selected task set');
    }
  }
}

async function publishPublicProjections(input: {
  runDirectory: string;
  internalDirectory: string;
  binding: FileWorkflowRunBindingV1;
  records: readonly FileWorkflowLedgerRecordV1[];
  final: z.infer<typeof finalAuthoritySchema> | undefined;
  faults?: FileWorkflowLedgerFaultInjectionV1;
  assertWriterOwned: () => Promise<void>;
}): Promise<void> {
  await assertPublicLanePaths(input.runDirectory);
  const { results, evaluations } = terminalProjections(input.binding, input.records);
  const status = input.final ? 'completed' as const : 'running' as const;
  if (input.final) {
    assertFileWorkflowFinalCardinalityV1({
      selectedTaskIds: input.binding.selectedTaskIds,
      results,
      evaluations,
    });
  }
  const events = input.records.map(record => fileWorkflowPublicEventV1Schema.parse({
    apiVersion: 'sharedeval-file-event/v1',
    workflowId: input.binding.workflowId,
    runId: input.binding.runId,
    sequence: record.sequence,
    eventId: record.payload.event.eventId,
    sessionId: record.payload.event.sessionId,
    tick: record.payload.event.tick,
    actorId: record.payload.event.actorId,
    traceId: record.payload.event.traceId,
    ...(record.payload.selectedTaskId
      ? { selectedTaskId: record.payload.selectedTaskId }
      : {}),
    terminalTaskIds: record.payload.transitions.map(value => value.taskId),
    fileReadCount: record.payload.fileReads.length,
    memoryCommitted: record.payload.memoryTransition !== undefined,
    usage: record.payload.usage,
  }));
  const summary = buildSummary(input.binding, input.records, results, evaluations);
  const run = fileWorkflowRunManifestV1Schema.parse({
    apiVersion: 'sharedeval-file-run/v1',
    workflowId: input.binding.workflowId,
    runId: input.binding.runId,
    status,
    ...(input.final ? { stopReason: input.final.stopReason } : {}),
    selectedTaskIds: input.binding.selectedTaskIds,
    selectedTasks: input.binding.selectedTasks,
    selectedTaskDigest: input.binding.selectedTaskDigest,
    dataset: input.binding.dataset,
    goldSet: input.binding.goldSet,
    policies: input.binding.policies,
    actors: {
      requester: {
        ...input.binding.actors.requester,
        ...(input.final ? { final: input.final.finalFiles.requester } : {}),
      },
      responder: {
        ...input.binding.actors.responder,
        ...(input.final ? { final: input.final.finalFiles.responder } : {}),
      },
    },
    backend: input.binding.backend,
    recordCount: input.records.length,
    resultRows: results.length,
    evaluationRows: evaluations.length,
  });
  const checkpoint = fileWorkflowCheckpointV1Schema.parse({
    apiVersion: 'sharedeval-file-checkpoint/v1',
    workflowId: input.binding.workflowId,
    runId: input.binding.runId,
    status,
    recordCount: input.records.length,
    selectedTasks: input.binding.selectedTaskIds.length,
    resultRows: results.length,
    evaluationRows: evaluations.length,
    lastEventId: input.records.at(-1)?.payload.event.eventId ?? null,
    lastRecordDigest: input.records.at(-1)?.recordDigest ?? null,
  });
  const artifacts: Array<[PublicArtifactName, string]> = [
    ['run.json', `${canonicalJson(run)}\n`],
    ['events.jsonl', jsonLines(events)],
    ['results.jsonl', jsonLines(results)],
    ['summary.json', `${canonicalJson(summary)}\n`],
    ['checkpoint.json', `${canonicalJson(checkpoint)}\n`],
  ];
  for (const [name, contents] of artifacts) {
    await input.assertWriterOwned();
    await input.faults?.beforePublicArtifactForTest?.(name);
    await input.assertWriterOwned();
    await atomicReplacePublicFile({
      internalDirectory: input.internalDirectory,
      destination: join(input.runDirectory, name),
      contents,
      assertWriterOwned: input.assertWriterOwned,
      afterStageForTest: input.faults?.afterPublicArtifactStageForTest
        ? () => input.faults?.afterPublicArtifactStageForTest?.(name)
        : undefined,
    });
  }
}

function terminalProjections(
  binding: FileWorkflowRunBindingV1,
  records: readonly FileWorkflowLedgerRecordV1[],
): {
  results: FileWorkflowPublicResultV1[];
  evaluations: FileWorkflowPublicEvaluationRecordV1[];
} {
  const byTask = new Map<string, {
    result: FileWorkflowPublicResultV1;
    evaluation: FileWorkflowPublicEvaluationRecordV1;
  }>();
  for (const record of records) {
    for (const transition of record.payload.transitions) {
      if (byTask.has(transition.taskId)) {
        throw new Error(`Duplicate terminal task authority for ${transition.taskId}`);
      }
      byTask.set(transition.taskId, {
        result: fileWorkflowPublicResultV1Schema.parse(transition.result),
        evaluation: fileWorkflowPublicEvaluationRecordV1Schema.parse(transition.evaluation),
      });
    }
  }
  const ordered = binding.selectedTaskIds.flatMap(taskId => {
    const value = byTask.get(taskId);
    return value ? [value] : [];
  });
  return {
    results: ordered.map(value => value.result),
    evaluations: ordered.map(value => value.evaluation),
  };
}

function assertStopReasonMatchesResults(
  stopReason: 'all_terminal' | 'tick_exhausted' | 'fatal_error',
  results: readonly FileWorkflowPublicResultV1[],
): void {
  if (
    stopReason === 'all_terminal'
    && results.some(result => result.status === 'no_response')
  ) {
    throw new Error('all_terminal cannot finalize no_response task authority');
  }
  if (
    stopReason === 'tick_exhausted'
    && !results.some(result => result.status === 'no_response')
  ) {
    throw new Error('tick_exhausted requires at least one no_response task authority');
  }
  if (
    stopReason === 'fatal_error'
    && (
      results.some(result => result.status === 'no_response')
      || !results.some(result => (
        result.status === 'error' || result.status === 'side_effect_before_failure'
      ))
    )
  ) {
    throw new Error(
      'fatal_error forbids no_response and requires at least one error or side-effect authority',
    );
  }
}

function buildSummary(
  binding: FileWorkflowRunBindingV1,
  records: readonly FileWorkflowLedgerRecordV1[],
  results: readonly FileWorkflowPublicResultV1[],
  evaluations: readonly FileWorkflowPublicEvaluationRecordV1[],
) {
  const statuses = {
    answered: 0,
    refused: 0,
    error: 0,
    no_response: 0,
    side_effect_before_failure: 0,
  };
  for (const result of results) statuses[result.status] += 1;
  const metricTotals = new Map<string, { numerator: number; denominator: number }>(
    PACT_PAIR_METRIC_NAMES_V1.map(metric => [metric, { numerator: 0, denominator: 0 }]),
  );
  for (const evaluation of evaluations) {
    for (const metric of evaluation.metrics) {
      const current = metricTotals.get(metric.metric) ?? { numerator: 0, denominator: 0 };
      current.numerator = safeAdd(current.numerator, metric.numerator);
      current.denominator = safeAdd(current.denominator, metric.denominator);
      metricTotals.set(metric.metric, current);
    }
  }
  const usage = records.reduce((total, record) => ({
    modelCalls: safeAdd(total.modelCalls, record.payload.usage.modelCalls),
    toolSteps: safeAdd(total.toolSteps, record.payload.usage.toolSteps),
    contactCalls: safeAdd(total.contactCalls, record.payload.usage.contactCalls),
    promptTokens: safeAdd(total.promptTokens, record.payload.usage.promptTokens),
    completionTokens: safeAdd(total.completionTokens, record.payload.usage.completionTokens),
    totalTokens: safeAdd(total.totalTokens, record.payload.usage.totalTokens),
    costUsd: safeAdd(total.costUsd, record.payload.usage.costUsd),
  }), {
    modelCalls: 0, toolSteps: 0, contactCalls: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0,
  });
  return fileWorkflowSummaryV1Schema.parse({
    apiVersion: 'sharedeval-file-summary/v1',
    workflowId: binding.workflowId,
    runId: binding.runId,
    selectedTasks: binding.selectedTaskIds.length,
    resultRows: results.length,
    evaluationRows: evaluations.length,
    statuses,
    metrics: PACT_PAIR_METRIC_NAMES_V1.map(metric => {
      const total = metricTotals.get(metric) ?? { numerator: 0, denominator: 0 };
      return {
        metric,
        numerator: total.numerator,
        denominator: total.denominator,
        value: total.denominator === 0 ? null : total.numerator / total.denominator,
      };
    }),
    usage,
  });
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('File-workflow aggregate usage exceeds the JSON-safe finite bound');
  }
  return value;
}

async function establishBinding(input: {
  internalDirectory: string;
  binding: FileWorkflowRunBindingV1;
  bindingDigest: string;
  retainPrivate: boolean;
  faults?: FileWorkflowLedgerFaultInjectionV1;
}): Promise<void> {
  await establishImmutableJson(
    join(input.internalDirectory, BINDING_FILE),
    {
      apiVersion: 'sharedeval-file-ledger-binding/v1',
      bindingDigest: input.bindingDigest,
      retainPrivate: input.retainPrivate,
      binding: input.binding,
    },
    bindingEnvelopeSchema,
    'file-workflow binding',
    input.faults,
  );
}

async function establishImmutableJson<Schema extends z.ZodTypeAny>(
  path: string,
  value: z.input<Schema>,
  schema: Schema,
  label: string,
  faults?: FileWorkflowLedgerFaultInjectionV1,
): Promise<void> {
  const parsed = schema.parse(value);
  const expected = `${canonicalJson(parsed)}\n`;
  const authorityDirectory = dirname(path);
  const stagePath = join(
    authorityDirectory,
    `immutable-authority-stage-${randomUUID()}.json`,
  );
  await writeDurablyExclusive(stagePath, expected, MAX_LEDGER_RECORD_BYTES);
  await syncDirectory(authorityDirectory);
  try {
    await faults?.beforeImmutableAuthorityPublicationForTest?.(
      basename(path) as 'binding.json' | 'final.json',
    );
    try {
      linkSync(stagePath, path);
      await syncDirectory(authorityDirectory);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readBoundedRegular(path, MAX_LEDGER_RECORD_BYTES, label);
    if (existing !== expected) {
      throw new Error(`${label} conflicts with existing immutable authority`);
    }
  } finally {
    await durableUnlink(stagePath);
  }
}

async function readFinalAuthority(
  internalDirectory: string,
  bindingDigest: string,
): Promise<z.infer<typeof finalAuthoritySchema> | undefined> {
  const path = join(internalDirectory, FINAL_FILE);
  if (!await pathExists(path)) return undefined;
  const authority = await readBoundedJsonRegular(
    path,
    MAX_LEDGER_RECORD_BYTES,
    finalAuthoritySchema,
    'final authority',
  );
  if (authority.bindingDigest !== bindingDigest) {
    throw new Error('Final authority carries a foreign run binding');
  }
  const { authorityDigest, ...withoutDigest } = authority;
  if (authorityDigest !== digestCanonical(withoutDigest)) {
    throw new Error('Final authority digest does not match its committed bytes');
  }
  return authority;
}

function assertFinalMatchesRecords(
  authority: z.infer<typeof finalAuthoritySchema> | undefined,
  records: readonly FileWorkflowLedgerRecordV1[],
): void {
  if (!authority) return;
  if (
    authority.recordCount !== records.length
    || authority.lastRecordDigest !== (records.at(-1)?.recordDigest ?? null)
  ) {
    throw new Error('Final authority does not match the committed ledger history');
  }
}

async function ensureRunDirectory(path: string): Promise<void> {
  if (basename(path) === '' || path === dirname(path)) {
    throw new Error('File-workflow run directory must be a concrete child path');
  }
  const parent = dirname(path);
  await assertDirectory(parent, 'run parent directory');
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertDirectory(path, 'file-workflow run directory');
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  await assertDirectory(parent, 'parent directory');
  const child = join(parent, name);
  try {
    await mkdir(child, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertDirectory(child, name);
  return child;
}

async function acquireWriterLock(input: {
  internalDirectory: string;
  writerClaimsDirectory: string;
  faults?: FileWorkflowLedgerFaultInjectionV1;
}): Promise<{
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
}> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const claims = await scanWriterClaims(input.writerClaimsDirectory);
    const latest = claims.at(-1);
    if (latest?.kind === 'acquire' && processIsAlive(latest.pid)) {
      throw new Error('File-workflow writer lock is already held');
    }
    const claim = createWriterClaim({
      sequence: claims.length,
      kind: 'acquire',
      token,
      previousClaimDigest: latest?.claimDigest ?? null,
    });
    if (!await publishWriterClaimNoReplace({
      internalDirectory: input.internalDirectory,
      writerClaimsDirectory: input.writerClaimsDirectory,
      claim,
    })) {
      continue;
    }

    const assertOwned = async () => {
      const current = (await scanWriterClaims(input.writerClaimsDirectory)).at(-1);
      if (
        current?.kind !== 'acquire'
        || current.token !== token
        || current.pid !== process.pid
      ) {
        throw new Error('File-workflow writer fencing authority changed');
      }
    };
    await assertOwned();
    let released = false;
    return {
      assertOwned,
      release: async () => {
        if (released) return;
        const currentClaims = await scanWriterClaims(input.writerClaimsDirectory);
        const current = currentClaims.at(-1);
        if (current?.kind === 'release' && current.token === token) {
          released = true;
          return;
        }
        if (current?.kind !== 'acquire' || current.token !== token) {
          throw new Error('Writer lock ownership changed before release');
        }
        const release = createWriterClaim({
          sequence: currentClaims.length,
          kind: 'release',
          token,
          previousClaimDigest: current.claimDigest,
        });
        const published = await publishWriterClaimNoReplace({
          internalDirectory: input.internalDirectory,
          writerClaimsDirectory: input.writerClaimsDirectory,
          claim: release,
          beforePublicationForTest: input.faults?.beforeWriterClaimPublicationForTest,
          afterPublicationForTest: input.faults?.afterWriterClaimPublicationForTest,
        });
        if (!published) {
          const winner = (await scanWriterClaims(input.writerClaimsDirectory)).at(-1);
          if (winner?.kind !== 'release' || winner.token !== token) {
            throw new Error('Writer release lost its no-replace authority');
          }
        }
        released = true;
      },
    };
  }
  throw new Error('File-workflow writer lock contention did not converge');
}

function createWriterClaim(input: {
  sequence: number;
  kind: WriterClaim['kind'];
  token: string;
  previousClaimDigest: string | null;
}): WriterClaim {
  const withoutDigest = {
    apiVersion: 'sharedeval-file-writer-claim/v1' as const,
    sequence: input.sequence,
    kind: input.kind,
    token: input.token,
    pid: process.pid,
    previousClaimDigest: input.previousClaimDigest,
  };
  return writerClaimSchema.parse({
    ...withoutDigest,
    claimDigest: digestCanonical(withoutDigest),
  });
}

async function publishWriterClaimNoReplace(input: {
  internalDirectory: string;
  writerClaimsDirectory: string;
  claim: WriterClaim;
  beforePublicationForTest?: (
    kind: WriterClaim['kind'],
  ) => void | Promise<void>;
  afterPublicationForTest?: (
    kind: WriterClaim['kind'],
  ) => void | Promise<void>;
}): Promise<boolean> {
  const stagePath = join(
    input.internalDirectory,
    `writer-claim-stage-${randomUUID()}.json`,
  );
  const destination = join(
    input.writerClaimsDirectory,
    writerClaimName(input.claim.sequence),
  );
  await writeDurablyExclusive(stagePath, `${canonicalJson(input.claim)}\n`, 4096);
  try {
    await input.beforePublicationForTest?.(input.claim.kind);
    try {
      linkSync(stagePath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await input.afterPublicationForTest?.(input.claim.kind);
    await syncDirectory(input.writerClaimsDirectory);
    return true;
  } finally {
    await durableUnlink(stagePath);
  }
}

async function scanWriterClaims(directory: string): Promise<WriterClaim[]> {
  const indexed = (await readdir(directory)).map(name => {
    const match = writerClaimNamePattern.exec(name);
    if (!match) throw new Error(`Writer claims contain unexpected entry ${name}`);
    return { name, sequence: Number(match[1]) };
  }).sort((left, right) => left.sequence - right.sequence);
  const claims: WriterClaim[] = [];
  for (const [index, entry] of indexed.entries()) {
    if (entry.sequence !== index || entry.name !== writerClaimName(index)) {
      throw new Error('Writer claim history must be contiguous and canonically named');
    }
    const claim = await readBoundedJsonRegular(
      join(directory, entry.name),
      4096,
      writerClaimSchema,
      `writer claim ${index}`,
    );
    const { claimDigest, ...withoutDigest } = claim;
    if (
      claim.sequence !== index
      || claim.previousClaimDigest !== (claims.at(-1)?.claimDigest ?? null)
      || claimDigest !== digestCanonical(withoutDigest)
    ) {
      throw new Error(`Writer claim ${index} has a broken digest history`);
    }
    const previous = claims.at(-1);
    if (
      claim.kind === 'release'
      && (
        previous?.kind !== 'acquire'
        || previous.token !== claim.token
        || previous.pid !== claim.pid
      )
    ) {
      throw new Error(`Writer claim ${index} is not the owner's matching release`);
    }
    claims.push(claim);
  }
  return claims;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function cleanupTornStages(stagingDirectory: string): Promise<void> {
  for (const name of await readdir(stagingDirectory)) {
    if (!stageNamePattern.test(name)) {
      throw new Error(`Ledger staging contains unexpected entry ${name}`);
    }
    const path = join(stagingDirectory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Ledger staging entries must be regular non-symlink files');
    }
    await durableUnlink(path);
  }
}

async function cleanupTornImmutableAuthorityStages(
  internalDirectory: string,
): Promise<void> {
  for (const name of await readdir(internalDirectory)) {
    if (!immutableAuthorityStageNamePattern.test(name)) continue;
    const path = join(internalDirectory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Immutable authority stages must be regular non-symlink files');
    }
    await durableUnlink(path);
  }
}

async function assertPublicLanePaths(runDirectory: string): Promise<void> {
  for (const name of [
    'run.json',
    'events.jsonl',
    'results.jsonl',
    'summary.json',
    'checkpoint.json',
    'private',
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
  ]) {
    const path = join(runDirectory, name);
    if (!await pathExists(path)) continue;
    const stat = await lstat(path);
    const directoryExpected = name === 'private' || name === FILE_WORKFLOW_INTERNAL_DIRECTORY_V1;
    if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Unsafe file-workflow lane path: ${name} must be a regular ${directoryExpected ? 'directory' : 'file'}`);
    }
    if (!directoryExpected && stat.size > MAX_PUBLIC_ARTIFACT_BYTES) {
      throw new Error(`Public artifact ${name} exceeds its byte limit`);
    }
  }
}

async function rejectForeignPublicRun(
  runDirectory: string,
  binding: FileWorkflowRunBindingV1,
): Promise<void> {
  const path = join(runDirectory, 'run.json');
  if (!await pathExists(path)) return;
  const source = await readBoundedRegular(path, MAX_PUBLIC_ARTIFACT_BYTES, 'run.json');
  let manifest: z.infer<typeof fileWorkflowRunManifestV1Schema>;
  try {
    manifest = fileWorkflowRunManifestV1Schema.parse(JSON.parse(source));
  } catch {
    throw new Error('Existing run.json is malformed and cannot enter the file-workflow lane');
  }
  const claimedBinding = {
    workflowId: manifest.workflowId,
    runId: manifest.runId,
    selectedTaskIds: manifest.selectedTaskIds,
    selectedTasks: manifest.selectedTasks,
    selectedTaskDigest: manifest.selectedTaskDigest,
    dataset: manifest.dataset,
    goldSet: manifest.goldSet,
    policies: manifest.policies,
    actors: {
      requester: manifestStartActor(manifest.actors.requester),
      responder: manifestStartActor(manifest.actors.responder),
    },
    backend: manifest.backend,
  };
  const expectedBinding = {
    workflowId: binding.workflowId,
    runId: binding.runId,
    selectedTaskIds: binding.selectedTaskIds,
    selectedTasks: binding.selectedTasks,
    selectedTaskDigest: binding.selectedTaskDigest,
    dataset: binding.dataset,
    goldSet: binding.goldSet,
    policies: binding.policies,
    actors: binding.actors,
    backend: binding.backend,
  };
  if (canonicalJson(claimedBinding) !== canonicalJson(expectedBinding)) {
    throw new Error('Existing run.json carries a foreign file-workflow run binding');
  }
}

function manifestStartActor(
  actor: z.infer<typeof fileWorkflowRunManifestV1Schema>['actors']['requester'],
) {
  return {
    actorId: actor.actorId,
    references: actor.references,
    model: actor.model,
    initial: actor.initial,
  };
}

async function atomicReplacePublicFile(input: {
  internalDirectory: string;
  destination: string;
  contents: string;
  assertWriterOwned: () => Promise<void>;
  afterStageForTest?: () => void | Promise<void>;
}): Promise<void> {
  if (Buffer.byteLength(input.contents) > MAX_PUBLIC_ARTIFACT_BYTES) {
    throw new Error('Public artifact exceeds its byte limit');
  }
  if (await pathExists(input.destination)) {
    const stat = await lstat(input.destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Public artifact destination must be a regular non-symlink file');
    }
  }
  const stage = join(input.internalDirectory, `public-${randomUUID()}.tmp`);
  try {
    await writeDurablyExclusive(stage, input.contents, MAX_PUBLIC_ARTIFACT_BYTES);
    await input.afterStageForTest?.();
    await input.assertWriterOwned();
    // Keep the final fencing check and publication in one synchronous turn.
    renameSync(stage, input.destination);
    await syncDirectory(dirname(input.destination));
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    throw error;
  }
}

async function readBoundedJsonRegular<Schema extends z.ZodTypeAny>(
  path: string,
  maximumBytes: number,
  schema: Schema,
  label: string,
): Promise<z.infer<Schema>> {
  const source = await readBoundedRegular(path, maximumBytes, label);
  try {
    return schema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`${label} is malformed`, { cause: error });
  }
}

async function readBoundedRegular(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (before.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > maximumBytes
    ) {
      throw new Error(`${label} must remain one bounded regular file`);
    }
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || bytesRead !== opened.size
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    if (handle) await handle.close();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

async function writeDurablyExclusive(
  path: string,
  contents: string,
  maximumBytes: number,
): Promise<void> {
  if (Buffer.byteLength(contents) > maximumBytes) {
    throw new Error(`Artifact exceeds ${maximumBytes} bytes`);
  }
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function recordName(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999_999_999) {
    throw new Error('Ledger record sequence is outside the safe range');
  }
  return `record-${String(sequence).padStart(12, '0')}.json`;
}

function writerClaimName(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999_999_999) {
    throw new Error('Writer claim sequence is outside the safe range');
  }
  return `claim-${String(sequence).padStart(12, '0')}.json`;
}

function jsonLines(values: readonly unknown[]): string {
  return values.length === 0 ? '' : `${values.map(canonicalJson).join('\n')}\n`;
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function recordDigestMaterial(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = structuredClone(value as Record<string, unknown>);
  const payload = record.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    delete (payload as Record<string, unknown>).privateEvidence;
  }
  return record;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
