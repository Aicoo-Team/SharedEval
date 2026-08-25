import { createHash } from 'node:crypto';
import type {
  FileWorkflowHeartbeatPayloadV1,
  FileWorkflowPrivateEvidenceV1,
  FileWorkflowRunBindingV1,
  FileWorkflowTerminalTransitionV1,
} from '../../src/runner/v1/file-workflow-artifacts.js';

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

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
    dataset: {
      id: 'pact-pair',
      split: 'test',
      sourceRevision: 'a'.repeat(40),
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
    backend: { adapterId: 'pact-public-runner', executor: 'scripted-harness' },
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
  const previousMemoryVersion = Math.max(0, tick - 1);
  const previousMemory = memoryContent(runBinding.selectedTaskIds, previousMemoryVersion);
  const nextMemory = memoryContent(
    runBinding.selectedTaskIds,
    tick,
    Object.fromEntries(rebound.flatMap(row => (
      row.result.status === 'answered' || row.result.status === 'refused'
        ? [[row.taskId, row.result.status]]
        : []
    ))),
  );
  const initial = runBinding.actors.requester.initial;
  const contactRequests = (privateValue?.contactRequests ?? []).map((contact: any) => ({
    requestTraceId: `trace-${tick}`,
    deadlineMs: 1_000,
    ...(contact.status === 'completed' ? { response: 'completed' } : {}),
    ...(contact.status === 'denied' ? { errorCode: 'CONTACT_RESPONDER_DENIED' } : {}),
    ...(contact.status === 'failed' ? { errorCode: 'CONTACT_RESPONDER_FAILED' } : {}),
    ...(contact.status === 'cancelled' ? { errorCode: 'CONTACT_CANCELLED' } : {}),
    ...contact,
  }));
  const contact = contactRequests[0];
  const privateEvidence: FileWorkflowPrivateEvidenceV1 = {
    contactRequests,
    memory: privateValue?.memory ?? {
      actorId: 'requester',
      previousBytesBase64: Buffer.from(previousMemory).toString('base64'),
      newBytesBase64: Buffer.from(nextMemory).toString('base64'),
    },
    actionSnapshots: privateValue?.actionSnapshots ?? [],
    tickDecisions: privateValue?.tickDecisions ?? [],
    fullEvaluations: privateValue?.fullEvaluations ?? [],
  };
  return {
    event: {
      eventId: `event-${tick}`,
      runId: runBinding.runId,
      sessionId: `session-${runBinding.runId}`,
      tick,
      actorId: 'requester',
      traceId: `trace-${tick}`,
    },
    selectedTaskId: contact?.taskId ?? rebound[0]?.taskId,
    ...(contact ? { correlatedContactId: contact.recipientTraceId } : {}),
    fileReads: [
      receipt('requester', 'AGENT.md', previousMemoryVersion, initial['AGENT.md']),
      receipt('requester', 'HEARTBEAT.md', previousMemoryVersion, initial['HEARTBEAT.md']),
      receipt('requester', 'POLICY.md', previousMemoryVersion, initial['POLICY.md']),
      receipt(
        'requester',
        'MEMORY.md',
        previousMemoryVersion,
        metadata('MEMORY.md', previousMemory),
      ),
      ...(
        contact && (contact.status === 'completed' || contact.status === 'denied')
          ? (['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const).map(path => (
              receipt(
                'responder',
                path,
                0,
                runBinding.actors.responder.initial[path],
              )
            ))
          : []
      ),
    ],
    memoryTransition: {
      actorId: 'requester',
      previousVersion: previousMemoryVersion,
      newVersion: tick,
      previousSha256: hex(previousMemory),
      newSha256: hex(nextMemory),
      byteLength: Buffer.byteLength(nextMemory),
    },
    transitions: rebound,
    provider: {
      requester: {
        provider: 'scripted', requestedModel: 'requester-v1', resolvedModel: 'requester-v1',
      },
      responder: {
        provider: 'scripted', requestedModel: 'responder-v1', resolvedModel: 'responder-v1',
      },
    },
    usage: usage(contact ? 1 : 0),
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
    backend: { adapterId: 'pact-public-runner', executor: 'scripted-harness' },
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
