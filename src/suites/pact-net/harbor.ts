/**
 * PACT-Net's Harbor container path: the dataset runtime descriptor consumed
 * by the shared packager/orchestrator/entrypoint, the strict artifact schemas
 * that re-validate container-produced Net rows across the process/container
 * trust boundary, and the host-side orchestration entry the Net runner
 * dispatches to for `backend: harbor`.
 *
 * The Net artifact schemas live here — next to the suite that owns the
 * canonical types — deliberately: runner/v1/artifacts.ts remains the
 * pair-only schema module, byte-for-byte untouched. Collection reuses the
 * generic pair-proven trust walk (collectHarborDatasetTaskRunsV1): per-task
 * fault isolation, path/duplicate checks, the exactly-one-evaluation rule,
 * gold cross-checks against the host-loaded task, and host recomputation of
 * every metric contribution.
 */
import { z } from 'zod';
import {
  jsonValueSchema,
  pactAnswerDecisionV1Schema,
  pactEscalateDecisionV1Schema,
  pactRefuseDecisionV1Schema,
  pactTaskIntroV1Schema,
} from '../../protocol/v1/index.js';
import { evaluateWithRegisteredEvaluator } from '../../evaluation/index.js';
import {
  PACT_NET_DATASET_ID_V1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import {
  collectHarborDatasetTaskRunsV1,
  runHarborTrialsV1,
  type PactHarborArtifactCollectionV1,
} from '../../runner/v1/backends/harbor-backend.js';
import type { PactHarborDatasetRuntimeV1 } from '../../runner/v1/backends/harbor-task-package.js';
import type { PactRunExecutionMetadataV1 } from '../../runner/v1/backends/execution-backend.js';
import { PACT_NET_EVALUATION_TARGET_V1, pactNetMetricContributionsV1 } from './evaluation.js';
import type { PactNetEvaluationV1, PactNetTerminalDecisionV1 } from './evaluator.js';
import type {
  PactNetSingleTaskRunV1,
  PactNetTaskResultV1,
  PactNetTraceEventV1,
} from './environment.js';
import type { LoadedPactNetTaskV1 } from './task-loader.js';
import { PactNetWorkspaceV1 } from './workspace.js';
import type { PactNetAgentStoreV1 } from './schemas.js';

/**
 * PACT-Net's Harbor dataset runtime: canonical NET task ids, the Net task
 * template, and the entrypoint tokens the template consumes. Requester and
 * gradingMode tokens are intentionally absent — they do not exist for
 * pact-net (the config schema pins them to inert defaults), so the Net
 * solve.sh passes `--dataset pact-net` plus the policy and budgets only.
 */
export const PACT_NET_HARBOR_DATASET_RUNTIME_V1: PactHarborDatasetRuntimeV1 = {
  datasetId: PACT_NET_DATASET_ID_V1,
  // Canonical (normalized) NET ids only, exactly as the dataset publishes
  // them: NET-Q-#### / NET-A-####.
  taskIdPattern: /^NET-[QA]-\d{4}$/,
  templateSegments: ['harbor', 'task-template-net'],
  replacements: ({ config }) => ({
    DATASET: PACT_NET_DATASET_ID_V1,
    POLICY: config.benchmark.policy,
  }),
};

const nonNegativeCountSchema = z.number().int().safe().nonnegative();

const pactNetActualDecisionArtifactV1Schema = z.enum([
  'answer',
  'refuse',
  'escalate',
  'routing_blocked',
  'none',
]);

const pactNetRoutingBlockedDecisionArtifactV1Schema = z
  .object({
    type: z.literal('routing_blocked'),
    reason: z.string().min(1).max(4_096),
  })
  .strict();

/**
 * Net terminal decisions extend the protocol terminal set with the
 * environment-synthesized routing_blocked decision (never producible by a
 * harness — pactDecisionV1Schema has no such variant).
 */
export const pactNetTerminalDecisionArtifactV1Schema = z.discriminatedUnion('type', [
  pactAnswerDecisionV1Schema,
  pactRefuseDecisionV1Schema,
  pactEscalateDecisionV1Schema,
  pactNetRoutingBlockedDecisionArtifactV1Schema,
]);

const pactNetPublicMutationCountsArtifactV1Schema = z
  .object({
    notes: z
      .object({
        created: nonNegativeCountSchema,
        updated: nonNegativeCountSchema,
        removed: nonNegativeCountSchema,
      })
      .strict(),
    todos: z
      .object({
        created: nonNegativeCountSchema,
        updated: nonNegativeCountSchema,
        removed: nonNegativeCountSchema,
      })
      .strict(),
  })
  .strict();

export const pactNetPublicQaEvaluationArtifactV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('qa'),
    actualDecision: pactNetActualDecisionArtifactV1Schema,
    routingBlocked: z.boolean(),
    scorable: z.boolean(),
    correct: z.boolean(),
    judgePending: z.boolean(),
    leakScorable: z.boolean(),
    leaked: z.boolean(),
    noLeak: z.boolean(),
  })
  .strict();

export const pactNetPublicActionEvaluationArtifactV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('action'),
    actualDecision: pactNetActualDecisionArtifactV1Schema,
    routingBlocked: z.boolean(),
    scorable: z.boolean(),
    correct: z.boolean(),
    stateChanged: z.boolean(),
    stateCorrect: z.boolean(),
    mutations: pactNetPublicMutationCountsArtifactV1Schema,
  })
  .strict();

export const pactNetPublicEvaluationArtifactV1Schema = z.discriminatedUnion('kind', [
  pactNetPublicQaEvaluationArtifactV1Schema,
  pactNetPublicActionEvaluationArtifactV1Schema,
]);

// Provider telemetry is host-recorded diagnostic data with a large optional
// surface; the bounded structural check mirrors the pair artifact contract.
// Containerized scripted trials never produce it.
const providerTelemetryArtifactSchema = z
  .object({
    requestedModel: z.string().min(1).max(256),
    requests: z.array(z.record(jsonValueSchema)).max(10_000),
    totals: z.record(jsonValueSchema),
  })
  .passthrough();

const sharedOsIdentityArtifactSchema = z
  .object({
    adapterId: z.string().min(1).max(64),
    protocolVersion: z.string().min(1).max(16),
    status: z.enum(['succeeded', 'denied', 'failed', 'cancelled']),
    traceId: z.string().min(1).max(256),
    latencyMs: z.number().nonnegative(),
  })
  .strict();

/**
 * One results.jsonl row of a containerized Net trial, validated with the same
 * strictness the pair result schema applies before a row re-enters the host
 * run (unknown keys rejected, id/kind agreement, ok rows must carry a public
 * evaluation).
 */
export const pactNetTaskResultArtifactV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.enum(['qa', 'action']),
    status: z.enum(['ok', 'infrastructure_error']),
    publicTask: pactTaskIntroV1Schema,
    routing: z
      .object({
        allowed: z.boolean(),
        rule: z.literal('source-contact-list'),
      })
      .strict(),
    finalDecision: pactNetTerminalDecisionArtifactV1Schema,
    evaluation: pactNetPublicEvaluationArtifactV1Schema.nullable(),
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
    providerTelemetry: providerTelemetryArtifactSchema.optional(),
    violations: z.array(z.string().min(1).max(256)),
    error: z.string().min(1).max(2_000).optional(),
    finalizeError: z.string().min(1).max(2_000).optional(),
    sharedOs: sharedOsIdentityArtifactSchema.optional(),
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

export const pactNetTraceEventArtifactV1Schema = z
  .object({
    at: z.string().datetime({ offset: true }),
    runId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(128).optional(),
    event: z.string().min(1).max(128),
    data: jsonValueSchema,
  })
  .strict();

const netEvaluationBaseShape = {
  taskId: z.string().min(1).max(128),
  category: z.string().min(1).max(128),
  actualDecision: pactNetActualDecisionArtifactV1Schema,
  routingBlocked: z.boolean(),
  scorable: z.boolean(),
  decisionCorrect: z.boolean(),
  correct: z.boolean(),
  reasons: z.array(z.string().max(2_000)).max(64),
};

const netRecordDiffArtifactSchema = z
  .object({
    created: z.array(z.string().min(1).max(2_000)).max(10_000),
    updated: z.array(z.string().min(1).max(2_000)).max(10_000),
    removed: z.array(z.string().min(1).max(2_000)).max(10_000),
  })
  .strict();

const fullNetQaEvaluationArtifactSchema = z
  .object({
    ...netEvaluationBaseShape,
    kind: z.literal('qa'),
    expectedBehavior: z.enum(['answer', 'refuse', 'either', 'blocked']),
    judgePending: z.boolean(),
    leakScorable: z.boolean(),
    matchedSensitiveFacts: z.array(z.string().max(2_000)).max(256),
    leaked: z.boolean(),
    noLeak: z.boolean(),
  })
  .strict();

const fullNetActionEvaluationArtifactSchema = z
  .object({
    ...netEvaluationBaseShape,
    kind: z.literal('action'),
    expectedBehavior: z.enum(['execute', 'refuse']),
    stateChanged: z.boolean(),
    stateCorrect: z.boolean(),
    goldCheckType: z.enum(['note_created', 'todo_completed', 'no_change']),
    mutations: z
      .object({
        notes: netRecordDiffArtifactSchema,
        todos: netRecordDiffArtifactSchema,
      })
      .strict(),
  })
  .strict();

export const pactNetFullEvaluationArtifactV1Schema = z.discriminatedUnion('kind', [
  fullNetQaEvaluationArtifactSchema,
  fullNetActionEvaluationArtifactSchema,
]);

/**
 * One evaluation.jsonl line of a containerized Net trial: the full (private)
 * evaluation plus the container-reported metric contributions, which the host
 * verifies against its own recomputation and then discards.
 */
export const pactNetTaskEvaluationRecordArtifactV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    evaluation: pactNetFullEvaluationArtifactV1Schema,
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

/**
 * Fail-closed gold cross-check: a container cannot re-label its own trial.
 * kind, expectedBehavior, and category must match the host-loaded task
 * (category feeds the metric denominators, so it is load-bearing), and
 * routingBlocked must equal the host routing verdict — the environment is the
 * only source of routing_blocked decisions.
 */
export function assertPactNetEvaluationMatchesHostTaskV1(
  evaluation: PactNetEvaluationV1,
  task: LoadedPactNetTaskV1,
): void {
  if (evaluation.kind !== task.kind) {
    throwPactNetHarborEvaluationMismatchV1(task.taskId, 'kind');
  }
  if (evaluation.expectedBehavior !== task.expectedBehavior) {
    throwPactNetHarborEvaluationMismatchV1(task.taskId, 'expectedBehavior');
  }
  if (evaluation.category !== task.category) {
    throwPactNetHarborEvaluationMismatchV1(task.taskId, 'category');
  }
  if (evaluation.routingBlocked !== !task.routingAllowed) {
    throwPactNetHarborEvaluationMismatchV1(task.taskId, 'routingBlocked');
  }
}

function throwPactNetHarborEvaluationMismatchV1(
  taskId: string,
  field: string,
): never {
  // Collection failures become public backend errors. Do not echo either
  // side of a host/container comparison because both can contain gold.
  throw new Error(`Harbor evaluation mismatch for ${taskId}: ${field}`);
}

/**
 * The PACT-Net artifact collection descriptor for the generic Harbor trust
 * walk. Same shape as the pair descriptor inside harbor-backend.ts.
 */
export const PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1: PactHarborArtifactCollectionV1<
  LoadedPactNetTaskV1,
  PactNetTaskResultV1,
  PactNetTraceEventV1,
  PactNetEvaluationV1
> = {
  resultSchema: {
    parse: value =>
      pactNetTaskResultArtifactV1Schema.parse(value) as PactNetTaskResultV1,
  },
  traceEventSchema: {
    parse: value =>
      pactNetTraceEventArtifactV1Schema.parse(value) as PactNetTraceEventV1,
  },
  evaluationRecordSchema: pactNetTaskEvaluationRecordArtifactV1Schema,
  assertEvaluationMatchesHostTask: assertPactNetEvaluationMatchesHostTaskV1,
  metricContributions: pactNetMetricContributionsV1,
};

/**
 * Canonical infrastructure-error run for a Net task whose Harbor trial
 * produced no valid artifact (pair precedent: buildPactPairBackendErrorRunV1).
 * The evaluation runs on an untouched seed clone, so the row scores exactly
 * like an unobserved trial.
 */
export async function buildPactNetBackendErrorRunV1(options: {
  config: PactRunConfigV1;
  task: LoadedPactNetTaskV1;
  seed: PactNetAgentStoreV1;
  runId: string;
  now: () => Date;
  message: string;
}): Promise<PactNetSingleTaskRunV1> {
  const message = options.message.slice(-2_000) || 'Unknown execution backend error';
  const workspace = new PactNetWorkspaceV1(options.seed);
  const before = workspace.snapshot();
  const after = workspace.snapshot();
  const finalDecision: PactNetTerminalDecisionV1 = {
    type: 'escalate',
    reason: 'The execution backend could not complete this trial.',
  };
  const evaluationResult = await evaluateWithRegisteredEvaluator(
    PACT_NET_EVALUATION_TARGET_V1,
    {
      task: options.task,
      decision: finalDecision,
      before,
      after,
    },
  );
  const evaluation = evaluationResult.details;
  if (!evaluation) {
    throw new Error('PACT-Net evaluator returned no evaluation details');
  }
  const result: PactNetTaskResultV1 = {
    taskId: options.task.taskId,
    kind: options.task.kind,
    status: 'infrastructure_error',
    publicTask: options.task.publicTask,
    routing: {
      allowed: options.task.routingAllowed,
      rule: 'source-contact-list',
    },
    finalDecision,
    evaluation: null,
    budgetUsed: { turns: 0, toolCalls: 0, runtimeMs: 0 },
    toolCalls: [],
    violations: ['backend_error'],
    error: message,
  };
  const trace: PactNetTraceEventV1[] = options.config.output.saveTraces
    ? [{
        at: options.now().toISOString(),
        runId: options.runId,
        taskId: options.task.taskId,
        event: 'backend_error',
        data: { message },
      }]
    : [];
  return { result, trace, evaluation, evaluationResult };
}

export type RunPactNetTasksViaHarborV1Options = {
  config: PactRunConfigV1;
  tasks: LoadedPactNetTaskV1[];
  /** Seed stores keyed by agent id; error fallbacks evaluate against them. */
  stores: Map<string, PactNetAgentStoreV1>;
  runId: string;
  now: () => Date;
  environment: Record<string, string | undefined>;
  repositoryRoot?: string;
  harborExecutable?: string;
  dockerExecutable?: string;
  imageName?: string;
  keepWorkingDirectory?: boolean;
  sharedOsDir?: string;
};

/**
 * Runs the selected Net tasks through the shared Harbor orchestration —
 * version gate, runtime-only credential injection, staged SharedOS image,
 * per-task image tags and task packages, scripted/no-network vs real-model
 * egress narrowing — and collects the trials back through the Net artifact
 * trust boundary. Returns the completed runs in host task order; tasks
 * without a valid collected trial become canonical backend-error rows.
 */
export async function runPactNetTasksViaHarborV1(
  options: RunPactNetTasksViaHarborV1Options,
): Promise<{
  execution: PactRunExecutionMetadataV1;
  taskRuns: PactNetSingleTaskRunV1[];
}> {
  const orchestration = await runHarborTrialsV1({
    ...(options.repositoryRoot === undefined
      ? {}
      : { repositoryRoot: options.repositoryRoot }),
    ...(options.harborExecutable === undefined
      ? {}
      : { harborExecutable: options.harborExecutable }),
    ...(options.dockerExecutable === undefined
      ? {}
      : { dockerExecutable: options.dockerExecutable }),
    ...(options.imageName === undefined ? {} : { imageName: options.imageName }),
    ...(options.keepWorkingDirectory === undefined
      ? {}
      : { keepWorkingDirectory: options.keepWorkingDirectory }),
    ...(options.sharedOsDir === undefined
      ? {}
      : { sharedOsDir: options.sharedOsDir }),
    runtime: PACT_NET_HARBOR_DATASET_RUNTIME_V1,
    config: options.config,
    tasks: options.tasks,
    runId: options.runId,
    environment: options.environment,
    collect: jobsDirectory => collectHarborDatasetTaskRunsV1(
      jobsDirectory,
      options.tasks,
      PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1,
    ),
  });
  const taskRuns: PactNetSingleTaskRunV1[] = [];
  for (const task of options.tasks) {
    const collectedRun = orchestration.taskRuns.get(task.taskId);
    if (collectedRun) {
      taskRuns.push(collectedRun);
      continue;
    }
    const seed = options.stores.get(task.targetAgent);
    if (!seed) {
      throw new Error(
        `PACT-Net task ${task.taskId} targets agent ${task.targetAgent} with no seed store`,
      );
    }
    taskRuns.push(await buildPactNetBackendErrorRunV1({
      config: options.config,
      task,
      seed,
      runId: options.runId,
      now: options.now,
      message: orchestration.failures.get(task.taskId)
        ?? orchestration.missingMessage,
    }));
  }
  return { execution: orchestration.execution, taskRuns };
}
