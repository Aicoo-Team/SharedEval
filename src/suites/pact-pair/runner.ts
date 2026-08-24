import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvaluationResults } from '../../evaluation/index.js';
import type { PairDataStore } from './schemas.js';
import {
  pactRunConfigV1Schema,
  selectedPactExecutionBackendV1,
  selectedPactTrajectoryV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import {
  createOpenAICompatiblePactHarnessV1,
} from '../../runner/v1/model-adapter.js';
import {
  HarborBackendV1,
  LocalBackendV1,
  type ExecutionBackendV1,
  type PactRunExecutionMetadataV1,
} from '../../runner/v1/backends/index.js';
import { loadPactPairTasksV1 } from './task-loader.js';
import {
  loadPactPairRelationshipLabelSetV2,
  type PactPairRelationshipLabelProvenanceV1,
} from './relationship-labels.js';
import { loadCanonicalPactPairStoreV1 } from './workspace.js';
import type {
  PactAdapterFactoryV1,
  PactHarnessFactoryV1,
  PactPairSingleTaskRunV1,
  PactPairTaskResultV1,
} from './environment.js';
import type {
  PactPairActionEvaluationV1,
  PactPairQaEvaluationV1,
} from './evaluator.js';
import { PACT_PAIR_METRIC_NAMES_V1 } from './evaluation.js';
import {
  getPactPolicySha256V1,
  PACT_POLICY_FILES_V1,
} from './prompt.js';

// Compatibility re-exports: these lived in this module before the execution
// backend seam extracted the per-task engine into environment.ts.
export {
  buildPactPairBackendErrorRunV1,
  intersectBoundaryPlans,
  runSinglePactPairTaskV1,
  toPublicEvaluation,
} from './environment.js';
export type {
  PactAdapterFactoryV1,
  PactHarnessFactoryV1,
  PactPairPublicActionEvaluationV1,
  PactPairPublicEvaluationV1,
  PactPairPublicQaEvaluationV1,
  PactPairSingleTaskRunV1,
  PactPairTaskResultV1,
  PactPairToolCallRecordV1,
  PactPairTraceEventV1,
} from './environment.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Private-artifact contract for a run output directory.
 *
 * Public artifacts (the output directory root) never contain gold labels,
 * gold facts, or raw workspace content: `run.json`, `summary.json`,
 * `results.jsonl`, and `checkpoint.json` carry only the public result shape.
 *
 * Everything derived from private gold — the full evaluation records
 * (`evaluation.jsonl`) and the raw traces (`trace.jsonl`) — lives under the
 * `private/` subdirectory and is written only when `output.saveTraces` is
 * true. With `saveTraces: false` no gold-bearing artifact is persisted at all.
 */
export const PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1 = 'private' as const;
export const PACT_PUBLIC_RUN_ARTIFACTS_V1 = [
  'run.json',
  'summary.json',
  'results.jsonl',
  'checkpoint.json',
] as const;

export type PactPairRunSummaryV1 = {
  total: number;
  attempted: number;
  observed: number;
  scorable: number;
  correct: number;
  errors: number;
  violations: number;
  provider: {
    requests: number;
    successfulRequests: number;
    invalidResponses: number;
    failedRequests: number;
    httpAttempts: number;
    usageRecords: number;
    costRecords: number;
    usageComplete: boolean;
    costComplete: boolean;
    servedModels: string[];
    providers: string[];
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    costUsd?: number;
  };
  metrics: {
    /**
     * The three information metrics below use the fixed submitted-D2 category
     * split so every policy is evaluated on identical utility/security sets.
     */
    informationUtility: PactRateV1;
    informationSecurity: PactRateV1;
    actionUtility: PactRateV1;
    actionSafety: PactRateV1;
    falseRefusalRate: PactRateV1;
    leakRate: PactRateV1;
    /**
     * These retain active-policy compliance semantics. They can be null for a
     * policy with no tasks labelled refuse (for example D0).
     */
    policyComplianceInformationUtility: PactRateV1;
    policyComplianceInformationSecurity: PactRateV1;
    policyComplianceFalseRefusalRate: PactRateV1;
    policyComplianceLeakRate: PactRateV1;
  };
  qa: {
    total: number;
    attempted: number;
    observed: number;
    errors: number;
    scorable: number;
    correct: number;
    expectedAnswer: number;
    correctAnswers: number;
    expectedRefuse: number;
    safeRefusals: number;
    protectedNoLeak: number;
    leaks: number;
    falseRefusals: number;
    borderline: number;
    benchmarkAllowed: number;
    correctBenchmarkAnswers: number;
    benchmarkProtected: number;
    benchmarkProtectedNoLeak: number;
    benchmarkLeaks: number;
    benchmarkFalseRefusals: number;
  };
  actions: {
    total: number;
    attempted: number;
    observed: number;
    errors: number;
    correct: number;
    expectedExecute: number;
    correctExecutions: number;
    expectedRefuse: number;
    safeRefusals: number;
    safeNoMutation: number;
    unsafeMutations: number;
  };
};

export type PactRateV1 = {
  numerator: number;
  denominator: number;
  value: number | null;
};

type PactOpenAICompatibleModelSectionV1 = Extract<
  PactRunConfigV1['model'],
  { provider: 'openai-compatible' }
>;

export type PactPairRunModelMetadataV1 =
  | {
      provider: 'openai-compatible';
      baseUrl: string;
      model: string;
      temperature?: number;
      seed?: number;
      reasoning?: PactOpenAICompatibleModelSectionV1['reasoning'];
      providerRouting?: PactOpenAICompatibleModelSectionV1['providerRouting'];
      maxOutputTokens: number;
    }
  | {
      provider: 'azure-openai';
      endpoint: string;
      deployment: string;
      apiVersion?: string;
      temperature?: number;
      maxOutputTokens: number;
    };

export type PactPairRunResultV1 = {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'completed_with_errors';
  selectedTasks: number;
  model: PactPairRunModelMetadataV1;
  /**
   * Execution provenance: which backend orchestrated the trials and which
   * effective executor produced the decisions. `model` above records the
   * caller-requested model configuration; when `execution.executor` is not
   * 'model' the trials were NOT produced by that model.
   */
  execution: PactRunExecutionMetadataV1;
  benchmark: PactRunConfigV1['benchmark'];
  policyProvenance: {
    id: PactRunConfigV1['benchmark']['policy'];
    file: string;
    sha256: string;
  };
  /**
   * Provenance of the relationship label matrix that conditioned this run's
   * gold expectations. Present exactly when `benchmark.gradingMode` is
   * `relationship`; category runs omit it so their `run.json` stays
   * byte-identical. Recording the file hash keeps scoring changes visible:
   * results produced against different label bytes are never confusable
   * (team position P-019).
   */
  relationshipLabelProvenance?: PactPairRelationshipLabelProvenanceV1;
  budget: PactRunConfigV1['budget'];
  configDigest: string;
  taskSetDigest: string;
  sourceRevision?: string;
  aborted?: {
    afterTaskId: string;
    reason: 'provider_configuration_error' | 'consecutive_infrastructure_errors';
  };
  outputDirectory?: string;
  summary: PactPairRunSummaryV1;
  tasks: PactPairTaskResultV1[];
};

export type RunPactPairBenchmarkV1Options = {
  harnessFactory?: PactHarnessFactoryV1;
  /** @deprecated Use harnessFactory. */
  adapterFactory?: PactAdapterFactoryV1;
  executionBackend?: ExecutionBackendV1;
  /**
   * Label for the effective decision source recorded in run artifacts.
   * Defaults to 'custom-harness' when a harnessFactory/adapterFactory is
   * injected and 'model' otherwise; backends may override it (the Harbor
   * backend always reports its scripted parity harness).
   */
  executor?: PactRunExecutionMetadataV1['executor'];
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  runId?: string;
  rootDir?: string;
  workingDirectory?: string;
  seed?: PairDataStore;
  writeOutputs?: boolean;
};

export async function runPactPairBenchmarkV1(
  config: PactRunConfigV1,
  options: RunPactPairBenchmarkV1Options = {},
): Promise<PactPairRunResultV1> {
  // Resolved configs may carry loader-only path metadata. Reconstruct the
  // public config shape so the strict schema can validate and clone it while
  // keeping machine-local paths out of the reproducibility digest.
  const runConfig = pactRunConfigV1Schema.parse({
    apiVersion: config.apiVersion,
    kind: config.kind,
    ...(config.backend ? { backend: config.backend } : {}),
    model: config.model,
    benchmark: config.benchmark,
    budget: config.budget,
    output: config.output,
  });
  if (selectedPactTrajectoryV1(runConfig)) {
    // Config-schema scaffolding for the multi-turn lane landed ahead of the
    // tick loop. Fail closed rather than silently running single-turn under
    // a trajectory config (docs/pact-pair-multi-turn-lane.md §8, phase 1).
    throw new Error(
      'benchmark.trajectory is scaffolded but the trajectory lane is not yet '
      + 'implemented; remove the block to run the single-turn lane',
    );
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = options.runId
    ?? `pact-${startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const rootDir = options.rootDir ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const tasks = loadPactPairTasksV1({
    rootDir,
    policy: runConfig.benchmark.policy,
    requester: runConfig.benchmark.requester,
    gradingMode: runConfig.benchmark.gradingMode,
    kind: runConfig.benchmark.tasks.kind,
    ids: runConfig.benchmark.tasks.ids,
    limit: runConfig.benchmark.tasks.limit,
  });
  if (tasks.length === 0) throw new Error('PACT-Pair task selection is empty');
  if (options.harnessFactory && options.adapterFactory) {
    throw new Error('Specify harnessFactory or adapterFactory, not both');
  }
  const configDigest = digestJson(runConfig);
  const taskSetDigest = digestJson(tasks);
  const sourceRevision = resolveSourceRevision(rootDir);
  const policyProvenance = {
    id: runConfig.benchmark.policy,
    file: PACT_POLICY_FILES_V1[runConfig.benchmark.policy],
    sha256: getPactPolicySha256V1(runConfig.benchmark.policy),
  };
  // Deterministic re-read of the same label set the task loader used; the
  // hash lands in run.json so relationship-graded results always carry the
  // exact label bytes they were scored against.
  const relationshipLabelProvenance = runConfig.benchmark.gradingMode === 'relationship'
    ? loadPactPairRelationshipLabelSetV2(rootDir).provenance
    : undefined;
  const backend = resolveExecutionBackend(runConfig, options.executionBackend);
  const defaultExecution: PactRunExecutionMetadataV1 = {
    backend: backend.kind,
    executor: options.executor
      ?? (options.harnessFactory || options.adapterFactory ? 'custom-harness' : 'model'),
  };
  const outputDirectory = options.writeOutputs === false
    ? undefined
    : await prepareRunOutputDirectory({
        workingDirectory: options.workingDirectory ?? process.cwd(),
        configuredDirectory: runConfig.output.directory,
        runId,
        startedAt: startedAt.toISOString(),
        model: runMetadataModelV1(runConfig.model),
        execution: defaultExecution,
        benchmark: runConfig.benchmark,
        policyProvenance,
        relationshipLabelProvenance,
        budget: runConfig.budget,
        configDigest,
        taskSetDigest,
        sourceRevision,
        selectedTasks: tasks.length,
        saveTraces: runConfig.output.saveTraces,
      });

  const seed = options.seed ?? loadCanonicalPactPairStoreV1();
  const harnessFactory = options.harnessFactory
    ?? options.adapterFactory
    ?? (context => createOpenAICompatiblePactHarnessV1(context.config, { environment }));
  const taskRuns: PactPairSingleTaskRunV1[] = [];

  const execution = await backend.run({
    config: runConfig,
    tasks,
    seed,
    runId,
    now,
    harnessFactory,
    environment,
    onTaskRun: async taskRun => {
      taskRuns.push(taskRun);
      if (outputDirectory) {
        await appendTaskCheckpoint(
          outputDirectory,
          taskRun,
          taskRuns.length,
          tasks.length,
          taskRuns.filter(run => run.result.status === 'infrastructure_error').length,
          runConfig.output.saveTraces,
        );
      }
    },
  });
  const aborted = execution.aborted;
  const executionMetadata = execution.execution ?? defaultExecution;

  const completedAt = now().toISOString();
  const summary = summarizeTaskRuns(taskRuns);
  const result: PactPairRunResultV1 = {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt,
    status: summary.errors > 0 ? 'completed_with_errors' : 'completed',
    selectedTasks: tasks.length,
    model: runMetadataModelV1(runConfig.model),
    execution: executionMetadata,
    benchmark: runConfig.benchmark,
    policyProvenance,
    ...(relationshipLabelProvenance ? { relationshipLabelProvenance } : {}),
    budget: runConfig.budget,
    configDigest,
    taskSetDigest,
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(aborted ? { aborted } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    summary,
    tasks: taskRuns.map(run => run.result),
  };

  if (outputDirectory) await finalizeRunOutputs(outputDirectory, result);

  return result;
}

function resolveExecutionBackend(
  config: PactRunConfigV1,
  override?: ExecutionBackendV1,
): ExecutionBackendV1 {
  const selected = selectedPactExecutionBackendV1(config);
  if (override) {
    if (override.kind !== selected.kind) {
      throw new Error(
        `Execution backend override ${override.kind} does not match configured backend ${selected.kind}`,
      );
    }
    return override;
  }
  if (selected.kind === 'local') return new LocalBackendV1();
  return new HarborBackendV1();
}

function runMetadataModelV1(
  model: PactRunConfigV1['model'],
): PactPairRunModelMetadataV1 {
  const temperature = model.temperature === undefined
    ? {}
    : { temperature: model.temperature };
  if (model.provider === 'azure-openai') {
    return {
      provider: 'azure-openai',
      endpoint: model.endpoint,
      deployment: model.deployment,
      ...(model.apiVersion === undefined ? {} : { apiVersion: model.apiVersion }),
      ...temperature,
      maxOutputTokens: model.maxOutputTokens,
    };
  }
  return {
    provider: 'openai-compatible',
    baseUrl: model.baseUrl,
    model: model.model,
    ...temperature,
    ...(model.seed === undefined ? {} : { seed: model.seed }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.providerRouting === undefined
      ? {}
      : { providerRouting: model.providerRouting }),
    maxOutputTokens: model.maxOutputTokens,
  };
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeRunDirectoryName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

async function prepareRunOutputDirectory(options: {
  workingDirectory: string;
  configuredDirectory: string;
  runId: string;
  startedAt: string;
  model: PactPairRunModelMetadataV1;
  execution: PactRunExecutionMetadataV1;
  benchmark: PactRunConfigV1['benchmark'];
  policyProvenance: PactPairRunResultV1['policyProvenance'];
  relationshipLabelProvenance?: PactPairRelationshipLabelProvenanceV1;
  budget: PactRunConfigV1['budget'];
  configDigest: string;
  taskSetDigest: string;
  sourceRevision?: string;
  selectedTasks: number;
  saveTraces: boolean,
}): Promise<string> {
  const outputRoot = resolve(options.workingDirectory, options.configuredDirectory);
  const outputDirectory = join(outputRoot, safeRunDirectoryName(options.runId));
  await mkdir(outputRoot, { recursive: true });
  // An existing run id is a provenance collision, not a directory to overwrite.
  await mkdir(outputDirectory);
  // Gold-bearing artifacts live only under private/ and only when the
  // retention switch (output.saveTraces) is on. See the private-artifact
  // contract next to PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1.
  if (options.saveTraces) {
    await mkdir(privateArtifactDirectory(outputDirectory));
  }
  await Promise.all([
    writeFile(join(outputDirectory, 'results.jsonl'), '', 'utf8'),
    ...(options.saveTraces
      ? [
          writeFile(
            join(privateArtifactDirectory(outputDirectory), 'evaluation.jsonl'),
            '',
            'utf8',
          ),
          writeFile(
            join(privateArtifactDirectory(outputDirectory), 'trace.jsonl'),
            '',
            'utf8',
          ),
        ]
      : []),
    writeFile(join(outputDirectory, 'run.json'), prettyJson({
      runId: options.runId,
      status: 'running',
      startedAt: options.startedAt,
      model: options.model,
      execution: options.execution,
      benchmark: options.benchmark,
      policyProvenance: options.policyProvenance,
      ...(options.relationshipLabelProvenance
        ? { relationshipLabelProvenance: options.relationshipLabelProvenance }
        : {}),
      budget: options.budget,
      configDigest: options.configDigest,
      taskSetDigest: options.taskSetDigest,
      selectedTasks: options.selectedTasks,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    }), 'utf8'),
  ]);
  return outputDirectory;
}

function privateArtifactDirectory(outputDirectory: string): string {
  return join(outputDirectory, PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1);
}

async function appendTaskCheckpoint(
  outputDirectory: string,
  taskRun: PactPairSingleTaskRunV1,
  completedTasks: number,
  selectedTasks: number,
  errors: number,
  saveTraces: boolean,
): Promise<void> {
  await appendFile(
    join(outputDirectory, 'results.jsonl'),
    jsonLines([taskRun.result]),
    'utf8',
  );
  // evaluation.jsonl carries the full evaluation (including gold-fact matches)
  // plus the registered-evaluator metric contributions, so execution backends
  // running in a separate process can hand complete trials back to the host.
  // Like trace.jsonl it contains private gold, so it is persisted only under
  // the private/ artifact directory and only when the retention switch
  // (output.saveTraces) is on; the public artifact set never contains gold.
  if (saveTraces) {
    await appendFile(
      join(outputDirectory, PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1, 'evaluation.jsonl'),
      jsonLines([{
        taskId: taskRun.result.taskId,
        evaluation: taskRun.evaluation,
        metrics: taskRun.evaluationResult.metrics,
      }]),
      'utf8',
    );
    if (taskRun.trace.length > 0) {
      await appendFile(
        join(outputDirectory, PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1, 'trace.jsonl'),
        jsonLines(taskRun.trace),
        'utf8',
      );
    }
  }
  await writeFile(join(outputDirectory, 'checkpoint.json'), prettyJson({
    status: 'running',
    completedTasks,
    selectedTasks,
    lastTaskId: taskRun.result.taskId,
    errors,
  }), 'utf8');
}

async function finalizeRunOutputs(
  outputDirectory: string,
  result: PactPairRunResultV1,
): Promise<void> {
  const runMetadata = {
    runId: result.runId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    model: result.model,
    execution: result.execution,
    benchmark: result.benchmark,
    policyProvenance: result.policyProvenance,
    ...(result.relationshipLabelProvenance
      ? { relationshipLabelProvenance: result.relationshipLabelProvenance }
      : {}),
    budget: result.budget,
    configDigest: result.configDigest,
    taskSetDigest: result.taskSetDigest,
    selectedTasks: result.selectedTasks,
    provider: result.summary.provider,
    ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
    ...(result.aborted ? { aborted: result.aborted } : {}),
  };
  await Promise.all([
    writeFile(join(outputDirectory, 'run.json'), prettyJson(runMetadata), 'utf8'),
    writeFile(join(outputDirectory, 'summary.json'), prettyJson(result.summary), 'utf8'),
    writeFile(join(outputDirectory, 'checkpoint.json'), prettyJson({
      status: result.status,
      completedTasks: result.tasks.length,
      selectedTasks: result.selectedTasks,
      lastTaskId: result.tasks.at(-1)?.taskId ?? null,
      errors: result.summary.errors,
    }), 'utf8'),
  ]);
}

function resolveSourceRevision(rootDir: string): string | undefined {
  try {
    const value = execFileSync(
      'git',
      ['-C', rootDir, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonLines(values: unknown[]): string {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`;
}

function summarizeTaskRuns(runs: PactPairSingleTaskRunV1[]): PactPairRunSummaryV1 {
  const results = runs.map(run => run.result);
  const qa = results.filter(result => result.kind === 'qa');
  const actions = results.filter(result => result.kind === 'action');
  const observedRuns = runs.filter(run => run.result.status === 'ok');
  const observedResults = observedRuns.map(run => run.result);
  const observedQa = qa.filter(result => result.status === 'ok');
  const observedActions = actions.filter(result => result.status === 'ok');
  const aggregatedMetrics = aggregateEvaluationResults(
    observedRuns.map(run => run.evaluationResult),
    PACT_PAIR_METRIC_NAMES_V1,
  );
  const qaEvaluations = observedRuns
    .map(run => run.evaluation)
    .filter((evaluation): evaluation is PactPairQaEvaluationV1 => evaluation.kind === 'qa');
  const actionEvaluations = observedRuns
    .map(run => run.evaluation)
    .filter((evaluation): evaluation is PactPairActionEvaluationV1 => evaluation.kind === 'action');
  const expectedAnswers = qaEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'answer');
  const expectedQaRefusals = qaEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'refuse');
  const benchmarkAllowed = qaEvaluations.filter(evaluation =>
    evaluation.benchmarkExpectedBehavior === 'answer');
  const benchmarkProtected = qaEvaluations.filter(evaluation =>
    evaluation.benchmarkExpectedBehavior === 'refuse');
  const expectedExecutions = actionEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'execute');
  const expectedActionRefusals = actionEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'refuse');
  const correctAnswers = expectedAnswers.filter(evaluation => evaluation.correct).length;
  const protectedNoLeak = expectedQaRefusals.filter(evaluation => evaluation.noLeak).length;
  const correctBenchmarkAnswers = benchmarkAllowed.filter(evaluation =>
    evaluation.factMatch).length;
  const benchmarkProtectedNoLeak = benchmarkProtected.filter(evaluation =>
    evaluation.benchmarkNoLeak).length;
  const correctExecutions = expectedExecutions.filter(evaluation =>
    evaluation.stateCorrect).length;
  const safeNoMutation = expectedActionRefusals.filter(evaluation =>
    !evaluation.stateChanged).length;
  const leaks = expectedQaRefusals.filter(evaluation => evaluation.leaked).length;
  const benchmarkLeaks = benchmarkProtected.filter(evaluation =>
    evaluation.benchmarkLeaked).length;
  const benchmarkFalseRefusals = benchmarkAllowed.filter(evaluation =>
    evaluation.actualDecision === 'refuse').length;
  const provider = summarizeProviderTelemetry(results);
  return {
    total: results.length,
    attempted: results.length,
    observed: observedResults.length,
    scorable: observedResults.filter(result => result.evaluation?.scorable).length,
    correct: observedResults.filter(result => result.evaluation?.correct).length,
    errors: results.filter(result => result.status === 'infrastructure_error').length,
    violations: results.reduce((count, result) => count + result.violations.length, 0),
    provider,
    metrics: {
      informationUtility: aggregatedMetrics.informationUtility,
      informationSecurity: aggregatedMetrics.informationSecurity,
      actionUtility: aggregatedMetrics.actionUtility,
      actionSafety: aggregatedMetrics.actionSafety,
      falseRefusalRate: aggregatedMetrics.falseRefusalRate,
      leakRate: aggregatedMetrics.leakRate,
      policyComplianceInformationUtility:
        aggregatedMetrics.policyComplianceInformationUtility,
      policyComplianceInformationSecurity:
        aggregatedMetrics.policyComplianceInformationSecurity,
      policyComplianceFalseRefusalRate:
        aggregatedMetrics.policyComplianceFalseRefusalRate,
      policyComplianceLeakRate: aggregatedMetrics.policyComplianceLeakRate,
    },
    qa: {
      total: qa.length,
      attempted: qa.length,
      observed: observedQa.length,
      errors: qa.length - observedQa.length,
      scorable: observedQa.filter(result => result.evaluation?.scorable).length,
      correct: observedQa.filter(result => result.evaluation?.correct).length,
      expectedAnswer: expectedAnswers.length,
      correctAnswers,
      expectedRefuse: expectedQaRefusals.length,
      safeRefusals: expectedQaRefusals.filter(evaluation => evaluation.correct).length,
      protectedNoLeak,
      leaks,
      falseRefusals: expectedAnswers.filter(evaluation =>
        evaluation.actualDecision === 'refuse').length,
      borderline: observedQa.filter(result => !result.evaluation?.scorable).length,
      benchmarkAllowed: benchmarkAllowed.length,
      correctBenchmarkAnswers,
      benchmarkProtected: benchmarkProtected.length,
      benchmarkProtectedNoLeak,
      benchmarkLeaks,
      benchmarkFalseRefusals,
    },
    actions: {
      total: actions.length,
      attempted: actions.length,
      observed: observedActions.length,
      errors: actions.length - observedActions.length,
      correct: observedActions.filter(result => result.evaluation?.correct).length,
      expectedExecute: expectedExecutions.length,
      correctExecutions,
      expectedRefuse: expectedActionRefusals.length,
      safeRefusals: expectedActionRefusals.filter(evaluation => evaluation.correct).length,
      safeNoMutation,
      unsafeMutations: expectedActionRefusals.filter(evaluation =>
        evaluation.stateChanged).length,
    },
  };
}

function summarizeProviderTelemetry(
  results: PactPairTaskResultV1[],
): PactPairRunSummaryV1['provider'] {
  const requests = results.flatMap(result =>
    result.providerTelemetry?.requests ?? []);
  const usage = requests.flatMap(request => request.usage ? [request.usage] : []);
  const costRecords = usage.filter(record => record.costUsd !== undefined);
  const sum = <K extends keyof NonNullable<(typeof requests)[number]['usage']>>(
    key: K,
  ): number | undefined => {
    const values = usage.flatMap(record => {
      const value = record[key];
      return typeof value === 'number' ? [value] : [];
    });
    return values.length === 0
      ? undefined
      : values.reduce((total, value) => total + value, 0);
  };
  const unique = (values: Array<string | undefined>): string[] =>
    [...new Set(values.flatMap(value => value ? [value] : []))].sort();
  return {
    requests: requests.length,
    successfulRequests: requests.filter(request => request.outcome === 'success').length,
    invalidResponses: requests.filter(request =>
      request.outcome === 'invalid_response').length,
    failedRequests: requests.filter(request =>
      request.outcome === 'provider_error').length,
    httpAttempts: requests.reduce(
      (total, request) => total + request.attempts,
      0,
    ),
    usageRecords: usage.length,
    costRecords: costRecords.length,
    usageComplete: requests.length > 0 && usage.length === requests.length,
    costComplete: requests.length > 0 && costRecords.length === requests.length,
    servedModels: unique(requests.map(request => request.servedModel)),
    providers: unique(requests.map(request => request.provider)),
    ...(sum('promptTokens') === undefined
      ? {}
      : { promptTokens: sum('promptTokens') }),
    ...(sum('completionTokens') === undefined
      ? {}
      : { completionTokens: sum('completionTokens') }),
    ...(sum('totalTokens') === undefined
      ? {}
      : { totalTokens: sum('totalTokens') }),
    ...(sum('reasoningTokens') === undefined
      ? {}
      : { reasoningTokens: sum('reasoningTokens') }),
    ...(sum('cachedTokens') === undefined
      ? {}
      : { cachedTokens: sum('cachedTokens') }),
    ...(sum('costUsd') === undefined
      ? {}
      : { costUsd: sum('costUsd') }),
  };
}
