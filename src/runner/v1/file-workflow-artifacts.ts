import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PACT_PAIR_METRIC_NAMES_V1 } from '../../suites/pact-pair/evaluation.js';
import { dataStoreSchema } from '../../suites/pact-pair/schemas.js';
import { MAX_AGENT_WORKSPACE_FILE_BYTES_V1 } from './agent-workspace.js';
import {
  pactPairFullEvaluationV1Schema,
  pactPairPublicEvaluationV1Schema,
} from '../../suites/pact-pair/public-evaluation.js';
import { fileTurnDecisionV1Schema } from './file-turn-contracts.js';
import {
  FILE_SESSION_CONTACT_ERROR_CODES_V1,
  SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
} from './sharedos-file-session-contracts.js';
import { agentWorkspaceRegistryReferencesV1Schema } from './workspace-registry.js';

export const MAX_FILE_WORKFLOW_SELECTED_TASKS_V1 = 600;
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
const positiveSafeIntegerSchema = z.number().int().safe().positive();
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
const contactErrorCodeSchema = z.enum(FILE_SESSION_CONTACT_ERROR_CODES_V1);
const executionStatusSchema = z.enum([
  'succeeded',
  'denied',
  'failed',
  'cancelled',
  'escalated',
]);
const sessionStopReasonSchema = z.enum([
  'all_terminal',
  'tick_exhausted',
  'fatal_error',
]);

export const FILE_WORKFLOW_PUBLIC_ERROR_CODES_V1 = Object.freeze([
  ...FILE_SESSION_CONTACT_ERROR_CODES_V1,
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
  version: semverSchema,
  manifestSha256: sha256Schema,
  tasksSha256: sha256Schema,
}).strict();

const goldSetProvenanceSchema = z.object({
  id: registryIdSchema,
  sha256: sha256Schema,
}).strict();

export const fileWorkflowHostRunProvenanceV1Schema = z.object({
  dataset: datasetProvenanceSchema,
  goldSet: goldSetProvenanceSchema,
  models: z.object({
    requester: fileWorkflowModelProvenanceV1Schema,
    responder: fileWorkflowModelProvenanceV1Schema,
  }).strict(),
  backend: fileWorkflowBackendProvenanceV1Schema,
}).strict();

export type FileWorkflowHostRunProvenanceV1 = z.infer<
  typeof fileWorkflowHostRunProvenanceV1Schema
>;

const policyProvenancePairSchema = z.object({
  requester: assetProvenanceSchema,
  responder: assetProvenanceSchema,
}).strict();

const fileWorkflowSharedOsRunAuthorityV1Schema = z.object({
  runStartedAt: z.string()
    .datetime({ offset: false, precision: 3 })
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  namespaceId: registryIdSchema,
  grantManifestDigest: sha256Schema,
  sharedOsRevision: z.string().regex(/^[a-f0-9]{40}$/),
  sharedOsRuntimeDigest: sha256Schema,
}).strict();

export const fileWorkflowRunBindingV1Schema = z.object({
  apiVersion: z.literal('sharedeval-file-run-binding/v1'),
  workflowId: fileWorkflowIdSchema,
  runId: opaqueIdSchema,
  selectedTaskIds: z.array(opaqueIdSchema).min(1).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  selectedTasks: z.array(fileWorkflowSelectedTaskV1Schema).min(1).max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  selectedTaskDigest: sha256Schema,
  scheduler: z.object({
    sessionId: opaqueIdSchema,
    sessionIndex: nonNegativeSafeIntegerSchema,
    maxTicks: positiveSafeIntegerSchema,
    budget: z.object({
      deadlineMs: positiveSafeIntegerSchema,
      maxToolCalls: positiveSafeIntegerSchema,
    }).strict(),
    initialActionSha256: sha256Schema,
  }).strict(),
  dataset: datasetProvenanceSchema,
  goldSet: goldSetProvenanceSchema,
  policies: policyProvenancePairSchema,
  actors: z.object({
    requester: actorBindingSchema,
    responder: actorBindingSchema,
  }).strict(),
  backend: fileWorkflowBackendProvenanceV1Schema,
  sharedOs: fileWorkflowSharedOsRunAuthorityV1Schema,
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
  // A refusal reaches the requester on either channel: the responder can deny
  // the request outright (denied), or answer the envelope with a reply whose
  // content declines (completed). Only the first is representable as a turn
  // decision -- the model driver derives `denied` from the provider's
  // API-level refusal field -- so requiring `denied` here scored every
  // policy-based refusal as a harness error.
  if (
    result.status === 'refused'
    && result.contactStatus !== 'denied'
    && result.contactStatus !== 'completed'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactStatus'],
      message: 'refused results require a delivered or denied contact',
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

const strictJsonInputSchema = z.unknown().superRefine((value, context) => {
  validatePlainJsonInput(value, context, [], new WeakSet<object>());
});
const strictJsonObjectInputSchema = strictJsonInputSchema.pipe(
  z.record(z.string(), z.unknown()),
);
const canonicalBase64Schema = z.string()
  .max(MAX_PRIVATE_MEMORY_BASE64_LENGTH_V1)
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value, {
    message: 'must use canonical base64',
  });

const sharedOsAddressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('group'), conversationId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('service'), serviceId: z.string().min(1).max(256) }).strict(),
]);
const sharedOsResourceRefSchema = z.object({
  namespace: z.string().min(1).max(256),
  path: z.array(z.string().min(1).max(256)).max(16),
  owner: sharedOsAddressSchema.optional(),
}).strict();
const sharedOsMessageEnvelopeSchema = z.object({
  version: z.literal('1'),
  id: opaqueIdSchema,
  sender: sharedOsAddressSchema,
  receiver: sharedOsAddressSchema,
  purpose: z.literal(SHAREDEVAL_PACT_PAIR_PURPOSE_V1),
  payload: strictJsonInputSchema,
  traceId: opaqueIdSchema,
  replyTo: opaqueIdSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  provenance: z.object({
    source: z.string().min(1).max(256),
    parentIds: z.array(opaqueIdSchema).max(32),
    metadata: strictJsonObjectInputSchema.optional(),
  }).strict().optional(),
}).strict();
const sharedOsAuditEventSchema = z.object({
  version: z.literal('1'),
  type: z.enum([
    'authority.resolved',
    'authorization.checked',
    'escalation.requested',
    'resource.invoked',
    'tool.catalog.listed',
    'tool.namespace.catalog.listed',
    'tool.namespace.selection.updated',
    'tool.invoked',
    'message.sent',
  ]),
  outcome: z.enum(['allowed', 'denied', 'succeeded', 'failed', 'escalated']),
  at: z.string().datetime({ offset: true }),
  traceId: opaqueIdSchema,
  namespaceId: registryIdSchema,
  actor: sharedOsAddressSchema,
  authority: sharedOsAddressSchema,
  owner: sharedOsAddressSchema,
  purpose: z.literal(SHAREDEVAL_PACT_PAIR_PURPOSE_V1),
  resource: sharedOsResourceRefSchema.optional(),
  action: z.string().min(1).max(128).optional(),
  grantId: opaqueIdSchema.optional(),
  authorityHash: sha256Schema.optional(),
  operationId: opaqueIdSchema.optional(),
  tool: z.string().min(1).max(256).optional(),
  messageId: opaqueIdSchema.optional(),
  receiver: sharedOsAddressSchema.optional(),
  reason: z.string().min(1).max(2048).optional(),
  metadata: strictJsonObjectInputSchema.optional(),
}).strict();

const sharedOsFileOperationBaseShape = {
  runId: opaqueIdSchema,
  actorId: opaqueIdSchema,
  traceId: opaqueIdSchema,
  operationId: opaqueIdSchema,
} as const;
const sharedOsFileReadOperationSchema = z.object({
  ...sharedOsFileOperationBaseShape,
  path: z.enum(['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md']),
  action: z.literal('read'),
  outcome: z.literal('succeeded'),
  version: nonNegativeSafeIntegerSchema,
  sha256: sha256Schema,
  byteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
}).strict();
const sharedOsFileReplaceBaseShape = {
  ...sharedOsFileOperationBaseShape,
  path: z.literal('MEMORY.md'),
  action: z.literal('replace'),
  expectedVersion: nonNegativeSafeIntegerSchema,
  previousVersion: nonNegativeSafeIntegerSchema,
  previousSha256: sha256Schema,
  previousByteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
  version: nonNegativeSafeIntegerSchema,
  sha256: sha256Schema,
  byteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
} as const;
const rawSharedOsFileReplaceConflictSchema = z.object({
  ...sharedOsFileReplaceBaseShape,
  outcome: z.literal('conflict'),
  previousBytesBase64: canonicalBase64Schema,
  newBytesBase64: canonicalBase64Schema,
}).strict().superRefine((receipt, context) => {
  const previous = Buffer.from(receipt.previousBytesBase64, 'base64');
  if (
    previous.byteLength !== receipt.previousByteLength
    || createHash('sha256').update(previous).digest('hex') !== receipt.previousSha256
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousBytesBase64'],
      message: 'conflict receipt previous bytes must match their metadata',
    });
  }
}).transform(receipt => {
  const { previousBytesBase64: _previous, newBytesBase64, ...bounded } = receipt;
  const attempted = Buffer.from(newBytesBase64, 'base64');
  return {
    ...bounded,
    attemptedSha256: createHash('sha256').update(attempted).digest('hex'),
    attemptedByteLength: attempted.byteLength,
  };
});
const normalizedSharedOsFileReplaceConflictSchema = z.object({
  ...sharedOsFileReplaceBaseShape,
  outcome: z.literal('conflict'),
  attemptedSha256: sha256Schema,
  attemptedByteLength: nonNegativeSafeIntegerSchema.max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
}).strict();
const sharedOsFileReplaceCommittedSchema = z.object({
  ...sharedOsFileReplaceBaseShape,
  outcome: z.literal('committed'),
  previousBytesBase64: canonicalBase64Schema,
  newBytesBase64: canonicalBase64Schema,
  durability: z.literal('published_unsynced').optional(),
}).strict().superRefine((receipt, context) => {
  const previous = Buffer.from(receipt.previousBytesBase64, 'base64');
  const next = Buffer.from(receipt.newBytesBase64, 'base64');
  if (
    receipt.expectedVersion !== receipt.previousVersion
    || receipt.version !== receipt.previousVersion + 1
    || previous.byteLength !== receipt.previousByteLength
    || createHash('sha256').update(previous).digest('hex') !== receipt.previousSha256
    || next.byteLength !== receipt.byteLength
    || createHash('sha256').update(next).digest('hex') !== receipt.sha256
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'committed MEMORY receipt bytes and CAS metadata must match exactly',
    });
  }
});
const sharedOsFileOperationSchema = z.union([
  sharedOsFileReadOperationSchema,
  sharedOsFileReplaceCommittedSchema,
  normalizedSharedOsFileReplaceConflictSchema,
  rawSharedOsFileReplaceConflictSchema,
]);

const providerUsageTelemetrySchema = z.object({
  promptTokens: nonNegativeFiniteSchema.optional(),
  completionTokens: nonNegativeFiniteSchema.optional(),
  totalTokens: nonNegativeFiniteSchema.optional(),
  reasoningTokens: nonNegativeFiniteSchema.optional(),
  cachedTokens: nonNegativeFiniteSchema.optional(),
  costUsd: nonNegativeFiniteSchema.optional(),
}).strict();
const providerRequestTelemetrySchema = z.object({
  requestedModel: z.string().min(1).max(512),
  resolvedModel: z.string().min(1).max(512),
  servedModel: z.string().min(1).max(512).optional(),
  servedModelVerified: z.boolean().optional(),
  provider: z.string().min(1).max(512).optional(),
  responseId: z.string().min(1).max(512).optional(),
  requestId: z.string().min(1).max(512).optional(),
  generationId: z.string().min(1).max(512).optional(),
  httpStatus: z.number().int().safe().min(100).max(599).optional(),
  lastResponseAttempt: nonNegativeSafeIntegerSchema.optional(),
  retryable: z.boolean().optional(),
  latencyMs: nonNegativeFiniteSchema,
  attempts: nonNegativeSafeIntegerSchema,
  choiceCount: nonNegativeSafeIntegerSchema.optional(),
  outcome: z.enum(['success', 'invalid_response', 'provider_error']),
  usage: providerUsageTelemetrySchema.optional(),
}).strict();
const providerTelemetrySchema = z.object({
  requestedModel: z.string().min(1).max(512),
  resolvedModel: z.string().min(1).max(512),
  requests: z.array(providerRequestTelemetrySchema).max(512),
  totals: z.object({
    requests: nonNegativeSafeIntegerSchema.max(512),
    promptTokens: nonNegativeFiniteSchema.optional(),
    completionTokens: nonNegativeFiniteSchema.optional(),
    totalTokens: nonNegativeFiniteSchema.optional(),
    reasoningTokens: nonNegativeFiniteSchema.optional(),
    cachedTokens: nonNegativeFiniteSchema.optional(),
    costUsd: nonNegativeFiniteSchema.optional(),
  }).strict(),
}).strict();

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

export const fileWorkflowSharedOsRetainedEvidenceV1Schema = z.object({
  requesterExecutionStatus: executionStatusSchema,
  sourceEvidence: z.object({
    requesterFileOperations: z.array(sharedOsFileOperationSchema).max(512),
    responderFileOperations: z.array(sharedOsFileOperationSchema).max(512),
    acceptedMessages: z.array(sharedOsMessageEnvelopeSchema).max(2),
    auditEvents: z.array(sharedOsAuditEventSchema).min(1).max(4096),
  }).strict(),
  providerTelemetry: z.object({
    requester: providerTelemetrySchema,
    responder: providerTelemetrySchema.optional(),
  }).strict(),
  actionSnapshots: z.array(z.object({
    taskId: opaqueIdSchema,
    contactId: opaqueIdSchema,
    actorId: opaqueIdSchema,
    eventId: opaqueIdSchema,
    before: strictPairDataStoreSchema,
    after: strictPairDataStoreSchema,
  }).strict()).max(1),
  tickDecisions: z.array(fileTurnDecisionV1Schema).max(1),
}).strict();

export type FileWorkflowSharedOsRetainedEvidenceV1 = z.infer<
  typeof fileWorkflowSharedOsRetainedEvidenceV1Schema
>;

export const fileWorkflowPrivateEvidenceV1Schema =
  fileWorkflowSharedOsRetainedEvidenceV1Schema.extend({
  fullEvaluations: z.array(fullEvaluationEvidenceSchema)
    .max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
}).strict();

export type FileWorkflowPrivateEvidenceV1 = z.infer<
  typeof fileWorkflowPrivateEvidenceV1Schema
>;

export const fileWorkflowContactAuthorityV1Schema = z.object({
  taskId: opaqueIdSchema,
  contactId: opaqueIdSchema,
  replyMessageId: opaqueIdSchema.optional(),
  responderExecutionId: opaqueIdSchema.optional(),
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
  const hasResponderOutcome = authority.status === 'completed' || authority.status === 'denied';
  if (
    (hasResponderOutcome && (
      authority.replyMessageId === undefined
      || authority.responderExecutionId === undefined
    ))
    || (!hasResponderOutcome && authority.replyMessageId !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replyMessageId'],
      message: 'completed or denied contacts require reply and execution IDs; failures cannot claim a reply',
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

const fileWorkflowMemoryTransitionV1Schema = z.object({
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
});

const fileWorkflowSharedOsHeartbeatAuthorityV1Schema =
  fileWorkflowSharedOsRunAuthorityV1Schema.extend({
    requesterExecutionId: opaqueIdSchema,
    requesterExecutionStatus: executionStatusSchema,
    responderExecutionId: opaqueIdSchema.optional(),
    audit: z.object({
      firstSequence: nonNegativeSafeIntegerSchema,
      lastSequence: nonNegativeSafeIntegerSchema,
      sha256: sha256Schema,
    }).strict(),
  }).strict().superRefine((authority, context) => {
    if (authority.audit.lastSequence < authority.audit.firstSequence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audit', 'lastSequence'],
        message: 'SharedOS audit window must be a nonempty inclusive range',
      });
    }
  });

export const fileWorkflowHeartbeatPayloadV1Schema = z.object({
  inputDigest: sha256Schema,
  event: z.object({
    eventId: opaqueIdSchema,
    runId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    tick: nonNegativeSafeIntegerSchema,
    actorId: opaqueIdSchema,
    traceId: opaqueIdSchema,
  }).strict(),
  contactAuthority: fileWorkflowContactAuthorityV1Schema.optional(),
  fileReads: z.array(fileReadReceiptSchema).max(512),
  memoryTransitions: z.array(fileWorkflowMemoryTransitionV1Schema).max(2),
  memoryAuthorities: z.array(fileWorkflowMemoryAuthorityV1Schema).max(2),
  transitions: z.array(fileWorkflowTerminalTransitionV1Schema)
    .max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  sharedOsAuthority: fileWorkflowSharedOsHeartbeatAuthorityV1Schema,
  sessionStopReason: sessionStopReasonSchema.optional(),
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
  if (payload.contactAuthority && (
    payload.contactAuthority.eventId !== payload.event.eventId
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactAuthority'],
      message: 'contact authority must match its heartbeat event',
    });
  }
  const selectedTransition = payload.contactAuthority
    ? payload.transitions.find(transition => (
      transition.taskId === payload.contactAuthority?.taskId
    ))
    : undefined;
  if (
    selectedTransition?.contactId !== undefined
    && selectedTransition.contactId !== payload.contactAuthority?.contactId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contactAuthority'],
      message: 'current terminal contact must match the heartbeat contact authority',
    });
  }
  const memoryActorIds = payload.memoryTransitions.map(transition => transition.actorId);
  if (
    payload.memoryTransitions.length !== payload.memoryAuthorities.length
    || new Set(memoryActorIds).size !== memoryActorIds.length
    || payload.memoryAuthorities.some((authority, index) => {
      const transition = payload.memoryTransitions[index];
      return !transition
        || authority.actorId !== transition.actorId
        || authority.previousVersion !== transition.previousVersion
        || authority.newVersion !== transition.newVersion
        || authority.previousSha256 !== transition.previousSha256
        || authority.newSha256 !== transition.newSha256;
    })
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memoryAuthorities'],
      message: 'MEMORY transitions and authorities require one unique exact actor-ordered pair',
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
