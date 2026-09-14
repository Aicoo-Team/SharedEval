import type { PactTaskIntroV1 } from '../../contracts/benchmark.js';
import {
  stableIdV1,
  type JsonValue,
} from '../../contracts/json.js';
import type {
  SoCapabilityGrant,
} from '../../execution/sharedos/v1/contracts.js';
import {
  SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
  SHAREDEVAL_SERVICE_ADDRESS_V1,
} from '../../runner/v1/sharedos-file-session-contracts.js';
const WORKSPACE_FILES = Object.freeze([
  'AGENT.md',
  'HEARTBEAT.md',
  'MEMORY.md',
  'POLICY.md',
] as const);
const NAMESPACE_ID_PATTERN = /^namespace-[a-f0-9]{40}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QA_TASK_ID_PATTERN = /^PAIR-Q[1-9][0-9]*$/;
const ACTION_TASK_ID_PATTERN = /^PAIR-A[1-9][0-9]*$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_TICKS = 10_000;
const MIN_TOOL_CALLS = 6;
const MAX_TOOL_CALLS = 128;

export type PactPairSharedOsGrantTaskV1 = Readonly<{
  taskId: string;
  kind: 'qa' | 'action';
  publicTask: PactTaskIntroV1;
}>;

export type BuildPactPairSharedOsGrantManifestV1Options = Readonly<{
  namespaceId: string;
  runStartedAt: string;
  requesterId: string;
  responderId: string;
  maxTicks: number;
  // Multi-turn probe gate: when present, contact-shaped use counts scale from
  // one-contact-per-task to one-contact-per-tick so the requester may re-ask a
  // still-pending task. Grant IDs exclude maxUses, so identities are unchanged;
  // only the constraints (and thus the manifest digest) differ, and only when
  // the gate is on.
  multiTurn?: Readonly<{ phase2StartTick: number; finalizeTick: number }>;
  maxToolCalls: number;
  tasks: readonly PactPairSharedOsGrantTaskV1[];
}>;

export type PactPairSharedOsResponderGrantSetV1 = Readonly<{
  taskId: string;
  grantIds: readonly string[];
}>;

export type PactPairSharedOsGrantManifestV1 = Readonly<{
  grants: readonly SoCapabilityGrant[];
  responderGrantSets: readonly PactPairSharedOsResponderGrantSetV1[];
}>;

type GrantDescriptor = Readonly<{
  subjectId: string;
  resourceNamespace: string;
  resourcePath: readonly string[];
  actions: readonly string[];
  maxUses: number;
  responderTaskId?: string;
}>;

/**
 * Builds the complete immutable authority for one PACT-Pair SharedOS session.
 * Task prompts, private benchmark rows, and future message payloads are not
 * inputs to any capability decision.
 */
export function buildPactPairSharedOsGrantManifestV1(
  input: BuildPactPairSharedOsGrantManifestV1Options,
): PactPairSharedOsGrantManifestV1 {
  validateOptions(input);
  const tasks = [...input.tasks].sort((left, right) => (
    compareCodeUnits(left.taskId, right.taskId)
  ));
  const grants: SoCapabilityGrant[] = [];

  grants.push(createGrant(input, {
    subjectId: input.requesterId,
    resourceNamespace: 'sharedos.execution',
    resourcePath: ['agent', input.requesterId],
    actions: ['invoke'],
    maxUses: input.maxTicks,
  }));
  for (const filename of WORKSPACE_FILES) {
    grants.push(createGrant(input, {
      subjectId: input.requesterId,
      resourceNamespace: 'files',
      resourcePath: [filename],
      actions: ['read'],
      maxUses: input.maxTicks * input.maxToolCalls,
    }));
  }
  grants.push(createGrant(input, {
    subjectId: input.requesterId,
    resourceNamespace: 'files',
    resourcePath: ['MEMORY.md'],
    actions: ['replace'],
    maxUses: input.maxTicks,
  }));
  grants.push(createGrant(input, {
    subjectId: input.requesterId,
    resourceNamespace: 'sharedos.messaging',
    resourcePath: ['agent', input.responderId],
    actions: ['send'],
    maxUses: input.multiTurn ? input.maxTicks : tasks.length,
  }));

  // One task no longer means one contact under the multi-turn gate: any tick
  // may re-contact a still-pending task, so every per-task responder budget
  // scales by the tick count instead of assuming a single attempt.
  const perContact = (maxUses: number): number => (
    input.multiTurn ? maxUses * input.maxTicks : maxUses
  );
  const responderGrantSets = tasks.map(task => {
    const descriptors: GrantDescriptor[] = [
      {
        subjectId: input.responderId,
        resourceNamespace: 'sharedos.execution',
        resourcePath: ['agent', input.responderId],
        actions: ['invoke'],
        maxUses: perContact(1),
        responderTaskId: task.taskId,
      },
      ...WORKSPACE_FILES.map(filename => ({
        subjectId: input.responderId,
        resourceNamespace: 'files',
        resourcePath: [filename],
        actions: ['read'],
        maxUses: perContact(input.maxToolCalls),
        responderTaskId: task.taskId,
      })),
      {
        subjectId: input.responderId,
        resourceNamespace: 'files',
        resourcePath: ['MEMORY.md'],
        actions: ['replace'],
        maxUses: perContact(1),
        responderTaskId: task.taskId,
      },
      {
        subjectId: input.responderId,
        resourceNamespace: 'sharedos.messaging',
        resourcePath: ['agent', input.requesterId],
        actions: ['send'],
        maxUses: perContact(1),
        responderTaskId: task.taskId,
      },
      ...taskCapabilityDescriptors(input, task),
    ];
    const taskGrants = descriptors.map(descriptor => createGrant(input, descriptor));
    grants.push(...taskGrants);
    return Object.freeze({
      taskId: task.taskId,
      grantIds: Object.freeze(taskGrants.map(grant => grant.id).sort(compareCodeUnits)),
    });
  });

  grants.sort((left, right) => compareCodeUnits(left.id, right.id));
  if (new Set(grants.map(grant => grant.id)).size !== grants.length) {
    throw new Error('SharedOS grant ID collision');
  }
  return Object.freeze({
    grants: Object.freeze(grants),
    responderGrantSets: Object.freeze(responderGrantSets),
  });
}

function taskCapabilityDescriptors(
  input: BuildPactPairSharedOsGrantManifestV1Options,
  task: PactPairSharedOsGrantTaskV1,
): GrantDescriptor[] {
  const surfaces = task.kind === 'qa' && task.publicTask.surface === 'unknown'
    ? ['notes', 'todos'] as const
    : [task.publicTask.surface] as const;
  const actions = task.kind === 'qa'
    ? ['read'] as const
    : ['create', 'read', 'update'] as const;
  return surfaces.map(surface => ({
    subjectId: input.responderId,
    resourceNamespace: 'pact-pair',
    resourcePath: ['task', task.taskId, surface],
    actions,
    maxUses: input.multiTurn ? input.maxToolCalls * input.maxTicks : input.maxToolCalls,
    responderTaskId: task.taskId,
  }));
}

function createGrant(
  input: BuildPactPairSharedOsGrantManifestV1Options,
  descriptor: GrantDescriptor,
): SoCapabilityGrant {
  const subject = {
    kind: 'agent',
    agentId: descriptor.subjectId,
  } as const;
  const actions = [...descriptor.actions].sort(compareCodeUnits);
  const resourcePath = [...descriptor.resourcePath];
  const idTuple: JsonValue[] = [
    'grant',
    input.namespaceId,
    subject,
    descriptor.resourceNamespace,
    resourcePath,
    actions,
    ...(descriptor.responderTaskId === undefined
      ? []
      : [['responder-task', descriptor.responderTaskId]]),
  ];
  const grant: SoCapabilityGrant = {
    id: stableIdV1('grant', idTuple),
    namespaceId: input.namespaceId,
    subject,
    issuer: { ...SHAREDEVAL_SERVICE_ADDRESS_V1 },
    capabilities: [{
      resource: {
        namespace: descriptor.resourceNamespace,
        path: resourcePath,
        owner: { ...SHAREDEVAL_SERVICE_ADDRESS_V1 },
      },
      actions,
      scope: 'exact',
    }],
    constraints: {
      purposes: [SHAREDEVAL_PACT_PAIR_PURPOSE_V1],
      notBefore: input.runStartedAt,
      maxUses: descriptor.maxUses,
    },
    issuedAt: input.runStartedAt,
  };
  return freezeGrant(grant);
}

function freezeGrant(grant: SoCapabilityGrant): SoCapabilityGrant {
  for (const capability of grant.capabilities) {
    Object.freeze(capability.resource.path);
    if (capability.resource.owner) Object.freeze(capability.resource.owner);
    Object.freeze(capability.resource);
    Object.freeze(capability.actions);
    Object.freeze(capability);
  }
  Object.freeze(grant.subject);
  Object.freeze(grant.issuer);
  Object.freeze(grant.capabilities);
  if (grant.constraints.purposes) Object.freeze(grant.constraints.purposes);
  Object.freeze(grant.constraints);
  return Object.freeze(grant);
}

function validateOptions(input: BuildPactPairSharedOsGrantManifestV1Options): void {
  if (!NAMESPACE_ID_PATTERN.test(input.namespaceId)) {
    throw new Error('SharedOS namespace must be one canonical logical-run namespace ID');
  }
  if (!isCanonicalTimestamp(input.runStartedAt)) {
    throw new Error('SharedOS run timestamp must be a canonical UTC timestamp');
  }
  validateActorId(input.requesterId, 'requester actor');
  validateActorId(input.responderId, 'responder actor');
  if (input.requesterId === input.responderId) {
    throw new Error('SharedOS requester and responder must be distinct actors');
  }
  if (!boundedSafeInteger(input.maxTicks, 1, MAX_TICKS)) {
    throw new Error(`SharedOS tick count must be a positive safe integer up to ${MAX_TICKS}`);
  }
  if (!boundedSafeInteger(input.maxToolCalls, MIN_TOOL_CALLS, MAX_TOOL_CALLS)) {
    throw new Error(
      `SharedOS tool count must be a safe integer from ${MIN_TOOL_CALLS} to ${MAX_TOOL_CALLS}`,
    );
  }
  if (input.multiTurn && (
    !boundedSafeInteger(input.multiTurn.phase2StartTick, 2, input.maxTicks)
    || !boundedSafeInteger(input.multiTurn.finalizeTick, 2, input.maxTicks)
    || input.multiTurn.phase2StartTick > input.multiTurn.finalizeTick
  )) {
    throw new Error('SharedOS multi-turn phase boundaries must satisfy 2 <= phase2StartTick <= finalizeTick <= maxTicks');
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('SharedOS grant manifest requires at least one PACT-Pair task');
  }
  if (!Number.isSafeInteger(input.tasks.length) || input.tasks.length > MAX_TICKS) {
    throw new Error(`SharedOS task count must not exceed ${MAX_TICKS}`);
  }
  const taskIds = new Set<string>();
  for (const task of input.tasks) {
    validateTask(task);
    if (taskIds.has(task.taskId)) {
      throw new Error(`Duplicate PACT-Pair task: ${task.taskId}`);
    }
    taskIds.add(task.taskId);
  }
}

function validateActorId(actorId: string, label: string): void {
  if (typeof actorId !== 'string' || !ACTOR_ID_PATTERN.test(actorId)) {
    throw new Error(`SharedOS ${label} ID is unsafe`);
  }
}

function validateTask(task: PactPairSharedOsGrantTaskV1): void {
  if (
    typeof task !== 'object'
    || task === null
    || typeof task.publicTask !== 'object'
    || task.publicTask === null
    || task.taskId !== task.publicTask.taskId
    || task.kind !== task.publicTask.kind
  ) {
    throw new Error('PACT-Pair task authority must be self-consistent');
  }
  if (task.kind === 'qa') {
    if (!QA_TASK_ID_PATTERN.test(task.taskId)) {
      throw new Error('Foreign or mismatched PACT-Pair QA task');
    }
    if (!['notes', 'todos', 'unknown'].includes(task.publicTask.surface)) {
      throw new Error('Foreign PACT-Pair QA task surface');
    }
    return;
  }
  if (task.kind === 'action') {
    if (!ACTION_TASK_ID_PATTERN.test(task.taskId)) {
      throw new Error('Foreign or mismatched PACT-Pair action task');
    }
    if (!['notes', 'todos'].includes(task.publicTask.surface)) {
      throw new Error('Foreign PACT-Pair action task surface');
    }
    return;
  }
  throw new Error('Foreign PACT-Pair task kind');
}

function isCanonicalTimestamp(value: string): boolean {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function boundedSafeInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
