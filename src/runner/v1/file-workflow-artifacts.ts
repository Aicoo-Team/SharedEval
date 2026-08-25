import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PACT_PAIR_METRIC_NAMES_V1 } from '../../suites/pact-pair/evaluation.js';
import { dataStoreSchema } from '../../suites/pact-pair/schemas.js';
import { MAX_AGENT_WORKSPACE_FILE_BYTES_V1 } from './agent-workspace.js';
import {
  pactPairFullEvaluationV1Schema,
  pactPairPublicEvaluationV1Schema,
} from './artifacts.js';
import { CONTACT_AGENT_ERROR_CODES_V1 } from './contact-agent.js';
import { fileTurnDecisionV1Schema } from './file-harness.js';
import { agentWorkspaceRegistryReferencesV1Schema } from './workspace-registry.js';

export const MAX_FILE_WORKFLOW_SELECTED_TASKS_V1 = 600;
const MAX_PRIVATE_RESPONSE_BYTES_V1 = 1_048_576;
const MAX_PRIVATE_MEMORY_BASE64_LENGTH_V1 =
  Math.ceil(MAX_AGENT_WORKSPACE_FILE_BYTES_V1 / 3) * 4;
const opaqueIdSchema = z.string().min(1).max(128).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'must be a safe opaque identifier',
);
const registryIdSchema = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  'must be a registry identifier',
);
const semverSchema = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const nonNegativeFiniteSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fileWorkflowIdSchema = z.enum(['files-multi', 'files-single']);
const taskKindSchema = z.enum(['qa', 'action']);
const terminalStatusSchema = z.enum([
  'answered',
  'refused',
  'error',
  'no_response',
  'side_effect_before_failure',
]);
const contactStatusSchema = z.enum(['completed', 'denied', 'failed', 'cancelled']);
const fileMemoryStatusSchema = z.enum(['pending', 'answered', 'refused', 'error']);
const pactPairMetricNameSchema = z.enum(PACT_PAIR_METRIC_NAMES_V1);
const task5ContactErrorCodeSchema = z.enum(
  Object.values(CONTACT_AGENT_ERROR_CODES_V1) as [string, ...string[]],
);
const TASK6_CONTACT_ERROR_CODES_V1 = Object.freeze([
  'CONTACT_REQUESTER_FILE_READ_REQUIRED',
  'CONTACT_DUPLICATE_TASK',
  'CONTACT_RESPONDER_FILE_READ_REQUIRED',
] as const);
const contactErrorCodeSchema = z.union([
  task5ContactErrorCodeSchema,
  z.enum(TASK6_CONTACT_ERROR_CODES_V1),
]);

export const FILE_WORKFLOW_PUBLIC_ERROR_CODES_V1 = Object.freeze([
  ...Object.values(CONTACT_AGENT_ERROR_CODES_V1),
  ...TASK6_CONTACT_ERROR_CODES_V1,
  'FILE_TURN_FAILED',
  'FILE_SESSION_FAILED',
  'FILE_SESSION_PREPARATION_FAILED',
] as const);
const publicErrorCodeSchema = z.enum(
  FILE_WORKFLOW_PUBLIC_ERROR_CODES_V1 as unknown as [string, ...string[]],
);

export const fileWorkflowUsageV1Schema = z.object({
  modelCalls: nonNegativeSafeIntegerSchema,
  toolSteps: nonNegativeSafeIntegerSchema,
  contactCalls: nonNegativeSafeIntegerSchema,
  promptTokens: nonNegativeFiniteSchema,
  completionTokens: nonNegativeFiniteSchema,
  totalTokens: nonNegativeFiniteSchema,
  costUsd: nonNegativeFiniteSchema,
}).strict().superRefine((usage, context) => {
  if (usage.totalTokens < usage.promptTokens + usage.completionTokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalTokens'],
      message: 'totalTokens must cover promptTokens plus completionTokens',
    });
  }
});

export const fileWorkflowModelProvenanceV1Schema = z.object({
  provider: opaqueIdSchema,
  requestedModel: z.string().min(1).max(256),
  resolvedModel: z.string().min(1).max(256),
}).strict();

export const fileWorkflowBackendProvenanceV1Schema = z.object({
  adapterId: opaqueIdSchema,
  executor: opaqueIdSchema,
}).strict();

const filePathSchemas = {
  'AGENT.md': z.literal('AGENT.md'),
  'HEARTBEAT.md': z.literal('HEARTBEAT.md'),
  'POLICY.md': z.literal('POLICY.md'),
  'MEMORY.md': z.literal('MEMORY.md'),
} as const;

function fileMetadataSchema<Path extends keyof typeof filePathSchemas>(path: Path) {
  return z.object({
    path: filePathSchemas[path],
    sha256: sha256Schema,
    byteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
  }).strict();
}

export const fileWorkflowFileSetV1Schema = z.object({
  'AGENT.md': fileMetadataSchema('AGENT.md'),
  'HEARTBEAT.md': fileMetadataSchema('HEARTBEAT.md'),
  'POLICY.md': fileMetadataSchema('POLICY.md'),
  'MEMORY.md': fileMetadataSchema('MEMORY.md'),
}).strict();

const assetProvenanceSchema = z.object({
  id: registryIdSchema,
  version: semverSchema,
  sha256: sha256Schema,
}).strict();

const actorBindingSchema = z.object({
  actorId: opaqueIdSchema,
  references: agentWorkspaceRegistryReferencesV1Schema,
  model: fileWorkflowModelProvenanceV1Schema,
  initial: fileWorkflowFileSetV1Schema,
}).strict();

export const fileWorkflowFinalFilesV1Schema = z.object({
  requester: fileWorkflowFileSetV1Schema,
  responder: fileWorkflowFileSetV1Schema,
}).strict();

export type FileWorkflowFinalFilesV1 = z.infer<typeof fileWorkflowFinalFilesV1Schema>;

export const fileWorkflowSelectedTaskV1Schema = z.object({
  taskId: opaqueIdSchema,
  kind: taskKindSchema,
}).strict();

export type FileWorkflowSelectedTaskV1 = z.infer<typeof fileWorkflowSelectedTaskV1Schema>;

const datasetProvenanceSchema = z.object({
  id: z.literal('pact-pair'),
  split: opaqueIdSchema,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/i),
}).strict();

const goldSetProvenanceSchema = z.object({
  id: registryIdSchema,
  sha256: sha256Schema,
}).strict();

const policyProvenancePairSchema = z.object({
  requester: assetProvenanceSchema,
  responder: assetProvenanceSchema,
}).strict();

export const fileWorkflowRunBindingV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-run-binding/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  selectedTaskIds: z.array(opaqueIdSchema).min(1).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  selectedTasks: z.array(fileWorkflowSelectedTaskV1Schema).min(1).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  selectedTaskDigest: sha256Schema,
  dataset: datasetProvenanceSchema,
  goldSet: goldSetProvenanceSchema,
  policies: policyProvenancePairSchema,
  actors: z.object({
    requester: actorBindingSchema,
    responder: actorBindingSchema,
  }).strict(),
  backend: fileWorkflowBackendProvenanceV1Schema,
}).strict().superRefine((binding, context) => {
  if (new Set(binding.selectedTaskIds).size !== binding.selectedTaskIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTaskIds'],
      message: 'selected task IDs must be unique',
    });
  }
  const metadataTaskIds = binding.selectedTasks.map(task => task.taskId);
  if (
    new Set(metadataTaskIds).size !== metadataTaskIds.length
    || metadataTaskIds.length !== binding.selectedTaskIds.length
    || metadataTaskIds.some((taskId, index) => taskId !== binding.selectedTaskIds[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTasks'],
      message: 'selected task metadata must uniquely match the selected task IDs and order',
    });
  }
  if (binding.selectedTaskDigest !== fileWorkflowSelectedTaskDigestV1(binding.selectedTaskIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTaskDigest'],
      message: 'selected task digest does not match the ordered selected task IDs',
    });
  }
  if (binding.actors.requester.actorId === binding.actors.responder.actorId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actors'],
      message: 'requester and responder actor IDs must be distinct',
    });
  }
  for (const role of ['requester', 'responder'] as const) {
    if (
      binding.policies[role].sha256
      !== binding.actors[role].initial['POLICY.md'].sha256
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policies', role, 'sha256'],
        message: `${role} policy provenance must match the initial POLICY.md bytes`,
      });
    }
  }
});

export type FileWorkflowRunBindingV1 = z.infer<typeof fileWorkflowRunBindingV1Schema>;

export const fileWorkflowPublicResultV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-result/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  kind: taskKindSchema,
  status: terminalStatusSchema,
  terminalTick: nonNegativeSafeIntegerSchema,
  contactStatus: contactStatusSchema.optional(),
  errorCode: publicErrorCodeSchema.optional(),
  publicEvaluation: pactPairPublicEvaluationV1Schema.nullable(),
  selectedTaskDigest: sha256Schema,
  backend: fileWorkflowBackendProvenanceV1Schema,
}).strict().superRefine((result, context) => {
  if (result.status === 'answered' && result.contactStatus !== 'completed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactStatus'],
      message: 'answered results require a completed contact',
    });
  }
  if (result.status === 'refused' && result.contactStatus !== 'denied') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactStatus'],
      message: 'refused results require a denied contact',
    });
  }
  if (
    result.status === 'side_effect_before_failure'
    && (result.kind !== 'action' || result.contactStatus === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactStatus'],
      message: 'side-effect results require an action contact',
    });
  }
  if (
    ['answered', 'refused', 'side_effect_before_failure'].includes(result.status)
    && result.publicEvaluation === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicEvaluation'],
      message: `${result.status} results require a public evaluation`,
    });
  }
  if (result.publicEvaluation && (
    result.publicEvaluation.taskId !== result.taskId
    || result.publicEvaluation.kind !== result.kind
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicEvaluation'],
      message: 'public evaluation identity must match its result',
    });
  }
  const requiredDecision = result.status === 'answered'
    ? 'answer'
    : result.status === 'refused'
      ? 'refuse'
      : result.status === 'side_effect_before_failure'
        ? 'none'
        : undefined;
  if (
    requiredDecision !== undefined
    && result.publicEvaluation?.actualDecision !== requiredDecision
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicEvaluation', 'actualDecision'],
      message: `${result.status} results require the ${requiredDecision} terminal decision`,
    });
  }
  if (
    ['error', 'no_response'].includes(result.status)
    && result.publicEvaluation !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicEvaluation'],
      message: 'error and no_response results cannot carry evaluation credit',
    });
  }
  const requiresErrorCode = result.status === 'error'
    || result.status === 'side_effect_before_failure';
  if (requiresErrorCode !== (result.errorCode !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['errorCode'],
      message: 'error and side-effect statuses require one bounded safe error code only',
    });
  }
});

export type FileWorkflowPublicResultV1 = z.infer<typeof fileWorkflowPublicResultV1Schema>;

const metricContributionSchema = z.object({
  metric: pactPairMetricNameSchema,
  numerator: nonNegativeSafeIntegerSchema.max(1),
  denominator: nonNegativeSafeIntegerSchema.max(1),
}).strict().superRefine((metric, context) => {
  if (metric.numerator > metric.denominator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['numerator'],
      message: 'metric numerator cannot exceed denominator',
    });
  }
});

export const fileWorkflowPublicEvaluationRecordV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-evaluation/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  publicEvaluation: pactPairPublicEvaluationV1Schema.nullable(),
  metrics: z.array(metricContributionSchema).max(64),
}).strict().superRefine((evaluation, context) => {
  if (
    evaluation.publicEvaluation
    && evaluation.publicEvaluation.taskId !== evaluation.taskId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicEvaluation'],
      message: 'public evaluation task ID must match its record',
    });
  }
  const names = evaluation.metrics.map(metric => metric.metric);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics'],
      message: 'metric contributions must be unique by name',
    });
  }
  if (evaluation.publicEvaluation === null) {
    if (evaluation.metrics.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics'],
        message: 'an unevaluated task must have an empty metric contribution set',
      });
    }
  } else if (
    evaluation.metrics.length !== PACT_PAIR_METRIC_NAMES_V1.length
    || PACT_PAIR_METRIC_NAMES_V1.some(
      (metric, index) => evaluation.metrics[index]?.metric !== metric,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics'],
      message: 'an evaluated task requires the exact ordered fixed PACT-Pair metric set',
    });
  }
});

export type FileWorkflowPublicEvaluationRecordV1 = z.infer<
  typeof fileWorkflowPublicEvaluationRecordV1Schema
>;

export const fileWorkflowTerminalTransitionV1Schema = z.object({
  taskId: opaqueIdSchema,
  contactId: opaqueIdSchema.optional(),
  result: fileWorkflowPublicResultV1Schema,
  evaluation: fileWorkflowPublicEvaluationRecordV1Schema,
}).strict().superRefine((transition, context) => {
  const identities = [
    transition.taskId,
    transition.result.taskId,
    transition.evaluation.taskId,
  ];
  if (new Set(identities).size !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'transition result and evaluation must share one task identity',
    });
  }
  if (
    transition.result.workflowId !== transition.evaluation.workflowId
    || transition.result.runId !== transition.evaluation.runId
    || transition.result.sessionId !== transition.evaluation.sessionId
    || JSON.stringify(transition.result.publicEvaluation)
      !== JSON.stringify(transition.evaluation.publicEvaluation)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'transition result and evaluation projections must agree',
    });
  }
  if ((transition.contactId !== undefined) !== (transition.result.contactStatus !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactId'],
      message: 'terminal contact identity and status must be declared together',
    });
  }
  if (
    transition.result.status === 'side_effect_before_failure'
    && transition.evaluation.metrics.some(metric => (
      metric.metric !== 'actionSafety' && metric.denominator !== 0
    ))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evaluation', 'metrics'],
      message: 'side-effect-before-failure may contribute only to actionSafety',
    });
  }
});

export type FileWorkflowTerminalTransitionV1 = z.infer<
  typeof fileWorkflowTerminalTransitionV1Schema
>;

const fileReadReceiptSchema = z.object({
  actorId: opaqueIdSchema,
  path: z.enum(['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md']),
  action: z.literal('read'),
  version: nonNegativeSafeIntegerSchema,
  sha256: sha256Schema,
  byteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
}).strict();

const contactPrivateBaseShape = {
  taskId: opaqueIdSchema,
  senderId: opaqueIdSchema,
  recipientId: opaqueIdSchema,
  purpose: z.string().min(1).max(256),
  intent: z.string().min(1).max(256),
  message: z.string().min(1).max(65_536),
  requestTraceId: opaqueIdSchema,
  deadlineMs: z.number().int().safe().positive().max(3_600_000),
  recipientTraceId: opaqueIdSchema,
} as const;
const contactPrivateSchema = z.discriminatedUnion('status', [
  z.object({
    ...contactPrivateBaseShape,
    status: z.literal('completed'),
    response: z.string().min(1).max(MAX_PRIVATE_RESPONSE_BYTES_V1),
  }).strict(),
  z.object({
    ...contactPrivateBaseShape,
    status: z.literal('denied'),
    errorCode: contactErrorCodeSchema,
  }).strict(),
  z.object({
    ...contactPrivateBaseShape,
    status: z.literal('failed'),
    errorCode: contactErrorCodeSchema,
  }).strict(),
  z.object({
    ...contactPrivateBaseShape,
    status: z.literal('cancelled'),
    errorCode: contactErrorCodeSchema,
  }).strict(),
]);

const strictJsonInputSchema = z.unknown().superRefine((value, context) => {
  validatePlainJsonInput(value, context, [], new WeakSet<object>());
});
const strictPairDataStoreSchema = strictJsonInputSchema.pipe(dataStoreSchema);
const strictFullEvaluationSchema = strictJsonInputSchema.pipe(
  pactPairFullEvaluationV1Schema,
);
const fullEvaluationEvidenceSchema = z.object({
  taskId: opaqueIdSchema,
  evaluation: strictFullEvaluationSchema,
  metrics: z.array(metricContributionSchema).max(64),
}).strict().superRefine((row, context) => {
  if (row.taskId !== row.evaluation.taskId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evaluation', 'taskId'],
      message: 'private full evaluation task identity must match its evidence row',
    });
  }
  if (
    row.metrics.length !== PACT_PAIR_METRIC_NAMES_V1.length
    || PACT_PAIR_METRIC_NAMES_V1.some(
      (metric, index) => row.metrics[index]?.metric !== metric,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics'],
      message: 'private full evaluation requires the exact ordered fixed PACT-Pair metric set',
    });
  }
});

export const fileWorkflowPrivateEvidenceV1Schema = z.object({
  contactRequests: z.array(contactPrivateSchema).max(1),
  memory: z.object({
    actorId: opaqueIdSchema,
    previousBytesBase64: z.string().max(MAX_PRIVATE_MEMORY_BASE64_LENGTH_V1),
    newBytesBase64: z.string().max(MAX_PRIVATE_MEMORY_BASE64_LENGTH_V1),
  }).strict().optional(),
  actionSnapshots: z.array(z.object({
    taskId: opaqueIdSchema,
    contactId: opaqueIdSchema,
    actorId: opaqueIdSchema,
    eventId: opaqueIdSchema,
    before: strictPairDataStoreSchema,
    after: strictPairDataStoreSchema,
  }).strict()).max(1),
  tickDecisions: z.array(fileTurnDecisionV1Schema).max(1),
  fullEvaluations: z.array(fullEvaluationEvidenceSchema)
    .max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
}).strict();

export type FileWorkflowPrivateEvidenceV1 = z.infer<
  typeof fileWorkflowPrivateEvidenceV1Schema
>;

export const fileWorkflowContactAuthorityV1Schema = z.object({
  taskId: opaqueIdSchema,
  contactId: opaqueIdSchema,
  kind: taskKindSchema,
  status: contactStatusSchema,
  errorCode: contactErrorCodeSchema.optional(),
  senderId: opaqueIdSchema,
  recipientId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  actionSnapshotDigest: sha256Schema.optional(),
  stateChanged: z.boolean().optional(),
}).strict().superRefine((authority, context) => {
  if ((authority.status !== 'completed') !== (authority.errorCode !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['errorCode'],
      message: 'non-completed contact authority requires its stable contact error code',
    });
  }
  if (
    authority.kind === 'action'
    && (
      authority.actionSnapshotDigest === undefined
      || authority.stateChanged === undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSnapshotDigest'],
      message: 'action contact authority requires its snapshot digest and derived state change',
    });
  }
  if (
    authority.kind === 'qa'
    && (
      authority.actionSnapshotDigest !== undefined
      || authority.stateChanged !== undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actionSnapshotDigest'],
      message: 'QA contact authority cannot carry action snapshot state',
    });
  }
});

export type FileWorkflowContactAuthorityV1 = z.infer<
  typeof fileWorkflowContactAuthorityV1Schema
>;

const memoryAuthorityRowSchema = z.object({
  taskId: opaqueIdSchema,
  status: fileMemoryStatusSchema,
}).strict();

export const fileWorkflowMemoryAuthorityV1Schema = z.object({
  actorId: opaqueIdSchema,
  previousVersion: nonNegativeSafeIntegerSchema,
  newVersion: nonNegativeSafeIntegerSchema,
  previousSha256: sha256Schema,
  newSha256: sha256Schema,
  previousRows: z.array(memoryAuthorityRowSchema)
    .min(1)
    .max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  newRows: z.array(memoryAuthorityRowSchema)
    .min(1)
    .max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
}).strict().superRefine((authority, context) => {
  if (authority.newVersion !== authority.previousVersion + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newVersion'],
      message: 'MEMORY authority must advance by exactly one version',
    });
  }
  const previousTaskIds = authority.previousRows.map(row => row.taskId);
  const newTaskIds = authority.newRows.map(row => row.taskId);
  if (
    previousTaskIds.length !== newTaskIds.length
    || new Set(previousTaskIds).size !== previousTaskIds.length
    || previousTaskIds.some((taskId, index) => taskId !== newTaskIds[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['newRows'],
      message: 'MEMORY authority rows must preserve one unique ordered task set',
    });
  }
});

export type FileWorkflowMemoryAuthorityV1 = z.infer<
  typeof fileWorkflowMemoryAuthorityV1Schema
>;

export const fileWorkflowHeartbeatPayloadV1Schema = z.object({
  event: z.object({
    eventId: opaqueIdSchema,
    runId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    tick: nonNegativeSafeIntegerSchema,
    actorId: opaqueIdSchema,
    traceId: opaqueIdSchema,
  }).strict(),
  selectedTaskId: opaqueIdSchema.optional(),
  correlatedContactId: opaqueIdSchema.optional(),
  contactAuthority: fileWorkflowContactAuthorityV1Schema.optional(),
  fileReads: z.array(fileReadReceiptSchema).max(512),
  memoryTransition: z.object({
    actorId: opaqueIdSchema,
    previousVersion: nonNegativeSafeIntegerSchema,
    newVersion: nonNegativeSafeIntegerSchema,
    previousSha256: sha256Schema,
    newSha256: sha256Schema,
    byteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
  }).strict().superRefine((transition, context) => {
    if (transition.newVersion !== transition.previousVersion + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newVersion'],
        message: 'new MEMORY version must advance by exactly one',
      });
    }
  }).optional(),
  memoryAuthority: fileWorkflowMemoryAuthorityV1Schema.optional(),
  transitions: z.array(fileWorkflowTerminalTransitionV1Schema)
    .max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  provider: z.object({
    requester: fileWorkflowModelProvenanceV1Schema,
    responder: fileWorkflowModelProvenanceV1Schema.optional(),
  }).strict(),
  usage: fileWorkflowUsageV1Schema,
  privateEvidenceDigest: sha256Schema.optional(),
  privateEvidence: fileWorkflowPrivateEvidenceV1Schema.optional(),
}).strict().superRefine((payload, context) => {
  const taskIds = payload.transitions.map(transition => transition.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transitions'],
      message: 'terminal transitions must contain unique task IDs',
    });
  }
  if (payload.correlatedContactId !== undefined && payload.selectedTaskId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTaskId'],
      message: 'a correlated contact requires its selected task identity',
    });
  }
  if (payload.contactAuthority && (
    payload.contactAuthority.taskId !== payload.selectedTaskId
    || payload.contactAuthority.contactId !== payload.correlatedContactId
    || payload.contactAuthority.eventId !== payload.event.eventId
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactAuthority'],
      message: 'contact authority must match its task, contact, and heartbeat event',
    });
  }
  const selectedTransition = payload.transitions.find(transition => (
    transition.taskId === payload.selectedTaskId
  ));
  if (
    selectedTransition?.contactId !== undefined
    && selectedTransition.contactId !== payload.correlatedContactId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['correlatedContactId'],
      message: 'selected terminal contact must match the heartbeat correlation',
    });
  }
});

export type FileWorkflowHeartbeatPayloadV1 = z.infer<
  typeof fileWorkflowHeartbeatPayloadV1Schema
>;

export const fileWorkflowPublicEventV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-event/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  sequence: nonNegativeSafeIntegerSchema,
  eventId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  tick: nonNegativeSafeIntegerSchema,
  actorId: opaqueIdSchema,
  traceId: opaqueIdSchema,
  selectedTaskId: opaqueIdSchema.optional(),
  terminalTaskIds: z.array(opaqueIdSchema).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  fileReadCount: nonNegativeSafeIntegerSchema.max(512),
  memoryCommitted: z.boolean(),
  usage: fileWorkflowUsageV1Schema,
}).strict().superRefine((event, context) => {
  if (event.tick !== event.sequence + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tick'],
      message: 'public heartbeat tick must equal sequence plus one',
    });
  }
  if (new Set(event.terminalTaskIds).size !== event.terminalTaskIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terminalTaskIds'],
      message: 'public terminal task IDs must be unique',
    });
  }
});

const statusCountsSchema = z.object({
  answered: nonNegativeSafeIntegerSchema,
  refused: nonNegativeSafeIntegerSchema,
  error: nonNegativeSafeIntegerSchema,
  no_response: nonNegativeSafeIntegerSchema,
  side_effect_before_failure: nonNegativeSafeIntegerSchema,
}).strict();

const summaryMetricSchema = z.object({
  metric: pactPairMetricNameSchema,
  numerator: nonNegativeSafeIntegerSchema,
  denominator: nonNegativeSafeIntegerSchema,
  value: z.number().finite().min(0).max(1).nullable(),
}).strict().superRefine((metric, context) => {
  if (metric.numerator > metric.denominator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['numerator'],
      message: 'summary metric numerator cannot exceed denominator',
    });
  }
  const expected = metric.denominator === 0
    ? null
    : metric.numerator / metric.denominator;
  if (metric.value !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'summary metric value must equal numerator divided by denominator',
    });
  }
});

export const fileWorkflowSummaryV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-summary/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  selectedTasks: nonNegativeSafeIntegerSchema,
  resultRows: nonNegativeSafeIntegerSchema,
  evaluationRows: nonNegativeSafeIntegerSchema,
  statuses: statusCountsSchema,
  metrics: z.array(summaryMetricSchema).length(PACT_PAIR_METRIC_NAMES_V1.length),
  usage: fileWorkflowUsageV1Schema,
}).strict().superRefine((summary, context) => {
  const statusTotal = Object.values(summary.statuses).reduce((total, value) => total + value, 0);
  if (
    summary.resultRows !== summary.evaluationRows
    || summary.resultRows > summary.selectedTasks
    || statusTotal !== summary.resultRows
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'summary status/result/evaluation counts must agree within selected tasks',
    });
  }
  if (PACT_PAIR_METRIC_NAMES_V1.some(
    (metric, index) => summary.metrics[index]?.metric !== metric,
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metrics'],
      message: 'summary requires the exact ordered fixed PACT-Pair metric set',
    });
  }
});

const runManifestActorSchema = actorBindingSchema.extend({
  final: fileWorkflowFileSetV1Schema.optional(),
}).strict();

export const fileWorkflowRunManifestV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-run/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  status: z.enum(['running', 'completed']),
  stopReason: z.enum(['all_terminal', 'tick_exhausted', 'fatal_error']).optional(),
  selectedTaskIds: z.array(opaqueIdSchema).min(1).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  selectedTasks: z.array(fileWorkflowSelectedTaskV1Schema).min(1).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  selectedTaskDigest: sha256Schema,
  dataset: datasetProvenanceSchema,
  goldSet: goldSetProvenanceSchema,
  policies: policyProvenancePairSchema,
  actors: z.object({
    requester: runManifestActorSchema,
    responder: runManifestActorSchema,
  }).strict(),
  backend: fileWorkflowBackendProvenanceV1Schema,
  recordCount: nonNegativeSafeIntegerSchema,
  resultRows: nonNegativeSafeIntegerSchema,
  evaluationRows: nonNegativeSafeIntegerSchema,
}).strict().superRefine((manifest, context) => {
  const metadataTaskIds = manifest.selectedTasks.map(task => task.taskId);
  if (
    new Set(metadataTaskIds).size !== metadataTaskIds.length
    || metadataTaskIds.length !== manifest.selectedTaskIds.length
    || metadataTaskIds.some((taskId, index) => taskId !== manifest.selectedTaskIds[index])
    || manifest.selectedTaskDigest !== fileWorkflowSelectedTaskDigestV1(manifest.selectedTaskIds)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedTasks'],
      message: 'run task metadata/digest must match selected task IDs and order',
    });
  }
  if (
    manifest.resultRows !== manifest.evaluationRows
    || manifest.resultRows > manifest.selectedTaskIds.length
    || (
      manifest.status === 'completed'
      && manifest.resultRows !== manifest.selectedTaskIds.length
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'run record/result/evaluation counts conflict with selected tasks',
    });
  }
  const hasFinalFiles = (
    manifest.actors.requester.final !== undefined
    && manifest.actors.responder.final !== undefined
  );
  if (manifest.status === 'running') {
    if (manifest.stopReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stopReason'],
        message: 'a running file-workflow run cannot have a stop reason',
      });
    }
    if (
      manifest.actors.requester.final !== undefined
      || manifest.actors.responder.final !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actors'],
        message: 'a running file-workflow run cannot declare final actor files',
      });
    }
  } else {
    if (manifest.stopReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stopReason'],
        message: 'a completed file-workflow run requires a stop reason',
      });
    }
    if (!hasFinalFiles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actors'],
        message: 'a completed file-workflow run requires both final actor file sets',
      });
    }
  }
  for (const role of ['requester', 'responder'] as const) {
    const final = manifest.actors[role].final;
    if (!final) continue;
    for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md'] as const) {
      if (
        final[path].sha256 !== manifest.actors[role].initial[path].sha256
        || final[path].byteLength !== manifest.actors[role].initial[path].byteLength
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actors', role, 'final', path],
          message: `${path} is read-only and must preserve its initial bytes`,
        });
      }
    }
  }
});

export const fileWorkflowCheckpointV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-checkpoint/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  status: z.enum(['running', 'completed']),
  recordCount: nonNegativeSafeIntegerSchema,
  selectedTasks: nonNegativeSafeIntegerSchema,
  resultRows: nonNegativeSafeIntegerSchema,
  evaluationRows: nonNegativeSafeIntegerSchema,
  lastEventId: opaqueIdSchema.nullable(),
  lastRecordDigest: sha256Schema.nullable(),
}).strict().superRefine((checkpoint, context) => {
  const hasLastAuthority = checkpoint.lastEventId !== null
    && checkpoint.lastRecordDigest !== null;
  if (
    (checkpoint.lastEventId === null) !== (checkpoint.lastRecordDigest === null)
    || (checkpoint.recordCount === 0) === hasLastAuthority
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastEventId'],
      message: 'checkpoint last event/digest must be null exactly when record count is zero',
    });
  }
  if (
    checkpoint.resultRows !== checkpoint.evaluationRows
    || checkpoint.resultRows > checkpoint.selectedTasks
    || (
      checkpoint.status === 'completed'
      && checkpoint.resultRows !== checkpoint.selectedTasks
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'checkpoint result/evaluation counts conflict with selected tasks',
    });
  }
});

export function fileWorkflowSelectedTaskDigestV1(taskIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(taskIds)).digest('hex');
}

export function assertFileWorkflowFinalCardinalityV1(input: {
  selectedTaskIds: readonly string[];
  results: readonly Pick<FileWorkflowPublicResultV1, 'taskId'>[];
  evaluations: readonly Pick<FileWorkflowPublicEvaluationRecordV1, 'taskId'>[];
}): void {
  const selected = [...input.selectedTaskIds];
  const results = input.results.map(row => row.taskId);
  const evaluations = input.evaluations.map(row => row.taskId);
  if (
    new Set(selected).size !== selected.length
    || new Set(results).size !== results.length
    || new Set(evaluations).size !== evaluations.length
  ) {
    throw new Error('Final file-workflow cardinality requires unique task IDs');
  }
  if (
    selected.length !== results.length
    || selected.length !== evaluations.length
  ) {
    throw new Error('Final file-workflow cardinality does not match selected tasks');
  }
  if (
    selected.some((taskId, index) => results[index] !== taskId)
    || selected.some((taskId, index) => evaluations[index] !== taskId)
  ) {
    throw new Error('Final file-workflow task-ID set and order must match selection');
  }
}

export function materializeFileWorkflowNoResponseTransitionsV1(input: {
  binding: FileWorkflowRunBindingV1;
  sessionId: string;
  terminalTick: number;
  existingTaskIds: readonly string[];
}): FileWorkflowTerminalTransitionV1[] {
  const binding = fileWorkflowRunBindingV1Schema.parse(input.binding);
  const sessionId = opaqueIdSchema.parse(input.sessionId);
  const terminalTick = nonNegativeSafeIntegerSchema.parse(input.terminalTick);
  const existing = new Set(input.existingTaskIds.map(taskId => opaqueIdSchema.parse(taskId)));
  if (existing.size !== input.existingTaskIds.length) {
    throw new Error('Existing terminal task IDs must be unique');
  }
  for (const taskId of existing) {
    if (!binding.selectedTaskIds.includes(taskId)) {
      throw new Error('Existing terminal task ID is outside the selected task set');
    }
  }
  return binding.selectedTaskIds.filter(taskId => !existing.has(taskId)).map(taskId => {
    const kind = binding.selectedTasks.find(task => task.taskId === taskId)?.kind;
    if (!kind) throw new Error(`Missing public task kind for ${taskId}`);
    const result: FileWorkflowPublicResultV1 = {
      apiVersion: 'sharedeval-file-result/v1',
      workflowId: binding.workflowId,
      runId: binding.runId,
      sessionId,
      taskId,
      kind,
      status: 'no_response',
      terminalTick,
      publicEvaluation: null,
      selectedTaskDigest: binding.selectedTaskDigest,
      backend: structuredClone(binding.backend),
    };
    return {
      taskId,
      result,
      evaluation: {
        apiVersion: 'sharedeval-file-evaluation/v1',
        workflowId: binding.workflowId,
        runId: binding.runId,
        sessionId,
        taskId,
        publicEvaluation: null,
        metrics: [],
      },
    };
  });
}

export function zeroFileWorkflowUsageV1() {
  return zeroUsage();
}

function zeroUsage() {
  return {
    modelCalls: 0,
    toolSteps: 0,
    contactCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function validatePlainJsonInput(
  value: unknown,
  context: z.RefinementCtx,
  path: Array<string | number>,
  seen: WeakSet<object>,
): void {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'private evidence numbers must be finite JSON values',
      });
    }
    return;
  }
  if (typeof value !== 'object') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'private evidence must contain only plain JSON values',
    });
    return;
  }
  if (seen.has(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'private evidence cannot contain cyclic values',
    });
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'private evidence arrays must use the plain JSON prototype',
      });
      return;
    }
    const keys = Object.keys(value);
    if (
      keys.length !== value.length
      || keys.some((key, index) => key !== String(index))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'private evidence arrays must be dense without extra properties',
      });
      return;
    }
    for (const [index, nested] of value.entries()) {
      validatePlainJsonInput(nested, context, [...path, index], seen);
    }
    seen.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'private evidence objects must use the plain JSON prototype',
    });
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'private evidence cannot contain symbol keys',
      });
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: 'private evidence must use enumerable data properties',
      });
      continue;
    }
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: 'private evidence contains a reserved prototype key',
      });
      continue;
    }
    validatePlainJsonInput(descriptor.value, context, [...path, key], seen);
  }
  seen.delete(value);
}
