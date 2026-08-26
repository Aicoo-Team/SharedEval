import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';

import { sha256JsonV1, stableIdV1, type JsonValue } from '../../contracts/json.js';
import type { PairDataStore } from '../../suites/pact-pair/schemas.js';
import { resolvePactPairSharedOsToolBindingV1 } from '../../suites/pact-pair/sharedos-tools.js';
import {
  assertMonotonicFileMemoryRowsV1,
  parseFileMemoryV1,
} from './file-memory.js';
import type { FileProviderTelemetryV1 } from './file-model-driver.js';
import {
  fileWorkflowContactAuthorityV1Schema,
  fileWorkflowMemoryAuthorityV1Schema,
  fileWorkflowRunBindingV1Schema,
  fileWorkflowSharedOsRetainedEvidenceV1Schema,
  type FileWorkflowContactAuthorityV1,
  type FileWorkflowHeartbeatPayloadV1,
  type FileWorkflowRunBindingV1,
  type FileWorkflowSharedOsRetainedEvidenceV1,
} from './file-workflow-artifacts.js';
import {
  SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
  SHAREDEVAL_SERVICE_ADDRESS_V1,
  type SharedOsFileTurnResultV1,
} from './sharedos-file-session-contracts.js';

type HeartbeatEvent = FileWorkflowHeartbeatPayloadV1['event'];
type FileRead = FileWorkflowHeartbeatPayloadV1['fileReads'][number];
type MemoryTransition = FileWorkflowHeartbeatPayloadV1['memoryTransitions'][number];
type SharedOsAuthority = FileWorkflowHeartbeatPayloadV1['sharedOsAuthority'];
type Provider = FileWorkflowHeartbeatPayloadV1['provider'];
type Usage = FileWorkflowHeartbeatPayloadV1['usage'];
type ExecutionStatus = SharedOsFileTurnResultV1['executionStatus'];
type NativeSourceEvidence = FileWorkflowSharedOsRetainedEvidenceV1['sourceEvidence'];
type NativeFileOperation = NativeSourceEvidence['requesterFileOperations'][number];
type NativeAuditEvent = NativeSourceEvidence['auditEvents'][number];
type NativeMessageEnvelope = NativeSourceEvidence['acceptedMessages'][number];
type NativeAddress = NativeAuditEvent['actor'];
type ResolvedAuthorityPhase = Readonly<{ index: number; authorityHash: string }>;
type AuthorityPhase = ResolvedAuthorityPhase & Readonly<{
  outcome: 'allowed' | 'denied';
}>;
type AdmittedToolCatalog = Readonly<{ visibleTools: ReadonlySet<string> }>;

type NativeContactEvidence = Readonly<{
  taskId: string;
  requestMessageId: string;
  replyMessageId?: string;
  responderExecutionId?: string;
  status: FileWorkflowContactAuthorityV1['status'];
  errorCode?: FileWorkflowContactAuthorityV1['errorCode'];
  /** Present only for the live adapter; null means the live turn claimed no response. */
  responseClaim?: string | null;
  /** Present only for the live adapter and exact-compared with source receipts. */
  responderReads?: readonly FileRead[];
}>;

type NativeTurnEvidence = Readonly<{
  executionId: string;
  traceId: string;
  executionStatus: ExecutionStatus;
  decision: FileWorkflowSharedOsRetainedEvidenceV1['tickDecisions'][number] | null;
  sourceEvidence: NativeSourceEvidence;
  audit: SharedOsAuthority['audit'];
  providerTelemetry: Readonly<{
    requester: FileProviderTelemetryV1;
    responder?: FileProviderTelemetryV1;
  }>;
  /** Present only for the live adapter and exact-compared with source receipts. */
  requesterReads?: readonly FileRead[];
  contact?: NativeContactEvidence;
  actionSnapshot?: Readonly<{ before: PairDataStore; after: PairDataStore }>;
}>;

type ProjectorCoreInput = Readonly<{
  binding: FileWorkflowRunBindingV1;
  event: HeartbeatEvent;
  native: NativeTurnEvidence;
  claims?: Readonly<{
    retainedEvidence: FileWorkflowSharedOsRetainedEvidenceV1;
    sharedOsAuthority: SharedOsAuthority;
    contactAuthority?: FileWorkflowContactAuthorityV1;
  }>;
}>;

export type ProjectFileWorkflowSharedOsEvidenceV1Input = Readonly<{
  binding: FileWorkflowRunBindingV1;
  event: HeartbeatEvent;
  turn: SharedOsFileTurnResultV1;
  actionSnapshot?: Readonly<{ before: PairDataStore; after: PairDataStore }>;
}>;

export type ProjectFileWorkflowRetainedSharedOsEvidenceV1Input = Readonly<{
  binding: FileWorkflowRunBindingV1;
  event: HeartbeatEvent;
  retainedEvidence: FileWorkflowSharedOsRetainedEvidenceV1;
  sharedOsAuthority: SharedOsAuthority;
  contactAuthority?: FileWorkflowContactAuthorityV1;
}>;

export type FileWorkflowSharedOsProjectionV1 = Readonly<{
  currentContact?: Readonly<{
    authority: FileWorkflowContactAuthorityV1;
    /** Needed by evaluation in the same process, but never retained as evidence. */
    response?: string;
  }>;
  fileReads: readonly FileRead[];
  memoryTransitions: readonly MemoryTransition[];
  memoryAuthorities: FileWorkflowHeartbeatPayloadV1['memoryAuthorities'];
  sharedOsAuthority: SharedOsAuthority;
  provider: Provider;
  usage: Usage;
  retainedEvidence: FileWorkflowSharedOsRetainedEvidenceV1;
}>;

/**
 * Project the evidence emitted by one SharedOS turn. This boundary is pure:
 * it has no clock, storage, evaluator, scheduler, or workspace dependency.
 */
export function projectFileWorkflowSharedOsEvidenceV1(
  input: ProjectFileWorkflowSharedOsEvidenceV1Input,
): FileWorkflowSharedOsProjectionV1 {
  const binding = fileWorkflowRunBindingV1Schema.parse(input.binding);
  const { turn } = input;
  if (!turn.provenance || !turn.sourceEvidence) {
    throw new Error('Projection requires production SharedOS provenance and source evidence');
  }
  if (!isDeepStrictEqual(turn.provenance, binding.sharedOs)) {
    throw new Error('SharedOS provenance conflicts with the immutable run binding');
  }
  if (
    !Array.isArray(turn.requesterReads)
    || (turn.contact !== undefined && !Array.isArray(turn.contact.responderReads))
  ) {
    throw new Error('Live SharedOS turn requires requester and contact responder read claims');
  }
  const sourceEvidence = fileWorkflowSharedOsRetainedEvidenceV1Schema.shape.sourceEvidence.parse(
    turn.sourceEvidence,
  );
  const responderExecutionId = turn.contact?.responderExecutionId;
  if (
    turn.contact
    && !responderExecutionId
    && !isNotInvokedTelemetry(turn.contact.providerUsage)
  ) {
    throw new Error('Responder telemetry without responder execution authority is invalid');
  }
  return projectFileWorkflowSharedOsEvidenceCore({
    binding,
    event: input.event,
    native: {
      executionId: turn.executionId,
      traceId: turn.traceId,
      executionStatus: turn.executionStatus,
      decision: turn.decision,
      sourceEvidence,
      audit: turn.audit,
      providerTelemetry: {
        requester: turn.providerUsage,
        ...(responderExecutionId ? { responder: turn.contact!.providerUsage } : {}),
      },
      requesterReads: turn.requesterReads,
      ...(turn.contact ? {
        contact: {
          taskId: turn.contact.taskId,
          requestMessageId: turn.contact.requestMessageId,
          ...(turn.contact.replyMessageId
            ? { replyMessageId: turn.contact.replyMessageId }
            : {}),
          ...(responderExecutionId ? { responderExecutionId } : {}),
          status: turn.contact.status,
          ...(turn.contact.errorCode ? { errorCode: turn.contact.errorCode } : {}),
          responseClaim: turn.contact.response ?? null,
          responderReads: turn.contact.responderReads,
        },
      } : {}),
      ...(input.actionSnapshot ? { actionSnapshot: input.actionSnapshot } : {}),
    },
  });
}

/** Reproject one durable retained-evidence record through the same canonical core. */
export function projectFileWorkflowRetainedSharedOsEvidenceV1(
  input: ProjectFileWorkflowRetainedSharedOsEvidenceV1Input,
): FileWorkflowSharedOsProjectionV1 {
  const binding = fileWorkflowRunBindingV1Schema.parse(input.binding);
  const retainedEvidence = fileWorkflowSharedOsRetainedEvidenceV1Schema.parse(
    input.retainedEvidence,
  );
  const contactAuthority = input.contactAuthority
    ? fileWorkflowContactAuthorityV1Schema.parse(input.contactAuthority)
    : undefined;
  const snapshot = retainedEvidence.actionSnapshots[0];
  return projectFileWorkflowSharedOsEvidenceCore({
    binding,
    event: input.event,
    native: {
      executionId: input.sharedOsAuthority.requesterExecutionId,
      traceId: input.event.traceId,
      executionStatus: retainedEvidence.requesterExecutionStatus,
      decision: retainedEvidence.tickDecisions[0] ?? null,
      sourceEvidence: retainedEvidence.sourceEvidence,
      audit: input.sharedOsAuthority.audit,
      providerTelemetry: retainedEvidence.providerTelemetry,
      ...(contactAuthority ? {
        contact: {
          taskId: contactAuthority.taskId,
          requestMessageId: contactAuthority.contactId,
          ...(contactAuthority.replyMessageId
            ? { replyMessageId: contactAuthority.replyMessageId }
            : {}),
          ...(contactAuthority.responderExecutionId
            ? { responderExecutionId: contactAuthority.responderExecutionId }
            : {}),
          status: contactAuthority.status,
          ...(contactAuthority.errorCode ? { errorCode: contactAuthority.errorCode } : {}),
        },
      } : {}),
      ...(snapshot ? {
        actionSnapshot: {
          before: snapshot.before,
          after: snapshot.after,
        },
      } : {}),
    },
    claims: {
      retainedEvidence,
      sharedOsAuthority: input.sharedOsAuthority,
      ...(contactAuthority ? { contactAuthority } : {}),
    },
  });
}

function projectFileWorkflowSharedOsEvidenceCore(
  input: ProjectorCoreInput,
): FileWorkflowSharedOsProjectionV1 {
  const { binding } = input;
  assertTurnIdentity(input, binding);
  const source = input.native.sourceEvidence;
  assertAuditWindow(input, binding, source.auditEvents);
  const admissions = assertExecutionAdmissions(input, binding, source.auditEvents);
  if (input.native.executionStatus === 'denied') {
    assertOrdinaryDeniedTurn(input, source.auditEvents);
  }
  const catalogs = assertAdmittedToolCatalogs(input, binding, source.auditEvents, admissions);

  const operations = validateFileOperations(input, binding, source.auditEvents, admissions);
  const memory = deriveMemoryEvidence(operations, binding);
  assertReadVersionCausality(operations, memory.transitions, binding, source.auditEvents);
  const contact = deriveContactEvidence(input, binding, source.auditEvents, admissions);
  assertAuthorizationPhaseHashes(
    source.auditEvents,
    binding,
    admissions,
    contact?.replyAuthorization,
  );
  assertPactPairAuditTopology(input, binding, source.auditEvents, admissions, catalogs, contact);
  if (contact) {
    assertCompleteContactReadCoverage(
      operations,
      binding.actors.requester.actorId,
      'requester',
    );
    if (contact.authority.status === 'completed' || contact.authority.status === 'denied') {
      assertCompleteContactReadCoverage(
        operations,
        binding.actors.responder.actorId,
        'responder',
      );
    }
  }
  const requesterTelemetry = input.native.executionStatus === 'denied'
    ? validateZeroBoundTelemetry(
      input.native.providerTelemetry.requester,
      binding.actors.requester.model,
      'requester',
    )
    : validateTelemetry(
      input.native.providerTelemetry.requester,
      binding.actors.requester.model,
      'requester',
    );
  const responderTelemetry = resolveResponderTelemetry(input.native, binding);
  const usage = deriveUsage(
    input.native.decision,
    source.auditEvents,
    binding.actors.requester.actorId,
    requesterTelemetry,
    responderTelemetry,
  );

  const retainedEvidence = fileWorkflowSharedOsRetainedEvidenceV1Schema.parse({
    requesterExecutionStatus: input.native.executionStatus,
    sourceEvidence: structuredClone(source),
    providerTelemetry: {
      requester: structuredClone(input.native.providerTelemetry.requester),
      ...(responderTelemetry
        ? { responder: structuredClone(input.native.providerTelemetry.responder) }
        : {}),
    },
    actionSnapshots: contact?.snapshot ? [contact.snapshot] : [],
    tickDecisions: input.native.decision ? [structuredClone(input.native.decision)] : [],
  });
  const candidate: FileWorkflowSharedOsProjectionV1 = {
    ...(contact ? {
      currentContact: {
        authority: contact.authority,
        ...(contact.response === undefined ? {} : { response: contact.response }),
      },
    } : {}),
    fileReads: operations.flatMap(operation => operation.action === 'read'
      ? [projectRead(operation)]
      : []),
    memoryTransitions: memory.transitions,
    memoryAuthorities: memory.authorities,
    sharedOsAuthority: {
      ...structuredClone(binding.sharedOs),
      requesterExecutionId: input.native.executionId,
      requesterExecutionStatus: input.native.executionStatus,
      ...(input.native.contact?.responderExecutionId
        ? { responderExecutionId: input.native.contact.responderExecutionId }
        : {}),
      audit: structuredClone(input.native.audit),
    },
    provider: {
      requester: structuredClone(binding.actors.requester.model),
      ...(responderTelemetry
        ? { responder: structuredClone(binding.actors.responder.model) }
        : {}),
    },
    usage,
    retainedEvidence,
  };
  if (input.claims) {
    if (!isDeepStrictEqual(candidate.retainedEvidence, input.claims.retainedEvidence)) {
      throw new Error('Retained SharedOS evidence conflicts with its canonical projection');
    }
    if (!isDeepStrictEqual(candidate.sharedOsAuthority, input.claims.sharedOsAuthority)) {
      throw new Error(
        'Retained SharedOS authority or requester execution status conflicts with its canonical projection',
      );
    }
    if (!isDeepStrictEqual(
      candidate.currentContact?.authority,
      input.claims.contactAuthority,
    )) {
      throw new Error('Retained contact authority conflicts with its canonical projection');
    }
  }
  return deepFreeze(structuredClone(candidate));
}

function assertTurnIdentity(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
): void {
  const { event, native } = input;
  if (
    event.runId !== binding.runId
    || event.actorId !== binding.actors.requester.actorId
    || event.traceId !== native.traceId
    || !Number.isSafeInteger(event.tick)
    || event.tick < 1
    || event.eventId.length === 0
    || event.sessionId.length === 0
  ) {
    throw new Error('SharedOS turn identity conflicts with its heartbeat event');
  }
  const executionId = stableIdV1('execution', [
    'requester-execution',
    event.eventId,
    binding.actors.requester.actorId,
  ]);
  if (native.executionId !== executionId) {
    throw new Error('SharedOS requester execution identity is not bound to this heartbeat');
  }
  if (![
    'succeeded',
    'denied',
    'failed',
    'cancelled',
    'escalated',
  ].includes(native.executionStatus)) {
    throw new Error('SharedOS requester execution status is invalid');
  }
  if ((native.executionStatus === 'succeeded') !== (native.decision !== null)) {
    throw new Error('Requester decision presence conflicts with SharedOS execution status');
  }
}

function assertAuditWindow(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
): void {
  if (
    events.length === 0
    || !Number.isSafeInteger(input.native.audit.firstSequence)
    || input.native.audit.firstSequence < 0
    || !Number.isSafeInteger(input.native.audit.lastSequence)
    || input.native.audit.lastSequence < 0
    || input.native.audit.lastSequence
      !== input.native.audit.firstSequence + events.length - 1
    || input.native.audit.sha256 !== digestCanonical(events)
  ) {
    throw new Error(
      'SharedOS audit sequence must be non-negative safe and its range/digest must match source evidence',
    );
  }
  const allowedActors = new Set([
    binding.actors.requester.actorId,
    binding.actors.responder.actorId,
  ]);
  for (const event of events) {
    if (
      event.traceId !== input.event.traceId
      || event.namespaceId !== binding.sharedOs.namespaceId
      || event.purpose !== SHAREDEVAL_PACT_PAIR_PURPOSE_V1
      || event.actor.kind !== 'agent'
      || !allowedActors.has(event.actor.agentId)
      || !isService(event.authority)
      || !isService(event.owner)
      || (event.resource?.owner !== undefined && !isService(event.resource.owner))
    ) {
      throw new Error('SharedOS audit event carries foreign actor, authority, owner, or context');
    }
  }
}

function assertExecutionAdmissions(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
): ReadonlyMap<string, AuthorityPhase> {
  const admissions = new Map<string, AuthorityPhase>();
  admissions.set(
    binding.actors.requester.actorId,
    requireExecutionAdmission(
      events,
      binding.actors.requester.actorId,
      input.native.executionStatus === 'denied' ? 'denied' : 'allowed',
    ),
  );
  const responderExecutionId = input.native.contact?.responderExecutionId;
  if (responderExecutionId) {
    admissions.set(
      binding.actors.responder.actorId,
      requireExecutionAdmission(events, binding.actors.responder.actorId, 'allowed'),
    );
  } else if (executionAdmissions(events, binding.actors.responder.actorId).some(
    row => row.event.outcome === 'allowed',
  )) {
    throw new Error('Responder execution admission lacks responder execution authority');
  }
  return admissions;
}

function requireExecutionAdmission(
  events: readonly NativeAuditEvent[],
  actorId: string,
  outcome: 'allowed' | 'denied',
): AuthorityPhase {
  const matches = executionAdmissions(events, actorId).filter(row => (
    row.event.outcome === outcome
    && row.event.operationId === undefined
    && row.event.metadata?.['consumed'] === true
    && (outcome === 'allowed'
      ? typeof row.event.grantId === 'string' && row.event.grantId.length > 0
      : row.event.grantId === undefined && typeof row.event.reason === 'string')
  ));
  if (matches.length !== 1) {
    throw new Error(
      `SharedOS ${actorId} execution lacks one exact ${outcome} audit admission`,
    );
  }
  const admission = matches[0]!;
  const phase = requireImmediateAuthorityResolution(
    events,
    admission.index,
    actorId,
    'execution admission',
  );
  if (admission.event.authorityHash !== phase.authorityHash) {
    throw new Error('SharedOS execution authority hash conflicts with its resolved phase');
  }
  return { index: admission.index, authorityHash: phase.authorityHash, outcome };
}

function assertOrdinaryDeniedTurn(
  input: ProjectorCoreInput,
  events: readonly NativeAuditEvent[],
): void {
  const source = input.native.sourceEvidence;
  if (
    events.length !== 2
    || input.native.contact !== undefined
    || input.native.actionSnapshot !== undefined
    || (input.native.requesterReads?.length ?? 0) !== 0
    || source.requesterFileOperations.length !== 0
    || source.responderFileOperations.length !== 0
    || source.acceptedMessages.length !== 0
  ) {
    throw new Error('Exact ordinary denied admission cannot carry catalog, driver, file, or contact evidence');
  }
}

function executionAdmissions(events: readonly NativeAuditEvent[], actorId: string) {
  return indexed(events).filter(row => (
    row.event.type === 'authorization.checked'
    && isAgent(row.event.actor, actorId)
    && row.event.action === 'invoke'
    && exactResource(row.event, 'sharedos.execution', ['agent', actorId])
  ));
}

function assertAdmittedToolCatalogs(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
  admissions: ReadonlyMap<string, AuthorityPhase>,
): ReadonlyMap<string, AdmittedToolCatalog> {
  const catalogs = new Map<string, AdmittedToolCatalog>();
  for (const [actorId, phase] of admissions) {
    if (phase.outcome === 'denied') continue;
    const matches = indexed(events).filter(row => (
      row.event.type === 'tool.catalog.listed'
      && row.event.outcome === 'succeeded'
      && isAgent(row.event.actor, actorId)
      && row.event.authorityHash === phase.authorityHash
    ));
    if (matches.length !== 1 || matches[0]!.index <= phase.index) {
      throw new Error('Each allowed SharedOS execution admission requires one phase-bound tool catalog');
    }
    const catalog = matches[0]!;
    const firstPhaseAuthorization = indexed(events).find(row => (
      row.index > phase.index
      && row.event.type === 'authorization.checked'
      && isAgent(row.event.actor, actorId)
      && row.event.authorityHash === phase.authorityHash
    ));
    if (firstPhaseAuthorization && catalog.index >= firstPhaseAuthorization.index) {
      throw new Error('SharedOS tool catalog must precede admitted phase tool work');
    }
    const visibleTools = parseVisibleTools(catalog.event);
    if (actorId === binding.actors.requester.actorId) {
      if (!sameStringSet(visibleTools, ['files.read', 'files.replace', 'messages.request'])) {
        throw new Error('Requester SharedOS tool catalog has a non-canonical visible tool set');
      }
    } else {
      if (
        !visibleTools.has('files.read')
        || !visibleTools.has('files.replace')
        || visibleTools.has('messages.request')
      ) {
        throw new Error('Responder SharedOS tool catalog lacks its canonical file boundary');
      }
      const taskKind = input.native.contact
        ? binding.selectedTasks.find(task => task.taskId === input.native.contact!.taskId)?.kind
        : undefined;
      for (const tool of visibleTools) {
        if (tool === 'files.read' || tool === 'files.replace') continue;
        const pactBinding = resolvePactPairSharedOsToolBindingV1(tool);
        if (!pactBinding || (taskKind === 'qa' && pactBinding.action !== 'read')) {
          throw new Error('Responder SharedOS tool catalog exposes a non-canonical PACT tool');
        }
      }
    }
    catalogs.set(actorId, { visibleTools });
  }
  const admittedActors = new Set(catalogs.keys());
  if (events.some(event => (
    event.type === 'tool.catalog.listed'
    && (!isAgentIn(event.actor, admittedActors) || event.outcome !== 'succeeded')
  ))) {
    throw new Error('SharedOS audit contains a tool catalog outside an admitted phase');
  }
  return catalogs;
}

function parseVisibleTools(event: NativeAuditEvent): ReadonlySet<string> {
  const visible = event.metadata?.['visibleTools'];
  if (
    !Array.isArray(visible)
    || visible.some(tool => typeof tool !== 'string' || tool.length === 0)
    || new Set(visible).size !== visible.length
  ) {
    throw new Error('SharedOS tool catalog visibleTools metadata is invalid');
  }
  return new Set(visible as string[]);
}

function validateFileOperations(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
  admissions: ReadonlyMap<string, AuthorityPhase>,
): NativeFileOperation[] {
  const source = input.native.sourceEvidence;
  const buckets = [
    [binding.actors.requester.actorId, source.requesterFileOperations],
    [binding.actors.responder.actorId, source.responderFileOperations],
  ] as const;
  const ids = new Set<string>();
  const operations: NativeFileOperation[] = [];
  for (const [actorId, receipts] of buckets) {
    const admission = admissions.get(actorId);
    let previousToolIndex = -1;
    for (const receipt of receipts) {
      if (
        receipt.runId !== binding.runId
        || receipt.actorId !== actorId
        || receipt.traceId !== input.event.traceId
        || ids.has(receipt.operationId)
      ) {
        throw new Error('SharedOS file receipt has foreign or duplicate authority');
      }
      if (receipt.action === 'read' && receipt.path !== 'MEMORY.md') {
        const actor = actorId === binding.actors.requester.actorId
          ? binding.actors.requester
          : binding.actors.responder;
        const expected = actor.initial[receipt.path];
        if (
          receipt.sha256 !== expected.sha256
          || receipt.byteLength !== expected.byteLength
        ) {
          throw new Error('SharedOS immutable file receipt conflicts with its run binding');
        }
      }
      ids.add(receipt.operationId);
      if (admission === undefined) {
        throw new Error('SharedOS file operation lacks actor execution admission');
      }
      const toolIndex = assertFileAuditCausality(events, receipt, admission);
      if (toolIndex <= previousToolIndex) {
        throw new Error('SharedOS file receipt order conflicts with native audit order');
      }
      previousToolIndex = toolIndex;
      operations.push(structuredClone(receipt));
    }
  }
  const requesterReads = source.requesterFileOperations
    .filter((row): row is Extract<typeof row, { action: 'read' }> => row.action === 'read')
    .map(projectRead);
  const responderReads = source.responderFileOperations
    .filter((row): row is Extract<typeof row, { action: 'read' }> => row.action === 'read')
    .map(projectRead);
  if (
    input.native.requesterReads !== undefined
    && !isDeepStrictEqual(input.native.requesterReads, requesterReads)
  ) {
    throw new Error('Requester read projection conflicts with native SharedOS receipts');
  }
  if (
    input.native.contact?.responderReads !== undefined
    && !isDeepStrictEqual(input.native.contact.responderReads, responderReads)
  ) {
    throw new Error('Responder read projection conflicts with native SharedOS receipts');
  }
  if (source.responderFileOperations.length > 0 && !input.native.contact?.responderExecutionId) {
    throw new Error('Responder file receipts require responder execution authority');
  }
  const retainedIds = new Set(operations.map(row => row.operationId));
  if (events.some(event => (
    event.type === 'resource.invoked'
    && event.resource?.namespace === 'files'
  ))) {
    throw new Error('Native file tools must not invent resource.invoked audit evidence');
  }
  if (events.some(event => (
    event.type === 'tool.invoked'
    && event.outcome === 'succeeded'
    && (event.tool === 'files.read' || event.tool === 'files.replace')
    && (!event.operationId || !retainedIds.has(event.operationId))
  ))) {
    throw new Error('SharedOS audit contains an unretained successful file operation');
  }
  return operations;
}

function assertFileAuditCausality(
  events: readonly NativeAuditEvent[],
  operation: NativeFileOperation,
  admission: AuthorityPhase,
): number {
  const path = [operation.path];
  const authorizations = indexed(events).filter(row => (
    row.event.type === 'authorization.checked'
    && row.event.outcome === 'allowed'
    && isAgent(row.event.actor, operation.actorId)
    && row.event.operationId === operation.operationId
    && row.event.action === operation.action
    && exactResource(row.event, 'files', path)
    && typeof row.event.grantId === 'string'
    && row.event.metadata?.['consumed'] === true
  ));
  const tools = indexed(events).filter(row => (
    row.event.type === 'tool.invoked'
    && row.event.outcome === 'succeeded'
    && isAgent(row.event.actor, operation.actorId)
    && row.event.operationId === operation.operationId
    && row.event.action === operation.action
    && exactResource(row.event, 'files', path)
    && row.event.tool === (operation.action === 'read' ? 'files.read' : 'files.replace')
  ));
  if (
    authorizations.length === 1
    && authorizations[0]!.event.authorityHash !== admission.authorityHash
  ) {
    throw new Error('SharedOS file authorization authority hash conflicts with its phase');
  }
  if (authorizations.length === 1 && admission.index >= authorizations[0]!.index) {
    throw new Error('SharedOS file operation must follow its actor execution admission');
  }
  if (
    authorizations.length !== 1
    || tools.length !== 1
    || !authorizations[0]!.event.grantId
    || tools[0]!.event.grantId !== authorizations[0]!.event.grantId
    || authorizations[0]!.index >= tools[0]!.index
  ) {
    throw new Error('SharedOS file receipt lacks exact authorization-to-tool causality');
  }
  return tools[0]!.index;
}

function assertCompleteContactReadCoverage(
  operations: readonly NativeFileOperation[],
  actorId: string,
  label: 'requester' | 'responder',
): void {
  const reads = operations.filter(operation => (
    operation.actorId === actorId && operation.action === 'read'
  ));
  const logicalPaths = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const;
  const observedPaths = new Set(reads.map(read => read.path));
  if (!logicalPaths.every(path => observedPaths.has(path))) {
    throw new Error(
      `Authoritative contact requires complete ${label} four-file read coverage`,
    );
  }
  const byVersionPath = new Map<string, { sha256: string; byteLength: number }>();
  for (const read of reads) {
    const key = `${read.version}:${read.path}`;
    const existing = byVersionPath.get(key);
    if (
      existing
      && (existing.sha256 !== read.sha256 || existing.byteLength !== read.byteLength)
    ) {
      throw new Error(`${label} contact reads conflict at one workspace version cursor`);
    }
    byVersionPath.set(key, { sha256: read.sha256, byteLength: read.byteLength });
  }
}

function deriveMemoryEvidence(
  operations: readonly NativeFileOperation[],
  binding: FileWorkflowRunBindingV1,
): Readonly<{
  transitions: MemoryTransition[];
  authorities: FileWorkflowHeartbeatPayloadV1['memoryAuthorities'];
}> {
  const transitions: MemoryTransition[] = [];
  const authorities: FileWorkflowHeartbeatPayloadV1['memoryAuthorities'] = [];
  for (const actorId of [
    binding.actors.requester.actorId,
    binding.actors.responder.actorId,
  ]) {
    const actorOperations = operations.filter(row => row.actorId === actorId);
    const committed = actorOperations.filter(row => (
      row.action === 'replace' && row.outcome === 'committed'
    ));
    if (committed.length > 1) {
      throw new Error('Each actor may commit MEMORY at most once per heartbeat');
    }
    const operation = committed[0];
    if (!operation || operation.action !== 'replace' || operation.outcome !== 'committed') continue;
    const replaceIndex = actorOperations.indexOf(operation);
    const priorRead = actorOperations.findIndex((receipt, index) => (
      index < replaceIndex
      && receipt.action === 'read'
      && receipt.path === 'MEMORY.md'
      && receipt.version === operation.previousVersion
      && receipt.sha256 === operation.previousSha256
      && receipt.byteLength === operation.previousByteLength
    ));
    if (priorRead < 0) {
      throw new Error('Committed MEMORY requires its exact preceding same-turn read receipt');
    }
    const previous = decodeMemory(operation.previousBytesBase64, 'previous MEMORY');
    const next = decodeMemory(operation.newBytesBase64, 'new MEMORY');
    const previousRows = parseFileMemoryV1({
      content: previous,
      selectedTaskIds: binding.selectedTaskIds,
    });
    const newRows = parseFileMemoryV1({
      content: next,
      selectedTaskIds: binding.selectedTaskIds,
    });
    assertMonotonicFileMemoryRowsV1(previousRows, newRows);
    transitions.push({
      actorId,
      previousVersion: operation.previousVersion,
      newVersion: operation.version,
      previousSha256: operation.previousSha256,
      newSha256: operation.sha256,
      byteLength: operation.byteLength,
    });
    authorities.push(fileWorkflowMemoryAuthorityV1Schema.parse({
      actorId,
      previousVersion: operation.previousVersion,
      newVersion: operation.version,
      previousSha256: operation.previousSha256,
      newSha256: operation.sha256,
      previousRows: previousRows.map(({ taskId, status }) => ({ taskId, status })),
      newRows: newRows.map(({ taskId, status }) => ({ taskId, status })),
    }));
  }
  return { transitions, authorities };
}

function assertReadVersionCausality(
  operations: readonly NativeFileOperation[],
  transitions: readonly MemoryTransition[],
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
): void {
  for (const actorId of [
    binding.actors.requester.actorId,
    binding.actors.responder.actorId,
  ]) {
    const versions = operations.flatMap(operation => (
      operation.actorId === actorId && operation.action === 'read'
        ? [operation.version]
        : []
    ));
    const transition = transitions.find(row => row.actorId === actorId);
    if (!transition) {
      if (new Set(versions).size > 1) {
        throw new Error('SharedOS actor has multiple read versions without a same-turn MEMORY CAS');
      }
      continue;
    }
    const replacement = operations.find(operation => (
      operation.actorId === actorId
      && operation.action === 'replace'
      && operation.outcome === 'committed'
      && operation.previousVersion === transition.previousVersion
      && operation.version === transition.newVersion
    ));
    const replacementAuthorization = replacement
      ? indexed(events).find(row => (
        row.event.type === 'authorization.checked'
        && row.event.operationId === replacement.operationId
      ))
      : undefined;
    const replacementTool = replacement
      ? indexed(events).find(row => (
        row.event.type === 'tool.invoked'
        && row.event.operationId === replacement.operationId
      ))
      : undefined;
    if (!replacementAuthorization || !replacementTool) {
      throw new Error('SharedOS MEMORY CAS lacks its audited replace boundary');
    }
    if (versions.some(version => (
      version !== transition.previousVersion && version !== transition.newVersion
    ))) {
      throw new Error('SharedOS read version falls outside its actor same-turn MEMORY CAS');
    }
    for (const operation of operations) {
      if (operation.actorId !== actorId || operation.action !== 'read') continue;
      const readAuthorization = indexed(events).find(row => (
        row.event.type === 'authorization.checked'
        && row.event.operationId === operation.operationId
      ));
      const readTool = indexed(events).find(row => (
        row.event.type === 'tool.invoked'
        && row.event.operationId === operation.operationId
      ));
      if (
        !readAuthorization
        || !readTool
        || (operation.version === transition.previousVersion
          ? readTool.index >= replacementAuthorization.index
          : readAuthorization.index <= replacementTool.index)
      ) {
        throw new Error(
          'SharedOS read timing requires previous version before and new version after its MEMORY CAS',
        );
      }
    }
  }
}

function deriveContactEvidence(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
  admissions: ReadonlyMap<string, AuthorityPhase>,
): Readonly<{
  authority: FileWorkflowContactAuthorityV1;
  response?: string;
  snapshot?: FileWorkflowSharedOsRetainedEvidenceV1['actionSnapshots'][number];
  replyAuthorization?: ResolvedAuthorityPhase;
}> | undefined {
  const contact = input.native.contact;
  const messages = input.native.sourceEvidence.acceptedMessages;
  if (!contact) {
    if (messages.length !== 0 || input.native.actionSnapshot) {
      throw new Error('Message or action evidence requires one SharedOS contact');
    }
    assertNoUnretainedSuccessfulMessages(events, new Set());
    return undefined;
  }
  const request = messages[0];
  if (
    !request
    || request.id !== contact.requestMessageId
    || request.replyTo !== undefined
  ) {
    throw new Error('SharedOS contact request envelope is missing or reordered');
  }
  assertEnvelope(request, binding.actors.requester.actorId, binding.actors.responder.actorId,
    input.event.traceId);
  const requestPayload = plainObject(request.payload, 'contact request payload');
  if (
    !exactKeys(requestPayload, ['message', 'taskId'])
    || requestPayload['taskId'] !== contact.taskId
    || typeof requestPayload['message'] !== 'string'
    || requestPayload['message'].length < 1
    || requestPayload['message'].length > 1_048_576
  ) {
    throw new Error('SharedOS contact request payload conflicts with its disposition');
  }
  const selected = binding.selectedTasks.find(row => row.taskId === contact.taskId);
  if (!selected) throw new Error('SharedOS contact task is outside the run binding');

  const requesterAdmission = admissions.get(binding.actors.requester.actorId);
  if (requesterAdmission === undefined) {
    throw new Error('SharedOS request lacks requester execution admission');
  }
  const requestAudit = assertRequestAuditCausality(
    events,
    request,
    contact,
    binding,
    requesterAdmission,
    input.native.executionStatus,
  );
  assertRequesterReadsPrecedeContact(
    events,
    input.native.sourceEvidence.requesterFileOperations,
    requestAudit.authorizationIndex,
  );
  const expectedRequestId = stableIdV1('message', [
    'message-request',
    binding.sharedOs.namespaceId,
    input.event.traceId,
    requestAudit.operationId,
    request.receiver,
  ]);
  if (request.id !== expectedRequestId) {
    throw new Error('SharedOS request message identity is not bound to its tool call');
  }

  assertContactDisposition(contact);
  const hasReply = contact.status === 'completed' || contact.status === 'denied';
  const reply = messages[1];
  if (
    messages.length !== (hasReply ? 2 : 1)
    || hasReply !== Boolean(reply)
    || hasReply !== Boolean(contact.replyMessageId)
    || (hasReply && !contact.responderExecutionId)
  ) {
    throw new Error('SharedOS contact reply and execution cardinality is inconsistent');
  }
  let responderAdmission: AuthorityPhase | undefined;
  if (contact.responderExecutionId) {
    const expectedExecutionId = stableIdV1('execution', [
      'responder-execution',
      request.id,
      binding.actors.responder.actorId,
    ]);
    if (contact.responderExecutionId !== expectedExecutionId) {
      throw new Error('SharedOS responder execution identity is not bound to its request');
    }
    responderAdmission = admissions.get(binding.actors.responder.actorId);
    if (
      responderAdmission === undefined
      || requestAudit.messageIndex >= responderAdmission.index
      || responderAdmission.index >= requestAudit.finalToolIndex
    ) {
      throw new Error('Accepted request must precede responder admission and nested execution');
    }
  }
  const acceptedMessageIndexes = new Set([requestAudit.messageIndex]);
  let nestedEndIndex = requestAudit.finalToolIndex;
  let replyAuthorization: ResolvedAuthorityPhase | undefined;
  let response: string | undefined;
  if (reply) {
    response = assertReply(reply, request, contact, binding, input.event.traceId);
    const replyAudit = assertReplyAuditCausality(
      events,
      reply,
      requestAudit.finalToolIndex,
      binding,
    );
    acceptedMessageIndexes.add(replyAudit.messageIndex);
    nestedEndIndex = replyAudit.authorityResolutionIndex;
    replyAuthorization = {
      index: replyAudit.authorizationIndex,
      authorityHash: replyAudit.authorityHash,
    };
  }
  if (responderAdmission !== undefined) {
    assertResponderWorkInsideNestedRequest(
      events,
      input.native.sourceEvidence.responderFileOperations,
      responderAdmission.index,
      nestedEndIndex,
    );
  }
  if (new Set(messages.map(row => row.id)).size !== messages.length) {
    throw new Error('Accepted message IDs must be unique');
  }
  assertNoUnretainedSuccessfulMessages(events, acceptedMessageIndexes);

  let snapshot: FileWorkflowSharedOsRetainedEvidenceV1['actionSnapshots'][number] | undefined;
  if (selected.kind === 'action') {
    if (!input.native.actionSnapshot) {
      throw new Error('Action contact requires before and after snapshots');
    }
    snapshot = {
      taskId: contact.taskId,
      contactId: request.id,
      actorId: binding.actors.responder.actorId,
      eventId: input.event.eventId,
      before: structuredClone(input.native.actionSnapshot.before),
      after: structuredClone(input.native.actionSnapshot.after),
    };
  } else if (input.native.actionSnapshot) {
    throw new Error('QA contact cannot carry action snapshots');
  }
  const authority = fileWorkflowContactAuthorityV1Schema.parse({
    taskId: contact.taskId,
    contactId: request.id,
    ...(reply ? { replyMessageId: reply.id } : {}),
    ...(contact.responderExecutionId
      ? { responderExecutionId: contact.responderExecutionId }
      : {}),
    kind: selected.kind,
    status: contact.status,
    ...(contact.errorCode ? { errorCode: contact.errorCode } : {}),
    senderId: binding.actors.requester.actorId,
    recipientId: binding.actors.responder.actorId,
    eventId: input.event.eventId,
    ...(snapshot ? {
      actionSnapshotDigest: digestCanonical(snapshot),
      stateChanged: !isDeepStrictEqual(snapshot.before, snapshot.after),
    } : {}),
  });
  return {
    authority,
    ...(response === undefined ? {} : { response }),
    ...(snapshot ? { snapshot } : {}),
    ...(replyAuthorization ? { replyAuthorization } : {}),
  };
}

function assertContactDisposition(
  contact: NativeContactEvidence,
): void {
  const responseClaimValid = contact.responseClaim === undefined
    || (contact.status === 'completed'
      ? typeof contact.responseClaim === 'string'
        && contact.responseClaim.length >= 1
        && contact.responseClaim.length <= 1_048_576
      : contact.responseClaim === null);
  const valid = responseClaimValid && (contact.status === 'completed'
    ? contact.errorCode === undefined
    : (contact.status === 'denied' && contact.errorCode === 'CONTACT_RESPONDER_DENIED')
      || (contact.status === 'cancelled' && contact.errorCode === 'CONTACT_CANCELLED')
      || (
        contact.status === 'failed'
        && contact.errorCode !== undefined
        && contact.errorCode !== 'CONTACT_RESPONDER_DENIED'
        && contact.errorCode !== 'CONTACT_CANCELLED'
      ));
  if (!valid) throw new Error('SharedOS contact status has an invalid response or error mapping');
}

function assertPactPairAuditTopology(
  input: ProjectorCoreInput,
  binding: FileWorkflowRunBindingV1,
  events: readonly NativeAuditEvent[],
  admissions: ReadonlyMap<string, AuthorityPhase>,
  catalogs: ReadonlyMap<string, AdmittedToolCatalog>,
  contact: Readonly<{
    authority: FileWorkflowContactAuthorityV1;
    snapshot?: FileWorkflowSharedOsRetainedEvidenceV1['actionSnapshots'][number];
  }> | undefined,
): void {
  const pactRows = indexed(events).filter(row => (
    row.event.resource?.namespace === 'pact-pair'
    && (row.event.type === 'authorization.checked' || row.event.type === 'tool.invoked')
  ));
  const responderId = binding.actors.responder.actorId;
  const phase = admissions.get(responderId);
  const catalog = catalogs.get(responderId);
  if (pactRows.length > 0 && (!contact || !phase || !catalog)) {
    throw new Error('PACT tool evidence requires one admitted responder contact');
  }

  const request = input.native.sourceEvidence.acceptedMessages.find(message => !message.replyTo);
  const requestMessage = request
    ? indexed(events).find(row => row.event.type === 'message.sent' && row.event.messageId === request.id)
    : undefined;
  const requestTerminal = requestMessage?.event.operationId
    ? indexed(events).find(row => (
      row.event.type === 'tool.invoked'
      && row.event.tool === 'messages.request'
      && row.event.operationId === requestMessage.event.operationId
    ))
    : undefined;
  const replyMessage = contact?.authority.replyMessageId
    ? indexed(events).find(row => (
      row.event.type === 'message.sent'
      && row.event.messageId === contact.authority.replyMessageId
    ))
    : undefined;
  const nestedEnd = replyMessage?.index ?? requestTerminal?.index ?? events.length;
  const successfulMutations: Array<Readonly<{ surface: string; action: string }>> = [];

  const authorizations = pactRows.filter(row => row.event.type === 'authorization.checked');
  const tools = pactRows.filter(row => row.event.type === 'tool.invoked');
  for (const authorization of authorizations) {
    const operationId = authorization.event.operationId;
    const matches = tools.filter(row => row.event.operationId === operationId);
    if (!operationId || matches.length !== 1) {
      throw new Error('PACT authorization lacks one exact terminal tool pair');
    }
    const tool = matches[0]!;
    const toolBinding = typeof tool.event.tool === 'string'
      ? resolvePactPairSharedOsToolBindingV1(tool.event.tool)
      : null;
    if (!toolBinding) throw new Error('PACT audit references an unknown tool binding');
    const expectedPath = ['task', contact!.authority.taskId, toolBinding.surface];
    const allowed = authorization.event.outcome === 'allowed';
    const denied = authorization.event.outcome === 'denied';
    if (
      (!allowed && !denied)
      || !isAgent(authorization.event.actor, responderId)
      || !isAgent(tool.event.actor, responderId)
      || authorization.event.authorityHash !== phase!.authorityHash
      || authorization.event.action !== toolBinding.action
      || tool.event.action !== toolBinding.action
      || !exactResource(authorization.event, 'pact-pair', expectedPath)
      || !exactResource(tool.event, 'pact-pair', expectedPath)
      || authorization.event.metadata?.['consumed'] !== true
      || (allowed && (
        typeof authorization.event.grantId !== 'string'
        || tool.event.grantId !== authorization.event.grantId
      ))
      || (denied && (
        authorization.event.grantId !== undefined
        || tool.event.grantId !== undefined
        || tool.event.outcome !== 'denied'
      ))
      || authorization.index <= phase!.index
      || authorization.index >= tool.index
      || tool.index >= nestedEnd
      || !catalog!.visibleTools.has(tool.event.tool!)
      || (contact!.authority.kind === 'qa' && toolBinding.action !== 'read')
    ) {
      throw new Error('PACT tool pair conflicts with responder admission or nested request topology');
    }
    if (
      tool.event.outcome === 'succeeded'
      && (toolBinding.action === 'create' || toolBinding.action === 'update')
    ) {
      successfulMutations.push(toolBinding);
    }
  }
  if (tools.some(tool => !authorizations.some(
    authorization => authorization.event.operationId === tool.event.operationId,
  ))) {
    throw new Error('PACT tool invocation lacks one exact authorization pair');
  }

  if (contact?.snapshot && contact.authority.stateChanged) {
    const changedSurfaces = changedActionSurfaces(
      contact.snapshot.before,
      contact.snapshot.after,
    );
    if (
      changedSurfaces.size === 0
      || !successfulMutations.some(mutation => changedSurfaces.has(mutation.surface))
    ) {
      throw new Error('Changed action state requires same-task PACT mutation evidence');
    }
  }
}

function changedActionSurfaces(before: PairDataStore, after: PairDataStore): ReadonlySet<string> {
  const surfaces = new Set<string>();
  if (
    !isDeepStrictEqual(before.note_folders, after.note_folders)
    || !isDeepStrictEqual(before.notes, after.notes)
  ) surfaces.add('notes');
  if (
    !isDeepStrictEqual(before.todo_folders, after.todo_folders)
    || !isDeepStrictEqual(before.todos, after.todos)
  ) surfaces.add('todos');
  return surfaces;
}

function assertRequestAuditCausality(
  events: readonly NativeAuditEvent[],
  request: NativeMessageEnvelope,
  contact: NativeContactEvidence,
  binding: FileWorkflowRunBindingV1,
  requesterAdmission: AuthorityPhase,
  requesterExecutionStatus: ExecutionStatus,
): Readonly<{
  operationId: string;
  authorizationIndex: number;
  messageIndex: number;
  finalToolIndex: number;
}> {
  const sent = indexed(events).filter(row => (
    row.event.type === 'message.sent'
    && row.event.outcome === 'succeeded'
    && row.event.messageId === request.id
    && row.event.operationId !== undefined
    && row.event.grantId === undefined
    && isAgent(row.event.actor, binding.actors.requester.actorId)
    && isAgent(row.event.receiver, binding.actors.responder.actorId)
  ));
  if (sent.length !== 1 || !sent[0]!.event.operationId) {
    throw new Error('Accepted SharedOS request lacks one operation-bound message audit');
  }
  const operationId = sent[0]!.event.operationId;
  const path = ['agent', binding.actors.responder.actorId];
  const authorizations = indexed(events).filter(row => (
    row.event.type === 'authorization.checked'
    && row.event.outcome === 'allowed'
    && row.event.operationId === operationId
    && row.event.action === 'send'
    && isAgent(row.event.actor, binding.actors.requester.actorId)
    && exactResource(row.event, 'sharedos.messaging', path)
    && typeof row.event.grantId === 'string'
    && row.event.metadata?.['consumed'] === true
  ));
  if (
    authorizations.length === 1
    && authorizations[0]!.event.authorityHash !== requesterAdmission.authorityHash
  ) {
    throw new Error('SharedOS request authorization authority hash conflicts with its phase');
  }
  // SharedOS proves only the transport partition. CONTACT_* is trusted output
  // from the run-scoped router and is intentionally not inferred from this generic reason.
  const outerCancelled = contact.status === 'cancelled'
    && requesterExecutionStatus === 'cancelled';
  const expectedToolOutcome = contact.status === 'completed' || contact.status === 'denied'
    ? 'succeeded'
    : 'failed';
  const expectedToolReason = expectedToolOutcome === 'failed'
    ? 'message_reply_resolution_failed'
    : undefined;
  const tools = indexed(events).filter(row => (
    row.event.type === 'tool.invoked'
    && row.event.tool === 'messages.request'
    && row.event.outcome === expectedToolOutcome
    && row.event.operationId === operationId
    && row.event.action === 'send'
    && isAgent(row.event.actor, binding.actors.requester.actorId)
    && exactResource(row.event, 'sharedos.messaging', path)
    && row.event.reason === expectedToolReason
  ));
  if (
    authorizations.length !== 1
    || requesterAdmission.index >= authorizations[0]!.index
    || authorizations[0]!.index >= sent[0]!.index
    || (outerCancelled
      ? tools.length !== 0 || events.some(event => (
        event.type === 'tool.invoked'
        && event.tool === 'messages.request'
        && event.operationId === operationId
      ))
      : tools.length !== 1
        || tools[0]!.event.grantId !== authorizations[0]!.event.grantId
        || sent[0]!.index >= tools[0]!.index)
  ) {
    throw new Error(
      'Accepted SharedOS request lacks exact authorization, message, and request tool reason causality',
    );
  }
  return {
    operationId,
    authorizationIndex: authorizations[0]!.index,
    messageIndex: sent[0]!.index,
    finalToolIndex: tools[0]?.index ?? events.length,
  };
}

function assertRequesterReadsPrecedeContact(
  events: readonly NativeAuditEvent[],
  operations: readonly NativeFileOperation[],
  requestAuthorizationIndex: number,
): void {
  const preContactPaths = new Set<string>();
  for (const operation of operations) {
    if (operation.action !== 'read') continue;
    const toolIndex = events.findIndex(event => (
      event.type === 'tool.invoked'
      && event.outcome === 'succeeded'
      && event.operationId === operation.operationId
      && event.tool === 'files.read'
    ));
    if (toolIndex >= 0 && toolIndex < requestAuthorizationIndex) preContactPaths.add(operation.path);
  }
  if (!['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'].every(
    path => preContactPaths.has(path),
  )) {
    throw new Error('Authoritative contact requires one complete requester file read set before contact authorization');
  }
}

function assertReply(
  reply: NativeMessageEnvelope,
  request: NativeMessageEnvelope,
  contact: NativeContactEvidence,
  binding: FileWorkflowRunBindingV1,
  traceId: string,
): string | undefined {
  if (
    reply.id !== contact.replyMessageId
    || reply.id !== stableIdV1('message', ['message-reply', request.id])
    || reply.replyTo !== request.id
  ) {
    throw new Error('SharedOS reply identity does not bind the accepted request');
  }
  assertEnvelope(reply, binding.actors.responder.actorId, binding.actors.requester.actorId, traceId);
  const payload = plainObject(reply.payload, 'contact reply payload');
  const response = payload['response'];
  const valid = contact.status === 'completed'
    ? exactKeys(payload, ['response', 'status', 'taskId'])
      && payload['taskId'] === contact.taskId
      && payload['status'] === 'completed'
      && typeof response === 'string'
      && response.length >= 1
      && response.length <= 1_048_576
      && (contact.responseClaim === undefined || response === contact.responseClaim)
    : exactKeys(payload, ['errorCode', 'status', 'taskId'])
      && payload['taskId'] === contact.taskId
      && payload['status'] === 'denied'
      && payload['errorCode'] === 'CONTACT_RESPONDER_DENIED';
  if (!valid) throw new Error('SharedOS reply payload conflicts with its contact disposition');
  return typeof response === 'string' ? response : undefined;
}

function assertReplyAuditCausality(
  events: readonly NativeAuditEvent[],
  reply: NativeMessageEnvelope,
  requestFinalToolIndex: number,
  binding: FileWorkflowRunBindingV1,
): Readonly<{
  authorityResolutionIndex: number;
  authorizationIndex: number;
  authorityHash: string;
  messageIndex: number;
}> {
  const path = ['agent', binding.actors.requester.actorId];
  const sent = indexed(events).filter(row => (
    row.event.type === 'message.sent'
    && row.event.outcome === 'succeeded'
    && row.event.messageId === reply.id
    && row.event.operationId === undefined
    && typeof row.event.grantId === 'string'
    && isAgent(row.event.actor, binding.actors.responder.actorId)
    && isAgent(row.event.receiver, binding.actors.requester.actorId)
  ));
  const authorizations = indexed(events).filter(row => (
    row.event.type === 'authorization.checked'
    && row.event.outcome === 'allowed'
    && row.event.operationId === undefined
    && row.event.action === 'send'
    && isAgent(row.event.actor, binding.actors.responder.actorId)
    && exactResource(row.event, 'sharedos.messaging', path)
    && typeof row.event.grantId === 'string'
    && row.event.metadata?.['consumed'] === true
  ));
  if (
    sent.length !== 1
    || authorizations.length !== 1
    || sent[0]!.event.grantId !== authorizations[0]!.event.grantId
    || authorizations[0]!.index >= sent[0]!.index
    || sent[0]!.index >= requestFinalToolIndex
  ) {
    throw new Error('SharedOS reply lacks exact direct-send authorization causality');
  }
  const phase = requireImmediateAuthorityResolution(
    events,
    authorizations[0]!.index,
    binding.actors.responder.actorId,
    'reply',
  );
  if (authorizations[0]!.event.authorityHash !== phase.authorityHash) {
    throw new Error('SharedOS reply authority hash conflicts with its resolved phase');
  }
  return {
    authorityResolutionIndex: phase.index,
    authorizationIndex: authorizations[0]!.index,
    authorityHash: phase.authorityHash,
    messageIndex: sent[0]!.index,
  };
}

function assertResponderWorkInsideNestedRequest(
  events: readonly NativeAuditEvent[],
  operations: readonly NativeFileOperation[],
  admissionIndex: number,
  endIndex: number,
): void {
  for (const operation of operations) {
    const operationEvents = indexed(events).filter(row => (
      row.event.operationId === operation.operationId
    ));
    if (operationEvents.some(row => row.index <= admissionIndex || row.index >= endIndex)) {
      throw new Error('SharedOS responder file work must stay inside the nested request');
    }
  }
}

function assertNoUnretainedSuccessfulMessages(
  events: readonly NativeAuditEvent[],
  acceptedMessageIndexes: ReadonlySet<number>,
): void {
  if (events.some((event, index) => (
    event.type === 'message.sent'
    && event.outcome === 'succeeded'
    && !acceptedMessageIndexes.has(index)
  ))) {
    throw new Error('SharedOS audit contains an extra successful message row');
  }
  const acceptedRequestOperationIds = new Set([...acceptedMessageIndexes].flatMap(index => {
    const operationId = events[index]?.operationId;
    return operationId ? [operationId] : [];
  }));
  if (events.some(event => (
    event.type === 'tool.invoked'
    && event.tool === 'messages.request'
    && event.outcome === 'succeeded'
    && (!event.operationId || !acceptedRequestOperationIds.has(event.operationId))
  ))) {
    throw new Error('Successful messages.request audit lacks its accepted durable request');
  }
}

function requireImmediateAuthorityResolution(
  events: readonly NativeAuditEvent[],
  authorizationIndex: number,
  actorId: string,
  label: 'execution admission' | 'reply',
): ResolvedAuthorityPhase {
  const index = authorizationIndex - 1;
  const event = events[index];
  if (
    !event
    || event.type !== 'authority.resolved'
    || event.outcome !== 'succeeded'
    || !isAgent(event.actor, actorId)
    || typeof event.authorityHash !== 'string'
    || event.authorityHash.length === 0
  ) {
    throw new Error(`SharedOS ${label} lacks its immediately preceding authority resolution`);
  }
  return { index, authorityHash: event.authorityHash };
}

function assertAuthorizationPhaseHashes(
  events: readonly NativeAuditEvent[],
  binding: FileWorkflowRunBindingV1,
  admissions: ReadonlyMap<string, AuthorityPhase>,
  replyAuthorization: ResolvedAuthorityPhase | undefined,
): void {
  const requesterId = binding.actors.requester.actorId;
  const responderId = binding.actors.responder.actorId;
  const requesterPhase = admissions.get(requesterId);
  const responderPhase = admissions.get(responderId);
  for (const { event, index } of indexed(events)) {
    if (event.type !== 'authorization.checked') continue;
    const expected = isAgent(event.actor, requesterId)
      ? requesterPhase
      : isAgent(event.actor, responderId)
        ? index === replyAuthorization?.index
          ? replyAuthorization
          : responderPhase
        : undefined;
    if (!expected || event.authorityHash !== expected.authorityHash) {
      throw new Error('SharedOS authorization authority hash conflicts with its resolved phase');
    }
  }
}

function resolveResponderTelemetry(
  native: NativeTurnEvidence,
  binding: FileWorkflowRunBindingV1,
) {
  if (!native.contact?.responderExecutionId) {
    if (native.providerTelemetry.responder !== undefined) {
      throw new Error('Responder telemetry without responder execution authority is invalid');
    }
    return undefined;
  }
  if (!native.providerTelemetry.responder) {
    throw new Error('Responder execution authority requires its provider telemetry');
  }
  return validateTelemetry(
    native.providerTelemetry.responder,
    binding.actors.responder.model,
    'responder',
  );
}

function validateTelemetry(
  telemetry: FileProviderTelemetryV1,
  model: FileWorkflowRunBindingV1['actors']['requester']['model'],
  label: 'requester' | 'responder',
) {
  if (
    telemetry.requestedModel !== model.requestedModel
    || telemetry.resolvedModel !== model.resolvedModel
    || telemetry.requests.some(request => (
      request.requestedModel !== model.requestedModel
      || request.resolvedModel !== model.resolvedModel
    ))
  ) {
    throw new Error(`${label} provider telemetry conflicts with model provenance`);
  }
  const totals: Record<string, number> = { requests: telemetry.requests.length };
  for (const key of [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'reasoningTokens',
    'cachedTokens',
    'costUsd',
  ] as const) {
    const values = telemetry.requests.flatMap(request => (
      request.usage?.[key] === undefined ? [] : [request.usage[key]]
    ));
    if (values.length > 0) totals[key] = values.reduce((sum, value) => sum + value, 0);
  }
  if (!isDeepStrictEqual(telemetry.totals, totals)) {
    throw new Error(`${label} provider telemetry totals do not derive from request rows`);
  }
  return {
    requests: totals['requests']!,
    promptTokens: totals['promptTokens'] ?? 0,
    completionTokens: totals['completionTokens'] ?? 0,
    totalTokens: totals['totalTokens'] ?? 0,
    costUsd: totals['costUsd'] ?? 0,
  };
}

function validateZeroBoundTelemetry(
  telemetry: FileProviderTelemetryV1,
  model: FileWorkflowRunBindingV1['actors']['requester']['model'],
  label: 'requester' | 'responder',
) {
  if (
    telemetry.requestedModel !== model.requestedModel
    || telemetry.resolvedModel !== model.resolvedModel
    || telemetry.requests.length !== 0
    || !isDeepStrictEqual(telemetry.totals, { requests: 0 })
  ) {
    throw new Error(`${label} denied admission must retain exact bound zero telemetry`);
  }
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function deriveUsage(
  decision: NativeTurnEvidence['decision'],
  events: readonly NativeAuditEvent[],
  requesterActorId: string,
  requester: ReturnType<typeof validateTelemetry>,
  responder: ReturnType<typeof validateTelemetry> | undefined,
): Usage {
  const toolSteps = events.filter(event => event.type === 'tool.invoked').length;
  const requesterTools = events.filter(event => (
    event.type === 'tool.invoked' && isAgent(event.actor, requesterActorId)
  ));
  const contactCalls = requesterTools.filter(event => event.tool === 'messages.request').length;
  if (decision && (
    decision.toolSteps !== requesterTools.length
    || decision.contactCalls !== contactCalls
  )) {
    throw new Error('Requester decision counters conflict with SharedOS audit evidence');
  }
  return {
    modelCalls: requester.requests + (responder?.requests ?? 0),
    toolSteps,
    contactCalls,
    promptTokens: requester.promptTokens + (responder?.promptTokens ?? 0),
    completionTokens: requester.completionTokens + (responder?.completionTokens ?? 0),
    totalTokens: requester.totalTokens + (responder?.totalTokens ?? 0),
    costUsd: requester.costUsd + (responder?.costUsd ?? 0),
  };
}

function projectRead(
  operation: Extract<NativeFileOperation, { action: 'read' }>,
): FileRead {
  return {
    actorId: operation.actorId,
    path: operation.path,
    action: 'read',
    version: operation.version,
    sha256: operation.sha256,
    byteLength: operation.byteLength,
  };
}

function assertEnvelope(
  envelope: NativeMessageEnvelope,
  senderId: string,
  receiverId: string,
  traceId: string,
): void {
  if (
    envelope.version !== '1'
    || !isAgent(envelope.sender, senderId)
    || !isAgent(envelope.receiver, receiverId)
    || envelope.purpose !== SHAREDEVAL_PACT_PAIR_PURPOSE_V1
    || envelope.traceId !== traceId
  ) {
    throw new Error(
      'SharedOS contact message envelope carries foreign sender, recipient, trace, or context',
    );
  }
}

function exactResource(
  event: NativeAuditEvent,
  namespace: string,
  path: readonly string[],
): boolean {
  return event.resource?.namespace === namespace
    && isDeepStrictEqual(event.resource.path, path)
    && isService(event.resource.owner);
}

function isService(address: NativeAddress | undefined): boolean {
  return isDeepStrictEqual(address, SHAREDEVAL_SERVICE_ADDRESS_V1);
}

function isAgent(address: NativeAddress | undefined, actorId: string): boolean {
  return address?.kind === 'agent' && address.agentId === actorId;
}

function isAgentIn(address: NativeAddress | undefined, actorIds: ReadonlySet<string>): boolean {
  return address?.kind === 'agent' && actorIds.has(address.agentId);
}

function sameStringSet(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
  return actual.size === expected.length && expected.every(value => actual.has(value));
}

function indexed(events: readonly NativeAuditEvent[]) {
  return events.map((event, index) => ({ event, index }));
}

function isNotInvokedTelemetry(telemetry: FileProviderTelemetryV1): boolean {
  return telemetry.requestedModel === 'not-invoked'
    && telemetry.resolvedModel === 'not-invoked'
    && telemetry.requests.length === 0
    && isDeepStrictEqual(telemetry.totals, { requests: 0 });
}

function decodeMemory(value: string, label: string): string {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8`);
  return text;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function digestCanonical(value: unknown): string {
  if (!isJsonValue(value)) throw new Error('Canonical digest input must be JSON-safe');
  return sha256JsonV1(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
