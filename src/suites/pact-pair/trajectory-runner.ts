/**
 * Top-level orchestrator for the PACT-Pair multi-turn trajectory lane
 * (docs/pact-pair-multi-turn-lane.md). One run = one config = N trajectories
 * over one checklist. Runs in-process on the embedded SharedOS adapter (short
 * lanes go embedded per §6; the Harbor container path is a later phase).
 *
 * Output layout (per run directory):
 *   - run.json           run metadata + `trajectoryProtocol` provenance
 *   - results.jsonl      one synthetic per-tick trial (direct-channel grade)
 *   - ticks.jsonl        one public row per tick
 *   - trajectories.jsonl one public row per trajectory
 *   - summary.json       frozen per-tick summary (reused metric aggregation)
 *   - trajectory-summary.json  trajectory-lane metrics (flip rate, holds, …)
 *   - checkpoint.json
 *   - private/           trace.jsonl + evaluation.jsonl (gold-bearing)
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  pactRunConfigV1Schema,
  selectedPactAgentConfigV1,
  selectedPactExecutionBackendV1,
  selectedPactTrajectoryV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import {
  buildPactPairAgentConfigProvenanceV1,
  loadPactPairAgentConfigV1,
  requesterPersonaForCohortV1,
  type PactPairAgentConfigRunProvenanceV1,
} from './agent-config.js';
import { createOpenAICompatiblePactHarnessV1 } from '../../runner/v1/model-adapter.js';
import { loadPactPairTasksV1, type LoadedPactPairTaskV1 } from './task-loader.js';
import { loadCanonicalPactPairStoreV1 } from './workspace.js';
import { getPactPolicySha256V1, PACT_POLICY_FILES_V1 } from './prompt.js';
import {
  summarizeTaskRuns,
  type PactPairRunResultV1,
  type RunPactPairBenchmarkV1Options,
} from './runner.js';
import { runPactPairTrajectoryV1, type PactPairTrajectoryResultV1 } from './trajectory.js';
import {
  createScriptedPactPairRequesterDriverV1,
  type PactPairRequesterDriverV1,
  type PactPairRequesterDriverProvenanceV1,
  type PactPairRetryStrategyV1,
} from './requester-driver.js';
import {
  createModelPactPairRequesterDriverV1,
  ModelPactPairRequesterDriverV1,
} from './requester-driver-model.js';
import type { PactTrajectoryProtocolV1 } from '../../runner/v1/artifacts.js';

const repositoryRoot = resolve(
  new URL('../../..', import.meta.url).pathname,
);

const PRIVATE_DIR = 'private' as const;

/** Public per-trajectory artifact row (trajectories.jsonl); no gold. */
export type PactPairTrajectoryPublicRowV1 = {
  trajectoryId: string;
  requesterId: PactRunConfigV1['benchmark']['requester'];
  tickCount: number;
  endReason: PactPairTrajectoryResultV1['endReason'];
  phase1Ticks: number;
  phase2Ticks: number;
  checklist: Array<{ taskId: string; status: string; asks: number }>;
  error?: string;
};

/** Trajectory-lane summary (new metric names; distinct from the frozen block). */
export type PactPairTrajectorySummaryV1 = {
  trajectories: number;
  completedTrajectories: number;
  erroredTrajectories: number;
  totalTicks: number;
  phase1Ticks: number;
  phase2Ticks: number;
  endReasons: Record<string, number>;
  /** Phase-2 retries and how many flipped a prior refusal to an answer, by strategy. */
  retriesByStrategy: Record<PactPairRetryStrategyV1, number>;
  flipsByStrategy: Record<PactPairRetryStrategyV1, number>;
  /** Checklist items disclosed at least once anywhere in a trajectory. */
  itemsAnswered: number;
  itemsRefused: number;
  itemsPending: number;
  /**
   * Requester-side model usage/cost, aggregated across trajectories. Absent for
   * the scripted driver (no model calls). The responder-side usage lives in the
   * frozen summary.provider block; keeping the requester cost separate makes
   * total run cost honestly attributable to each side.
   */
  requesterModel?: {
    requests: number;
    fallbackTicks: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    servedModels: string[];
  };
};

export async function runPactPairTrajectoryBenchmarkV1(
  config: PactRunConfigV1,
  options: RunPactPairBenchmarkV1Options = {},
): Promise<PactPairRunResultV1> {
  const runConfig = pactRunConfigV1Schema.parse({
    apiVersion: config.apiVersion,
    kind: config.kind,
    ...(config.backend ? { backend: config.backend } : {}),
    model: config.model,
    benchmark: config.benchmark,
    budget: config.budget,
    output: config.output,
  });
  const trajectory = selectedPactTrajectoryV1(runConfig);
  if (!trajectory) {
    throw new Error('runPactPairTrajectoryBenchmarkV1 requires benchmark.trajectory');
  }
  if (options.harnessFactory && options.adapterFactory) {
    throw new Error('Specify harnessFactory or adapterFactory, not both');
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
  if (tasks.length === 0) throw new Error('PACT-Pair trajectory checklist is empty');

  const configDigest = digestJson(runConfig);
  const taskSetDigest = digestJson(tasks);
  const sourceRevision = resolveSourceRevision(rootDir);
  const policyProvenance = {
    id: runConfig.benchmark.policy,
    file: PACT_POLICY_FILES_V1[runConfig.benchmark.policy],
    sha256: getPactPolicySha256V1(runConfig.benchmark.policy),
  };

  const harnessFactory = options.harnessFactory
    ?? options.adapterFactory
    ?? (context => createOpenAICompatiblePactHarnessV1(context.config, { environment }));
  const scriptPath = trajectory.requesterDriver.kind === 'scripted'
    && trajectory.requesterDriver.script
    ? resolve(rootDir, trajectory.requesterDriver.script)
    : undefined;
  const makeDriver = (): PactPairRequesterDriverV1 => {
    if (trajectory.requesterDriver.kind === 'scripted') {
      return createScriptedPactPairRequesterDriverV1(scriptPath);
    }
    // Model-driven requester: runs the requester persona (from the cohort id)
    // with its own COO/MEMORY over its configured endpoint. Fail-closed if the
    // cohort has no persona config (R0/Riley is a stranger).
    const persona = requesterPersonaForCohortV1(runConfig.benchmark.requester);
    const personaConfig = loadPactPairAgentConfigV1(persona, rootDir);
    return createModelPactPairRequesterDriverV1({
      modelConfig: trajectory.requesterDriver.model,
      environment,
      personaCoo: personaConfig.coo,
      personaMemory: personaConfig.memory,
    });
  };

  // The model driver's promptSha256 is only fixed once its system prompt is
  // built from the checklist, so initialize a provenance driver with the real
  // checklist first (initialize makes no network call). The scripted driver's
  // provenance is checklist-independent, so this is harmless for it too.
  const checklistInit = {
    trajectoryId: `${runId}:provenance`,
    items: tasks.map(task => ({
      taskId: task.taskId,
      prompt: task.publicTask.prompt,
      publicTask: task.publicTask,
    })),
    ...(trajectory.phase2StartTick !== undefined
      ? { phase2StartTick: trajectory.phase2StartTick }
      : {}),
    maxTicks: trajectory.maxTicks,
  };
  const provenanceDriver = makeDriver();
  await provenanceDriver.initialize(checklistInit);
  const trajectoryProtocol = buildTrajectoryProtocolV1(
    trajectory,
    provenanceDriver.provenance(),
  );

  // Re-hash the agent-config bytes the responder harness will load (fail-closed
  // on a missing file before any tick runs).
  const agentConfigSelection = selectedPactAgentConfigV1(runConfig);
  const agentConfigProvenance: PactPairAgentConfigRunProvenanceV1 | undefined =
    agentConfigSelection
      ? buildPactPairAgentConfigProvenanceV1({
          responder: agentConfigSelection.responder,
          policySource: agentConfigSelection.policySource,
          rootDir,
        })
      : undefined;

  const seed = options.seed ?? loadCanonicalPactPairStoreV1();

  const outputDirectory = options.writeOutputs === false
    ? undefined
    : await prepareTrajectoryOutputDirectory({
        workingDirectory: options.workingDirectory ?? process.cwd(),
        configuredDirectory: runConfig.output.directory,
        runId,
        startedAt: startedAt.toISOString(),
        runConfig,
        policyProvenance,
        trajectoryProtocol,
        agentConfigProvenance,
        configDigest,
        taskSetDigest,
        sourceRevision,
        selectedTasks: tasks.length,
        saveTraces: runConfig.output.saveTraces,
      });

  const trajectoryResults: PactPairTrajectoryResultV1[] = [];
  const trajectoryRows: PactPairTrajectoryPublicRowV1[] = [];
  const requesterUsage: Array<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    servedModel?: string;
    fallback: boolean;
  }> = [];
  for (let index = 0; index < trajectory.count; index += 1) {
    const trajectoryId = `${runId}:traj-${index + 1}`;
    const driver = makeDriver();
    const result = await runPactPairTrajectoryV1({
      config: runConfig,
      tasks,
      seed,
      runId,
      trajectoryId,
      maxTicks: trajectory.maxTicks,
      ...(trajectory.phase2StartTick !== undefined
        ? { phase2StartTick: trajectory.phase2StartTick }
        : {}),
      trajectoryRuntimeMs: trajectory.maxRuntimeMs,
      now,
      harnessFactory,
      driver,
      environment,
    });
    trajectoryResults.push(result);
    // Requester-side model usage lives on the driver, not the responder harness.
    if (driver instanceof ModelPactPairRequesterDriverV1) {
      requesterUsage.push(...driver.usageRecords());
    }
    const row = toPublicTrajectoryRow(result);
    trajectoryRows.push(row);
    if (outputDirectory) {
      await appendTrajectoryArtifacts(outputDirectory, result, row, runConfig.output.saveTraces);
    }
  }

  // The per-tick direct-channel grades reused through the frozen summary.
  const tickRuns = trajectoryResults.flatMap(result => result.tickRuns);
  const summary = summarizeTaskRuns(tickRuns);
  // Provider usage is trajectory-level; overwrite the (empty) tick-run provider
  // block with the aggregate across every trajectory's single harness.
  summary.provider = aggregateProviderTelemetry(trajectoryResults);
  const trajectorySummary = summarizeTrajectories(trajectoryResults);
  const requesterModel = aggregateRequesterUsage(requesterUsage);
  if (requesterModel) trajectorySummary.requesterModel = requesterModel;

  const completedAt = now().toISOString();
  const status = summary.errors > 0 ? 'completed_with_errors' : 'completed';
  const result: PactPairRunResultV1 = {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt,
    status,
    selectedTasks: tasks.length,
    model: runMetadataModelV1(runConfig.model),
    execution: {
      backend: selectedPactExecutionBackendV1(runConfig).kind,
      executor: options.executor
        ?? (options.harnessFactory || options.adapterFactory ? 'custom-harness' : 'model'),
    },
    benchmark: runConfig.benchmark,
    policyProvenance,
    budget: runConfig.budget,
    configDigest,
    taskSetDigest,
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(agentConfigProvenance ? { agentConfigProvenance } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    summary,
    tasks: tickRuns.map(run => run.result),
    trajectoryProtocol,
    trajectories: trajectoryRows,
    trajectorySummary,
  };

  if (outputDirectory) {
    await finalizeTrajectoryOutputs(outputDirectory, result, trajectorySummary);
  }
  return result;
}

function buildTrajectoryProtocolV1(
  trajectory: NonNullable<ReturnType<typeof selectedPactTrajectoryV1>>,
  driverProvenance: PactPairRequesterDriverProvenanceV1,
): PactTrajectoryProtocolV1 {
  return {
    schemaVersion: 1,
    maxTicks: trajectory.maxTicks,
    ...(trajectory.phase2StartTick !== undefined
      ? { phase2StartTick: trajectory.phase2StartTick }
      : {}),
    trajectoryCount: trajectory.count,
    strategyTaxonomyVersion: driverProvenance.strategyTaxonomyVersion,
    requesterDriver:
      driverProvenance.kind === 'scripted'
        ? {
            kind: 'scripted',
            id: driverProvenance.id,
            version: driverProvenance.version,
            file: driverProvenance.file,
            sha256: driverProvenance.sha256,
          }
        : {
            kind: 'model',
            model: driverProvenance.model,
            servedModel: driverProvenance.servedModel,
            promptSha256: driverProvenance.promptSha256,
          },
  };
}

function toPublicTrajectoryRow(
  result: PactPairTrajectoryResultV1,
): PactPairTrajectoryPublicRowV1 {
  return {
    trajectoryId: result.trajectoryId,
    requesterId: result.requesterId,
    tickCount: result.tickCount,
    endReason: result.endReason,
    phase1Ticks: result.phase1Ticks,
    phase2Ticks: result.phase2Ticks,
    checklist: result.checklist,
    ...(result.error ? { error: result.error } : {}),
  };
}

function emptyStrategyCounts(): Record<PactPairRetryStrategyV1, number> {
  return {
    repeat: 0,
    business_justification: 0,
    urgency: 0,
    social_appeal: 0,
    decomposition: 0,
  };
}

function summarizeTrajectories(
  results: PactPairTrajectoryResultV1[],
): PactPairTrajectorySummaryV1 {
  const endReasons: Record<string, number> = {};
  const retriesByStrategy = emptyStrategyCounts();
  const flipsByStrategy = emptyStrategyCounts();
  let totalTicks = 0;
  let phase1Ticks = 0;
  let phase2Ticks = 0;
  let itemsAnswered = 0;
  let itemsRefused = 0;
  let itemsPending = 0;

  for (const result of results) {
    endReasons[result.endReason] = (endReasons[result.endReason] ?? 0) + 1;
    totalTicks += result.tickCount;
    phase1Ticks += result.phase1Ticks;
    phase2Ticks += result.phase2Ticks;
    // The decision an item last drew before a given tick, to detect flips.
    const lastDecisionByTask = new Map<string, string>();
    for (const tick of result.ticks) {
      if (tick.phase === 2 && tick.requesterStrategy !== 'first_ask') {
        const strategy = tick.requesterStrategy as PactPairRetryStrategyV1;
        retriesByStrategy[strategy] += 1;
        const prior = lastDecisionByTask.get(tick.taskId);
        if (
          (prior === 'refuse' || prior === 'escalate')
          && tick.finalDecision.type === 'answer'
        ) {
          flipsByStrategy[strategy] += 1;
        }
      }
      lastDecisionByTask.set(tick.taskId, tick.finalDecision.type);
    }
    for (const item of result.checklist) {
      if (item.status === 'answered') itemsAnswered += 1;
      else if (item.status === 'refused') itemsRefused += 1;
      else if (item.status === 'pending') itemsPending += 1;
    }
  }

  return {
    trajectories: results.length,
    completedTrajectories: results.filter(r => r.endReason !== 'infrastructure_error').length,
    erroredTrajectories: results.filter(r => r.endReason === 'infrastructure_error').length,
    totalTicks,
    phase1Ticks,
    phase2Ticks,
    endReasons,
    retriesByStrategy,
    flipsByStrategy,
    itemsAnswered,
    itemsRefused,
    itemsPending,
  };
}

function aggregateRequesterUsage(
  usage: Array<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    servedModel?: string;
    fallback: boolean;
  }>,
): PactPairTrajectorySummaryV1['requesterModel'] | undefined {
  if (usage.length === 0) return undefined;
  const sum = (key: 'promptTokens' | 'completionTokens' | 'totalTokens' | 'costUsd') => {
    const values = usage.flatMap(record => {
      const value = record[key];
      return typeof value === 'number' ? [value] : [];
    });
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  const servedModels = [
    ...new Set(usage.flatMap(record => (record.servedModel ? [record.servedModel] : []))),
  ].sort();
  return {
    requests: usage.filter(record => !record.fallback).length,
    fallbackTicks: usage.filter(record => record.fallback).length,
    ...(sum('promptTokens') === undefined ? {} : { promptTokens: sum('promptTokens') }),
    ...(sum('completionTokens') === undefined ? {} : { completionTokens: sum('completionTokens') }),
    ...(sum('totalTokens') === undefined ? {} : { totalTokens: sum('totalTokens') }),
    ...(sum('costUsd') === undefined ? {} : { costUsd: sum('costUsd') }),
    servedModels,
  };
}

function aggregateProviderTelemetry(
  results: PactPairTrajectoryResultV1[],
): PactPairRunResultV1['summary']['provider'] {
  const requests = results.flatMap(result => result.providerTelemetry?.requests ?? []);
  const usage = requests.flatMap(request => (request.usage ? [request.usage] : []));
  const costRecords = usage.filter(record => record.costUsd !== undefined);
  const sum = (key: keyof (typeof usage)[number]): number | undefined => {
    const values = usage.flatMap(record => {
      const value = record[key];
      return typeof value === 'number' ? [value] : [];
    });
    return values.length === 0
      ? undefined
      : values.reduce((total, value) => total + value, 0);
  };
  const unique = (values: Array<string | undefined>): string[] =>
    [...new Set(values.flatMap(value => (value ? [value] : [])))].sort();
  return {
    requests: requests.length,
    successfulRequests: requests.filter(request => request.outcome === 'success').length,
    invalidResponses: requests.filter(request => request.outcome === 'invalid_response').length,
    failedRequests: requests.filter(request => request.outcome === 'provider_error').length,
    httpAttempts: requests.reduce((total, request) => total + request.attempts, 0),
    usageRecords: usage.length,
    costRecords: costRecords.length,
    usageComplete: requests.length > 0 && usage.length === requests.length,
    costComplete: requests.length > 0 && costRecords.length === requests.length,
    servedModels: unique(requests.map(request => request.servedModel)),
    providers: unique(requests.map(request => request.provider)),
    ...(sum('promptTokens') === undefined ? {} : { promptTokens: sum('promptTokens') }),
    ...(sum('completionTokens') === undefined ? {} : { completionTokens: sum('completionTokens') }),
    ...(sum('totalTokens') === undefined ? {} : { totalTokens: sum('totalTokens') }),
    ...(sum('reasoningTokens') === undefined ? {} : { reasoningTokens: sum('reasoningTokens') }),
    ...(sum('cachedTokens') === undefined ? {} : { cachedTokens: sum('cachedTokens') }),
    ...(sum('costUsd') === undefined ? {} : { costUsd: sum('costUsd') }),
  };
}

// --- artifact writing -------------------------------------------------------

async function prepareTrajectoryOutputDirectory(options: {
  workingDirectory: string;
  configuredDirectory: string;
  runId: string;
  startedAt: string;
  runConfig: PactRunConfigV1;
  policyProvenance: { id: string; file: string; sha256: string };
  trajectoryProtocol: PactTrajectoryProtocolV1;
  agentConfigProvenance?: PactPairAgentConfigRunProvenanceV1;
  configDigest: string;
  taskSetDigest: string;
  sourceRevision?: string;
  selectedTasks: number;
  saveTraces: boolean;
}): Promise<string> {
  const outputRoot = resolve(options.workingDirectory, options.configuredDirectory);
  const outputDirectory = join(outputRoot, safeRunDirectoryName(options.runId));
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDirectory);
  if (options.saveTraces) await mkdir(join(outputDirectory, PRIVATE_DIR));
  await Promise.all([
    writeFile(join(outputDirectory, 'results.jsonl'), '', 'utf8'),
    writeFile(join(outputDirectory, 'ticks.jsonl'), '', 'utf8'),
    writeFile(join(outputDirectory, 'trajectories.jsonl'), '', 'utf8'),
    ...(options.saveTraces
      ? [
          writeFile(join(outputDirectory, PRIVATE_DIR, 'trace.jsonl'), '', 'utf8'),
          writeFile(join(outputDirectory, PRIVATE_DIR, 'evaluation.jsonl'), '', 'utf8'),
        ]
      : []),
    writeFile(join(outputDirectory, 'run.json'), prettyJson({
      runId: options.runId,
      status: 'running',
      startedAt: options.startedAt,
      model: runMetadataModelV1(options.runConfig.model),
      execution: {
        backend: selectedPactExecutionBackendV1(options.runConfig).kind,
        executor: 'model',
      },
      benchmark: options.runConfig.benchmark,
      policyProvenance: options.policyProvenance,
      trajectoryProtocol: options.trajectoryProtocol,
      ...(options.agentConfigProvenance
        ? { agentConfigProvenance: options.agentConfigProvenance }
        : {}),
      budget: options.runConfig.budget,
      configDigest: options.configDigest,
      taskSetDigest: options.taskSetDigest,
      selectedTasks: options.selectedTasks,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    }), 'utf8'),
  ]);
  return outputDirectory;
}

async function appendTrajectoryArtifacts(
  outputDirectory: string,
  result: PactPairTrajectoryResultV1,
  row: PactPairTrajectoryPublicRowV1,
  saveTraces: boolean,
): Promise<void> {
  await appendFile(
    join(outputDirectory, 'trajectories.jsonl'),
    jsonLines([row]),
    'utf8',
  );
  await appendFile(
    join(outputDirectory, 'ticks.jsonl'),
    jsonLines(result.ticks),
    'utf8',
  );
  await appendFile(
    join(outputDirectory, 'results.jsonl'),
    jsonLines(result.tickRuns.map(run => run.result)),
    'utf8',
  );
  if (saveTraces) {
    if (result.trace.length > 0) {
      await appendFile(
        join(outputDirectory, PRIVATE_DIR, 'trace.jsonl'),
        jsonLines(result.trace),
        'utf8',
      );
    }
    if (result.privateEvaluations.length > 0) {
      await appendFile(
        join(outputDirectory, PRIVATE_DIR, 'evaluation.jsonl'),
        jsonLines(result.privateEvaluations.map(entry => ({
          trajectoryId: result.trajectoryId,
          tick: entry.tick,
          taskId: entry.taskId,
          evaluation: entry.evaluation,
        }))),
        'utf8',
      );
    }
  }
}

async function finalizeTrajectoryOutputs(
  outputDirectory: string,
  result: PactPairRunResultV1,
  trajectorySummary: PactPairTrajectorySummaryV1,
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
      policyProvenance: result.policyProvenance,
      trajectoryProtocol: result.trajectoryProtocol,
      ...(result.agentConfigProvenance
        ? { agentConfigProvenance: result.agentConfigProvenance }
        : {}),
      budget: result.budget,
      configDigest: result.configDigest,
      taskSetDigest: result.taskSetDigest,
      selectedTasks: result.selectedTasks,
      provider: result.summary.provider,
      ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
    }), 'utf8'),
    writeFile(join(outputDirectory, 'summary.json'), prettyJson(result.summary), 'utf8'),
    writeFile(
      join(outputDirectory, 'trajectory-summary.json'),
      prettyJson(trajectorySummary),
      'utf8',
    ),
    writeFile(join(outputDirectory, 'checkpoint.json'), prettyJson({
      status: result.status,
      completedTrajectories: result.trajectories?.length ?? 0,
      totalTicks: trajectorySummary.totalTicks,
      errors: result.summary.errors,
    }), 'utf8'),
  ]);
}

// --- small local helpers (mirror runner.ts) --------------------------------

function runMetadataModelV1(
  model: PactRunConfigV1['model'],
): PactPairRunResultV1['model'] {
  const temperature = model.temperature === undefined ? {} : { temperature: model.temperature };
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
    ...(model.providerRouting === undefined ? {} : { providerRouting: model.providerRouting }),
    maxOutputTokens: model.maxOutputTokens,
  };
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeRunDirectoryName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonLines(values: unknown[]): string {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`;
}

function resolveSourceRevision(rootDir: string): string | undefined {
  try {
    const value = execFileSync('git', ['-C', rootDir, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export type { LoadedPactPairTaskV1 };
