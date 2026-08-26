import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256JsonV1, stableIdV1, type JsonValue } from '../../src/contracts/json.js';
import {
  projectFileWorkflowRetainedSharedOsEvidenceV1,
  projectFileWorkflowSharedOsEvidenceV1,
  type ProjectFileWorkflowSharedOsEvidenceV1Input,
} from '../../src/runner/v1/file-workflow-sharedos-evidence.js';
import type { SharedOsFileTurnResultV1 } from '../../src/runner/v1/sharedos-file-session-contracts.js';
import {
  binding,
  heartbeatPayloadFor,
  memoryContent,
  pairStore,
  transition,
} from './file-workflow-test-fixtures.js';

test('projects one native SharedOS turn without inventing resource invocations', () => {
  const input = nativeQaInput('projector-happy');

  const projected = projectFileWorkflowSharedOsEvidenceV1(input);

  assert.equal(projected.currentContact?.authority.taskId, 'PAIR-Q-001');
  assert.equal(projected.currentContact?.response, 'authorized answer');
  assert.deepEqual(
    projected.memoryTransitions.map(row => row.actorId),
    ['requester', 'responder'],
  );
  assert.equal(projected.fileReads.length, 8);
  assert.equal(projected.sharedOsAuthority.requesterExecutionStatus, 'succeeded');
  assert.equal(projected.provider.responder?.requestedModel, 'responder-v1');
  assert.equal(projected.usage.contactCalls, 1);
  assert.equal(projected.retainedEvidence.sourceEvidence.auditEvents.some(
    event => event.type === 'resource.invoked',
  ), false);
  assert.equal('fullEvaluations' in projected.retainedEvidence, false);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.retainedEvidence.sourceEvidence.auditEvents), true);
});

test('reprojects durable retained evidence without fabricating live turn projections', () => {
  const input = nativeQaInput('projector-retained');
  const live = projectFileWorkflowSharedOsEvidenceV1(input);

  const retained = projectFileWorkflowRetainedSharedOsEvidenceV1({
    binding: input.binding,
    event: input.event,
    retainedEvidence: live.retainedEvidence,
    sharedOsAuthority: live.sharedOsAuthority,
    contactAuthority: live.currentContact!.authority,
  });

  assert.deepEqual(retained, live);

  const wrongRequesterReads: any = nativeQaInput('projector-live-requester-reads');
  wrongRequesterReads.turn.requesterReads = [];
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(wrongRequesterReads),
    /requester read projection/i,
  );

  const wrongResponderReads: any = nativeQaInput('projector-live-responder-reads');
  wrongResponderReads.turn.contact.responderReads = [];
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(wrongResponderReads),
    /responder read projection/i,
  );

  for (const role of ['requester', 'responder'] as const) {
    const missing: any = nativeQaInput(`projector-live-missing-${role}-reads`);
    if (role === 'requester') delete missing.turn.requesterReads;
    else delete missing.turn.contact.responderReads;
    assert.throws(
      () => projectFileWorkflowSharedOsEvidenceV1(missing),
      /live.*read claim/i,
      role,
    );
  }
});

test('requires the accepted request before responder admission', () => {
  const input: any = nativeQaInput('projector-message-order');
  const events = input.turn.sourceEvidence.auditEvents;
  const responderAdmissionIndex = events.findIndex((event: any) => (
    event.type === 'authorization.checked'
    && event.resource?.namespace === 'sharedos.execution'
    && event.actor.agentId === 'responder'
  ));
  const admissionPair = events.splice(responderAdmissionIndex - 1, 2);
  const shiftedRequestIndex = events.findIndex((event: any) => (
    event.type === 'message.sent' && event.operationId !== undefined
  ));
  events.splice(shiftedRequestIndex, 0, ...admissionPair);
  refreshAudit(input);

  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(input),
    /accepted request.*responder admission|responder admission.*accepted request/i,
  );
});

test('requires requester file work before opening the accepted contact', () => {
  const input: any = nativeQaInput('projector-requester-read-precondition');
  const requesterOperationIds = new Set(
    input.turn.sourceEvidence.requesterFileOperations.map(
      (operation: any) => operation.operationId,
    ),
  );
  const requesterFileEvents = input.turn.sourceEvidence.auditEvents.filter(
    (event: any) => requesterOperationIds.has(event.operationId),
  );
  input.turn.sourceEvidence.auditEvents = input.turn.sourceEvidence.auditEvents.filter(
    (event: any) => !requesterOperationIds.has(event.operationId),
  );
  const requestToolIndex = input.turn.sourceEvidence.auditEvents.findIndex(
    (event: any) => event.type === 'tool.invoked' && event.tool === 'messages.request',
  );
  input.turn.sourceEvidence.auditEvents.splice(
    requestToolIndex + 1,
    0,
    ...requesterFileEvents,
  );
  refreshAudit(input);

  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(input),
    /requester.*file.*before.*contact|contact.*requires.*requester.*file/i,
  );

  const reread: any = nativeQaInput('projector-requester-post-contact-reread');
  const receipt = structuredClone(reread.turn.sourceEvidence.requesterFileOperations[0]);
  receipt.operationId = 'requester-post-contact-reread';
  receipt.version = 1;
  reread.turn.sourceEvidence.requesterFileOperations.push(receipt);
  reread.turn.requesterReads.push({
    actorId: receipt.actorId,
    path: receipt.path,
    action: 'read',
    version: receipt.version,
    sha256: receipt.sha256,
    byteLength: receipt.byteLength,
  });
  const templateAuthorization = reread.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'authorization.checked'
    && event.resource?.namespace === 'files'
    && event.actor.agentId === 'requester'
  ));
  const templateTool = reread.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'tool.invoked'
    && event.operationId === templateAuthorization.operationId
  ));
  const grantId = 'grant-requester-post-contact-reread';
  reread.turn.sourceEvidence.auditEvents.push({
    ...structuredClone(templateAuthorization),
    operationId: receipt.operationId,
    grantId,
  }, {
    ...structuredClone(templateTool),
    operationId: receipt.operationId,
    grantId,
  });
  reread.turn.decision.toolSteps += 1;
  refreshAudit(reread);
  assert.doesNotThrow(() => projectFileWorkflowSharedOsEvidenceV1(reread));
});

test('rejects foreign actors and trusted-service impersonation in the audit window', () => {
  const cases: Array<[string, (input: any) => void]> = [
    ['actor', input => {
      input.turn.sourceEvidence.auditEvents[0].actor = { kind: 'agent', agentId: 'foreign' };
    }],
    ['authority', input => {
      input.turn.sourceEvidence.auditEvents[0].authority = {
        kind: 'agent',
        agentId: 'requester',
      };
    }],
    ['owner', input => {
      input.turn.sourceEvidence.auditEvents[0].owner = {
        kind: 'service',
        serviceId: 'foreign',
      };
    }],
  ];
  for (const [name, mutate] of cases) {
    const input: any = nativeQaInput(`projector-foreign-${name}`);
    mutate(input);
    refreshAudit(input);
    assert.throws(
      () => projectFileWorkflowSharedOsEvidenceV1(input),
      /foreign actor, authority, owner, or context/i,
      name,
    );
  }

  const wrongPhaseHash: any = nativeQaInput('projector-authority-phase-hash');
  const fileAuthorization = wrongPhaseHash.turn.sourceEvidence.auditEvents.find(
    (event: any) => event.type === 'authorization.checked'
      && event.resource?.namespace === 'files',
  );
  fileAuthorization.authorityHash = 'f'.repeat(64);
  refreshAudit(wrongPhaseHash);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(wrongPhaseHash),
    /authority hash.*phase|phase.*authority hash/i,
  );
});

test('requires canonical audit sequence and requester terminal-status runtime shapes', () => {
  const negativeSequence: any = nativeQaInput('projector-negative-audit-sequence');
  negativeSequence.turn.audit.firstSequence = -1;
  negativeSequence.turn.audit.lastSequence =
    negativeSequence.turn.sourceEvidence.auditEvents.length - 2;
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(negativeSequence),
    /audit.*non-negative safe|sequence.*non-negative safe/i,
  );

  const invalidStatus: any = nativeQaInput('projector-invalid-execution-status');
  invalidStatus.turn.executionStatus = 'invented-status';
  invalidStatus.turn.decision = null;
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(invalidStatus),
    /requester execution status.*invalid|invalid.*execution status/i,
  );
});

test('requires one phase-bound catalog before each admitted turn does tool work', () => {
  const missing: any = nativeQaInput('projector-missing-catalog');
  missing.turn.sourceEvidence.auditEvents = missing.turn.sourceEvidence.auditEvents.filter(
    (event: any) => !(event.type === 'tool.catalog.listed' && event.actor.agentId === 'responder'),
  );
  refreshAudit(missing);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(missing),
    /admission requires one.*tool catalog|tool catalog.*admission/i,
  );

  const wrongTools: any = nativeQaInput('projector-wrong-catalog-tools');
  const requesterCatalog = wrongTools.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'tool.catalog.listed' && event.actor.agentId === 'requester'
  ));
  requesterCatalog.metadata.visibleTools.push('search_notes');
  refreshAudit(wrongTools);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(wrongTools),
    /requester.*catalog.*non-canonical|non-canonical.*requester.*catalog/i,
  );
});

test('separates trusted router disposition from the real e6 request-tool partition', () => {
  const failed: any = nativeQaInput('projector-generic-router-failure');
  convertCompletedContactToFailed(failed, 'CONTACT_RESPONDER_FAILED');
  assert.equal(
    projectFileWorkflowSharedOsEvidenceV1(failed).currentContact?.authority.status,
    'failed',
  );

  failed.turn.contact.errorCode = 'CONTACT_DUPLICATE_TASK';
  assert.doesNotThrow(() => projectFileWorkflowSharedOsEvidenceV1(failed));

  const innerCancelled: any = structuredClone(failed);
  innerCancelled.turn.contact.status = 'cancelled';
  innerCancelled.turn.contact.errorCode = 'CONTACT_CANCELLED';
  assert.equal(
    projectFileWorkflowSharedOsEvidenceV1(innerCancelled).currentContact?.authority.status,
    'cancelled',
  );

  const outerCancelled: any = structuredClone(innerCancelled);
  outerCancelled.turn.executionStatus = 'cancelled';
  outerCancelled.turn.decision = null;
  outerCancelled.turn.sourceEvidence.auditEvents = outerCancelled.turn.sourceEvidence.auditEvents.filter(
    (event: any) => !(event.type === 'tool.invoked' && event.tool === 'messages.request'),
  );
  refreshAudit(outerCancelled);
  assert.equal(
    projectFileWorkflowSharedOsEvidenceV1(outerCancelled).currentContact?.authority.status,
    'cancelled',
  );

  const terminalizedCancel: any = structuredClone(outerCancelled);
  const requestMessage = terminalizedCancel.turn.sourceEvidence.acceptedMessages[0];
  const requestSent = terminalizedCancel.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'message.sent' && event.messageId === requestMessage.id
  ));
  const requestAuthorization = terminalizedCancel.turn.sourceEvidence.auditEvents.find(
    (event: any) => event.type === 'authorization.checked'
      && event.operationId === requestSent.operationId,
  );
  terminalizedCancel.turn.sourceEvidence.auditEvents.push({
    ...structuredClone(requestAuthorization),
    type: 'tool.invoked',
    outcome: 'failed',
    tool: 'messages.request',
    reason: 'message_reply_resolution_failed',
  });
  refreshAudit(terminalizedCancel);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(terminalizedCancel),
    /request tool reason causality|request.*exact authorization/i,
  );
});

test('retains one ordinary denied admission with bound zero driver telemetry', () => {
  const input: any = nativeDeniedInput('projector-denied-admission');

  const projected = projectFileWorkflowSharedOsEvidenceV1(input);

  assert.equal(projected.sharedOsAuthority.requesterExecutionStatus, 'denied');
  assert.deepEqual(projected.fileReads, []);
  assert.deepEqual(projected.usage, {
    modelCalls: 0,
    toolSteps: 0,
    contactCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  });

  const extraCatalog = structuredClone(input.turn.sourceEvidence.auditEvents[0]);
  extraCatalog.type = 'tool.catalog.listed';
  extraCatalog.outcome = 'succeeded';
  extraCatalog.metadata = { visibleTools: [] };
  input.turn.sourceEvidence.auditEvents.push(extraCatalog);
  refreshAudit(input);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(input),
    /denied.*catalog|denied admission.*driver|exact ordinary denied/i,
  );
});

test('requires native file authorization followed by the canonical file tool only', () => {
  const mismatchedGrant: any = nativeQaInput('projector-file-grant');
  const fileTool = mismatchedGrant.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'tool.invoked' && event.tool === 'files.read'
  ));
  fileTool.grantId = 'foreign-grant';
  refreshAudit(mismatchedGrant);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(mismatchedGrant),
    /authorization-to-tool causality/i,
  );

  const inventedResource: any = nativeQaInput('projector-resource-invocation');
  inventedResource.turn.sourceEvidence.auditEvents.push({
    ...structuredClone(inventedResource.turn.sourceEvidence.auditEvents[0]),
    type: 'resource.invoked',
    outcome: 'succeeded',
    resource: {
      namespace: 'files',
      path: ['MEMORY.md'],
      owner: { kind: 'service', serviceId: 'sharedeval' },
    },
    action: 'read',
    operationId: 'invented-resource-operation',
  });
  refreshAudit(inventedResource);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(inventedResource),
    /must not invent resource\.invoked/i,
  );

  const foreignImmutableBytes: any = nativeQaInput('projector-immutable-file-binding');
  const operation = foreignImmutableBytes.turn.sourceEvidence.requesterFileOperations.find(
    (row: any) => row.action === 'read' && row.path === 'AGENT.md',
  );
  operation.sha256 = 'f'.repeat(64);
  operation.byteLength += 1;
  const projectedRead = foreignImmutableBytes.turn.requesterReads.find(
    (row: any) => row.path === 'AGENT.md',
  );
  projectedRead.sha256 = operation.sha256;
  projectedRead.byteLength = operation.byteLength;
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(foreignImmutableBytes),
    /immutable file.*run binding|run binding.*immutable file/i,
  );
});

test('binds stable request and reply identities to their native message gates', () => {
  const wrongRequest: any = nativeQaInput('projector-request-id');
  const source = wrongRequest.turn.sourceEvidence;
  const request = source.acceptedMessages[0];
  const reply = source.acceptedMessages[1];
  const oldRequestId = request.id;
  const oldReplyId = reply.id;
  request.id = `message-${'a'.repeat(40)}`;
  reply.replyTo = request.id;
  reply.id = stableIdV1('message', ['message-reply', request.id]);
  wrongRequest.turn.contact.requestMessageId = request.id;
  wrongRequest.turn.contact.replyMessageId = reply.id;
  wrongRequest.turn.contact.responderExecutionId = stableIdV1('execution', [
    'responder-execution',
    request.id,
    'responder',
  ]);
  for (const event of source.auditEvents) {
    if (event.messageId === oldRequestId) event.messageId = request.id;
    if (event.messageId === oldReplyId) event.messageId = reply.id;
  }
  refreshAudit(wrongRequest);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(wrongRequest),
    /request message identity.*tool call/i,
  );

  const replyOperation: any = nativeQaInput('projector-reply-gate');
  const replyAuthorization = replyOperation.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'authorization.checked'
    && event.actor.agentId === 'responder'
    && event.resource?.namespace === 'sharedos.messaging'
  ));
  replyAuthorization.operationId = 'forbidden-direct-reply-operation';
  refreshAudit(replyOperation);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(replyOperation),
    /reply lacks exact direct-send authorization/i,
  );
});

test('counts denied request attempts without fabricating accepted messages', () => {
  const input: any = nativeQaInput('projector-denied-attempt');
  const events = input.turn.sourceEvidence.auditEvents;
  const base = structuredClone(events[0]);
  events.push({
    ...base,
    type: 'authorization.checked',
    outcome: 'denied',
    resource: { namespace: 'sharedos.messaging', path: [] },
    action: 'send',
    reason: 'capability usage exhausted',
  });
  events.push({
    ...base,
    type: 'tool.invoked',
    outcome: 'denied',
    operationId: 'denied-contact-call',
    tool: 'messages.request',
    reason: 'capability usage exhausted',
  });
  input.turn.decision.toolSteps += 1;
  input.turn.decision.contactCalls += 1;
  refreshAudit(input);

  const projected = projectFileWorkflowSharedOsEvidenceV1(input);

  assert.equal(projected.usage.contactCalls, 2);
  assert.equal(projected.retainedEvidence.sourceEvidence.acceptedMessages.length, 2);

  events.at(-1).outcome = 'succeeded';
  refreshAudit(input);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(input),
    /successful messages\.request.*accepted durable request/i,
  );
});

test('rejects extra successful message rows even when they reuse an accepted ID', () => {
  const input: any = nativeQaInput('projector-duplicate-message-row');
  const requestSent = input.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'message.sent' && event.operationId !== undefined
  ));
  input.turn.sourceEvidence.auditEvents.push({
    ...structuredClone(requestSent),
    actor: { kind: 'agent', agentId: 'responder' },
    receiver: { kind: 'agent', agentId: 'requester' },
  });
  refreshAudit(input);

  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(input),
    /extra successful message|exact.*message.*cardinality|unretained accepted message/i,
  );
});

test('requires a preceding exact MEMORY read and telemetry-derived usage', () => {
  const reordered: any = nativeQaInput('projector-memory-order');
  const operations = reordered.turn.sourceEvidence.requesterFileOperations;
  const replaceIndex = operations.findIndex((row: any) => row.action === 'replace');
  const [replace] = operations.splice(replaceIndex, 1);
  operations.unshift(replace);
  const events = reordered.turn.sourceEvidence.auditEvents;
  const replaceEvents = events.filter((event: any) => (
    event.operationId === replace.operationId
  ));
  reordered.turn.sourceEvidence.auditEvents = events.filter((event: any) => (
    event.operationId !== replace.operationId
  ));
  const catalogIndex = reordered.turn.sourceEvidence.auditEvents.findIndex((event: any) => (
    event.type === 'tool.catalog.listed'
    && event.actor.agentId === 'requester'
  ));
  reordered.turn.sourceEvidence.auditEvents.splice(catalogIndex + 1, 0, ...replaceEvents);
  refreshAudit(reordered);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(reordered),
    /preceding same-turn read/i,
  );

  const telemetry: any = nativeQaInput('projector-telemetry');
  telemetry.turn.providerUsage.totals.totalTokens += 1;
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(telemetry),
    /telemetry totals/i,
  );
});

test('retains an upstream routing provider independently from the configured transport', () => {
  const routed: any = nativeQaInput('projector-upstream-provider');
  routed.turn.providerUsage.requests[0].provider = 'Novita';

  assert.doesNotThrow(() => projectFileWorkflowSharedOsEvidenceV1(routed));
});

test('requires complete requester and responder four-file reads for an accepted contact', () => {
  for (const [actorId, path] of [
    ['requester', 'HEARTBEAT.md'],
    ['responder', 'POLICY.md'],
  ] as const) {
    const input: any = nativeQaInput(`projector-${actorId}-read-coverage`);
    const operations = actorId === 'requester'
      ? input.turn.sourceEvidence.requesterFileOperations
      : input.turn.sourceEvidence.responderFileOperations;
    const index = operations.findIndex((operation: any) => (
      operation.action === 'read' && operation.path === path
    ));
    const [removed] = operations.splice(index, 1);
    input.turn.sourceEvidence.auditEvents = input.turn.sourceEvidence.auditEvents.filter(
      (event: any) => event.operationId !== removed.operationId,
    );
    if (actorId === 'requester') {
      input.turn.requesterReads = input.turn.requesterReads.filter(
        (receipt: any) => receipt.path !== path,
      );
      input.turn.decision.toolSteps -= 1;
    } else {
      input.turn.contact.responderReads = input.turn.contact.responderReads.filter(
        (receipt: any) => receipt.path !== path,
      );
    }
    refreshAudit(input);

    assert.throws(
      () => projectFileWorkflowSharedOsEvidenceV1(input),
      /complete.*four-file read coverage|complete requester file read set/i,
      actorId,
    );
  }
});

test('binds every read version to the actor same-turn MEMORY CAS', () => {
  const futureBeforeCas: any = nativeQaInput('projector-future-read-before-cas');
  const futureOperation = futureBeforeCas.turn.sourceEvidence.requesterFileOperations.find(
    (operation: any) => operation.action === 'read' && operation.path === 'AGENT.md',
  );
  futureOperation.version = 1;
  futureBeforeCas.turn.requesterReads.find((receipt: any) => (
    receipt.path === 'AGENT.md'
  )).version = 1;
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(futureBeforeCas),
    /new version.*after.*MEMORY CAS|future.*before.*MEMORY CAS|read timing.*MEMORY CAS/i,
  );

  const requesterGap: any = nativeQaInput('projector-requester-version-gap');
  const requesterOperation = requesterGap.turn.sourceEvidence.requesterFileOperations.find(
    (operation: any) => operation.action === 'read' && operation.path === 'AGENT.md',
  );
  requesterOperation.version = 7;
  requesterGap.turn.requesterReads.find((receipt: any) => (
    receipt.path === 'AGENT.md'
  )).version = 7;
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(requesterGap),
    /read version.*same-turn MEMORY CAS|MEMORY CAS.*read version/i,
  );

  const responderGap: any = nativeQaInput('projector-responder-version-gap');
  const responderOperations = responderGap.turn.sourceEvidence.responderFileOperations;
  const replace = responderOperations.find((operation: any) => operation.action === 'replace');
  responderGap.turn.sourceEvidence.responderFileOperations = responderOperations.filter(
    (operation: any) => operation !== replace,
  );
  responderGap.turn.sourceEvidence.auditEvents = responderGap.turn.sourceEvidence.auditEvents.filter(
    (event: any) => event.operationId !== replace.operationId,
  );
  const responderOperation = responderGap.turn.sourceEvidence.responderFileOperations.find(
    (operation: any) => operation.action === 'read' && operation.path === 'AGENT.md',
  );
  responderOperation.version = 1;
  responderGap.turn.contact.responderReads.find((receipt: any) => (
    receipt.path === 'AGENT.md'
  )).version = 1;
  refreshAudit(responderGap);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(responderGap),
    /read versions.*without.*MEMORY CAS|MEMORY CAS.*read versions/i,
  );
});

test('enforces execution admissions and keeps responder work inside the nested request', () => {
  const missingResolution: any = nativeQaInput('projector-execution-resolution');
  const requesterAdmission = missingResolution.turn.sourceEvidence.auditEvents.findIndex(
    (event: any) => event.type === 'authorization.checked'
      && event.resource?.namespace === 'sharedos.execution'
      && event.actor.agentId === 'requester',
  );
  missingResolution.turn.sourceEvidence.auditEvents.splice(requesterAdmission - 1, 1);
  refreshAudit(missingResolution);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(missingResolution),
    /execution.*authority resolution|authority resolution.*execution/i,
  );

  const beforeAdmission: any = nativeQaInput('projector-file-before-admission');
  const firstRequesterOperation = beforeAdmission.turn.sourceEvidence
    .requesterFileOperations[0].operationId;
  const requesterPair = beforeAdmission.turn.sourceEvidence.auditEvents.filter(
    (event: any) => event.operationId === firstRequesterOperation,
  );
  beforeAdmission.turn.sourceEvidence.auditEvents = [
    ...requesterPair,
    ...beforeAdmission.turn.sourceEvidence.auditEvents.filter(
      (event: any) => event.operationId !== firstRequesterOperation,
    ),
  ];
  refreshAudit(beforeAdmission);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(beforeAdmission),
    /file.*execution admission|execution admission.*file/i,
  );

  const afterReply: any = nativeQaInput('projector-responder-after-reply');
  const responderOperations = afterReply.turn.sourceEvidence.responderFileOperations;
  const lastResponderOperation = responderOperations.at(-1).operationId;
  const responderPair = afterReply.turn.sourceEvidence.auditEvents.filter(
    (event: any) => event.operationId === lastResponderOperation,
  );
  const withoutResponderPair = afterReply.turn.sourceEvidence.auditEvents.filter(
    (event: any) => event.operationId !== lastResponderOperation,
  );
  const requestToolIndex = withoutResponderPair.findIndex((event: any) => (
    event.type === 'tool.invoked' && event.tool === 'messages.request'
  ));
  withoutResponderPair.splice(requestToolIndex, 0, ...responderPair);
  afterReply.turn.sourceEvidence.auditEvents = withoutResponderPair;
  refreshAudit(afterReply);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(afterReply),
    /responder.*nested request|nested request.*responder/i,
  );

  const missingReplyResolution: any = nativeQaInput('projector-reply-resolution');
  const replyAuthorization = missingReplyResolution.turn.sourceEvidence.auditEvents.findIndex(
    (event: any) => event.type === 'authorization.checked'
      && event.resource?.namespace === 'sharedos.messaging'
      && event.actor.agentId === 'responder',
  );
  missingReplyResolution.turn.sourceEvidence.auditEvents.splice(replyAuthorization - 1, 1);
  refreshAudit(missingReplyResolution);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(missingReplyResolution),
    /reply.*authority resolution|authority resolution.*reply/i,
  );
});

test('keeps every responder PACT tool pair inside the admitted nested request', () => {
  for (const position of ['before-admission', 'after-request'] as const) {
    const input: any = nativeQaInput(`projector-pact-${position}`);
    appendPactPair(input, position, 'search_notes');
    refreshAudit(input);

    assert.throws(
      () => projectFileWorkflowSharedOsEvidenceV1(input),
      /PACT.*responder admission|PACT.*nested request|nested request.*PACT/i,
      position,
    );
  }
});

test('requires canonical PACT tool bindings and mutation evidence for changed action state', () => {
  const unknown: any = nativeQaInput('projector-pact-unknown-tool');
  appendPactPair(unknown, 'nested', 'invented_pact_tool');
  refreshAudit(unknown);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(unknown),
    /unknown.*PACT.*tool|PACT.*tool.*binding|non-canonical PACT tool/i,
  );

  const before = pairStore('unchanged');
  const after = structuredClone(before);
  after.notes[0]!.content = 'changed through the responder tool';
  const changed = nativeActionInput(
    'projector-action-without-pact-mutation',
    { before, after },
  );
  const changedInput: any = changed;
  changedInput.turn.sourceEvidence.auditEvents = changedInput.turn.sourceEvidence.auditEvents.filter(
    (event: any) => event.resource?.namespace !== 'pact-pair',
  );
  const responderCatalog = changedInput.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'tool.catalog.listed' && event.actor.agentId === 'responder'
  ));
  responderCatalog.metadata.visibleTools = responderCatalog.metadata.visibleTools.filter(
    (tool: string) => tool !== 'edit_note',
  );
  refreshAudit(changedInput);
  assert.throws(
    () => projectFileWorkflowSharedOsEvidenceV1(changedInput),
    /changed action.*PACT.*mutation|PACT.*mutation.*changed action/i,
  );
});

function nativeQaInput(runId: string): ProjectFileWorkflowSharedOsEvidenceV1Input {
  return nativeCompletedInput(runId, 'PAIR-Q-001');
}

function nativeActionInput(
  runId: string,
  actionSnapshot: NonNullable<ProjectFileWorkflowSharedOsEvidenceV1Input['actionSnapshot']>,
): ProjectFileWorkflowSharedOsEvidenceV1Input {
  return nativeCompletedInput(runId, 'PAIR-A-001', actionSnapshot);
}

function nativeDeniedInput(runId: string): ProjectFileWorkflowSharedOsEvidenceV1Input {
  const runBinding = binding('files-multi', runId, ['PAIR-Q-001']);
  const payload: any = heartbeatPayloadFor(runBinding, 1, [], {
    requesterExecutionStatus: 'denied',
  });
  const [resolution, admission] = payload.privateEvidence.sourceEvidence.auditEvents;
  admission.outcome = 'denied';
  admission.reason = 'grant_not_found';
  delete admission.grantId;
  const events = [resolution, admission];
  const turn: SharedOsFileTurnResultV1 = {
    executionId: payload.sharedOsAuthority.requesterExecutionId,
    traceId: payload.event.traceId,
    executionStatus: 'denied',
    decision: null,
    requesterReads: [],
    providerUsage: {
      requestedModel: runBinding.actors.requester.model.requestedModel,
      resolvedModel: runBinding.actors.requester.model.resolvedModel,
      requests: [],
      totals: { requests: 0 },
    },
    provenance: structuredClone(runBinding.sharedOs),
    sourceEvidence: {
      requesterFileOperations: [],
      responderFileOperations: [],
      acceptedMessages: [],
      auditEvents: events,
    },
    audit: {
      firstSequence: 0,
      lastSequence: events.length - 1,
      sha256: sha256JsonV1(events as JsonValue),
    },
  };
  return {
    binding: runBinding,
    event: structuredClone(payload.event),
    turn,
  };
}

function nativeCompletedInput(
  runId: string,
  taskId: 'PAIR-Q-001' | 'PAIR-A-001',
  actionSnapshot?: NonNullable<ProjectFileWorkflowSharedOsEvidenceV1Input['actionSnapshot']>,
): ProjectFileWorkflowSharedOsEvidenceV1Input {
  const runBinding = binding('files-multi', runId, [taskId]);
  const tick = 1;
  const traceId = `trace-${tick}`;
  const requesterPrevious = memoryContent(runBinding.selectedTaskIds, 0);
  const requesterNext = memoryContent(runBinding.selectedTaskIds, 1, {
    [taskId]: 'answered',
  });
  const responderPrevious = memoryContent(runBinding.selectedTaskIds, 0);
  const responderNext = memoryContent(runBinding.selectedTaskIds, 1, {
    [taskId]: 'answered',
  });
  const payload: any = heartbeatPayloadFor(
    runBinding,
    tick,
    [transition(taskId, 'answered', tick)],
    {
      contact: {
        taskId,
        message: 'please answer',
        status: 'completed',
        response: 'authorized answer',
      },
      requesterMemory: {
        previousBytesBase64: Buffer.from(requesterPrevious).toString('base64'),
        newBytesBase64: Buffer.from(requesterNext).toString('base64'),
      },
      responderMemory: {
        previousBytesBase64: Buffer.from(responderPrevious).toString('base64'),
        newBytesBase64: Buffer.from(responderNext).toString('base64'),
      },
      ...(actionSnapshot ? {
        actionSnapshots: [{
          taskId,
          contactId: 'request-message-1',
          actorId: runBinding.actors.responder.actorId,
          eventId: 'event-1',
          before: structuredClone(actionSnapshot.before),
          after: structuredClone(actionSnapshot.after),
        }],
      } : {}),
    },
  );
  const sourceEvidence = structuredClone(payload.privateEvidence.sourceEvidence);
  const requestMessageId = sourceEvidence.acceptedMessages[0].id;
  const replyMessageId = sourceEvidence.acceptedMessages[1].id;
  const contactAuthority = payload.contactAuthority;
  const responderReads = payload.fileReads.filter(
    (receipt: any) => receipt.actorId === runBinding.actors.responder.actorId,
  );
  const turn: SharedOsFileTurnResultV1 = {
    executionId: payload.sharedOsAuthority.requesterExecutionId,
    traceId,
    executionStatus: 'succeeded',
    decision: structuredClone(payload.privateEvidence.tickDecisions[0]),
    requesterReads: payload.fileReads.filter(
      (receipt: any) => receipt.actorId === runBinding.actors.requester.actorId,
    ),
    contact: {
      taskId: contactAuthority.taskId,
      requestMessageId,
      replyMessageId,
      responderExecutionId: contactAuthority.responderExecutionId,
      status: 'completed',
      response: 'authorized answer',
      responderReads,
      providerUsage: structuredClone(payload.privateEvidence.providerTelemetry.responder),
    },
    providerUsage: structuredClone(payload.privateEvidence.providerTelemetry.requester),
    provenance: structuredClone(runBinding.sharedOs),
    sourceEvidence,
    audit: {
      firstSequence: payload.sharedOsAuthority.audit.firstSequence,
      lastSequence:
        payload.sharedOsAuthority.audit.firstSequence + sourceEvidence.auditEvents.length - 1,
      sha256: sha256JsonV1(sourceEvidence.auditEvents as JsonValue),
    },
  };
  return {
    binding: runBinding,
    event: structuredClone(payload.event),
    turn,
    ...(actionSnapshot ? { actionSnapshot: structuredClone(actionSnapshot) } : {}),
  };
}

function refreshAudit(input: any): void {
  const events = input.turn.sourceEvidence.auditEvents;
  input.turn.audit.lastSequence = input.turn.audit.firstSequence + events.length - 1;
  input.turn.audit.sha256 = sha256JsonV1(events as JsonValue);
}

function convertCompletedContactToFailed(input: any, errorCode: string): void {
  const replyMessageId = input.turn.contact.replyMessageId;
  const replyAuthorization = input.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'authorization.checked'
    && event.resource?.namespace === 'sharedos.messaging'
    && event.actor.agentId === 'responder'
  ));
  input.turn.sourceEvidence.acceptedMessages = input.turn.sourceEvidence.acceptedMessages.filter(
    (message: any) => message.id !== replyMessageId,
  );
  input.turn.sourceEvidence.auditEvents = input.turn.sourceEvidence.auditEvents.filter(
    (event: any) => event.messageId !== replyMessageId
      && event.authorityHash !== replyAuthorization.authorityHash,
  );
  const requestTool = input.turn.sourceEvidence.auditEvents.find((event: any) => (
    event.type === 'tool.invoked' && event.tool === 'messages.request'
  ));
  requestTool.outcome = 'failed';
  requestTool.reason = 'message_reply_resolution_failed';
  input.turn.contact.status = 'failed';
  input.turn.contact.errorCode = errorCode;
  delete input.turn.contact.response;
  delete input.turn.contact.replyMessageId;
  refreshAudit(input);
}

function appendPactPair(
  input: any,
  position: 'before-admission' | 'nested' | 'after-request',
  tool: string,
): void {
  const events = input.turn.sourceEvidence.auditEvents;
  const responderAdmissionIndex = events.findIndex((event: any) => (
    event.type === 'authorization.checked'
    && event.resource?.namespace === 'sharedos.execution'
    && event.actor.agentId === 'responder'
  ));
  const responderAdmission = events[responderAdmissionIndex];
  const responderCatalog = events.find((event: any) => (
    event.type === 'tool.catalog.listed'
    && event.actor.agentId === 'responder'
  ));
  responderCatalog.metadata.visibleTools.push(tool);
  const operationId = `pact-operation-${position}-${tool}`;
  const grantId = `pact-grant-${position}-${tool}`;
  const context = {
    version: '1',
    at: responderAdmission.at,
    traceId: responderAdmission.traceId,
    namespaceId: responderAdmission.namespaceId,
    actor: structuredClone(responderAdmission.actor),
    authority: structuredClone(responderAdmission.authority),
    owner: structuredClone(responderAdmission.owner),
    purpose: responderAdmission.purpose,
  };
  const resource = {
    namespace: 'pact-pair',
    path: ['task', input.turn.contact.taskId, 'notes'],
    owner: structuredClone(responderAdmission.owner),
  };
  const pair = [{
    ...context,
    type: 'authorization.checked',
    outcome: 'allowed',
    resource,
    action: 'read',
    operationId,
    grantId,
    authorityHash: responderAdmission.authorityHash,
    metadata: { consumed: true },
  }, {
    ...context,
    type: 'tool.invoked',
    outcome: 'succeeded',
    resource,
    action: 'read',
    operationId,
    grantId,
    tool,
  }];
  const insertAt = position === 'before-admission'
    ? responderAdmissionIndex - 1
    : position === 'after-request'
      ? events.length
      : events.findIndex((event: any) => (
        event.type === 'authority.resolved'
        && event.actor.agentId === 'responder'
        && event !== events[responderAdmissionIndex - 1]
      ));
  events.splice(insertAt, 0, ...pair);
}
