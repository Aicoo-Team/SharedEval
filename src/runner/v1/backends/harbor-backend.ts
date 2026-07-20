import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pactTaskResultV1Schema,
  pactTraceEventV1Schema,
  type PactTaskResultV1,
  type PactTraceEventV1,
} from '../artifacts.js';
import {
  toPublicPactPairEvaluationV1,
} from '../environment.js';
import { evaluatePactPairTaskV1 } from '../evaluator.js';
import type { LoadedPactPairTaskV1 } from '../task-loader.js';
import { createPactPairWorkspaceV1 } from '../workspace.js';
import type {
  ExecutionBackendV1,
  PactExecutionBackendRunContextV1,
  PactExecutionBackendRunResultV1,
  PactExecutionTaskRunV1,
} from './execution-backend.js';
import {
  harborTaskImageName,
  materializeHarborDatasetV1,
} from './harbor-task-package.js';

const defaultRepositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

export const PACT_HARBOR_VERSION_V1 = '0.5.0' as const;
export const PACT_HARBOR_IMAGE_V1 = 'pact-bench-harbor:p0' as const;
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
};

/**
 * P0 coarse bridge: Harbor orchestrates one Node container per task while the
 * container runs the authoritative PactEnvironmentV1 with a scripted harness.
 */
export class HarborBackendV1 implements ExecutionBackendV1 {
  readonly kind = 'harbor' as const;
  private readonly repositoryRoot: string;
  private readonly harborExecutable: string;
  private readonly dockerExecutable: string;
  private readonly imageName: string;
  private readonly keepWorkingDirectory: boolean;

  constructor(options: HarborBackendV1Options = {}) {
    this.repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
    this.harborExecutable = options.harborExecutable ?? 'harbor';
    this.dockerExecutable = options.dockerExecutable ?? 'docker';
    this.imageName = options.imageName ?? PACT_HARBOR_IMAGE_V1;
    this.keepWorkingDirectory = options.keepWorkingDirectory ?? false;
  }

  async run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1> {
    const unsupported = context.tasks.filter(task =>
      !PACT_HARBOR_SMOKE_TASK_IDS_V1.includes(
        task.taskId as typeof PACT_HARBOR_SMOKE_TASK_IDS_V1[number],
      ));
    if (unsupported.length > 0) {
      const message = `P0 Harbor backend supports only the six-task smoke set; unsupported: ${unsupported.map(task => task.taskId).join(', ')}`;
      return {
        taskRuns: context.tasks.map(task => backendErrorRun(context, task, message)),
      };
    }

    const workingDirectory = await mkdtemp(join(tmpdir(), 'pact-harbor-'));
    const datasetDirectory = join(workingDirectory, 'tasks');
    const jobsDirectory = join(workingDirectory, 'jobs');
    let commandFailure: unknown;
    let collected = new Map<string, PactExecutionTaskRunV1>();
    let trialFailures = new Map<string, string>();

    try {
      await runExternalCommand(
        this.dockerExecutable,
        [
          'build',
          '--file',
          join(this.repositoryRoot, 'harbor', 'environment', 'Dockerfile'),
          '--tag',
          this.imageName,
          this.repositoryRoot,
        ],
        this.repositoryRoot,
        context.environment,
      );
      await Promise.all(context.tasks.map(task => runExternalCommand(
        this.dockerExecutable,
        [
          'image',
          'tag',
          this.imageName,
          harborTaskImageName(this.imageName, task.taskId),
        ],
        this.repositoryRoot,
        context.environment,
      )));
      await materializeHarborDatasetV1({
        datasetDirectory,
        templateDirectory: join(this.repositoryRoot, 'harbor', 'task-template'),
        imageName: this.imageName,
        config: context.config,
        tasks: context.tasks,
      });
      try {
        await runExternalCommand(
          this.harborExecutable,
          [
            'run',
            '--path',
            datasetDirectory,
            '--agent',
            'oracle',
            '--jobs-dir',
            jobsDirectory,
            '--job-name',
            safeJobName(context.runId),
            '--n-concurrent',
            String(context.config.backend?.kind === 'harbor'
              ? context.config.backend.concurrency
              : 4),
            '--max-retries',
            '0',
            '--yes',
            '--quiet',
          ],
          this.repositoryRoot,
          context.environment,
        );
      } catch (error) {
        commandFailure = error;
      }
      ({ taskRuns: collected, failures: trialFailures } =
        await collectHarborTaskRuns(jobsDirectory, context.tasks));
    } catch (error) {
      commandFailure = error;
    } finally {
      if (!this.keepWorkingDirectory) {
        await rm(workingDirectory, { recursive: true, force: true });
      }
    }

    const missingMessage = commandFailure
      ? commandErrorMessage(commandFailure)
      : 'Harbor completed without a canonical PACT result artifact';
    return {
      taskRuns: context.tasks.map(task =>
        collected.get(task.taskId)
        ?? backendErrorRun(
          context,
          task,
          trialFailures.get(task.taskId) ?? missingMessage,
        )),
    };
  }
}

async function collectHarborTaskRuns(
  jobsDirectory: string,
  tasks: LoadedPactPairTaskV1[],
): Promise<{
  taskRuns: Map<string, PactExecutionTaskRunV1>;
  failures: Map<string, string>;
}> {
  const artifactPaths = await findNamedFiles(jobsDirectory, 'pact-result.json');
  const collected = new Map<string, PactExecutionTaskRunV1>();
  for (const artifactPath of artifactPaths) {
    const result = pactTaskResultV1Schema.parse(
      JSON.parse(await readFile(artifactPath, 'utf8')),
    );
    if (collected.has(result.taskId)) {
      throw new Error(`Harbor emitted duplicate PACT result for ${result.taskId}`);
    }
    const tracePath = join(dirname(artifactPath), 'trace.jsonl');
    const trace = await readJsonLines(tracePath, pactTraceEventV1Schema);
    collected.set(result.taskId, { result, trace });
  }
  const taskIdByDirectory = new Map(tasks.map(task => [
    task.taskId.toLocaleLowerCase('en-US'),
    task.taskId,
  ] as const));
  const failures = new Map<string, string>();
  const resultPaths = await findNamedFiles(jobsDirectory, 'result.json');
  for (const resultPath of resultPaths) {
    const value = JSON.parse(await readFile(resultPath, 'utf8')) as {
      task_id?: { path?: unknown };
      exception_info?: {
        exception_message?: unknown;
        exception_traceback?: unknown;
      } | null;
    };
    const taskPath = value.task_id?.path;
    const taskId = typeof taskPath === 'string'
      ? taskIdByDirectory.get(basename(taskPath))
      : undefined;
    if (!taskId || !value.exception_info) continue;
    const message = value.exception_info.exception_message;
    const traceback = value.exception_info.exception_traceback;
    failures.set(taskId, [message, traceback]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n'));
  }
  return { taskRuns: collected, failures };
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

function backendErrorRun(
  context: PactExecutionBackendRunContextV1,
  task: LoadedPactPairTaskV1,
  rawMessage: string,
): PactExecutionTaskRunV1 {
  const message = rawMessage.slice(-2_000) || 'Unknown Harbor backend error';
  const workspace = createPactPairWorkspaceV1(context.seed);
  const before = workspace.snapshot();
  const after = workspace.snapshot();
  const finalDecision = {
    type: 'escalate' as const,
    reason: 'The Harbor execution backend could not complete this trial.',
  };
  const evaluation = evaluatePactPairTaskV1({
    task,
    decision: finalDecision,
    before,
    after,
  });
  const result: PactTaskResultV1 = {
    taskId: task.taskId,
    kind: task.kind,
    publicTask: task.publicTask,
    finalDecision,
    grantedAccess: {
      access: {
        notes: { read: { scope: 'none' }, write: false },
        todos: { read: false, write: false },
        memory: { read: 'none', write: false },
      },
    },
    evaluation: toPublicPactPairEvaluationV1(evaluation),
    budgetUsed: { turns: 0, toolCalls: 0, runtimeMs: 0 },
    toolCalls: [],
    violations: ['backend_error'],
    error: message,
  };
  const trace: PactTraceEventV1[] = context.config.output.saveTraces
    ? [{
        at: context.now().toISOString(),
        runId: context.runId,
        taskId: task.taskId,
        event: 'backend_error',
        data: { message },
      }]
    : [];
  return { result, trace };
}

async function runExternalCommand(
  executable: string,
  args: string[],
  cwd: string,
  environment: Record<string, string | undefined>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
        resolve();
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
