import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EXPERIMENT_CELL_STATES_V1,
  assertExperimentResumeProvenanceV1,
  classifyExperimentFailureV1,
  nodeExperimentRunArtifactFilesV1,
  observeExperimentCellV1,
  type ExperimentCellFinalizationEvidenceV1,
  type ExperimentCellObservationV1,
  type ExperimentContainerStateV1,
  type ExperimentFailureCauseV1,
  type ExperimentProviderRequestEvidenceV1,
  type ExperimentSessionStopReasonV1,
} from '../../src/experiments/v1/status.js';
import {
  deriveExperimentCellIdV1,
  experimentCellV1Schema,
  type ExperimentCellV1,
} from '../../src/experiments/v1/contracts.js';
import {
  deriveExperimentRunIdV1,
  type BoundExperimentCellV1,
} from '../../src/experiments/v1/plan.js';
import { zeroFileWorkflowUsageV1 } from '../../src/runner/v1/file-workflow-artifacts.js';
import { PACT_PAIR_METRIC_NAMES_V1 } from '../../src/suites/pact-pair/evaluation.js';
import { binding, finalFilesFor } from '../runner-v1/file-workflow-test-fixtures.js';

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

const EXPERIMENT_ID = 'exp-status-observer';
const TASK_IDS = ['PAIR-Q-1', 'PAIR-Q-2'];
const RUN_DIRECTORY = path.join(path.sep, 'observed', 'multi');
const RECORDS_DIRECTORY = path.join('.sharedeval-file-workflow', 'records');

function cellDefinition(): ExperimentCellV1 {
  return experimentCellV1Schema.parse({
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      model: 'deepseek/deepseek-v3.2',
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      gradingMode: 'category',
      tasks: { kind: 'all' },
    },
    workflow: { mode: 'multi', protocol: 'files', maxTicks: 8, stopWhen: 'all-terminal' },
    budget: { maxToolCalls: 8, maxRuntimeMs: 60_000 },
    replicate: 1,
    provenance: {
      configDigest: hex('config'),
      taskSetDigest: hex('task-set'),
      sharedosRevision: 'ac0f1bb210baa3ba4b7e0d0baaf2291bbe9ffd05',
      sharedosRuntimeDigest: hex('sharedos-runtime'),
      imageDigest: `sha256:${hex('image')}`,
      egressProbe: {
        directEgressBlocked: true,
        nonAllowlistedEgressBlocked: true,
        modelEndpointReachable: true,
      },
    },
  });
}

function boundCellFor(cell: ExperimentCellV1): BoundExperimentCellV1 {
  const cellId = deriveExperimentCellIdV1(cell);
  return {
    planDigest: hex('published-plan'),
    experimentId: EXPERIMENT_ID,
    cellId,
    runId: deriveExperimentRunIdV1(EXPERIMENT_ID, cellId, cell.replicate),
    replicate: cell.replicate,
    cell,
  };
}

const boundCell = boundCellFor(cellDefinition());

function recordName(sequence: number): string {
  return path.join(
    RECORDS_DIRECTORY,
    `record-${String(sequence).padStart(12, '0')}.json`,
  );
}

type ResultRowStatus = 'error' | 'no_response';

type ArtifactOptions = Readonly<{
  status: 'running' | 'completed';
  stopReason?: ExperimentSessionStopReasonV1;
  recordCount?: number;
  resultStatuses?: readonly ResultRowStatus[];
  recordStopReason?: ExperimentSessionStopReasonV1;
  /** null omits privateEvidence entirely (retainPrivate=false runs). */
  requests?: readonly Record<string, unknown>[] | null;
}>;

function runArtifacts(options: ArtifactOptions): Map<string, string> {
  const bound = binding('files-multi', boundCell.runId, [...TASK_IDS]);
  const statuses = options.resultStatuses ?? [];
  const recordCount = options.recordCount ?? (statuses.length > 0 ? 1 : 0);
  const rows = statuses.map((status, index) => ({
    apiVersion: 'sharedeval-file-result/v1',
    workflowId: bound.workflowId,
    runId: bound.runId,
    sessionId: `session-${bound.runId}`,
    taskId: TASK_IDS[index],
    kind: bound.selectedTasks[index]!.kind,
    status,
    terminalTick: index + 1,
    ...(status === 'error' ? { errorCode: 'FILE_SESSION_FAILED' } : {}),
    publicEvaluation: null,
    selectedTaskDigest: bound.selectedTaskDigest,
    backend: bound.backend,
  }));
  const statusCounts = {
    answered: 0,
    refused: 0,
    error: 0,
    no_response: 0,
    side_effect_before_failure: 0,
  };
  for (const status of statuses) statusCounts[status] += 1;
  const lastRecordDigest = recordCount > 0
    ? hex(`record:${bound.runId}:${recordCount - 1}`)
    : null;
  const completed = options.status === 'completed';
  const finalFiles = completed ? finalFilesFor(bound) : null;
  const runManifest = {
    apiVersion: 'sharedeval-file-run/v1',
    workflowId: bound.workflowId,
    runId: bound.runId,
    status: options.status,
    ...(completed ? { stopReason: options.stopReason ?? 'all_terminal' } : {}),
    selectedTaskIds: bound.selectedTaskIds,
    selectedTasks: bound.selectedTasks,
    selectedTaskDigest: bound.selectedTaskDigest,
    dataset: bound.dataset,
    goldSet: bound.goldSet,
    policies: bound.policies,
    actors: finalFiles
      ? {
        requester: { ...bound.actors.requester, final: finalFiles.requester },
        responder: { ...bound.actors.responder, final: finalFiles.responder },
      }
      : bound.actors,
    backend: bound.backend,
    recordCount,
    resultRows: rows.length,
    evaluationRows: rows.length,
  };
  const summary = {
    apiVersion: 'sharedeval-file-summary/v1',
    workflowId: bound.workflowId,
    runId: bound.runId,
    selectedTasks: TASK_IDS.length,
    resultRows: rows.length,
    evaluationRows: rows.length,
    statuses: statusCounts,
    metrics: PACT_PAIR_METRIC_NAMES_V1.map(metric => ({
      metric,
      numerator: 0,
      denominator: 0,
      value: null,
    })),
    usage: zeroFileWorkflowUsageV1(),
  };
  const checkpoint = {
    apiVersion: 'sharedeval-file-checkpoint/v1',
    workflowId: bound.workflowId,
    runId: bound.runId,
    status: options.status,
    recordCount,
    selectedTasks: TASK_IDS.length,
    resultRows: rows.length,
    evaluationRows: rows.length,
    lastEventId: recordCount > 0 ? `event-${recordCount}` : null,
    lastRecordDigest,
  };
  const entries = new Map<string, string>();
  entries.set('run.json', `${JSON.stringify(runManifest)}\n`);
  entries.set(
    'results.jsonl',
    rows.length > 0 ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '',
  );
  entries.set('summary.json', `${JSON.stringify(summary)}\n`);
  entries.set('checkpoint.json', `${JSON.stringify(checkpoint)}\n`);
  if (recordCount > 0) {
    const record = {
      apiVersion: 'sharedeval-file-heartbeat-record/v1',
      sequence: recordCount - 1,
      bindingDigest: hex('binding-digest'),
      previousRecordDigest: recordCount === 1
        ? null
        : hex(`record:${bound.runId}:${recordCount - 2}`),
      payload: {
        ...(options.recordStopReason
          ? { sessionStopReason: options.recordStopReason }
          : {}),
        ...(options.requests === null
          ? {}
          : {
            privateEvidence: {
              providerTelemetry: {
                requester: {
                  requests: options.requests
                    ?? [{ outcome: 'success', attempts: 1, latencyMs: 1 }],
                },
              },
            },
          }),
      },
      recordDigest: lastRecordDigest,
    };
    entries.set(recordName(recordCount - 1), `${JSON.stringify(record)}\n`);
  }
  return entries;
}

function withJson(
  entries: Map<string, string>,
  name: string,
  mutate: (value: any) => void,
): Map<string, string> {
  const clone = new Map(entries);
  const raw = clone.get(name);
  assert.ok(raw !== undefined, `fixture is missing ${name}`);
  const value = JSON.parse(raw) as any;
  mutate(value);
  clone.set(name, `${JSON.stringify(value)}\n`);
  return clone;
}

function without(entries: Map<string, string>, name: string): Map<string, string> {
  const clone = new Map(entries);
  clone.delete(name);
  return clone;
}

function assertObservationInvariants(observation: ExperimentCellObservationV1): void {
  assert.ok(
    (EXPERIMENT_CELL_STATES_V1 as readonly string[]).includes(observation.state),
    `state ${observation.state} is outside the typed state set`,
  );
  assert.equal(
    observation.failureCause !== null,
    observation.state === 'failed',
    'failureCause must be present exactly when the state is failed',
  );
  if (observation.corruption !== null) {
    assert.equal(observation.state, 'indeterminate', 'corrupt artifacts fail closed');
    assert.deepEqual(observation.resume, { eligible: false, kind: 'corrupt' });
  }
  if (observation.state === 'indeterminate') {
    assert.equal(observation.resume.eligible, false, 'indeterminate never auto-resumes');
  }
  if (observation.resume.eligible) {
    assert.ok(
      ['planned', 'failed', 'committed', 'finalized'].includes(observation.state),
      'resume-eligible states are constrained',
    );
  }
}

async function observe(options: Readonly<{
  entries?: Map<string, string>;
  unreadable?: readonly string[];
  container?: ExperimentContainerStateV1;
  probeThrows?: boolean;
  finalization?: ExperimentCellFinalizationEvidenceV1 | null;
}> = {}): Promise<ExperimentCellObservationV1> {
  const entries = options.entries ?? new Map<string, string>();
  const unreadable = new Set(options.unreadable ?? []);
  const observation = await observeExperimentCellV1({
    cell: boundCell,
    runDirectory: RUN_DIRECTORY,
    probe: {
      containerState: async runId => {
        assert.equal(runId, boundCell.runId, 'probe must be keyed by the cell runId');
        if (options.probeThrows) throw new Error('PRIVATE_PROBE_BACKEND_FAILURE');
        return options.container ?? 'absent';
      },
    },
    files: {
      readOptionalFile: async filePath => {
        const relativePath = path.relative(RUN_DIRECTORY, filePath);
        if (unreadable.has(relativePath)) {
          throw new Error('PRIVATE_FIXTURE_IO_FAILURE');
        }
        return entries.get(relativePath) ?? null;
      },
    },
    ...(options.finalization !== undefined ? { finalization: options.finalization } : {}),
  });
  assertObservationInvariants(observation);
  return observation;
}

function committedFinalization(): ExperimentCellFinalizationEvidenceV1 {
  return {
    runId: boundCell.runId,
    sourceLastRecordDigest: hex(`record:${boundCell.runId}:0`),
  };
}

// --- failure classifier: exhaustive totality table -------------------------

const CAUSE_KINDS = [
  'model_behavior_terminal',
  'infrastructure_failed',
  'indeterminate_external_operation',
] as const;

const STOP_REASONS = [null, 'all_terminal', 'tick_exhausted', 'fatal_error'] as const;
const DURABLE_COUNTS = [0, 3] as const;

const success: ExperimentProviderRequestEvidenceV1 = {
  outcome: 'success',
  httpStatus: 200,
  attempts: 1,
};
const invalidResponse: ExperimentProviderRequestEvidenceV1 = {
  outcome: 'invalid_response',
  httpStatus: 200,
  attempts: 5,
};
function providerError(httpStatus: number | null): ExperimentProviderRequestEvidenceV1 {
  return { outcome: 'provider_error', httpStatus, attempts: 3 };
}

function classifyEverywhere(
  requests: readonly ExperimentProviderRequestEvidenceV1[],
  expected: (
    stop: ExperimentSessionStopReasonV1 | null,
    count: number,
  ) => ExperimentFailureCauseV1,
): void {
  for (const sessionStopReason of STOP_REASONS) {
    for (const durableRecordCount of DURABLE_COUNTS) {
      const cause = classifyExperimentFailureV1({
        sessionStopReason,
        providerRequests: requests,
        durableRecordCount,
      });
      assert.ok(
        (CAUSE_KINDS as readonly string[]).includes(cause.kind),
        'classifier must be total over the typed cause set',
      );
      assert.deepEqual(
        cause,
        expected(sessionStopReason, durableRecordCount),
        `stop=${sessionStopReason} count=${durableRecordCount}`,
      );
    }
  }
}

test('classifier: no provider evidence is always indeterminate', () => {
  classifyEverywhere([], () => ({
    kind: 'indeterminate_external_operation',
    reason: 'no_provider_evidence',
  }));
});

test('classifier: all-success telemetry with a fatal stop is format-denial exhaustion', () => {
  classifyEverywhere([success, success], stop => (
    stop === 'fatal_error'
      ? { kind: 'model_behavior_terminal', reason: 'format_denial_exhausted' }
      : { kind: 'indeterminate_external_operation', reason: 'unproven_stop' }
  ));
});

test('classifier: a recovered provider error keeps a fatal stop unproven', () => {
  classifyEverywhere([providerError(429), success], () => ({
    kind: 'indeterminate_external_operation',
    reason: 'unproven_stop',
  }));
});

test('classifier: a terminal invalid_response is model behavior, never re-rolled', () => {
  classifyEverywhere([success, invalidResponse], () => ({
    kind: 'model_behavior_terminal',
    reason: 'invalid_response',
  }));
});

test('classifier: retryable provider errors before any durable commit are infrastructure', () => {
  for (const httpStatus of [408, 409, 429, 500, 502, 503, 599]) {
    classifyEverywhere([success, providerError(httpStatus)], (_stop, count) => (
      count === 0
        ? { kind: 'infrastructure_failed', reason: 'retryable_provider_error', httpStatus }
        : {
          kind: 'indeterminate_external_operation',
          reason: 'provider_error_after_durable_commit',
        }
    ));
  }
});

test('classifier: non-retryable or unproven provider errors are indeterminate', () => {
  for (const httpStatus of [400, 401, 403, 404, 422, 499, null]) {
    classifyEverywhere([providerError(httpStatus)], () => ({
      kind: 'indeterminate_external_operation',
      reason: 'non_retryable_provider_error',
    }));
  }
});

// --- state derivation ------------------------------------------------------

test('planned: no artifacts and no container', async () => {
  const observation = await observe({ container: 'absent' });
  assert.equal(observation.state, 'planned');
  assert.deepEqual(observation.resume, { eligible: true, kind: 'not_started' });
  assert.equal(observation.corruption, null);
  assert.equal(observation.planDigest, boundCell.planDigest);
  assert.equal(observation.cellId, boundCell.cellId);
  assert.equal(observation.runId, boundCell.runId);
});

test('starting: container up before any durable artifact', async () => {
  for (const container of ['starting', 'running'] as const) {
    const observation = await observe({ container });
    assert.equal(observation.state, 'starting');
    assert.deepEqual(observation.resume, { eligible: false, kind: 'in_progress' });
  }
});

test('failed not-started: container exited with zero durable artifacts', async () => {
  const observation = await observe({ container: 'exited' });
  assert.equal(observation.state, 'failed');
  assert.deepEqual(observation.failureCause, {
    kind: 'infrastructure_failed',
    reason: 'container_stopped_before_durable_artifacts',
    httpStatus: null,
  });
  assert.deepEqual(observation.resume, { eligible: true, kind: 'not_started' });
});

test('indeterminate: unknown container state with no artifacts never resumes', async () => {
  const observation = await observe({ container: 'unknown' });
  assert.equal(observation.state, 'indeterminate');
  assert.deepEqual(observation.resume, {
    eligible: false,
    kind: 'container_state_unproven',
  });
});

test('a throwing probe fails closed to an unknown container state', async () => {
  const observation = await observe({ probeThrows: true });
  assert.equal(observation.containerState, 'unknown');
  assert.equal(observation.state, 'indeterminate');
  assert.deepEqual(observation.resume, {
    eligible: false,
    kind: 'container_state_unproven',
  });
});

test('running: live container over consistent in-progress artifacts', async () => {
  const entries = runArtifacts({ status: 'running', resultStatuses: ['error'] });
  const observation = await observe({ entries, container: 'running' });
  assert.equal(observation.state, 'running');
  assert.deepEqual(observation.resume, { eligible: false, kind: 'in_progress' });
});

test('running: absent results.jsonl with zero result rows is not corrupt', async () => {
  const entries = without(runArtifacts({ status: 'running' }), 'results.jsonl');
  const observation = await observe({ entries, container: 'running' });
  assert.equal(observation.state, 'running');
  assert.equal(observation.corruption, null);
});

test('failed not-started: checkpoint proves zero durable rows after container stop', async () => {
  const entries = runArtifacts({ status: 'running' });
  for (const container of ['absent', 'exited'] as const) {
    const observation = await observe({ entries, container });
    assert.equal(observation.state, 'failed');
    assert.deepEqual(observation.failureCause, {
      kind: 'infrastructure_failed',
      reason: 'container_stopped_before_durable_artifacts',
      httpStatus: null,
    });
    assert.deepEqual(observation.resume, { eligible: true, kind: 'not_started' });
  }
});

test('indeterminate: interruption after durable rows with no provable cause', async () => {
  const entries = runArtifacts({ status: 'running', resultStatuses: ['error'] });
  const observation = await observe({ entries, container: 'exited' });
  assert.equal(observation.state, 'indeterminate');
  assert.deepEqual(observation.resume, { eligible: false, kind: 'indeterminate' });
});

test('indeterminate: interrupted partial run with unknown container state', async () => {
  const entries = runArtifacts({ status: 'running', resultStatuses: ['error'] });
  const observation = await observe({ entries, container: 'unknown' });
  assert.equal(observation.state, 'indeterminate');
  assert.deepEqual(observation.resume, {
    eligible: false,
    kind: 'container_state_unproven',
  });
});

test('failed: durable fatal stop with all-success telemetry is model behavior', async () => {
  const entries = runArtifacts({
    status: 'running',
    resultStatuses: ['error'],
    recordStopReason: 'fatal_error',
  });
  const observation = await observe({ entries, container: 'exited' });
  assert.equal(observation.state, 'failed');
  assert.deepEqual(observation.failureCause, {
    kind: 'model_behavior_terminal',
    reason: 'format_denial_exhausted',
  });
  assert.deepEqual(observation.resume, { eligible: false, kind: 'failed_terminal' });
});

test('committed: completed durable authority allows a zero-work replay', async () => {
  for (const stopReason of ['all_terminal', 'tick_exhausted'] as const) {
    const entries = runArtifacts({
      status: 'completed',
      stopReason,
      resultStatuses: ['error', 'no_response'],
      recordStopReason: stopReason,
    });
    const observation = await observe({ entries, container: 'exited' });
    assert.equal(observation.state, 'committed');
    assert.deepEqual(observation.resume, {
      eligible: true,
      kind: 'durable_commit_replay',
    });
  }
});

test('finalized: finalization evidence bound to the exact ledger authority', async () => {
  const entries = runArtifacts({
    status: 'completed',
    resultStatuses: ['error', 'no_response'],
    recordStopReason: 'all_terminal',
  });
  const observation = await observe({
    entries,
    container: 'absent',
    finalization: committedFinalization(),
  });
  assert.equal(observation.state, 'finalized');
  assert.deepEqual(observation.resume, {
    eligible: true,
    kind: 'durable_commit_replay',
  });
});

test('failed: fatal completed run classifies invalid_response and never resumes', async () => {
  const entries = runArtifacts({
    status: 'completed',
    stopReason: 'fatal_error',
    resultStatuses: ['error', 'error'],
    recordStopReason: 'fatal_error',
    requests: [
      { outcome: 'success', attempts: 1, latencyMs: 1 },
      { outcome: 'invalid_response', attempts: 5, latencyMs: 1 },
    ],
  });
  const observation = await observe({ entries, container: 'exited' });
  assert.equal(observation.state, 'failed');
  assert.deepEqual(observation.failureCause, {
    kind: 'model_behavior_terminal',
    reason: 'invalid_response',
  });
  assert.deepEqual(observation.resume, { eligible: false, kind: 'failed_terminal' });
});

test('failed: fatal completed run with all-success telemetry is denial exhaustion', async () => {
  const entries = runArtifacts({
    status: 'completed',
    stopReason: 'fatal_error',
    resultStatuses: ['error', 'error'],
    recordStopReason: 'fatal_error',
  });
  const observation = await observe({ entries, container: 'exited' });
  assert.equal(observation.state, 'failed');
  assert.deepEqual(observation.failureCause, {
    kind: 'model_behavior_terminal',
    reason: 'format_denial_exhausted',
  });
});

test('indeterminate: fatal completed run without retained telemetry is unprovable', async () => {
  const entries = runArtifacts({
    status: 'completed',
    stopReason: 'fatal_error',
    resultStatuses: ['error', 'error'],
    recordStopReason: 'fatal_error',
    requests: null,
  });
  const observation = await observe({ entries, container: 'exited' });
  assert.equal(observation.state, 'indeterminate');
  assert.deepEqual(observation.resume, { eligible: false, kind: 'indeterminate' });
});

// --- corrupt and conflicting artifacts fail closed -------------------------

test('corrupt: run.json that is not JSON', async () => {
  const entries = runArtifacts({ status: 'running', resultStatuses: ['error'] });
  entries.set('run.json', '{ not json');
  const observation = await observe({ entries, container: 'running' });
  assert.equal(observation.state, 'indeterminate');
  assert.deepEqual(observation.corruption, { artifact: 'run.json', reason: 'invalid_json' });
});

test('corrupt: checkpoint.json violating its schema', async () => {
  const entries = runArtifacts({ status: 'running', resultStatuses: ['error'] });
  entries.set('checkpoint.json', `${JSON.stringify({ apiVersion: 'other/v1' })}\n`);
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'checkpoint.json',
    reason: 'schema_violation',
  });
});

test('corrupt: an unreadable artifact never passes as absent', async () => {
  const observation = await observe({
    entries: runArtifacts({ status: 'running' }),
    unreadable: ['run.json'],
    container: 'running',
  });
  assert.deepEqual(observation.corruption, { artifact: 'run.json', reason: 'unreadable' });
  assert.deepEqual(observation.resume, { eligible: false, kind: 'corrupt' });
});

test('corrupt: public projections without their checkpoint authority', async () => {
  const entries = without(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    'checkpoint.json',
  );
  const observation = await observe({ entries, container: 'absent' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'orphan_public_artifact',
  });
});

test('corrupt: checkpoint without its companion public artifacts', async () => {
  const entries = without(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    'run.json',
  );
  const observation = await observe({ entries, container: 'absent' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'missing_companion_artifact',
  });
});

test('corrupt: checkpoint and run.json disagree on lifecycle status', async () => {
  const completed = runArtifacts({
    status: 'completed',
    resultStatuses: ['error', 'error'],
    recordStopReason: 'all_terminal',
  });
  const running = runArtifacts({
    status: 'running',
    resultStatuses: ['error', 'error'],
  });
  const entries = new Map(completed);
  entries.set('run.json', running.get('run.json')!);
  const observation = await observe({ entries, container: 'absent' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'status_conflict',
  });
});

test('corrupt: checkpoint result counters conflict with the result rows', async () => {
  const entries = withJson(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    'checkpoint.json',
    checkpoint => {
      checkpoint.resultRows = 0;
      checkpoint.evaluationRows = 0;
    },
  );
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'count_conflict',
  });
});

test('corrupt: summary status tallies conflict with the typed result rows', async () => {
  const entries = withJson(
    runArtifacts({ status: 'running', resultStatuses: ['error', 'error'] }),
    'summary.json',
    summary => {
      summary.statuses = {
        answered: 0,
        refused: 0,
        error: 0,
        no_response: 2,
        side_effect_before_failure: 0,
      };
    },
  );
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'count_conflict',
  });
});

test('corrupt: artifacts from a foreign run identity', async () => {
  const entries = withJson(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    'checkpoint.json',
    checkpoint => {
      checkpoint.runId = 'someone-elses-run';
    },
  );
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'foreign_run',
  });
});

test('corrupt: duplicate task IDs across result rows', async () => {
  const base = runArtifacts({ status: 'running', resultStatuses: ['error', 'error'] });
  const rows = base.get('results.jsonl')!.trim().split('\n').map(line => JSON.parse(line) as any);
  rows[1].taskId = rows[0].taskId;
  const entries = new Map(base);
  entries.set('results.jsonl', `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'results.jsonl',
    reason: 'duplicate_result_tasks',
  });
});

test('corrupt: checkpoint claims durable records but the last record is missing', async () => {
  const entries = without(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    recordName(0),
  );
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'ledger-record',
    reason: 'missing_last_record',
  });
});

test('corrupt: broken record digest chain', async () => {
  const entries = withJson(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    recordName(0),
    record => {
      record.recordDigest = hex('tampered-record');
    },
  );
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'ledger-record',
    reason: 'record_chain_broken',
  });
});

test('corrupt: last record sequence disagrees with the checkpoint', async () => {
  const entries = withJson(
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
    recordName(0),
    record => {
      record.sequence = 7;
    },
  );
  const observation = await observe({ entries, container: 'running' });
  assert.deepEqual(observation.corruption, {
    artifact: 'ledger-record',
    reason: 'record_chain_broken',
  });
});

test('corrupt: run.json stop reason conflicts with the durable record', async () => {
  const entries = runArtifacts({
    status: 'completed',
    stopReason: 'all_terminal',
    resultStatuses: ['error', 'error'],
    recordStopReason: 'tick_exhausted',
  });
  const observation = await observe({ entries, container: 'absent' });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'stop_reason_conflict',
  });
});

test('corrupt: finalization evidence over a run that is not committed', async () => {
  for (const entries of [
    new Map<string, string>(),
    runArtifacts({ status: 'running', resultStatuses: ['error'] }),
  ]) {
    const observation = await observe({
      entries,
      container: 'absent',
      finalization: committedFinalization(),
    });
    assert.deepEqual(observation.corruption, {
      artifact: 'cross-artifact',
      reason: 'finalization_mismatch',
    });
  }
});

test('corrupt: finalization evidence bound to a different ledger digest', async () => {
  const entries = runArtifacts({
    status: 'completed',
    resultStatuses: ['error', 'error'],
    recordStopReason: 'all_terminal',
  });
  const observation = await observe({
    entries,
    container: 'absent',
    finalization: {
      runId: boundCell.runId,
      sourceLastRecordDigest: hex('a-different-run-authority'),
    },
  });
  assert.deepEqual(observation.corruption, {
    artifact: 'cross-artifact',
    reason: 'finalization_mismatch',
  });
});

// --- resume provenance -----------------------------------------------------

test('resume provenance: the exact bound cell is accepted', () => {
  assertExperimentResumeProvenanceV1(boundCell, structuredClone(boundCell));
});

test('resume provenance: a re-measured egress probe does not block reuse', () => {
  const candidate = structuredClone(boundCell) as any;
  candidate.cell.provenance.egressProbe = {
    directEgressBlocked: true,
    nonAllowlistedEgressBlocked: true,
    modelEndpointReachable: false,
  };
  assertExperimentResumeProvenanceV1(boundCell, candidate as BoundExperimentCellV1);
});

test('resume provenance: a different image digest is rejected', () => {
  const candidate = structuredClone(boundCell) as any;
  candidate.cell.provenance.imageDigest = `sha256:${hex('rebaked-image')}`;
  assert.throws(
    () => assertExperimentResumeProvenanceV1(boundCell, candidate as BoundExperimentCellV1),
    /exact image provenance/,
  );
});

test('resume provenance: a different cell configuration is rejected', () => {
  const changed = cellDefinition();
  (changed.model as any).temperature = 0.7;
  const candidate = { ...structuredClone(boundCell), cell: experimentCellV1Schema.parse(changed) };
  assert.throws(
    () => assertExperimentResumeProvenanceV1(boundCell, candidate),
    /exact cell configuration/,
  );
});

test('resume provenance: a different run identity is rejected', () => {
  const candidate = {
    ...structuredClone(boundCell),
    runId: deriveExperimentRunIdV1(EXPERIMENT_ID, boundCell.cellId, 2),
  };
  assert.throws(
    () => assertExperimentResumeProvenanceV1(boundCell, candidate),
    /exact run identity/,
  );
});

test('resume provenance: a tampered original binding is rejected', () => {
  const original = { ...structuredClone(boundCell), cellId: hex('forged-cell-id') };
  assert.throws(
    () => assertExperimentResumeProvenanceV1(original, structuredClone(boundCell)),
    /own cell identity/,
  );
});

// --- node artifact files seam ----------------------------------------------

test('node artifact files: absent resolves null, present resolves contents', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'experiment-status-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const files = nodeExperimentRunArtifactFilesV1();
  assert.equal(await files.readOptionalFile(path.join(directory, 'missing.json')), null);
  await writeFile(path.join(directory, 'present.json'), '{"ok":true}\n', 'utf8');
  assert.equal(
    await files.readOptionalFile(path.join(directory, 'present.json')),
    '{"ok":true}\n',
  );
  // A non-ENOENT failure must propagate so the observer records corruption
  // instead of mistaking an unreadable artifact for an absent one.
  await assert.rejects(files.readOptionalFile(directory));
});
