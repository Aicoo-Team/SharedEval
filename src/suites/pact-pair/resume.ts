import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  pactRunMetadataV1Schema,
  pactTaskCommitV1Schema,
  pactTaskEvaluationRecordV1Schema,
  pactTaskResultV1Schema,
  pactTraceEventV1Schema,
  type PactRunMetadataV1,
  type PactTaskCommitV1,
} from '../../runner/v1/artifacts.js';
import { pactPairMetricContributionsV1 } from './evaluation.js';
import type { PactPairEvaluationV1 } from './evaluator.js';
import type {
  PactPairSingleTaskRunV1,
  PactPairTaskResultV1,
} from './environment.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';

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
const PACT_TASK_COMMIT_DIRECTORY_V1 = 'task-commits';
const PACT_RUN_WRITER_LOCK_V1 = '.writer-lock';

export type PactPairRunWriterLockV1 = {
  release(): Promise<void>;
};

type WriterLockOwnerV1 = {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
};

/**
 * Acquires the run-directory single-writer lease. A live owner always wins;
 * a dead local-process owner is moved aside atomically before acquisition.
 * Corrupt or remote-host ownership fails closed with a removal diagnostic.
 */
export async function acquirePactPairRunWriterLockV1(
  runDirectory: string,
): Promise<PactPairRunWriterLockV1> {
  const lockDirectory = join(runDirectory, PACT_RUN_WRITER_LOCK_V1);
  const ownerPath = join(lockDirectory, 'owner.json');
  const owner: WriterLockOwnerV1 = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };

  for (;;) {
    try {
      await mkdir(lockDirectory);
      await atomicWriteFile(ownerPath, prettyJson(owner));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readWriterLockOwner(ownerPath, lockDirectory);
      if (existing.host !== owner.host || processIsAlive(existing.pid)) {
        throw new Error(
          `Cannot write run directory ${runDirectory}: active writer lock `
          + `owned by pid ${existing.pid} on ${existing.host} since `
          + `${existing.acquiredAt}`,
        );
      }
      const stalePath = `${lockDirectory}.stale-${randomUUID()}`;
      try {
        await rename(lockDirectory, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      let current: WriterLockOwnerV1;
      try {
        current = await readWriterLockOwner(ownerPath, lockDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (current.token !== owner.token) {
        throw new Error(
          `Refusing to release writer lock for ${runDirectory}: ownership changed`,
        );
      }
      await rm(lockDirectory, { recursive: true });
    },
  };
}

async function readWriterLockOwner(
  ownerPath: string,
  lockDirectory: string,
): Promise<WriterLockOwnerV1> {
  let source: string;
  try {
    source = await readFile(ownerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Cannot use run directory: writer lock ${lockDirectory} has no `
        + 'owner record; remove it only after confirming no writer is active',
      );
    }
    throw error;
  }
  try {
    const value = JSON.parse(source) as Partial<WriterLockOwnerV1>;
    if (
      !Number.isSafeInteger(value.pid)
      || Number(value.pid) <= 0
      || typeof value.host !== 'string'
      || typeof value.token !== 'string'
      || typeof value.acquiredAt !== 'string'
    ) throw new Error('invalid owner fields');
    return value as WriterLockOwnerV1;
  } catch (error) {
    throw new Error(
      `Cannot use run directory: writer lock owner at ${ownerPath} is `
      + `corrupt (${error instanceof Error ? error.message : String(error)}); `
      + 'remove the lock only after confirming no writer is active',
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * How a resumed run partitions the selected tasks against the prior run's
 * per-task checkpoint (`results.jsonl`):
 *
 * - `completedTaskIds` — a prior trial finished successfully, or failed in a
 *   way that is non-retryable or could have committed an action. These are
 *   NEVER re-executed: their recorded results are retained verbatim, so a
 *   resume cannot duplicate an action or best-of-N a task.
 * - `retryTaskIds` — the prior trial has explicit evidence of a transient
 *   failure before any tool action; the task is safe to re-run and replace.
 * - `missingTaskIds` — no prior result line exists (the run died before the
 *   trial finished); the task is run normally.
 */
export type PactPairResumeSelectionV1 = {
  completedTaskIds: string[];
  retryTaskIds: string[];
  missingTaskIds: string[];
};

export type PactPairResumeResultV1 = Pick<
  PactPairTaskResultV1,
  'taskId' | 'status'
> & Partial<Pick<
  PactPairTaskResultV1,
  'error' | 'finalizeError' | 'violations' | 'toolCalls'
>>;

const TRANSIENT_FAILURE_PATTERN_V1 =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|429|502|503|504|rate[ -]?limit|temporar(?:y|ily)|connection reset|timed? out)\b/i;
const NON_RETRYABLE_MODEL_FAILURE_PATTERN_V1 =
  /(?:returned no (?:tool )?decision|invalid tool arguments|mixed terminal and runner tool calls|selected an unavailable tool)/i;

/**
 * Conservative resume taxonomy. An infrastructure_error is terminal unless
 * the recorded evidence proves a transient failure occurred before any tool
 * action. This prevents resume from duplicating a possibly committed action.
 */
export function retryablePactPairFailureV1(
  result: PactPairResumeResultV1,
): boolean {
  if (result.status !== 'infrastructure_error') return false;
  if (result.finalizeError) return false;
  if ((result.toolCalls?.length ?? 0) > 0) return false;
  const violations = new Set(result.violations ?? []);
  if (
    violations.has('adapter_protocol_error')
    || violations.has('provider_configuration_error')
    || violations.has('max_runtime_ms_exceeded')
    || violations.has('max_turns_exceeded')
  ) return false;
  const message = result.error ?? '';
  if (NON_RETRYABLE_MODEL_FAILURE_PATTERN_V1.test(message)) return false;
  return TRANSIENT_FAILURE_PATTERN_V1.test(message);
}

/**
 * Pure resume selection: partitions the selected task ids using the prior
 * run's recorded results. A task with any `ok` result is completed even if an
 * older transient-error line is also present. A terminal failure also wins
 * over a retryable line. Prior results for tasks outside the current selection
 * are rejected — task-set identity has already been proven by digest.
 */
export function selectPactPairResumeTasksV1(
  taskIds: readonly string[],
  priorResults: readonly PactPairResumeResultV1[],
): PactPairResumeSelectionV1 {
  const selected = new Set(taskIds);
  const completed = new Set<string>();
  const retryable = new Set<string>();
  for (const result of priorResults) {
    if (!selected.has(result.taskId)) {
      throw new Error(
        `Cannot resume: prior results contain task ${result.taskId}, which is `
        + 'not part of the current task selection',
      );
    }
    if (result.status === 'ok' || !retryablePactPairFailureV1(result)) {
      completed.add(result.taskId);
    } else {
      retryable.add(result.taskId);
    }
  }
  const selection: PactPairResumeSelectionV1 = {
    completedTaskIds: [],
    retryTaskIds: [],
    missingTaskIds: [],
  };
  for (const taskId of taskIds) {
    if (completed.has(taskId)) selection.completedTaskIds.push(taskId);
    else if (retryable.has(taskId)) selection.retryTaskIds.push(taskId);
    else selection.missingTaskIds.push(taskId);
  }
  return selection;
}

export type PactPairResumeStateV1 = {
  /** The prior run's identity; the resumed run keeps it. */
  runId: string;
  startedAt: string;
  metadata: PactRunMetadataV1;
  selection: PactPairResumeSelectionV1;
  /**
   * Completed trials reconstructed from the checkpoint artifacts
   * (results.jsonl + private/evaluation.jsonl), in canonical task order.
   * Traces are not reloaded — they are only ever appended to trace.jsonl and
   * never re-enter the in-memory run.
   */
  retainedRuns: PactPairSingleTaskRunV1[];
};

export type LoadPactPairResumeStateV1Options = {
  runDirectory: string;
  tasks: readonly LoadedPactPairTaskV1[];
  /** Digest of the CURRENT run config; must match the prior run.json. */
  configDigest: string;
  /** Digest of the CURRENT task selection; must match the prior run.json. */
  taskSetDigest: string;
};

export type CommitPactPairTaskRunV1Options = {
  runDirectory: string;
  taskRun: PactPairSingleTaskRunV1;
  saveTraces: boolean;
  checkpoint: {
    completedTasks: number;
    selectedTasks: number;
    errors: number;
  };
};

/**
 * Prepares and commits one already-executed task before publishing any of its
 * canonical artifacts. Publication rewrites each artifact by task id, so a
 * callback retry finishes or observes the same commit without appending a
 * second row.
 */
export async function commitPactPairTaskRunV1(
  options: CommitPactPairTaskRunV1Options,
): Promise<void> {
  const commit = pactTaskCommitV1Schema.parse({
    apiVersion: 'pact-task-commit/v1',
    taskId: options.taskRun.result.taskId,
    result: options.taskRun.result,
    evaluation: {
      taskId: options.taskRun.result.taskId,
      evaluation: options.taskRun.evaluation,
      metrics: options.taskRun.evaluationResult.metrics,
    },
    trace: options.taskRun.trace,
  }) as PactTaskCommitV1;
  const durableCommit = options.saveTraces
    ? await persistTaskCommit(options.runDirectory, commit)
    : commit;
  await publishCommittedTaskArtifacts(
    options.runDirectory,
    durableCommit,
    options.saveTraces,
  );
  await atomicWriteFile(join(options.runDirectory, 'checkpoint.json'), prettyJson({
    status: 'running',
    completedTasks: options.checkpoint.completedTasks,
    selectedTasks: options.checkpoint.selectedTasks,
    lastTaskId: durableCommit.taskId,
    errors: options.checkpoint.errors,
  }));
}

async function persistTaskCommit(
  runDirectory: string,
  commit: PactTaskCommitV1,
): Promise<PactTaskCommitV1> {
  const directory = taskCommitDirectory(runDirectory);
  await mkdir(directory, { recursive: true });
  const committedPath = taskCommitPath(directory, commit.taskId);
  const preparedPath = join(
    directory,
    `${taskCommitDigest(commit.taskId)}.${randomUUID()}.prepared.json`,
  );
  await writeDurably(preparedPath, prettyJson(commit));
  try {
    await link(preparedPath, committedPath);
    return commit;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readTaskCommit(committedPath);
    assertSameTaskCommit(existing, commit, committedPath);
    return existing;
  } finally {
    await unlink(preparedPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function recoverTaskCommits(
  runDirectory: string,
): Promise<Map<string, PactTaskCommitV1>> {
  const directory = taskCommitDirectory(runDirectory);
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter(name => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const commits = new Map<string, PactTaskCommitV1>();
  const pathsByTask = new Map<string, string[]>();
  for (const entry of entries.sort()) {
    const path = join(directory, entry);
    const commit = await readTaskCommit(path);
    const existing = commits.get(commit.taskId);
    if (existing) assertSameTaskCommit(existing, commit, path);
    else commits.set(commit.taskId, commit);
    const paths = pathsByTask.get(commit.taskId) ?? [];
    paths.push(path);
    pathsByTask.set(commit.taskId, paths);
  }
  for (const [taskId, commit] of commits) {
    const committedPath = taskCommitPath(directory, taskId);
    const sourcePath = pathsByTask.get(taskId)?.[0];
    if (!sourcePath) continue;
    if (!pathsByTask.get(taskId)?.includes(committedPath)) {
      try {
        await link(sourcePath, committedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertSameTaskCommit(await readTaskCommit(committedPath), commit, committedPath);
      }
    }
    for (const path of pathsByTask.get(taskId) ?? []) {
      if (path !== committedPath) await unlink(path);
    }
  }
  return commits;
}

async function readTaskCommit(path: string): Promise<PactTaskCommitV1> {
  try {
    return pactTaskCommitV1Schema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    ) as PactTaskCommitV1;
  } catch (error) {
    throw new Error(
      `Cannot recover task commit at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertSameTaskCommit(
  left: PactTaskCommitV1,
  right: PactTaskCommitV1,
  path: string,
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `Conflicting committed outcomes for task ${right.taskId} at ${path}; `
      + 'refusing to overwrite an already-executed model action',
    );
  }
}

async function publishCommittedTaskArtifacts(
  runDirectory: string,
  commit: PactTaskCommitV1,
  saveTraces: boolean,
): Promise<void> {
  await rewriteTaskJsonLinesFile(
    join(runDirectory, 'results.jsonl'),
    commit.taskId,
    [commit.result],
    line => (pactTaskResultV1Schema.parse(JSON.parse(line)) as PactPairTaskResultV1).taskId,
    'results.jsonl',
  );
  if (!saveTraces) return;
  const privateDirectory = join(
    runDirectory,
    PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
  );
  await rewriteTaskJsonLinesFile(
    join(privateDirectory, 'evaluation.jsonl'),
    commit.taskId,
    [commit.evaluation],
    line => pactTaskEvaluationRecordV1Schema.parse(JSON.parse(line)).taskId,
    'private/evaluation.jsonl',
  );
  await rewriteTaskJsonLinesFile(
    join(privateDirectory, 'trace.jsonl'),
    commit.taskId,
    commit.trace,
    line => pactTraceEventV1Schema.parse(JSON.parse(line)).taskId,
    'private/trace.jsonl',
  );
}

async function rewriteTaskJsonLinesFile(
  path: string,
  taskId: string,
  replacement: readonly unknown[],
  taskIdFromLine: (line: string) => string | undefined,
  label: string,
): Promise<void> {
  let source = '';
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const replacementLines = replacement.map(value => JSON.stringify(value));
  const next: string[] = [];
  let replaced = false;
  for (const [index, line] of source
    .split('\n')
    .filter(candidate => candidate.trim().length > 0)
    .entries()) {
    let lineTaskId: string | undefined;
    try {
      lineTaskId = taskIdFromLine(line);
    } catch (error) {
      throw new Error(
        `Cannot publish task ${taskId}: ${label} line ${index + 1} is `
        + `invalid (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (lineTaskId === taskId) {
      if (!replaced) next.push(...replacementLines);
      replaced = true;
    } else {
      next.push(line);
    }
  }
  if (!replaced) next.push(...replacementLines);
  await atomicWriteFile(path, next.length > 0 ? `${next.join('\n')}\n` : '');
}

export type CanonicalizePactPairRunArtifactsV1Options = {
  runDirectory: string;
  /** Canonical host task-selection order for every task-bearing artifact. */
  taskIds: readonly string[];
  saveTraces: boolean;
};

/**
 * Atomically rewrites each task-bearing artifact into host selection order.
 * Streaming backends may publish completed tasks in any order; run.json and
 * checkpoint.json remain `running` until all of these rewrites finish. A
 * crash between rewrites is therefore recovered by the next resume before
 * that process marks the run completed.
 */
export async function canonicalizePactPairRunArtifactsV1(
  options: CanonicalizePactPairRunArtifactsV1Options,
): Promise<void> {
  await canonicalizeTaskJsonLinesFile(
    join(options.runDirectory, 'results.jsonl'),
    options.taskIds,
    line => (pactTaskResultV1Schema.parse(JSON.parse(line)) as PactPairTaskResultV1).taskId,
    'results.jsonl',
    true,
  );
  if (!options.saveTraces) return;
  const privateDirectory = join(
    options.runDirectory,
    PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
  );
  await canonicalizeTaskJsonLinesFile(
    join(privateDirectory, 'evaluation.jsonl'),
    options.taskIds,
    line => pactTaskEvaluationRecordV1Schema.parse(JSON.parse(line)).taskId,
    'private/evaluation.jsonl',
    true,
  );
  await canonicalizeTaskJsonLinesFile(
    join(privateDirectory, 'trace.jsonl'),
    options.taskIds,
    line => pactTraceEventV1Schema.parse(JSON.parse(line)).taskId,
    'private/trace.jsonl',
    false,
  );
}

async function canonicalizeTaskJsonLinesFile(
  path: string,
  taskIds: readonly string[],
  taskIdFromLine: (line: string) => string | undefined,
  label: string,
  oneLinePerTask: boolean,
): Promise<void> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot finalize run: ${label} is unreadable at ${path} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  const selected = new Set(taskIds);
  const linesByTaskId = new Map<string, string[]>();
  for (const [index, line] of source
    .split('\n')
    .filter(candidate => candidate.trim().length > 0)
    .entries()) {
    let taskId: string | undefined;
    try {
      taskId = taskIdFromLine(line);
    } catch (error) {
      throw new Error(
        `Cannot finalize run: ${label} line ${index + 1} is invalid (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    if (!taskId || !selected.has(taskId)) {
      throw new Error(
        `Cannot finalize run: ${label} line ${index + 1} has task id `
        + `${taskId ?? 'missing'}, which is not in the task selection`,
      );
    }
    const normalized = JSON.stringify(JSON.parse(line));
    const existing = linesByTaskId.get(taskId) ?? [];
    if (oneLinePerTask && existing.length > 0) {
      if (existing[0] !== normalized) {
        throw new Error(
          `Cannot finalize run: conflicting ${label} rows for ${taskId}`,
        );
      }
      continue;
    }
    existing.push(normalized);
    linesByTaskId.set(taskId, existing);
  }
  const ordered = taskIds.flatMap(taskId => linesByTaskId.get(taskId) ?? []);
  await atomicWriteFile(
    path,
    ordered.length > 0 ? `${ordered.join('\n')}\n` : '',
  );
}

function taskCommitDirectory(runDirectory: string): string {
  return join(
    runDirectory,
    PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
    PACT_TASK_COMMIT_DIRECTORY_V1,
  );
}

function taskCommitDigest(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex');
}

function taskCommitPath(directory: string, taskId: string): string {
  return join(directory, `${taskCommitDigest(taskId)}.commit.json`);
}

/**
 * Loads and validates the resumable state of a prior run directory.
 *
 * Fails closed on any provenance drift: the prior `run.json` digests must
 * match the current config and task selection exactly, so a resume can never
 * silently mix results produced under different configurations. Every
 * artifact line is re-validated through the strict schemas before it re-enters
 * the host run, and retained metric contributions are recomputed from the
 * stored full evaluation (the stored rows must match the recomputation).
 *
 * Resume requires `output.saveTraces: true`: the run-level summary aggregates
 * full private evaluations, which are only persisted (under `private/`) when
 * the retention switch is on.
 */
export async function loadPactPairResumeStateV1(
  options: LoadPactPairResumeStateV1Options,
): Promise<PactPairResumeStateV1> {
  const metadataPath = join(options.runDirectory, 'run.json');
  let metadataSource: string;
  try {
    metadataSource = await readFile(metadataPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: run.json is unreadable (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  const metadata = pactRunMetadataV1Schema.parse(JSON.parse(metadataSource));
  if (metadata.configDigest !== options.configDigest) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: the current run config does not `
      + 'match the original (configDigest mismatch). Resume requires the '
      + 'exact same configuration file.',
    );
  }
  if (metadata.taskSetDigest !== options.taskSetDigest) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: the current task selection does `
      + 'not match the original (taskSetDigest mismatch).',
    );
  }

  const selectedTaskIds = new Set(options.tasks.map(task => task.taskId));
  const committed = await recoverTaskCommits(options.runDirectory);
  for (const taskId of committed.keys()) {
    if (!selectedTaskIds.has(taskId)) {
      throw new Error(
        `Cannot resume ${options.runDirectory}: task commit ${taskId} is not `
        + 'part of the recorded task selection',
      );
    }
  }
  for (const task of options.tasks) {
    const commit = committed.get(task.taskId);
    if (commit) {
      await publishCommittedTaskArtifacts(
        options.runDirectory,
        commit,
        true,
      );
    }
  }

  const priorResults = await readJsonLinesFile(
    join(options.runDirectory, 'results.jsonl'),
    line => pactTaskResultV1Schema.parse(JSON.parse(line)) as PactPairTaskResultV1,
    'results.jsonl',
  );
  const selection = selectPactPairResumeTasksV1(
    options.tasks.map(task => task.taskId),
    priorResults,
  );

  const completed = new Set(selection.completedTaskIds);
  const retainedRuns: PactPairSingleTaskRunV1[] = [];
  if (completed.size > 0) {
    const evaluationPath = join(
      options.runDirectory,
      PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
      'evaluation.jsonl',
    );
    let evaluationSource: string;
    try {
      evaluationSource = await readFile(evaluationPath, 'utf8');
    } catch {
      throw new Error(
        `Cannot resume ${options.runDirectory}: private/evaluation.jsonl is `
        + 'missing. Resume requires the original run to have used '
        + 'output.saveTraces: true, because the run summary aggregates the '
        + 'full private evaluations of completed trials.',
      );
    }
    const evaluationRecords = parseJsonLines(
      evaluationSource,
      line => pactTaskEvaluationRecordV1Schema.parse(JSON.parse(line)),
      'private/evaluation.jsonl',
    );
    const evaluationByTaskId = new Map<string, (typeof evaluationRecords)[number]>();
    for (const record of evaluationRecords) {
      const existing = evaluationByTaskId.get(record.taskId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          `Cannot resume: conflicting evaluation records for ${record.taskId}`,
        );
      }
      evaluationByTaskId.set(record.taskId, record);
    }
    const tasksById = new Map(
      options.tasks.map(task => [task.taskId, task] as const),
    );
    // Reconstruct one committed outcome per retained task. Byte-equivalent
    // historical duplicate rows are tolerated and compacted; conflicting
    // outcomes fail closed.
    const resultByTaskId = new Map<string, PactPairTaskResultV1>();
    for (const result of priorResults) {
      if (!completed.has(result.taskId)) continue;
      const existing = resultByTaskId.get(result.taskId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(result)) {
        throw new Error(
          `Cannot resume: conflicting result records for ${result.taskId}`,
        );
      }
      resultByTaskId.set(result.taskId, result);
    }
    for (const taskId of selection.completedTaskIds) {
      const result = resultByTaskId.get(taskId);
      const record = evaluationByTaskId.get(taskId);
      const task = tasksById.get(taskId);
      if (!result || !task) {
        throw new Error(`Cannot resume: missing prior result for ${taskId}`);
      }
      if (!record) {
        throw new Error(
          `Cannot resume ${options.runDirectory}: completed task ${taskId} `
          + 'has no record in private/evaluation.jsonl',
        );
      }
      const evaluation = record.evaluation as PactPairEvaluationV1;
      if (evaluation.kind !== task.kind) {
        throw new Error(
          `Cannot resume: recorded evaluation kind ${evaluation.kind} does `
          + `not match host task kind ${task.kind} for ${taskId}`,
        );
      }
      if (evaluation.expectedBehavior !== task.expectedBehavior) {
        throw new Error(
          `Cannot resume: recorded expected behavior `
          + `${evaluation.expectedBehavior} does not match host gold `
          + `${task.expectedBehavior} for ${taskId}`,
        );
      }
      if (
        evaluation.kind === 'qa'
        && task.kind === 'qa'
        && evaluation.benchmarkExpectedBehavior
          !== task.benchmarkExpectedBehavior
      ) {
        throw new Error(
          `Cannot resume: recorded benchmark expected behavior `
          + `${evaluation.benchmarkExpectedBehavior} does not match host `
          + `gold ${task.benchmarkExpectedBehavior} for ${taskId}`,
        );
      }
      // Same anti-tamper posture as the Harbor collector: recompute the
      // metric contributions from the full evaluation and require the stored
      // rows to agree — a stored artifact cannot inject arbitrary metrics.
      const recomputedMetrics = pactPairMetricContributionsV1(evaluation);
      if (metricKey(recomputedMetrics) !== metricKey(record.metrics)) {
        throw new Error(
          `Cannot resume: stored metric contributions for ${taskId} do not `
          + 'match the host recomputation from its evaluation',
        );
      }
      retainedRuns.push({
        result,
        trace: [],
        evaluation,
        evaluationResult: { metrics: recomputedMetrics, details: evaluation },
      });
    }
  }

  return {
    runId: metadata.runId,
    startedAt: metadata.startedAt,
    metadata,
    selection,
    retainedRuns,
  };
}

export type CompactResumedRunArtifactsV1Options = {
  runDirectory: string;
  /** Tasks whose prior artifact lines are retained (the completed set). */
  keepTaskIds: ReadonlySet<string>;
  saveTraces: boolean;
};

/**
 * Drops artifact lines and commit records for only the tasks proven safe to
 * re-run, so their replacement cannot coexist with a stale outcome. Each
 * rewrite uses a unique staging path plus atomic rename.
 */
export async function compactResumedRunArtifactsV1(
  options: CompactResumedRunArtifactsV1Options,
): Promise<void> {
  const keepLine = (line: string): boolean => {
    const taskId = (JSON.parse(line) as { taskId?: string }).taskId;
    return taskId === undefined || options.keepTaskIds.has(taskId);
  };
  const commits = await recoverTaskCommits(options.runDirectory);
  for (const taskId of commits.keys()) {
    if (!options.keepTaskIds.has(taskId)) {
      await unlink(taskCommitPath(taskCommitDirectory(options.runDirectory), taskId));
    }
  }
  await rewriteJsonLinesFile(
    join(options.runDirectory, 'results.jsonl'),
    keepLine,
    true,
  );
  if (options.saveTraces) {
    const privateDirectory = join(
      options.runDirectory,
      PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
    );
    await rewriteJsonLinesFile(
      join(privateDirectory, 'evaluation.jsonl'),
      keepLine,
      true,
    );
    await rewriteJsonLinesFile(
      join(privateDirectory, 'trace.jsonl'),
      keepLine,
      false,
    );
  }
}

async function rewriteJsonLinesFile(
  path: string,
  keepLine: (line: string) => boolean,
  oneLinePerTask: boolean,
): Promise<void> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const kept = source
    .split('\n')
    .filter(line => line.trim().length > 0)
    .filter(keepLine);
  const deduplicated: string[] = [];
  const byTaskId = new Map<string, string>();
  const seenLines = new Set<string>();
  for (const line of kept) {
    const normalized = JSON.stringify(JSON.parse(line));
    if (!oneLinePerTask) {
      if (!seenLines.has(normalized)) deduplicated.push(normalized);
      seenLines.add(normalized);
      continue;
    }
    const taskId = (JSON.parse(line) as { taskId?: unknown }).taskId;
    if (typeof taskId !== 'string') {
      throw new Error(`Cannot resume: artifact row at ${path} has no taskId`);
    }
    const existing = byTaskId.get(taskId);
    if (existing && existing !== normalized) {
      throw new Error(
        `Cannot resume: conflicting artifact rows for ${taskId} at ${path}`,
      );
    }
    if (!existing) {
      byTaskId.set(taskId, normalized);
      deduplicated.push(normalized);
    }
  }
  await atomicWriteFile(
    path,
    deduplicated.length > 0 ? `${deduplicated.join('\n')}\n` : '',
  );
}

async function readJsonLinesFile<T>(
  path: string,
  parseLine: (line: string) => T,
  label: string,
): Promise<T[]> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot resume: ${label} is unreadable at ${path} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  return parseJsonLines(source, parseLine, label);
}

function parseJsonLines<T>(
  source: string,
  parseLine: (line: string) => T,
  label: string,
): T[] {
  return source
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, index) => {
      try {
        return parseLine(line);
      } catch (error) {
        throw new Error(
          `Cannot resume: ${label} line ${index + 1} is invalid (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    });
}

function metricKey(
  rows: readonly { metric: string; numerator: number; denominator: number }[],
): string {
  return JSON.stringify([...rows]
    .map(row => [row.metric, row.numerator, row.denominator])
    .sort());
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeDurably(temporaryPath, contents);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(unlinkError => {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkError;
      }
    });
    throw error;
  }
}

async function writeDurably(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
