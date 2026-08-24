/**
 * Zod schemas for the canonical run artifacts (results.jsonl, summary.json,
 * run.json, trace.jsonl, evaluation.jsonl). Execution backends that run trials
 * in a separate process — such as the Harbor container backend — parse these
 * artifacts back across the process/container trust boundary, so every field
 * is validated before a result re-enters the host run.
 */
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
import { PACT_PAIR_POLICIES_V1 } from '../../suites/pact-pair/task-loader.js';
import type {
  PactPairPublicActionEvaluationV1,
  PactPairPublicEvaluationV1,
  PactPairPublicQaEvaluationV1,
  PactPairTaskResultV1 as SuitePactPairTaskResultV1,
  PactPairTraceEventV1,
} from '../../suites/pact-pair/environment.js';
import type { PactPairRunSummaryV1 as SuitePactPairRunSummaryV1 } from '../../suites/pact-pair/runner.js';
import type { PactPairEvaluationV1 } from '../../suites/pact-pair/evaluator.js';
import type { MetricContribution } from '../../evaluation/index.js';

const nonNegativeCountSchema = z.number().int().safe().nonnegative();
const nonNegativeNumberSchema = z.number().finite().nonnegative();
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

const actualDecisionSchema = z.enum(['answer', 'refuse', 'escalate', 'none']);

export const pactPairPublicQaEvaluationV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('qa'),
    actualDecision: actualDecisionSchema,
    scorable: z.boolean(),
    correct: z.boolean(),
    factMatch: z.boolean(),
    leaked: z.boolean(),
    noLeak: z.boolean(),
    benchmarkLeaked: z.boolean(),
    benchmarkNoLeak: z.boolean(),
  })
  .strict();

export const pactPairPublicActionEvaluationV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('action'),
    actualDecision: actualDecisionSchema,
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

// Provider telemetry is host-recorded diagnostic data with a large optional
// surface. The bounded structural check below keeps artifact parsing strict
// about what matters (its identity and request list) without duplicating the
// full telemetry type; containerized scripted trials never produce it.
const providerTelemetrySchema = z
  .object({
    requestedModel: z.string().min(1).max(256),
    requests: z.array(z.record(jsonValueSchema)).max(10_000),
    totals: z.record(jsonValueSchema),
  })
  .passthrough();

export const pactTaskResultV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.enum(['qa', 'action']),
    status: z.enum(['ok', 'infrastructure_error']),
    publicTask: pactTaskIntroV1Schema,
    finalDecision: pactTerminalDecisionV1Schema,
    /**
     * One record per requester message. Absent on artifacts produced before
     * multi-exchange support, and on trials that never reached a terminal
     * decision; length 1 for ordinary single-exchange tasks.
     */
    exchanges: z
      .array(
        z
          .object({
            exchange: nonNegativeCountSchema,
            prompt: z.string().min(1).max(32_768),
            decision: pactTerminalDecisionV1Schema,
            firstTurn: nonNegativeCountSchema,
            turnsUsed: nonNegativeCountSchema,
          })
          .strict(),
      )
      .max(16)
      .optional(),
    grantedAccess: pactBoundaryPlanV1Schema,
    evaluation: pactPairPublicEvaluationV1Schema.nullable(),
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
    providerTelemetry: providerTelemetrySchema.optional(),
    violations: z.array(z.string().min(1).max(256)),
    error: z.string().min(1).max(2_000).optional(),
    finalizeError: z.string().min(1).max(2_000).optional(),
    // Execution-substrate identity for trials run through a SharedOS
    // adapter. Public identity block only — kernel runtime/audit events
    // stay in the private trace artifact.
    sharedOs: z
      .object({
        adapterId: z.string().min(1).max(64),
        protocolVersion: z.string().min(1).max(16),
        status: z.enum(['succeeded', 'denied', 'failed', 'cancelled']),
        traceId: z.string().min(1).max(256),
        latencyMs: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.kind !== result.publicTask.kind
      || result.taskId !== result.publicTask.taskId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task id and kind must agree between the result and public task',
      });
    }
    if (result.evaluation && (
      result.kind !== result.evaluation.kind
      || result.taskId !== result.evaluation.taskId
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task id and kind must agree between the result and evaluation',
      });
    }
    if (result.status === 'ok' && result.evaluation === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an ok result must carry a public evaluation',
      });
    }
  });

const providerSummarySchema = z
  .object({
    requests: nonNegativeCountSchema,
    successfulRequests: nonNegativeCountSchema,
    invalidResponses: nonNegativeCountSchema,
    failedRequests: nonNegativeCountSchema,
    httpAttempts: nonNegativeCountSchema,
    usageRecords: nonNegativeCountSchema,
    costRecords: nonNegativeCountSchema,
    usageComplete: z.boolean(),
    costComplete: z.boolean(),
    servedModels: z.array(z.string().min(1).max(256)),
    providers: z.array(z.string().min(1).max(256)),
    promptTokens: nonNegativeNumberSchema.optional(),
    completionTokens: nonNegativeNumberSchema.optional(),
    totalTokens: nonNegativeNumberSchema.optional(),
    reasoningTokens: nonNegativeNumberSchema.optional(),
    cachedTokens: nonNegativeNumberSchema.optional(),
    costUsd: nonNegativeNumberSchema.optional(),
  })
  .strict();

export const pactRunSummaryV1Schema = z
  .object({
    total: nonNegativeCountSchema,
    attempted: nonNegativeCountSchema,
    observed: nonNegativeCountSchema,
    scorable: nonNegativeCountSchema,
    correct: nonNegativeCountSchema,
    errors: nonNegativeCountSchema,
    violations: nonNegativeCountSchema,
    provider: providerSummarySchema,
    metrics: z
      .object({
        informationUtility: rateSchema,
        informationSecurity: rateSchema,
        actionUtility: rateSchema,
        actionSafety: rateSchema,
        falseRefusalRate: rateSchema,
        leakRate: rateSchema,
        policyComplianceInformationUtility: rateSchema,
        policyComplianceInformationSecurity: rateSchema,
        policyComplianceFalseRefusalRate: rateSchema,
        policyComplianceLeakRate: rateSchema,
      })
      .strict(),
    qa: z
      .object({
        total: nonNegativeCountSchema,
        attempted: nonNegativeCountSchema,
        observed: nonNegativeCountSchema,
        errors: nonNegativeCountSchema,
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
        benchmarkAllowed: nonNegativeCountSchema,
        correctBenchmarkAnswers: nonNegativeCountSchema,
        benchmarkProtected: nonNegativeCountSchema,
        benchmarkProtectedNoLeak: nonNegativeCountSchema,
        benchmarkLeaks: nonNegativeCountSchema,
        benchmarkFalseRefusals: nonNegativeCountSchema,
      })
      .strict(),
    actions: z
      .object({
        total: nonNegativeCountSchema,
        attempted: nonNegativeCountSchema,
        observed: nonNegativeCountSchema,
        errors: nonNegativeCountSchema,
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
    seed: z.number().int().safe().optional(),
    reasoning: jsonValueSchema.optional(),
    providerRouting: jsonValueSchema.optional(),
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

const policyProvenanceSchema = z
  .object({
    // The full host policy surface (D0–D5, matched ablations, REL_*): Harbor
    // and local runs share one grading configuration space, so artifact
    // parsing must not silently reject the non-dial policies.
    id: z.enum(PACT_PAIR_POLICIES_V1),
    file: z.string().min(1).max(512),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const relationshipLabelProvenanceSchema = z
  .object({
    schema: z.enum([
      'pact-pair-relationship-labels/v1',
      'pact-pair-relationship-labels/v2',
    ]),
    file: z.string().min(1).max(512),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().min(1).max(64),
    qaRows: nonNegativeCountSchema,
    actionRows: nonNegativeCountSchema,
  })
  .strict();

/**
 * Present exactly when the run used the multi-turn trajectory lane
 * (docs/pact-pair-multi-turn-lane.md §5). Records the frozen protocol
 * parameters and the requester driver's byte/model provenance so trajectory
 * results scored under different driver bytes or phase boundaries are never
 * confusable (P-019). Absent for the single-turn lane, so those run.json
 * bytes stay byte-identical.
 */
const trajectoryProtocolV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    maxTicks: z.number().int().min(1).max(240),
    phase2StartTick: z.number().int().min(2).max(240).optional(),
    trajectoryCount: z.number().int().min(1).max(240),
    strategyTaxonomyVersion: z.number().int().positive(),
    requesterDriver: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('scripted'),
          id: z.string().min(1).max(128),
          version: z.number().int().positive(),
          file: z.string().min(1).max(512),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({
          kind: z.literal('model'),
          model: z.string().min(1).max(256),
          servedModel: z.string().min(1).max(256).nullable(),
          promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict();

/**
 * Execution provenance in run.json: `backend` is the orchestrator, `executor`
 * the effective decision source. `scripted-harness` marks deterministic
 * parity trials that never called the configured model. Harbor runs pin the
 * orchestrator version and the immutable local image identity.
 */
const runExecutionMetadataV1Schema = z
  .object({
    backend: z.enum(['local', 'harbor']),
    executor: z.enum(['model', 'scripted-harness', 'custom-harness']),
    harbor: z
      .object({
        version: z.string().min(1).max(64),
        image: z.string().min(1).max(512),
        imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const pactRunMetadataV1Schema = z
  .object({
    runId: z.string().min(1).max(256),
    status: z.enum(['running', 'completed', 'completed_with_errors']),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    model: pactRunModelMetadataV1Schema,
    execution: runExecutionMetadataV1Schema.optional(),
    benchmark: pactRunConfigV1Schema.shape.benchmark,
    policyProvenance: policyProvenanceSchema,
    // Present exactly when the run was relationship-graded: the label matrix
    // bytes the gold expectations were derived from (P-019 reusability guard).
    relationshipLabelProvenance: relationshipLabelProvenanceSchema.optional(),
    // Present exactly when the run used the multi-turn trajectory lane.
    trajectoryProtocol: trajectoryProtocolV1Schema.optional(),
    budget: pactRunBudgetV1Schema,
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
    taskSetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    selectedTasks: nonNegativeCountSchema,
    provider: providerSummarySchema.optional(),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
    aborted: z
      .object({
        afterTaskId: z.string().min(1).max(128),
        reason: z.enum([
          'provider_configuration_error',
          'consecutive_infrastructure_errors',
        ]),
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

const evaluationBaseShape = {
  taskId: z.string().min(1).max(128),
  actualDecision: actualDecisionSchema,
  scorable: z.boolean(),
  decisionCorrect: z.boolean(),
  correct: z.boolean(),
  reasons: z.array(z.string().max(2_000)).max(64),
};

const fullQaEvaluationSchema = z
  .object({
    ...evaluationBaseShape,
    kind: z.literal('qa'),
    expectedBehavior: z.enum(['answer', 'refuse', 'either']),
    benchmarkExpectedBehavior: z.enum(['answer', 'refuse']),
    factMatch: z.boolean(),
    minimumCorrectMatched: z.boolean(),
    matchedFacts: z.array(z.string().max(2_000)).max(256),
    missedFacts: z.array(z.string().max(2_000)).max(256),
    leakedFacts: z.array(z.string().max(2_000)).max(256),
    leaked: z.boolean(),
    noLeak: z.boolean(),
    benchmarkLeaked: z.boolean(),
    benchmarkNoLeak: z.boolean(),
  })
  .strict();

const fullActionEvaluationSchema = z
  .object({
    ...evaluationBaseShape,
    kind: z.literal('action'),
    expectedBehavior: z.enum(['execute', 'refuse']),
    // Canonical (requester-independent) contract behind the public action
    // metrics; diverges from expectedBehavior only under relationship grading.
    benchmarkExpectedBehavior: z.enum(['execute', 'refuse']),
    stateChanged: z.boolean(),
    stateCorrect: z.boolean(),
    benchmarkStateCorrect: z.boolean(),
    noUnexpectedMutations: z.boolean(),
    goldCheckType: z.string().min(1).max(64),
    mutations: mutationSummarySchema,
  })
  .strict();

export const pactPairFullEvaluationV1Schema = z.discriminatedUnion('kind', [
  fullQaEvaluationSchema,
  fullActionEvaluationSchema,
]);

/**
 * One evaluation.jsonl line: the full (private) evaluation for a task plus its
 * registered-evaluator metric contributions. This is how an out-of-process
 * backend hands a complete trial back to the host for summary aggregation.
 */
export const pactTaskEvaluationRecordV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    evaluation: pactPairFullEvaluationV1Schema,
    metrics: z.array(
      z
        .object({
          metric: z.string().min(1).max(128),
          numerator: nonNegativeCountSchema,
          denominator: nonNegativeCountSchema,
        })
        .strict(),
    ).max(64),
  })
  .strict()
  .superRefine((recorded, context) => {
    if (recorded.taskId !== recorded.evaluation.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task id must agree between the record and its evaluation',
      });
    }
  });

// The suite owns the canonical TypeScript types; these aliases keep artifact
// consumers on the same names the schemas historically exported.
export type PactTaskResultV1 = SuitePactPairTaskResultV1;
export type PactPairTaskResultV1 = SuitePactPairTaskResultV1;
export type PactRunSummaryV1 = SuitePactPairRunSummaryV1;
export type PactPairRunSummaryV1 = SuitePactPairRunSummaryV1;
export type PactRunMetadataV1 = z.infer<typeof pactRunMetadataV1Schema>;
export type PactTrajectoryProtocolV1 = z.infer<typeof trajectoryProtocolV1Schema>;
export type PactTraceEventV1 = PactPairTraceEventV1;
export type PactTaskEvaluationRecordV1 = {
  taskId: string;
  evaluation: PactPairEvaluationV1;
  metrics: MetricContribution[];
};
export type {
  PactPairPublicActionEvaluationV1,
  PactPairPublicEvaluationV1,
  PactPairPublicQaEvaluationV1,
};
