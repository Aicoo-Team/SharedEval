import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvaluationResults } from '../../evaluation/index.js';
import {
  pactRunConfigV1Schema,
  selectedPactExecutionBackendV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import type { PactRunExecutionMetadataV1 } from '../../runner/v1/backends/index.js';
import {
  loadPactNetTasksV1,
  requirePactNetPolicyV1,
  type PactNetPolicyV1,
} from './task-loader.js';
import { loadPactNetAgentStoresV1 } from './workspace.js';
import { createPactNetModelHarnessV1 } from './model-harness.js';
import {
  runSinglePactNetTaskV1,
  type PactNetHarnessFactoryV1,
  type PactNetSingleTaskRunV1,
  type PactNetTaskResultV1,
} from './environment.js';
import type {
  PactNetActionEvaluationV1,
  PactNetQaEvaluationV1,
} from './evaluator.js';
import { PACT_NET_METRIC_NAMES_V1 } from './evaluation.js';
import type { PactNetAgentStoreV1 } from './schemas.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Private-artifact contract, mirroring the PACT-Pair run layout: the public
 * output directory root (`run.json`, `summary.json`, `results.jsonl`,
 * `checkpoint.json`) never contains gold labels, gold facts, expected
 * behaviors, or workspace content. Gold-bearing artifacts
 * (`evaluation.jsonl`, `trace.jsonl`) live only under `private/` and only
 * when `output.saveTraces` is true.
 */
export const PACT_NET_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1 = 'private' as const;

export type PactNetRateV1 = {
  numerator: number;
  denominator: number;
  value: number | null;
};

export type PactNetRunSummaryV1 = {
  total: number;
  attempted: number;
  observed: number;
  scorable: number;
  correct: number;
  errors: number;
  violations: number;
  judgePending: number;
  routingBlocked: number;
  metrics: Record<typeof PACT_NET_METRIC_NAMES_V1[number], PactNetRateV1>;
  qa: {
    total: number;
    observed: number;
    errors: number;
    expectedAnswer: number;
    expectedRefuse: number;
    borderline: number;
    blockedGold: number;
    routingBlocked: number;
    safeRefusals: number;
    leakScorable: number;
    leaks: number;
    falseRefusals: number;
  };
  actions: {
    total: number;
    observed: number;
    errors: number;
    expectedExecute: number;
    correctExecutions: number;
    expectedRefuse: number;
    safeRefusals: number;
    safeNoMutation: number;
    unsafeMutations: number;
  };
};

type PactNetRunModelMetadataV1 =
  | {
      provider: 'openai-compatible';
      baseUrl: string;
      model: string;
      temperature?: number;
      seed?: number;
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

export type PactNetRunResultV1 = {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'completed_with_errors';
  selectedTasks: number;
  model: PactNetRunModelMetadataV1;
  execution: PactRunExecutionMetadataV1;
  benchmark: {
    dataset: 'pact-net';
    policy: PactNetPolicyV1;
    tasks: PactRunConfigV1['benchmark']['tasks'];
    /**
     * Execution-adapter selection, present only when the config sets it
     * explicitly (absence keeps existing run.json payloads byte-identical
     * and means pact-public-runner) — Pair precedent, where run.json's
     * benchmark block carries `execution` verbatim from the config.
     */
    execution?: NonNullable<PactRunConfigV1['benchmark']['execution']>;
  };
  budget: PactRunConfigV1['budget'];
  configDigest: string;
  taskSetDigest: string;
  sourceRevision?: string;
  /** Never set by the in-process Net runner; kept for dispatch-result parity. */
  aborted?: {
    afterTaskId: string;
    reason: 'provider_configuration_error';
  };
  outputDirectory?: string;
  summary: PactNetRunSummaryV1;
  tasks: PactNetTaskResultV1[];
};

export type RunPactNetBenchmarkV1Options = {
  /**
   * Decision source override. When absent the OpenAI-compatible PACT-Net
   * model harness (model-harness.ts) backs every trial with the configured
   * provider; scripted or test harnesses are injected here.
   */
  harnessFactory?: PactNetHarnessFactoryV1;
  /**
   * Label for the effective decision source recorded in run artifacts.
   * Defaults to 'custom-harness' when a harnessFactory is injected and
   * 'model' otherwise (Pair precedent).
   */
  executor?: PactRunExecutionMetadataV1['executor'];
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  runId?: string;
  rootDir?: string;
  workingDirectory?: string;
  /** Seed-store override keyed by agent id; defaults to the dataset stores. */
  stores?: Map<string, PactNetAgentStoreV1>;
  writeOutputs?: boolean;
};

export async function runPactNetBenchmarkV1(
  config: PactRunConfigV1,
  options: RunPactNetBenchmarkV1Options = {},
): Promise<PactNetRunResultV1> {
  // Reconstruct the public config shape so the strict schema validates and
  // clones it while keeping machine-local paths out of the digest (Pair
  // precedent).
  const runConfig = pactRunConfigV1Schema.parse({
    apiVersion: config.apiVersion,
    kind: config.kind,
    ...(config.backend ? { backend: config.backend } : {}),
    model: config.model,
    benchmark: config.benchmark,
    budget: config.budget,
    output: config.output,
  });
  if (runConfig.benchmark.dataset !== 'pact-net') {
    throw new Error(
      `runPactNetBenchmarkV1 requires benchmark.dataset pact-net, got ${runConfig.benchmark.dataset}`,
    );
  }
  if (selectedPactExecutionBackendV1(runConfig).kind !== 'local') {
    throw new Error('PACT-Net currently supports only the local execution backend');
  }
  const policy = requirePactNetPolicyV1(runConfig.benchmark.policy);
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = options.runId
    ?? `pact-net-${startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const rootDir = options.rootDir ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const tasks = loadPactNetTasksV1({
    rootDir,
    policy,
    kind: runConfig.benchmark.tasks.kind,
    ...(runConfig.benchmark.tasks.ids ? { ids: runConfig.benchmark.tasks.ids } : {}),
    ...(runConfig.benchmark.tasks.limit === undefined
      ? {}
      : { limit: runConfig.benchmark.tasks.limit }),
  });
  if (tasks.length === 0) throw new Error('PACT-Net task selection is empty');
  const stores = options.stores ?? loadPactNetAgentStoresV1({ rootDir });
  const harnessFactory = options.harnessFactory
    ?? (context => createPactNetModelHarnessV1(context.config, context.publicTask, {
      environment,
    }));

  const benchmarkMetadata: PactNetRunResultV1['benchmark'] = {
    dataset: 'pact-net',
    policy,
    tasks: runConfig.benchmark.tasks,
    ...(runConfig.benchmark.execution
      ? { execution: runConfig.benchmark.execution }
      : {}),
  };
  const configDigest = digestJson(runConfig);
  const taskSetDigest = digestJson(tasks);
  const sourceRevision = resolveSourceRevision(rootDir);
  const execution: PactRunExecutionMetadataV1 = {
    backend: 'local',
    executor: options.executor
      ?? (options.harnessFactory ? 'custom-harness' : 'model'),
  };
  const outputDirectory = options.writeOutputs === false
    ? undefined
    : await prepareRunOutputDirectory({
        workingDirectory: options.workingDirectory ?? process.cwd(),
        configuredDirectory: runConfig.output.directory,
        runId,
        startedAt: startedAt.toISOString(),
        model: runMetadataModelV1(runConfig.model),
        execution,
        benchmark: benchmarkMetadata,
        budget: runConfig.budget,
        configDigest,
        taskSetDigest,
        ...(sourceRevision ? { sourceRevision } : {}),
        selectedTasks: tasks.length,
        saveTraces: runConfig.output.saveTraces,
      });

  const taskRuns: PactNetSingleTaskRunV1[] = [];
  for (const task of tasks) {
    const seed = stores.get(task.targetAgent);
    if (!seed) {
      throw new Error(`PACT-Net task ${task.taskId} targets agent ${task.targetAgent} with no seed store`);
    }
    const taskRun = await runSinglePactNetTaskV1({
      config: runConfig,
      task,
      seed,
      runId,
      now,
      harnessFactory,
      environment,
    });
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
  }

  const completedAt = now().toISOString();
  const summary = summarizeTaskRuns(taskRuns);
  const result: PactNetRunResultV1 = {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt,
    status: summary.errors > 0 ? 'completed_with_errors' : 'completed',
    selectedTasks: tasks.length,
    model: runMetadataModelV1(runConfig.model),
    execution,
    benchmark: benchmarkMetadata,
    budget: runConfig.budget,
    configDigest,
    taskSetDigest,
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    summary,
    tasks: taskRuns.map(run => run.result),
  };

  if (outputDirectory) await finalizeRunOutputs(outputDirectory, result);

  return result;
}

function runMetadataModelV1(
  model: PactRunConfigV1['model'],
): PactNetRunModelMetadataV1 {
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
  model: PactNetRunModelMetadataV1;
  execution: PactRunExecutionMetadataV1;
  benchmark: PactNetRunResultV1['benchmark'];
  budget: PactRunConfigV1['budget'];
  configDigest: string;
  taskSetDigest: string;
  sourceRevision?: string;
  selectedTasks: number;
  saveTraces: boolean;
}): Promise<string> {
  const outputRoot = resolve(options.workingDirectory, options.configuredDirectory);
  const outputDirectory = join(outputRoot, safeRunDirectoryName(options.runId));
  await mkdir(outputRoot, { recursive: true });
  // An existing run id is a provenance collision, not a directory to overwrite.
  await mkdir(outputDirectory);
  if (options.saveTraces) {
    await mkdir(join(outputDirectory, PACT_NET_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1));
  }
  await Promise.all([
    writeFile(join(outputDirectory, 'results.jsonl'), '', 'utf8'),
    ...(options.saveTraces
      ? [
          writeFile(
            join(outputDirectory, PACT_NET_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1, 'evaluation.jsonl'),
            '',
            'utf8',
          ),
          writeFile(
            join(outputDirectory, PACT_NET_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1, 'trace.jsonl'),
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
      budget: options.budget,
      configDigest: options.configDigest,
      taskSetDigest: options.taskSetDigest,
      selectedTasks: options.selectedTasks,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    }), 'utf8'),
  ]);
  return outputDirectory;
}

async function appendTaskCheckpoint(
  outputDirectory: string,
  taskRun: PactNetSingleTaskRunV1,
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
  // The full evaluation (expected behaviors, matched facts, mutation keys)
  // carries private gold, so it is persisted only under private/ and only
  // when the retention switch is on — same contract as PACT-Pair.
  if (saveTraces) {
    await appendFile(
      join(outputDirectory, PACT_NET_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1, 'evaluation.jsonl'),
      jsonLines([{
        taskId: taskRun.result.taskId,
        evaluation: taskRun.evaluation,
        metrics: taskRun.evaluationResult.metrics,
      }]),
      'utf8',
    );
    if (taskRun.trace.length > 0) {
      await appendFile(
        join(outputDirectory, PACT_NET_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1, 'trace.jsonl'),
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
  result: PactNetRunResultV1,
): Promise<void> {
  await Promise.all([
    writeFile(join(outputDirectory, 'run.json'), prettyJson({
      runId: result.runId,
      status: result.status,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      model: result.model,
      execution: result.execution,
      benchmark: result.benchmark,
      budget: result.budget,
      configDigest: result.configDigest,
      taskSetDigest: result.taskSetDigest,
      selectedTasks: result.selectedTasks,
      ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
    }), 'utf8'),
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

function summarizeTaskRuns(runs: PactNetSingleTaskRunV1[]): PactNetRunSummaryV1 {
  const results = runs.map(run => run.result);
  const qa = results.filter(result => result.kind === 'qa');
  const actions = results.filter(result => result.kind === 'action');
  const observedRuns = runs.filter(run => run.result.status === 'ok');
  const observedResults = observedRuns.map(run => run.result);
  const observedQa = qa.filter(result => result.status === 'ok');
  const observedActions = actions.filter(result => result.status === 'ok');
  const aggregated = aggregateEvaluationResults(
    observedRuns.map(run => run.evaluationResult),
    PACT_NET_METRIC_NAMES_V1,
  );
  const qaEvaluations = observedRuns
    .map(run => run.evaluation)
    .filter((evaluation): evaluation is PactNetQaEvaluationV1 => evaluation.kind === 'qa');
  const actionEvaluations = observedRuns
    .map(run => run.evaluation)
    .filter((evaluation): evaluation is PactNetActionEvaluationV1 =>
      evaluation.kind === 'action');
  const expectedAnswers = qaEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'answer');
  const expectedQaRefusals = qaEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'refuse');
  const expectedExecutions = actionEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'execute');
  const expectedActionRefusals = actionEvaluations.filter(evaluation =>
    evaluation.expectedBehavior === 'refuse');

  const metrics = Object.fromEntries(
    PACT_NET_METRIC_NAMES_V1.map(name => [
      name,
      aggregated[name] ?? { numerator: 0, denominator: 0, value: null },
    ]),
  ) as PactNetRunSummaryV1['metrics'];

  return {
    total: results.length,
    attempted: results.length,
    observed: observedResults.length,
    scorable: observedRuns.filter(run => run.evaluation.scorable).length,
    correct: observedRuns.filter(run => run.evaluation.correct).length,
    errors: results.filter(result => result.status === 'infrastructure_error').length,
    violations: results.reduce((count, result) => count + result.violations.length, 0),
    judgePending: qaEvaluations.filter(evaluation => evaluation.judgePending).length,
    routingBlocked: observedRuns.filter(run => run.evaluation.routingBlocked).length,
    metrics,
    qa: {
      total: qa.length,
      observed: observedQa.length,
      errors: qa.length - observedQa.length,
      expectedAnswer: expectedAnswers.length,
      expectedRefuse: expectedQaRefusals.length,
      borderline: qaEvaluations.filter(evaluation =>
        evaluation.expectedBehavior === 'either').length,
      blockedGold: qaEvaluations.filter(evaluation =>
        evaluation.expectedBehavior === 'blocked').length,
      routingBlocked: qaEvaluations.filter(evaluation => evaluation.routingBlocked).length,
      safeRefusals: expectedQaRefusals.filter(evaluation => evaluation.correct).length,
      leakScorable: qaEvaluations.filter(evaluation => evaluation.leakScorable).length,
      leaks: qaEvaluations.filter(evaluation => evaluation.leaked).length,
      falseRefusals: expectedAnswers.filter(evaluation =>
        evaluation.actualDecision === 'refuse').length,
    },
    actions: {
      total: actions.length,
      observed: observedActions.length,
      errors: actions.length - observedActions.length,
      expectedExecute: expectedExecutions.length,
      correctExecutions: expectedExecutions.filter(evaluation =>
        evaluation.stateCorrect).length,
      expectedRefuse: expectedActionRefusals.length,
      safeRefusals: expectedActionRefusals.filter(evaluation => evaluation.correct).length,
      safeNoMutation: expectedActionRefusals.filter(evaluation =>
        !evaluation.stateChanged).length,
      unsafeMutations: expectedActionRefusals.filter(evaluation =>
        evaluation.stateChanged).length,
    },
  };
}
