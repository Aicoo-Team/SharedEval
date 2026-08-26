import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256JsonV1, type JsonValue } from '../../src/contracts/json.js';
import {
  buildFileWorkflowHeartbeatPayloadV1,
  type BuildFileWorkflowHeartbeatPayloadV1Input,
} from '../../src/runner/v1/file-workflow-heartbeat.js';
import type { FileWorkflowSharedOsProjectionV1 } from '../../src/runner/v1/file-workflow-sharedos-evidence.js';
import {
  binding,
  heartbeatPayloadFor,
  memoryContent,
  pairStore,
  transition,
} from './file-workflow-test-fixtures.js';

test('assembles one durable heartbeat around the canonical SharedOS projection', () => {
  const input = answeredInput('builder-happy');
  const payload = buildFileWorkflowHeartbeatPayloadV1(input);
  assert.equal(payload.event.runId, 'builder-happy');
  assert.equal(payload.contactAuthority?.taskId, 'PAIR-Q-001');
  assert.equal(payload.transitions[0]?.result.status, 'answered');
  assert.equal(payload.transitions[0]?.result.publicEvaluation?.actualDecision, 'answer');
  assert.deepEqual(payload.usage, input.native.usage);
  assert.equal(payload.privateEvidence?.fullEvaluations.length, 1);
  assert.equal('selectedTaskId' in payload, false);
  assert.equal('correlatedContactId' in payload, false);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.privateEvidence?.sourceEvidence.auditEvents), true);
});

test('derives task kind and contact status instead of trusting obsolete caller fields', () => {
  const input: any = answeredInput('builder-derived-terminal-authority');
  input.terminalOutcomes[0].kind = 'action';
  input.terminalOutcomes[0].contactStatus = 'denied';

  const payload = buildFileWorkflowHeartbeatPayloadV1(input);

  assert.equal(payload.transitions[0]?.result.kind, 'qa');
  assert.equal(payload.transitions[0]?.result.contactStatus, 'completed');
});

test('uses prior contact authority for fatal fallback while MEMORY remains pending', () => {
  const runBinding = binding('files-multi', 'builder-history-fallback', ['PAIR-A-001']);
  const prior = projectionFor(runBinding, 1, {
    contact: {
      taskId: 'PAIR-A-001',
      message: 'perform action',
      status: 'completed',
      response: 'done',
    },
    actionSnapshot: { before: pairStore('before'), after: pairStore('after') },
  });
  const current = projectionFor(runBinding, 2);
  const input: BuildFileWorkflowHeartbeatPayloadV1Input = {
    binding: runBinding,
    sessionId: current.sessionId,
    heartbeat: current.heartbeat,
    native: current.native,
    history: {
      terminalTaskIds: [],
      contacts: [prior.native.currentContact!.authority],
    },
    terminalOutcomes: [{
      taskId: 'PAIR-A-001',
      status: 'side_effect_before_failure',
      contactId: prior.native.currentContact!.authority.contactId,
      errorCode: 'FILE_SESSION_FAILED',
      fullEvaluation: actionEvaluation('PAIR-A-001', true, 'none'),
    }],
    sessionStopReason: 'fatal_error',
  };
  const payload = buildFileWorkflowHeartbeatPayloadV1(input);
  assert.equal(payload.transitions[0]?.result.status, 'side_effect_before_failure');
  assert.equal(payload.memoryAuthorities[0]?.newRows[0]?.status, 'pending');
  assert.equal(payload.contactAuthority, undefined);
});

test('allows max-tick no-response fallback without a MEMORY commit', () => {
  const runBinding = binding('files-multi', 'builder-max-tick', ['PAIR-Q-001']);
  const current = projectionFor(runBinding, 1, { omitMemoryCommit: true });
  const input: any = baseInput(runBinding, current);
  input.terminalOutcomes = [{
    taskId: 'PAIR-Q-001',
    status: 'no_response',
    fullEvaluation: null,
  }];
  input.sessionStopReason = 'tick_exhausted';
  const payload = buildFileWorkflowHeartbeatPayloadV1(input);
  assert.equal(payload.transitions[0]?.result.status, 'no_response');
  assert.deepEqual(payload.memoryTransitions, []);
});

test('requires answered and refused results to have a same-turn terminal MEMORY delta', () => {
  const input: any = answeredInput('builder-missing-memory-delta');
  input.native.memoryTransitions = [];
  input.native.memoryAuthorities = [];
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(input),
    /answered.*same-turn MEMORY|same-turn MEMORY.*answered/i,
  );
});

test('rejects terminal MEMORY deltas that are not current terminal outcomes', () => {
  const runBinding = binding(
    'files-multi',
    'builder-extra-memory-delta',
    ['PAIR-Q-001', 'PAIR-Q-002'],
  );
  const current = projectionFor(runBinding, 1, {
    memoryStatuses: { 'PAIR-Q-001': 'answered', 'PAIR-Q-002': 'answered' },
    contact: {
      taskId: 'PAIR-Q-001',
      message: 'answer one',
      status: 'completed',
      response: 'one',
    },
  });
  const input: any = baseInput(runBinding, current);
  input.terminalOutcomes = [{
    taskId: 'PAIR-Q-001',
    status: 'answered',
    contactId: current.native.currentContact!.authority.contactId,
    fullEvaluation: qaEvaluation('PAIR-Q-001', 'answer'),
  }];
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(input),
    /MEMORY delta.*terminal outcome|terminal outcome.*MEMORY delta/i,
  );
});

test('requires a cancelled requester decision to end as fatal error', () => {
  const input: any = answeredInput('builder-cancelled-decision');
  input.native.retainedEvidence.tickDecisions[0] = {
    type: 'cancelled',
    reason: 'cancelled',
    toolSteps: input.native.retainedEvidence.tickDecisions[0].toolSteps,
    contactCalls: input.native.retainedEvidence.tickDecisions[0].contactCalls,
  };
  input.sessionStopReason = 'all_terminal';
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(input),
    /cancelled.*fatal_error/i,
  );
});

test('allows an ordinary denied requester admission only at a fatal boundary', () => {
  const runBinding = binding('files-multi', 'builder-denied-admission', ['PAIR-Q-001']);
  const current = projectionFor(runBinding, 1, { omitMemoryCommit: true });
  const input: any = baseInput(runBinding, current);
  input.native.sharedOsAuthority.requesterExecutionStatus = 'denied';
  input.native.retainedEvidence.requesterExecutionStatus = 'denied';
  input.native.retainedEvidence.tickDecisions = [];
  input.terminalOutcomes = [{
    taskId: 'PAIR-Q-001',
    status: 'error',
    errorCode: 'FILE_SESSION_FAILED',
    fullEvaluation: null,
  }];
  input.sessionStopReason = 'fatal_error';
  assert.doesNotThrow(() => buildFileWorkflowHeartbeatPayloadV1(input));

  input.sessionStopReason = 'all_terminal';
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(input),
    /non-succeeded.*fatal_error|denied.*fatal/i,
  );
});

test('enforces denied and cancelled contact mappings', () => {
  const denied: any = answeredInput('builder-denied-mapping');
  denied.native.currentContact.authority.status = 'denied';
  denied.native.currentContact.authority.errorCode = 'CONTACT_RESPONDER_DENIED';
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(denied),
    /denied.*refused|MEMORY.*contact authority/i,
  );

  const cancelled: any = answeredInput('builder-cancelled-mapping');
  cancelled.native.currentContact.authority.status = 'cancelled';
  cancelled.native.currentContact.authority.errorCode = 'CONTACT_CANCELLED';
  delete cancelled.native.currentContact.authority.replyMessageId;
  cancelled.terminalOutcomes[0] = {
    taskId: 'PAIR-Q-001',
    status: 'error',
    contactId: cancelled.native.currentContact.authority.contactId,
    errorCode: 'FILE_SESSION_FAILED',
    fullEvaluation: null,
  };
  cancelled.sessionStopReason = 'fatal_error';
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(cancelled),
    /CONTACT_CANCELLED|terminal error code.*contact/i,
  );
});

test('validates selected order, prior terminal authority, and stop cardinality', () => {
  const runBinding = binding(
    'files-multi',
    'builder-terminal-set',
    ['PAIR-Q-001', 'PAIR-Q-002'],
  );
  const current = projectionFor(runBinding, 2, { omitMemoryCommit: true });
  const input: any = baseInput(runBinding, current);
  input.history.terminalTaskIds = ['PAIR-Q-001'];
  input.terminalOutcomes = [{
    taskId: 'PAIR-Q-002',
    status: 'error',
    errorCode: 'FILE_SESSION_FAILED',
    fullEvaluation: null,
  }];
  input.sessionStopReason = 'fatal_error';
  assert.doesNotThrow(() => buildFileWorkflowHeartbeatPayloadV1(input));

  input.history.terminalTaskIds = ['PAIR-Q-002'];
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(input),
    /disjoint|prior terminal|selected.*order/i,
  );
});

test('rejects a current contact for a task that is already terminal in history', () => {
  const runBinding = binding(
    'files-multi',
    'builder-contacted-terminal-task',
    ['PAIR-Q-001', 'PAIR-Q-002'],
  );
  const current = projectionFor(runBinding, 2, {
    contact: {
      taskId: 'PAIR-Q-001',
      message: 'contact terminal task again',
      status: 'completed',
      response: 'duplicate',
    },
  });
  const input: any = baseInput(runBinding, current);
  input.history.terminalTaskIds = ['PAIR-Q-001'];
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(input),
    /current contact.*terminal|terminal.*current contact/i,
  );
});

test('preserves changed-action and denied-contact fallback authority', () => {
  const actionBinding = binding('files-multi', 'builder-changed-action-error', ['PAIR-A-001']);
  const changed = projectionFor(actionBinding, 1, {
    contact: {
      taskId: 'PAIR-A-001',
      message: 'change state',
      status: 'completed',
      response: 'changed',
    },
    actionSnapshot: { before: pairStore('before'), after: pairStore('after') },
  });
  const changedInput: any = baseInput(actionBinding, changed);
  changedInput.terminalOutcomes = [{
    taskId: 'PAIR-A-001',
    status: 'error',
    contactId: changed.native.currentContact!.authority.contactId,
    errorCode: 'FILE_SESSION_FAILED',
    fullEvaluation: null,
  }];
  changedInput.sessionStopReason = 'fatal_error';
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(changedInput),
    /changed action.*side_effect_before_failure|side_effect_before_failure.*changed action/i,
  );

  const deniedBinding = binding('files-multi', 'builder-denied-error-code', ['PAIR-Q-001']);
  const denied = projectionFor(deniedBinding, 1, {
    omitMemoryCommit: true,
    contact: {
      taskId: 'PAIR-Q-001',
      message: 'denied contact',
      status: 'denied',
      errorCode: 'CONTACT_RESPONDER_DENIED',
    },
  });
  const deniedInput: any = baseInput(deniedBinding, denied);
  deniedInput.terminalOutcomes = [{
    taskId: 'PAIR-Q-001',
    status: 'error',
    contactId: denied.native.currentContact!.authority.contactId,
    errorCode: 'FILE_SESSION_FAILED',
    fullEvaluation: null,
  }];
  deniedInput.sessionStopReason = 'fatal_error';
  assert.throws(
    () => buildFileWorkflowHeartbeatPayloadV1(deniedInput),
    /CONTACT_RESPONDER_DENIED|contact failure code/i,
  );
});

test('does not mutate its projection and returns an independent deep-frozen payload', () => {
  const input = answeredInput('builder-immutability');
  const before = structuredClone(input);
  const payload = buildFileWorkflowHeartbeatPayloadV1(input);
  assert.deepEqual(input, before);
  assert.notEqual(payload.privateEvidence, input.native.retainedEvidence);
  assert.throws(() => {
    (payload.transitions as any[]).push(payload.transitions[0]);
  }, TypeError);
});

function answeredInput(runId: string): BuildFileWorkflowHeartbeatPayloadV1Input {
  const runBinding = binding('files-multi', runId, ['PAIR-Q-001']);
  const current = projectionFor(runBinding, 1, {
    memoryStatuses: { 'PAIR-Q-001': 'answered' },
    contact: {
      taskId: 'PAIR-Q-001',
      message: 'please answer',
      status: 'completed',
      response: 'authorized answer',
    },
  });
  const input: any = baseInput(runBinding, current);
  input.terminalOutcomes = [{
    taskId: 'PAIR-Q-001',
    status: 'answered',
    contactId: current.native.currentContact!.authority.contactId,
    fullEvaluation: qaEvaluation('PAIR-Q-001', 'answer'),
  }];
  input.sessionStopReason = 'all_terminal';
  return input;
}

function baseInput(
  runBinding: ReturnType<typeof binding>,
  current: ReturnType<typeof projectionFor>,
): BuildFileWorkflowHeartbeatPayloadV1Input {
  return {
    binding: runBinding,
    sessionId: current.sessionId,
    heartbeat: current.heartbeat,
    native: current.native,
    history: { terminalTaskIds: [], contacts: [] },
    terminalOutcomes: [],
  };
}

function projectionFor(
  runBinding: ReturnType<typeof binding>,
  tick: number,
  options: Readonly<{
    memoryStatuses?: Readonly<Record<string, 'pending' | 'answered' | 'refused' | 'error'>>;
    omitMemoryCommit?: boolean;
    contact?: Readonly<{
      taskId: string;
      message: string;
      status: 'completed' | 'denied' | 'failed' | 'cancelled';
      response?: string;
      errorCode?: string;
    }>;
    actionSnapshot?: Readonly<{
      before: ReturnType<typeof pairStore>;
      after: ReturnType<typeof pairStore>;
    }>;
  }> = {},
) {
  const memoryStatuses = options.memoryStatuses ?? {};
  const terminalRows = Object.entries(memoryStatuses).flatMap(([taskId, status]) => (
    status === 'answered' || status === 'refused'
      ? [transition(taskId, status, tick)]
      : []
  ));
  const previousMemory = memoryContent(runBinding.selectedTaskIds, Math.max(0, tick - 1));
  const nextMemory = memoryContent(runBinding.selectedTaskIds, tick, memoryStatuses);
  const actionSnapshots = options.actionSnapshot && options.contact ? [{
    taskId: options.contact.taskId,
    contactId: `request-message-${tick}`,
    actorId: runBinding.actors.responder.actorId,
    eventId: `event-${tick}`,
    before: options.actionSnapshot.before,
    after: options.actionSnapshot.after,
  }] : [];
  const payload: any = heartbeatPayloadFor(runBinding, tick, terminalRows, {
    ...(options.contact ? { contact: options.contact } : {}),
    ...(!options.omitMemoryCommit ? {
      requesterMemory: {
        previousBytesBase64: Buffer.from(previousMemory).toString('base64'),
        newBytesBase64: Buffer.from(nextMemory).toString('base64'),
      },
    } : {}),
    actionSnapshots,
  });
  if (options.omitMemoryCommit) {
    const operations = payload.privateEvidence.sourceEvidence.requesterFileOperations;
    const removedOperationIds = new Set(operations.flatMap((row: any) => (
      row.action === 'replace' ? [row.operationId] : []
    )));
    payload.privateEvidence.sourceEvidence.requesterFileOperations = operations.filter(
      (row: any) => row.action !== 'replace',
    );
    payload.privateEvidence.sourceEvidence.auditEvents =
      payload.privateEvidence.sourceEvidence.auditEvents.filter(
        (event: any) => !removedOperationIds.has(event.operationId),
      );
    payload.sharedOsAuthority.audit.lastSequence =
      payload.sharedOsAuthority.audit.firstSequence
      + payload.privateEvidence.sourceEvidence.auditEvents.length - 1;
    payload.sharedOsAuthority.audit.sha256 = sha256JsonV1(
      payload.privateEvidence.sourceEvidence.auditEvents as JsonValue,
    );
    payload.usage.toolSteps -= removedOperationIds.size;
    for (const decision of payload.privateEvidence.tickDecisions) {
      decision.toolSteps -= removedOperationIds.size;
    }
    payload.memoryTransitions = [];
    payload.memoryAuthorities = [];
  }
  const { fullEvaluations: _fullEvaluations, ...retainedEvidence } =
    structuredClone(payload.privateEvidence);
  const native: FileWorkflowSharedOsProjectionV1 = {
    ...(payload.contactAuthority ? {
      currentContact: {
        authority: structuredClone(payload.contactAuthority),
        ...(options.contact?.response === undefined
          ? {}
          : { response: options.contact.response }),
      },
    } : {}),
    fileReads: structuredClone(payload.fileReads),
    memoryTransitions: structuredClone(payload.memoryTransitions),
    memoryAuthorities: structuredClone(payload.memoryAuthorities),
    sharedOsAuthority: structuredClone(payload.sharedOsAuthority),
    provider: structuredClone(payload.provider),
    usage: structuredClone(payload.usage),
    retainedEvidence,
  };
  return {
    native,
    sessionId: payload.event.sessionId as string,
    heartbeat: {
      eventId: payload.event.eventId as string,
      tick: payload.event.tick as number,
      traceId: payload.event.traceId as string,
      inputDigest: payload.inputDigest as string,
    },
  };
}

function qaEvaluation(taskId: string, actualDecision: 'answer' | 'refuse') {
  return {
    taskId,
    kind: 'qa' as const,
    expectedBehavior: actualDecision,
    benchmarkExpectedBehavior: actualDecision,
    actualDecision,
    scorable: true,
    decisionCorrect: true,
    correct: true,
    reasons: [],
    factMatch: actualDecision === 'answer',
    minimumCorrectMatched: actualDecision === 'answer',
    matchedFacts: actualDecision === 'answer' ? ['fact'] : [],
    missedFacts: [],
    leakedFacts: [],
    leaked: false,
    noLeak: true,
    benchmarkLeaked: false,
    benchmarkNoLeak: true,
  };
}

function actionEvaluation(
  taskId: string,
  stateChanged: boolean,
  actualDecision: 'answer' | 'none',
) {
  return {
    taskId,
    kind: 'action' as const,
    expectedBehavior: 'execute' as const,
    benchmarkExpectedBehavior: 'execute' as const,
    actualDecision,
    scorable: true,
    decisionCorrect: actualDecision === 'answer',
    correct: actualDecision === 'answer',
    reasons: [],
    stateChanged,
    stateCorrect: actualDecision === 'answer',
    benchmarkStateCorrect: actualDecision === 'answer',
    noUnexpectedMutations: true,
    goldCheckType: 'note_created' as const,
    mutations: {
      metadataChanged: false,
      noteFoldersChanged: false,
      todoFoldersChanged: false,
      notes: { created: stateChanged ? [2] : [], updated: [], removed: [] },
      todos: { created: [], updated: [], removed: [] },
    },
  };
}
