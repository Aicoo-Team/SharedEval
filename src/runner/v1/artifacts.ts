import { z } from 'zod';
import {
  jsonValueSchema,
  pactBoundaryPlanV1Schema,
  pactTaskIntroV1Schema,
  pactTerminalDecisionV1Schema,
} from '../../protocol/v1/index.js';
import {
  pactRunBudgetV1Schema,
  pactRunConfigV1Schema,
} from './config.js';

const nonNegativeCountSchema = z.number().int().safe().nonnegative();
const rateSchema = z
  .object({
    numerator: nonNegativeCountSchema,
    denominator: nonNegativeCountSchema,
    value: z.number().finite().min(0).max(1).nullable(),
  })
  .strict()
  .superRefine((rate, context) => {
    const expected = rate.denominator === 0
      ? null
      : rate.numerator / rate.denominator;
    if (rate.value !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'must equal numerator / denominator, or null when denominator is zero',
      });
    }
  });

const recordDiffSchema = z
  .object({
    created: z.array(nonNegativeCountSchema),
    updated: z.array(nonNegativeCountSchema),
    removed: z.array(nonNegativeCountSchema),
  })
  .strict();

const mutationSummarySchema = z
  .object({
    metadataChanged: z.boolean(),
    noteFoldersChanged: z.boolean(),
    todoFoldersChanged: z.boolean(),
    notes: recordDiffSchema,
    todos: recordDiffSchema,
  })
  .strict();

export const pactPairPublicQaEvaluationV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('qa'),
    actualDecision: z.enum(['answer', 'refuse', 'escalate', 'none']),
    scorable: z.boolean(),
    correct: z.boolean(),
    factMatch: z.boolean(),
    leaked: z.boolean(),
    noLeak: z.boolean(),
  })
  .strict();

export const pactPairPublicActionEvaluationV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('action'),
    actualDecision: z.enum(['answer', 'refuse', 'escalate', 'none']),
    scorable: z.boolean(),
    correct: z.boolean(),
    stateChanged: z.boolean(),
    stateCorrect: z.boolean(),
    noUnexpectedMutations: z.boolean(),
    mutations: mutationSummarySchema,
  })
  .strict();

export const pactPairPublicEvaluationV1Schema = z.discriminatedUnion('kind', [
  pactPairPublicQaEvaluationV1Schema,
  pactPairPublicActionEvaluationV1Schema,
]);

export const pactTaskResultV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.enum(['qa', 'action']),
    publicTask: pactTaskIntroV1Schema,
    finalDecision: pactTerminalDecisionV1Schema,
    grantedAccess: pactBoundaryPlanV1Schema,
    evaluation: pactPairPublicEvaluationV1Schema,
    budgetUsed: z
      .object({
        turns: nonNegativeCountSchema,
        toolCalls: nonNegativeCountSchema,
        runtimeMs: nonNegativeCountSchema,
      })
      .strict(),
    toolCalls: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          name: z.string().min(1).max(64),
          isError: z.boolean(),
        })
        .strict(),
    ),
    violations: z.array(z.string().min(1).max(256)),
    error: z.string().min(1).max(2_000).optional(),
    finalizeError: z.string().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.kind !== result.publicTask.kind
      || result.kind !== result.evaluation.kind
      || result.taskId !== result.publicTask.taskId
      || result.taskId !== result.evaluation.taskId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task id and kind must agree across the result, public task, and evaluation',
      });
    }
  });

export const pactRunSummaryV1Schema = z
  .object({
    total: nonNegativeCountSchema,
    scorable: nonNegativeCountSchema,
    correct: nonNegativeCountSchema,
    errors: nonNegativeCountSchema,
    violations: nonNegativeCountSchema,
    metrics: z
      .object({
        informationUtility: rateSchema,
        informationSecurity: rateSchema,
        actionUtility: rateSchema,
        actionSafety: rateSchema,
        falseRefusalRate: rateSchema,
        leakRate: rateSchema,
      })
      .strict(),
    qa: z
      .object({
        total: nonNegativeCountSchema,
        scorable: nonNegativeCountSchema,
        correct: nonNegativeCountSchema,
        expectedAnswer: nonNegativeCountSchema,
        correctAnswers: nonNegativeCountSchema,
        expectedRefuse: nonNegativeCountSchema,
        safeRefusals: nonNegativeCountSchema,
        protectedNoLeak: nonNegativeCountSchema,
        leaks: nonNegativeCountSchema,
        falseRefusals: nonNegativeCountSchema,
        borderline: nonNegativeCountSchema,
      })
      .strict(),
    actions: z
      .object({
        total: nonNegativeCountSchema,
        correct: nonNegativeCountSchema,
        expectedExecute: nonNegativeCountSchema,
        correctExecutions: nonNegativeCountSchema,
        expectedRefuse: nonNegativeCountSchema,
        safeRefusals: nonNegativeCountSchema,
        safeNoMutation: nonNegativeCountSchema,
        unsafeMutations: nonNegativeCountSchema,
      })
      .strict(),
  })
  .strict();

const openAICompatibleModelMetadataV1Schema = z
  .object({
    provider: z.literal('openai-compatible'),
    baseUrl: z.string().url().max(2_048),
    model: z.string().min(1).max(256),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536),
  })
  .strict();

// Azure metadata records the resource endpoint, deployment, and api-version
// (all non-secret). The credential never appears here — it stays in the
// api-key header at request time only.
const azureOpenAIModelMetadataV1Schema = z
  .object({
    provider: z.literal('azure-openai'),
    endpoint: z.string().url().max(2_048),
    deployment: z.string().min(1).max(256),
    apiVersion: z.string().min(1).max(64).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536),
  })
  .strict();

export const pactRunModelMetadataV1Schema = z.discriminatedUnion('provider', [
  openAICompatibleModelMetadataV1Schema,
  azureOpenAIModelMetadataV1Schema,
]);

export const pactRunMetadataV1Schema = z
  .object({
    runId: z.string().min(1).max(256),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    model: pactRunModelMetadataV1Schema,
    benchmark: pactRunConfigV1Schema.shape.benchmark,
    budget: pactRunBudgetV1Schema,
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
    aborted: z
      .object({
        afterTaskId: z.string().min(1).max(128),
        reason: z.literal('provider_configuration_error'),
      })
      .strict()
      .optional(),
  })
  .strict();

export const pactTraceEventV1Schema = z
  .object({
    at: z.string().datetime({ offset: true }),
    runId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(128).optional(),
    event: z.string().min(1).max(128),
    data: jsonValueSchema,
  })
  .strict();

export type PactPairPublicQaEvaluationV1 = z.infer<
  typeof pactPairPublicQaEvaluationV1Schema
>;
export type PactPairPublicActionEvaluationV1 = z.infer<
  typeof pactPairPublicActionEvaluationV1Schema
>;
export type PactPairPublicEvaluationV1 = z.infer<
  typeof pactPairPublicEvaluationV1Schema
>;
export type PactTaskResultV1 = z.infer<typeof pactTaskResultV1Schema>;
export type PactRunSummaryV1 = z.infer<typeof pactRunSummaryV1Schema>;
export type PactRunMetadataV1 = z.infer<typeof pactRunMetadataV1Schema>;
export type PactTraceEventV1 = z.infer<typeof pactTraceEventV1Schema>;

// Pair-prefixed aliases preserve the current runner API while the canonical
// artifact names remain usable by every execution backend.
export type PactPairTaskResultV1 = PactTaskResultV1;
export type PactPairRunSummaryV1 = PactRunSummaryV1;
export type PactRateV1 = z.infer<typeof rateSchema>;
