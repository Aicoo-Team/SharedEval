import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  fileWorkflowCheckpointV1Schema,
  fileWorkflowPublicResultV1Schema,
  fileWorkflowRunManifestV1Schema,
  fileWorkflowSummaryV1Schema,
} from '../../runner/v1/file-workflow-artifacts.js';
import { FILE_WORKFLOW_INTERNAL_DIRECTORY_V1 } from '../../runner/v1/file-workflow-ledger.js';
import { deriveExperimentCellIdV1 } from './contracts.js';
import type { BoundExperimentCellV1 } from './plan.js';

export const EXPERIMENT_CELL_STATES_V1 = Object.freeze([
  'planned',
  'starting',
  'running',
  'committed',
  'indeterminate',
  'failed',
  'finalized',
] as const);

export type ExperimentCellStateV1 = (typeof EXPERIMENT_CELL_STATES_V1)[number];

// Mirrors the unexported RECORD_DIRECTORY constant in
// src/runner/v1/file-workflow-ledger.ts.
export const EXPERIMENT_LEDGER_RECORDS_DIRECTORY_V1 = 'records' as const;
const LEDGER_RECORD_SEQUENCE_WIDTH = 12;

export const RETRYABLE_PROVIDER_HTTP_STATUSES_V1 = Object.freeze([408, 409, 429] as const);

const sha256HexV1Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256 digest');
const sessionStopReasonV1Schema = z.enum([
  'all_terminal',
  'tick_exhausted',
  'fatal_error',
]);

export type ExperimentSessionStopReasonV1 = z.infer<typeof sessionStopReasonV1Schema>;

const providerRequestEvidenceV1Schema = z
  .object({
    outcome: z.enum(['success', 'invalid_response', 'provider_error']),
    httpStatus: z.number().int().safe().min(100).max(599).optional(),
    attempts: z.number().int().safe().nonnegative(),
  })
  .passthrough();

/**
 * Read-only typed projection of the runner's unexported
 * sharedeval-file-heartbeat-record/v1 ledger record shape (see
 * fileWorkflowLedgerRecordV1Schema in src/runner/v1/file-workflow-ledger.ts).
 * Only the fields the observer consumes are validated; the payload stays the
 * runner's authority and is never rewritten here.
 */
const ledgerRecordProjectionV1Schema = z
  .object({
    apiVersion: z.literal('sharedeval-file-heartbeat-record/v1'),
    sequence: z.number().int().safe().nonnegative(),
    previousRecordDigest: sha256HexV1Schema.nullable(),
    recordDigest: sha256HexV1Schema,
    payload: z
      .object({
        sessionStopReason: sessionStopReasonV1Schema.optional(),
        privateEvidence: z
          .object({
            providerTelemetry: z
              .object({
                requester: z
                  .object({
                    requests: z.array(providerRequestEvidenceV1Schema).max(512),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

type LedgerRecordProjectionV1 = z.infer<typeof ledgerRecordProjectionV1Schema>;
type FileWorkflowRunManifest = z.infer<typeof fileWorkflowRunManifestV1Schema>;
type FileWorkflowCheckpoint = z.infer<typeof fileWorkflowCheckpointV1Schema>;
type FileWorkflowSummary = z.infer<typeof fileWorkflowSummaryV1Schema>;
type FileWorkflowPublicResult = z.infer<typeof fileWorkflowPublicResultV1Schema>;

export type ExperimentProviderRequestEvidenceV1 = Readonly<{
  outcome: 'success' | 'invalid_response' | 'provider_error';
  httpStatus: number | null;
  attempts: number;
}>;

export type ExperimentFailureEvidenceV1 = Readonly<{
  sessionStopReason: ExperimentSessionStopReasonV1 | null;
  providerRequests: readonly ExperimentProviderRequestEvidenceV1[];
  /** Records already durably committed when the failure was observed. */
  durableRecordCount: number;
}>;

export type ExperimentFailureCauseV1 =
  | Readonly<{
    kind: 'model_behavior_terminal';
    reason: 'invalid_response' | 'format_denial_exhausted';
  }>
  | Readonly<{
    kind: 'infrastructure_failed';
    reason: 'retryable_provider_error' | 'container_stopped_before_durable_artifacts';
    httpStatus: number | null;
  }>
  | Readonly<{
    kind: 'indeterminate_external_operation';
    reason:
      | 'no_provider_evidence'
      | 'non_retryable_provider_error'
      | 'provider_error_after_durable_commit'
      | 'unproven_stop';
  }>;

export function isRetryableProviderHttpStatusV1(httpStatus: number | null): boolean {
  if (httpStatus === null) return false;
  return (
    (RETRYABLE_PROVIDER_HTTP_STATUSES_V1 as readonly number[]).includes(httpStatus)
    || (httpStatus >= 500 && httpStatus <= 599)
  );
}

/**
 * Evidence-based, typed, and total: every evidence value maps to exactly one
 * cause. model_behavior_terminal is experimental data and must never be
 * re-rolled; infrastructure_failed is provable only for a retryable provider
 * error before any durable commit; everything unprovable is
 * indeterminate_external_operation.
 */
export function classifyExperimentFailureV1(
  evidence: ExperimentFailureEvidenceV1,
): ExperimentFailureCauseV1 {
  const last = evidence.providerRequests.at(-1);
  if (last?.outcome === 'invalid_response') {
    return { kind: 'model_behavior_terminal', reason: 'invalid_response' };
  }
  if (last?.outcome === 'provider_error') {
    if (!isRetryableProviderHttpStatusV1(last.httpStatus)) {
      return {
        kind: 'indeterminate_external_operation',
        reason: 'non_retryable_provider_error',
      };
    }
    if (evidence.durableRecordCount > 0) {
      return {
        kind: 'indeterminate_external_operation',
        reason: 'provider_error_after_durable_commit',
      };
    }
    return {
      kind: 'infrastructure_failed',
      reason: 'retryable_provider_error',
      httpStatus: last.httpStatus,
    };
  }
  // The last request succeeded, or there are no requests at all.
  if (
    evidence.sessionStopReason === 'fatal_error'
    && evidence.providerRequests.length > 0
    && evidence.providerRequests.every(request => request.outcome === 'success')
  ) {
    // Every provider call succeeded yet the session still died: the model's
    // own output exhausted its correctable denials (e.g. MEMORY format).
    return { kind: 'model_behavior_terminal', reason: 'format_denial_exhausted' };
  }
  return {
    kind: 'indeterminate_external_operation',
    reason: evidence.providerRequests.length === 0
      ? 'no_provider_evidence'
      : 'unproven_stop',
  };
}

export type ExperimentArtifactNameV1 =
  | 'run.json'
  | 'checkpoint.json'
  | 'results.jsonl'
  | 'summary.json'
  | 'ledger-record'
  | 'cross-artifact';

export type ExperimentArtifactCorruptionReasonV1 =
  | 'unreadable'
  | 'invalid_json'
  | 'schema_violation'
  | 'foreign_run'
  | 'missing_companion_artifact'
  | 'orphan_public_artifact'
  | 'count_conflict'
  | 'status_conflict'
  | 'stop_reason_conflict'
  | 'duplicate_result_tasks'
  | 'missing_last_record'
  | 'record_chain_broken'
  | 'finalization_mismatch';

export type ExperimentArtifactCorruptionV1 = Readonly<{
  artifact: ExperimentArtifactNameV1;
  reason: ExperimentArtifactCorruptionReasonV1;
}>;

export type ExperimentContainerStateV1 =
  | 'absent'
  | 'starting'
  | 'running'
  | 'exited'
  | 'unknown';

export type ExperimentContainerProbeV1 = Readonly<{
  containerState(runId: string): Promise<ExperimentContainerStateV1>;
}>;

export type ExperimentRunArtifactFilesV1 = Readonly<{
  /** Resolves null only when the path provably does not exist. */
  readOptionalFile(filePath: string): Promise<string | null>;
}>;

export function nodeExperimentRunArtifactFilesV1(): ExperimentRunArtifactFilesV1 {
  return {
    async readOptionalFile(filePath) {
      try {
        return await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}

/**
 * A typed reference to the score/finalize commit's derived artifact for this
 * cell. The observer never guesses at score outputs: the caller hands it the
 * binding it verified, and the observer only checks that it matches the run's
 * durable ledger authority.
 */
export type ExperimentCellFinalizationEvidenceV1 = Readonly<{
  runId: string;
  sourceLastRecordDigest: string;
}>;

export type ExperimentResumeDecisionV1 =
  | Readonly<{
    eligible: true;
    /**
     * not_started: no durable rows exist and the container is provably not
     * running, so a relaunch cannot duplicate any external work.
     * durable_commit_replay: the checkpoint proves a completed durable
     * commit, so a replay is expected to add zero model calls.
     */
    kind: 'not_started' | 'durable_commit_replay';
  }>
  | Readonly<{
    eligible: false;
    kind:
      | 'in_progress'
      | 'container_state_unproven'
      | 'failed_terminal'
      | 'indeterminate'
      | 'corrupt';
  }>;

export type ExperimentCellObservationV1 = Readonly<{
  planDigest: string;
  cellId: string;
  runId: string;
  containerState: ExperimentContainerStateV1;
  state: ExperimentCellStateV1;
  /** Present exactly when state is 'failed'. */
  failureCause: ExperimentFailureCauseV1 | null;
  /** Present exactly when state is 'indeterminate' because of corrupt artifacts. */
  corruption: ExperimentArtifactCorruptionV1 | null;
  resume: ExperimentResumeDecisionV1;
}>;

export type ObserveExperimentCellV1Input = Readonly<{
  cell: BoundExperimentCellV1;
  /** The mode directory that contains run.json for this cell's run. */
  runDirectory: string;
  probe: ExperimentContainerProbeV1;
  files?: ExperimentRunArtifactFilesV1;
  finalization?: ExperimentCellFinalizationEvidenceV1 | null;
}>;

type ArtifactReading<Value> =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; value: Value }>
  | Readonly<{ kind: 'corrupt'; corruption: ExperimentArtifactCorruptionV1 }>;

function corrupt(
  artifact: ExperimentArtifactNameV1,
  reason: ExperimentArtifactCorruptionReasonV1,
): ExperimentArtifactCorruptionV1 {
  return { artifact, reason };
}

async function readJsonArtifact<Schema extends z.ZodTypeAny>(
  files: ExperimentRunArtifactFilesV1,
  filePath: string,
  artifact: ExperimentArtifactNameV1,
  schema: Schema,
): Promise<ArtifactReading<z.infer<Schema>>> {
  let raw: string | null;
  try {
    raw = await files.readOptionalFile(filePath);
  } catch {
    return { kind: 'corrupt', corruption: corrupt(artifact, 'unreadable') };
  }
  if (raw === null) return { kind: 'absent' };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'corrupt', corruption: corrupt(artifact, 'invalid_json') };
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    return { kind: 'corrupt', corruption: corrupt(artifact, 'schema_violation') };
  }
  return { kind: 'present', value: parsed.data };
}

async function readResultRows(
  files: ExperimentRunArtifactFilesV1,
  filePath: string,
): Promise<ArtifactReading<readonly FileWorkflowPublicResult[]>> {
  let raw: string | null;
  try {
    raw = await files.readOptionalFile(filePath);
  } catch {
    return { kind: 'corrupt', corruption: corrupt('results.jsonl', 'unreadable') };
  }
  if (raw === null) return { kind: 'absent' };
  const rows: FileWorkflowPublicResult[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch {
      return { kind: 'corrupt', corruption: corrupt('results.jsonl', 'invalid_json') };
    }
    const parsed = fileWorkflowPublicResultV1Schema.safeParse(parsedJson);
    if (!parsed.success) {
      return { kind: 'corrupt', corruption: corrupt('results.jsonl', 'schema_violation') };
    }
    rows.push(parsed.data);
  }
  return { kind: 'present', value: rows };
}

function ledgerRecordPath(runDirectory: string, sequence: number): string {
  return path.join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    EXPERIMENT_LEDGER_RECORDS_DIRECTORY_V1,
    `record-${String(sequence).padStart(LEDGER_RECORD_SEQUENCE_WIDTH, '0')}.json`,
  );
}

function expectedWorkflowId(
  cell: BoundExperimentCellV1,
): 'files-multi' | 'files-single' {
  return cell.cell.workflow.mode === 'multi' ? 'files-multi' : 'files-single';
}

function providerRequestsFrom(
  record: LedgerRecordProjectionV1 | null,
): readonly ExperimentProviderRequestEvidenceV1[] {
  const requests = record?.payload.privateEvidence?.providerTelemetry.requester.requests;
  if (!requests) return [];
  return requests.map(request => ({
    outcome: request.outcome,
    httpStatus: request.httpStatus ?? null,
    attempts: request.attempts,
  }));
}

type StateDecision = Readonly<{
  state: ExperimentCellStateV1;
  failureCause: ExperimentFailureCauseV1 | null;
  corruption: ExperimentArtifactCorruptionV1 | null;
  resume: ExperimentResumeDecisionV1;
}>;

function indeterminateDecision(
  corruption: ExperimentArtifactCorruptionV1 | null,
  resumeKind: 'corrupt' | 'indeterminate' | 'container_state_unproven',
): StateDecision {
  return {
    state: 'indeterminate',
    failureCause: null,
    corruption,
    resume: { eligible: false, kind: resumeKind },
  };
}

function failedDecision(
  cause: ExperimentFailureCauseV1,
  resume: ExperimentResumeDecisionV1,
): StateDecision {
  return { state: 'failed', failureCause: cause, corruption: null, resume };
}

const NOT_STARTED_RESUME: ExperimentResumeDecisionV1 = {
  eligible: true,
  kind: 'not_started',
};
const DURABLE_REPLAY_RESUME: ExperimentResumeDecisionV1 = {
  eligible: true,
  kind: 'durable_commit_replay',
};

/**
 * Read-only observer over the run's typed ledger/final authority plus an
 * injected container-state probe. It never inspects log text and never counts
 * files to guess progress: every judgement is made from validated artifacts,
 * and any malformed or conflicting artifact maps to a typed corrupt outcome
 * that fails closed into 'indeterminate'.
 */
export async function observeExperimentCellV1(
  input: ObserveExperimentCellV1Input,
): Promise<ExperimentCellObservationV1> {
  const files = input.files ?? nodeExperimentRunArtifactFilesV1();
  const { cell } = input;

  let containerState: ExperimentContainerStateV1;
  try {
    containerState = await input.probe.containerState(cell.runId);
  } catch {
    containerState = 'unknown';
  }

  const [run, checkpoint, summary, results] = await Promise.all([
    readJsonArtifact(
      files,
      path.join(input.runDirectory, 'run.json'),
      'run.json',
      fileWorkflowRunManifestV1Schema,
    ),
    readJsonArtifact(
      files,
      path.join(input.runDirectory, 'checkpoint.json'),
      'checkpoint.json',
      fileWorkflowCheckpointV1Schema,
    ),
    readJsonArtifact(
      files,
      path.join(input.runDirectory, 'summary.json'),
      'summary.json',
      fileWorkflowSummaryV1Schema,
    ),
    readResultRows(files, path.join(input.runDirectory, 'results.jsonl')),
  ]);

  const decision = await deriveState({
    cell,
    runDirectory: input.runDirectory,
    files,
    containerState,
    finalization: input.finalization ?? null,
    run,
    checkpoint,
    summary,
    results,
  });

  return {
    planDigest: cell.planDigest,
    cellId: cell.cellId,
    runId: cell.runId,
    containerState,
    state: decision.state,
    failureCause: decision.failureCause,
    corruption: decision.corruption,
    resume: decision.resume,
  };
}

async function deriveState(input: Readonly<{
  cell: BoundExperimentCellV1;
  runDirectory: string;
  files: ExperimentRunArtifactFilesV1;
  containerState: ExperimentContainerStateV1;
  finalization: ExperimentCellFinalizationEvidenceV1 | null;
  run: ArtifactReading<FileWorkflowRunManifest>;
  checkpoint: ArtifactReading<FileWorkflowCheckpoint>;
  summary: ArtifactReading<FileWorkflowSummary>;
  results: ArtifactReading<readonly FileWorkflowPublicResult[]>;
}>): Promise<StateDecision> {
  const { cell, containerState, finalization } = input;

  if (input.run.kind === 'corrupt') {
    return indeterminateDecision(input.run.corruption, 'corrupt');
  }
  if (input.checkpoint.kind === 'corrupt') {
    return indeterminateDecision(input.checkpoint.corruption, 'corrupt');
  }
  if (input.summary.kind === 'corrupt') {
    return indeterminateDecision(input.summary.corruption, 'corrupt');
  }
  if (input.results.kind === 'corrupt') {
    return indeterminateDecision(input.results.corruption, 'corrupt');
  }

  if (input.checkpoint.kind === 'absent') {
    const hasResultRows = input.results.kind === 'present' && input.results.value.length > 0;
    if (input.run.kind === 'present' || input.summary.kind === 'present' || hasResultRows) {
      // A public projection without its checkpoint authority is torn state.
      return indeterminateDecision(
        corrupt('cross-artifact', 'orphan_public_artifact'),
        'corrupt',
      );
    }
    if (finalization !== null) {
      return indeterminateDecision(
        corrupt('cross-artifact', 'finalization_mismatch'),
        'corrupt',
      );
    }
    switch (containerState) {
      case 'absent':
        return {
          state: 'planned',
          failureCause: null,
          corruption: null,
          resume: NOT_STARTED_RESUME,
        };
      case 'starting':
      case 'running':
        return {
          state: 'starting',
          failureCause: null,
          corruption: null,
          resume: { eligible: false, kind: 'in_progress' },
        };
      case 'exited':
        return failedDecision(
          {
            kind: 'infrastructure_failed',
            reason: 'container_stopped_before_durable_artifacts',
            httpStatus: null,
          },
          NOT_STARTED_RESUME,
        );
      case 'unknown':
        return indeterminateDecision(null, 'container_state_unproven');
    }
  }

  const checkpoint = input.checkpoint.value;
  if (input.run.kind === 'absent' || input.summary.kind === 'absent') {
    return indeterminateDecision(
      corrupt('cross-artifact', 'missing_companion_artifact'),
      'corrupt',
    );
  }
  const run = input.run.value;
  const summary = input.summary.value;
  const rows = input.results.kind === 'present' ? input.results.value : [];

  const workflowId = expectedWorkflowId(cell);
  if (
    checkpoint.runId !== cell.runId
    || run.runId !== cell.runId
    || summary.runId !== cell.runId
    || checkpoint.workflowId !== workflowId
    || run.workflowId !== workflowId
    || summary.workflowId !== workflowId
    || rows.some(row => row.runId !== cell.runId || row.workflowId !== workflowId)
  ) {
    return indeterminateDecision(corrupt('cross-artifact', 'foreign_run'), 'corrupt');
  }
  if (run.status !== checkpoint.status) {
    return indeterminateDecision(corrupt('cross-artifact', 'status_conflict'), 'corrupt');
  }
  if (
    run.recordCount !== checkpoint.recordCount
    || run.resultRows !== checkpoint.resultRows
    || run.evaluationRows !== checkpoint.evaluationRows
    || summary.resultRows !== checkpoint.resultRows
    || summary.evaluationRows !== checkpoint.evaluationRows
    || summary.selectedTasks !== checkpoint.selectedTasks
    || run.selectedTaskIds.length !== checkpoint.selectedTasks
    || rows.length !== checkpoint.resultRows
    || (checkpoint.recordCount === 0 && checkpoint.resultRows > 0)
  ) {
    return indeterminateDecision(corrupt('cross-artifact', 'count_conflict'), 'corrupt');
  }
  const rowTaskIds = rows.map(row => row.taskId);
  if (new Set(rowTaskIds).size !== rowTaskIds.length) {
    return indeterminateDecision(
      corrupt('results.jsonl', 'duplicate_result_tasks'),
      'corrupt',
    );
  }
  for (const status of [
    'answered',
    'refused',
    'error',
    'no_response',
    'side_effect_before_failure',
  ] as const) {
    const observed = rows.filter(row => row.status === status).length;
    if (observed !== summary.statuses[status]) {
      return indeterminateDecision(corrupt('cross-artifact', 'count_conflict'), 'corrupt');
    }
  }

  let record: LedgerRecordProjectionV1 | null = null;
  if (checkpoint.recordCount > 0) {
    const reading = await readJsonArtifact(
      input.files,
      ledgerRecordPath(input.runDirectory, checkpoint.recordCount - 1),
      'ledger-record',
      ledgerRecordProjectionV1Schema,
    );
    if (reading.kind === 'corrupt') {
      return indeterminateDecision(reading.corruption, 'corrupt');
    }
    if (reading.kind === 'absent') {
      return indeterminateDecision(
        corrupt('ledger-record', 'missing_last_record'),
        'corrupt',
      );
    }
    record = reading.value;
    if (
      record.sequence !== checkpoint.recordCount - 1
      || record.recordDigest !== checkpoint.lastRecordDigest
      || (checkpoint.recordCount === 1) !== (record.previousRecordDigest === null)
    ) {
      return indeterminateDecision(
        corrupt('ledger-record', 'record_chain_broken'),
        'corrupt',
      );
    }
  }

  const recordStopReason = record?.payload.sessionStopReason ?? null;
  if (
    run.stopReason !== undefined
    && recordStopReason !== null
    && run.stopReason !== recordStopReason
  ) {
    return indeterminateDecision(
      corrupt('cross-artifact', 'stop_reason_conflict'),
      'corrupt',
    );
  }

  const evidence: ExperimentFailureEvidenceV1 = {
    sessionStopReason: recordStopReason ?? run.stopReason ?? null,
    providerRequests: providerRequestsFrom(record),
    durableRecordCount: checkpoint.recordCount,
  };

  if (checkpoint.status === 'completed') {
    if (run.stopReason === 'fatal_error') {
      if (finalization !== null) {
        return indeterminateDecision(
          corrupt('cross-artifact', 'finalization_mismatch'),
          'corrupt',
        );
      }
      const cause = classifyExperimentFailureV1(evidence);
      if (cause.kind === 'indeterminate_external_operation') {
        return indeterminateDecision(null, 'indeterminate');
      }
      // A fatal run's artifacts are evidence: it never reuses its runId, so
      // it is never auto-resumed, whatever its cause.
      return failedDecision(cause, { eligible: false, kind: 'failed_terminal' });
    }
    if (finalization !== null) {
      if (
        finalization.runId !== cell.runId
        || checkpoint.lastRecordDigest === null
        || finalization.sourceLastRecordDigest !== checkpoint.lastRecordDigest
      ) {
        return indeterminateDecision(
          corrupt('cross-artifact', 'finalization_mismatch'),
          'corrupt',
        );
      }
      return {
        state: 'finalized',
        failureCause: null,
        corruption: null,
        resume: DURABLE_REPLAY_RESUME,
      };
    }
    return {
      state: 'committed',
      failureCause: null,
      corruption: null,
      resume: DURABLE_REPLAY_RESUME,
    };
  }

  // checkpoint.status === 'running'
  if (finalization !== null) {
    return indeterminateDecision(
      corrupt('cross-artifact', 'finalization_mismatch'),
      'corrupt',
    );
  }
  switch (containerState) {
    case 'starting':
    case 'running':
      return {
        state: 'running',
        failureCause: null,
        corruption: null,
        resume: { eligible: false, kind: 'in_progress' },
      };
    case 'unknown':
      return indeterminateDecision(null, 'container_state_unproven');
    case 'absent':
    case 'exited': {
      if (checkpoint.recordCount === 0) {
        // The ledger proves zero durable rows and the probe proves the
        // container stopped: provably not-started, safe to relaunch.
        return failedDecision(
          {
            kind: 'infrastructure_failed',
            reason: 'container_stopped_before_durable_artifacts',
            httpStatus: null,
          },
          NOT_STARTED_RESUME,
        );
      }
      const cause = classifyExperimentFailureV1(evidence);
      if (cause.kind === 'indeterminate_external_operation') {
        // Interrupted after durable work with no provable terminal cause:
        // never auto-resumed.
        return indeterminateDecision(null, 'indeterminate');
      }
      return failedDecision(cause, { eligible: false, kind: 'failed_terminal' });
    }
  }
}

/**
 * Resume must reuse the exact runId, configuration identity, and image
 * provenance of the original bound cell. Cell identity is recomputed from the
 * cell definitions rather than trusted from the bound fields. The egress
 * probe result is re-measured provenance and may differ.
 */
export function assertExperimentResumeProvenanceV1(
  original: BoundExperimentCellV1,
  candidate: BoundExperimentCellV1,
): void {
  const originalCellId = deriveExperimentCellIdV1(original.cell);
  if (originalCellId !== original.cellId) {
    throw new Error('Original bound cell does not match its own cell identity');
  }
  if (deriveExperimentCellIdV1(candidate.cell) !== originalCellId) {
    throw new Error('Experiment resume must reuse the exact cell configuration');
  }
  if (candidate.cellId !== original.cellId) {
    throw new Error('Experiment resume must reuse the original cell id');
  }
  if (candidate.planDigest !== original.planDigest) {
    throw new Error('Experiment resume must reuse the original published plan');
  }
  if (
    candidate.experimentId !== original.experimentId
    || candidate.replicate !== original.replicate
    || candidate.runId !== original.runId
  ) {
    throw new Error('Experiment resume must reuse the exact run identity');
  }
  if (candidate.cell.provenance.imageDigest !== original.cell.provenance.imageDigest) {
    throw new Error('Experiment resume must reuse the exact image provenance');
  }
}
