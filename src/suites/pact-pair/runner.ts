import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvaluationResults } from '../../evaluation/index.js';
import type { PairDataStore } from './schemas.js';
import {
  pactRunConfigV1Schema,
  selectedPactExecutionBackendV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import {
  createOpenAICompatiblePactHarnessV1,
} from '../../runner/v1/model-adapter.js';
import {
  HarborBackendV1,
  LocalBackendV1,
  PactHarborExecutionIdentityUnavailableErrorV1,
  type ExecutionBackendV1,
  type PactRunExecutionMetadataV1,
} from '../../runner/v1/backends/index.js';
import {
  acquirePactPairRunWriterLockV1,
  atomicWritePactPairRunFileV1,
  canonicalizePactPairRunArtifactsV1,
  commitPactPairTaskRunV1,
  compactResumedRunArtifactsV1,
  createPactPairRunDirectoryWithWriterLockV1,
  loadPactPairResumeStateV1,
  PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
  recordPactPairExecutionAuthorityV1,
  type PactPairResumeStateV1,
  type PactPairRunWriterLockV1,
} from './resume.js';
import {
  loadPactPairTaskSetV1,
  type PactPairRequesterIdentityProvenanceV1,
} from './task-loader.js';
import type { PactPairRelationshipLabelProvenanceV1 } from './relationship-labels.js';
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

// The private-artifact contract (and its documentation) lives in resume.ts
// beside the code that re-reads the checkpoint artifacts; re-exported here for
// compatibility.
export {
  PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
  selectPactPairResumeTasksV1,
  type PactPairResumeSelectionV1,
} from './resume.js';
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
  executionProjection: 'all-outcomes' | 'latest-attempt';
  executionAttempts: PactPairRunExecutionAttemptV1[];
  benchmark: PactRunConfigV1['benchmark'];
  policyProvenance: {
    id: PactRunConfigV1['benchmark']['policy'];
    file: string;
    sha256: string;
  };
  requesterIdentityProvenance: PactPairRequesterIdentityProvenanceV1;
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
  /**
   * Resume provenance: present exactly when this run result was produced by
   * resuming a prior run directory. Each entry records one resume attempt and
   * the task ids it re-executed (missing or proven transient trials only).
   */
  resumed?: true;
  resumes?: PactPairRunResumeRecordV1[];
  summary: PactPairRunSummaryV1;
  tasks: PactPairTaskResultV1[];
};

export type PactPairRunExecutionAttemptV1 = {
  taskIds: string[];
  execution: PactRunExecutionMetadataV1;
};

export type PactPairRunResumeRecordV1 = {
  at: string;
  taskIds: string[];
};

/**
 * Machine-readable context for a run that failed closed before Harbor could
 * publish any task outcome. The run directory remains resumable; the CLI can
 * report the root cause without inventing execution provenance or task rows.
 */
export class PactPairRunFatalErrorV1 extends Error {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly taskIds: string[];

  constructor(
    message: string,
    context: { runId: string; outputDirectory: string; taskIds: string[] },
  ) {
    super(message);
    this.name = 'PactPairRunFatalErrorV1';
    this.runId = context.runId;
    this.outputDirectory = context.outputDirectory;
    this.taskIds = [...context.taskIds];
  }
}

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
  /**
   * Path to a prior run's output directory to resume (relative paths resolve
   * against workingDirectory). The current config and task selection must
   * match the original exactly (digest-checked). Completed trials are
   * retained verbatim and never re-executed; only missing tasks and failures
   * proven transient before any action run. Requires the original run to have
   * used output.saveTraces: true.
   */
  resume?: string;
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
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let runId = options.runId
    ?? `pact-${startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const rootDir = options.rootDir ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const taskSet = loadPactPairTaskSetV1({
    rootDir,
    policy: runConfig.benchmark.policy,
    requester: runConfig.benchmark.requester,
    gradingMode: runConfig.benchmark.gradingMode,
    kind: runConfig.benchmark.tasks.kind,
    ids: runConfig.benchmark.tasks.ids,
    limit: runConfig.benchmark.tasks.limit,
  });
  const { tasks } = taskSet;
  if (tasks.length === 0) throw new Error('PACT-Pair task selection is empty');
  if (options.harnessFactory && options.adapterFactory) {
    throw new Error('Specify harnessFactory or adapterFactory, not both');
  }
  const configDigest = digestJson(runConfig);
  // Bind both task bytes and every gold/identity source used to create them.
  // The loader returns this atomically, avoiding a second label-file read.
  const taskSetDigest = digestJson(taskSet);
  const sourceRevision = resolveSourceRevision(rootDir);
  const policyProvenance = {
    id: runConfig.benchmark.policy,
    file: PACT_POLICY_FILES_V1[runConfig.benchmark.policy],
    sha256: getPactPolicySha256V1(runConfig.benchmark.policy),
  };
  const backend = resolveExecutionBackend(runConfig, options.executionBackend);
  const defaultExecution: PactRunExecutionMetadataV1 = {
    backend: backend.kind,
    executor: options.executor
      ?? (options.harnessFactory || options.adapterFactory ? 'custom-harness' : 'model'),
  };
  let resumeState: PactPairResumeStateV1 | undefined;
  let resumes: PactPairRunResumeRecordV1[] | undefined;
  let outputDirectory: string | undefined;
  let pendingTasks = tasks;
  let writerLock: PactPairRunWriterLockV1 | undefined;
  let retainedAttempts: PactPairRunExecutionAttemptV1[] = [];
  const seed = options.seed ?? loadCanonicalPactPairStoreV1();
  try {
    if (options.resume !== undefined) {
      if (options.writeOutputs === false) {
        throw new Error(
          'resume requires writeOutputs: the run directory is the checkpoint',
        );
      }
      if (options.runId !== undefined) {
        throw new Error(
          'resume keeps the original run id; do not combine resume with runId',
        );
      }
      outputDirectory = resolve(
        options.workingDirectory ?? process.cwd(),
        options.resume,
      );
      writerLock = await acquirePactPairRunWriterLockV1(outputDirectory);
      resumeState = await loadPactPairResumeStateV1({
        runDirectory: outputDirectory,
        tasks,
        configDigest,
        taskSetDigest,
        model: runMetadataModelV1(runConfig.model),
        benchmark: runConfig.benchmark,
        budget: runConfig.budget,
        policyProvenance,
        requesterIdentityProvenance: taskSet.requesterIdentityProvenance,
        relationshipLabelProvenance: taskSet.relationshipLabelProvenance,
        sourceRevision,
        seed,
      });
      runId = resumeState.runId;
      // Promote any in-progress execution authority into the durable per-task
      // projection before replacing run.json. From this point onward every
      // observable metadata state must still bind each retained task commit's
      // executionDigest, even if later canonical finalization tears.
      retainedAttempts = retainedExecutionAttempts(
        resumeState.metadata,
        resumeState.selection.completedTaskIds,
      );
      const retainedProjection = retainedAttempts.length > 0
        ? executionProjectionFor(retainedAttempts)
        : undefined;
      const retainedExecution = retainedProjection === undefined
        ? undefined
        : retainedProjection === 'all-outcomes'
          ? retainedAttempts[0]!.execution
          : retainedAttempts.at(-1)!.execution;
      const pendingIds = new Set([
        ...resumeState.selection.retryTaskIds,
        ...resumeState.selection.missingTaskIds,
      ]);
      pendingTasks = tasks.filter(task => pendingIds.has(task.taskId));
      resumes = [
        ...(resumeState.metadata.resumes ?? []),
        {
          at: startedAt.toISOString(),
          taskIds: pendingTasks.map(task => task.taskId),
        },
      ];
      // Drop only the outcomes proven safe to re-run, then mark the run as
      // running again with resume provenance. Terminal outcomes stay retained.
      await compactResumedRunArtifactsV1({
        runDirectory: outputDirectory,
        keepTaskIds: new Set(resumeState.selection.completedTaskIds),
        saveTraces: runConfig.output.saveTraces,
      });
      await atomicWritePactPairRunFileV1(join(outputDirectory, 'run.json'), prettyJson({
        runId,
        status: 'running',
        startedAt: resumeState.startedAt,
        model: resumeState.metadata.model,
        ...(retainedExecution
          ? { execution: retainedExecution }
          : {}),
        ...(retainedProjection
          ? { executionProjection: retainedProjection }
          : {}),
        ...(retainedAttempts.length > 0
          ? { executionAttempts: retainedAttempts }
          : {}),
        benchmark: resumeState.metadata.benchmark,
        policyProvenance: resumeState.metadata.policyProvenance,
        requesterIdentityProvenance:
          resumeState.metadata.requesterIdentityProvenance,
        ...(resumeState.metadata.relationshipLabelProvenance
          ? {
              relationshipLabelProvenance:
                resumeState.metadata.relationshipLabelProvenance,
            }
          : {}),
        budget: resumeState.metadata.budget,
        configDigest,
        taskSetDigest,
        selectedTasks: tasks.length,
        ...(resumeState.metadata.sourceRevision
          ? { sourceRevision: resumeState.metadata.sourceRevision }
          : {}),
        resumed: true,
        resumes,
      }));
    } else if (options.writeOutputs !== false) {
      const prepared = await prepareRunOutputDirectory({
        workingDirectory: options.workingDirectory ?? process.cwd(),
        configuredDirectory: runConfig.output.directory,
        runId,
        startedAt: startedAt.toISOString(),
        model: runMetadataModelV1(runConfig.model),
        execution: defaultExecution,
        benchmark: runConfig.benchmark,
        policyProvenance,
        requesterIdentityProvenance: taskSet.requesterIdentityProvenance,
        relationshipLabelProvenance: taskSet.relationshipLabelProvenance,
        budget: runConfig.budget,
        configDigest,
        taskSetDigest,
        sourceRevision,
        selectedTasks: tasks.length,
        saveTraces: runConfig.output.saveTraces,
      });
      outputDirectory = prepared.outputDirectory;
      writerLock = prepared.writerLock;
    }

    const harnessFactory = options.harnessFactory
      ?? options.adapterFactory
      ?? (context => createOpenAICompatiblePactHarnessV1(context.config, { environment }));
    const retainedRuns = resumeState?.retainedRuns ?? [];
    const taskRuns = new Map<string, PactPairSingleTaskRunV1>();
    let activeExecution = backend.kind === 'harbor'
      ? undefined
      : defaultExecution;

    const backendRunContext = {
      config: runConfig,
      tasks: pendingTasks,
      seed,
      runId,
      now,
      harnessFactory,
      environment,
      onExecution: async (reportedExecution: PactRunExecutionMetadataV1) => {
        assertExactExecutionIdentity(reportedExecution, backend.kind);
        if (activeExecution !== undefined) {
          assertSameExecutionIdentity(activeExecution, reportedExecution);
        }
        if (outputDirectory) {
          await recordPactPairExecutionAuthorityV1(
            outputDirectory,
            reportedExecution,
          );
        }
        activeExecution = structuredClone(reportedExecution);
      },
      onTaskRun: async (taskRun: PactPairSingleTaskRunV1) => {
        const taskId = taskRun.result.taskId;
        if (activeExecution === undefined) {
          throw new Error(
            `Cannot commit task ${taskId}: exact ${backend.kind} execution `
            + 'identity was not durably recorded before task completion',
          );
        }
        const existing = taskRuns.get(taskId);
        if (existing) assertSameInMemoryTaskRun(existing, taskRun);
        else taskRuns.set(taskId, taskRun);
        const nextRuns = new Map(taskRuns);
        if (outputDirectory) {
          await commitPactPairTaskRunV1({
            runDirectory: outputDirectory,
            runId,
            configDigest,
            taskSetDigest,
            execution: activeExecution,
            taskRun,
            saveTraces: runConfig.output.saveTraces,
            checkpoint: {
              completedTasks: retainedRuns.length + nextRuns.size,
              selectedTasks: tasks.length,
              errors: [...retainedRuns, ...nextRuns.values()]
                .filter(run => run.result.status === 'infrastructure_error').length,
            },
          });
        }
      },
    };
    const execution = pendingTasks.length === 0
      ? {}
      : await backend.run(backendRunContext);
    const aborted = execution.aborted;
    const freshTaskIds = tasks
      .map(task => task.taskId)
      .filter(taskId => taskRuns.has(taskId));
    if (execution.execution !== undefined) {
      assertExactExecutionIdentity(execution.execution, backend.kind);
      if (activeExecution !== undefined) {
        assertSameExecutionIdentity(activeExecution, execution.execution);
      }
      activeExecution = execution.execution;
    }
    const executionMetadata = activeExecution ?? defaultExecution;
    const executionAttempts = [
      ...retainedAttempts,
      ...(freshTaskIds.length > 0
        ? [{ taskIds: freshTaskIds, execution: executionMetadata }]
        : []),
    ];
    if (executionAttempts.length === 0) {
      throw new Error('PACT-Pair run produced no committed task outcomes');
    }
    const executionProjection = executionProjectionFor(executionAttempts);
    const projectedExecution = executionProjection === 'all-outcomes'
      ? executionAttempts[0]!.execution
      : executionAttempts.at(-1)!.execution;

    const completedAt = now().toISOString();
    // Canonical task order for the aggregate result: retained and freshly run
    // trials interleave by selection order, so resumed and concurrent backends
    // produce the same deterministic ordering as a serial fresh run.
    const orderIndex = new Map(tasks.map((task, index) => [task.taskId, index] as const));
    const mergedRuns = [...retainedRuns, ...taskRuns.values()].sort((a, b) =>
      (orderIndex.get(a.result.taskId) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(b.result.taskId) ?? Number.MAX_SAFE_INTEGER));
    const summary = summarizeTaskRuns(mergedRuns);
    const result: PactPairRunResultV1 = {
      runId,
      startedAt: resumeState?.startedAt ?? startedAt.toISOString(),
      completedAt,
      status: summary.errors > 0 ? 'completed_with_errors' : 'completed',
      selectedTasks: tasks.length,
      model: runMetadataModelV1(runConfig.model),
      execution: projectedExecution,
      executionProjection,
      executionAttempts,
      benchmark: resumeState?.metadata.benchmark ?? runConfig.benchmark,
      policyProvenance: resumeState?.metadata.policyProvenance ?? policyProvenance,
      requesterIdentityProvenance: taskSet.requesterIdentityProvenance,
      ...(taskSet.relationshipLabelProvenance
        ? { relationshipLabelProvenance: taskSet.relationshipLabelProvenance }
        : {}),
      budget: resumeState?.metadata.budget ?? runConfig.budget,
      configDigest,
      taskSetDigest,
      ...((resumeState?.metadata.sourceRevision ?? sourceRevision)
        ? { sourceRevision: resumeState?.metadata.sourceRevision ?? sourceRevision }
        : {}),
      ...(aborted ? { aborted } : {}),
      ...(outputDirectory ? { outputDirectory } : {}),
      ...(resumes ? { resumed: true as const, resumes } : {}),
      summary,
      tasks: mergedRuns.map(run => run.result),
    };

    if (outputDirectory) {
      await canonicalizePactPairRunArtifactsV1({
        runDirectory: outputDirectory,
        taskIds: tasks.map(task => task.taskId),
        saveTraces: runConfig.output.saveTraces,
      });
      await finalizeRunOutputs(outputDirectory, result);
    }

    return result;
  } catch (error) {
    if (
      error instanceof PactHarborExecutionIdentityUnavailableErrorV1
      && outputDirectory !== undefined
    ) {
      throw new PactPairRunFatalErrorV1(error.message, {
        runId,
        outputDirectory,
        taskIds: tasks.map(task => task.taskId),
      });
    }
    throw error;
  } finally {
    await writerLock?.release();
  }
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

function retainedExecutionAttempts(
  metadata: PactPairResumeStateV1['metadata'],
  retainedTaskIds: readonly string[],
): PactPairRunExecutionAttemptV1[] {
  if (retainedTaskIds.length === 0) return [];
  const retained = new Set(retainedTaskIds);
  const attempts = (metadata.executionAttempts ?? [])
    .map(attempt => ({
      taskIds: attempt.taskIds.filter(taskId => retained.has(taskId)),
      execution: attempt.execution,
    }))
    .filter(attempt => attempt.taskIds.length > 0);
  const covered = new Set(attempts.flatMap(attempt => attempt.taskIds));
  const missing = retainedTaskIds.filter(taskId => !covered.has(taskId));
  if (missing.length > 0) {
    const fallback = metadata.activeExecution ?? metadata.execution;
    if (fallback === undefined) {
      throw new Error(
        `Cannot resume task ${missing[0]}: no authoritative execution `
        + 'provenance is recorded',
      );
    }
    assertExactExecutionIdentity(fallback, fallback.backend);
    attempts.push({ taskIds: missing, execution: fallback });
  }
  for (const attempt of attempts) {
    try {
      assertExactExecutionIdentity(attempt.execution, attempt.execution.backend);
    } catch (error) {
      const taskId = attempt.taskIds[0] ?? 'unknown';
      throw new Error(
        `Cannot resume task ${taskId}: exact execution provenance is not `
        + `durably known (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const finalCovered = new Set(attempts.flatMap(attempt => attempt.taskIds));
  const unresolved = retainedTaskIds.find(taskId => !finalCovered.has(taskId));
  if (unresolved !== undefined) {
    throw new Error(
      `Cannot resume task ${unresolved}: no authoritative execution provenance is recorded`,
    );
  }
  return attempts;
}

function assertExactExecutionIdentity(
  execution: PactRunExecutionMetadataV1,
  backendKind: ExecutionBackendV1['kind'],
): void {
  if (execution.backend !== backendKind) {
    throw new Error(
      `Execution backend identity ${execution.backend} does not match ${backendKind}`,
    );
  }
  if (
    execution.backend === 'harbor'
    && (
      execution.harbor === undefined
      || !/^sha256:[0-9a-f]{64}$/u.test(execution.harbor.imageId ?? '')
    )
  ) {
    throw new Error(
      'Harbor execution identity requires version, image, and immutable imageId',
    );
  }
}

function assertSameExecutionIdentity(
  existing: PactRunExecutionMetadataV1,
  incoming: PactRunExecutionMetadataV1,
): void {
  if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(
      'Backend returned an execution identity that conflicts with its durable authority',
    );
  }
}

function executionProjectionFor(
  attempts: readonly PactPairRunExecutionAttemptV1[],
): 'all-outcomes' | 'latest-attempt' {
  const identity = JSON.stringify(attempts[0]?.execution);
  return attempts.every(attempt => JSON.stringify(attempt.execution) === identity)
    ? 'all-outcomes'
    : 'latest-attempt';
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
  requesterIdentityProvenance: PactPairRequesterIdentityProvenanceV1;
  relationshipLabelProvenance?: PactPairRelationshipLabelProvenanceV1;
  budget: PactRunConfigV1['budget'];
  configDigest: string;
  taskSetDigest: string;
  sourceRevision?: string;
  selectedTasks: number;
  saveTraces: boolean,
}): Promise<{
  outputDirectory: string;
  writerLock: PactPairRunWriterLockV1;
}> {
  const outputRoot = resolve(options.workingDirectory, options.configuredDirectory);
  const outputDirectory = join(outputRoot, safeRunDirectoryName(options.runId));
  const writerLock = await createPactPairRunDirectoryWithWriterLockV1(
    outputDirectory,
  );
  try {
    // Gold-bearing artifacts live only under private/ and only when the
    // retention switch (output.saveTraces) is on. See the private-artifact
    // contract next to PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1.
    if (options.saveTraces) {
      await mkdir(privateArtifactDirectory(outputDirectory));
    }
    await atomicWritePactPairRunFileV1(
      join(outputDirectory, 'results.jsonl'),
      '',
    );
    if (options.saveTraces) {
      await atomicWritePactPairRunFileV1(
        join(privateArtifactDirectory(outputDirectory), 'evaluation.jsonl'),
        '',
      );
      await atomicWritePactPairRunFileV1(
        join(privateArtifactDirectory(outputDirectory), 'trace.jsonl'),
        '',
      );
    }
    await atomicWritePactPairRunFileV1(join(outputDirectory, 'run.json'), prettyJson({
      runId: options.runId,
      status: 'running',
      startedAt: options.startedAt,
      model: options.model,
      execution: options.execution,
      benchmark: options.benchmark,
      policyProvenance: options.policyProvenance,
      requesterIdentityProvenance: options.requesterIdentityProvenance,
      ...(options.relationshipLabelProvenance
        ? { relationshipLabelProvenance: options.relationshipLabelProvenance }
        : {}),
      budget: options.budget,
      configDigest: options.configDigest,
      taskSetDigest: options.taskSetDigest,
      selectedTasks: options.selectedTasks,
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    }));
    return { outputDirectory, writerLock };
  } catch (error) {
    await writerLock.release();
    throw error;
  }
}

function privateArtifactDirectory(outputDirectory: string): string {
  return join(outputDirectory, PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1);
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
    executionProjection: result.executionProjection,
    executionAttempts: result.executionAttempts,
    benchmark: result.benchmark,
    policyProvenance: result.policyProvenance,
    requesterIdentityProvenance: result.requesterIdentityProvenance,
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
    ...(result.resumed ? { resumed: true, resumes: result.resumes } : {}),
  };
  // The checkpoint is the completion marker and therefore publishes last.
  // Until both summary and run metadata are durable, recovery sees `running`.
  await atomicWritePactPairRunFileV1(
    join(outputDirectory, 'summary.json'),
    prettyJson(result.summary),
  );
  await atomicWritePactPairRunFileV1(
    join(outputDirectory, 'run.json'),
    prettyJson(runMetadata),
  );
  await atomicWritePactPairRunFileV1(
    join(outputDirectory, 'checkpoint.json'),
    prettyJson({
      status: result.status,
      completedTasks: result.tasks.length,
      selectedTasks: result.selectedTasks,
      lastTaskId: result.tasks.at(-1)?.taskId ?? null,
      errors: result.summary.errors,
    }),
  );
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

function assertSameInMemoryTaskRun(
  existing: PactPairSingleTaskRunV1,
  incoming: PactPairSingleTaskRunV1,
): void {
  if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(
      `Conflicting completed outcomes for task ${incoming.result.taskId}; `
      + 'refusing to replace an already-executed model action',
    );
  }
}

function summarizeTaskRuns(runs: PactPairSingleTaskRunV1[]): PactPairRunSummaryV1 {
  const results = runs.map(run => run.result);
  const qa = results.filter(result => result.kind === 'qa');
  const actions = results.filter(result => result.kind === 'action');
  // A failed trial that already mutated state remains an observed safety
  // outcome. It carries a public evaluation and must not disappear from the
  // live denominators merely because the provider failed afterwards.
  const observedRuns = runs.filter(run => run.result.evaluation !== null);
  const observedResults = observedRuns.map(run => run.result);
  const observedQa = qa.filter(result => result.evaluation !== null);
  const observedActions = actions.filter(result => result.evaluation !== null);
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
      errors: qa.filter(result => result.status === 'infrastructure_error').length,
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
      errors: actions.filter(result =>
        result.status === 'infrastructure_error').length,
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
