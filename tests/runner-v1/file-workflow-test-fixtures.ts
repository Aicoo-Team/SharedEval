import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  jsonObjectSchema,
  jsonValueSchema,
  stableIdV1,
} from '../../src/contracts/json.js';
import type {
  SoAuditEvent,
  SoMessageEnvelope,
} from '../../src/execution/sharedos/v1/contracts.js';
import type { FileProviderTelemetryV1 } from '../../src/runner/v1/file-model-driver.js';
import {
  SHAREDEVAL_SERVICE_ADDRESS_V1,
  type CreateSharedOsFileSessionV1Options,
  type SharedOsFileSessionFactoryV1,
  type SharedOsFileTurnResultV1,
} from '../../src/runner/v1/sharedos-file-session-contracts.js';
import type { SharedOsFileOperationReceiptV1 } from '../../src/runner/v1/sharedos-file-provider.js';
import type { FileReadReceiptV1 } from '../../src/runner/v1/file-workspace.js';
import type {
  FileWorkflowHostRunProvenanceV1,
  FileWorkflowHeartbeatPayloadV1,
  FileWorkflowPrivateEvidenceV1,
  FileWorkflowRunBindingV1,
  FileWorkflowTerminalTransitionV1,
} from '../../src/runner/v1/file-workflow-artifacts.js';
import {
  loadPactPairTasksV1,
  type LoadedPactPairTaskV1,
} from '../../src/suites/pact-pair/task-loader.js';

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

export const fileWorkflowHostRunProvenanceFixtureV1 = Object.freeze({
  dataset: Object.freeze({
    id: 'pact-pair' as const,
    version: '1.0.0',
    manifestSha256: hex('dataset-manifest'),
    tasksSha256: hex('dataset-tasks'),
  }),
  goldSet: Object.freeze({ id: 'pair-gold-v2', sha256: hex('gold-set-withheld') }),
  models: Object.freeze({
    requester: Object.freeze({
      provider: 'scripted',
      requestedModel: 'requester-v1',
      resolvedModel: 'requester-v1',
    }),
    responder: Object.freeze({
      provider: 'scripted',
      requestedModel: 'responder-v1',
      resolvedModel: 'responder-v1',
    }),
  }),
  backend: Object.freeze({ adapterId: 'sharedos-runtime', executor: 'sharedos-executor' }),
}) satisfies FileWorkflowHostRunProvenanceV1;

export function binding(
  workflowId: 'files-multi' | 'files-single',
  runId: string,
  selectedTaskIds: string[],
): FileWorkflowRunBindingV1 {
  const requesterFiles = fileSet('requester', selectedTaskIds);
  const responderFiles = fileSet('responder', selectedTaskIds);
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
    scheduler: {
      sessionId: `session-${runId}`,
      sessionIndex: 0,
      maxTicks: 10_000,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      initialActionSha256: hex('initial-pact-action-state'),
    },
    dataset: {
      id: 'pact-pair',
      version: '1.0.0',
      manifestSha256: hex('dataset-manifest'),
      tasksSha256: hex(`dataset-tasks:${selectedTaskIds.join(',')}`),
    },
    goldSet: { id: 'pair-gold-v2', sha256: hex('gold-set-withheld') },
    policies: {
      requester: {
        id: 'ordered-public-task-queue',
        version: '1.0.0',
        sha256: requesterFiles['POLICY.md'].sha256,
      },
      responder: {
        id: 'D2R',
        version: '1.0.0',
        sha256: responderFiles['POLICY.md'].sha256,
      },
    },
    actors: {
      requester: {
        actorId: 'requester',
        references: references('requester'),
        model: {
          provider: 'scripted',
          requestedModel: 'requester-v1',
          resolvedModel: 'requester-v1',
        },
        initial: requesterFiles,
      },
      responder: {
        actorId: 'responder',
        references: references('responder'),
        model: {
          provider: 'scripted',
          requestedModel: 'responder-v1',
          resolvedModel: 'responder-v1',
        },
        initial: responderFiles,
      },
    },
    backend: { adapterId: 'sharedos-runtime', executor: 'sharedos-executor' },
    sharedOs: {
      runStartedAt: '2026-08-26T00:00:00.000Z',
      namespaceId: `namespace-${runId}`,
      grantManifestDigest: hex(`grant-manifest:${runId}`),
      sharedOsRevision: 'b'.repeat(40),
      sharedOsRuntimeDigest: hex(`sharedos-runtime:${runId}`),
    },
  };
}

export function memoryContent(
  selectedTaskIds: readonly string[],
  tick: number,
  statuses: Readonly<Record<string, 'pending' | 'answered' | 'refused' | 'error'>> = {},
): string {
  return `${selectedTaskIds.map(taskId => (
    `${taskId} [${statuses[taskId] ?? 'pending'}] — memory ${tick}`
  )).join('\n')}\n`;
}

export function finalFilesFor(
  runBinding: FileWorkflowRunBindingV1,
  requesterMemoryTick = runBinding.selectedTaskIds.length,
  requesterStatuses: Readonly<
    Record<string, 'pending' | 'answered' | 'refused' | 'error'>
  > = {},
) {
  const requester = structuredClone(runBinding.actors.requester.initial);
  if (requesterMemoryTick > 0) {
    requester['MEMORY.md'] = metadata(
      'MEMORY.md',
      memoryContent(runBinding.selectedTaskIds, requesterMemoryTick, requesterStatuses),
    );
  }
  return {
    requester,
    responder: structuredClone(runBinding.actors.responder.initial),
  };
}

export function heartbeatPayloadFor(
  runBinding: FileWorkflowRunBindingV1,
  tick: number,
  transitions: FileWorkflowTerminalTransitionV1[],
  privateValue?: any,
): any {
  const rebound = transitions.map(row => rewriteTransition(row, runBinding));
  const previousMemoryVersion = privateValue?.requesterMemory?.previousVersion
    ?? Math.max(0, tick - 1);
  const defaultPreviousMemory = memoryContent(runBinding.selectedTaskIds, previousMemoryVersion);
  const defaultNextMemory = memoryContent(
    runBinding.selectedTaskIds,
    tick,
    Object.fromEntries(rebound.flatMap(row => (
      row.result.status === 'answered' || row.result.status === 'refused'
        ? [[row.taskId, row.result.status]]
        : []
    ))),
  );
  const previousMemory = privateValue?.requesterMemory?.previousBytesBase64
    ? Buffer.from(privateValue.requesterMemory.previousBytesBase64, 'base64').toString('utf8')
    : defaultPreviousMemory;
  const nextMemory = privateValue?.requesterMemory?.newBytesBase64
    ? Buffer.from(privateValue.requesterMemory.newBytesBase64, 'base64').toString('utf8')
    : defaultNextMemory;
  const initial = runBinding.actors.requester.initial;
  const contact = privateValue?.contact
    ? {
      ...(privateValue.contact.status === 'completed' ? { response: 'completed' } : {}),
      ...(privateValue.contact.status === 'denied'
        ? { errorCode: 'CONTACT_RESPONDER_DENIED' }
        : {}),
      ...(privateValue.contact.status === 'failed'
        ? { errorCode: 'CONTACT_RESPONDER_FAILED' }
        : {}),
      ...(privateValue.contact.status === 'cancelled'
        ? { errorCode: 'CONTACT_CANCELLED' }
        : {}),
      ...privateValue.contact,
    }
    : undefined;
  const requesterExecutionStatus = privateValue?.requesterExecutionStatus ?? 'succeeded';
  const traceId = privateValue?.traceId ?? `trace-${tick}`;
  const requesterOperations: any[] = (['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const)
    .map((path, index) => fileReadOperation({
      runId: runBinding.runId,
      actorId: runBinding.actors.requester.actorId,
      traceId,
      operationId: `requester-read-${tick}-${index + 1}`,
      path,
      version: previousMemoryVersion,
      metadata: path === 'MEMORY.md'
        ? metadata('MEMORY.md', previousMemory)
        : initial[path],
    }));
  if (!privateValue?.omitRequesterMemoryReplace) {
    requesterOperations.push(fileReplaceOperation({
      runId: runBinding.runId,
      actorId: runBinding.actors.requester.actorId,
      traceId,
      operationId: `requester-memory-replace-${tick}`,
      previousVersion: previousMemoryVersion,
      previousContent: previousMemory,
      newContent: nextMemory,
    }));
  }

  const responderOperations: any[] = contact
    && (contact.status === 'completed' || contact.status === 'denied')
    ? (['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const).map(
        (path, index) => fileReadOperation({
          runId: runBinding.runId,
          actorId: runBinding.actors.responder.actorId,
          traceId,
          operationId: `responder-read-${tick}-${index + 1}`,
          path,
          version: 0,
          metadata: runBinding.actors.responder.initial[path],
        }),
      )
    : [];
  if (privateValue?.responderMemory) {
    const previous = Buffer.from(
      privateValue.responderMemory.previousBytesBase64,
      'base64',
    ).toString('utf8');
    const next = Buffer.from(
      privateValue.responderMemory.newBytesBase64,
      'base64',
    ).toString('utf8');
    const responderPreviousVersion = privateValue.responderMemory.previousVersion ?? 0;
    for (const operation of responderOperations) {
      if (operation.action !== 'read') continue;
      operation.version = responderPreviousVersion;
      if (operation.path === 'MEMORY.md') {
        operation.sha256 = hex(previous);
        operation.byteLength = Buffer.byteLength(previous);
      }
    }
    responderOperations.push(fileReplaceOperation({
      runId: runBinding.runId,
      actorId: runBinding.actors.responder.actorId,
      traceId,
      operationId: `responder-memory-replace-${tick}`,
      previousVersion: responderPreviousVersion,
      previousContent: previous,
      newContent: next,
    }));
  }

  const requestSeed = contact?.requestMessageId ?? `request-message-${tick}`;
  const requestOperationId = contact ? stableIdV1('operation', [
    'fixture-message-request',
    runBinding.runId,
    tick,
    requestSeed,
  ]) : undefined;
  const acceptedMessages = contact ? (() => {
    const recipient = {
      kind: 'agent' as const,
      agentId: runBinding.actors.responder.actorId,
    };
    const requestMessageId = stableIdV1('message', [
      'message-request',
      runBinding.sharedOs.namespaceId,
      traceId,
      requestOperationId!,
      recipient,
    ]);
    const request = messageEnvelope({
      id: requestMessageId,
      senderId: runBinding.actors.requester.actorId,
      receiverId: runBinding.actors.responder.actorId,
      traceId,
      payload: { taskId: contact.taskId, message: contact.message },
      createdAt: fixtureTimestamp(tick, 0),
    });
    if (contact.status !== 'completed' && contact.status !== 'denied') return [request];
    const reply = messageEnvelope({
      id: stableIdV1('message', ['message-reply', requestMessageId]),
      senderId: runBinding.actors.responder.actorId,
      receiverId: runBinding.actors.requester.actorId,
      traceId,
      replyTo: requestMessageId,
      payload: contact.status === 'completed'
        ? { taskId: contact.taskId, status: 'completed', response: contact.response }
        : { taskId: contact.taskId, status: 'denied', errorCode: contact.errorCode },
      createdAt: fixtureTimestamp(tick, 1),
    });
    return [request, reply];
  })() : [];

  const pactMutation = fixturePactMutation(contact, privateValue?.actionSnapshots ?? []);

  const auditEvents = buildAuditEvents({
    runBinding,
    tick,
    traceId,
    operations: [...requesterOperations, ...responderOperations],
    messages: acceptedMessages,
    requestOperationId,
    responderExecutionStarted: Boolean(contact && (
      contact.status === 'completed'
      || contact.status === 'denied'
      || contact.responderExecutionId
    )),
    requestToolOutcome: contact?.status === 'cancelled'
      && requesterExecutionStatus === 'cancelled'
      ? 'cancelled'
      : contact?.status === 'failed' || contact?.status === 'cancelled'
        ? 'failed'
        : 'succeeded',
    ...(contact?.status === 'failed' || contact?.status === 'cancelled'
      ? { requestToolReason: 'message_reply_resolution_failed' }
      : {}),
    ...(pactMutation ? { pactMutation } : {}),
  });
  const requesterTelemetry = privateValue?.providerTelemetry?.requester
    ?? providerTelemetry(runBinding.actors.requester.model, true);
  const responderTelemetry = privateValue?.providerTelemetry?.responder
    ?? (contact && (
      contact.status === 'completed'
      || contact.status === 'denied'
      || contact.responderExecutionId
    )
      ? providerTelemetry(runBinding.actors.responder.model, false)
      : undefined);
  const defaultDecision = {
    type: 'completed' as const,
    content: `fixture heartbeat ${tick}`,
    toolSteps: auditEvents.filter(event => (
      event.type === 'tool.invoked'
      && event.actor.kind === 'agent'
      && event.actor.agentId === runBinding.actors.requester.actorId
    )).length,
    contactCalls: auditEvents.filter(event => (
      event.type === 'tool.invoked'
      && event.tool === 'messages.request'
      && event.actor.kind === 'agent'
      && event.actor.agentId === runBinding.actors.requester.actorId
    )).length,
  };
  const privateEvidence: FileWorkflowPrivateEvidenceV1 = {
    requesterExecutionStatus,
    sourceEvidence: {
      requesterFileOperations: requesterOperations,
      responderFileOperations: responderOperations,
      acceptedMessages,
      auditEvents,
    },
    providerTelemetry: {
      requester: requesterTelemetry,
      ...(responderTelemetry ? { responder: responderTelemetry } : {}),
    },
    actionSnapshots: (privateValue?.actionSnapshots ?? []).map((snapshot: any) => (
      contact && snapshot.contactId === requestSeed
        ? { ...snapshot, contactId: acceptedMessages[0]!.id }
        : snapshot
    )),
    tickDecisions: privateValue?.tickDecisions?.length
      ? privateValue.tickDecisions.map((decision: any) => ({
        ...decision,
        toolSteps: defaultDecision.toolSteps,
        contactCalls: defaultDecision.contactCalls,
      }))
      : requesterExecutionStatus === 'succeeded'
        ? [defaultDecision]
        : [],
    fullEvaluations: privateValue?.fullEvaluations ?? [],
  };
  const fileReads = [...requesterOperations, ...responderOperations]
    .filter(operation => operation.action === 'read')
    .map(operation => ({
      actorId: operation.actorId,
      path: operation.path,
      action: 'read' as const,
      version: operation.version,
      sha256: operation.sha256,
      byteLength: operation.byteLength,
    }));
  const memoryOperations = [...requesterOperations, ...responderOperations]
    .filter(operation => operation.action === 'replace' && operation.outcome === 'committed');
  const memoryTransitions = memoryOperations.map(memoryTransitionFromOperation);
  const memoryAuthorities = memoryOperations.map(operation => (
    memoryAuthorityFromOperation(operation, runBinding.selectedTaskIds)
  ));
  const contactAuthority = contact
    ? contactAuthorityFor({
      contact,
      acceptedMessages,
      snapshots: privateEvidence.actionSnapshots,
      runBinding,
      eventId: `event-${tick}`,
      tick,
    })
    : undefined;
  const toolSteps = auditEvents.filter(event => event.type === 'tool.invoked').length;
  const contactCalls = auditEvents.filter(event => (
    event.type === 'tool.invoked'
    && event.tool === 'messages.request'
    && event.actor.kind === 'agent'
    && event.actor.agentId === runBinding.actors.requester.actorId
  )).length;
  const usageTotals = [requesterTelemetry, responderTelemetry].filter(Boolean).reduce(
    (totals, telemetry: any) => ({
      modelCalls: totals.modelCalls + telemetry.totals.requests,
      promptTokens: totals.promptTokens + (telemetry.totals.promptTokens ?? 0),
      completionTokens: totals.completionTokens + (telemetry.totals.completionTokens ?? 0),
      totalTokens: totals.totalTokens + (telemetry.totals.totalTokens ?? 0),
      costUsd: totals.costUsd + (telemetry.totals.costUsd ?? 0),
    }),
    { modelCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  const inferredStopReason = rebound.length > 0 && (
    rebound.length === runBinding.selectedTaskIds.length
    || tick >= runBinding.selectedTaskIds.length
  )
    ? (rebound.some(row => row.result.status === 'no_response')
      ? 'tick_exhausted' as const
      : 'all_terminal' as const)
    : undefined;
  const sessionStopReason = privateValue?.omitSessionStopReason
    ? undefined
    : privateValue?.sessionStopReason ?? inferredStopReason;
  const auditFirstSequence = (tick - 1) * 32;
  const responderExecutionId = contactAuthority?.responderExecutionId;
  return {
    inputDigest: hex(`heartbeat-input:${runBinding.runId}:${tick}`),
    event: {
      eventId: `event-${tick}`,
      runId: runBinding.runId,
      sessionId: `session-${runBinding.runId}`,
      tick,
      actorId: 'requester',
      traceId,
    },
    ...(contactAuthority ? { contactAuthority } : {}),
    fileReads,
    memoryTransitions,
    memoryAuthorities,
    sharedOsAuthority: {
      ...runBinding.sharedOs,
      requesterExecutionId: stableIdV1('execution', [
        'requester-execution',
        `event-${tick}`,
        runBinding.actors.requester.actorId,
      ]),
      requesterExecutionStatus,
      ...(responderExecutionId ? { responderExecutionId } : {}),
      audit: {
        firstSequence: auditFirstSequence,
        lastSequence: auditFirstSequence + auditEvents.length - 1,
        sha256: digestCanonicalFixture(auditEvents),
      },
    },
    ...(sessionStopReason
      ? { sessionStopReason }
      : {}),
    transitions: rebound,
    provider: {
      requester: structuredClone(runBinding.actors.requester.model),
      ...(responderTelemetry
        ? { responder: structuredClone(runBinding.actors.responder.model) }
        : {}),
    },
    usage: { ...usageTotals, toolSteps, contactCalls },
    privateEvidence,
  };
}

export function transition(
  taskId: string,
  status: 'answered' | 'refused' | 'error' | 'no_response' | 'side_effect_before_failure',
  terminalTick: number,
  kind: 'qa' | 'action' = taskId.includes('-A-') ? 'action' : 'qa',
): FileWorkflowTerminalTransitionV1 {
  const result = {
    apiVersion: 'sharedeval-file-result/v1' as const,
    workflowId: 'files-multi' as const,
    runId: 'placeholder-run',
    sessionId: 'session-placeholder-run',
    taskId,
    kind,
    status,
    terminalTick,
    ...(status === 'error' || status === 'side_effect_before_failure'
      ? { errorCode: 'FILE_SESSION_FAILED' }
      : {}),
    publicEvaluation: null,
    selectedTaskDigest: taskDigest([taskId]),
    backend: { adapterId: 'sharedos-runtime', executor: 'sharedos-executor' },
  };
  return {
    taskId,
    result,
    evaluation: {
      apiVersion: 'sharedeval-file-evaluation/v1',
      workflowId: result.workflowId,
      runId: result.runId,
      sessionId: result.sessionId,
      taskId,
      publicEvaluation: null,
      metrics: [],
    },
  };
}

export function pairStore(sentinel: string) {
  return {
    version: '1',
    description: `private test store ${sentinel}`,
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
      sensitivity: 'work_public' as const,
    }],
    todo_folders: [{ id: 1, name: 'General', sensitivity: 'work_public' as const }],
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

function rewriteTransition(
  row: FileWorkflowTerminalTransitionV1,
  runBinding: FileWorkflowRunBindingV1,
): FileWorkflowTerminalTransitionV1 {
  const sessionId = `session-${runBinding.runId}`;
  return {
    ...row,
    result: {
      ...row.result,
      workflowId: runBinding.workflowId,
      runId: runBinding.runId,
      sessionId,
      selectedTaskDigest: runBinding.selectedTaskDigest,
      backend: structuredClone(runBinding.backend),
    },
    evaluation: {
      ...row.evaluation,
      workflowId: runBinding.workflowId,
      runId: runBinding.runId,
      sessionId,
    },
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

function fileSet(prefix: string, selectedTaskIds: readonly string[]) {
  return {
    'AGENT.md': metadata('AGENT.md', `${prefix}-agent`),
    'HEARTBEAT.md': metadata('HEARTBEAT.md', `${prefix}-heartbeat`),
    'POLICY.md': metadata('POLICY.md', `${prefix}-policy`),
    'MEMORY.md': metadata('MEMORY.md', memoryContent(selectedTaskIds, 0)),
  };
}

function metadata<Path extends 'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md'>(
  path: Path,
  value: string,
): { path: Path; sha256: string; byteLength: number } {
  return { path, sha256: hex(value), byteLength: Buffer.byteLength(value) };
}

function fileReadOperation(input: {
  runId: string;
  actorId: string;
  traceId: string;
  operationId: string;
  path: 'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md';
  version: number;
  metadata: { sha256: string; byteLength: number };
}) {
  return {
    runId: input.runId,
    actorId: input.actorId,
    traceId: input.traceId,
    operationId: input.operationId,
    path: input.path,
    action: 'read' as const,
    outcome: 'succeeded' as const,
    version: input.version,
    sha256: input.metadata.sha256,
    byteLength: input.metadata.byteLength,
  };
}

function fileReplaceOperation(input: {
  runId: string;
  actorId: string;
  traceId: string;
  operationId: string;
  previousVersion: number;
  previousContent: string;
  newContent: string;
}) {
  return {
    runId: input.runId,
    actorId: input.actorId,
    traceId: input.traceId,
    operationId: input.operationId,
    path: 'MEMORY.md' as const,
    action: 'replace' as const,
    outcome: 'committed' as const,
    expectedVersion: input.previousVersion,
    previousVersion: input.previousVersion,
    previousSha256: hex(input.previousContent),
    previousByteLength: Buffer.byteLength(input.previousContent),
    previousBytesBase64: Buffer.from(input.previousContent).toString('base64'),
    newBytesBase64: Buffer.from(input.newContent).toString('base64'),
    version: input.previousVersion + 1,
    sha256: hex(input.newContent),
    byteLength: Buffer.byteLength(input.newContent),
  };
}

function messageEnvelope(input: {
  id: string;
  senderId: string;
  receiverId: string;
  traceId: string;
  payload: unknown;
  createdAt: string;
  replyTo?: string;
}) {
  return {
    version: '1' as const,
    id: input.id,
    sender: { kind: 'agent' as const, agentId: input.senderId },
    receiver: { kind: 'agent' as const, agentId: input.receiverId },
    purpose: 'sharedeval:pact-pair' as const,
    payload: input.payload,
    traceId: input.traceId,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    createdAt: input.createdAt,
  };
}

function buildAuditEvents(input: {
  runBinding: FileWorkflowRunBindingV1;
  tick: number;
  traceId: string;
  operations: readonly any[];
  messages: readonly any[];
  requestOperationId?: string;
  responderExecutionStarted: boolean;
  requestToolOutcome: 'succeeded' | 'failed' | 'cancelled';
  requestToolReason?: string;
  pactMutation?: Readonly<{
    taskId: string;
    surface: 'notes' | 'todos';
    action: 'create' | 'update';
    tool: 'create_note' | 'edit_note' | 'create_todo' | 'edit_todo';
  }>;
}) {
  const namespaceId = input.runBinding.sharedOs.namespaceId;
  const owner = SHAREDEVAL_SERVICE_ADDRESS_V1;
  const base = (actorId: string) => ({
    version: '1' as const,
    at: fixtureTimestamp(input.tick, 2),
    traceId: input.traceId,
    namespaceId,
    actor: { kind: 'agent' as const, agentId: actorId },
    authority: owner,
    owner,
    purpose: 'sharedeval:pact-pair' as const,
  });
  const events: any[] = [];
  const requesterAuthorityHash = hex(
    `authority:${input.runBinding.runId}:${input.tick}:requester-admission`,
  );
  const responderAuthorityHash = hex(
    `authority:${input.runBinding.runId}:${input.tick}:responder-admission`,
  );
  const replyAuthorityHash = hex(
    `authority:${input.runBinding.runId}:${input.tick}:responder-reply`,
  );
  const authorityResolved = (actorId: string, authorityHash: string) => ({
    ...base(actorId),
    type: 'authority.resolved',
    outcome: 'succeeded',
    authorityHash,
  });
  const executionAuthorization = (actorId: string, authorityHash: string) => ({
    ...base(actorId),
    type: 'authorization.checked',
    outcome: 'allowed',
    resource: {
      namespace: 'sharedos.execution',
      path: ['agent', actorId],
      owner,
    },
    action: 'invoke',
    grantId: `grant-execution-${actorId}`,
    authorityHash,
    metadata: { consumed: true },
  });
  const toolCatalog = (
    actorId: string,
    authorityHash: string,
    visibleTools: readonly string[],
  ) => ({
    ...base(actorId),
    type: 'tool.catalog.listed',
    outcome: 'succeeded',
    authorityHash,
    metadata: { visibleTools: [...visibleTools] },
  });
  const requesterId = input.runBinding.actors.requester.actorId;
  const responderId = input.runBinding.actors.responder.actorId;
  events.push(authorityResolved(requesterId, requesterAuthorityHash));
  events.push(executionAuthorization(requesterId, requesterAuthorityHash));
  events.push(toolCatalog(requesterId, requesterAuthorityHash, [
    'files.read',
    'files.replace',
    'messages.request',
  ]));
  const appendFileOperation = (operation: any) => {
    const grantId = `grant-${operation.actorId}-${operation.operationId}`;
    const resource = {
      namespace: 'files',
      path: [operation.path],
      owner,
    };
    const authorityHash = operation.actorId === requesterId
      ? requesterAuthorityHash
      : responderAuthorityHash;
    events.push({
      ...base(operation.actorId),
      type: 'authorization.checked',
      outcome: 'allowed',
      resource,
      action: operation.action,
      operationId: operation.operationId,
      grantId,
      authorityHash,
      metadata: { consumed: true },
    });
    events.push({
      ...base(operation.actorId),
      type: 'tool.invoked',
      outcome: 'succeeded',
      resource,
      action: operation.action,
      operationId: operation.operationId,
      tool: operation.action === 'read' ? 'files.read' : 'files.replace',
      grantId,
    });
  };
  for (const operation of input.operations.filter(row => row.actorId === requesterId)) {
    appendFileOperation(operation);
  }
  const request = input.messages.find(message => !message.replyTo);
  const reply = input.messages.find(message => message.replyTo);
  if (request) {
    const operationId = input.requestOperationId;
    if (!operationId) throw new Error('Fixture request requires its tool operation identity');
    const grantId = `grant-message-${request.id}`;
    const resource = {
      namespace: 'sharedos.messaging',
      path: ['agent', responderId],
      owner,
    };
    events.push({
      ...base(requesterId),
      type: 'authorization.checked',
      outcome: 'allowed',
      operationId,
      resource,
      action: 'send',
      grantId,
      authorityHash: requesterAuthorityHash,
      metadata: { consumed: true },
    });
    events.push({
      ...base(requesterId),
      type: 'message.sent',
      outcome: 'succeeded',
      operationId,
      messageId: request.id,
      receiver: request.receiver,
    });
    if (input.responderExecutionStarted) {
      events.push(authorityResolved(responderId, responderAuthorityHash));
      events.push(executionAuthorization(responderId, responderAuthorityHash));
      events.push(toolCatalog(responderId, responderAuthorityHash, [
        'files.read',
        'files.replace',
        ...(input.pactMutation ? [input.pactMutation.tool] : []),
      ]));
      for (const operation of input.operations.filter(row => row.actorId === responderId)) {
        appendFileOperation(operation);
      }
      if (input.pactMutation) {
        const operationId = `responder-pact-mutation-${input.tick}`;
        const grantId = `grant-${operationId}`;
        const resource = {
          namespace: 'pact-pair',
          path: ['task', input.pactMutation.taskId, input.pactMutation.surface],
          owner,
        };
        events.push({
          ...base(responderId),
          type: 'authorization.checked',
          outcome: 'allowed',
          resource,
          action: input.pactMutation.action,
          operationId,
          grantId,
          authorityHash: responderAuthorityHash,
          metadata: { consumed: true },
        });
        events.push({
          ...base(responderId),
          type: 'tool.invoked',
          outcome: 'succeeded',
          resource,
          action: input.pactMutation.action,
          operationId,
          tool: input.pactMutation.tool,
          grantId,
        });
      }
    }
    if (reply) {
      const replyGrantId = `grant-message-${reply.id}`;
      events.push(authorityResolved(responderId, replyAuthorityHash));
      events.push({
        ...base(responderId),
        type: 'authorization.checked',
        outcome: 'allowed',
        resource: {
          namespace: 'sharedos.messaging',
          path: ['agent', requesterId],
          owner,
        },
        action: 'send',
        grantId: replyGrantId,
        authorityHash: replyAuthorityHash,
        metadata: { consumed: true },
      });
      events.push({
        ...base(responderId),
        type: 'message.sent',
        outcome: 'succeeded',
        grantId: replyGrantId,
        messageId: reply.id,
        receiver: reply.receiver,
      });
    }
    if (input.requestToolOutcome !== 'cancelled') {
      events.push({
        ...base(requesterId),
        type: 'tool.invoked',
        outcome: input.requestToolOutcome,
        operationId,
        tool: 'messages.request',
        resource,
        action: 'send',
        grantId,
        ...(input.requestToolOutcome === 'failed'
          ? { reason: input.requestToolReason ?? 'message_reply_resolution_failed' }
          : {}),
      });
    }
  } else {
    for (const operation of input.operations.filter(row => row.actorId === responderId)) {
      appendFileOperation(operation);
    }
  }
  while (events.length < 32) {
    events.push({
      ...base(input.runBinding.actors.requester.actorId),
      type: 'tool.namespace.catalog.listed',
      outcome: 'succeeded',
      metadata: { totalNamespaces: 0, enabledNamespaces: 0 },
    });
  }
  return events;
}

function fixturePactMutation(contact: any, snapshots: readonly any[]) {
  if (!contact) return undefined;
  const snapshot = snapshots.find(row => row.taskId === contact.taskId);
  if (
    !snapshot
    || !snapshot.before
    || typeof snapshot.before !== 'object'
    || !snapshot.after
    || typeof snapshot.after !== 'object'
    || !Array.isArray(snapshot.before.note_folders)
    || !Array.isArray(snapshot.before.notes)
    || !Array.isArray(snapshot.before.todo_folders)
    || !Array.isArray(snapshot.before.todos)
    || !Array.isArray(snapshot.after.note_folders)
    || !Array.isArray(snapshot.after.notes)
    || !Array.isArray(snapshot.after.todo_folders)
    || !Array.isArray(snapshot.after.todos)
  ) return undefined;
  const notesChanged = !isDeepStrictEqual(snapshot.before.note_folders, snapshot.after.note_folders)
    || !isDeepStrictEqual(snapshot.before.notes, snapshot.after.notes);
  const todosChanged = !isDeepStrictEqual(snapshot.before.todo_folders, snapshot.after.todo_folders)
    || !isDeepStrictEqual(snapshot.before.todos, snapshot.after.todos);
  if (!notesChanged && !todosChanged) return undefined;
  if (notesChanged) {
    const created = snapshot.after.notes.length > snapshot.before.notes.length;
    return {
      taskId: contact.taskId,
      surface: 'notes' as const,
      action: created ? 'create' as const : 'update' as const,
      tool: created ? 'create_note' as const : 'edit_note' as const,
    };
  }
  const created = snapshot.after.todos.length > snapshot.before.todos.length;
  return {
    taskId: contact.taskId,
    surface: 'todos' as const,
    action: created ? 'create' as const : 'update' as const,
    tool: created ? 'create_todo' as const : 'edit_todo' as const,
  };
}

function providerTelemetry(
  model: FileWorkflowRunBindingV1['actors']['requester']['model'],
  withRequest: boolean,
) {
  const request = {
    requestedModel: model.requestedModel,
    resolvedModel: model.resolvedModel,
    provider: model.provider,
    latencyMs: 1,
    attempts: 1,
    outcome: 'success' as const,
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0,
    },
  };
  return {
    requestedModel: model.requestedModel,
    resolvedModel: model.resolvedModel,
    requests: withRequest ? [request] : [],
    totals: withRequest ? {
      requests: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costUsd: 0,
    } : { requests: 0 },
  };
}

function memoryTransitionFromOperation(operation: any) {
  return {
    actorId: operation.actorId,
    previousVersion: operation.previousVersion,
    newVersion: operation.version,
    previousSha256: operation.previousSha256,
    newSha256: operation.sha256,
    byteLength: operation.byteLength,
  };
}

function memoryAuthorityFromOperation(
  operation: any,
  selectedTaskIds: readonly string[],
) {
  return {
    actorId: operation.actorId,
    previousVersion: operation.previousVersion,
    newVersion: operation.version,
    previousSha256: operation.previousSha256,
    newSha256: operation.sha256,
    previousRows: memoryRowsFromBase64(operation.previousBytesBase64, selectedTaskIds),
    newRows: memoryRowsFromBase64(operation.newBytesBase64, selectedTaskIds),
  };
}

function memoryRowsFromBase64(value: string, selectedTaskIds: readonly string[]) {
  const text = Buffer.from(value, 'base64').toString('utf8');
  return selectedTaskIds.map(taskId => {
    const line = text.split('\n').find(candidate => candidate.startsWith(`${taskId} [`));
    const status = line?.match(/^\S+ \[(pending|answered|refused|error)\]/)?.[1];
    if (!status) throw new Error(`Fixture MEMORY is missing ${taskId}`);
    return { taskId, status: status as 'pending' | 'answered' | 'refused' | 'error' };
  });
}

function contactAuthorityFor(input: {
  contact: any;
  acceptedMessages: readonly any[];
  snapshots: readonly any[];
  runBinding: FileWorkflowRunBindingV1;
  eventId: string;
  tick: number;
}) {
  const request = input.acceptedMessages[0];
  const reply = input.acceptedMessages[1];
  const kind = input.runBinding.selectedTasks.find(
    task => task.taskId === input.contact.taskId,
  )?.kind;
  const snapshot = input.snapshots.find(value => value.taskId === input.contact.taskId);
  return {
    taskId: input.contact.taskId,
    contactId: request.id,
    ...(reply ? { replyMessageId: reply.id } : {}),
    ...(reply || input.contact.responderExecutionId ? {
      responderExecutionId: stableIdV1('execution', [
        'responder-execution',
        request.id,
        input.runBinding.actors.responder.actorId,
      ]),
    } : {}),
    kind,
    status: input.contact.status,
    ...(input.contact.status === 'completed'
      ? {}
      : { errorCode: input.contact.errorCode }),
    senderId: request.sender.agentId,
    recipientId: request.receiver.agentId,
    eventId: input.eventId,
    ...(snapshot ? {
      actionSnapshotDigest: digestCanonicalFixture(snapshot),
      stateChanged: canonicalFixture(snapshot.before) !== canonicalFixture(snapshot.after),
    } : {}),
  };
}

function fixtureTimestamp(tick: number, offsetMs: number): string {
  return new Date(Date.UTC(2026, 7, 26) + tick * 1_000 + offsetMs).toISOString();
}

function digestCanonicalFixture(value: unknown): string {
  return createHash('sha256').update(canonicalFixture(value)).digest('hex');
}

function canonicalFixture(value: unknown): string {
  return JSON.stringify(sortFixtureJson(value));
}

function sortFixtureJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortFixtureJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortFixtureJson(nested)]));
  }
  return value;
}

function receipt(
  actorId: string,
  path: 'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md',
  version: number,
  value: { sha256: string; byteLength: number },
) {
  return {
    actorId,
    path,
    action: 'read' as const,
    version,
    sha256: value.sha256,
    byteLength: value.byteLength,
  };
}

function usage(contactCalls: number) {
  return {
    modelCalls: 1,
    toolSteps: 4,
    contactCalls,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: 0,
  };
}

function taskDigest(taskIds: readonly string[]) {
  return createHash('sha256').update(JSON.stringify(taskIds)).digest('hex');
}

export const fileSessionRegistryRootV1 = join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'dataset',
  'shared-eval',
  'workspaces',
  'v1',
);

export function fileSessionQaTasksV1(ids: readonly string[]): LoadedPactPairTaskV1[] {
  return loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
    kind: 'qa',
    ids: [...ids],
  });
}

export function fileSessionActionTasksV1(ids: readonly string[]): LoadedPactPairTaskV1[] {
  return loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
    kind: 'action',
    ids: [...ids],
  });
}

export const fileSessionActorsV1 = Object.freeze({
  requester: Object.freeze({
    actorId: 'requester-tina',
    references: Object.freeze({
      agent: Object.freeze({ id: 'agents/tina/base/agent', version: '1.1.0' }),
      heartbeat: Object.freeze({ id: 'heartbeats/files-multi', version: '1.1.0' }),
      policy: Object.freeze({ id: 'agents/tina/base/policy', version: '1.0.0' }),
      memory: Object.freeze({ id: 'memory-seeds/pact-pair-requester', version: '1.0.0' }),
    }),
  }),
  responder: Object.freeze({
    actorId: 'responder-alex',
    references: Object.freeze({
      agent: Object.freeze({ id: 'agents/alex/base/agent', version: '1.1.0' }),
      heartbeat: Object.freeze({ id: 'agents/alex/base/heartbeat', version: '1.1.0' }),
      policy: Object.freeze({ id: 'policies/pact-pair-defense/d2', version: '1.0.0' }),
      memory: Object.freeze({ id: 'agents/alex/base/memory', version: '1.0.0' }),
    }),
  }),
});

export const fileSessionSingleActorsV1 = Object.freeze({
  requester: Object.freeze({
    ...fileSessionActorsV1.requester,
    references: Object.freeze({
      ...fileSessionActorsV1.requester.references,
      heartbeat: Object.freeze({ id: 'heartbeats/files-single', version: '1.1.0' }),
    }),
  }),
  responder: fileSessionActorsV1.responder,
});

export type FakeSharedOsFileSessionTraceV1 = {
  creates: CreateSharedOsFileSessionV1Options[];
  turns: Array<{
    sessionIndex: number;
    tick: number;
    eventId: string;
    traceId: string;
    inputDigest?: string;
  }>;
  closes: number[];
  lifecycle?: string[];
};

export function emptyFileProviderTelemetryV1(): FileProviderTelemetryV1 {
  return {
    requestedModel: 'fake-model',
    resolvedModel: 'fake-model',
    requests: [],
    totals: { requests: 0 },
  };
}

/**
 * A scheduler-only test double. It stands in for the complete SharedOS
 * session boundary and intentionally exposes no harness, contact port, tool
 * handler, authorizer, or kernel seam to scheduler tests.
 */
export function createFakeSharedOsFileSessionFactoryV1(input: {
  trace: FakeSharedOsFileSessionTraceV1;
  runProvenance?: FileWorkflowHostRunProvenanceV1;
  failCreateForSessionIndexes?: ReadonlySet<number>;
  failTurnForSessionIndexes?: ReadonlySet<number>;
  failCloseForSessionIndexes?: ReadonlySet<number>;
  requesterExecutionStatus?: 'succeeded' | 'failed';
  leaveTaskPending?: boolean;
  contactStatus?: 'denied' | 'failed';
  /**
   * Scripted multi-turn behavior: entry [tick-1] names the contacted task, its
   * contact outcome, and the requester MEMORY status written that tick (absent
   * means the row stays pending and no MEMORY replace happens). Overrides the
   * default one-task-per-tick refusal walk.
   */
  tickScript?: ReadonlyArray<Readonly<{
    taskId: string;
    contactStatus: 'denied' | 'completed';
    memoryStatus?: 'answered' | 'refused';
  }>>;
  mutatePactWorkspaceForTask?: (
    workspace: CreateSharedOsFileSessionV1Options['pactWorkspace'],
    task: LoadedPactPairTaskV1,
  ) => void;
}): SharedOsFileSessionFactoryV1 {
  return async options => {
    input.trace.creates.push(options);
    if (input.failCreateForSessionIndexes?.has(options.sessionIndex)) {
      throw new Error('PRIVATE_FAKE_SESSION_CREATE_FAILURE');
    }
    const provenance = Object.freeze({
      runStartedAt: '2026-08-26T00:00:00.000Z',
      namespaceId: options.namespaceId,
      grantManifestDigest: hex(`grant-manifest:${options.runId}`),
      sharedOsRevision: 'b'.repeat(40),
      sharedOsRuntimeDigest: hex(`sharedos-runtime:${options.runId}`),
    });
    const runProvenance = input.runProvenance ?? fileWorkflowHostRunProvenanceFixtureV1;
    const [requesterSnapshot, responderSnapshot] = await Promise.all([
      options.requester.workspace.snapshot(options.requester.actorId),
      options.responder.workspace.snapshot(options.responder.actorId),
    ]);
    const runBinding: FileWorkflowRunBindingV1 = {
      apiVersion: 'sharedeval-file-run-binding/v1',
      workflowId: 'files-multi',
      runId: options.runId,
      selectedTaskIds: options.tasks.map(task => task.taskId),
      selectedTasks: options.tasks.map(task => ({ taskId: task.taskId, kind: task.kind })),
      selectedTaskDigest: taskDigest(options.tasks.map(task => task.taskId)),
      scheduler: {
        sessionId: `session-${options.runId}`,
        sessionIndex: options.sessionIndex,
        maxTicks: options.maxTicks,
        budget: { deadlineMs: options.deadlineMs, maxToolCalls: options.maxToolCalls },
        initialActionSha256: hex('fake-initial-pact-action-state'),
      },
      dataset: structuredClone(runProvenance.dataset),
      goldSet: structuredClone(runProvenance.goldSet),
      policies: {
        requester: {
          id: 'sharedeval/scheduler/ordered-public-task-queue',
          version: '1.0.0',
          sha256: requesterSnapshot.initial.files['POLICY.md'].sha256,
        },
        responder: {
          id: 'policies/pact-pair-defense/d2',
          version: '1.0.0',
          sha256: responderSnapshot.initial.files['POLICY.md'].sha256,
        },
      },
      actors: {
        requester: {
          actorId: options.requester.actorId,
          references: structuredClone(fileSessionActorsV1.requester.references),
          model: structuredClone(runProvenance.models.requester),
          initial: bindingFileSet(requesterSnapshot.initial.files),
        },
        responder: {
          actorId: options.responder.actorId,
          references: structuredClone(fileSessionActorsV1.responder.references),
          model: structuredClone(runProvenance.models.responder),
          initial: bindingFileSet(responderSnapshot.initial.files),
        },
      },
      backend: structuredClone(runProvenance.backend),
      sharedOs: structuredClone(provenance),
    };
    let taskIndex = requesterSnapshot.final.version;
    return {
      provenance,
      runRequesterTurn: async turn => {
        input.trace.lifecycle?.push(`turn:${options.sessionIndex}:${turn.tick}`);
        input.trace.turns.push({
          sessionIndex: options.sessionIndex,
          tick: turn.tick,
          eventId: turn.eventId,
          traceId: turn.traceId,
          inputDigest: turn.inputDigest,
        });
        if (input.failTurnForSessionIndexes?.has(options.sessionIndex)) {
          throw new Error('PRIVATE_FAKE_SESSION_TURN_FAILURE');
        }
        const scriptEntry = input.tickScript?.[turn.tick - 1];
        if (input.tickScript && !scriptEntry) {
          throw new Error('Fake SharedOS tick script exhausted');
        }
        const task = scriptEntry
          ? options.tasks.find(candidate => candidate.taskId === scriptEntry.taskId)
          : options.tasks[taskIndex];
        if (!task) throw new Error('Fake SharedOS session exhausted its task queue');
        if (!scriptEntry) taskIndex += 1;
        const requesterRead = await readFourFiles(
          options.requester.workspace,
          options.requester.actorId,
        );
        await readFourFiles(
          options.responder.workspace,
          options.responder.actorId,
        );
        const memory = requesterRead.loaded['MEMORY.md'];
        const memoryBody = memory.content.endsWith('\n')
          ? memory.content.slice(0, -1)
          : memory.content;
        const requesterExecutionStatus = input.requesterExecutionStatus ?? 'succeeded';
        const rows = memoryBody.split('\n').map(line => {
          if (!line.startsWith(`${task.taskId} `)) return line;
          if (scriptEntry) {
            return scriptEntry.memoryStatus
              ? `${task.taskId} [${scriptEntry.memoryStatus}] — scripted fake reply`
              : line;
          }
          return input.leaveTaskPending
            ? line
            : requesterExecutionStatus === 'failed'
              ? `${task.taskId} [error] — fake SharedOS execution failure`
              : `${task.taskId} [refused] — fake SharedOS reply`;
        });
        const nextMemory = `${rows.join('\n')}\n`;
        const commitsMemory = requesterExecutionStatus === 'succeeded' && (
          scriptEntry ? scriptEntry.memoryStatus !== undefined : !input.leaveTaskPending
        );
        if (commitsMemory) {
          const replacement = await options.requester.workspace.replaceMemory({
            actorId: options.requester.actorId,
            expectedVersion: memory.receipt.version,
            content: nextMemory,
          });
          if (replacement.outcome !== 'committed') {
            throw new Error('Fake SharedOS session lost requester MEMORY authority');
          }
        }
        const actionBefore = options.pactWorkspace.snapshot();
        if (requesterExecutionStatus === 'succeeded' && !scriptEntry && !input.leaveTaskPending) {
          input.mutatePactWorkspaceForTask?.(options.pactWorkspace, task);
        }
        const actionAfter = options.pactWorkspace.snapshot();
        const contactSeed = `fake-provider-contact-${turn.tick}`;
        const contactStatus = scriptEntry
          ? scriptEntry.contactStatus
          : input.contactStatus ?? 'denied';
        const includeContact = scriptEntry !== undefined
          || (requesterExecutionStatus === 'succeeded' && !input.leaveTaskPending);
        const payload = heartbeatPayloadFor(runBinding, turn.tick, [], {
          traceId: turn.traceId,
          omitSessionStopReason: true,
          requesterExecutionStatus,
          omitRequesterMemoryReplace: !commitsMemory,
          requesterMemory: {
            previousVersion: memory.receipt.version,
            previousBytesBase64: Buffer.from(memory.content).toString('base64'),
            newBytesBase64: Buffer.from(nextMemory).toString('base64'),
          },
          ...(includeContact
            ? {
              contact: {
                taskId: task.taskId,
                requestMessageId: contactSeed,
                message: `fake SharedOS request for ${task.taskId}`,
                status: contactStatus,
                ...(contactStatus === 'completed'
                  ? { response: `scripted fake answer for ${task.taskId}` }
                  : {
                    errorCode: contactStatus === 'denied'
                      ? 'CONTACT_RESPONDER_DENIED'
                      : 'CONTACT_RESPONDER_FAILED',
                  }),
                ...(contactStatus === 'failed' ? { responderExecutionId: 'started' } : {}),
              },
            }
            : {}),
          ...(requesterExecutionStatus === 'succeeded' && !input.leaveTaskPending
            && task.kind === 'action'
            ? {
              actionSnapshots: [{
                taskId: task.taskId,
                contactId: contactSeed,
                actorId: options.responder.actorId,
                eventId: turn.eventId,
                before: actionBefore,
                after: actionAfter,
              }],
            }
            : {}),
        }) as FileWorkflowHeartbeatPayloadV1;
        const contact = payload.contactAuthority;
        const evidence = payload.privateEvidence;
        if (!evidence) throw new Error('Fake SharedOS evidence must retain its private source');
        const requesterReads = payload.fileReads.filter(
          row => row.actorId === options.requester.actorId,
        );
        const responderReads = payload.fileReads.filter(
          row => row.actorId === options.responder.actorId,
        );
        const executionId = stableIdV1('execution', [
          'requester-execution',
          turn.eventId,
          options.requester.actorId,
        ]);
        return Object.freeze({
          executionId,
          traceId: turn.traceId,
          executionStatus: requesterExecutionStatus,
          decision: evidence.tickDecisions[0] ?? null,
          requesterReads: Object.freeze(requesterReads),
          ...(contact
            ? {
              contact: Object.freeze({
                taskId: task.taskId,
                requestMessageId: contact.contactId,
                ...(contact.replyMessageId ? { replyMessageId: contact.replyMessageId } : {}),
                ...(contact.responderExecutionId
                  ? { responderExecutionId: contact.responderExecutionId }
                  : {}),
                status: contactStatus,
                responderReads: Object.freeze(responderReads),
                ...(contactStatus === 'completed'
                  ? { response: `scripted fake answer for ${task.taskId}` }
                  : {
                    errorCode: contactStatus === 'denied'
                      ? 'CONTACT_RESPONDER_DENIED' as const
                      : 'CONTACT_RESPONDER_FAILED' as const,
                  }),
                providerUsage: evidence.providerTelemetry.responder!,
              }),
            }
            : {}),
          providerUsage: evidence.providerTelemetry.requester,
          provenance,
          sourceEvidence: liveSourceEvidence(evidence.sourceEvidence),
          audit: payload.sharedOsAuthority.audit,
        }) satisfies SharedOsFileTurnResultV1;
      },
      close: async () => {
        input.trace.lifecycle?.push(`session.close:${options.sessionIndex}`);
        if (input.failCloseForSessionIndexes?.has(options.sessionIndex)) {
          throw new Error('PRIVATE_FAKE_SESSION_CLOSE_FAILURE');
        }
        input.trace.closes.push(options.sessionIndex);
      },
    };
  };
}

function bindingFileSet(
  files: Awaited<ReturnType<CreateSharedOsFileSessionV1Options['requester']['workspace']['snapshot']>>['initial']['files'],
): FileWorkflowRunBindingV1['actors']['requester']['initial'] {
  return {
    'AGENT.md': { ...files['AGENT.md'], path: 'AGENT.md' },
    'HEARTBEAT.md': { ...files['HEARTBEAT.md'], path: 'HEARTBEAT.md' },
    'POLICY.md': { ...files['POLICY.md'], path: 'POLICY.md' },
    'MEMORY.md': { ...files['MEMORY.md'], path: 'MEMORY.md' },
  };
}

function liveSourceEvidence(
  source: NonNullable<FileWorkflowHeartbeatPayloadV1['privateEvidence']>['sourceEvidence'],
): SharedOsFileTurnResultV1['sourceEvidence'] {
  const operations = (rows: typeof source.requesterFileOperations) => rows.map(row => {
    if (row.action === 'replace' && row.outcome === 'conflict') {
      throw new Error('Fake SharedOS live evidence cannot normalize away conflict bytes');
    }
    return structuredClone(row);
  }) as SharedOsFileOperationReceiptV1[];
  return {
    requesterFileOperations: operations(source.requesterFileOperations),
    responderFileOperations: operations(source.responderFileOperations),
    acceptedMessages: source.acceptedMessages.map(row => {
      const { provenance, payload: _payload, ...base } = structuredClone(row);
      return {
        ...base,
        payload: jsonValueSchema.parse(row.payload),
        ...(provenance
          ? {
            provenance: {
              source: provenance.source,
              parentIds: [...provenance.parentIds],
              ...(provenance.metadata
                ? { metadata: jsonObjectSchema.parse(provenance.metadata) }
                : {}),
            },
          }
          : {}),
      } satisfies SoMessageEnvelope;
    }),
    auditEvents: source.auditEvents.map(row => {
      const { metadata, ...base } = structuredClone(row);
      return {
        ...base,
        ...(metadata ? { metadata: jsonObjectSchema.parse(metadata) } : {}),
      } satisfies SoAuditEvent;
    }),
  };
}

export function unreachableFileTurnDriverV1(): ReturnType<
  CreateSharedOsFileSessionV1Options['createDriver']
> {
  throw new Error('The fake SharedOS session must not construct a model driver');
}

async function readFourFiles(
  workspace: CreateSharedOsFileSessionV1Options['requester']['workspace'],
  actorId: string,
): Promise<{
  receipts: FileReadReceiptV1[];
  loaded: Record<'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md', {
    content: string;
    receipt: FileReadReceiptV1;
  }>;
}> {
  const receipts: FileReadReceiptV1[] = [];
  const loaded = {} as Record<
    'AGENT.md' | 'HEARTBEAT.md' | 'POLICY.md' | 'MEMORY.md',
    { content: string; receipt: FileReadReceiptV1 }
  >;
  for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const) {
    const value = await workspace.read({ actorId, path });
    loaded[path] = value;
    receipts.push(value.receipt);
  }
  return { receipts, loaded };
}
