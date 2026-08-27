import path from 'node:path';
import { z } from 'zod';
import {
  MAX_FILE_WORKFLOW_SELECTED_TASKS_V1,
  fileWorkflowCheckpointV1Schema,
  fileWorkflowPublicResultV1Schema,
  fileWorkflowSummaryV1Schema,
  fileWorkflowUsageV1Schema,
} from '../../runner/v1/file-workflow-artifacts.js';
import {
  PACT_PAIR_EVALUATOR_ID_V1,
  PACT_PAIR_EVALUATOR_VERSION_V1,
  PACT_PAIR_METRIC_NAMES_V1,
} from '../../suites/pact-pair/evaluation.js';
import {
  EXPERIMENT_ID_PATTERN_V1,
  MAX_EXPERIMENT_PLAN_CELLS_V1,
  MAX_EXPERIMENT_REPLICATES_V1,
  canonicalExperimentJsonV1,
  experimentCellIdentityInputV1,
  experimentCellV1Schema,
  sha256ExperimentJsonV1,
} from './contracts.js';
import type { ExperimentCellV1 } from './contracts.js';
import {
  assertSingleExperimentBatchV1,
  deriveExperimentRunIdV1,
  nodeExperimentPlanFilesV1,
} from './plan.js';
import type { BoundExperimentCellV1, ExperimentPlanFilesV1 } from './plan.js';

export const EXPERIMENT_CELL_SCORE_API_VERSION_V1 =
  'sharedeval-experiment-cell-score/v1' as const;
export const EXPERIMENT_FINALIZATION_API_VERSION_V1 =
  'sharedeval-experiment-finalization/v1' as const;
export const EXPERIMENT_SCORER_ID_V1 = 'sharedeval-experiment-scorer' as const;
export const EXPERIMENT_SCORER_VERSION_V1 = '1.0.0' as const;
export const EXPERIMENT_CELL_SCORE_FILE_PREFIX_V1 = 'cell-score' as const;
export const EXPERIMENT_FINALIZATION_FILE_PREFIX_V1 = 'experiment-finalization' as const;

// The summary metric set is one ordered contract of 6 fixed metrics followed
// by 4 policyCompliance* metrics. Score and finalize keep the two contracts
// separate so policy-compliance denominators never blend into fixed ones.
export const EXPERIMENT_FIXED_METRIC_NAMES_V1 = Object.freeze(
  PACT_PAIR_METRIC_NAMES_V1.filter(name => !name.startsWith('policyCompliance')),
);
export const EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1 = Object.freeze(
  PACT_PAIR_METRIC_NAMES_V1.filter(name => name.startsWith('policyCompliance')),
);
if (
  EXPERIMENT_FIXED_METRIC_NAMES_V1.length !== 6
  || EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1.length !== 4
  || EXPERIMENT_FIXED_METRIC_NAMES_V1.length
    + EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1.length
    !== PACT_PAIR_METRIC_NAMES_V1.length
) {
  throw new Error('PACT-Pair metric contract no longer splits into 6 fixed + 4 policyCompliance');
}

const EXPERIMENT_TERMINAL_STATUS_KEYS_V1 = [
  'answered',
  'refused',
  'error',
  'no_response',
  'side_effect_before_failure',
] as const;

const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256 digest');
// Mirrors RUN_ID_PATTERN in src/runner/v1/sharedeval-production.ts (not
// exported there; plan.ts mirrors it the same way).
const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const experimentIdSchema = z.string().regex(EXPERIMENT_ID_PATTERN_V1);
const replicateSchema = z.number().int().safe().min(1).max(MAX_EXPERIMENT_REPLICATES_V1);
const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const positiveSafeIntegerSchema = z.number().int().safe().positive();
// Mirrors the unexported status-count and semver schemas in
// src/runner/v1/file-workflow-artifacts.ts.
const semverSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
export const experimentStatusCountsV1Schema = z.object({
  answered: nonNegativeSafeIntegerSchema,
  refused: nonNegativeSafeIntegerSchema,
  error: nonNegativeSafeIntegerSchema,
  no_response: nonNegativeSafeIntegerSchema,
  side_effect_before_failure: nonNegativeSafeIntegerSchema,
}).strict();

export type ExperimentStatusCountsV1 = z.infer<typeof experimentStatusCountsV1Schema>;

const metricNameSchema = z.enum(
  PACT_PAIR_METRIC_NAMES_V1 as unknown as [string, ...string[]],
);

export const experimentMetricAggregateV1Schema = z.object({
  metric: metricNameSchema,
  numerator: nonNegativeSafeIntegerSchema,
  denominator: nonNegativeSafeIntegerSchema,
  value: z.number().finite().min(0).max(1).nullable(),
}).strict().superRefine((metric, context) => {
  if (metric.numerator > metric.denominator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['numerator'],
      message: 'metric numerator cannot exceed denominator',
    });
  }
  const expected = metric.denominator === 0
    ? null
    : metric.numerator / metric.denominator;
  if (metric.value !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'metric value must be null on a zero denominator, else numerator/denominator',
    });
  }
});

export type ExperimentMetricAggregateV1 = z.infer<typeof experimentMetricAggregateV1Schema>;

function orderedMetricsSchema(names: readonly string[]) {
  return z
    .array(experimentMetricAggregateV1Schema)
    .length(names.length)
    .superRefine((metrics, context) => {
      names.forEach((name, index) => {
        if (metrics[index]?.metric !== name) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'metric'],
            message: `metric ${index} must be ${name}`,
          });
        }
      });
    });
}

export const experimentMetricsBlockV1Schema = z.object({
  fixed: orderedMetricsSchema(EXPERIMENT_FIXED_METRIC_NAMES_V1),
  policyCompliance: orderedMetricsSchema(EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1),
}).strict();

export type ExperimentMetricsBlockV1 = z.infer<typeof experimentMetricsBlockV1Schema>;

export const experimentEvaluatorBindingV1Schema = z.object({
  id: z.string().min(1).max(128),
  version: semverSchema,
}).strict();

export const experimentScorerBindingV1Schema = z.object({
  id: z.string().min(1).max(128),
  version: semverSchema,
  scorerConfigDigest: sha256HexSchema,
}).strict();

export const experimentScorerConfigV1Schema = z.object({
  scorerId: z.literal(EXPERIMENT_SCORER_ID_V1).default(EXPERIMENT_SCORER_ID_V1),
  scorerVersion: z.literal(EXPERIMENT_SCORER_VERSION_V1).default(EXPERIMENT_SCORER_VERSION_V1),
  // A committed run that made model calls but recorded zero cost has missing
  // cost telemetry: such a cell is invalid-for-cost, never a free cell.
  costTelemetryRule: z
    .literal('model-calls-require-positive-cost')
    .default('model-calls-require-positive-cost'),
}).strict().default({
  scorerId: EXPERIMENT_SCORER_ID_V1,
  scorerVersion: EXPERIMENT_SCORER_VERSION_V1,
  costTelemetryRule: 'model-calls-require-positive-cost',
});

export type ExperimentScorerConfigV1 = z.infer<typeof experimentScorerConfigV1Schema>;

export function deriveExperimentScorerConfigDigestV1(config?: unknown): string {
  return sha256ExperimentJsonV1(experimentScorerConfigV1Schema.parse(config));
}

const costTelemetrySchema = z.enum(['complete', 'missing']);

function expectedCostTelemetryV1(
  usage: Readonly<{ modelCalls: number; costUsd: number }>,
): 'complete' | 'missing' {
  return usage.modelCalls > 0 && usage.costUsd === 0 ? 'missing' : 'complete';
}

export const experimentCellScoreV1Schema = z.object({
  apiVersion: z.literal(EXPERIMENT_CELL_SCORE_API_VERSION_V1),
  kind: z.literal('ExperimentCellScore'),
  experimentId: experimentIdSchema,
  planDigest: sha256HexSchema,
  cellId: sha256HexSchema,
  runId: runIdSchema,
  replicate: replicateSchema,
  source: z.object({
    runId: runIdSchema,
    configDigest: sha256HexSchema,
    taskSetDigest: sha256HexSchema,
    lastRecordDigest: sha256HexSchema,
    recordCount: positiveSafeIntegerSchema,
  }).strict(),
  evaluator: experimentEvaluatorBindingV1Schema,
  scorer: experimentScorerBindingV1Schema,
  cardinality: z.object({
    selectedTasks: positiveSafeIntegerSchema.max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
    resultRows: positiveSafeIntegerSchema.max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
    evaluationRows: positiveSafeIntegerSchema.max(MAX_FILE_WORKFLOW_SELECTED_TASKS_V1),
  }).strict(),
  statuses: experimentStatusCountsV1Schema,
  metrics: experimentMetricsBlockV1Schema,
  usage: fileWorkflowUsageV1Schema,
  costTelemetry: costTelemetrySchema,
}).strict().superRefine((score, context) => {
  if (score.source.runId !== score.runId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'runId'],
      message: 'score source run must be the scored cell run',
    });
  }
  if (
    score.cardinality.resultRows !== score.cardinality.selectedTasks
    || score.cardinality.evaluationRows !== score.cardinality.selectedTasks
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cardinality'],
      message: 'a scored cell requires exact selected/result/evaluation cardinality',
    });
  }
  const statusTotal = EXPERIMENT_TERMINAL_STATUS_KEYS_V1
    .reduce((total, key) => total + score.statuses[key], 0);
  if (statusTotal !== score.cardinality.resultRows) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['statuses'],
      message: 'status counts must total the result rows',
    });
  }
  if (score.costTelemetry !== expectedCostTelemetryV1(score.usage)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['costTelemetry'],
      message: 'cost telemetry validity must follow the v1 scorer rule',
    });
  }
});

export type ExperimentCellScoreV1 = z.infer<typeof experimentCellScoreV1Schema>;

export const EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1 = Object.freeze({
  missing: ['cell_not_started', 'artifacts_missing'],
  partial: ['run_not_committed', 'result_rows_incomplete'],
  invalid: ['artifact_validation_failed', 'cardinality_mismatch', 'provenance_mismatch'],
  indeterminate: ['indeterminate_external_operation'],
  failed: ['infrastructure_failed', 'model_behavior_terminal'],
} as const);

export type ExperimentOmissionKindV1 = keyof typeof EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1;
export type ExperimentOmissionCauseV1 =
  (typeof EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1)[ExperimentOmissionKindV1][number];

const omissionKindSchema = z.enum(
  Object.keys(EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1) as [
    ExperimentOmissionKindV1,
    ...ExperimentOmissionKindV1[],
  ],
);
const omissionCauseSchema = z.enum(
  Object.values(EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1).flat() as [
    ExperimentOmissionCauseV1,
    ...ExperimentOmissionCauseV1[],
  ],
);

const omissionEntryFieldsV1 = {
  cellId: sha256HexSchema,
  runId: runIdSchema,
  replicate: replicateSchema,
  kind: omissionKindSchema,
  cause: omissionCauseSchema,
  detail: z.string().min(1).max(2_000).optional(),
};

function assertOmissionCausePairV1(
  entry: Readonly<{ kind: ExperimentOmissionKindV1; cause: ExperimentOmissionCauseV1 }>,
  context: z.RefinementCtx,
): void {
  const allowed: readonly string[] = EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1[entry.kind];
  if (!allowed.includes(entry.cause)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cause'],
      message: `cause ${entry.cause} is not a ${entry.kind} cause`,
    });
  }
}

export const experimentCellOmissionV1Schema = z.object({
  planDigest: sha256HexSchema,
  ...omissionEntryFieldsV1,
}).strict().superRefine(assertOmissionCausePairV1);

export type ExperimentCellOmissionV1 = z.infer<typeof experimentCellOmissionV1Schema>;

export const experimentOmissionLedgerEntryV1Schema = z
  .object(omissionEntryFieldsV1)
  .strict()
  .superRefine(assertOmissionCausePairV1);

export type ExperimentOmissionLedgerEntryV1 = z.infer<
  typeof experimentOmissionLedgerEntryV1Schema
>;

// Aggregate usage totals carry no costUsd: cost is accounted separately so a
// cell with missing cost telemetry is marked invalid-for-cost, never zero.
export const experimentUsageTotalsV1Schema = fileWorkflowUsageV1Schema
  .innerType()
  .omit({ costUsd: true })
  .superRefine((usage, context) => {
    if (usage.totalTokens < usage.promptTokens + usage.completionTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalTokens'],
        message: 'totalTokens must cover promptTokens plus completionTokens',
      });
    }
  });

export type ExperimentUsageTotalsV1 = z.infer<typeof experimentUsageTotalsV1Schema>;

export const experimentCellSummaryV1Schema = z.object({
  cellId: sha256HexSchema,
  runId: runIdSchema,
  replicate: replicateSchema,
  statuses: experimentStatusCountsV1Schema,
  metrics: experimentMetricsBlockV1Schema,
  usage: fileWorkflowUsageV1Schema,
  costTelemetry: costTelemetrySchema,
}).strict();

export type ExperimentCellSummaryV1 = z.infer<typeof experimentCellSummaryV1Schema>;

export const experimentFinalizationV1Schema = z.object({
  apiVersion: z.literal(EXPERIMENT_FINALIZATION_API_VERSION_V1),
  kind: z.literal('ExperimentFinalization'),
  experimentId: experimentIdSchema,
  planDigest: sha256HexSchema,
  cells: z.object({
    planned: positiveSafeIntegerSchema.max(MAX_EXPERIMENT_PLAN_CELLS_V1),
    finalized: nonNegativeSafeIntegerSchema,
    omitted: nonNegativeSafeIntegerSchema,
    omittedByKind: z.object({
      missing: nonNegativeSafeIntegerSchema,
      partial: nonNegativeSafeIntegerSchema,
      invalid: nonNegativeSafeIntegerSchema,
      indeterminate: nonNegativeSafeIntegerSchema,
      failed: nonNegativeSafeIntegerSchema,
    }).strict(),
  }).strict(),
  evaluator: experimentEvaluatorBindingV1Schema.nullable(),
  scorer: experimentScorerBindingV1Schema.nullable(),
  statuses: experimentStatusCountsV1Schema,
  metrics: experimentMetricsBlockV1Schema,
  usage: experimentUsageTotalsV1Schema,
  cost: z.object({
    costUsd: z.number().finite().nonnegative(),
    costValidCells: nonNegativeSafeIntegerSchema,
    costInvalidCells: z.array(runIdSchema).max(MAX_EXPERIMENT_PLAN_CELLS_V1),
  }).strict(),
  perCell: z.array(experimentCellSummaryV1Schema).max(MAX_EXPERIMENT_PLAN_CELLS_V1),
  omissionLedger: z
    .array(experimentOmissionLedgerEntryV1Schema)
    .max(MAX_EXPERIMENT_PLAN_CELLS_V1),
}).strict().superRefine((finalization, context) => {
  const { cells } = finalization;
  if (cells.planned !== cells.finalized + cells.omitted) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cells'],
      message: 'planned cells must equal finalized plus omitted cells',
    });
  }
  if (
    finalization.perCell.length !== cells.finalized
    || finalization.omissionLedger.length !== cells.omitted
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cells'],
      message: 'per-cell summaries and omission ledger must cover every planned cell',
    });
  }
  for (const kind of Object.keys(EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1) as
    ExperimentOmissionKindV1[]) {
    const counted = finalization.omissionLedger
      .filter(entry => entry.kind === kind).length;
    if (cells.omittedByKind[kind] !== counted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cells', 'omittedByKind', kind],
        message: `omission kind count must match the ledger (${counted})`,
      });
    }
  }
  if (
    (finalization.evaluator === null) !== (cells.finalized === 0)
    || (finalization.scorer === null) !== (cells.finalized === 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evaluator'],
      message: 'evaluator/scorer bindings are null exactly when no cell finalized',
    });
  }
  const runIds = [
    ...finalization.perCell.map(cell => cell.runId),
    ...finalization.omissionLedger.map(entry => entry.runId),
  ];
  if (new Set(runIds).size !== runIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['perCell'],
      message: 'a cell cannot appear in both the summaries and the omission ledger',
    });
  }
  for (const key of EXPERIMENT_TERMINAL_STATUS_KEYS_V1) {
    const total = finalization.perCell
      .reduce((sum, cell) => sum + cell.statuses[key], 0);
    if (finalization.statuses[key] !== total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['statuses', key],
        message: 'aggregate status counts must equal the per-cell sums',
      });
    }
  }
  for (const block of ['fixed', 'policyCompliance'] as const) {
    finalization.metrics[block].forEach((metric, index) => {
      const numerator = finalization.perCell
        .reduce((sum, cell) => sum + (cell.metrics[block][index]?.numerator ?? 0), 0);
      const denominator = finalization.perCell
        .reduce((sum, cell) => sum + (cell.metrics[block][index]?.denominator ?? 0), 0);
      if (metric.numerator !== numerator || metric.denominator !== denominator) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metrics', block, index],
          message: 'aggregate metrics must equal the per-cell sums',
        });
      }
    });
  }
  for (const key of [
    'modelCalls',
    'toolSteps',
    'contactCalls',
    'promptTokens',
    'completionTokens',
    'totalTokens',
  ] as const) {
    const total = finalization.perCell.reduce((sum, cell) => sum + cell.usage[key], 0);
    if (finalization.usage[key] !== total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usage', key],
        message: 'aggregate usage must equal the per-cell sums',
      });
    }
  }
  const costInvalid = finalization.perCell
    .filter(cell => cell.costTelemetry === 'missing')
    .map(cell => cell.runId);
  if (
    finalization.cost.costValidCells !== cells.finalized - costInvalid.length
    || finalization.cost.costInvalidCells.length !== costInvalid.length
    || finalization.cost.costInvalidCells.some((runId, index) => runId !== costInvalid[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cost'],
      message: 'cost validity accounting must match the per-cell cost telemetry',
    });
  }
  const costUsd = finalization.perCell
    .filter(cell => cell.costTelemetry === 'complete')
    .reduce((sum, cell) => sum + cell.usage.costUsd, 0);
  if (finalization.cost.costUsd !== costUsd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cost', 'costUsd'],
      message: 'aggregate cost must sum only cost-valid cells',
    });
  }
});

export type ExperimentFinalizationV1 = z.infer<typeof experimentFinalizationV1Schema>;

export type ExperimentCellScoreInputV1 = Readonly<{
  cell: BoundExperimentCellV1;
  /** Parsed JSON of the committed run's summary.json. */
  summary: unknown;
  /** Parsed JSON of the committed run's checkpoint.json. */
  checkpoint: unknown;
  /** Parsed rows of the committed run's results.jsonl, in file order. */
  results: readonly unknown[];
  scorerConfig?: unknown;
}>;

function verifyBoundExperimentCellV1(
  bound: BoundExperimentCellV1,
): ExperimentCellV1 {
  if (!EXPERIMENT_ID_PATTERN_V1.test(bound.experimentId)) {
    throw new Error('Bound experiment cell has an invalid experiment id');
  }
  sha256HexSchema.parse(bound.planDigest);
  const definition = experimentCellV1Schema.parse(bound.cell);
  const cellId = sha256ExperimentJsonV1(experimentCellIdentityInputV1(definition));
  if (cellId !== bound.cellId) {
    throw new Error('Bound experiment cell id does not match its cell definition');
  }
  if (definition.replicate !== bound.replicate) {
    throw new Error('Bound experiment cell replicate does not match its cell definition');
  }
  const runId = deriveExperimentRunIdV1(bound.experimentId, cellId, bound.replicate);
  if (runId !== bound.runId) {
    throw new Error('Bound experiment cell run id does not match its cell identity');
  }
  return definition;
}

/**
 * Scores one committed cell from its canonical run artifacts only. The output
 * is a derived artifact bound to the source run authority; the source run is
 * never touched.
 */
export function scoreExperimentCellV1(
  input: ExperimentCellScoreInputV1,
): ExperimentCellScoreV1 {
  const definition = verifyBoundExperimentCellV1(input.cell);
  const summary = fileWorkflowSummaryV1Schema.parse(input.summary);
  const checkpoint = fileWorkflowCheckpointV1Schema.parse(input.checkpoint);
  const results = input.results.map(row => fileWorkflowPublicResultV1Schema.parse(row));

  if (summary.runId !== input.cell.runId || checkpoint.runId !== input.cell.runId) {
    throw new Error('Experiment score artifacts do not belong to the bound cell run');
  }
  const expectedWorkflowId = `files-${definition.workflow.mode}`;
  if (
    summary.workflowId !== expectedWorkflowId
    || checkpoint.workflowId !== expectedWorkflowId
  ) {
    throw new Error('Experiment score artifacts do not match the cell workflow');
  }
  if (checkpoint.status !== 'completed') {
    throw new Error('Experiment score requires a committed (completed) checkpoint');
  }
  if (
    checkpoint.recordCount === 0
    || checkpoint.lastRecordDigest === null
    || checkpoint.lastEventId === null
  ) {
    throw new Error('Experiment score requires committed run record authority');
  }
  if (
    checkpoint.selectedTasks !== summary.selectedTasks
    || checkpoint.resultRows !== summary.resultRows
    || checkpoint.evaluationRows !== summary.evaluationRows
  ) {
    throw new Error('Experiment score checkpoint and summary counts disagree');
  }
  if (
    summary.selectedTasks < 1
    || summary.selectedTasks > MAX_FILE_WORKFLOW_SELECTED_TASKS_V1
    || summary.resultRows !== summary.selectedTasks
    || summary.evaluationRows !== summary.selectedTasks
  ) {
    throw new Error('Experiment score requires exact selected/result/evaluation cardinality');
  }
  if (results.length !== summary.resultRows) {
    throw new Error('Experiment score result rows do not match the summary cardinality');
  }
  const taskIds = results.map(row => row.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Experiment score result rows must have unique task ids');
  }
  for (const row of results) {
    if (row.runId !== input.cell.runId || row.workflowId !== expectedWorkflowId) {
      throw new Error('Experiment score result row does not belong to the cell run');
    }
    if (row.selectedTaskDigest !== definition.provenance.taskSetDigest) {
      throw new Error('Experiment score result rows are not bound to the cell task-set digest');
    }
  }
  for (const key of EXPERIMENT_TERMINAL_STATUS_KEYS_V1) {
    const counted = results.filter(row => row.status === key).length;
    if (summary.statuses[key] !== counted) {
      throw new Error('Experiment score summary statuses disagree with the result rows');
    }
  }

  const metricByName = new Map(summary.metrics.map(metric => [metric.metric, metric]));
  const pickMetrics = (names: readonly string[]): ExperimentMetricAggregateV1[] =>
    names.map(name => {
      const metric = metricByName.get(name as (typeof summary.metrics)[number]['metric']);
      if (!metric) {
        throw new Error(`Experiment score summary is missing metric ${name}`);
      }
      return {
        metric: metric.metric,
        numerator: metric.numerator,
        denominator: metric.denominator,
        value: metric.value,
      };
    });

  const scorerConfig = experimentScorerConfigV1Schema.parse(input.scorerConfig);
  const score: ExperimentCellScoreV1 = {
    apiVersion: EXPERIMENT_CELL_SCORE_API_VERSION_V1,
    kind: 'ExperimentCellScore',
    experimentId: input.cell.experimentId,
    planDigest: input.cell.planDigest,
    cellId: input.cell.cellId,
    runId: input.cell.runId,
    replicate: input.cell.replicate,
    source: {
      runId: input.cell.runId,
      configDigest: definition.provenance.configDigest,
      taskSetDigest: definition.provenance.taskSetDigest,
      lastRecordDigest: checkpoint.lastRecordDigest,
      recordCount: checkpoint.recordCount,
    },
    evaluator: {
      id: PACT_PAIR_EVALUATOR_ID_V1,
      version: PACT_PAIR_EVALUATOR_VERSION_V1,
    },
    scorer: {
      id: scorerConfig.scorerId,
      version: scorerConfig.scorerVersion,
      scorerConfigDigest: sha256ExperimentJsonV1(scorerConfig),
    },
    cardinality: {
      selectedTasks: summary.selectedTasks,
      resultRows: summary.resultRows,
      evaluationRows: summary.evaluationRows,
    },
    statuses: { ...summary.statuses },
    metrics: {
      fixed: pickMetrics(EXPERIMENT_FIXED_METRIC_NAMES_V1),
      policyCompliance: pickMetrics(EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1),
    },
    usage: { ...summary.usage },
    costTelemetry: expectedCostTelemetryV1(summary.usage),
  };
  return experimentCellScoreV1Schema.parse(score);
}

export function serializeExperimentCellScoreV1(score: ExperimentCellScoreV1): string {
  return `${canonicalExperimentJsonV1(experimentCellScoreV1Schema.parse(score))}\n`;
}

export function deriveExperimentCellScoreDigestV1(score: unknown): string {
  return sha256ExperimentJsonV1(experimentCellScoreV1Schema.parse(score));
}

export type WrittenExperimentArtifactV1 = Readonly<{
  filePath: string;
  artifactDigest: string;
}>;

/**
 * Derived artifacts are immutable and content-addressed: the filename embeds
 * the artifact digest, creation is exclusive, and re-writing identical bytes
 * is an idempotent no-op while any divergent existing file is an error. The
 * seam only ever creates new files, so a source run can never be mutated.
 */
async function writeImmutableExperimentArtifactV1(
  directory: string,
  fileName: string,
  serialized: string,
  files: ExperimentPlanFilesV1,
): Promise<string> {
  await files.mkdir(directory);
  const filePath = path.join(directory, fileName);
  try {
    await files.writeFileExclusive(filePath, serialized);
  } catch (error) {
    let existing: string;
    try {
      existing = await files.readFile(filePath);
    } catch {
      throw error;
    }
    if (existing !== serialized) {
      throw new Error('Derived experiment artifact already exists with different content');
    }
  }
  return filePath;
}

export async function writeExperimentCellScoreV1(
  score: ExperimentCellScoreV1,
  directory: string,
  files: ExperimentPlanFilesV1 = nodeExperimentPlanFilesV1(),
): Promise<WrittenExperimentArtifactV1> {
  const parsed = experimentCellScoreV1Schema.parse(score);
  const artifactDigest = sha256ExperimentJsonV1(parsed);
  const filePath = await writeImmutableExperimentArtifactV1(
    directory,
    `${EXPERIMENT_CELL_SCORE_FILE_PREFIX_V1}.${artifactDigest}.json`,
    `${canonicalExperimentJsonV1(parsed)}\n`,
    files,
  );
  return { filePath, artifactDigest };
}

export type FinalizeExperimentInputV1 = Readonly<{
  experimentId: string;
  planDigest: string;
  /** Every cell bound by the published plan, in plan order. */
  cells: readonly BoundExperimentCellV1[];
  /** Finalized cell score artifacts (unknown JSON, validated here). */
  scores: readonly unknown[];
  /** Typed omissions for cells that did not finalize. */
  omissions?: readonly unknown[];
}>;

const AUTO_MISSING_DETAIL_V1 =
  'no score or typed omission was provided for this planned cell';

/**
 * Aggregates exactly one published plan: every planned cell appears either as
 * a finalized per-cell summary or as a typed omission-ledger entry, so no
 * cell can silently vanish from the denominators.
 */
export function finalizeExperimentV1(
  input: FinalizeExperimentInputV1,
): ExperimentFinalizationV1 {
  const experimentId = experimentIdSchema.parse(input.experimentId);
  const planDigest = sha256HexSchema.parse(input.planDigest);
  assertSingleExperimentBatchV1(input.cells);
  const planCellsByRunId = new Map<
    string,
    Readonly<{ bound: BoundExperimentCellV1; definition: ExperimentCellV1 }>
  >();
  for (const bound of input.cells) {
    if (bound.planDigest !== planDigest || bound.experimentId !== experimentId) {
      throw new Error('Experiment finalization plan cells are not bound to the plan');
    }
    planCellsByRunId.set(bound.runId, {
      bound,
      definition: verifyBoundExperimentCellV1(bound),
    });
  }

  const scores = input.scores.map(score => experimentCellScoreV1Schema.parse(score));
  const omissions = (input.omissions ?? [])
    .map(omission => experimentCellOmissionV1Schema.parse(omission));

  const observedPlanDigests = new Set([
    planDigest,
    ...scores.map(score => score.planDigest),
    ...omissions.map(omission => omission.planDigest),
  ]);
  if (observedPlanDigests.size > 1) {
    throw new Error(
      `Experiment finalization mixes cells from ${observedPlanDigests.size} published plans`,
    );
  }

  const scoreByRunId = new Map<string, ExperimentCellScoreV1>();
  const omissionByRunId = new Map<string, ExperimentCellOmissionV1>();
  for (const score of scores) {
    if (score.experimentId !== experimentId) {
      throw new Error('Experiment finalization score belongs to another experiment');
    }
    const planned = planCellsByRunId.get(score.runId);
    if (!planned) {
      throw new Error('Experiment finalization score does not match a planned cell');
    }
    if (scoreByRunId.has(score.runId)) {
      throw new Error('Experiment finalization contains duplicate cell scores');
    }
    if (
      score.cellId !== planned.bound.cellId
      || score.replicate !== planned.bound.replicate
      || score.source.configDigest !== planned.definition.provenance.configDigest
      || score.source.taskSetDigest !== planned.definition.provenance.taskSetDigest
    ) {
      throw new Error('Experiment finalization score is not bound to its planned cell');
    }
    scoreByRunId.set(score.runId, score);
  }
  for (const omission of omissions) {
    const planned = planCellsByRunId.get(omission.runId);
    if (!planned) {
      throw new Error('Experiment finalization omission does not match a planned cell');
    }
    if (
      omission.cellId !== planned.bound.cellId
      || omission.replicate !== planned.bound.replicate
    ) {
      throw new Error('Experiment finalization omission is not bound to its planned cell');
    }
    if (omissionByRunId.has(omission.runId) || scoreByRunId.has(omission.runId)) {
      throw new Error('Experiment finalization covers one cell more than once');
    }
    omissionByRunId.set(omission.runId, omission);
  }

  const evaluatorKeys = new Set(
    scores.map(score => canonicalExperimentJsonV1(score.evaluator)),
  );
  const scorerKeys = new Set(
    scores.map(score => canonicalExperimentJsonV1(score.scorer)),
  );
  if (evaluatorKeys.size > 1 || scorerKeys.size > 1) {
    throw new Error('Experiment finalization mixes evaluator or scorer contracts');
  }

  const perCell: ExperimentCellSummaryV1[] = [];
  const omissionLedger: ExperimentOmissionLedgerEntryV1[] = [];
  for (const bound of input.cells) {
    const score = scoreByRunId.get(bound.runId);
    if (score) {
      perCell.push({
        cellId: score.cellId,
        runId: score.runId,
        replicate: score.replicate,
        statuses: { ...score.statuses },
        metrics: {
          fixed: score.metrics.fixed.map(metric => ({ ...metric })),
          policyCompliance: score.metrics.policyCompliance.map(metric => ({ ...metric })),
        },
        usage: { ...score.usage },
        costTelemetry: score.costTelemetry,
      });
      continue;
    }
    const omission = omissionByRunId.get(bound.runId);
    if (omission) {
      const { planDigest: _planDigest, ...entry } = omission;
      omissionLedger.push(entry);
      continue;
    }
    omissionLedger.push({
      cellId: bound.cellId,
      runId: bound.runId,
      replicate: bound.replicate,
      kind: 'missing',
      cause: 'artifacts_missing',
      detail: AUTO_MISSING_DETAIL_V1,
    });
  }

  const aggregateMetrics = (
    names: readonly string[],
    block: 'fixed' | 'policyCompliance',
  ): ExperimentMetricAggregateV1[] =>
    names.map((name, index) => {
      const numerator = perCell
        .reduce((sum, cell) => sum + (cell.metrics[block][index]?.numerator ?? 0), 0);
      const denominator = perCell
        .reduce((sum, cell) => sum + (cell.metrics[block][index]?.denominator ?? 0), 0);
      return {
        metric: name,
        numerator,
        denominator,
        value: denominator === 0 ? null : numerator / denominator,
      };
    });

  const statuses = Object.fromEntries(
    EXPERIMENT_TERMINAL_STATUS_KEYS_V1.map(key => [
      key,
      perCell.reduce((sum, cell) => sum + cell.statuses[key], 0),
    ]),
  ) as ExperimentStatusCountsV1;
  const usage = Object.fromEntries(
    ([
      'modelCalls',
      'toolSteps',
      'contactCalls',
      'promptTokens',
      'completionTokens',
      'totalTokens',
    ] as const).map(key => [
      key,
      perCell.reduce((sum, cell) => sum + cell.usage[key], 0),
    ]),
  ) as ExperimentUsageTotalsV1;
  const costInvalidCells = perCell
    .filter(cell => cell.costTelemetry === 'missing')
    .map(cell => cell.runId);
  const costUsd = perCell
    .filter(cell => cell.costTelemetry === 'complete')
    .reduce((sum, cell) => sum + cell.usage.costUsd, 0);
  const omittedByKind = Object.fromEntries(
    (Object.keys(EXPERIMENT_OMISSION_CAUSES_BY_KIND_V1) as ExperimentOmissionKindV1[])
      .map(kind => [
        kind,
        omissionLedger.filter(entry => entry.kind === kind).length,
      ]),
  ) as Record<ExperimentOmissionKindV1, number>;

  const [firstScore] = scores;
  const finalization: ExperimentFinalizationV1 = {
    apiVersion: EXPERIMENT_FINALIZATION_API_VERSION_V1,
    kind: 'ExperimentFinalization',
    experimentId,
    planDigest,
    cells: {
      planned: input.cells.length,
      finalized: perCell.length,
      omitted: omissionLedger.length,
      omittedByKind,
    },
    evaluator: firstScore ? { ...firstScore.evaluator } : null,
    scorer: firstScore ? { ...firstScore.scorer } : null,
    statuses,
    metrics: {
      fixed: aggregateMetrics(EXPERIMENT_FIXED_METRIC_NAMES_V1, 'fixed'),
      policyCompliance: aggregateMetrics(
        EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1,
        'policyCompliance',
      ),
    },
    usage,
    cost: {
      costUsd,
      costValidCells: perCell.length - costInvalidCells.length,
      costInvalidCells,
    },
    perCell,
    omissionLedger,
  };
  return experimentFinalizationV1Schema.parse(finalization);
}

export function serializeExperimentFinalizationV1(
  finalization: ExperimentFinalizationV1,
): string {
  return `${canonicalExperimentJsonV1(experimentFinalizationV1Schema.parse(finalization))}\n`;
}

export function deriveExperimentFinalizationDigestV1(finalization: unknown): string {
  return sha256ExperimentJsonV1(experimentFinalizationV1Schema.parse(finalization));
}

export async function writeExperimentFinalizationV1(
  finalization: ExperimentFinalizationV1,
  directory: string,
  files: ExperimentPlanFilesV1 = nodeExperimentPlanFilesV1(),
): Promise<WrittenExperimentArtifactV1> {
  const parsed = experimentFinalizationV1Schema.parse(finalization);
  const artifactDigest = sha256ExperimentJsonV1(parsed);
  const filePath = await writeImmutableExperimentArtifactV1(
    directory,
    `${EXPERIMENT_FINALIZATION_FILE_PREFIX_V1}.${artifactDigest}.json`,
    `${canonicalExperimentJsonV1(parsed)}\n`,
    files,
  );
  return { filePath, artifactDigest };
}
