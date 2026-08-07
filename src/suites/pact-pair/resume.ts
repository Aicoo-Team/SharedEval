import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  pactRunMetadataV1Schema,
  pactTaskEvaluationRecordV1Schema,
  pactTaskResultV1Schema,
  type PactRunMetadataV1,
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

/**
 * How a resumed run partitions the selected tasks against the prior run's
 * per-task checkpoint (`results.jsonl`):
 *
 * - `completedTaskIds` — a prior trial finished with `status: 'ok'`. These
 *   are NEVER re-executed: their recorded results are retained verbatim, so a
 *   resume can only fill gaps, not retry completed trials for a better draw
 *   (no best-of-N through repeated resumes). There is deliberately no
 *   override flag.
 * - `retryTaskIds` — the prior trial ended in `infrastructure_error`; the
 *   task is re-run and its error result replaced.
 * - `missingTaskIds` — no prior result line exists (the run died before the
 *   trial finished); the task is run normally.
 */
export type PactPairResumeSelectionV1 = {
  completedTaskIds: string[];
  retryTaskIds: string[];
  missingTaskIds: string[];
};

/**
 * Pure resume selection: partitions the selected task ids using the prior
 * run's recorded results. A task with any `ok` result is completed even if an
 * older `infrastructure_error` line is also present. Prior results for tasks
 * outside the current selection are rejected — the caller must already have
 * proven task-set identity (taskSetDigest), so any leftover is corruption.
 */
export function selectPactPairResumeTasksV1(
  taskIds: readonly string[],
  priorResults: readonly Pick<PactPairTaskResultV1, 'taskId' | 'status'>[],
): PactPairResumeSelectionV1 {
  const selected = new Set(taskIds);
  const completed = new Set<string>();
  const errored = new Set<string>();
  for (const result of priorResults) {
    if (!selected.has(result.taskId)) {
      throw new Error(
        `Cannot resume: prior results contain task ${result.taskId}, which is `
        + 'not part of the current task selection',
      );
    }
    if (result.status === 'ok') completed.add(result.taskId);
    else errored.add(result.taskId);
  }
  const selection: PactPairResumeSelectionV1 = {
    completedTaskIds: [],
    retryTaskIds: [],
    missingTaskIds: [],
  };
  for (const taskId of taskIds) {
    if (completed.has(taskId)) selection.completedTaskIds.push(taskId);
    else if (errored.has(taskId)) selection.retryTaskIds.push(taskId);
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
    const evaluationByTaskId = new Map(
      evaluationRecords.map(record => [record.taskId, record] as const),
    );
    const tasksById = new Map(
      options.tasks.map(task => [task.taskId, task] as const),
    );
    // Reconstruct in results order, keeping the LAST ok line per task (a
    // compacted resumed run has exactly one).
    const resultByTaskId = new Map<string, PactPairTaskResultV1>();
    for (const result of priorResults) {
      if (result.status === 'ok') resultByTaskId.set(result.taskId, result);
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
 * Drops the artifact lines of the tasks a resume is about to re-run (prior
 * `infrastructure_error` lines and any partial leftovers), so the appended
 * fresh lines never coexist with stale ones. Each rewrite goes through a
 * temporary file plus atomic rename — a crash mid-compaction leaves the
 * original artifact intact.
 */
export async function compactResumedRunArtifactsV1(
  options: CompactResumedRunArtifactsV1Options,
): Promise<void> {
  const keepLine = (line: string): boolean => {
    const taskId = (JSON.parse(line) as { taskId?: string }).taskId;
    return taskId === undefined || options.keepTaskIds.has(taskId);
  };
  await rewriteJsonLinesFile(
    join(options.runDirectory, 'results.jsonl'),
    keepLine,
  );
  if (options.saveTraces) {
    const privateDirectory = join(
      options.runDirectory,
      PACT_PRIVATE_RUN_ARTIFACT_DIRECTORY_V1,
    );
    await rewriteJsonLinesFile(join(privateDirectory, 'evaluation.jsonl'), keepLine);
    await rewriteJsonLinesFile(join(privateDirectory, 'trace.jsonl'), keepLine);
  }
}

async function rewriteJsonLinesFile(
  path: string,
  keepLine: (line: string) => boolean,
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
  const temporaryPath = `${path}.resume-tmp`;
  await writeFile(
    temporaryPath,
    kept.length > 0 ? `${kept.join('\n')}\n` : '',
    'utf8',
  );
  await rename(temporaryPath, path);
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
