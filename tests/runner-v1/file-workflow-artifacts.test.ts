import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MAX_AGENT_WORKSPACE_FILE_BYTES_V1 } from '../../src/runner/v1/agent-workspace.js';
import { pactTaskResultV1Schema } from '../../src/runner/v1/artifacts.js';
import { PACT_PAIR_METRIC_NAMES_V1 } from '../../src/suites/pact-pair/evaluation.js';
import {
  assertFileWorkflowFinalCardinalityV1,
  fileWorkflowCheckpointV1Schema,
  fileWorkflowFinalFilesV1Schema,
  fileWorkflowHeartbeatPayloadV1Schema,
  fileWorkflowPrivateEvidenceV1Schema,
  fileWorkflowPublicEventV1Schema,
  fileWorkflowPublicEvaluationRecordV1Schema,
  fileWorkflowPublicResultV1Schema,
  fileWorkflowRunBindingV1Schema,
  fileWorkflowRunManifestV1Schema,
  fileWorkflowSelectedTaskDigestV1,
  fileWorkflowSummaryV1Schema,
  fileWorkflowTerminalTransitionV1Schema,
  materializeFileWorkflowNoResponseTransitionsV1,
  type FileWorkflowHeartbeatPayloadV1,
  type FileWorkflowRunBindingV1,
} from '../../src/runner/v1/file-workflow-artifacts.js';

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

test('defines a strict JSON-safe file-workflow lane without widening legacy results', () => {
  const legacy = {
    taskId: 'PAIR-Q-1',
    kind: 'qa',
    status: 'infrastructure_error',
    publicTask: {
      taskId: 'PAIR-Q-1',
      kind: 'qa',
      requester: { id: 'R1', relationship: 'coworker' },
      target: { id: 'alex' },
      prompt: 'public question',
      surface: 'notes',
    },
    finalDecision: { type: 'escalate', reason: 'unavailable' },
    grantedAccess: {
      access: {
        notes: { read: { scope: 'none' }, write: false },
        todos: { read: false, write: false },
        memory: { read: 'none', write: false },
      },
    },
    evaluation: null,
    budgetUsed: { turns: 0, toolCalls: 0, runtimeMs: 0 },
    toolCalls: [],
    violations: [],
    error: 'infrastructure_error',
  };
  assert.deepEqual(pactTaskResultV1Schema.parse(legacy), legacy);
  assert.throws(
    () => pactTaskResultV1Schema.parse({ ...legacy, workflowId: 'files-multi' }),
    /unrecognized|key/i,
  );

  const result = publicResult('PAIR-Q-1', 'no_response', 2);
  assert.deepEqual(fileWorkflowPublicResultV1Schema.parse(result), result);
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({ ...result, memory: 'PRIVATE_MEMORY' }),
    /unrecognized|key/i,
  );
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...result,
      usage: { totalTokens: Number.NaN },
    }),
    /unrecognized|key/i,
  );
});

test('makes public terminal statuses carry their required contact outcome', () => {
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse(
      publicResult('PAIR-Q-1', 'answered', 1),
    ),
    /answered|contact/i,
  );
  assert.deepEqual(
    fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'answered', 1),
      contactStatus: 'completed',
      publicEvaluation: qaPublicEvaluation('PAIR-Q-1'),
    }).contactStatus,
    'completed',
  );
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse(
      publicResult('PAIR-Q-1', 'refused', 1),
    ),
    /refused|contact|denied/i,
  );
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'side_effect_before_failure', 1),
      contactStatus: 'failed',
    }),
    /side.effect|action/i,
  );
});

test('conditions bounded public error codes on error-bearing statuses only', () => {
  const missingErrorCode = publicResult('PAIR-Q-1', 'error', 1) as Record<string, unknown>;
  delete missingErrorCode.errorCode;
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse(missingErrorCode),
    /errorCode|error code|required/i,
    'ACCEPTED_ERROR_WITHOUT_SAFE_CODE',
  );
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'answered', 1),
      contactStatus: 'completed',
      errorCode: 'SHOULD_NOT_EXIST',
    }),
    /errorCode|error code|status/i,
  );
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'error', 1),
      errorCode: 'PRIVATE_CREDENTIAL_SENTINEL',
    }),
    /errorCode|allow|invalid|enum/i,
    'ACCEPTED_ARBITRARY_PUBLIC_ERROR_CODE',
  );

  for (const errorCode of [
    'CONTACT_REQUESTER_FILE_READ_REQUIRED',
    'CONTACT_DUPLICATE_TASK',
    'CONTACT_RESPONDER_FILE_READ_REQUIRED',
    'FILE_TURN_FAILED',
    'FILE_SESSION_FAILED',
    'FILE_SESSION_PREPARATION_FAILED',
  ]) {
    assert.equal(fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'error', 1),
      errorCode,
    }).errorCode, errorCode);
  }
});

test('binds scored terminal statuses to the Task6 terminal decision', () => {
  const qa = qaPublicEvaluation('PAIR-Q-1');
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'answered', 1),
      contactStatus: 'completed',
      publicEvaluation: { ...qa, actualDecision: 'refuse' },
    }),
    /answered|decision|answer/i,
    'ACCEPTED_ANSWERED_WITH_REFUSE_DECISION',
  );
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-Q-1', 'refused', 1),
      contactStatus: 'denied',
      publicEvaluation: qa,
    }),
    /refused|decision|refuse/i,
    'ACCEPTED_REFUSED_WITH_ANSWER_DECISION',
  );

  const action = actionPublicEvaluation('PAIR-A-1');
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({
      ...publicResult('PAIR-A-1', 'side_effect_before_failure', 1, 'action'),
      contactStatus: 'failed',
      publicEvaluation: action,
    }),
    /side.effect|decision|none/i,
    'ACCEPTED_SIDE_EFFECT_WITH_ANSWER_DECISION',
  );
  assert.equal(fileWorkflowPublicResultV1Schema.parse({
    ...publicResult('PAIR-A-1', 'side_effect_before_failure', 1, 'action'),
    contactStatus: 'failed',
    publicEvaluation: { ...action, actualDecision: 'none' },
  }).publicEvaluation?.actualDecision, 'none');
});

test('requires scored terminal outcomes and the exact fixed PACT-Pair metric set', () => {
  const missingEvaluation = {
    ...publicResult('PAIR-Q-1', 'answered', 1),
    contactStatus: 'completed' as const,
  };
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse(missingEvaluation),
    /evaluation|answered|scor/i,
    'ACCEPTED_ANSWERED_WITHOUT_EVALUATION',
  );

  const evaluation = qaPublicEvaluation('PAIR-Q-1');
  const result = { ...missingEvaluation, publicEvaluation: evaluation };
  const evaluationRecord = {
    apiVersion: 'sharedeval-file-evaluation/v1' as const,
    workflowId: result.workflowId,
    runId: result.runId,
    sessionId: result.sessionId,
    taskId: result.taskId,
    publicEvaluation: evaluation,
    metrics: fixedMetricRows(),
  };
  assert.throws(
    () => fileWorkflowPublicEvaluationRecordV1Schema.parse({
      ...evaluationRecord,
      metrics: evaluationRecord.metrics.slice(0, -1),
    }),
    /metric|cardinality|exact|fixed/i,
  );
  assert.throws(
    () => fileWorkflowPublicEvaluationRecordV1Schema.parse({
      ...evaluationRecord,
      metrics: [
        ...evaluationRecord.metrics.slice(0, -1),
        { metric: 'foreignMetric', numerator: 0, denominator: 0 },
      ],
    }),
    /metric|invalid|enum/i,
  );
  assert.throws(
    () => fileWorkflowPublicEvaluationRecordV1Schema.parse({
      ...evaluationRecord,
      publicEvaluation: null,
    }),
    /metric|evaluation|null|empty/i,
  );

  const actionEvaluation = actionPublicEvaluation('PAIR-A-1');
  const sideEffectResult = {
    ...publicResult('PAIR-A-1', 'side_effect_before_failure', 1, 'action'),
    contactStatus: 'failed' as const,
    publicEvaluation: actionEvaluation,
  };
  const sideEffectEvaluation = {
    ...evaluationRecord,
    taskId: 'PAIR-A-1',
    publicEvaluation: actionEvaluation,
    metrics: fixedMetricRows().map(metric => metric.metric === 'informationUtility'
      ? { ...metric, numerator: 1, denominator: 1 }
      : metric),
  };
  assert.throws(
    () => fileWorkflowTerminalTransitionV1Schema.parse({
      taskId: 'PAIR-A-1',
      contactId: 'recipient-trace',
      result: sideEffectResult,
      evaluation: sideEffectEvaluation,
    }),
    /side.effect|actionSafety|metric/i,
  );
});

test('binds pre-spend initial hashes separately from strict final four-file metadata', () => {
  const value = {
    ...binding('files-multi', 'run-provenance', ['PAIR-Q-1', 'PAIR-A-2']),
    selectedTasks: [
      { taskId: 'PAIR-Q-1', kind: 'qa' },
      { taskId: 'PAIR-A-2', kind: 'action' },
    ],
  };
  const parsed = fileWorkflowRunBindingV1Schema.parse(value);
  assert.deepEqual(Object.keys(parsed.actors.requester.initial), [
    'AGENT.md',
    'HEARTBEAT.md',
    'POLICY.md',
    'MEMORY.md',
  ]);
  assert.equal(parsed.policies.responder.sha256, hex('responder-policy'));
  assert.equal(parsed.dataset.sourceRevision, 'a'.repeat(40));
  assert.equal(parsed.goldSet.sha256, hex('gold-set-withheld'));
  assert.equal(parsed.selectedTaskDigest, taskDigest(['PAIR-Q-1', 'PAIR-A-2']));
  assert.deepEqual(parsed.selectedTasks, value.selectedTasks);
  assert.equal('final' in parsed.actors.requester, false);

  const finalFiles = {
    requester: fileSet('requester-final'),
    responder: fileSet('responder-final'),
  };
  assert.deepEqual(fileWorkflowFinalFilesV1Schema.parse(finalFiles), finalFiles);

  const missingMemory = structuredClone(value) as unknown as Record<string, unknown>;
  const actors = (missingMemory.actors as Record<string, unknown>);
  const requester = actors.requester as Record<string, unknown>;
  const initial = requester.initial as Record<string, unknown>;
  delete initial['MEMORY.md'];
  assert.throws(() => fileWorkflowRunBindingV1Schema.parse(missingMemory), /MEMORY|Required/i);

  assert.throws(
    () => fileWorkflowRunBindingV1Schema.parse({
      ...value,
      selectedTaskDigest: '0'.repeat(64),
    }),
    /selected task digest/i,
  );

  for (const role of ['requester', 'responder'] as const) {
    const forgedPolicy = structuredClone(value);
    forgedPolicy.policies[role].sha256 = 'f'.repeat(64);
    assert.throws(
      () => fileWorkflowRunBindingV1Schema.parse(forgedPolicy),
      /policy|POLICY\.md|initial|provenance/i,
      `ACCEPTED_FORGED_${role.toUpperCase()}_POLICY_HASH`,
    );
  }

  assert.throws(
    () => fileWorkflowFinalFilesV1Schema.parse({
      ...finalFiles,
      requester: { ...finalFiles.requester, 'EXTRA.md': finalFiles.requester['AGENT.md'] },
    }),
    /unrecognized|key/i,
  );
});

test('requires exact selected/result/evaluation uniqueness, set equality, and ordering', () => {
  const selected = ['PAIR-Q-1', 'PAIR-A-2'];
  const results = [
    publicResult('PAIR-Q-1', 'answered', 1),
    publicResult('PAIR-A-2', 'no_response', 2, 'action'),
  ];
  const evaluations = results.map(result => publicEvaluation(result));
  assert.doesNotThrow(() => assertFileWorkflowFinalCardinalityV1({
    selectedTaskIds: selected,
    results,
    evaluations,
  }));

  for (const invalid of [
    { results: [results[0]], evaluations },
    { results: [...results].reverse(), evaluations },
    { results, evaluations: [...evaluations].reverse() },
    { results: [results[0], results[0]], evaluations },
    { results, evaluations: [evaluations[0], evaluations[0]] },
  ]) {
    assert.throws(() => assertFileWorkflowFinalCardinalityV1({
      selectedTaskIds: selected,
      results: invalid.results,
      evaluations: invalid.evaluations,
    }), /cardinality|unique|order|task-ID set/i);
  }
});

test('materializes one ordered no_response result and evaluation for every pending task', () => {
  const run = binding('files-multi', 'run-exhausted', [
    'PAIR-Q-1',
    'PAIR-Q-2',
    'PAIR-A-3',
  ]);
  const transitions = materializeFileWorkflowNoResponseTransitionsV1({
    binding: run,
    sessionId: 'session-exhausted',
    terminalTick: 4,
    existingTaskIds: ['PAIR-Q-1'],
  });
  assert.deepEqual(transitions.map(row => row.taskId), ['PAIR-Q-2', 'PAIR-A-3']);
  assert.deepEqual(transitions.map(row => row.result.status), ['no_response', 'no_response']);
  assert.deepEqual(transitions.map(row => row.evaluation.publicEvaluation), [null, null]);
  assert.ok(transitions.every(row => row.evaluation.metrics.length === 0));
});

test('keeps private contact, MEMORY, snapshots, and full evaluation in a separate bounded schema', () => {
  const value = privateEvidence('PAIR-A-2', 'PRIVATE_MEMORY_SENTINEL');
  assert.deepEqual(fileWorkflowPrivateEvidenceV1Schema.parse(value), value);
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...value,
      contactRequests: [{
        ...value.contactRequests[0],
        message: 'x'.repeat(1_048_577),
      }],
    }),
    /too_big|at most|less than/i,
  );
});

test('accepts only the stable Task5 and Task6 contact failure codes', () => {
  const value = strictPrivateEvidence('PAIR-A-2');
  const { response: _response, ...contact } = value.contactRequests[0]!;
  for (const [status, errorCode] of [
    ['denied', 'CONTACT_REQUESTER_FILE_READ_REQUIRED'],
    ['denied', 'CONTACT_DUPLICATE_TASK'],
    ['failed', 'CONTACT_RESPONDER_FILE_READ_REQUIRED'],
  ] as const) {
    const parsedContact = fileWorkflowPrivateEvidenceV1Schema.parse({
      ...value,
      contactRequests: [{ ...contact, status, errorCode }],
    }).contactRequests[0];
    assert.ok(parsedContact && parsedContact.status !== 'completed');
    assert.equal(parsedContact.errorCode, errorCode);
  }
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...value,
      contactRequests: [{
        ...contact,
        status: 'failed',
        errorCode: 'PRIVATE_CREDENTIAL_SENTINEL',
      }],
    }),
    /errorCode|allow|invalid|enum/i,
  );
});

test('requires canonical Pair stores and full PACT evaluations in private evidence', () => {
  const valid = strictPrivateEvidence('PAIR-A-2');
  assert.deepEqual(fileWorkflowPrivateEvidenceV1Schema.parse(valid), valid);
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...valid,
      actionSnapshots: [{ ...valid.actionSnapshots[0], before: null, after: null }],
    }),
    /snapshot|store|object|required/i,
    'ACCEPTED_NULL_ACTION_SNAPSHOT',
  );
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...valid,
      fullEvaluations: [{
        ...valid.fullEvaluations[0],
        evaluation: { taskId: 'PAIR-A-2', kind: 'action' },
      }],
    }),
    /evaluation|required|invalid/i,
  );
  const prototypeStore = Object.assign(
    Object.create({ inheritedPrivateField: 'PRIVATE_PROTOTYPE_SENTINEL' }),
    pairStore('PAIR_STORE_SENTINEL'),
  );
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...valid,
      actionSnapshots: [{ ...valid.actionSnapshots[0], before: prototypeStore }],
    }),
    /prototype|plain|JSON/i,
  );
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...valid,
      actionSnapshots: [{
        ...valid.actionSnapshots[0],
        before: { ...pairStore('PAIR_STORE_SENTINEL'), version: Number.POSITIVE_INFINITY },
      }],
    }),
    /finite|number|store/i,
  );
});

test('requires the exact Task5 contact request/result and one Task4 decision shape', () => {
  const missingRequestAuthority = strictPrivateEvidence('PAIR-A-2') as Record<string, any>;
  delete missingRequestAuthority.contactRequests[0].requestTraceId;
  delete missingRequestAuthority.contactRequests[0].deadlineMs;
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse(missingRequestAuthority),
    /trace|deadline|required/i,
    'ACCEPTED_CONTACT_WITHOUT_REQUEST_TRACE_OR_DEADLINE',
  );

  const completedWithoutResponse = strictPrivateEvidence('PAIR-A-2') as Record<string, any>;
  delete completedWithoutResponse.contactRequests[0].response;
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse(completedWithoutResponse),
    /completed|response|required/i,
  );

  const failedWithResponse = strictPrivateEvidence('PAIR-A-2') as Record<string, any>;
  failedWithResponse.contactRequests[0].status = 'failed';
  failedWithResponse.contactRequests[0].errorCode = 'CONTACT_FAILED';
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse(failedWithResponse),
    /failed|response|unrecognized/i,
  );

  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...strictPrivateEvidence('PAIR-A-2'),
      tickDecisions: [{ arbitrary: 'PRIVATE_DECISION' }],
    }),
    /decision|type|required|union/i,
  );
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...strictPrivateEvidence('PAIR-A-2'),
      tickDecisions: [
        { type: 'completed', content: 'one', toolSteps: 0, contactCalls: 1 },
        { type: 'completed', content: 'two', toolSteps: 0, contactCalls: 1 },
      ],
    }),
    /decision|at most|array/i,
  );
});

test('uses the workspace byte ceiling and unit PACT-Pair metric contributions', () => {
  const oversized = binding('files-multi', 'oversized-file-binding', ['PAIR-Q-1']);
  oversized.actors.requester.initial['AGENT.md'].byteLength =
    MAX_AGENT_WORKSPACE_FILE_BYTES_V1 + 1;
  assert.throws(
    () => fileWorkflowRunBindingV1Schema.parse(oversized),
    /byte|too_big|at most|less than/i,
    'ACCEPTED_FILE_OVER_WORKSPACE_LIMIT',
  );

  const result = {
    ...publicResult('PAIR-Q-1', 'answered', 1),
    contactStatus: 'completed' as const,
    publicEvaluation: qaPublicEvaluation('PAIR-Q-1'),
  };
  const metrics = fixedMetricRows();
  metrics[0] = { ...metrics[0]!, numerator: 2, denominator: 2 };
  assert.throws(
    () => fileWorkflowPublicEvaluationRecordV1Schema.parse({
      apiVersion: 'sharedeval-file-evaluation/v1',
      workflowId: result.workflowId,
      runId: result.runId,
      sessionId: result.sessionId,
      taskId: result.taskId,
      publicEvaluation: result.publicEvaluation,
      metrics,
    }),
    /metric|unit|at most|less than/i,
    'ACCEPTED_NON_UNIT_METRIC_CONTRIBUTION',
  );
});

test('allows a current contact selection to differ from prior-task terminal transitions', () => {
  const payload = heartbeatPayload('run-heartbeat', 2, [
    transition('PAIR-A-1', 'error', 2, 'action'),
  ]);
  payload.selectedTaskId = 'PAIR-A-2';
  payload.correlatedContactId = 'recipient-trace-b';
  assert.doesNotThrow(
    () => fileWorkflowHeartbeatPayloadV1Schema.parse(payload),
    'CURRENT_CONTACT_B_REJECTED_WHILE_TERMINALIZING_PRIOR_A',
  );
});

test('rejects a same-version MEMORY transition instead of recording a no-op CAS', () => {
  const payload = heartbeatPayload('run-heartbeat', 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]);
  payload.memoryTransition = {
    ...payload.memoryTransition!,
    newVersion: payload.memoryTransition!.previousVersion,
    newSha256: payload.memoryTransition!.previousSha256,
  };
  assert.throws(
    () => fileWorkflowHeartbeatPayloadV1Schema.parse(payload),
    /MEMORY|version|advance|exact/i,
    'ACCEPTED_SAME_VERSION_MEMORY_TRANSITION',
  );
});

test('caps one heartbeat to one contact/snapshot and keeps full evaluations transition-bound', () => {
  const evidence = strictPrivateEvidence('PAIR-A-2');
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...evidence,
      contactRequests: [evidence.contactRequests[0], evidence.contactRequests[0]],
    }),
    /contact|at most|array/i,
    'ACCEPTED_MULTIPLE_CONTACTS_IN_ONE_HEARTBEAT',
  );
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      ...evidence,
      actionSnapshots: [evidence.actionSnapshots[0], evidence.actionSnapshots[0]],
    }),
    /snapshot|at most|array/i,
    'ACCEPTED_MULTIPLE_SNAPSHOTS_IN_ONE_HEARTBEAT',
  );
});

test('keeps this lane PACT-Pair-only and rejects injected per-task usage claims', () => {
  assert.throws(
    () => fileWorkflowRunBindingV1Schema.parse({
      ...binding('files-multi', 'foreign-dataset', ['PAIR-Q-1']),
      dataset: {
        ...binding('files-multi', 'foreign-dataset', ['PAIR-Q-1']).dataset,
        id: 'foreign-benchmark',
      },
    }),
    /pact-pair|dataset|literal/i,
    'ACCEPTED_FOREIGN_DATASET_IN_PACT_PAIR_FILE_LANE',
  );
  const result = publicResult('PAIR-Q-1', 'error', 1);
  assert.throws(
    () => fileWorkflowPublicResultV1Schema.parse({ ...result, usage: usage() }),
    /usage|unrecognized|key/i,
    'ACCEPTED_UNATTRIBUTABLE_PER_TASK_USAGE',
  );
});

test('strictly binds public event, summary, run, and checkpoint count relations', () => {
  const runBinding = binding('files-multi', 'projection-relations', ['PAIR-Q-1']);
  const event = {
    apiVersion: 'sharedeval-file-event/v1' as const,
    workflowId: 'files-multi' as const,
    runId: runBinding.runId,
    sequence: 0,
    eventId: 'event-1',
    sessionId: 'session-projection-relations',
    tick: 1,
    actorId: 'requester',
    traceId: 'trace-1',
    terminalTaskIds: ['PAIR-Q-1'],
    fileReadCount: 4,
    memoryCommitted: true,
    usage: usage(),
  };
  assert.deepEqual(fileWorkflowPublicEventV1Schema.parse(event), event);
  assert.throws(
    () => fileWorkflowPublicEventV1Schema.parse({ ...event, tick: 2 }),
    /tick|sequence/i,
  );
  assert.throws(
    () => fileWorkflowPublicEventV1Schema.parse({
      ...event,
      terminalTaskIds: ['PAIR-Q-1', 'PAIR-Q-1'],
    }),
    /terminal|unique|duplicate/i,
  );

  const summary = {
    apiVersion: 'sharedeval-file-summary/v1' as const,
    workflowId: 'files-multi' as const,
    runId: runBinding.runId,
    selectedTasks: 1,
    resultRows: 1,
    evaluationRows: 1,
    statuses: {
      answered: 0,
      refused: 0,
      error: 1,
      no_response: 0,
      side_effect_before_failure: 0,
    },
    metrics: fixedSummaryMetricRows(),
    usage: usage(),
  };
  assert.deepEqual(fileWorkflowSummaryV1Schema.parse(summary), summary);
  assert.throws(
    () => fileWorkflowSummaryV1Schema.parse({
      ...summary,
      statuses: { ...summary.statuses, error: 0 },
    }),
    /status|count|result/i,
  );
  assert.throws(
    () => fileWorkflowSummaryV1Schema.parse({
      ...summary,
      metrics: summary.metrics.slice(0, -1),
    }),
    /metric|exact|fixed/i,
  );

  const manifest = {
    apiVersion: 'sharedeval-file-run/v1' as const,
    workflowId: runBinding.workflowId,
    runId: runBinding.runId,
    status: 'running' as const,
    selectedTaskIds: runBinding.selectedTaskIds,
    selectedTasks: runBinding.selectedTasks,
    selectedTaskDigest: runBinding.selectedTaskDigest,
    dataset: runBinding.dataset,
    goldSet: runBinding.goldSet,
    policies: runBinding.policies,
    actors: runBinding.actors,
    backend: runBinding.backend,
    recordCount: 0,
    resultRows: 0,
    evaluationRows: 0,
  };
  assert.deepEqual(fileWorkflowRunManifestV1Schema.parse(manifest), manifest);
  assert.throws(
    () => fileWorkflowRunManifestV1Schema.parse({
      ...manifest,
      resultRows: 1,
    }),
    /result|evaluation|count/i,
  );

  const checkpoint = {
    apiVersion: 'sharedeval-file-checkpoint/v1' as const,
    workflowId: runBinding.workflowId,
    runId: runBinding.runId,
    status: 'running' as const,
    recordCount: 0,
    selectedTasks: 1,
    resultRows: 0,
    evaluationRows: 0,
    lastEventId: null,
    lastRecordDigest: null,
  };
  assert.deepEqual(fileWorkflowCheckpointV1Schema.parse(checkpoint), checkpoint);
  assert.throws(
    () => fileWorkflowCheckpointV1Schema.parse({
      ...checkpoint,
      lastEventId: 'foreign-event',
      lastRecordDigest: 'f'.repeat(64),
    }),
    /last|record|zero|null/i,
  );
});

test('heartbeat payload rejects foreign identities, duplicate transitions, and unbounded usage', () => {
  const payload = heartbeatPayload('run-heartbeat', 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]);
  assert.deepEqual(fileWorkflowHeartbeatPayloadV1Schema.parse(payload), payload);
  assert.throws(
    () => fileWorkflowHeartbeatPayloadV1Schema.parse({
      ...payload,
      transitions: [payload.transitions[0], payload.transitions[0]],
    }),
    /unique|duplicate/i,
  );
  assert.throws(
    () => fileWorkflowHeartbeatPayloadV1Schema.parse({
      ...payload,
      event: { ...payload.event, runId: '../foreign' },
    }),
    /opaque|invalid/i,
  );
  assert.throws(
    () => fileWorkflowHeartbeatPayloadV1Schema.parse({
      ...payload,
      usage: { ...payload.usage, modelCalls: Number.POSITIVE_INFINITY },
    }),
    /finite|number/i,
  );
});

test('uses the literal 600-task PACT-Pair bound across every evidence array', () => {
  const taskIds = Array.from({ length: 601 }, (_, index) => `PAIR-Q-${index + 1}`);
  assert.equal(
    fileWorkflowRunBindingV1Schema.parse(
      binding('files-multi', 'bound-600', taskIds.slice(0, 600)),
    ).selectedTaskIds.length,
    600,
  );
  assert.throws(
    () => fileWorkflowRunBindingV1Schema.parse(
      binding('files-multi', 'bound-601', taskIds),
    ),
    /600|too_big|at most|task/i,
    'ACCEPTED_601_SELECTED_TASKS',
  );

  const transitions = taskIds.map((taskId, index) => transition(taskId, 'error', index + 1));
  assert.equal(fileWorkflowHeartbeatPayloadV1Schema.parse(
    heartbeatPayload('transition-bound-600', 1, transitions.slice(0, 600)),
  ).transitions.length, 600);
  assert.throws(
    () => fileWorkflowHeartbeatPayloadV1Schema.parse(
      heartbeatPayload('transition-bound-601', 1, transitions),
    ),
    /600|too_big|at most|transition/i,
    'ACCEPTED_601_HEARTBEAT_TRANSITIONS',
  );

  const fullEvaluations = taskIds.map(taskId => ({
    taskId,
    evaluation: { ...fullActionEvaluation(taskId), kind: 'action' as const },
    metrics: fixedMetricRows(),
  }));
  for (const count of [64, 65, 600]) {
    assert.equal(fileWorkflowPrivateEvidenceV1Schema.parse({
      contactRequests: [],
      actionSnapshots: [],
      tickDecisions: [],
      fullEvaluations: fullEvaluations.slice(0, count),
    }).fullEvaluations.length, count);
  }
  assert.throws(
    () => fileWorkflowPrivateEvidenceV1Schema.parse({
      contactRequests: [],
      actionSnapshots: [],
      tickDecisions: [],
      fullEvaluations,
    }),
    /600|too_big|at most|evaluation/i,
    'ACCEPTED_601_FULL_EVALUATIONS',
  );
});

export function binding(
  workflowId: 'files-multi' | 'files-single',
  runId: string,
  selectedTaskIds: string[],
): FileWorkflowRunBindingV1 {
  const requesterFiles = fileSet('requester');
  const responderFiles = fileSet('responder');
  return {
    apiVersion: 'sharedeval-file-run-binding/v1',
    workflowId,
    runId,
    selectedTaskIds,
    selectedTasks: selectedTaskIds.map(taskId => ({
      taskId,
      kind: taskId.includes('-A-') ? 'action' as const : 'qa' as const,
    })),
    selectedTaskDigest: taskDigest(selectedTaskIds),
    dataset: {
      id: 'pact-pair',
      split: 'test',
      sourceRevision: 'a'.repeat(40),
    },
    goldSet: { id: 'pair-gold-v2', sha256: hex('gold-set-withheld') },
    policies: {
      requester: { id: 'ordered-public-task-queue', version: '1.0.0', sha256: hex('requester-policy') },
      responder: { id: 'D2R', version: '1.0.0', sha256: hex('responder-policy') },
    },
    actors: {
      requester: {
        actorId: 'requester',
        references: references('requester'),
        model: { provider: 'scripted', requestedModel: 'requester-v1', resolvedModel: 'requester-v1' },
        initial: requesterFiles,
      },
      responder: {
        actorId: 'responder',
        references: references('responder'),
        model: { provider: 'scripted', requestedModel: 'responder-v1', resolvedModel: 'responder-v1' },
        initial: responderFiles,
      },
    },
    backend: { adapterId: 'pact-public-runner', executor: 'scripted-harness' },
  };
}

export function heartbeatPayload(
  runId: string,
  tick: number,
  transitions: ReturnType<typeof transition>[],
  privateValue?: ReturnType<typeof privateEvidence>,
): any {
  return {
    event: {
      eventId: `event-${tick}`,
      runId,
      sessionId: `session-${runId}`,
      tick,
      actorId: 'requester',
      traceId: `trace-${tick}`,
    },
    selectedTaskId: transitions[0]?.taskId,
    fileReads: [
      receipt('requester', 'AGENT.md', 0),
      receipt('requester', 'HEARTBEAT.md', 0),
      receipt('requester', 'POLICY.md', 0),
      receipt('requester', 'MEMORY.md', Math.max(0, tick - 1)),
    ],
    memoryTransition: {
      actorId: 'requester',
      previousVersion: Math.max(0, tick - 1),
      newVersion: tick,
      previousSha256: hex(`memory-${tick - 1}`),
      newSha256: hex(`memory-${tick}`),
      byteLength: 24,
    },
    transitions,
    provider: {
      requester: { provider: 'scripted', requestedModel: 'requester-v1', resolvedModel: 'requester-v1' },
      responder: { provider: 'scripted', requestedModel: 'responder-v1', resolvedModel: 'responder-v1' },
    },
    usage: usage(),
    ...(privateValue ? { privateEvidence: privateValue } : {}),
  };
}

export function transition(
  taskId: string,
  status: 'answered' | 'refused' | 'error' | 'no_response' | 'side_effect_before_failure',
  terminalTick: number,
  kind: 'qa' | 'action' = taskId.includes('-A-') ? 'action' : 'qa',
) {
  const result = publicResult(taskId, status, terminalTick, kind);
  return {
    taskId,
    result,
    evaluation: publicEvaluation(result),
  };
}

function publicResult(
  taskId: string,
  status: 'answered' | 'refused' | 'error' | 'no_response' | 'side_effect_before_failure',
  terminalTick: number,
  kind: 'qa' | 'action' = 'qa',
) {
  return {
    apiVersion: 'sharedeval-file-result/v1' as const,
    workflowId: 'files-multi' as const,
    runId: 'run-heartbeat',
    sessionId: 'session-run-heartbeat',
    taskId,
    kind,
    status,
    terminalTick,
    ...(status === 'error' || status === 'side_effect_before_failure'
      ? { errorCode: 'FILE_SESSION_FAILED' }
      : {}),
    publicEvaluation: null,
    selectedTaskDigest: taskDigest(['PAIR-Q-1']),
    backend: { adapterId: 'pact-public-runner', executor: 'scripted-harness' },
  };
}

function publicEvaluation(result: ReturnType<typeof publicResult>) {
  return {
    apiVersion: 'sharedeval-file-evaluation/v1' as const,
    workflowId: result.workflowId,
    runId: result.runId,
    sessionId: result.sessionId,
    taskId: result.taskId,
    publicEvaluation: result.publicEvaluation,
    metrics: [],
  };
}

function qaPublicEvaluation(taskId: string) {
  return {
    taskId,
    kind: 'qa' as const,
    actualDecision: 'answer' as const,
    scorable: true,
    correct: true,
    factMatch: true,
    leaked: false,
    noLeak: true,
    benchmarkLeaked: false,
    benchmarkNoLeak: true,
  };
}

function actionPublicEvaluation(taskId: string) {
  return {
    taskId,
    kind: 'action' as const,
    actualDecision: 'answer' as const,
    scorable: true,
    correct: false,
    stateChanged: true,
    stateCorrect: false,
    noUnexpectedMutations: false,
    mutations: {
      metadataChanged: false,
      noteFoldersChanged: false,
      todoFoldersChanged: false,
      notes: { created: [], updated: [], removed: [] },
      todos: { created: [], updated: [], removed: [] },
    },
  };
}

function fixedMetricRows() {
  return PACT_PAIR_METRIC_NAMES_V1.map(metric => ({
    metric,
    numerator: 0,
    denominator: 0,
  }));
}

function fixedSummaryMetricRows() {
  return fixedMetricRows().map(metric => ({ ...metric, value: null }));
}

function strictPrivateEvidence(taskId: string) {
  return {
    contactRequests: [{
      taskId,
      senderId: 'requester',
      recipientId: 'responder',
      purpose: taskId,
      intent: 'perform action',
      message: 'PRIVATE_CONTACT_SENTINEL',
      requestTraceId: 'trace-1',
      deadlineMs: 1_000,
      recipientTraceId: 'recipient-trace',
      status: 'completed' as const,
      response: 'PRIVATE_RESPONSE_SENTINEL',
    }],
    actionSnapshots: [{
      taskId,
      contactId: 'recipient-trace',
      actorId: 'responder',
      eventId: 'event-1',
      before: pairStore('PRIVATE_BEFORE_SENTINEL'),
      after: pairStore('PRIVATE_AFTER_SENTINEL'),
    }],
    tickDecisions: [],
    fullEvaluations: [{
      taskId,
      evaluation: fullActionEvaluation(taskId),
      metrics: fixedMetricRows(),
    }],
  };
}

function fullActionEvaluation(taskId: string) {
  return {
    taskId,
    kind: 'action' as const,
    actualDecision: 'answer' as const,
    scorable: true,
    decisionCorrect: false,
    correct: false,
    reasons: ['PRIVATE_FULL_EVALUATION_SENTINEL'],
    expectedBehavior: 'execute' as const,
    benchmarkExpectedBehavior: 'execute' as const,
    stateChanged: true,
    stateCorrect: false,
    benchmarkStateCorrect: false,
    noUnexpectedMutations: false,
    goldCheckType: 'exact',
    mutations: actionPublicEvaluation(taskId).mutations,
  };
}

function pairStore(sentinel: string) {
  return {
    version: '1',
    description: 'private test store',
    owner: {
      name: 'Owner',
      role: 'Engineer',
      company: 'Example',
      background: 'Test fixture',
    },
    note_folders: [{
      id: 1,
      name: 'General',
      parentId: null,
      sensitivity: 'work_public',
    }],
    todo_folders: [{ id: 1, name: 'General', sensitivity: 'work_public' }],
    notes: [{ id: 1, folderId: 1, title: 'Evidence', content: sentinel }],
    todos: [{
      id: 1,
      title: 'Verify evidence',
      description: sentinel,
      folderId: 1,
      priority: 0,
      category: 'work_public' as const,
      completed: false as const,
      dueDate: '2026-08-25',
    }],
  };
}

function privateEvidence(taskId: string, memory: string) {
  const evidence = strictPrivateEvidence(taskId);
  return {
    ...evidence,
    memory: {
      actorId: 'requester',
      previousBytesBase64: Buffer.from('old memory').toString('base64'),
      newBytesBase64: Buffer.from(memory).toString('base64'),
    },
    tickDecisions: [{
      type: 'completed' as const,
      content: 'PRIVATE_DECISION_SENTINEL',
      toolSteps: 0,
      contactCalls: 1,
    }],
  };
}

function references(prefix: string) {
  return {
    agent: { id: `${prefix}-agent`, version: '1.0.0' },
    heartbeat: { id: `${prefix}-heartbeat`, version: '1.0.0' },
    policy: { id: `${prefix}-policy`, version: '1.0.0' },
    memory: { id: `${prefix}-memory`, version: '1.0.0' },
  };
}

function fileSet(prefix: string) {
  return {
    'AGENT.md': metadata('AGENT.md', `${prefix}-agent`),
    'HEARTBEAT.md': metadata('HEARTBEAT.md', `${prefix}-heartbeat`),
    'POLICY.md': metadata('POLICY.md', `${prefix}-policy`),
    'MEMORY.md': metadata('MEMORY.md', `${prefix}-memory`),
  };
}

function metadata<Path extends 'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md'>(
  path: Path,
  value: string,
): { path: Path; sha256: string; byteLength: number } {
  return { path, sha256: hex(value), byteLength: Buffer.byteLength(value) };
}

function receipt(
  actorId: string,
  path: 'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md',
  version: number,
) {
  const value = `${actorId}:${path}:${version}`;
  return { actorId, path, action: 'read' as const, version, sha256: hex(value), byteLength: value.length };
}

function usage() {
  return {
    modelCalls: 1,
    toolSteps: 4,
    contactCalls: 1,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: 0,
  };
}

function taskDigest(taskIds: string[]) {
  return createHash('sha256').update(JSON.stringify(taskIds)).digest('hex');
}

assert.equal(fileWorkflowSelectedTaskDigestV1(['PAIR-Q-1']), taskDigest(['PAIR-Q-1']));
