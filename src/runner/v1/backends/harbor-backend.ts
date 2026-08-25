import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pactTaskEvaluationRecordV1Schema,
  pactTaskResultV1Schema,
  pactTraceEventV1Schema,
  type PactTaskResultV1,
  type PactTraceEventV1,
} from '../artifacts.js';
import { buildPactPairBackendErrorRunV1 } from '../../../suites/pact-pair/environment.js';
import { pactPairMetricContributionsV1 } from '../../../suites/pact-pair/evaluation.js';
import type { PactPairEvaluationV1 } from '../../../suites/pact-pair/evaluator.js';
import type { LoadedPactPairTaskV1 } from '../../../suites/pact-pair/task-loader.js';
import type {
  ExecutionBackendV1,
  PactExecutionBackendRunContextV1,
  PactExecutionBackendRunResultV1,
  PactExecutionTaskRunV1,
  PactRunExecutionMetadataV1,
} from './execution-backend.js';
import { mapWithConcurrencyV1 } from './concurrency.js';
import {
  PACT_MODEL_API_KEY_ENV_V1,
  type PactRunConfigV1,
} from '../config.js';
import {
  defaultHostSharedOsDirV1,
  pactHarborSharedOsStageDirV1,
  stageSharedOsBuildV1,
} from './harbor-sharedos.js';
import {
  harborTaskImageName,
  materializeHarborDatasetV1,
  pactHarborScriptedModelV1,
  pactHarborTemplateDirectoryV1,
  type PactHarborDatasetRuntimeV1,
  type PactHarborPackagedTaskV1,
} from './harbor-task-package.js';
import { PACT_PAIR_HARBOR_DATASET_RUNTIME_V1 } from '../../../suites/pact-pair/harbor.js';

const defaultRepositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Harbor stopped before an immutable execution identity could be announced. */
export class PactHarborExecutionIdentityUnavailableErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PactHarborExecutionIdentityUnavailableErrorV1';
  }
}

/**
 * The only Harbor release this backend is validated against. The task packages
 * rely on v0.5.0 config semantics — most importantly `allow_internet = false`
 * being the field that actually disables container networking — so the backend
 * refuses to run under any other version instead of silently degrading.
 */
export const PACT_HARBOR_VERSION_V1 = '0.5.0' as const;
export const PACT_HARBOR_IMAGE_V1 = 'pact-bench-harbor:p0' as const;

// Bound how many `docker image tag` subprocesses run at once. Each selected
// task gets its own task-scoped image tag, so a full-dataset selection would
// otherwise spawn hundreds of concurrent `docker` processes.
const HARBOR_IMAGE_TAG_CONCURRENCY_V1 = 8;

// Settled PACT-Pair trials are scanned while Harbor is still running so the
// host can checkpoint them before the whole job completes.
const HARBOR_STREAM_POLL_INTERVAL_MS_V1 = 2_000;

// The deterministic smoke-fixture set: the tasks covered by the committed
// pact-pair-smoke-v1 golden and the default verify_harbor.sh Docker parity
// check. This is NO LONGER an execution allowlist — the Harbor backend
// materializes and runs any selected PACT-Pair task (up to the full 600-task
// dataset). It is retained only to seed fixtures and example configs.
export const PACT_HARBOR_SMOKE_TASK_IDS_V1 = [
  'PAIR-Q1',
  'PAIR-Q101',
  'PAIR-Q201',
  'PAIR-A1',
  'PAIR-A21',
  'PAIR-A41',
] as const;

export type HarborBackendV1Options = {
  repositoryRoot?: string;
  harborExecutable?: string;
  dockerExecutable?: string;
  imageName?: string;
  keepWorkingDirectory?: boolean;
  /** Poll interval for streaming per-trial results while Harbor runs. */
  streamPollIntervalMs?: number;
  /**
   * A locally BUILT SharedOS checkout staged into the image. Defaults to
   * PACT_SHAREDOS_DIR, then a `sharedos-repo` checkout beside the repository
   * (the load-sharedos.ts convention).
   */
  sharedOsDir?: string;
};

/**
 * Coarse bridge: Harbor orchestrates one Node container per selected task while
 * the container runs the authoritative per-task engine
 * (runSinglePactPairTaskV1). Any PACT-Pair task (up to the full 600-task
 * dataset) can be materialized and run.
 *
 * The in-container harness is still the deterministic scripted harness (see
 * container-entrypoint.ts); wiring a real-model harness across the container
 * boundary is the runner-side follow-up. The container packaging decisions
 * (O-003) are already in force here: the image carries the prebuilt SharedOS
 * checkout (staged, never cloned/built in-container), the model credential is
 * injected runtime-only through Harbor's env resolution, and real-model task
 * packages narrow egress to the configured model endpoint host over HTTPS 443
 * while scripted packages stay strictly no-network. Run artifacts record the
 * effective executor honestly: `scripted-harness` for scripted parity
 * packages (which never call a model), `model` for real-model packages.
 */
export class HarborBackendV1 implements ExecutionBackendV1 {
  readonly kind = 'harbor' as const;
  private readonly repositoryRoot: string;
  private readonly harborExecutable: string;
  private readonly dockerExecutable: string;
  private readonly imageName: string;
  private readonly keepWorkingDirectory: boolean;
  private readonly sharedOsDir: string | undefined;
  private readonly streamPollIntervalMs: number;

  constructor(options: HarborBackendV1Options = {}) {
    this.repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
    this.harborExecutable = options.harborExecutable ?? 'harbor';
    this.dockerExecutable = options.dockerExecutable ?? 'docker';
    this.imageName = options.imageName ?? PACT_HARBOR_IMAGE_V1;
    this.keepWorkingDirectory = options.keepWorkingDirectory ?? false;
    this.sharedOsDir = options.sharedOsDir;
    this.streamPollIntervalMs = options.streamPollIntervalMs
      ?? HARBOR_STREAM_POLL_INTERVAL_MS_V1;
  }

  async run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1> {
    const onExecution = (context as PactExecutionBackendRunContextV1 & {
      onExecution?: (execution: PactRunExecutionMetadataV1) => Promise<void>;
    }).onExecution;
    const checkpointHostRun = async (taskRun: PactExecutionTaskRunV1) => {
      await context.onTaskRun?.(bindPactPairTraceToHostRun(taskRun, context.runId));
    };
    const orchestration = await runHarborTrialsV1({
      repositoryRoot: this.repositoryRoot,
      harborExecutable: this.harborExecutable,
      dockerExecutable: this.dockerExecutable,
      imageName: this.imageName,
      keepWorkingDirectory: this.keepWorkingDirectory,
      ...(this.sharedOsDir === undefined ? {} : { sharedOsDir: this.sharedOsDir }),
      runtime: PACT_PAIR_HARBOR_DATASET_RUNTIME_V1,
      config: context.config,
      tasks: context.tasks,
      runId: context.runId,
      environment: context.environment,
      onExecution,
      collect: jobsDirectory => collectHarborTaskRunsV1(jobsDirectory, context.tasks),
      stream: (jobsDirectory, untilSettled) => streamHarborTrialsV1({
        jobsDirectory,
        tasks: context.tasks,
        untilSettled,
        pollIntervalMs: this.streamPollIntervalMs,
        runId: context.runId,
        onTaskRun: context.onTaskRun,
      }),
    });
    if (onExecution && !orchestration.execution.harbor?.imageId) {
      throw new PactHarborExecutionIdentityUnavailableErrorV1(
        'Harbor failed before its exact execution identity could be durably '
        + `recorded: ${orchestration.missingMessage}`,
      );
    }
    for (const task of context.tasks) {
      if (orchestration.emittedTaskIds.has(task.taskId)) continue;
      const taskRun = orchestration.taskRuns.get(task.taskId)
        ?? await buildPactPairBackendErrorRunV1({
          config: context.config,
          task,
          seed: context.seed,
          runId: context.runId,
          now: context.now,
          message: orchestration.failures.get(task.taskId)
            ?? orchestration.missingMessage,
        });
      await checkpointHostRun(taskRun);
    }
    return { execution: orchestration.execution };
  }
}

export type RunHarborTrialsV1Options<Run> = {
  repositoryRoot?: string;
  harborExecutable?: string;
  dockerExecutable?: string;
  imageName?: string;
  keepWorkingDirectory?: boolean;
  /** A locally BUILT SharedOS checkout; see HarborBackendV1Options. */
  sharedOsDir?: string;
  /** Dataset-identity parameters (task-id gate, template, entrypoint args). */
  runtime: PactHarborDatasetRuntimeV1;
  config: PactRunConfigV1;
  tasks: readonly PactHarborPackagedTaskV1[];
  runId: string;
  environment: Record<string, string | undefined>;
  /** Durably records exact Harbor identity before any trial can be emitted. */
  onExecution?: (execution: PactRunExecutionMetadataV1) => Promise<void>;
  /**
   * Trust-boundary collection of the verifier artifacts back into host task
   * runs (collectHarborDatasetTaskRunsV1 with the dataset's artifact
   * collection descriptor).
   */
  collect(jobsDirectory: string): Promise<{
    taskRuns: Map<string, Run>;
    failures: Map<string, string>;
  }>;
  /** Optional dataset-specific streaming collector. */
  stream?(
    jobsDirectory: string,
    untilSettled: Promise<unknown>,
  ): Promise<ReadonlySet<string>>;
};

export type RunHarborTrialsV1Result<Run> = {
  execution: PactRunExecutionMetadataV1;
  taskRuns: Map<string, Run>;
  failures: Map<string, string>;
  /** Task ids whose host checkpoint callback completed during streaming. */
  emittedTaskIds: ReadonlySet<string>;
  /** Fallback message for selected tasks without a collected run. */
  missingMessage: string;
};

/**
 * Dataset-generic Harbor orchestration: version gate, runtime-only credential
 * preflight, SharedOS staging, image build + per-task tags, task-package
 * materialization through the dataset runtime, the `harbor run` invocation,
 * and artifact collection. Every dataset suite (PACT-Pair via
 * HarborBackendV1, PACT-Net via runPactNetTasksViaHarborV1) goes through this
 * one path; only the dataset runtime and the collection differ.
 */
export async function runHarborTrialsV1<Run>(
  options: RunHarborTrialsV1Options<Run>,
): Promise<RunHarborTrialsV1Result<Run>> {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const harborExecutable = options.harborExecutable ?? 'harbor';
  const dockerExecutable = options.dockerExecutable ?? 'docker';
  const imageName = options.imageName ?? PACT_HARBOR_IMAGE_V1;
  const workingDirectory = await mkdtemp(join(tmpdir(), 'pact-harbor-'));
  const datasetDirectory = join(workingDirectory, 'tasks');
  const jobsDirectory = join(workingDirectory, 'jobs');
  let commandFailure: unknown;
  let collected = new Map<string, Run>();
  let trialFailures = new Map<string, string>();
  let emittedTaskIds: ReadonlySet<string> = new Set();
  const execution: PactRunExecutionMetadataV1 = {
    backend: 'harbor',
    // Scripted parity packages never call a model; real-model packages run
    // the caller-configured model inside the container. The artifact must
    // say which one actually produced the decisions.
    executor: pactHarborScriptedModelV1(options.config.model)
      ? 'scripted-harness'
      : 'model',
    harbor: {
      version: PACT_HARBOR_VERSION_V1,
      image: imageName,
    },
  };

  try {
    // Fail closed on any orchestrator drift: the task packages encode
    // v0.5.0 semantics (allow_internet, verifier layout), so an unknown or
    // different Harbor version must not run trials at all.
    await assertCompatibleHarborVersion(
      harborExecutable,
      repositoryRoot,
      options.environment,
    );
    // Harbor resolves task-package env templates from its own process
    // environment; the subprocess below inherits process.env overlaid with
    // options.environment, so check the same view here.
    const runtimeEnvironment: Record<string, string | undefined> = {
      ...process.env,
      ...options.environment,
    };
    const scriptedRun = pactHarborScriptedModelV1(options.config.model);
    if (!scriptedRun && !runtimeEnvironment[PACT_MODEL_API_KEY_ENV_V1]?.trim()) {
      // O-003 decision 1: the credential is injected runtime-only through
      // Harbor's env resolution, so a real-model run needs it on the host.
      // Failing here beats one opaque per-trial resolution failure later.
      throw new Error(
        `Model credential environment variable ${PACT_MODEL_API_KEY_ENV_V1} `
        + 'is not set. Harbor injects it into containers at runtime only '
        + '(never via the task package or image), so real-model Harbor runs '
        + 'require it in the host environment.',
      );
    }
    // Stage the prebuilt SharedOS checkout into the Docker build context so
    // the image COPY below carries it (no in-container clone/build). The
    // staged commit is recorded in every task package for provenance.
    const stagedSharedOs = await stageSharedOsBuildV1({
      sharedOsDir: options.sharedOsDir
        ?? defaultHostSharedOsDirV1(repositoryRoot, runtimeEnvironment),
      stageDirectory: pactHarborSharedOsStageDirV1(repositoryRoot),
    });
    await runExternalCommand(
      dockerExecutable,
      [
        'build',
        '--file',
        join(repositoryRoot, 'harbor', 'environment', 'Dockerfile'),
        '--tag',
        imageName,
        repositoryRoot,
      ],
      repositoryRoot,
      options.environment,
    );
    const imageId = (await runExternalCommand(
      dockerExecutable,
      ['image', 'inspect', '--format', '{{.Id}}', imageName],
      repositoryRoot,
      options.environment,
    )).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId) || !execution.harbor) {
      throw new Error(
        `Docker returned an invalid immutable image identity for ${imageName}`,
      );
    }
    execution.harbor.imageId = imageId;
    await options.onExecution?.(structuredClone(execution));
    await mapWithConcurrencyV1(
      [...options.tasks],
      HARBOR_IMAGE_TAG_CONCURRENCY_V1,
      task => runExternalCommand(
        dockerExecutable,
        [
          'image',
          'tag',
          imageName,
          harborTaskImageName(imageName, task.taskId),
        ],
        repositoryRoot,
        options.environment,
      ),
    );
    await materializeHarborDatasetV1({
      datasetDirectory,
      templateDirectory: pactHarborTemplateDirectoryV1(
        repositoryRoot,
        options.runtime,
      ),
      imageName,
      config: options.config,
      tasks: options.tasks,
      runtime: options.runtime,
      sharedOsCommit: stagedSharedOs.commit,
      sharedOsRuntimeDigest: stagedSharedOs.runtimeDigest,
    });
    try {
      const harborRun = runExternalCommand(
        harborExecutable,
        [
          'run',
          '--path',
          datasetDirectory,
          '--agent',
          'oracle',
          '--jobs-dir',
          jobsDirectory,
          '--job-name',
          safeJobName(options.runId),
          '--n-concurrent',
          String(options.config.backend?.kind === 'harbor'
            ? options.config.backend.concurrency
            : 4),
          '--max-retries',
          '0',
          '--yes',
          '--quiet',
        ],
        repositoryRoot,
        options.environment,
      );
      if (options.stream) {
        emittedTaskIds = await options.stream(jobsDirectory, harborRun);
      }
      await harborRun;
    } catch (error) {
      commandFailure = error;
    }
    ({ taskRuns: collected, failures: trialFailures } =
      await options.collect(jobsDirectory));
  } catch (error) {
    commandFailure = error;
  } finally {
    if (!(options.keepWorkingDirectory ?? false)) {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  return {
    execution,
    taskRuns: collected,
    failures: trialFailures,
    emittedTaskIds,
    missingMessage: commandFailure
      ? commandErrorMessage(commandFailure)
      : 'Harbor completed without a canonical PACT result artifact',
  };
}

export type StreamHarborTrialsV1Options = {
  jobsDirectory: string;
  tasks: LoadedPactPairTaskV1[];
  /** Settles (resolve or reject) when the `harbor run` command exits. */
  untilSettled: Promise<unknown>;
  pollIntervalMs: number;
  /** Authoritative host run id used to rebind container-local trace ids. */
  runId?: string;
  onTaskRun?: (taskRun: PactExecutionTaskRunV1) => Promise<void>;
};

/**
 * Streams settled PACT-Pair trials to the host while Harbor is still running.
 * Filesystem collection races are retried by polling. A rejected host
 * checkpoint remains un-emitted so a later poll (or the final sweep) retries
 * publication instead of silently losing the trial.
 */
export async function streamHarborTrialsV1(
  options: StreamHarborTrialsV1Options,
): Promise<Set<string>> {
  const emitted = new Set<string>();
  let running = true;
  const settled = options.untilSettled.then(
    () => { running = false; },
    () => { running = false; },
  );
  while (running) {
    await settledOrDelay(settled, options.pollIntervalMs);
    if (!running) break;
    let trials: Map<string, PactExecutionTaskRunV1>;
    try {
      trials = await collectSettledHarborTrialsV1(
        options.jobsDirectory,
        options.tasks,
        emitted,
      );
    } catch {
      continue;
    }
    for (const task of options.tasks) {
      const trial = trials.get(task.taskId);
      if (!trial || emitted.has(task.taskId)) continue;
      try {
        await options.onTaskRun?.(options.runId
          ? bindPactPairTraceToHostRun(trial, options.runId)
          : trial);
      } catch {
        continue;
      }
      emitted.add(task.taskId);
    }
  }
  return emitted;
}

function bindPactPairTraceToHostRun(
  taskRun: PactExecutionTaskRunV1,
  runId: string,
): PactExecutionTaskRunV1 {
  return {
    ...taskRun,
    trace: taskRun.trace.map(event => ({ ...event, runId })),
  };
}

async function settledOrDelay(
  settled: Promise<unknown>,
  delayMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>(resolve => { timer = setTimeout(resolve, delayMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertCompatibleHarborVersion(
  harborExecutable: string,
  repositoryRoot: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  let output: string;
  try {
    output = await runExternalCommand(
      harborExecutable,
      ['--version'],
      repositoryRoot,
      environment,
    );
  } catch (error) {
    throw new Error(
      `Unable to determine the Harbor version (need ${PACT_HARBOR_VERSION_V1}): ${
        commandErrorMessage(error)
      }`,
    );
  }
  const version = /\d+\.\d+\.\d+(?:[.\w-]*)?/.exec(output)?.[0];
  if (version !== PACT_HARBOR_VERSION_V1) {
    throw new Error(
      `Unsupported Harbor version ${version ?? '(unknown)'}; this backend requires exactly ${PACT_HARBOR_VERSION_V1} (its task packages depend on v0.5.0 network-isolation semantics)`,
    );
  }
}

/** One metric row as reported by (and recomputed for) a Harbor trial. */
export type PactHarborMetricRowV1 = {
  metric: string;
  numerator: number;
  denominator: number;
};

/**
 * Dataset-specific trust-boundary parameters for collecting Harbor verifier
 * artifacts: the strict artifact schemas, the gold cross-check against the
 * host-loaded task, and the host-side metric recomputation. Owned by the
 * suite layer next to the dataset's own artifact types.
 */
export type PactHarborArtifactCollectionV1<
  Task extends PactHarborPackagedTaskV1,
  ResultRow extends PactHarborPackagedTaskV1,
  TraceEvent,
  Evaluation,
> = {
  resultSchema: { parse(value: unknown): ResultRow };
  traceEventSchema: { parse(value: unknown): TraceEvent };
  evaluationRecordSchema: {
    parse(value: unknown): {
      taskId: string;
      evaluation: unknown;
      metrics: PactHarborMetricRowV1[];
    };
  };
  /** Fail closed when the container's evaluation contradicts host gold. */
  assertEvaluationMatchesHostTask(evaluation: Evaluation, task: Task): void;
  /** Host-side recomputation of the evaluation's metric contributions. */
  metricContributions(evaluation: Evaluation): readonly PactHarborMetricRowV1[];
};

export type PactHarborCollectedTaskRunV1<ResultRow, TraceEvent, Evaluation> = {
  result: ResultRow;
  trace: TraceEvent[];
  evaluation: Evaluation;
  evaluationResult: {
    metrics: readonly PactHarborMetricRowV1[];
    details: Evaluation;
  };
};

/**
 * The PACT-Pair artifact collection: schemas from runner/v1/artifacts.ts, the
 * pair gold cross-check, and the pair metric recomputation.
 */
const PACT_PAIR_HARBOR_ARTIFACT_COLLECTION_V1: PactHarborArtifactCollectionV1<
  LoadedPactPairTaskV1,
  PactTaskResultV1,
  PactTraceEventV1,
  PactPairEvaluationV1
> = {
  resultSchema: {
    parse: value => pactTaskResultV1Schema.parse(value) as PactTaskResultV1,
  },
  traceEventSchema: {
    parse: value => pactTraceEventV1Schema.parse(value) as PactTraceEventV1,
  },
  evaluationRecordSchema: pactTaskEvaluationRecordV1Schema,
  assertEvaluationMatchesHostTask,
  metricContributions: pactPairMetricContributionsV1,
};

/**
 * Collects Harbor verifier artifacts back into host task runs. Fault isolation
 * and trust are per task:
 *
 * - one malformed or inconsistent artifact only fails its own task; every
 *   other valid result is still collected;
 * - the container-reported evaluation is cross-checked against the host-loaded
 *   task (kind and expected behaviors) and its metric contributions are
 *   recomputed on the host from the evaluation itself — a container cannot
 *   inject arbitrary metric rows into the run summary.
 */
export async function collectHarborTaskRunsV1(
  jobsDirectory: string,
  tasks: LoadedPactPairTaskV1[],
  options: { only?: ReadonlySet<string> } = {},
): Promise<{
  taskRuns: Map<string, PactExecutionTaskRunV1>;
  failures: Map<string, string>;
}> {
  // The generic collected shape is structurally a PactPairSingleTaskRunV1.
  return collectHarborDatasetTaskRunsV1(
    jobsDirectory,
    tasks,
    PACT_PAIR_HARBOR_ARTIFACT_COLLECTION_V1,
    options,
  );
}

/**
 * Collects only trials with Harbor's settled `result.json` marker, excluding
 * task ids the host has already checkpointed successfully.
 */
export async function collectSettledHarborTrialsV1(
  jobsDirectory: string,
  tasks: LoadedPactPairTaskV1[],
  alreadyEmitted: ReadonlySet<string>,
): Promise<Map<string, PactExecutionTaskRunV1>> {
  const taskIdByDirectory = new Map(tasks.map(task => [
    task.taskId.toLocaleLowerCase('en-US'),
    task.taskId,
  ] as const));
  const markers = await findNamedFiles(jobsDirectory, 'result.json');
  const settled = new Set<string>();
  for (const marker of markers) {
    const taskId = taskIdFromArtifactPath(marker, taskIdByDirectory);
    if (taskId && !alreadyEmitted.has(taskId)) settled.add(taskId);
  }
  if (settled.size === 0) return new Map();
  const { taskRuns } = await collectHarborTaskRunsV1(
    jobsDirectory,
    tasks,
    { only: settled },
  );
  return taskRuns;
}

/**
 * Dataset-generic Harbor artifact collection (the trust-boundary walk shared
 * by every dataset suite). All dataset-specific validation flows through the
 * collection descriptor; the per-task fault isolation, path/duplicate checks,
 * exactly-one-evaluation rule, and metric-row verification are identical for
 * every dataset.
 */
export async function collectHarborDatasetTaskRunsV1<
  Task extends PactHarborPackagedTaskV1,
  ResultRow extends PactHarborPackagedTaskV1,
  TraceEvent,
  Evaluation,
>(
  jobsDirectory: string,
  tasks: readonly Task[],
  collection: PactHarborArtifactCollectionV1<Task, ResultRow, TraceEvent, Evaluation>,
  options: { only?: ReadonlySet<string> } = {},
): Promise<{
  taskRuns: Map<string, PactHarborCollectedTaskRunV1<ResultRow, TraceEvent, Evaluation>>;
  failures: Map<string, string>;
}> {
  const tasksById = new Map(tasks.map(task => [task.taskId, task] as const));
  const taskIdByDirectory = new Map(tasks.map(task => [
    task.taskId.toLocaleLowerCase('en-US'),
    task.taskId,
  ] as const));
  const collected = new Map<
    string,
    PactHarborCollectedTaskRunV1<ResultRow, TraceEvent, Evaluation>
  >();
  const failures = new Map<string, string>();
  const recordFailure = (taskId: string | undefined, message: string) => {
    if (!taskId) return;
    const existing = failures.get(taskId);
    failures.set(taskId, existing ? `${existing}\n${message}` : message);
  };

  const artifactPaths = await findNamedFiles(jobsDirectory, 'pact-result.json');
  for (const artifactPath of artifactPaths) {
    const pathTaskId = taskIdFromArtifactPath(artifactPath, taskIdByDirectory);
    if (options.only && (!pathTaskId || !options.only.has(pathTaskId))) continue;
    let taskId = pathTaskId;
    try {
      const result = collection.resultSchema.parse(
        JSON.parse(await readFile(artifactPath, 'utf8')),
      );
      taskId = result.taskId;
      const task = tasksById.get(result.taskId);
      if (!task) {
        throw new Error(
          `Harbor emitted a PACT result for unselected task ${result.taskId}`,
        );
      }
      if (pathTaskId && pathTaskId !== result.taskId) {
        throw new Error(
          `Harbor artifact for ${pathTaskId} claims task ${result.taskId}`,
        );
      }
      if (collected.has(result.taskId)) {
        throw new Error(`Harbor emitted duplicate PACT result for ${result.taskId}`);
      }
      const tracePath = join(dirname(artifactPath), 'trace.jsonl');
      const trace = await readJsonLines(tracePath, collection.traceEventSchema);
      // The container appends one evaluation.jsonl record per trial; each
      // container runs exactly one task, so exactly one record must match.
      const evaluationRecords = await readJsonLines(
        join(dirname(artifactPath), 'evaluation.jsonl'),
        collection.evaluationRecordSchema,
      );
      const evaluationRecord = evaluationRecords.find(record =>
        record.taskId === result.taskId);
      if (!evaluationRecord || evaluationRecords.length !== 1) {
        throw new Error(
          `Harbor emitted ${evaluationRecords.length} evaluation records for ${result.taskId}; expected exactly one`,
        );
      }
      const evaluation = evaluationRecord.evaluation as Evaluation;
      collection.assertEvaluationMatchesHostTask(evaluation, task);
      // Recompute the metric contributions on the host from the evaluation.
      // The container's own metric rows are validated against the recomputed
      // values and then discarded — only host-derived contributions enter the
      // run summary.
      const recomputedMetrics = collection.metricContributions(evaluation);
      assertMetricsMatch(
        result.taskId,
        recomputedMetrics,
        evaluationRecord.metrics,
      );
      collected.set(result.taskId, {
        result,
        trace,
        evaluation,
        evaluationResult: {
          metrics: recomputedMetrics,
          details: evaluation,
        },
      });
    } catch (error) {
      recordFailure(
        taskId,
        `Harbor returned an invalid trial artifact: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const resultPaths = await findNamedFiles(jobsDirectory, 'result.json');
  for (const resultPath of resultPaths) {
    let value: {
      task_id?: { path?: unknown };
      exception_info?: {
        exception_message?: unknown;
        exception_traceback?: unknown;
      } | null;
    };
    try {
      value = JSON.parse(await readFile(resultPath, 'utf8')) as typeof value;
    } catch {
      // A malformed Harbor trial record only loses that trial's failure
      // detail; affected tasks still fall back to the generic backend error.
      continue;
    }
    const taskPath = value.task_id?.path;
    const taskId = typeof taskPath === 'string'
      ? taskIdByDirectory.get(basename(taskPath))
      : undefined;
    if (!taskId || collected.has(taskId) || !value.exception_info) continue;
    if (options.only && !options.only.has(taskId)) continue;
    const message = value.exception_info.exception_message;
    const traceback = value.exception_info.exception_traceback;
    recordFailure(taskId, [message, traceback]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n'));
  }
  return { taskRuns: collected, failures };
}

function taskIdFromArtifactPath(
  artifactPath: string,
  taskIdByDirectory: Map<string, string>,
): string | undefined {
  for (const segment of artifactPath.split(sep)) {
    const normalized = segment.toLocaleLowerCase('en-US');
    const direct = taskIdByDirectory.get(normalized);
    if (direct) return direct;
    // Harbor trial directories may suffix the task name (for example
    // `pair-q1__<uuid>`); match on the leading task-directory component.
    const prefix = normalized.split('__')[0];
    if (prefix) {
      const byPrefix = taskIdByDirectory.get(prefix);
      if (byPrefix) return byPrefix;
    }
  }
  return undefined;
}

function assertEvaluationMatchesHostTask(
  evaluation: PactPairEvaluationV1,
  task: LoadedPactPairTaskV1,
): void {
  if (evaluation.kind !== task.kind) {
    throw new Error(
      `Harbor evaluation kind ${evaluation.kind} does not match host task kind ${task.kind} for ${task.taskId}`,
    );
  }
  if (evaluation.expectedBehavior !== task.expectedBehavior) {
    throw new Error(
      `Harbor evaluation expectedBehavior ${evaluation.expectedBehavior} does not match host gold ${task.expectedBehavior} for ${task.taskId}`,
    );
  }
  if (
    evaluation.kind === 'qa'
    && task.kind === 'qa'
    && evaluation.benchmarkExpectedBehavior !== task.benchmarkExpectedBehavior
  ) {
    throw new Error(
      `Harbor evaluation benchmarkExpectedBehavior ${evaluation.benchmarkExpectedBehavior} does not match host gold ${task.benchmarkExpectedBehavior} for ${task.taskId}`,
    );
  }
}

function assertMetricsMatch(
  taskId: string,
  recomputed: readonly { metric: string; numerator: number; denominator: number }[],
  reported: readonly { metric: string; numerator: number; denominator: number }[],
): void {
  const key = (rows: readonly { metric: string; numerator: number; denominator: number }[]) =>
    JSON.stringify([...rows]
      .map(row => [row.metric, row.numerator, row.denominator])
      .sort());
  if (key(recomputed) !== key(reported)) {
    throw new Error(
      `Harbor container metric contributions do not match the host recomputation for ${taskId}`,
    );
  }
}

async function findNamedFiles(
  directory: string,
  fileName: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findNamedFiles(entryPath, fileName));
    } else if (entry.isFile() && entry.name === fileName) {
      found.push(entryPath);
    }
  }
  return found;
}

async function readJsonLines<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  const source = await readFile(path, 'utf8');
  return source
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => schema.parse(JSON.parse(line)));
}

async function runExternalCommand(
  executable: string,
  args: string[],
  cwd: string,
  environment: Record<string, string | undefined>,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-2_000_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', error => reject(new PactBackendCommandError(
      `${executable} could not be started: ${error.message}`,
      output,
    )));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new PactBackendCommandError(
        `${executable} exited with ${signal ? `signal ${signal}` : `status ${String(code)}`}`,
        output,
      ));
    });
  });
}

class PactBackendCommandError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
    this.name = 'PactBackendCommandError';
  }
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof PactBackendCommandError) {
    return `${error.message}\n${error.output}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function safeJobName(runId: string): string {
  return `pact-${runId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
}
