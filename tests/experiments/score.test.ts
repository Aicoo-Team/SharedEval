import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fileWorkflowSelectedTaskDigestV1,
} from '../../src/runner/v1/file-workflow-artifacts.js';
import { PACT_PAIR_METRIC_NAMES_V1 } from '../../src/suites/pact-pair/evaluation.js';
import {
  deriveExperimentCellIdV1,
  experimentCellV1Schema,
} from '../../src/experiments/v1/contracts.js';
import { deriveExperimentRunIdV1 } from '../../src/experiments/v1/plan.js';
import type {
  BoundExperimentCellV1,
  ExperimentPlanFilesV1,
} from '../../src/experiments/v1/plan.js';
import {
  EXPERIMENT_FIXED_METRIC_NAMES_V1,
  EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1,
  deriveExperimentScorerConfigDigestV1,
  finalizeExperimentV1,
  scoreExperimentCellV1,
  serializeExperimentCellScoreV1,
  serializeExperimentFinalizationV1,
  writeExperimentCellScoreV1,
  writeExperimentFinalizationV1,
} from '../../src/experiments/v1/score.js';
import type {
  ExperimentCellScoreInputV1,
  ExperimentCellScoreV1,
} from '../../src/experiments/v1/score.js';

const EXPERIMENT_ID = 'exp-score-golden';
const PLAN_DIGEST = 'b'.repeat(64);
const OTHER_PLAN_DIGEST = 'e'.repeat(64);
const CONFIG_DIGEST = 'c'.repeat(64);
const LAST_RECORD_DIGEST = 'd'.repeat(64);
const TASK_IDS = ['PAIR-Q-001', 'PAIR-Q-002', 'PAIR-A-003'] as const;
const TASK_SET_DIGEST = fileWorkflowSelectedTaskDigestV1([...TASK_IDS]);

function cellDefinition(
  replicate: number,
  overrides: Readonly<{ taskSetDigest?: string }> = {},
): unknown {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      model: 'deepseek/deepseek-v3.2',
      maxOutputTokens: 4_096,
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      gradingMode: 'category',
      tasks: { kind: 'all' },
    },
    workflow: { mode: 'multi', protocol: 'files', maxTicks: 8, stopWhen: 'all-terminal' },
    budget: { maxToolCalls: 8, maxRuntimeMs: 60_000 },
    replicate,
    provenance: {
      configDigest: CONFIG_DIGEST,
      taskSetDigest: overrides.taskSetDigest ?? TASK_SET_DIGEST,
      sharedosRevision: '3aa07e33999b656a10ace294fd4e41df8cbc318e',
      sharedosRuntimeDigest: 'f'.repeat(64),
    },
  };
}

function boundCell(
  replicate: number,
  overrides: Readonly<{ taskSetDigest?: string }> = {},
  planDigest = PLAN_DIGEST,
): BoundExperimentCellV1 {
  const cell = experimentCellV1Schema.parse(cellDefinition(replicate, overrides));
  const cellId = deriveExperimentCellIdV1(cell);
  return {
    planDigest,
    experimentId: EXPERIMENT_ID,
    cellId,
    runId: deriveExperimentRunIdV1(EXPERIMENT_ID, cellId, replicate),
    replicate,
    cell,
  };
}

type MetricPair = readonly [number, number];

function summaryMetrics(pairs: Readonly<Partial<Record<string, MetricPair>>> = {}) {
  return PACT_PAIR_METRIC_NAMES_V1.map(name => {
    const [numerator, denominator] = pairs[name] ?? [0, 0];
    return {
      metric: name,
      numerator,
      denominator,
      value: denominator === 0 ? null : numerator / denominator,
    };
  });
}

const GOLDEN_METRIC_PAIRS = {
  informationUtility: [1, 2],
  informationSecurity: [2, 2],
  falseRefusalRate: [0, 2],
  leakRate: [0, 2],
  policyComplianceInformationUtility: [1, 2],
  policyComplianceInformationSecurity: [2, 2],
  policyComplianceFalseRefusalRate: [0, 2],
} as const;

function usageFor(costUsd = 0.05) {
  return {
    modelCalls: 6,
    toolSteps: 9,
    contactCalls: 2,
    promptTokens: 1_200,
    completionTokens: 300,
    totalTokens: 1_500,
    costUsd,
  };
}

const GOLDEN_STATUSES = {
  answered: 0,
  refused: 0,
  error: 1,
  no_response: 2,
  side_effect_before_failure: 0,
} as const;

function summaryFor(
  bound: BoundExperimentCellV1,
  options: Readonly<{
    usage?: unknown;
    metrics?: unknown;
    statuses?: unknown;
    runId?: string;
  }> = {},
): unknown {
  return {
    apiVersion: 'sharedeval-file-summary/v1',
    workflowId: 'files-multi',
    runId: options.runId ?? bound.runId,
    selectedTasks: TASK_IDS.length,
    resultRows: TASK_IDS.length,
    evaluationRows: TASK_IDS.length,
    statuses: options.statuses ?? { ...GOLDEN_STATUSES },
    metrics: options.metrics ?? summaryMetrics(GOLDEN_METRIC_PAIRS),
    usage: options.usage ?? usageFor(),
  };
}

function checkpointFor(
  bound: BoundExperimentCellV1,
  status: 'running' | 'completed' = 'completed',
): unknown {
  return {
    apiVersion: 'sharedeval-file-checkpoint/v1',
    workflowId: 'files-multi',
    runId: bound.runId,
    status,
    recordCount: 7,
    selectedTasks: TASK_IDS.length,
    resultRows: TASK_IDS.length,
    evaluationRows: TASK_IDS.length,
    lastEventId: 'evt-7',
    lastRecordDigest: LAST_RECORD_DIGEST,
  };
}

function resultRowsFor(bound: BoundExperimentCellV1): Record<string, unknown>[] {
  return TASK_IDS.map((taskId, index) => {
    const status = index === TASK_IDS.length - 1 ? 'error' : 'no_response';
    return {
      apiVersion: 'sharedeval-file-result/v1',
      workflowId: 'files-multi',
      runId: bound.runId,
      sessionId: 'session-1',
      taskId,
      kind: 'qa',
      status,
      terminalTick: 3,
      ...(status === 'error' ? { errorCode: 'FILE_TURN_FAILED' } : {}),
      publicEvaluation: null,
      selectedTaskDigest: TASK_SET_DIGEST,
      backend: { adapterId: 'sharedos-files', executor: 'sharedos' },
    };
  });
}

function scoreInput(
  bound: BoundExperimentCellV1,
  overrides: Readonly<Partial<Omit<ExperimentCellScoreInputV1, 'cell'>>> = {},
): ExperimentCellScoreInputV1 {
  return {
    cell: bound,
    summary: overrides.summary ?? summaryFor(bound),
    checkpoint: overrides.checkpoint ?? checkpointFor(bound),
    results: overrides.results ?? resultRowsFor(bound),
  };
}

function memoryFiles(): Readonly<{
  files: ExperimentPlanFilesV1;
  stored: Map<string, string>;
}> {
  const stored = new Map<string, string>();
  const files: ExperimentPlanFilesV1 = {
    async mkdir() {},
    async readFile(filePath) {
      const value = stored.get(filePath);
      if (value === undefined) throw new Error('missing file');
      return value;
    },
    async writeFileExclusive(filePath, contents) {
      if (stored.has(filePath)) throw new Error('file already exists');
      stored.set(filePath, contents);
    },
  };
  return { files, stored };
}

test('scores a committed cell and binds the derived artifact to its sources', () => {
  const bound = boundCell(1);
  const score = scoreExperimentCellV1(scoreInput(bound));

  assert.equal(score.apiVersion, 'sharedeval-experiment-cell-score/v1');
  assert.equal(score.experimentId, EXPERIMENT_ID);
  assert.equal(score.planDigest, PLAN_DIGEST);
  assert.equal(score.cellId, bound.cellId);
  assert.equal(score.runId, bound.runId);
  assert.deepEqual(score.source, {
    runId: bound.runId,
    configDigest: CONFIG_DIGEST,
    taskSetDigest: TASK_SET_DIGEST,
    lastRecordDigest: LAST_RECORD_DIGEST,
    recordCount: 7,
  });
  assert.deepEqual(score.evaluator, { id: 'pact-pair', version: '1.0.0' });
  assert.equal(score.scorer.id, 'sharedeval-experiment-scorer');
  assert.equal(score.scorer.scorerConfigDigest, deriveExperimentScorerConfigDigestV1());
  assert.deepEqual(score.cardinality, {
    selectedTasks: 3,
    resultRows: 3,
    evaluationRows: 3,
  });
  assert.deepEqual(score.statuses, { ...GOLDEN_STATUSES });
  assert.deepEqual(
    score.metrics.fixed.map(metric => metric.metric),
    [...EXPERIMENT_FIXED_METRIC_NAMES_V1],
  );
  assert.deepEqual(
    score.metrics.policyCompliance.map(metric => metric.metric),
    [...EXPERIMENT_POLICY_COMPLIANCE_METRIC_NAMES_V1],
  );
  assert.equal(score.metrics.fixed[0]?.value, 0.5);
  // Zero-denominator metrics stay null all the way through the derived artifact.
  assert.equal(score.metrics.fixed[2]?.value, null);
  assert.equal(score.metrics.policyCompliance[3]?.value, null);
  assert.equal(score.costTelemetry, 'complete');

  // Same input, byte-identical derived artifact.
  const again = scoreExperimentCellV1(scoreInput(bound));
  assert.equal(serializeExperimentCellScoreV1(score), serializeExperimentCellScoreV1(again));
});

test('marks cells with missing cost telemetry invalid-for-cost, never zero-cost', () => {
  const bound = boundCell(1);
  const missing = scoreExperimentCellV1(
    scoreInput(bound, { summary: summaryFor(bound, { usage: usageFor(0) }) }),
  );
  assert.equal(missing.costTelemetry, 'missing');

  const idle = scoreExperimentCellV1(
    scoreInput(bound, {
      summary: summaryFor(bound, {
        usage: {
          modelCalls: 0,
          toolSteps: 0,
          contactCalls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      }),
    }),
  );
  assert.equal(idle.costTelemetry, 'complete');
});

test('rejects non-committed and cardinality-violating source artifacts', () => {
  const bound = boundCell(1);

  assert.throws(
    () => scoreExperimentCellV1(scoreInput(bound, { checkpoint: checkpointFor(bound, 'running') })),
    /committed/,
  );

  const duplicated = resultRowsFor(bound);
  duplicated[1] = { ...duplicated[1], taskId: TASK_IDS[0] };
  assert.throws(
    () => scoreExperimentCellV1(scoreInput(bound, { results: duplicated })),
    /unique task ids/,
  );

  assert.throws(
    () => scoreExperimentCellV1(scoreInput(bound, { results: resultRowsFor(bound).slice(0, 2) })),
    /result rows do not match/,
  );

  assert.throws(
    () => scoreExperimentCellV1(scoreInput(bound, {
      summary: summaryFor(bound, {
        statuses: {
          answered: 0,
          refused: 0,
          error: 0,
          no_response: 3,
          side_effect_before_failure: 0,
        },
      }),
    })),
    /statuses disagree/,
  );

  const other = boundCell(2);
  assert.throws(
    () => scoreExperimentCellV1(scoreInput(bound, { summary: summaryFor(other) })),
    /do not belong/,
  );

  const rebased = boundCell(1, { taskSetDigest: 'a'.repeat(64) });
  assert.throws(
    () => scoreExperimentCellV1(scoreInput(rebased)),
    /task-set digest/,
  );

  const tampered: BoundExperimentCellV1 = { ...bound, cellId: '9'.repeat(64) };
  assert.throws(
    () => scoreExperimentCellV1(scoreInput(tampered)),
    /cell id does not match/,
  );
});

test('score artifact writes are content-addressed, idempotent, and immutable', async () => {
  const bound = boundCell(1);
  const score = scoreExperimentCellV1(scoreInput(bound));
  const { files, stored } = memoryFiles();

  const first = await writeExperimentCellScoreV1(score, '/derived', files);
  assert.match(first.filePath, new RegExp(`cell-score\\.${first.artifactDigest}\\.json$`));
  const second = await writeExperimentCellScoreV1(score, '/derived', files);
  assert.equal(second.filePath, first.filePath);
  assert.equal(second.artifactDigest, first.artifactDigest);
  assert.equal(stored.size, 1);
  assert.equal(stored.get(first.filePath), serializeExperimentCellScoreV1(score));

  stored.set(first.filePath, 'tampered');
  await assert.rejects(
    writeExperimentCellScoreV1(score, '/derived', files),
    /already exists with different content/,
  );
});

function goldenFinalizationFixture(): Readonly<{
  cells: BoundExperimentCellV1[];
  scores: ExperimentCellScoreV1[];
  omissions: Record<string, unknown>[];
}> {
  const cells = [1, 2, 3, 4, 5, 6, 7].map(replicate => boundCell(replicate));
  const scoreComplete = scoreExperimentCellV1(scoreInput(cells[0]!));
  const scoreCostMissing = scoreExperimentCellV1(scoreInput(cells[1]!, {
    summary: summaryFor(cells[1]!, {
      usage: usageFor(0),
      metrics: summaryMetrics({
        informationUtility: [2, 2],
        policyComplianceLeakRate: [1, 2],
      }),
      statuses: {
        answered: 0,
        refused: 0,
        error: 1,
        no_response: 2,
        side_effect_before_failure: 0,
      },
    }),
  }));
  const omission = (
    index: number,
    kind: string,
    cause: string,
    detail?: string,
  ): Record<string, unknown> => ({
    planDigest: PLAN_DIGEST,
    cellId: cells[index]!.cellId,
    runId: cells[index]!.runId,
    replicate: cells[index]!.replicate,
    kind,
    cause,
    ...(detail === undefined ? {} : { detail }),
  });
  return {
    cells,
    scores: [scoreComplete, scoreCostMissing],
    omissions: [
      omission(2, 'partial', 'run_not_committed'),
      omission(3, 'invalid', 'artifact_validation_failed', 'summary.json failed schema validation'),
      omission(4, 'indeterminate', 'indeterminate_external_operation'),
      omission(5, 'failed', 'model_behavior_terminal'),
      // cells[6] intentionally uncovered: it must surface as a typed missing entry.
    ],
  };
}

test('finalizes one plan with every omission type explicit in the ledger', async () => {
  const { cells, scores, omissions } = goldenFinalizationFixture();
  const finalization = finalizeExperimentV1({
    experimentId: EXPERIMENT_ID,
    planDigest: PLAN_DIGEST,
    cells,
    scores,
    omissions,
  });

  assert.deepEqual(finalization.cells, {
    planned: 7,
    finalized: 2,
    omitted: 5,
    omittedByKind: { missing: 1, partial: 1, invalid: 1, indeterminate: 1, failed: 1 },
  });
  assert.deepEqual(finalization.evaluator, { id: 'pact-pair', version: '1.0.0' });
  assert.equal(finalization.scorer?.scorerConfigDigest, deriveExperimentScorerConfigDigestV1());

  // Ledger in plan order; the uncovered cell is explicit, never silently dropped.
  assert.deepEqual(
    finalization.omissionLedger.map(entry => [entry.runId, entry.kind, entry.cause]),
    [
      [cells[2]!.runId, 'partial', 'run_not_committed'],
      [cells[3]!.runId, 'invalid', 'artifact_validation_failed'],
      [cells[4]!.runId, 'indeterminate', 'indeterminate_external_operation'],
      [cells[5]!.runId, 'failed', 'model_behavior_terminal'],
      [cells[6]!.runId, 'missing', 'artifacts_missing'],
    ],
  );

  assert.deepEqual(finalization.perCell.map(cell => cell.runId), [
    cells[0]!.runId,
    cells[1]!.runId,
  ]);
  assert.deepEqual(finalization.statuses, {
    answered: 0,
    refused: 0,
    error: 2,
    no_response: 4,
    side_effect_before_failure: 0,
  });

  const fixedByName = new Map(
    finalization.metrics.fixed.map(metric => [metric.metric, metric]),
  );
  assert.deepEqual(fixedByName.get('informationUtility'), {
    metric: 'informationUtility',
    numerator: 3,
    denominator: 4,
    value: 0.75,
  });
  assert.deepEqual(fixedByName.get('informationSecurity'), {
    metric: 'informationSecurity',
    numerator: 2,
    denominator: 2,
    value: 1,
  });
  // Fixed and policyCompliance contracts stay separate; zero denominators stay null.
  assert.deepEqual(fixedByName.get('actionUtility'), {
    metric: 'actionUtility',
    numerator: 0,
    denominator: 0,
    value: null,
  });
  const policyByName = new Map(
    finalization.metrics.policyCompliance.map(metric => [metric.metric, metric]),
  );
  assert.deepEqual(policyByName.get('policyComplianceLeakRate'), {
    metric: 'policyComplianceLeakRate',
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.deepEqual(policyByName.get('policyComplianceInformationUtility'), {
    metric: 'policyComplianceInformationUtility',
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });

  assert.deepEqual(finalization.usage, {
    modelCalls: 12,
    toolSteps: 18,
    contactCalls: 4,
    promptTokens: 2_400,
    completionTokens: 600,
    totalTokens: 3_000,
  });
  // The cost-invalid cell is excluded from cost, not counted as free.
  assert.deepEqual(finalization.cost, {
    costUsd: 0.05,
    costValidCells: 1,
    costInvalidCells: [cells[1]!.runId],
  });

  const { files, stored } = memoryFiles();
  const written = await writeExperimentFinalizationV1(finalization, '/derived', files);
  assert.equal(stored.get(written.filePath), serializeExperimentFinalizationV1(finalization));
});

test('finalizes an all-omitted plan without evaluator/scorer bindings', () => {
  const cells = [boundCell(1), boundCell(2)];
  const finalization = finalizeExperimentV1({
    experimentId: EXPERIMENT_ID,
    planDigest: PLAN_DIGEST,
    cells,
    scores: [],
  });
  assert.equal(finalization.cells.finalized, 0);
  assert.equal(finalization.evaluator, null);
  assert.equal(finalization.scorer, null);
  assert.deepEqual(
    finalization.omissionLedger.map(entry => [entry.kind, entry.cause]),
    [['missing', 'artifacts_missing'], ['missing', 'artifacts_missing']],
  );
  assert.deepEqual(finalization.cost, { costUsd: 0, costValidCells: 0, costInvalidCells: [] });
});

test('finalization is deterministic byte-for-byte', () => {
  const { cells, scores, omissions } = goldenFinalizationFixture();
  const input = { experimentId: EXPERIMENT_ID, planDigest: PLAN_DIGEST, cells, scores, omissions };
  assert.equal(
    serializeExperimentFinalizationV1(finalizeExperimentV1(input)),
    serializeExperimentFinalizationV1(finalizeExperimentV1(input)),
  );
});

test('rejects mixed plans, duplicate coverage, and unknown cells', () => {
  const { cells, scores, omissions } = goldenFinalizationFixture();

  const foreignBound = boundCell(1, {}, OTHER_PLAN_DIGEST);
  const foreignScore = scoreExperimentCellV1(scoreInput(foreignBound));
  assert.throws(
    () => finalizeExperimentV1({
      experimentId: EXPERIMENT_ID,
      planDigest: PLAN_DIGEST,
      cells,
      scores: [foreignScore],
      omissions: [],
    }),
    /mixes cells from 2 published plans/,
  );

  assert.throws(
    () => finalizeExperimentV1({
      experimentId: EXPERIMENT_ID,
      planDigest: PLAN_DIGEST,
      cells,
      scores,
      omissions: [{ ...omissions[0], planDigest: OTHER_PLAN_DIGEST }],
    }),
    /mixes cells from 2 published plans/,
  );

  const duplicateOmission = {
    planDigest: PLAN_DIGEST,
    cellId: cells[0]!.cellId,
    runId: cells[0]!.runId,
    replicate: cells[0]!.replicate,
    kind: 'failed',
    cause: 'infrastructure_failed',
  };
  assert.throws(
    () => finalizeExperimentV1({
      experimentId: EXPERIMENT_ID,
      planDigest: PLAN_DIGEST,
      cells,
      scores,
      omissions: [...omissions, duplicateOmission],
    }),
    /more than once/,
  );

  const unknown = boundCell(9);
  assert.throws(
    () => finalizeExperimentV1({
      experimentId: EXPERIMENT_ID,
      planDigest: PLAN_DIGEST,
      cells,
      scores,
      omissions: [...omissions, {
        planDigest: PLAN_DIGEST,
        cellId: unknown.cellId,
        runId: unknown.runId,
        replicate: unknown.replicate,
        kind: 'missing',
        cause: 'cell_not_started',
      }],
    }),
    /does not match a planned cell/,
  );

  assert.throws(
    () => finalizeExperimentV1({
      experimentId: EXPERIMENT_ID,
      planDigest: PLAN_DIGEST,
      cells,
      scores,
      omissions: [...omissions, {
        planDigest: PLAN_DIGEST,
        cellId: cells[6]!.cellId,
        runId: cells[6]!.runId,
        replicate: cells[6]!.replicate,
        kind: 'missing',
        cause: 'indeterminate_external_operation',
      }],
    }),
    /not a missing cause/,
  );
});

test('rejects mixed evaluator or scorer contracts', () => {
  const { cells, scores, omissions } = goldenFinalizationFixture();
  const divergent: ExperimentCellScoreV1 = {
    ...scores[1]!,
    scorer: { ...scores[1]!.scorer, scorerConfigDigest: '9'.repeat(64) },
  };
  assert.throws(
    () => finalizeExperimentV1({
      experimentId: EXPERIMENT_ID,
      planDigest: PLAN_DIGEST,
      cells,
      scores: [scores[0]!, divergent],
      omissions,
    }),
    /mixes evaluator or scorer contracts/,
  );
});
