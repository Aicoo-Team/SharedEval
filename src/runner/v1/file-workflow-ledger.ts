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
import { toPublicEvaluation } from '../../suites/pact-pair/public-evaluation.js';
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
  fileWorkflowFinalFilesV1Schema,
  fileWorkflowHeartbeatPayloadV1Schema,
  fileWorkflowPublicEventV1Schema,
  fileWorkflowPublicTickV1Schema,
  fileWorkflowPublicEvaluationRecordV1Schema,
  fileWorkflowPublicResultV1Schema,
  fileWorkflowRunBindingV1Schema,
  fileWorkflowRunManifestV1Schema,
  fileWorkflowQuarantinePayloadV1Schema,
  fileWorkflowSummaryV1Schema,
  isFileWorkflowQuarantinePayloadV1,
  zeroFileWorkflowUsageV1,
  type FileWorkflowHeartbeatPayloadV1,
  type FileWorkflowContactAuthorityV1,
  type FileWorkflowFinalFilesV1,
  type FileWorkflowLedgerPayloadV1,
  type FileWorkflowMemoryAuthorityV1,
  type FileWorkflowPublicEvaluationRecordV1,
  type FileWorkflowPublicResultV1,
  type FileWorkflowQuarantinePayloadV1,
  type FileWorkflowRunBindingV1,
} from './file-workflow-artifacts.js';
import {
  projectFileWorkflowRetainedSharedOsEvidenceV1,
  type FileWorkflowSharedOsProjectionV1,
} from './file-workflow-sharedos-evidence.js';
import {
  FileWorkflowHeartbeatMarkerAuthorityErrorV1,
  fileWorkflowHeartbeatStartMarkerV1Schema,
  fileWorkflowHeartbeatStartV1Schema,
  indeterminateFileWorkflowHeartbeatResultV1,
  type FileWorkflowHeartbeatBeginResultV1,
  type FileWorkflowHeartbeatStartMarkerV1,
  type FileWorkflowHeartbeatStartV1,
} from './file-workflow-recovery.js';

export const FILE_WORKFLOW_INTERNAL_DIRECTORY_V1 = '.sharedeval-file-workflow' as const;
const RECORD_DIRECTORY = 'records';
const STAGING_DIRECTORY = 'staging';
const WRITER_CLAIMS_DIRECTORY = 'writer-claims';
const HEARTBEAT_STARTS_DIRECTORY = 'heartbeat-starts';
const BINDING_FILE = 'binding.json';
const FINAL_FILE = 'final.json';
// Two actors may each retain a full 1 MiB before/after committed MEMORY receipt.
const MAX_LEDGER_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_ARTIFACT_BYTES = 32 * 1024 * 1024;
const recordNamePattern = /^record-([0-9]{12})\.json$/;
const writerClaimNamePattern = /^claim-([0-9]{12})\.json$/;
const heartbeatStartNamePattern = /^start-([0-9]{12})\.json$/;
const heartbeatStartStageNamePattern = /^start-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const stageNamePattern = /^stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const immutableAuthorityStageNamePattern = /^immutable-authority-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const fileWorkflowLedgerPayloadV1Schema = z.union([
  fileWorkflowHeartbeatPayloadV1Schema,
  fileWorkflowQuarantinePayloadV1Schema,
]);

const fileWorkflowLedgerRecordV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-heartbeat-record/v1'),
  sequence: z.number().int().safe().nonnegative(),
  bindingDigest: sha256Schema,
  previousRecordDigest: sha256Schema.nullable(),
  payload: fileWorkflowLedgerPayloadV1Schema,
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
  | 'ticks.jsonl'
  | 'results.jsonl'
  | 'summary.json'
  | 'checkpoint.json';

export type FileWorkflowLedgerFaultInjectionV1 = Readonly<{
  beforeHeartbeatStartLinkForTest?: (input: Readonly<{
    stagePath: string;
    destination: string;
  }>) => void | Promise<void>;
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

export type FileWorkflowLedgerRecoveryInspectionV1 =
  | Readonly<{ kind: 'clear' }>
  | ReturnType<typeof indeterminateFileWorkflowHeartbeatResultV1>;

export interface FileWorkflowLedgerV1 {
  inspectRecovery(): Promise<FileWorkflowLedgerRecoveryInspectionV1>;
  beginHeartbeat(start: FileWorkflowHeartbeatStartV1): Promise<FileWorkflowHeartbeatBeginResultV1>;
  commitHeartbeat(payload: FileWorkflowHeartbeatPayloadV1): Promise<FileWorkflowCommitResultV1>;
  /**
   * Resolve the one unresolved heartbeat start marker into a committed
   * quarantine record: every remaining selected task is sealed as a typed
   * 'error'/'INDETERMINATE_EXTERNAL_OPERATION' terminal with fatal_error stop
   * authority, and the marker's tick is never re-executed. Refuses (throws)
   * when no marker is unresolved, when the ledger already stopped or
   * finalized, or when a remaining task carries committed changed-action
   * contact authority (that proven side effect must not be relabeled).
   */
  commitQuarantine(): Promise<FileWorkflowCommitResultV1>;
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
  const heartbeatStartsDirectory = await ensureChildDirectory(
    internalDirectory,
    HEARTBEAT_STARTS_DIRECTORY,
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
      heartbeatStartsDirectory,
      binding,
      bindingDigest,
      retainPrivate: options.retainPrivate,
      faults: options.faults,
      assertWriterOwned: lock.assertOwned,
      releaseLock: lock.release,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await lock.release();
    } catch (releaseError) {
      failures.push(releaseError);
    }
    throw combinedFailure(
      failures,
      'File-workflow ledger open failed and writer cleanup also failed',
    );
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
    heartbeatStartsDirectory: string;
    binding: FileWorkflowRunBindingV1;
    bindingDigest: string;
    retainPrivate: boolean;
    faults?: FileWorkflowLedgerFaultInjectionV1;
    assertWriterOwned: () => Promise<void>;
    releaseLock: () => Promise<void>;
  }) {}

  inspectRecovery(): Promise<FileWorkflowLedgerRecoveryInspectionV1> {
    return this.enqueue(() => this.inspectRecoveryInternal());
  }

  beginHeartbeat(
    start: FileWorkflowHeartbeatStartV1,
  ): Promise<FileWorkflowHeartbeatBeginResultV1> {
    return this.enqueue(() => this.beginHeartbeatInternal(start));
  }

  commitHeartbeat(
    input: FileWorkflowHeartbeatPayloadV1,
  ): Promise<FileWorkflowCommitResultV1> {
    return this.enqueue(() => this.commitHeartbeatInternal(input));
  }

  commitQuarantine(): Promise<FileWorkflowCommitResultV1> {
    return this.enqueue(() => this.commitQuarantineInternal());
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

  private async beginHeartbeatInternal(
    input: FileWorkflowHeartbeatStartV1,
  ): Promise<FileWorkflowHeartbeatBeginResultV1> {
    const start = fileWorkflowHeartbeatStartV1Schema.parse(input);
    await this.options.assertWriterOwned();
    const records = await scanRecords(this.options);
    const final = await readFinalAuthority(
      this.options.internalDirectory,
      this.options.bindingDigest,
    );
    assertFinalMatchesRecords(final, records);
    if (final) assertFinalFilesBinding(records, this.options.binding, final.finalFiles);

    await cleanupHeartbeatStartStages(this.options.heartbeatStartsDirectory);
    let markers: FileWorkflowHeartbeatStartMarkerV1[];
    try {
      markers = await scanHeartbeatStarts({
        heartbeatStartsDirectory: this.options.heartbeatStartsDirectory,
        binding: this.options.binding,
        bindingDigest: this.options.bindingDigest,
      });
    } catch (error) {
      if (error instanceof FileWorkflowHeartbeatMarkerAuthorityErrorV1) {
        return indeterminateFileWorkflowHeartbeatResultV1();
      }
      throw error;
    }
    assertHeartbeatStartHistory(markers, records);

    const marker = markers.find(value => value.event.tick === start.event.tick);
    const committed = records.find(value => value.payload.event.tick === start.event.tick);
    if (committed) {
      if (!marker) {
        throw new Error('Committed heartbeat is missing its required start marker');
      }
      assertExactHeartbeatIdentity({
        expectedEvent: committed.payload.event,
        expectedInputDigest: committed.payload.inputDigest,
        actualEvent: start.event,
        actualInputDigest: start.inputDigest,
        label: 'Committed heartbeat replay',
      });
      assertExactHeartbeatIdentity({
        expectedEvent: marker.event,
        expectedInputDigest: marker.inputDigest,
        actualEvent: start.event,
        actualInputDigest: start.inputDigest,
        label: 'Committed heartbeat marker',
      });
      await this.repairPublicProjectionsInternal();
      return { kind: 'committed', record: structuredClone(committed) };
    }

    if (final) {
      throw new Error('Completed file-workflow ledger cannot begin another heartbeat');
    }
    if (records.at(-1)?.payload.sessionStopReason) {
      throw new Error('Stopped file-workflow ledger cannot begin another heartbeat');
    }
    if (marker) {
      assertExactHeartbeatIdentity({
        expectedEvent: marker.event,
        expectedInputDigest: marker.inputDigest,
        actualEvent: start.event,
        actualInputDigest: start.inputDigest,
        label: 'Started heartbeat replay',
      });
      return indeterminateFileWorkflowHeartbeatResultV1();
    }
    if (markers.length !== records.length) {
      throw new Error('A prior started heartbeat remains unresolved');
    }
    if (records.some(record => (
      record.payload.event.eventId === start.event.eventId
      || record.payload.event.traceId === start.event.traceId
    )) || markers.some(value => (
      value.event.eventId === start.event.eventId
      || value.event.traceId === start.event.traceId
    ))) {
      throw new Error('Heartbeat event and trace identities must be unique');
    }

    const expectedTick = records.length + 1;
    if (
      start.event.runId !== this.options.binding.runId
      || start.event.actorId !== this.options.binding.actors.requester.actorId
      || start.event.tick !== expectedTick
      || start.event.tick > this.options.binding.scheduler.maxTicks
      || start.event.sessionId !== this.options.binding.scheduler.sessionId
    ) {
      throw new Error('Heartbeat start identity conflicts with the bound run history');
    }

    const withoutDigest = {
      apiVersion: 'sharedeval-file-heartbeat-start/v1' as const,
      bindingDigest: this.options.bindingDigest,
      event: start.event,
      inputDigest: start.inputDigest,
    };
    const markerAuthority = fileWorkflowHeartbeatStartMarkerV1Schema.parse({
      ...withoutDigest,
      markerDigest: digestCanonical(withoutDigest),
    });
    await this.options.assertWriterOwned();
    await publishHeartbeatStart({
      heartbeatStartsDirectory: this.options.heartbeatStartsDirectory,
      authority: markerAuthority,
      assertWriterOwned: this.options.assertWriterOwned,
      beforeLinkForTest: this.options.faults?.beforeHeartbeatStartLinkForTest,
    });
    return { kind: 'execute' };
  }

  private async inspectRecoveryInternal(): Promise<FileWorkflowLedgerRecoveryInspectionV1> {
    await this.options.assertWriterOwned();
    const records = await scanRecords(this.options);
    const final = await readFinalAuthority(
      this.options.internalDirectory,
      this.options.bindingDigest,
    );
    assertFinalMatchesRecords(final, records);
    if (final) assertFinalFilesBinding(records, this.options.binding, final.finalFiles);
    await cleanupHeartbeatStartStages(this.options.heartbeatStartsDirectory);
    let markers: FileWorkflowHeartbeatStartMarkerV1[];
    try {
      markers = await scanHeartbeatStarts({
        heartbeatStartsDirectory: this.options.heartbeatStartsDirectory,
        binding: this.options.binding,
        bindingDigest: this.options.bindingDigest,
      });
    } catch (error) {
      if (error instanceof FileWorkflowHeartbeatMarkerAuthorityErrorV1) {
        return indeterminateFileWorkflowHeartbeatResultV1();
      }
      throw error;
    }
    assertHeartbeatStartHistory(markers, records);
    return markers.length === records.length
      ? { kind: 'clear' }
      : indeterminateFileWorkflowHeartbeatResultV1();
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
    if (!parsed.privateEvidence) {
      throw new Error('A new heartbeat requires native SharedOS source evidence');
    }
    const projection = projectPayloadSharedOsEvidence(parsed, this.options.binding);
    const derived = projectionPayloadFields(projection);
    assertCallerProjectionsMatchNativeEvidence(parsed, projection);
    const withDerivedAuthority = { ...parsed, ...derived };
    const privateEvidenceDigest = digestCanonical(parsed.privateEvidence);
    const normalized = fileWorkflowHeartbeatPayloadV1Schema.parse({
      ...withDerivedAuthority,
      ...(privateEvidenceDigest ? { privateEvidenceDigest } : {}),
    });
    validatePayloadBinding(normalized, this.options.binding, {
      allowStrippedPrivateEvidence: false,
      projection,
    });
    const payload = this.options.retainPrivate
      ? structuredClone(normalized)
      : stripPrivateEvidence(normalized);
    assertRetentionConsistency(payload, this.options.retainPrivate);
    await cleanupHeartbeatStartStages(this.options.heartbeatStartsDirectory);
    const markers = await scanHeartbeatStarts({
      heartbeatStartsDirectory: this.options.heartbeatStartsDirectory,
      binding: this.options.binding,
      bindingDigest: this.options.bindingDigest,
    });
    const marker = markers.find(value => value.event.tick === payload.event.tick);
    if (!marker) {
      throw new Error('Heartbeat commit requires an existing start marker');
    }
    assertExactHeartbeatIdentity({
      expectedEvent: marker.event,
      expectedInputDigest: marker.inputDigest,
      actualEvent: payload.event,
      actualInputDigest: payload.inputDigest,
      label: 'Heartbeat commit',
    });
    const records = await scanRecords(this.options);
    assertHeartbeatStartHistory(markers, records);
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
    assertStopBoundary([...records.map(record => record.payload), payload], this.options.binding);

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

  private async commitQuarantineInternal(): Promise<FileWorkflowCommitResultV1> {
    await this.options.assertWriterOwned();
    if (await readFinalAuthority(this.options.internalDirectory, this.options.bindingDigest)) {
      throw new Error('Completed file-workflow ledger cannot quarantine a heartbeat');
    }
    const records = await scanRecords(this.options);
    if (records.at(-1)?.payload.sessionStopReason) {
      throw new Error('Stopped file-workflow ledger cannot quarantine a heartbeat');
    }
    await cleanupHeartbeatStartStages(this.options.heartbeatStartsDirectory);
    const markers = await scanHeartbeatStarts({
      heartbeatStartsDirectory: this.options.heartbeatStartsDirectory,
      binding: this.options.binding,
      bindingDigest: this.options.bindingDigest,
    });
    assertHeartbeatStartHistory(markers, records);
    const marker = markers[records.length];
    if (markers.length !== records.length + 1 || !marker) {
      throw new Error('Quarantine requires exactly one unresolved heartbeat start marker');
    }
    const binding = this.options.binding;
    const terminal = terminalAuthorityByTask(records);
    const remaining = binding.selectedTasks.filter(task => !terminal.has(task.taskId));
    if (remaining.length === 0) {
      throw new Error('Quarantine requires at least one unresolved selected task');
    }
    // Every committed contact counts, not only a task's latest: under repeat
    // contacts a later no-op retry must not hide an earlier proven change.
    const changedTaskIds = new Set(records.flatMap(record => {
      const authority = record.payload.contactAuthority;
      return authority?.stateChanged === true ? [authority.taskId] : [];
    }));
    for (const task of remaining) {
      if (changedTaskIds.has(task.taskId)) {
        // A committed contact proves this task already changed action state;
        // sealing it as a plain typed error would erase that proven side
        // effect, so this stays a loud run-level failure.
        throw new Error(
          'Quarantine cannot seal a task with committed changed-action contact authority',
        );
      }
    }
    const sessionId = binding.scheduler.sessionId;
    const payload = fileWorkflowQuarantinePayloadV1Schema.parse({
      quarantine: { errorCode: 'INDETERMINATE_EXTERNAL_OPERATION' },
      inputDigest: marker.inputDigest,
      event: structuredClone(marker.event),
      fileReads: [],
      memoryTransitions: [],
      memoryAuthorities: [],
      transitions: remaining.map(task => ({
        taskId: task.taskId,
        result: {
          apiVersion: 'sharedeval-file-result/v1',
          workflowId: binding.workflowId,
          runId: binding.runId,
          sessionId,
          taskId: task.taskId,
          kind: task.kind,
          status: 'error',
          terminalTick: marker.event.tick,
          errorCode: 'INDETERMINATE_EXTERNAL_OPERATION',
          publicEvaluation: null,
          selectedTaskDigest: binding.selectedTaskDigest,
          backend: structuredClone(binding.backend),
        },
        evaluation: {
          apiVersion: 'sharedeval-file-evaluation/v1',
          workflowId: binding.workflowId,
          runId: binding.runId,
          sessionId,
          taskId: task.taskId,
          publicEvaluation: null,
          metrics: [],
        },
      })),
      sessionStopReason: 'fatal_error',
      usage: zeroFileWorkflowUsageV1(),
    });
    validateQuarantinePayloadBinding(payload, binding);
    assertStopBoundary([...records.map(record => record.payload), payload], binding);

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
    await cleanupHeartbeatStartStages(this.options.heartbeatStartsDirectory);
    const markers = await scanHeartbeatStarts({
      heartbeatStartsDirectory: this.options.heartbeatStartsDirectory,
      binding: this.options.binding,
      bindingDigest: this.options.bindingDigest,
    });
    assertHeartbeatStartHistory(markers, records);
    if (markers.length !== records.length) {
      throw new Error('Cannot finalize with an unresolved heartbeat start marker');
    }
    const { results, evaluations } = terminalProjections(this.options.binding, records);
    assertFileWorkflowFinalCardinalityV1({
      selectedTaskIds: this.options.binding.selectedTaskIds,
      results,
      evaluations,
    });
    const committedStopReason = records.at(-1)?.payload.sessionStopReason;
    if (!committedStopReason || committedStopReason !== input.stopReason) {
      throw new Error('Finalization stop reason must exactly match the last committed payload');
    }
    assertStopReasonMatchesResults(committedStopReason, results);
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

async function scanHeartbeatStarts(input: {
  heartbeatStartsDirectory: string;
  binding: FileWorkflowRunBindingV1;
  bindingDigest: string;
}): Promise<FileWorkflowHeartbeatStartMarkerV1[]> {
  const names = await readdir(input.heartbeatStartsDirectory);
  const indexed = names.map(name => {
    const match = heartbeatStartNamePattern.exec(name);
    if (!match) throw new Error(`Heartbeat starts contain unexpected entry ${name}`);
    const tick = Number(match[1]);
    if (name !== heartbeatStartName(tick)) {
      throw new Error('Heartbeat start marker must be canonically named');
    }
    return { name, tick };
  }).sort((left, right) => left.tick - right.tick);

  const markers: FileWorkflowHeartbeatStartMarkerV1[] = [];
  for (const entry of indexed) {
    try {
      const marker = await readBoundedJsonRegular(
        join(input.heartbeatStartsDirectory, entry.name),
        16 * 1024,
        fileWorkflowHeartbeatStartMarkerV1Schema,
        `heartbeat start ${entry.tick}`,
      );
      const { markerDigest, ...withoutDigest } = marker;
      if (
        marker.event.tick !== entry.tick
        || marker.bindingDigest !== input.bindingDigest
        || marker.event.runId !== input.binding.runId
        || marker.event.actorId !== input.binding.actors.requester.actorId
        || markerDigest !== digestCanonical(withoutDigest)
      ) {
        throw new Error('Heartbeat start marker has foreign or edited authority');
      }
      markers.push(marker);
    } catch {
      throw new FileWorkflowHeartbeatMarkerAuthorityErrorV1();
    }
  }
  return markers;
}

function assertHeartbeatStartHistory(
  markers: readonly FileWorkflowHeartbeatStartMarkerV1[],
  records: readonly FileWorkflowLedgerRecordV1[],
): void {
  if (markers.length < records.length || markers.length > records.length + 1) {
    throw new Error('Heartbeat start history does not match committed record authority');
  }
  const eventIds = new Set<string>();
  const traceIds = new Set<string>();
  for (const [index, marker] of markers.entries()) {
    if (marker.event.tick !== index + 1) {
      throw new Error('Heartbeat start history must be contiguous');
    }
    if (eventIds.has(marker.event.eventId) || traceIds.has(marker.event.traceId)) {
      throw new Error('Heartbeat start event and trace identities must be unique');
    }
    eventIds.add(marker.event.eventId);
    traceIds.add(marker.event.traceId);
    const record = records[index];
    if (!record) continue;
    assertExactHeartbeatIdentity({
      expectedEvent: marker.event,
      expectedInputDigest: marker.inputDigest,
      actualEvent: record.payload.event,
      actualInputDigest: record.payload.inputDigest,
      label: 'Committed heartbeat start authority',
    });
  }
}

function assertExactHeartbeatIdentity(input: {
  expectedEvent: FileWorkflowHeartbeatStartV1['event'];
  expectedInputDigest: string;
  actualEvent: FileWorkflowHeartbeatStartV1['event'];
  actualInputDigest: string;
  label: string;
}): void {
  if (
    !isDeepStrictEqual(input.expectedEvent, input.actualEvent)
    || input.expectedInputDigest !== input.actualInputDigest
  ) {
    throw new Error(`${input.label} conflicts with immutable heartbeat identity`);
  }
}

async function publishHeartbeatStart(input: {
  heartbeatStartsDirectory: string;
  authority: FileWorkflowHeartbeatStartMarkerV1;
  assertWriterOwned: () => Promise<void>;
  beforeLinkForTest?: (input: Readonly<{
    stagePath: string;
    destination: string;
  }>) => void | Promise<void>;
}): Promise<void> {
  const stage = join(
    input.heartbeatStartsDirectory,
    `start-stage-${randomUUID()}.json`,
  );
  const destination = join(
    input.heartbeatStartsDirectory,
    heartbeatStartName(input.authority.event.tick),
  );
  const contents = `${canonicalJson(input.authority)}\n`;
  await writeDurablyExclusive(stage, contents, 16 * 1024);
  await syncDirectory(input.heartbeatStartsDirectory);
  try {
    await input.assertWriterOwned();
    await input.beforeLinkForTest?.({ stagePath: stage, destination });
    try {
      linkSync(stage, destination);
      await syncDirectory(input.heartbeatStartsDirectory);
      await input.assertWriterOwned();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let existing: string;
    try {
      existing = await readBoundedRegular(
        destination,
        16 * 1024,
        'heartbeat start authority',
      );
    } catch {
      throw new FileWorkflowHeartbeatMarkerAuthorityErrorV1();
    }
    if (existing !== contents) {
      throw new Error('Heartbeat start authority conflicts with existing marker');
    }
    await input.assertWriterOwned();
  } finally {
    await durableUnlink(stage);
  }
}

async function cleanupHeartbeatStartStages(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!heartbeatStartStageNamePattern.test(name)) continue;
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Heartbeat start stages must be regular non-symlink files');
    }
    await durableUnlink(path);
  }
}

function validatePayloadBinding(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
  options: {
    allowStrippedPrivateEvidence: boolean;
    projection?: FileWorkflowSharedOsProjectionV1;
  } = {
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
    payload.event.sessionId !== binding.scheduler.sessionId
    || payload.event.tick > binding.scheduler.maxTicks
  ) {
    throw new Error('Heartbeat record carries foreign scheduler authority');
  }
  const sharedOsRunAuthority = {
    runStartedAt: payload.sharedOsAuthority.runStartedAt,
    namespaceId: payload.sharedOsAuthority.namespaceId,
    grantManifestDigest: payload.sharedOsAuthority.grantManifestDigest,
    sharedOsRevision: payload.sharedOsAuthority.sharedOsRevision,
    sharedOsRuntimeDigest: payload.sharedOsAuthority.sharedOsRuntimeDigest,
  };
  if (canonicalJson(sharedOsRunAuthority) !== canonicalJson(binding.sharedOs)) {
    throw new Error('Heartbeat record carries foreign SharedOS run authority');
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
  if (!payload.privateEvidence) {
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
  }
  const canonicalActors = [
    binding.actors.requester.actorId,
    binding.actors.responder.actorId,
  ];
  const actorOrder = new Map(canonicalActors.map((actorId, index) => [actorId, index]));
  let previousActorIndex = -1;
  for (const [index, transition] of payload.memoryTransitions.entries()) {
    const authority = payload.memoryAuthorities[index];
    const actorIndex = actorOrder.get(transition.actorId);
    if (
      actorIndex === undefined
      || actorIndex <= previousActorIndex
      || !authority
      || authority.actorId !== transition.actorId
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
    previousActorIndex = actorIndex;
    assertMonotonicFileMemoryRowsV1(
      authority.previousRows.map(row => ({ ...row, note: '' })),
      authority.newRows.map(row => ({ ...row, note: '' })),
    );
  }
  const selectedTasks = new Map(binding.selectedTasks.map(task => [task.taskId, task.kind]));
  const contactAuthority = payload.contactAuthority;
  if (contactAuthority) {
    if (
      contactAuthority.kind !== selectedTasks.get(contactAuthority.taskId)
      || contactAuthority.senderId !== binding.actors.requester.actorId
      || contactAuthority.recipientId !== binding.actors.responder.actorId
      || contactAuthority.eventId !== payload.event.eventId
    ) {
      throw new Error('Heartbeat contact authority carries foreign task/actor/event provenance');
    }
    if (payload.usage.contactCalls < 1) {
      throw new Error('Authoritative contact requires at least one requester contact call');
    }
    if (!payload.privateEvidence) {
      assertCompleteContactReadCoverage(
        payload.fileReads,
        binding.actors.requester.actorId,
        'requester',
      );
    }
    if (
      !payload.privateEvidence
      && (contactAuthority.status === 'completed' || contactAuthority.status === 'denied')
    ) {
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
  if (payload.privateEvidence) {
    const projection = options.projection ?? projectPayloadSharedOsEvidence(payload, binding);
    assertCallerProjectionsMatchNativeEvidence(payload, projection);
    validatePrivateEvaluationEvidence(payload, binding);
  } else if (!options.allowStrippedPrivateEvidence) {
    throw new Error('Heartbeat requires native SharedOS source evidence');
  }
}

function validateQuarantinePayloadBinding(
  payload: FileWorkflowQuarantinePayloadV1,
  binding: FileWorkflowRunBindingV1,
): void {
  if (payload.event.runId !== binding.runId) {
    throw new Error('Quarantine record carries a foreign run binding');
  }
  if (payload.event.actorId !== binding.actors.requester.actorId) {
    throw new Error('Quarantine record carries a foreign actor binding');
  }
  if (
    payload.event.sessionId !== binding.scheduler.sessionId
    || payload.event.tick > binding.scheduler.maxTicks
  ) {
    throw new Error('Quarantine record carries foreign scheduler authority');
  }
  const selectedTasks = new Map(binding.selectedTasks.map(task => [task.taskId, task.kind]));
  for (const transition of payload.transitions) {
    if (!selectedTasks.has(transition.taskId)) {
      throw new Error('Quarantine transition is outside the bound task set');
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
      || transition.result.kind !== selectedTasks.get(transition.taskId)
    ) {
      throw new Error('Quarantine transition carries foreign workflow/run/session provenance');
    }
  }
}

function projectPayloadSharedOsEvidence(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
): FileWorkflowSharedOsProjectionV1 {
  const evidence = payload.privateEvidence;
  if (!evidence) throw new Error('Native SharedOS source evidence is required');
  const { fullEvaluations: _fullEvaluations, ...retainedEvidence } = evidence;
  return projectFileWorkflowRetainedSharedOsEvidenceV1({
    binding,
    event: payload.event,
    retainedEvidence,
    sharedOsAuthority: payload.sharedOsAuthority,
    ...(payload.contactAuthority ? { contactAuthority: payload.contactAuthority } : {}),
  });
}

function projectionPayloadFields(
  projection: FileWorkflowSharedOsProjectionV1,
) {
  return {
    fileReads: projection.fileReads.map(row => structuredClone(row)),
    memoryTransitions: projection.memoryTransitions.map(row => structuredClone(row)),
    memoryAuthorities: projection.memoryAuthorities.map(row => structuredClone(row)),
    ...(projection.currentContact
      ? { contactAuthority: structuredClone(projection.currentContact.authority) }
      : {}),
    provider: structuredClone(projection.provider),
    usage: structuredClone(projection.usage),
    sharedOsAuthority: structuredClone(projection.sharedOsAuthority),
  };
}

function assertCallerProjectionsMatchNativeEvidence(
  payload: FileWorkflowHeartbeatPayloadV1,
  projection: FileWorkflowSharedOsProjectionV1,
): void {
  const derived = projectionPayloadFields(projection);
  for (const field of [
    'fileReads',
    'memoryTransitions',
    'memoryAuthorities',
    'provider',
    'usage',
  ] as const) {
    if (canonicalJson(payload[field]) !== canonicalJson(derived[field])) {
      throw new Error(`Heartbeat ${field} conflicts with native SharedOS source evidence`);
    }
  }
}
function validatePrivateEvaluationEvidence(
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
): void {
  const evidence = payload.privateEvidence;
  if (!evidence) return;
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
  assertUniqueSelectedTasks('action snapshot', evidence.actionSnapshots);
  assertUniqueSelectedTasks('evaluation', evidence.fullEvaluations);
  const transitions = new Map(payload.transitions.map(transition => [
    transition.taskId,
    transition,
  ]));
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

function assertNextHeartbeatLinearity(
  records: readonly FileWorkflowLedgerRecordV1[],
  payload: FileWorkflowHeartbeatPayloadV1,
  binding: FileWorkflowRunBindingV1,
): void {
  const expectedTick = records.length + 1;
  if (payload.event.tick !== expectedTick) {
    throw new Error(`Heartbeat tick history must be contiguous; expected ${expectedTick}`);
  }
  if (payload.event.sessionId !== binding.scheduler.sessionId) {
    throw new Error('Heartbeat record carries a foreign session identity');
  }
  if (records.some(record => (
    record.payload.event.eventId === payload.event.eventId
    || record.payload.event.traceId === payload.event.traceId
  ))) {
    throw new Error('Heartbeat event and trace identities must be unique');
  }

  const memory = memoryCursorsAfter(records, binding);
  assertMemoryTransitionsFrom(payload, memory, binding);
}

type FileWorkflowMemoryCursor = {
  version: number;
  sha256: string;
  byteLength: number;
};

function memoryCursorsAfter(
  records: readonly FileWorkflowLedgerRecordV1[],
  binding: FileWorkflowRunBindingV1,
): Map<string, FileWorkflowMemoryCursor> {
  const cursors = new Map<string, FileWorkflowMemoryCursor>();
  for (const role of ['requester', 'responder'] as const) {
    const actor = binding.actors[role];
    cursors.set(actor.actorId, {
      version: 0,
      sha256: actor.initial['MEMORY.md'].sha256,
      byteLength: actor.initial['MEMORY.md'].byteLength,
    });
  }
  for (const record of records) {
    assertMemoryTransitionsFrom(record.payload, cursors, binding);
  }
  return cursors;
}

function assertMemoryTransitionsFrom(
  payload: FileWorkflowLedgerPayloadV1,
  cursors: Map<string, FileWorkflowMemoryCursor>,
  binding: FileWorkflowRunBindingV1,
): void {
  for (const role of ['requester', 'responder'] as const) {
    const actorId = binding.actors[role].actorId;
    const cursor = cursors.get(actorId);
    if (!cursor) throw new Error(`Missing ${role} MEMORY cursor`);
    assertActorMemoryTransitionFrom(payload, cursor, actorId, role);
  }
}

function assertActorMemoryTransitionFrom(
  payload: FileWorkflowLedgerPayloadV1,
  cursor: FileWorkflowMemoryCursor,
  actorId: string,
  role: 'requester' | 'responder',
): void {
  // The projector owns same-turn read/CAS ordering. The ledger only pins those
  // projected versions and hashes to the durable cursor from earlier heartbeats.
  const transition = payload.memoryTransitions.find(value => value.actorId === actorId);
  const permittedVersions = new Set([
    cursor.version,
    ...(transition ? [transition.newVersion] : []),
  ]);
  if (payload.fileReads.some(receipt => (
    receipt.actorId === actorId
    && receipt.path !== 'MEMORY.md'
    && !permittedVersions.has(receipt.version)
  ))) {
    throw new Error(
      `${role} immutable-file reads must use the pre- or post-CAS workspace version cursor`,
    );
  }
  const reads = payload.fileReads.filter(receipt => (
    receipt.actorId === actorId && receipt.path === 'MEMORY.md'
  ));
  if (!transition) {
    if (reads.some(receipt => (
      receipt.version !== cursor.version
      || receipt.sha256 !== cursor.sha256
      || receipt.byteLength !== cursor.byteLength
    ))) {
      throw new Error(`${role} MEMORY read receipt breaks the committed chain`);
    }
    return;
  }
  if (
    transition.previousVersion !== cursor.version
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
    throw new Error(`MEMORY CAS requires a matching ${role} read receipt`);
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
    throw new Error(`${role} MEMORY read receipt is outside the committed CAS transition`);
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
  const committed = memoryCursorsAfter(records, binding);
  for (const role of ['requester', 'responder'] as const) {
    const actorId = binding.actors[role].actorId;
    const cursor = committed.get(actorId);
    const declared = finalFiles[role]['MEMORY.md'];
    if (
      !cursor
      || declared.sha256 !== cursor.sha256
      || declared.byteLength !== cursor.byteLength
    ) {
      throw new Error(
        `Declared final ${role} MEMORY hash/byte length does not match the ledger CAS chain`,
      );
    }
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
    if (isFileWorkflowQuarantinePayloadV1(record.payload)) {
      validateQuarantinePayloadBinding(record.payload, input.binding);
    } else {
      validatePayloadBinding(record.payload, input.binding, {
        allowStrippedPrivateEvidence: !input.retainPrivate,
      });
      assertRetentionConsistency(record.payload, input.retainPrivate, index);
    }
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
    && !payload.privateEvidence
  ) {
    throw new Error(`${prefix} discarded private evidence despite retention`);
  }
  if (!payload.privateEvidenceDigest) {
    throw new Error(`${prefix} is missing its native SharedOS evidence digest`);
  }
}

function assertLedgerLinearity(
  records: readonly FileWorkflowLedgerRecordV1[],
  binding: FileWorkflowRunBindingV1,
): void {
  const eventIds = new Set<string>();
  const traceIds = new Set<string>();
  const executionIds = new Set<string>();
  let expectedAuditSequence: number | undefined;
  for (const [index, record] of records.entries()) {
    const payload = record.payload;
    if (record.payload.event.tick !== index + 1) {
      throw new Error('Heartbeat tick history must be contiguous');
    }
    if (
      record.payload.event.sessionId !== binding.scheduler.sessionId
      || record.payload.event.tick > binding.scheduler.maxTicks
      || eventIds.has(record.payload.event.eventId)
      || traceIds.has(record.payload.event.traceId)
    ) {
      throw new Error('Heartbeat session/event/trace history is conflicting');
    }
    eventIds.add(record.payload.event.eventId);
    traceIds.add(record.payload.event.traceId);
    if (isFileWorkflowQuarantinePayloadV1(payload)) {
      // A quarantine record carries no SharedOS turn evidence: no audit
      // window, no execution identities, and only typed error transitions.
      // Its fatal stop authority makes it the final record, which the stop
      // boundary check below enforces.
      continue;
    }
    const audit = payload.sharedOsAuthority.audit;
    if (expectedAuditSequence !== undefined && audit.firstSequence !== expectedAuditSequence) {
      throw new Error('SharedOS audit windows must form one exact contiguous run history');
    }
    expectedAuditSequence = audit.lastSequence + 1;
    for (const executionId of [
      payload.sharedOsAuthority.requesterExecutionId,
      payload.sharedOsAuthority.responderExecutionId,
    ]) {
      if (!executionId) continue;
      if (executionIds.has(executionId)) {
        throw new Error('SharedOS execution identities must be unique across heartbeat history');
      }
      executionIds.add(executionId);
    }
    if (
      payload.transitions.some(transition => (
        transition.result.status === 'answered' || transition.result.status === 'refused'
      ))
      && payload.sharedOsAuthority.requesterExecutionStatus !== 'succeeded'
    ) {
      throw new Error('Answered/refused authority requires a succeeded requester execution');
    }
    if (
      payload.sharedOsAuthority.responderExecutionId
      !== payload.contactAuthority?.responderExecutionId
    ) {
      throw new Error('Responder execution authority must resolve through the exact contact');
    }
  }
  memoryCursorsAfter(records, binding);
  assertStopBoundary(records.map(record => record.payload), binding);
}

function assertContactAuthorityHistory(
  payloads: readonly FileWorkflowLedgerPayloadV1[],
  binding: FileWorkflowRunBindingV1,
): void {
  // Under the multi-turn gate byTask is latest-wins (a still-pending task may
  // be re-contacted on later ticks); changedTasks remembers every committed
  // changed-action contact so a later no-op retry cannot launder a real side
  // effect into a plain error terminal.
  const repeatContacts = binding.scheduler.multiTurn !== undefined;
  const byTask = new Map<string, FileWorkflowContactAuthorityV1>();
  const byContact = new Map<string, FileWorkflowContactAuthorityV1>();
  const changedTasks = new Set<string>();
  const terminalTasks = new Set<string>();
  const memoryRowsByActor = new Map<string, readonly Pick<FileMemoryRowV1, 'taskId' | 'status'>[]>([
    [binding.actors.requester.actorId,
      binding.selectedTaskIds.map(taskId => ({ taskId, status: 'pending' as const }))],
    [binding.actors.responder.actorId,
      binding.selectedTaskIds.map(taskId => ({ taskId, status: 'pending' as const }))],
  ]);
  for (const payload of payloads) {
    const current = payload.contactAuthority;
    if (current) {
      if (terminalTasks.has(current.taskId)) {
        throw new Error('Contact authority cannot be appended after terminal task authority');
      }
      if (
        byContact.has(current.contactId)
        || (!repeatContacts && byTask.has(current.taskId))
      ) {
        throw new Error('Distinct duplicate or conflicting contact/snapshot authority');
      }
      byTask.set(current.taskId, current);
      byContact.set(current.contactId, current);
      if (current.stateChanged === true) changedTasks.add(current.taskId);
    }
    for (const memoryAuthority of payload.memoryAuthorities) {
      const previousRows = memoryRowsByActor.get(memoryAuthority.actorId);
      if (!previousRows) {
        throw new Error('Sanitized MEMORY authority carries a foreign actor');
      }
      if (canonicalJson(memoryAuthority.previousRows) !== canonicalJson(previousRows)) {
        throw new Error('Sanitized MEMORY authority breaks the ordered task-status history');
      }
      memoryRowsByActor.set(memoryAuthority.actorId, memoryAuthority.newRows);
    }
    if (isFileWorkflowQuarantinePayloadV1(payload)) {
      // Quarantine transitions claim no contact or MEMORY derivation; they
      // only seal the remaining tasks. A remaining task with a committed
      // changed-action contact is refused at commit time instead.
      for (const transition of payload.transitions) {
        if (terminalTasks.has(transition.taskId)) {
          throw new Error('Quarantine cannot repeat committed terminal task authority');
        }
        terminalTasks.add(transition.taskId);
      }
      continue;
    }
    for (const transition of payload.transitions) {
      if (transition.contactId) {
        const referenced = byContact.get(transition.contactId);
        if (!referenced || referenced.taskId !== transition.taskId) {
          throw new Error(
            'Terminal contact does not resolve to committed task authority',
          );
        }
      }
      const authority = byTask.get(transition.taskId);
      const memoryRow = memoryRowsByActor
        .get(binding.actors.requester.actorId)
        ?.find(row => row.taskId === transition.taskId);
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
          const anyStateChanged = repeatContacts
            ? changedTasks.has(transition.taskId)
            : authority.stateChanged === true;
          if (
            transition.result.status === 'side_effect_before_failure'
            && !anyStateChanged
          ) {
            throw new Error('Side-effect failure requires changed action snapshot authority');
          }
          if (
            anyStateChanged
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

function assertStopBoundary(
  payloads: readonly FileWorkflowLedgerPayloadV1[],
  binding: FileWorkflowRunBindingV1,
): void {
  const terminalTasks = new Set<string>();
  const results: FileWorkflowPublicResultV1[] = [];
  for (const [index, payload] of payloads.entries()) {
    for (const transition of payload.transitions) {
      terminalTasks.add(transition.taskId);
      results.push(transition.result);
    }
    const complete = terminalTasks.size === binding.selectedTaskIds.length;
    if (payload.sessionStopReason !== undefined) {
      if (index !== payloads.length - 1 || !complete) {
        throw new Error(
          'Session stop authority is allowed only on the final cardinality-complete record',
        );
      }
      assertStopReasonMatchesResults(payload.sessionStopReason, results);
    } else if (complete) {
      throw new Error('The terminal cardinality-complete record requires a session stop reason');
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
    ...(record.payload.contactAuthority
      ? { selectedTaskId: record.payload.contactAuthority.taskId }
      : {}),
    terminalTaskIds: record.payload.transitions.map(value => value.taskId),
    fileReadCount: record.payload.fileReads.length,
    memoryCommitted: record.payload.memoryTransitions.length > 0,
    usage: record.payload.usage,
  }));
  const multiTurn = input.binding.scheduler.multiTurn;
  const ticks = multiTurn
    ? input.records.flatMap(record => {
      const payload = record.payload;
      if (isFileWorkflowQuarantinePayloadV1(payload)) return [];
      const authority = payload.contactAuthority;
      const reply = authority
        ? payload.privateEvidence?.sourceEvidence.acceptedMessages.find(message => (
          message.replyTo === authority.contactId
        ))
        : undefined;
      const replyPayload = reply?.payload;
      const response = replyPayload
        && typeof replyPayload === 'object'
        && !Array.isArray(replyPayload)
        && typeof (replyPayload as Record<string, unknown>).response === 'string'
        ? (replyPayload as Record<string, string>).response
        : undefined;
      const requesterMemory = payload.memoryAuthorities.find(row => (
        row.actorId === input.binding.actors.requester.actorId
      ));
      const memoryRow = authority
        ? requesterMemory?.newRows.find(row => row.taskId === authority.taskId)
        : undefined;
      const memoryReplace = payload.privateEvidence?.sourceEvidence.requesterFileOperations
        .find(operation => operation.action === 'replace' && operation.path === 'MEMORY.md');
      let memoryNote: string | undefined;
      if (authority && memoryReplace && 'newBytesBase64' in memoryReplace) {
        try {
          const rows = parseFileMemoryV1({
            content: Buffer.from(memoryReplace.newBytesBase64, 'base64').toString('utf8'),
            selectedTaskIds: input.binding.selectedTaskIds,
          });
          memoryNote = rows.find(row => row.taskId === authority.taskId)?.note;
        } catch {
          // A malformed MEMORY commit is already surfaced by the ledger's own
          // validation; the tick row simply omits the note.
        }
      }
      return [fileWorkflowPublicTickV1Schema.parse({
        apiVersion: 'sharedeval-file-tick/v1',
        workflowId: input.binding.workflowId,
        runId: input.binding.runId,
        sessionId: payload.event.sessionId,
        tick: payload.event.tick,
        phase: payload.event.tick < multiTurn.phase2StartTick ? 1 : 2,
        finalization: payload.event.tick >= multiTurn.finalizeTick,
        status: payload.sharedOsAuthority.requesterExecutionStatus === 'succeeded'
          ? 'completed'
          : 'failed',
        ...(authority
          ? {
            selectedTaskId: authority.taskId,
            contactId: authority.contactId,
            contactStatus: authority.status,
            ...(authority.errorCode ? { contactErrorCode: authority.errorCode } : {}),
          }
          : {}),
        ...(response === undefined ? {} : { response }),
        ...(memoryRow ? { memoryStatus: memoryRow.status } : {}),
        ...(memoryNote === undefined ? {} : { memoryNote }),
        terminalStatuses: payload.transitions.map(transition => ({
          taskId: transition.taskId,
          status: transition.result.status,
        })),
      })];
    })
    : undefined;
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
    ...(ticks ? [['ticks.jsonl', jsonLines(ticks)] as [PublicArtifactName, string]] : []),
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
    && !results.some(result => (
      result.status === 'no_response'
      || result.status === 'side_effect_before_failure'
    ))
  ) {
    throw new Error(
      'tick_exhausted requires at least one no_response or side-effect-before-failure authority',
    );
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
    'ticks.jsonl',
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

function heartbeatStartName(tick: number): string {
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > 999_999_999_999) {
    throw new Error('Heartbeat start tick is outside the safe range');
  }
  return `start-${String(tick).padStart(12, '0')}.json`;
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

function combinedFailure(failures: readonly unknown[], message: string): unknown {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
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
