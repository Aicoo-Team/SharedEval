import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { assertSingleExperimentBatchV1 } from './plan.js';
import type { BoundExperimentCellV1, PublishedExperimentPlanV1 } from './plan.js';

export const DEFAULT_EXPERIMENT_SCHEDULE_CONCURRENCY_V1 = 2;
export const MAX_EXPERIMENT_SCHEDULE_CONCURRENCY_V1 = 4;
export const DEFAULT_EXPERIMENT_CELL_RELAUNCHES_V1 = 1;
export const MAX_EXPERIMENT_CELL_RELAUNCHES_V1 = 8;
export const MAX_EXPERIMENT_BACKOFF_DELAY_MS_V1 = 300_000;
export const EXPERIMENT_CELL_CONFIG_FILE_SUFFIX_V1 = '.sharedeval-run.yaml';

export const DEFAULT_EXPERIMENT_SCHEDULE_BACKOFF_V1: ExperimentScheduleBackoffV1 = {
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 30_000,
};

/**
 * The scheduler launches cells exclusively through the production CLI: either
 * `npm run sharedeval -- …` in-tree or a caller-supplied wrapper script (for
 * example the run-level Docker `run-cell.sh`). It never reaches into
 * authorization, messages, files, or the task loop.
 */
export type ExperimentCellLauncherV1 =
  | Readonly<{ kind: 'npm-cli' }>
  | Readonly<{ kind: 'wrapper-script'; scriptPath: string }>;

export type ExperimentCellManifestV1 = BoundExperimentCellV1 & Readonly<{
  mode: 'multi' | 'single';
  configPath: string;
  command: readonly string[];
}>;

export type CompileExperimentPlanOptionsV1 = Readonly<{
  /** Directory holding one published sharedeval-run config per cell. */
  configDirectory: string;
  launcher?: ExperimentCellLauncherV1;
}>;

export function experimentCellConfigPathV1(
  configDirectory: string,
  cellId: string,
): string {
  return path.join(configDirectory, `${cellId}${EXPERIMENT_CELL_CONFIG_FILE_SUFFIX_V1}`);
}

export function experimentCellCommandV1(
  mode: 'multi' | 'single',
  configPath: string,
  runId: string,
  launcher: ExperimentCellLauncherV1 = { kind: 'npm-cli' },
): readonly string[] {
  const cliArguments = [mode, '--config', configPath, '--run-id', runId];
  if (launcher.kind === 'wrapper-script') {
    if (launcher.scriptPath.trim() === '') {
      throw new Error('Experiment launcher wrapper script path must not be empty');
    }
    return Object.freeze([launcher.scriptPath, ...cliArguments]);
  }
  return Object.freeze(['npm', 'run', 'sharedeval', '--', ...cliArguments]);
}

/**
 * plan -> ordered cell manifests. Order is canonical (codepoint-sorted by the
 * collision-checked runId), so a shuffled authoring order compiles to the
 * identical schedule. Manifests are frozen: nothing downstream may rewrite a
 * cell's identity or its command.
 */
export function compileExperimentPlanV1(
  published: PublishedExperimentPlanV1,
  options: CompileExperimentPlanOptionsV1,
): readonly ExperimentCellManifestV1[] {
  if (options.configDirectory.trim() === '') {
    throw new Error('Experiment config directory must not be empty');
  }
  assertSingleExperimentBatchV1(published.cells);
  for (const cell of published.cells) {
    if (cell.planDigest !== published.planDigest) {
      throw new Error('Experiment plan cell is bound to a different plan digest');
    }
  }
  const launcher = options.launcher ?? { kind: 'npm-cli' };
  const manifests = [...published.cells]
    .sort((left, right) => (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0))
    .map(cell => {
      const mode = cell.cell.workflow.mode;
      const configPath = experimentCellConfigPathV1(options.configDirectory, cell.cellId);
      return Object.freeze({
        ...cell,
        mode,
        configPath,
        command: experimentCellCommandV1(mode, configPath, cell.runId, launcher),
      });
    });
  return Object.freeze(manifests);
}

export type ExperimentCellExecResultV1 = Readonly<{
  exitCode: number | null;
  signal: string | null;
}>;

/** Exec seam: resolves when the launched production CLI process exits. */
export type ExperimentCellExecV1 = (
  command: readonly string[],
  manifest: ExperimentCellManifestV1,
) => Promise<ExperimentCellExecResultV1>;

export function nodeExperimentCellExecV1(): ExperimentCellExecV1 {
  return (command, _manifest) =>
    new Promise((resolve, reject) => {
      const [executable, ...processArguments] = command;
      if (!executable) {
        reject(new Error('Experiment cell command must not be empty'));
        return;
      }
      const child = spawn(executable, processArguments, { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
}

export type ExperimentCellFailureCauseV1 =
  | 'model_behavior_terminal'
  | 'infrastructure_failed'
  | 'indeterminate_external_operation';

/**
 * Evidence-based classification of one CLI exit, produced by the status
 * module from checkpoint state and provider telemetry — never from log text.
 */
export type ExperimentCellExitOutcomeV1 =
  | Readonly<{ kind: 'committed' }>
  | Readonly<{ kind: 'model_behavior_terminal'; detail?: string }>
  | Readonly<{
      kind: 'infrastructure_failed';
      beforeDurableCommit: boolean;
      detail?: string;
    }>
  | Readonly<{ kind: 'indeterminate_external_operation'; detail?: string }>;

export type ExperimentCellExitClassifierV1 = (
  manifest: ExperimentCellManifestV1,
  exit: ExperimentCellExecResultV1,
) => Promise<ExperimentCellExitOutcomeV1> | ExperimentCellExitOutcomeV1;

/**
 * Start-status probe over the run's durable authority (run directory /
 * ledger). A relaunch with the SAME runId is only sound when the previous
 * attempt provably never started the run; anything else fails closed.
 */
export type ExperimentRunStartStatusV1 = 'provably_not_started' | 'possibly_started';

export type ExperimentRunStatusProbeV1 = (
  manifest: ExperimentCellManifestV1,
) => Promise<ExperimentRunStartStatusV1> | ExperimentRunStartStatusV1;

export type ExperimentScheduleClockV1 = Readonly<{
  now(): number;
  sleep(delayMs: number): Promise<void>;
}>;

export function nodeExperimentScheduleClockV1(): ExperimentScheduleClockV1 {
  return {
    now: () => Date.now(),
    sleep: async delayMs => {
      await sleepMs(delayMs);
    },
  };
}

export type ExperimentScheduleBackoffV1 = Readonly<{
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}>;

export type ExperimentCellScheduleStateV1 =
  | 'planned'
  | 'starting'
  | 'running'
  | 'committed'
  | 'indeterminate'
  | 'failed';

export type ExperimentCellFinalScheduleStateV1 = 'committed' | 'indeterminate' | 'failed';

export type ExperimentCellTransitionV1 = Readonly<{
  state: ExperimentCellScheduleStateV1;
  atMs: number;
  /** 0 for the pre-launch planned transition, then 1-based per launch. */
  attempt: number;
  cause?: ExperimentCellFailureCauseV1;
  detail?: string;
  exitCode?: number | null;
}>;

export type ExperimentCellLedgerEntryV1 = Readonly<{
  planDigest: string;
  experimentId: string;
  cellId: string;
  runId: string;
  replicate: number;
  attempts: number;
  finalState: ExperimentCellFinalScheduleStateV1;
  failureCause?: ExperimentCellFailureCauseV1;
  transitions: readonly ExperimentCellTransitionV1[];
}>;

export type ExperimentScheduleLedgerV1 = Readonly<{
  planDigest: string;
  experimentId: string;
  concurrency: number;
  maxRelaunches: number;
  startedAtMs: number;
  finishedAtMs: number;
  cells: readonly ExperimentCellLedgerEntryV1[];
}>;

export type ExperimentScheduleTransitionEventV1 = Readonly<{
  cellId: string;
  runId: string;
  transition: ExperimentCellTransitionV1;
}>;

export type ExperimentScheduleOptionsV1 = Readonly<{
  exec: ExperimentCellExecV1;
  classifyExit: ExperimentCellExitClassifierV1;
  probeRunStart: ExperimentRunStatusProbeV1;
  clock?: ExperimentScheduleClockV1;
  concurrency?: number;
  maxRelaunches?: number;
  backoff?: ExperimentScheduleBackoffV1;
  onTransition?: (event: ExperimentScheduleTransitionEventV1) => void;
}>;

function resolveConcurrencyV1(concurrency: number | undefined): number {
  if (concurrency === undefined) return DEFAULT_EXPERIMENT_SCHEDULE_CONCURRENCY_V1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Experiment schedule concurrency must be a positive integer');
  }
  if (concurrency > MAX_EXPERIMENT_SCHEDULE_CONCURRENCY_V1) {
    throw new Error(
      `Experiment schedule concurrency must not exceed ${MAX_EXPERIMENT_SCHEDULE_CONCURRENCY_V1}`,
    );
  }
  return concurrency;
}

function resolveMaxRelaunchesV1(maxRelaunches: number | undefined): number {
  if (maxRelaunches === undefined) return DEFAULT_EXPERIMENT_CELL_RELAUNCHES_V1;
  if (!Number.isSafeInteger(maxRelaunches) || maxRelaunches < 0) {
    throw new Error('Experiment cell relaunch limit must be a non-negative integer');
  }
  if (maxRelaunches > MAX_EXPERIMENT_CELL_RELAUNCHES_V1) {
    throw new Error(
      `Experiment cell relaunch limit must not exceed ${MAX_EXPERIMENT_CELL_RELAUNCHES_V1}`,
    );
  }
  return maxRelaunches;
}

function resolveBackoffV1(
  backoff: ExperimentScheduleBackoffV1 | undefined,
): ExperimentScheduleBackoffV1 {
  const resolved = backoff ?? DEFAULT_EXPERIMENT_SCHEDULE_BACKOFF_V1;
  if (!Number.isSafeInteger(resolved.initialDelayMs) || resolved.initialDelayMs < 1) {
    throw new Error('Experiment backoff initial delay must be a positive integer');
  }
  if (!Number.isFinite(resolved.multiplier) || resolved.multiplier < 1) {
    throw new Error('Experiment backoff multiplier must be at least 1');
  }
  if (
    !Number.isSafeInteger(resolved.maxDelayMs)
    || resolved.maxDelayMs < resolved.initialDelayMs
    || resolved.maxDelayMs > MAX_EXPERIMENT_BACKOFF_DELAY_MS_V1
  ) {
    throw new Error(
      `Experiment backoff max delay must lie between the initial delay and ${MAX_EXPERIMENT_BACKOFF_DELAY_MS_V1}ms`,
    );
  }
  return resolved;
}

export function experimentBackoffDelayMsV1(
  backoff: ExperimentScheduleBackoffV1,
  relaunch: number,
): number {
  if (!Number.isSafeInteger(relaunch) || relaunch < 1) {
    throw new Error('Experiment backoff relaunch index must be a positive integer');
  }
  const delayMs = backoff.initialDelayMs * backoff.multiplier ** (relaunch - 1);
  return Math.min(backoff.maxDelayMs, Math.round(delayMs));
}

function assertManifestCommandV1(manifest: ExperimentCellManifestV1): void {
  const expectedTail = [
    manifest.mode,
    '--config',
    manifest.configPath,
    '--run-id',
    manifest.runId,
  ];
  const tail = manifest.command.slice(-expectedTail.length);
  const matches =
    tail.length === expectedTail.length
    && tail.every((argument, index) => argument === expectedTail[index]);
  if (!matches) {
    throw new Error(
      `Experiment cell ${manifest.cellId} command does not match its manifest identity`,
    );
  }
}

/**
 * Runs one compiled schedule with bounded concurrency. Cells launch in
 * manifest order as slots free up; each cell only ever executes its frozen
 * production-CLI command. On an infrastructure failure before any durable
 * commit the cell is relaunched with the SAME runId after bounded backoff, at
 * most maxRelaunches times, and only when the status probe proves the run
 * never started; every other failure (model behavior, indeterminate external
 * operation, possibly-started runs, exhausted relaunches, broken seams) is
 * recorded as terminal for the cell and the schedule continues.
 */
export async function runExperimentScheduleV1(
  manifests: readonly ExperimentCellManifestV1[],
  options: ExperimentScheduleOptionsV1,
): Promise<ExperimentScheduleLedgerV1> {
  assertSingleExperimentBatchV1(manifests);
  manifests.forEach(assertManifestCommandV1);
  const concurrency = resolveConcurrencyV1(options.concurrency);
  const maxRelaunches = resolveMaxRelaunchesV1(options.maxRelaunches);
  const backoff = resolveBackoffV1(options.backoff);
  const clock = options.clock ?? nodeExperimentScheduleClockV1();

  const startedAtMs = clock.now();
  const entries: ExperimentCellLedgerEntryV1[] = new Array(manifests.length);
  let nextIndex = 0;

  const runCell = async (
    manifest: ExperimentCellManifestV1,
  ): Promise<ExperimentCellLedgerEntryV1> => {
    const transitions: ExperimentCellTransitionV1[] = [];
    const record = (
      transition: Omit<ExperimentCellTransitionV1, 'atMs'>,
    ): void => {
      const stamped = Object.freeze({ ...transition, atMs: clock.now() });
      transitions.push(stamped);
      options.onTransition?.({
        cellId: manifest.cellId,
        runId: manifest.runId,
        transition: stamped,
      });
    };
    const finish = (
      finalState: ExperimentCellFinalScheduleStateV1,
      attempts: number,
      failureCause?: ExperimentCellFailureCauseV1,
    ): ExperimentCellLedgerEntryV1 =>
      Object.freeze({
        planDigest: manifest.planDigest,
        experimentId: manifest.experimentId,
        cellId: manifest.cellId,
        runId: manifest.runId,
        replicate: manifest.replicate,
        attempts,
        finalState,
        ...(failureCause === undefined ? {} : { failureCause }),
        transitions: Object.freeze([...transitions]),
      });

    record({ state: 'planned', attempt: 0 });
    let attempt = 1;
    for (;;) {
      record({ state: 'starting', attempt });
      record({ state: 'running', attempt });
      let outcome: ExperimentCellExitOutcomeV1;
      let exitCode: number | null | undefined;
      try {
        const exit = await options.exec(manifest.command, manifest);
        exitCode = exit.exitCode;
        outcome = await options.classifyExit(manifest, exit);
      } catch (error) {
        // A broken exec or classifier seam proves nothing about the run:
        // fail closed as infrastructure_failed with no relaunch eligibility.
        outcome = {
          kind: 'infrastructure_failed',
          beforeDurableCommit: false,
          detail: `scheduler seam failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      switch (outcome.kind) {
        case 'committed':
          record({ state: 'committed', attempt, exitCode });
          return finish('committed', attempt);
        case 'model_behavior_terminal':
          // Experimental data, never re-rolled: a relaunch would be best-of-N.
          record({
            state: 'failed',
            attempt,
            cause: 'model_behavior_terminal',
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            exitCode,
          });
          return finish('failed', attempt, 'model_behavior_terminal');
        case 'indeterminate_external_operation':
          record({
            state: 'indeterminate',
            attempt,
            cause: 'indeterminate_external_operation',
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            exitCode,
          });
          return finish('indeterminate', attempt, 'indeterminate_external_operation');
        case 'infrastructure_failed': {
          const relaunchesUsed = attempt - 1;
          if (outcome.beforeDurableCommit && relaunchesUsed < maxRelaunches) {
            let startStatus: ExperimentRunStartStatusV1;
            try {
              startStatus = await options.probeRunStart(manifest);
            } catch {
              startStatus = 'possibly_started';
            }
            if (startStatus === 'provably_not_started') {
              await clock.sleep(experimentBackoffDelayMsV1(backoff, relaunchesUsed + 1));
              attempt += 1;
              continue;
            }
          }
          record({
            state: 'failed',
            attempt,
            cause: 'infrastructure_failed',
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            exitCode,
          });
          return finish('failed', attempt, 'infrastructure_failed');
        }
      }
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      if (index >= manifests.length) return;
      nextIndex += 1;
      entries[index] = await runCell(manifests[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, manifests.length) }, () => worker()),
  );

  return Object.freeze({
    planDigest: manifests[0].planDigest,
    experimentId: manifests[0].experimentId,
    concurrency,
    maxRelaunches,
    startedAtMs,
    finishedAtMs: clock.now(),
    cells: Object.freeze(entries),
  });
}
