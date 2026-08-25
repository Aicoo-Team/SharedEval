import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
import { toPublicEvaluation } from './environment.js';
import {
  evaluatePactPairActionV1,
  evaluatePactPairQaV1,
} from './evaluator.js';
import type { PairDataStore } from './schemas.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import { executePactPairToolV1 } from './tools.js';
import { createPactPairWorkspaceV1 } from './workspace.js';

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
 * Acquires the run-directory single-writer lease. Existing ownership always
 * fails closed. Even a provably dead local PID is not sufficient authority to
 * delete a lock: an operator must inspect the run and remove it manually.
 */
export async function acquirePactPairRunWriterLockV1(
  runDirectory: string,
): Promise<PactPairRunWriterLockV1> {
  const lockDirectory = join(runDirectory, PACT_RUN_WRITER_LOCK_V1);
  const owner = newWriterLockOwner();
  try {
    await mkdir(lockDirectory);
    await syncDirectory(runDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const ownerPath = join(lockDirectory, 'owner.json');
    const existing = await readWriterLockOwner(ownerPath, lockDirectory);
    const disposition = existing.host === owner.host && !processIsAlive(existing.pid)
      ? 'stale writer lock'
      : 'active writer lock';
    throw new Error(
      `Cannot write run directory ${runDirectory}: ${disposition} owned by `
      + `pid ${existing.pid} on ${existing.host} since ${existing.acquiredAt}; `
      + 'remove it manually only after confirming no writer is active',
    );
  }
  await atomicWriteFile(join(lockDirectory, 'owner.json'), prettyJson(owner));
  return writerLockHandle(runDirectory, owner);
}

/**
 * Atomically creates a fresh run directory with writer exclusion already in
 * place. The final path is never observable without `.writer-lock`.
 */
export async function createPactPairRunDirectoryWithWriterLockV1(
  runDirectory: string,
): Promise<PactPairRunWriterLockV1> {
  const parentDirectory = dirname(runDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = join(
    parentDirectory,
    `.${basename(runDirectory)}.initializing-${randomUUID()}`,
  );
  const owner = newWriterLockOwner();
  try {
    await mkdir(stagingDirectory);
    const stagingLock = join(stagingDirectory, PACT_RUN_WRITER_LOCK_V1);
    await mkdir(stagingLock);
    await atomicWriteFile(join(stagingLock, 'owner.json'), prettyJson(owner));
    await syncDirectory(stagingDirectory);
    await rename(stagingDirectory, runDirectory);
    await syncDirectory(parentDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    if (['EEXIST', 'ENOTEMPTY'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )) {
      throw new Error(
        `EEXIST: run directory already exists at ${runDirectory}`,
        { cause: error },
      );
    }
    throw error;
  }
  return writerLockHandle(runDirectory, owner);
}

function newWriterLockOwner(): WriterLockOwnerV1 {
  return {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
}

function writerLockHandle(
  runDirectory: string,
  owner: WriterLockOwnerV1,
): PactPairRunWriterLockV1 {
  const lockDirectory = join(runDirectory, PACT_RUN_WRITER_LOCK_V1);
  const ownerPath = join(lockDirectory, 'owner.json');

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
      await unlink(ownerPath);
      await syncDirectory(lockDirectory);
      await rmdir(lockDirectory);
      await syncDirectory(runDirectory);
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
    || violations.has('max_tool_calls_exceeded')
    || violations.has('side_effect_before_failure')
  ) return false;
  const message = result.error ?? '';
  if (NON_RETRYABLE_MODEL_FAILURE_PATTERN_V1.test(message)) return false;
  return TRANSIENT_FAILURE_PATTERN_V1.test(message);
}

/**
 * Pure resume selection: partitions the selected task ids using the prior
 * run's recorded results. Byte-identical duplicate rows are compacted;
 * distinct rows for one task fail closed because no ordering claim can prove
 * which outcome is authoritative. Prior results for tasks outside the current
 * selection are rejected — task-set identity has already been proven by digest.
 */
export function selectPactPairResumeTasksV1(
  taskIds: readonly string[],
  priorResults: readonly PactPairResumeResultV1[],
): PactPairResumeSelectionV1 {
  const selected = new Set(taskIds);
  const priorByTaskId = new Map<string, string>();
  const completed = new Set<string>();
  const retryable = new Set<string>();
  for (const result of priorResults) {
    if (!selected.has(result.taskId)) {
      throw new Error(
        `Cannot resume: prior results contain task ${result.taskId}, which is `
        + 'not part of the current task selection',
      );
    }
    const normalized = canonicalJson(result);
    const existing = priorByTaskId.get(result.taskId);
    if (existing !== undefined && existing !== normalized) {
      throw new Error(
        `Cannot resume: conflicting prior outcomes for task ${result.taskId}`,
      );
    }
    if (existing !== undefined) continue;
    priorByTaskId.set(result.taskId, normalized);
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
   * (results.jsonl + private/evaluation.jsonl + private/trace.jsonl), in
   * canonical task order. Recovery replays action traces against the current
   * host seed before any retained outcome is republished.
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
  model: PactRunMetadataV1['model'];
  benchmark: PactRunMetadataV1['benchmark'];
  budget: PactRunMetadataV1['budget'];
  policyProvenance: PactRunMetadataV1['policyProvenance'];
  requesterIdentityProvenance: NonNullable<
    PactRunMetadataV1['requesterIdentityProvenance']
  >;
  relationshipLabelProvenance?: NonNullable<
    PactRunMetadataV1['relationshipLabelProvenance']
  >;
  sourceRevision?: string;
  seed: PairDataStore;
};

export type CommitPactPairTaskRunV1Options = {
  runDirectory: string;
  runId: string;
  configDigest: string;
  taskSetDigest: string;
  execution: NonNullable<PactRunMetadataV1['execution']>;
  taskRun: PactPairSingleTaskRunV1;
  saveTraces: boolean;
  checkpoint: {
    completedTasks: number;
    selectedTasks: number;
    errors: number;
  };
};

/**
 * Durably records the exact identity of the active backend attempt before a
 * task from that attempt can enter the private journal.
 */
export async function recordPactPairExecutionAuthorityV1(
  runDirectory: string,
  execution: NonNullable<PactRunMetadataV1['execution']>,
): Promise<void> {
  const metadataPath = join(runDirectory, 'run.json');
  const metadata = pactRunMetadataV1Schema.parse(JSON.parse(
    await readFile(metadataPath, 'utf8'),
  ));
  if (metadata.status !== 'running') {
    throw new Error(
      `Cannot record execution identity for non-running run ${metadata.runId}`,
    );
  }
  if (
    metadata.activeExecution !== undefined
    && canonicalJson(metadata.activeExecution) !== canonicalJson(execution)
  ) {
    throw new Error(
      `Conflicting active execution identity for run ${metadata.runId}`,
    );
  }
  await atomicWriteFile(metadataPath, prettyJson({
    ...metadata,
    activeExecution: execution,
  }));
}

/**
 * Prepares and commits one already-executed task before publishing any of its
 * canonical artifacts. Publication rewrites each artifact by task id, so a
 * callback retry finishes or observes the same commit without appending a
 * second row.
 */
export async function commitPactPairTaskRunV1(
  options: CommitPactPairTaskRunV1Options,
): Promise<void> {
  const payload = {
    binding: {
      runId: options.runId,
      taskId: options.taskRun.result.taskId,
      configDigest: options.configDigest,
      taskSetDigest: options.taskSetDigest,
      publicTaskDigest: digestCanonicalJson(options.taskRun.result.publicTask),
      executionDigest: digestCanonicalJson(options.execution),
    },
    result: options.taskRun.result,
    evaluation: {
      taskId: options.taskRun.result.taskId,
      evaluation: options.taskRun.evaluation,
      metrics: options.taskRun.evaluationResult.metrics,
    },
    trace: options.taskRun.trace,
  };
  const commit = pactTaskCommitV1Schema.parse({
    apiVersion: 'pact-task-commit/v1',
    payloadDigest: taskCommitPayloadDigest(payload),
    payload,
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
    lastTaskId: durableCommit.payload.binding.taskId,
    errors: options.checkpoint.errors,
  }));
}

async function persistTaskCommit(
  runDirectory: string,
  commit: PactTaskCommitV1,
): Promise<PactTaskCommitV1> {
  const directory = taskCommitDirectory(runDirectory);
  await mkdir(directory, { recursive: true });
  await syncDirectory(dirname(directory));
  const authorityPath = taskCommitAuthorityPath(directory, commit);
  const committedPath = taskCommitPath(directory, commit);
  const preparedPath = join(
    directory,
    `${taskCommitTaskDigest(commit)}.${commit.payloadDigest}.`
    + `${randomUUID()}.prepared.json`,
  );
  await writeDurably(preparedPath, prettyJson(commit));
  await syncDirectory(directory);
  let authoritative = commit;
  try {
    try {
      // The stable run/task address is the one authority claim. Different
      // payload digests therefore race on the same hard-link destination.
      await link(preparedPath, authorityPath);
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      authoritative = await readTaskCommit(authorityPath);
      assertSameTaskCommit(authoritative, commit, authorityPath);
    }
    try {
      await link(authorityPath, committedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assertSameTaskCommit(
        await readTaskCommit(committedPath),
        authoritative,
        committedPath,
      );
    }
    await syncDirectory(directory);
    return authoritative;
  } finally {
    await durableUnlink(preparedPath);
  }
}

async function recoverTaskCommits(
  runDirectory: string,
): Promise<Map<string, PactTaskCommitV1>> {
  const directory = taskCommitDirectory(runDirectory);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const commits = new Map<string, PactTaskCommitV1>();
  const pathsByTask = new Map<string, string[]>();
  for (const entry of entries
    .filter(candidate => candidate.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (!entry.isFile()) {
      throw new Error(
        `Cannot recover task journal at ${path}: journal entries must be `
        + 'regular files (symbolic links and special files are refused)',
      );
    }
    const commit = await readTaskCommit(path);
    const taskId = commit.payload.binding.taskId;
    const existing = commits.get(taskId);
    if (existing) assertSameTaskCommit(existing, commit, path);
    else commits.set(taskId, commit);
    const paths = pathsByTask.get(taskId) ?? [];
    paths.push(path);
    pathsByTask.set(taskId, paths);
  }
  for (const [taskId, commit] of commits) {
    const authorityPath = taskCommitAuthorityPath(directory, commit);
    const committedPath = taskCommitPath(directory, commit);
    const sourcePath = pathsByTask.get(taskId)?.[0];
    if (!sourcePath) continue;
    if (!pathsByTask.get(taskId)?.includes(authorityPath)) {
      try {
        await link(sourcePath, authorityPath);
        await syncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertSameTaskCommit(
          await readTaskCommit(authorityPath),
          commit,
          authorityPath,
        );
      }
    }
    if (!pathsByTask.get(taskId)?.includes(committedPath)) {
      try {
        await link(authorityPath, committedPath);
        await syncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertSameTaskCommit(await readTaskCommit(committedPath), commit, committedPath);
      }
    }
    for (const path of pathsByTask.get(taskId) ?? []) {
      if (path !== authorityPath && path !== committedPath) {
        await durableUnlink(path);
      }
    }
  }
  return commits;
}

async function readTaskCommit(path: string): Promise<PactTaskCommitV1> {
  try {
    const commit = pactTaskCommitV1Schema.parse(
      JSON.parse(await readJournalRegularFile(path)),
    ) as PactTaskCommitV1;
    const actualPayloadDigest = taskCommitPayloadDigest(commit.payload);
    if (actualPayloadDigest !== commit.payloadDigest) {
      throw new Error(
        `journal payload digest mismatch for task ${commit.payload.binding.taskId}`,
      );
    }
    assertTaskCommitFilename(path, commit);
    return commit;
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
      `Conflicting committed outcomes for task ${right.payload.binding.taskId} at ${path}; `
      + 'refusing to overwrite an already-executed model action',
    );
  }
}

async function publishCommittedTaskArtifacts(
  runDirectory: string,
  commit: PactTaskCommitV1,
  saveTraces: boolean,
): Promise<void> {
  const payload = commit.payload;
  await rewriteTaskJsonLinesFile(
    join(runDirectory, 'results.jsonl'),
    payload.binding.taskId,
    [payload.result],
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
    payload.binding.taskId,
    [payload.evaluation],
    line => pactTaskEvaluationRecordV1Schema.parse(JSON.parse(line)).taskId,
    'private/evaluation.jsonl',
  );
  await rewriteTaskJsonLinesFile(
    join(privateDirectory, 'trace.jsonl'),
    payload.binding.taskId,
    payload.trace,
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

function taskCommitIdDigest(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex');
}

function taskCommitTaskDigest(commit: PactTaskCommitV1): string {
  return taskCommitIdDigest(commit.payload.binding.taskId);
}

function taskCommitAuthorityDigest(commit: PactTaskCommitV1): string {
  return digestCanonicalJson({
    runId: commit.payload.binding.runId,
    taskId: commit.payload.binding.taskId,
  });
}

function taskCommitAuthorityPath(
  directory: string,
  commit: PactTaskCommitV1,
): string {
  return join(directory, `${taskCommitAuthorityDigest(commit)}.authority.json`);
}

function taskCommitPath(
  directory: string,
  commit: PactTaskCommitV1,
): string {
  return join(
    directory,
    `${taskCommitTaskDigest(commit)}.${commit.payloadDigest}.commit.json`,
  );
}

function taskCommitPayloadDigest(
  payload: unknown,
): string {
  return digestCanonicalJson(payload);
}

function assertTaskCommitFilename(
  path: string,
  commit: PactTaskCommitV1,
): void {
  const name = basename(path);
  const authority = /^([a-f0-9]{64})\.authority\.json$/u.exec(name);
  const committed = /^([a-f0-9]{64})\.([a-f0-9]{64})\.commit\.json$/u.exec(name);
  const prepared = /^([a-f0-9]{64})\.([a-f0-9]{64})\.[^.]+\.prepared\.json$/u
    .exec(name);
  const address = committed ?? prepared;
  if (authority) {
    if (authority[1] !== taskCommitAuthorityDigest(commit)) {
      throw new Error(
        `journal authority filename ${name} does not match its run/task identity`,
      );
    }
    return;
  }
  if (!address) {
    throw new Error(
      `journal filename ${name} is not a valid content address`,
    );
  }
  if (
    address[1] !== taskCommitTaskDigest(commit)
    || address[2] !== commit.payloadDigest
  ) {
    throw new Error(
      `journal filename ${name} does not match its content address`,
    );
  }
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
  for (const [field, recorded, current] of [
    ['model', metadata.model, options.model],
    ['benchmark', metadata.benchmark, options.benchmark],
    ['budget', metadata.budget, options.budget],
  ] as const) {
    if (canonicalJson(recorded) !== canonicalJson(current)) {
      throw new Error(
        `Cannot resume ${options.runDirectory}: recorded ${field} provenance `
        + 'does not match the current run configuration',
      );
    }
  }
  if (
    canonicalJson(metadata.policyProvenance)
    !== canonicalJson(options.policyProvenance)
  ) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: recorded policy provenance `
      + 'does not match the current host policy',
    );
  }
  if (
    canonicalJson(metadata.requesterIdentityProvenance)
    !== canonicalJson(options.requesterIdentityProvenance)
  ) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: recorded requester identity `
      + 'provenance does not match the current task source',
    );
  }
  if (
    canonicalJson(metadata.relationshipLabelProvenance)
    !== canonicalJson(options.relationshipLabelProvenance)
  ) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: recorded relationship label `
      + 'provenance does not match the current task source',
    );
  }
  if (metadata.sourceRevision !== options.sourceRevision) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: recorded source provenance `
      + 'does not match the current host source',
    );
  }
  if (metadata.selectedTasks !== options.tasks.length) {
    throw new Error(
      `Cannot resume ${options.runDirectory}: recorded selected task count `
      + 'does not match the current task selection',
    );
  }

  const selectedTaskIds = new Set(options.tasks.map(task => task.taskId));
  const tasksById = new Map(
    options.tasks.map(task => [task.taskId, task] as const),
  );
  const committed = await recoverTaskCommits(options.runDirectory);
  for (const taskId of committed.keys()) {
    if (!selectedTaskIds.has(taskId)) {
      throw new Error(
        `Cannot resume ${options.runDirectory}: task commit ${taskId} is not `
        + 'part of the recorded task selection',
      );
    }
  }
  const validatedCommittedRuns = new Map<string, PactPairSingleTaskRunV1>();
  for (const [taskId, commit] of committed) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    validatedCommittedRuns.set(
      taskId,
      await validateCommittedTaskRun(commit, task, metadata, options),
    );
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
    const tracePath = join(
      options.runDirectory,
      PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
      'trace.jsonl',
    );
    let traceSource: string;
    try {
      traceSource = await readFile(tracePath, 'utf8');
    } catch {
      throw new Error(
        `Cannot resume ${options.runDirectory}: private/trace.jsonl is `
        + 'missing. Resume validation requires the original private trace.',
      );
    }
    const traceEvents = parseJsonLines(
      traceSource,
      line => pactTraceEventV1Schema.parse(JSON.parse(line)),
      'private/trace.jsonl',
    ) as unknown as PactPairSingleTaskRunV1['trace'];
    const traceByTaskId = new Map<string, PactPairSingleTaskRunV1['trace']>();
    for (const event of traceEvents) {
      if (!event.taskId || !selectedTaskIds.has(event.taskId)) {
        throw new Error(
          'Cannot resume: private/trace.jsonl contains an event outside the '
          + 'current task selection',
        );
      }
      const taskTrace = traceByTaskId.get(event.taskId) ?? [];
      taskTrace.push(event);
      traceByTaskId.set(event.taskId, taskTrace);
    }
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
      const committedRun = validatedCommittedRuns.get(taskId);
      retainedRuns.push(committedRun ?? await validateRetainedTaskRun(
        task,
        result,
        record as unknown as {
          taskId: string;
          evaluation: PactPairEvaluationV1;
          metrics: readonly {
            metric: string;
            numerator: number;
            denominator: number;
          }[];
        },
        traceByTaskId.get(taskId) ?? [],
        metadata.budget,
        options.seed,
      ));
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

async function validateCommittedTaskRun(
  commit: PactTaskCommitV1,
  task: LoadedPactPairTaskV1,
  metadata: PactRunMetadataV1,
  options: LoadPactPairResumeStateV1Options,
): Promise<PactPairSingleTaskRunV1> {
  const { binding } = commit.payload;
  const result = commit.payload.result as unknown as PactPairTaskResultV1;
  const evaluation = commit.payload.evaluation as unknown as {
    taskId: string;
    evaluation: PactPairEvaluationV1;
    metrics: readonly {
      metric: string;
      numerator: number;
      denominator: number;
    }[];
  };
  const trace = commit.payload.trace as unknown as PactPairSingleTaskRunV1['trace'];
  const taskId = task.taskId;
  const recordedExecution = executionAuthorityForTask(metadata, taskId);
  for (const [field, matches] of [
    ['run identity', binding.runId === metadata.runId],
    ['config identity', binding.configDigest === options.configDigest],
    ['task-set identity', binding.taskSetDigest === options.taskSetDigest],
    ['task identity', binding.taskId === taskId],
    [
      'public task identity',
      binding.publicTaskDigest === digestCanonicalJson(task.publicTask),
    ],
    [
      'execution identity',
      binding.executionDigest === undefined
        || (recordedExecution !== undefined
          && binding.executionDigest === digestCanonicalJson(recordedExecution)),
    ],
  ] as const) {
    if (!matches) {
      throw new Error(
        `Cannot resume: committed task ${taskId} has a ${field} mismatch`,
      );
    }
  }
  return validateRetainedTaskRun(
    task,
    result,
    evaluation,
    trace,
    metadata.budget,
    options.seed,
  );
}

function executionAuthorityForTask(
  metadata: PactRunMetadataV1,
  taskId: string,
): NonNullable<PactRunMetadataV1['execution']> | undefined {
  const committedAttempt = metadata.executionAttempts?.find(attempt =>
    attempt.taskIds.includes(taskId));
  return committedAttempt?.execution
    ?? metadata.activeExecution
    ?? metadata.execution;
}

async function validateRetainedTaskRun(
  task: LoadedPactPairTaskV1,
  result: PactPairTaskResultV1,
  record: {
    taskId: string;
    evaluation: PactPairEvaluationV1;
    metrics: readonly { metric: string; numerator: number; denominator: number }[];
  },
  trace: PactPairSingleTaskRunV1['trace'],
  budget: PactRunMetadataV1['budget'],
  seed: PairDataStore,
): Promise<PactPairSingleTaskRunV1> {
  const taskId = task.taskId;
  const fail = (field: string): never => {
    throw new Error(
      `Cannot resume: retained task ${taskId} has an invalid ${field}`,
    );
  };
  if (result.taskId !== taskId || record.taskId !== taskId) fail('taskId');
  if (result.kind !== task.kind || record.evaluation.kind !== task.kind) {
    fail('kind');
  }
  if (canonicalJson(result.publicTask) !== canonicalJson(task.publicTask)) {
    fail('public task identity');
  }
  if (record.evaluation.expectedBehavior !== task.expectedBehavior) {
    fail('expectedBehavior');
  }
  const replayedWorkspace = await replayToolTrace(
    result,
    trace,
    seed,
    fail,
  );
  if (task.kind === 'qa' && record.evaluation.kind === 'qa') {
    if (
      record.evaluation.benchmarkExpectedBehavior
      !== task.benchmarkExpectedBehavior
    ) fail('benchmarkExpectedBehavior');
    const recomputed = evaluatePactPairQaV1(task, result.finalDecision);
    if (canonicalJson(recomputed) !== canonicalJson(record.evaluation)) {
      fail('host evaluation');
    }
  } else if (task.kind === 'action' && record.evaluation.kind === 'action') {
    if (record.evaluation.goldCheckType !== task.action.gold_check.type) {
      fail('goldCheckType');
    }
    const replayedEvaluation = evaluatePactPairActionV1(
      task,
      result.finalDecision,
      replayedWorkspace.before,
      replayedWorkspace.after,
    );
    if (canonicalJson(replayedEvaluation) !== canonicalJson(record.evaluation)) {
      fail('host evaluation');
    }
  }
  const publicEvaluation = result.status === 'ok'
    ? toPublicEvaluation(record.evaluation)
    : null;
  if (canonicalJson(result.evaluation) !== canonicalJson(publicEvaluation)) {
    fail('public evaluation');
  }
  if (
    result.budgetUsed.turns > budget.maxTurns
    || result.budgetUsed.toolCalls > budget.maxToolCalls
    || result.budgetUsed.toolCalls !== result.toolCalls.length
  ) fail('turn or tool-call budget');
  const runtimeAccountingOverhead = result.violations.includes(
    'max_runtime_ms_exceeded',
  )
    ? Math.min(5_000, Math.max(100, Math.ceil(budget.maxRuntimeMs * 0.1)))
    : 0;
  if (
    result.budgetUsed.runtimeMs
    > budget.maxRuntimeMs + runtimeAccountingOverhead
  ) {
    fail('runtime budget');
  }
  const recomputedMetrics = pactPairMetricContributionsV1(record.evaluation);
  if (metricKey(recomputedMetrics) !== metricKey(record.metrics)) {
    fail('metric contributions');
  }
  const infrastructureError = result.error !== undefined
    || result.finalizeError !== undefined;
  if ((result.status === 'infrastructure_error') !== infrastructureError) {
    fail('result status');
  }
  const completions = trace.filter(event => event.event === 'task_completed');
  const backendErrors = trace.filter(event => event.event === 'backend_error');
  const backendFailure = result.violations.includes('backend_error');
  if (backendFailure) {
    if (
      completions.length !== 0
      || backendErrors.length !== 1
      || result.error === undefined
      || !isJsonRecord(backendErrors[0]?.data)
      || backendErrors[0].data.message !== result.error
    ) fail('terminal trace binding');
  } else if (completions.length !== 1) {
    fail('terminal trace binding');
  }
  const completion = completions[0];
  if (completion !== undefined) {
    const data = completion.data as Record<string, unknown>;
    if (
      canonicalJson(data.finalDecision) !== canonicalJson(result.finalDecision)
      || canonicalJson(data.evaluation) !== canonicalJson(result.evaluation)
      || canonicalJson(data.budgetUsed) !== canonicalJson(result.budgetUsed)
      || canonicalJson(data.violations) !== canonicalJson(result.violations)
    ) fail('trace completion binding');
  }
  return {
    result,
    trace,
    evaluation: record.evaluation,
    evaluationResult: {
      metrics: recomputedMetrics,
      details: record.evaluation,
    },
  };
}

async function replayToolTrace(
  result: PactPairTaskResultV1,
  trace: PactPairSingleTaskRunV1['trace'],
  seed: PairDataStore,
  fail: (field: string) => never,
): Promise<{ before: PairDataStore; after: PairDataStore }> {
  let replayTime = new Date(0).toISOString();
  const workspace = createPactPairWorkspaceV1(seed, { now: () => replayTime });
  const before = workspace.snapshot();
  const toolEvents = trace.filter(event => event.event === 'tool_result');
  const toolDecisions = trace.flatMap(event => {
    if (event.event !== 'decision' || !isJsonRecord(event.data)) return [];
    const decision = event.data.decision;
    return isJsonRecord(decision) && decision.type === 'tool_call'
      ? [decision]
      : [];
  });
  if (toolEvents.length !== result.toolCalls.length) {
    fail('trace tool-call binding');
  }
  for (const [index, event] of toolEvents.entries()) {
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      fail('trace tool-call binding');
    }
    const record = data as Record<string, unknown>;
    const toolCall = result.toolCalls[index];
    const decision = toolDecisions[index];
    if (
      !toolCall
      || !decision
      || record.toolCallId !== toolCall.id
      || record.toolName !== toolCall.name
      || decision.toolName !== toolCall.name
      || !Object.hasOwn(decision, 'input')
      || !Object.hasOwn(record, 'result')
    ) fail('trace tool-call binding');
    const input = Object.hasOwn(record, 'input')
      ? record.input
      : decision.input;
    if (
      Object.hasOwn(record, 'input')
      && canonicalJson(record.input) !== canonicalJson(decision.input)
    ) fail('trace tool-call binding');
    replayTime = recordedCompletionTime(record.result) ?? event.at;
    const replayed = await executePactPairToolV1({
      workspace,
      access: result.grantedAccess,
      toolName: toolCall.name,
      input,
    });
    const recordedResult = record.result;
    const sharedOsStatus = isJsonRecord(recordedResult)
      && typeof recordedResult.status === 'string'
      ? recordedResult.status
      : undefined;
    if (
      replayed.isError !== toolCall.isError
      || (sharedOsStatus === undefined
        ? canonicalJson(replayed) !== canonicalJson(recordedResult)
        : (sharedOsStatus !== 'succeeded') !== replayed.isError)
    ) fail('trace tool result');
  }
  return { before, after: workspace.snapshot() };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordedCompletionTime(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = recordedCompletionTime(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.completedAt === 'string') return record.completedAt;
  for (const entry of Object.values(record)) {
    const found = recordedCompletionTime(entry);
    if (found !== undefined) return found;
  }
  return undefined;
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
  for (const [taskId, commit] of commits) {
    if (!options.keepTaskIds.has(taskId)) {
      await durableUnlink(taskCommitAuthorityPath(
        taskCommitDirectory(options.runDirectory),
        commit,
      ));
      await durableUnlink(taskCommitPath(
        taskCommitDirectory(options.runDirectory),
        commit,
      ));
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
    await syncDirectory(dirname(path));
  } catch (error) {
    await durableUnlink(temporaryPath);
    throw error;
  }
}

/** Durable, non-truncating publication for run-level JSON artifacts. */
export async function atomicWritePactPairRunFileV1(
  path: string,
  contents: string,
): Promise<void> {
  await atomicWriteFile(path, contents);
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

async function durableUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJournalRegularFile(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('journal entry is not a regular file');
    }
    if (stat.size > 64 * 1024 * 1024) {
      throw new Error('journal entry exceeds the 64 MiB safety limit');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(
        `journal entry at ${path} is a symbolic link; only regular files are allowed`,
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function digestCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
