import { isDeepStrictEqual } from 'node:util';

import { stableIdV1 } from '../../contracts/json.js';
import {
  deriveFileMemoryTerminalStatusV1,
} from './file-memory.js';
import {
  fileWorkflowContactAuthorityV1Schema,
  fileWorkflowHeartbeatPayloadV1Schema,
  fileWorkflowRunBindingV1Schema,
  type FileWorkflowContactAuthorityV1,
  type FileWorkflowHeartbeatPayloadV1,
  type FileWorkflowPublicResultV1,
  type FileWorkflowRunBindingV1,
} from './file-workflow-artifacts.js';
import type { FileWorkflowSharedOsProjectionV1 } from './file-workflow-sharedos-evidence.js';
import { pactPairMetricContributionsV1 } from '../../suites/pact-pair/evaluation.js';
import {
  toPublicEvaluation,
  type PactPairEvaluationV1,
} from '../../suites/pact-pair/public-evaluation.js';

type TerminalStatus = FileWorkflowPublicResultV1['status'];
type PublicErrorCode = NonNullable<FileWorkflowPublicResultV1['errorCode']>;

export type FileWorkflowHeartbeatTerminalOutcomeV1 = Readonly<{
  taskId: string;
  status: TerminalStatus;
  contactId?: string;
  errorCode?: PublicErrorCode;
  fullEvaluation: PactPairEvaluationV1 | null;
}>;

export type BuildFileWorkflowHeartbeatPayloadV1Input = Readonly<{
  binding: FileWorkflowRunBindingV1;
  sessionId: string;
  heartbeat: Readonly<{
    eventId: string;
    tick: number;
    traceId: string;
    inputDigest: string;
  }>;
  native: FileWorkflowSharedOsProjectionV1;
  history: Readonly<{
    terminalTaskIds: readonly string[];
    contacts: readonly FileWorkflowContactAuthorityV1[];
  }>;
  terminalOutcomes: readonly FileWorkflowHeartbeatTerminalOutcomeV1[];
  sessionStopReason?: 'all_terminal' | 'tick_exhausted' | 'fatal_error';
}>;

/** Assemble scheduler-owned terminal/evaluation state around canonical native evidence. */
export function buildFileWorkflowHeartbeatPayloadV1(
  input: BuildFileWorkflowHeartbeatPayloadV1Input,
): FileWorkflowHeartbeatPayloadV1 {
  const binding = fileWorkflowRunBindingV1Schema.parse(input.binding);
  assertNativeBinding(input, binding);
  assertTerminalSet(input, binding);
  const contacts = collectContacts(input, binding);
  const memoryDeltas = terminalMemoryDeltas(input.native, binding);
  const transitions = input.terminalOutcomes.map(outcome => buildTransition(
    input,
    binding,
    outcome,
    contacts.get(outcome.contactId ?? ''),
    memoryDeltas,
  ));
  for (const taskId of memoryDeltas.keys()) {
    if (!input.terminalOutcomes.some(outcome => outcome.taskId === taskId)) {
      throw new Error('Every requester terminal MEMORY delta requires a current terminal outcome');
    }
  }
  const fullEvaluations = input.terminalOutcomes.flatMap((outcome, index) => (
    outcome.fullEvaluation
      ? [{
        taskId: outcome.taskId,
        evaluation: structuredClone(outcome.fullEvaluation),
        metrics: structuredClone(transitions[index]!.evaluation.metrics),
      }]
      : []
  ));
  const currentContact = input.native.currentContact?.authority;
  const candidate = {
    inputDigest: input.heartbeat.inputDigest,
    event: {
      eventId: input.heartbeat.eventId,
      runId: binding.runId,
      sessionId: input.sessionId,
      tick: input.heartbeat.tick,
      actorId: binding.actors.requester.actorId,
      traceId: input.heartbeat.traceId,
    },
    ...(currentContact ? { contactAuthority: structuredClone(currentContact) } : {}),
    fileReads: structuredClone(input.native.fileReads),
    memoryTransitions: structuredClone(input.native.memoryTransitions),
    memoryAuthorities: structuredClone(input.native.memoryAuthorities),
    transitions,
    sharedOsAuthority: structuredClone(input.native.sharedOsAuthority),
    ...(input.sessionStopReason ? { sessionStopReason: input.sessionStopReason } : {}),
    provider: structuredClone(input.native.provider),
    usage: structuredClone(input.native.usage),
    privateEvidence: {
      ...structuredClone(input.native.retainedEvidence),
      fullEvaluations,
    },
  };
  return deepFreeze(fileWorkflowHeartbeatPayloadV1Schema.parse(candidate));
}

function assertNativeBinding(
  input: BuildFileWorkflowHeartbeatPayloadV1Input,
  binding: FileWorkflowRunBindingV1,
): void {
  const authority = input.native.sharedOsAuthority;
  const runAuthority = {
    runStartedAt: authority.runStartedAt,
    namespaceId: authority.namespaceId,
    grantManifestDigest: authority.grantManifestDigest,
    sharedOsRevision: authority.sharedOsRevision,
    sharedOsRuntimeDigest: authority.sharedOsRuntimeDigest,
  };
  const expectedExecutionId = stableIdV1('execution', [
    'requester-execution',
    input.heartbeat.eventId,
    binding.actors.requester.actorId,
  ]);
  if (
    !isDeepStrictEqual(runAuthority, binding.sharedOs)
    || authority.requesterExecutionId !== expectedExecutionId
    || (
      input.native.currentContact?.authority.eventId !== undefined
      && input.native.currentContact.authority.eventId !== input.heartbeat.eventId
    )
    || input.native.retainedEvidence.requesterExecutionStatus
      !== authority.requesterExecutionStatus
  ) {
    throw new Error('Canonical SharedOS projection conflicts with the run or heartbeat binding');
  }
  const decisions = input.native.retainedEvidence.tickDecisions;
  if ((authority.requesterExecutionStatus === 'succeeded') !== (decisions.length === 1)) {
    throw new Error('Canonical SharedOS projection has inconsistent requester decision authority');
  }
  if (authority.requesterExecutionStatus !== 'succeeded'
    && input.sessionStopReason !== 'fatal_error') {
    throw new Error('A non-succeeded SharedOS turn requires fatal_error stop authority');
  }
  if (decisions[0]?.type === 'cancelled' && input.sessionStopReason !== 'fatal_error') {
    throw new Error('A cancelled requester decision requires fatal_error stop authority');
  }
}

function collectContacts(
  input: BuildFileWorkflowHeartbeatPayloadV1Input,
  binding: FileWorkflowRunBindingV1,
): ReadonlyMap<string, FileWorkflowContactAuthorityV1> {
  const selected = new Set(binding.selectedTaskIds);
  const byContact = new Map<string, FileWorkflowContactAuthorityV1>();
  const taskIds = new Set<string>();
  const messageIds = new Set<string>();
  const executionIds = new Set<string>();
  const values = [
    ...input.history.contacts,
    ...(input.native.currentContact ? [input.native.currentContact.authority] : []),
  ];
  const currentContact = input.native.currentContact?.authority;
  if (currentContact && input.history.terminalTaskIds.includes(currentContact.taskId)) {
    throw new Error('Current contact cannot target a task that is already terminal in history');
  }
  for (const value of values) {
    const contact = fileWorkflowContactAuthorityV1Schema.parse(value);
    const identities = [contact.contactId, ...(contact.replyMessageId ? [contact.replyMessageId] : [])];
    if (
      !selected.has(contact.taskId)
      || taskIds.has(contact.taskId)
      || byContact.has(contact.contactId)
      || identities.some(id => messageIds.has(id))
      || (contact.responderExecutionId && executionIds.has(contact.responderExecutionId))
    ) {
      throw new Error('Contact history must carry unique selected task and native identities');
    }
    taskIds.add(contact.taskId);
    for (const id of identities) messageIds.add(id);
    if (contact.responderExecutionId) executionIds.add(contact.responderExecutionId);
    byContact.set(contact.contactId, contact);
  }
  return byContact;
}

function assertTerminalSet(
  input: BuildFileWorkflowHeartbeatPayloadV1Input,
  binding: FileWorkflowRunBindingV1,
): void {
  const selectedIndex = new Map(binding.selectedTaskIds.map((taskId, index) => [taskId, index]));
  const prior = new Set(input.history.terminalTaskIds);
  if (prior.size !== input.history.terminalTaskIds.length) {
    throw new Error('Prior terminal task IDs must be unique');
  }
  for (const taskId of prior) {
    if (!selectedIndex.has(taskId)) throw new Error('Prior terminal authority is outside the selected set');
  }
  const current = new Set<string>();
  let lastIndex = -1;
  for (const outcome of input.terminalOutcomes) {
    const index = selectedIndex.get(outcome.taskId);
    if (index === undefined || prior.has(outcome.taskId) || current.has(outcome.taskId)) {
      throw new Error('New terminal outcomes must be selected, unique, and disjoint from prior terminal authority');
    }
    if (index <= lastIndex) throw new Error('New terminal outcomes must preserve selected-task order');
    current.add(outcome.taskId);
    lastIndex = index;
  }
  const complete = prior.size + current.size === binding.selectedTaskIds.length;
  if (complete !== (input.sessionStopReason !== undefined)) {
    throw new Error('Only the cardinality-complete heartbeat may carry the required stop reason');
  }
  const statuses = input.terminalOutcomes.map(outcome => outcome.status);
  if (statuses.includes('no_response') && input.sessionStopReason !== 'tick_exhausted') {
    throw new Error('no_response authority is allowed only for tick_exhausted');
  }
  if (input.sessionStopReason === 'all_terminal' && statuses.includes('no_response')) {
    throw new Error('all_terminal cannot create no_response authority');
  }
  if (
    input.sessionStopReason === 'tick_exhausted'
    && !statuses.some(status => status === 'no_response' || status === 'side_effect_before_failure')
  ) {
    throw new Error('tick_exhausted requires a current fallback authority');
  }
  if (
    input.sessionStopReason === 'fatal_error'
    && (
      statuses.includes('no_response')
      || !statuses.some(status => status === 'error' || status === 'side_effect_before_failure')
    )
  ) {
    throw new Error('fatal_error requires error authority and forbids no_response');
  }
}

function terminalMemoryDeltas(
  native: FileWorkflowSharedOsProjectionV1,
  binding: FileWorkflowRunBindingV1,
): ReadonlyMap<string, 'answered' | 'refused' | 'error'> {
  const requester = native.memoryAuthorities.find(row => (
    row.actorId === binding.actors.requester.actorId
  ));
  if (!requester) return new Map();
  if (!isDeepStrictEqual(
    requester.newRows.map(row => row.taskId),
    binding.selectedTaskIds,
  )) {
    throw new Error('Requester MEMORY authority conflicts with the selected task order');
  }
  return new Map(requester.newRows.flatMap((row, index) => (
    requester.previousRows[index]?.status === 'pending' && row.status !== 'pending'
      ? [[row.taskId, row.status] as const]
      : []
  )));
}

function buildTransition(
  input: BuildFileWorkflowHeartbeatPayloadV1Input,
  binding: FileWorkflowRunBindingV1,
  outcome: FileWorkflowHeartbeatTerminalOutcomeV1,
  contact: FileWorkflowContactAuthorityV1 | undefined,
  memoryDeltas: ReadonlyMap<string, 'answered' | 'refused' | 'error'>,
) {
  const selectedTask = binding.selectedTasks.find(task => task.taskId === outcome.taskId);
  if (!selectedTask) throw new Error('Terminal outcome is outside the immutable task binding');
  validateOutcome(outcome, contact, memoryDeltas.get(outcome.taskId), selectedTask.kind);
  const publicEvaluation = outcome.fullEvaluation
    ? toPublicEvaluation(structuredClone(outcome.fullEvaluation))
    : null;
  const metrics = outcome.fullEvaluation
    ? pactPairMetricContributionsV1(outcome.fullEvaluation).map(metric => (
      outcome.status === 'side_effect_before_failure' && metric.metric !== 'actionSafety'
        ? { ...metric, numerator: 0, denominator: 0 }
        : { ...metric }
    ))
    : [];
  const result = {
    apiVersion: 'sharedeval-file-result/v1' as const,
    workflowId: binding.workflowId,
    runId: binding.runId,
    sessionId: input.sessionId,
    taskId: outcome.taskId,
    kind: selectedTask.kind,
    status: outcome.status,
    terminalTick: input.heartbeat.tick,
    ...(contact ? { contactStatus: contact.status } : {}),
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    publicEvaluation,
    selectedTaskDigest: binding.selectedTaskDigest,
    backend: structuredClone(binding.backend),
  };
  return {
    taskId: outcome.taskId,
    ...(outcome.contactId ? { contactId: outcome.contactId } : {}),
    result,
    evaluation: {
      apiVersion: 'sharedeval-file-evaluation/v1' as const,
      workflowId: binding.workflowId,
      runId: binding.runId,
      sessionId: input.sessionId,
      taskId: outcome.taskId,
      publicEvaluation: structuredClone(publicEvaluation),
      metrics,
    },
  };
}

function validateOutcome(
  outcome: FileWorkflowHeartbeatTerminalOutcomeV1,
  contact: FileWorkflowContactAuthorityV1 | undefined,
  memoryDelta: 'answered' | 'refused' | 'error' | undefined,
  taskKind: 'qa' | 'action',
): void {
  if (outcome.contactId) {
    if (
      !contact
      || outcome.taskId !== contact.taskId
    ) {
      throw new Error('Terminal outcome conflicts with current or historical contact authority');
    }
  } else if (outcome.status === 'answered' || outcome.status === 'refused') {
    throw new Error('Answered and refused outcomes require native contact authority');
  }
  if ((outcome.status === 'answered' || outcome.status === 'refused') && !memoryDelta) {
    throw new Error(`${outcome.status} requires a same-turn MEMORY terminal delta`);
  }
  if (memoryDelta) {
    if (!contact) throw new Error('A terminal MEMORY delta requires matching contact authority');
    const derived = deriveFileMemoryTerminalStatusV1({
      memoryStatus: memoryDelta,
      contactStatus: contact.status,
      stateChanged: contact.stateChanged ?? false,
    });
    if (derived !== outcome.status) {
      throw new Error('Terminal outcome conflicts with its MEMORY delta and contact authority');
    }
  }
  if (outcome.status === 'side_effect_before_failure' && (
    !contact || contact.kind !== 'action' || contact.stateChanged !== true
  )) {
    throw new Error('side_effect_before_failure requires a changed action contact');
  }
  if (
    contact?.kind === 'action'
    && contact.stateChanged === true
    && (outcome.status === 'error' || outcome.status === 'no_response')
  ) {
    throw new Error('A changed action fallback must use side_effect_before_failure');
  }
  if (
    contact?.errorCode !== undefined
    && (outcome.status === 'error' || outcome.status === 'side_effect_before_failure')
    && outcome.errorCode !== contact.errorCode
  ) {
    throw new Error(`Terminal contact failure code must preserve ${contact.errorCode}`);
  }
  if (
    taskKind === 'action'
    && outcome.fullEvaluation?.kind === 'action'
    && contact?.stateChanged !== undefined
    && outcome.fullEvaluation.stateChanged !== contact.stateChanged
  ) {
    throw new Error('Action evaluation state change conflicts with contact snapshot authority');
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
