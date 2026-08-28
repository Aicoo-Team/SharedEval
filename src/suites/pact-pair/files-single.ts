import { createHash } from 'node:crypto';
import {
  FileDrivenPairSessionPreparationErrorV1,
  runOneFileDrivenPairSessionV1,
  toPublicFileDrivenPairSessionV1,
  type FileDrivenPairSessionV1,
  type FileDrivenPairTaskOutcomeV1,
  type PublicFileDrivenPairSessionV1,
  type RunOneFileDrivenPairSessionV1Options,
} from './file-workflow.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import type { PactPairWorkspaceV1 } from './workspace.js';

export type RunPactPairFilesSingleV1Options = Omit<
  RunOneFileDrivenPairSessionV1Options,
  | 'workflowId'
  | 'sessionId'
  | 'sessionIndex'
  | 'maxTicks'
  | 'tasks'
  | 'pactWorkspace'
  | 'storeRoot'
> & Readonly<{
  tasks: readonly LoadedPactPairTaskV1[];
  maxTicks?: number;
  /** Tasks processed at once; absent means 1, the serial behavior. */
  taskConcurrency?: number;
  pactWorkspaceForTask: (
    task: LoadedPactPairTaskV1,
    index: number,
  ) => PactPairWorkspaceV1;
  storeRootForTask: (task: LoadedPactPairTaskV1, index: number) => string;
}>;

export type FileDrivenPairSinglePreparationFailureV1 = Readonly<{
  taskId: string;
  errorCode: 'FILE_SESSION_PREPARATION_FAILED';
}>;

export type PactPairFilesSingleBatchV1 = Readonly<{
  workflowId: 'files-single';
  sessions: readonly FileDrivenPairSessionV1[];
  outcomes: readonly FileDrivenPairTaskOutcomeV1[];
  preparationFailures: readonly FileDrivenPairSinglePreparationFailureV1[];
  publicProjection: Readonly<{
    workflowId: 'files-single';
    sessions: readonly PublicFileDrivenPairSessionV1[];
    outcomes: readonly Readonly<{
      taskId: string;
      kind: LoadedPactPairTaskV1['kind'];
      status: FileDrivenPairTaskOutcomeV1['status'];
      terminalTick: number;
      publicEvaluation: FileDrivenPairTaskOutcomeV1['publicEvaluation'];
    }>[];
    preparationFailures: readonly FileDrivenPairSinglePreparationFailureV1[];
  }>;
}>;

/**
 * Single creates one fully isolated invocation of the shared scheduler per
 * task. Only a typed pre-session preparation failure is contained; once a
 * durable session may have acted, every other failure stops the batch.
 *
 * taskConcurrency processes up to that many tasks at once through the same
 * per-task isolation; results stay in task order, byte-equivalent to a serial
 * run. On a fatal error no new task starts, in-flight tasks settle, and the
 * lowest-index fatal error propagates (later tasks that finished first are
 * discarded with the batch, exactly as a serial run would never have run
 * them).
 */
export async function runPactPairFilesSingleV1(
  options: RunPactPairFilesSingleV1Options,
): Promise<PactPairFilesSingleBatchV1> {
  const maxTicks = options.maxTicks ?? 1;
  const taskConcurrency = options.taskConcurrency ?? 1;
  validateSingleOptions(options.runId, options.tasks, maxTicks, taskConcurrency);
  const sessionSlots: (FileDrivenPairSessionV1 | undefined)[] =
    new Array(options.tasks.length).fill(undefined);
  const outcomeSlots: (FileDrivenPairTaskOutcomeV1 | undefined)[] =
    new Array(options.tasks.length).fill(undefined);
  const failureSlots: (FileDrivenPairSinglePreparationFailureV1 | undefined)[] =
    new Array(options.tasks.length).fill(undefined);
  const {
    pactWorkspaceForTask,
    storeRootForTask,
    tasks: _tasks,
    maxTicks: _maxTicks,
    taskConcurrency: _taskConcurrency,
    ...common
  } = options;

  const runTask = async (task: LoadedPactPairTaskV1, index: number) => {
    const physicalRunId = singlePhysicalRunId(options.runId, task.taskId, index);
    try {
      const session = await runOneFileDrivenPairSessionV1({
        ...common,
        workflowId: 'files-single',
        runId: physicalRunId,
        sessionIndex: index,
        tasks: [task],
        maxTicks,
        pactWorkspace: pactWorkspaceForTask(task, index),
        storeRoot: storeRootForTask(task, index),
      });
      const outcome = session.outcomes[0];
      if (!outcome || outcome.taskId !== task.taskId) {
        throw new Error('File-driven single session returned a mismatched task outcome');
      }
      sessionSlots[index] = session;
      outcomeSlots[index] = outcome;
    } catch (error) {
      if (!(error instanceof FileDrivenPairSessionPreparationErrorV1)) throw error;
      failureSlots[index] = Object.freeze({
        taskId: task.taskId,
        errorCode: 'FILE_SESSION_PREPARATION_FAILED' as const,
      });
      outcomeSlots[index] = Object.freeze({
        taskId: task.taskId,
        kind: task.kind,
        status: 'error' as const,
        terminalTick: 0,
        evaluation: null,
        evaluationResult: null,
        publicEvaluation: null,
      });
    }
  };

  let nextIndex = 0;
  const fatalFailures: { index: number; error: unknown }[] = [];
  const worker = async () => {
    while (fatalFailures.length === 0 && nextIndex < options.tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const task = options.tasks[index]!;
      try {
        await runTask(task, index);
      } catch (error) {
        fatalFailures.push({ index, error });
        return;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(taskConcurrency, options.tasks.length) },
    worker,
  ));
  const fatal = fatalFailures
    .sort((left, right) => left.index - right.index)
    .at(0);
  if (fatal !== undefined) throw fatal.error;

  const sessions = sessionSlots.filter(
    (session): session is FileDrivenPairSessionV1 => session !== undefined,
  );
  const outcomes = outcomeSlots.filter(
    (outcome): outcome is FileDrivenPairTaskOutcomeV1 => outcome !== undefined,
  );
  const preparationFailures = failureSlots.filter(
    (failure): failure is FileDrivenPairSinglePreparationFailureV1 =>
      failure !== undefined,
  );
  const publicSessions = sessions.map(toPublicFileDrivenPairSessionV1);
  return Object.freeze({
    workflowId: 'files-single' as const,
    sessions: Object.freeze(sessions),
    outcomes: Object.freeze(outcomes),
    preparationFailures: Object.freeze(preparationFailures),
    publicProjection: Object.freeze({
      workflowId: 'files-single' as const,
      sessions: Object.freeze(publicSessions),
      outcomes: Object.freeze(outcomes.map(outcome => ({
        taskId: outcome.taskId,
        kind: outcome.kind,
        status: outcome.status,
        terminalTick: outcome.terminalTick,
        publicEvaluation: outcome.publicEvaluation === null
          ? null
          : structuredClone(outcome.publicEvaluation),
      }))),
      preparationFailures: Object.freeze([...preparationFailures]),
    }),
  });
}

function validateSingleOptions(
  runId: string,
  tasks: readonly LoadedPactPairTaskV1[],
  maxTicks: number,
  taskConcurrency: number,
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('File-driven single run ID must be a safe opaque identifier');
  }
  if (tasks.length === 0 || new Set(tasks.map(task => task.taskId)).size !== tasks.length) {
    throw new Error('File-driven single requires unique selected tasks');
  }
  if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0 || maxTicks > 10_000) {
    throw new Error('maxTicks must be a positive safe integer up to 10000');
  }
  if (!Number.isSafeInteger(taskConcurrency) || taskConcurrency < 1 || taskConcurrency > 32) {
    throw new Error('taskConcurrency must be a safe integer between 1 and 32');
  }
}

function singlePhysicalRunId(parentRunId: string, taskId: string, index: number): string {
  const safePrefix = parentRunId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 72)
    || 'sharedeval';
  return `${safePrefix}-single-${index + 1}-${digest(`${parentRunId}:${taskId}`).slice(0, 24)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
