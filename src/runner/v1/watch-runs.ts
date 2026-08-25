import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { basename, join, sep } from 'node:path';
import { z } from 'zod';
import { retryablePactPairFailureV1 } from '../../suites/pact-pair/resume.js';

const runMetadataSchema = z
  .object({
    runId: z.string().min(1).max(256).optional(),
    status: z.string().min(1).max(256).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    selectedTasks: z.number().int().safe().nonnegative().optional(),
    resumed: z.literal(true).optional(),
    resumes: z
      .array(z
        .object({
          at: z.string().datetime({ offset: true }),
          taskIds: z.array(z.string().min(1).max(128)).max(10_000),
        })
        .passthrough())
      .max(1_000)
      .optional(),
  })
  .passthrough();

const taskResultSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    status: z.enum(['ok', 'infrastructure_error']),
    error: z.string().max(2_000).optional(),
    finalizeError: z.string().max(2_000).optional(),
    toolCalls: z.array(z.unknown()).max(10_000).optional(),
    violations: z.array(z.string().min(1).max(256)).max(10_000).optional(),
    sharedOs: z
      .object({ status: z.string().min(1).max(64) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const checkpointSchema = z
  .object({
    status: z.string().min(1).max(256),
    completedTasks: z.number().int().safe().nonnegative(),
    selectedTasks: z.number().int().safe().nonnegative(),
    errors: z.number().int().safe().nonnegative(),
  })
  .passthrough();

const summarySchema = z
  .object({
    total: z.number().int().safe().nonnegative(),
    errors: z.number().int().safe().nonnegative(),
  })
  .passthrough();

export const WATCH_RUNS_DEFAULT_LIMITS_V1 = Object.freeze({
  runJsonBytes: 1 * 1024 * 1024,
  resultsJsonlBytes: 64 * 1024 * 1024,
  checkpointJsonBytes: 1 * 1024 * 1024,
  summaryJsonBytes: 4 * 1024 * 1024,
  maxRuns: 2_048,
  concurrency: 8,
});

export type WatchTaskResultV1 = z.infer<typeof taskResultSchema>;

export type WatchTaskOutcomeV1 = {
  taskId: string;
  status: 'ok' | 'infrastructure_error';
  disposition: 'ok' | 'retryable' | 'terminal';
  completed: boolean;
};

export type RunOverviewV1 = {
  runId: string;
  directoryName: string;
  status: string;
  startedAt: number;
  selectedTasks: number;
  observedTasks: number;
  completedTasks: number;
  okTasks: number;
  retryableErrors: number;
  terminalErrors: number;
  ignoredPartialTail: boolean;
  tasks: WatchTaskOutcomeV1[];
  progress?: {
    at: number;
    taskIds: string[];
    completedTasks: number;
  };
  corruptError?: string;
};

export type WatchRunsLimitsV1 = Partial<Pick<
  typeof WATCH_RUNS_DEFAULT_LIMITS_V1,
  | 'runJsonBytes'
  | 'resultsJsonlBytes'
  | 'checkpointJsonBytes'
  | 'summaryJsonBytes'
>>;

export type InspectRunDirectoryV1Options = {
  limits?: WatchRunsLimitsV1;
};

export type CollectRunOverviewsV1Options = InspectRunDirectoryV1Options & {
  concurrency?: number;
  maxRuns?: number;
};

type CollectRunOverviewsV1Dependencies = {
  inspectRunDirectory?: (
    directory: string,
    options: InspectRunDirectoryV1Options,
  ) => Promise<RunOverviewV1 | null>;
};

/**
 * Preserves the public outer result status and adds only the resume
 * disposition used by the overview. The retry decision delegates to the
 * runner's versioned classifier; the watcher owns no shadow regex taxonomy.
 */
export function classifyWatchTaskResultV1(result: unknown): WatchTaskOutcomeV1 {
  const parsed = taskResultSchema.parse(result);
  if (parsed.status === 'ok') {
    return {
      taskId: parsed.taskId,
      status: parsed.status,
      disposition: 'ok',
      completed: true,
    };
  }

  const retryable = retryablePactPairFailureV1({
    taskId: parsed.taskId,
    status: parsed.status,
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
    ...(parsed.finalizeError === undefined
      ? {}
      : { finalizeError: parsed.finalizeError }),
    ...(parsed.violations === undefined ? {} : { violations: parsed.violations }),
    ...(parsed.toolCalls === undefined
      ? {}
      : {
          // The formal classifier consumes only whether any tool call exists.
          toolCalls: parsed.toolCalls.map((_, index) => ({
            id: `observed-${index}`,
            name: 'observed',
            isError: false,
          })),
        }),
  });

  return {
    taskId: parsed.taskId,
    status: parsed.status,
    disposition: retryable ? 'retryable' : 'terminal',
    completed: !retryable,
  };
}

/** Reads and validates one run using only the four public root artifacts. */
export async function inspectRunDirectoryV1(
  runDirectory: string,
  options: InspectRunDirectoryV1Options = {},
): Promise<RunOverviewV1 | null> {
  await assertSafeDirectory(runDirectory, 'run directory');
  const limits = { ...WATCH_RUNS_DEFAULT_LIMITS_V1, ...options.limits };
  const metadataSource = await readOptionalPublicFile(
    join(runDirectory, 'run.json'),
    limits.runJsonBytes,
    'run.json',
  );
  if (metadataSource === undefined) return null;
  const metadata = parseJsonArtifact(runMetadataSchema, metadataSource, 'run.json');
  const status = metadata.status ?? 'unknown';
  const isRunning = status === 'running';

  const resultsSource = await readOptionalPublicFile(
    join(runDirectory, 'results.jsonl'),
    limits.resultsJsonlBytes,
    'results.jsonl',
  );
  if (resultsSource === undefined && !isRunning) {
    throw new Error('results.jsonl is missing from a finalized run');
  }
  const parsedResults = parsePublicResultsJsonl(resultsSource ?? '', isRunning);
  const uniqueResults = new Map<string, WatchTaskResultV1>();
  for (const result of parsedResults.results) {
    const existing = uniqueResults.get(result.taskId);
    if (existing !== undefined && !isDeepStrictEqual(existing, result)) {
      throw new Error(`Conflicting public outcomes for task ${result.taskId}`);
    }
    if (existing === undefined) uniqueResults.set(result.taskId, result);
  }

  const outcomes = [...uniqueResults.values()].map(classifyWatchTaskResultV1);
  const infrastructureErrors = outcomes.filter(
    outcome => outcome.status === 'infrastructure_error',
  ).length;
  const checkpointSource = await readOptionalPublicFile(
    join(runDirectory, 'checkpoint.json'),
    limits.checkpointJsonBytes,
    'checkpoint.json',
  );
  const summarySource = await readOptionalPublicFile(
    join(runDirectory, 'summary.json'),
    limits.summaryJsonBytes,
    'summary.json',
  );
  if (!isRunning && checkpointSource === undefined) {
    throw new Error('checkpoint.json is missing from a finalized run');
  }
  if (!isRunning && summarySource === undefined) {
    throw new Error('summary.json is missing from a finalized run');
  }
  const checkpoint = checkpointSource === undefined
    ? undefined
    : parseJsonArtifact(checkpointSchema, checkpointSource, 'checkpoint.json');
  const summary = summarySource === undefined
    ? undefined
    : parseJsonArtifact(summarySchema, summarySource, 'summary.json');

  const selectedTasks = metadata.selectedTasks
    ?? checkpoint?.selectedTasks
    ?? summary?.total
    ?? uniqueResults.size;
  assertArtifactConsistency({
    status,
    selectedTasks,
    metadataSelectedTasks: metadata.selectedTasks,
    observedTasks: uniqueResults.size,
    infrastructureErrors,
    checkpoint,
    summary,
  });

  const latestResume = metadata.resumes?.at(-1);
  const progress = latestResume === undefined
    ? undefined
    : publicProgress(latestResume, outcomes);
  return {
    runId: metadata.runId ?? basename(runDirectory),
    directoryName: basename(runDirectory),
    status,
    startedAt: metadata.startedAt === undefined
      ? 0
      : Date.parse(metadata.startedAt),
    selectedTasks,
    observedTasks: outcomes.length,
    completedTasks: outcomes.filter(outcome => outcome.completed).length,
    okTasks: outcomes.filter(outcome => outcome.disposition === 'ok').length,
    retryableErrors: outcomes.filter(
      outcome => outcome.disposition === 'retryable',
    ).length,
    terminalErrors: outcomes.filter(
      outcome => outcome.disposition === 'terminal',
    ).length,
    ignoredPartialTail: parsedResults.ignoredPartialTail,
    tasks: outcomes,
    ...(progress === undefined ? {} : { progress }),
  };
}

/** Scans immediate child directories with a bounded worker pool. */
export async function collectRunOverviewsV1(
  runsRoot: string,
  options: CollectRunOverviewsV1Options = {},
  dependencies: CollectRunOverviewsV1Dependencies = {},
): Promise<RunOverviewV1[]> {
  let rootInfo;
  try {
    rootInfo = await lstat(runsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`Runs root ${runsRoot} is a symlink; refusing path escape`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`Runs root ${runsRoot} is not a directory`);
  }

  const rootRealPath = await realpath(runsRoot);
  const entries = (await readdir(runsRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink());
  const maxRuns = options.maxRuns ?? WATCH_RUNS_DEFAULT_LIMITS_V1.maxRuns;
  assertPositiveSafeInteger(maxRuns, 'maxRuns');
  if (entries.length > maxRuns) {
    throw new Error(
      `Runs root contains ${entries.length} candidate directories; limit ${maxRuns}`,
    );
  }
  const concurrency = options.concurrency
    ?? WATCH_RUNS_DEFAULT_LIMITS_V1.concurrency;
  assertPositiveSafeInteger(concurrency, 'concurrency');
  const inspect = dependencies.inspectRunDirectory ?? inspectRunDirectoryV1;
  const inspected = await mapConcurrent(entries, concurrency, async entry => {
    if (entry.isSymbolicLink()) {
      return corruptOverview(
        entry.name,
        `Run path ${entry.name} is a symlink; refusing path escape`,
      );
    }
    const directory = join(runsRoot, entry.name);
    try {
      const childRealPath = await realpath(directory);
      if (!isPathInside(rootRealPath, childRealPath)) {
        throw new Error(`Run path ${entry.name} escapes the runs root`);
      }
      return await inspect(directory, { limits: options.limits });
    } catch (error) {
      return corruptOverview(entry.name, errorMessage(error));
    }
  });

  return inspected
    .filter((run): run is RunOverviewV1 => run !== null)
    .sort((left, right) => right.startedAt - left.startedAt
      || left.directoryName.localeCompare(right.directoryName));
}

export function formatRunEtaV1(run: RunOverviewV1, now: number): string {
  if (run.status !== 'running') return '-';
  const progress = run.progress;
  if (progress === undefined || progress.completedTasks === 0) return '?';
  const remaining = progress.taskIds.length - progress.completedTasks;
  if (remaining <= 0) return 'finishing';
  const elapsed = now - progress.at;
  if (!Number.isFinite(elapsed) || elapsed < 0) return '?';
  return `~${formatDuration(elapsed / progress.completedTasks * remaining)}`;
}

export function renderRunOverviewTableV1(
  runs: readonly RunOverviewV1[],
  runsRoot: string,
  now: number,
): string {
  const header = [
    'RUN',
    'DIR',
    'STATUS',
    'DONE',
    'OK',
    'ERR(retryable/terminal)',
    'PROGRESS',
    'ETA',
    'ERROR',
  ];
  const rows = runs.map(run => {
    const errors = run.retryableErrors + run.terminalErrors;
    return [
      escapeDisplay(run.runId, 64),
      escapeDisplay(run.directoryName, 64),
      escapeDisplay(run.status, 64),
      `${run.completedTasks}/${run.selectedTasks}`,
      String(run.okTasks),
      errors === 0 ? '0' : `${errors} (${run.retryableErrors}/${run.terminalErrors})`,
      run.progress === undefined
        ? '-'
        : `${formatDuration(now - run.progress.at)} ago`,
      formatRunEtaV1(run, now),
      escapeDisplay(run.corruptError ?? '', 160),
    ];
  });
  const widths = header.map((cell, column) => Math.max(
    cell.length,
    ...rows.map(row => row[column]?.length ?? 0),
  ));
  const renderRow = (row: readonly string[]): string => row
    .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
    .join('  ')
    .trimEnd();
  const running = runs.filter(run => run.status === 'running').length;
  const completed = runs.reduce((total, run) => total + run.completedTasks, 0);
  const selected = runs.reduce((total, run) => total + run.selectedTasks, 0);
  return [
    `${escapeDisplay(runsRoot, 256)} — ${runs.length} run(s), ${running} running, `
      + `${completed}/${selected} trials done — ${new Date(now).toLocaleTimeString()}`,
    '',
    renderRow(header),
    ...rows.map(renderRow),
  ].join('\n');
}

export type WatchRunsCliOptionsV1 = {
  runsRoot: string;
  intervalMs: number;
  once: boolean;
};

export class WatchRunsCliArgumentErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchRunsCliArgumentErrorV1';
  }
}

export function parseWatchRunsArgsV1(argv: readonly string[]): WatchRunsCliOptionsV1 {
  let runsRoot = 'runs';
  let intervalMs = 2_000;
  let once = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--once') {
      once = true;
      continue;
    }
    if (argument === '--dir' || argument === '-d') {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('-')) {
        throw new WatchRunsCliArgumentErrorV1('--dir requires a non-empty path');
      }
      runsRoot = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--dir=')) {
      const value = argument.slice('--dir='.length);
      if (value.length === 0) {
        throw new WatchRunsCliArgumentErrorV1('--dir requires a non-empty path');
      }
      runsRoot = value;
      continue;
    }
    if (argument === '--interval' || argument === '-i') {
      const value = argv[index + 1];
      intervalMs = parseInterval(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--interval=')) {
      intervalMs = parseInterval(argument.slice('--interval='.length));
      continue;
    }
    throw new WatchRunsCliArgumentErrorV1(`Unknown argument: ${escapeDisplay(argument)}`);
  }
  return { runsRoot, intervalMs, once };
}

export const WATCH_RUNS_USAGE_V1 =
  'Usage: npm run watch:runs -- [--dir <runsRoot>] [--interval <seconds>] [--once]';

export type WatchRunOverviewsV1Options = WatchRunsCliOptionsV1 & {
  signal?: AbortSignal;
};

type WatchRunOverviewsV1Dependencies = {
  collectRuns?: (runsRoot: string) => Promise<RunOverviewV1[]>;
  write?: (source: string) => void;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

/** Sequential refresh loop: the next delay starts only after a scan renders. */
export async function watchRunOverviewsV1(
  options: Omit<WatchRunOverviewsV1Options, 'once'> & { once?: boolean },
  dependencies: WatchRunOverviewsV1Dependencies = {},
): Promise<void> {
  const collectRuns = dependencies.collectRuns ?? collectRunOverviewsV1;
  const write = dependencies.write ?? (source => { process.stdout.write(source); });
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? waitForNextRefresh;
  do {
    const runs = await collectRuns(options.runsRoot);
    const body = runs.length === 0
      ? `${escapeDisplay(options.runsRoot, 256)} — no run directories found`
      : renderRunOverviewTableV1(runs, options.runsRoot, now());
    write(options.once ? `${body}\n` : `\u001b[2J\u001b[H${body}\n`);
    if (options.once || options.signal?.aborted) return;
    await wait(options.intervalMs, options.signal);
  } while (!options.signal?.aborted);
}

export async function runWatchRunsCliV1(
  argv: readonly string[],
  streams: {
    writeStdout?: (source: string) => void;
    writeStderr?: (source: string) => void;
  } = {},
): Promise<number> {
  const writeStdout = streams.writeStdout ?? (source => { process.stdout.write(source); });
  const writeStderr = streams.writeStderr ?? (source => { process.stderr.write(source); });
  let options: WatchRunsCliOptionsV1;
  try {
    options = parseWatchRunsArgsV1(argv);
  } catch (error) {
    if (!(error instanceof WatchRunsCliArgumentErrorV1)) throw error;
    writeStderr(`${escapeDisplay(error.message, 512)}\n${WATCH_RUNS_USAGE_V1}\n`);
    return 2;
  }
  try {
    await watchRunOverviewsV1(options, { write: writeStdout });
    return 0;
  } catch (error) {
    writeStderr(`watch:runs failed: ${escapeDisplay(errorMessage(error), 512)}\n`);
    return 1;
  }
}

function parsePublicResultsJsonl(
  source: string,
  isRunning: boolean,
): { results: WatchTaskResultV1[]; ignoredPartialTail: boolean } {
  const terminated = source.endsWith('\n');
  const lines = source.split('\n');
  if (terminated) lines.pop();
  const results: WatchTaskResultV1[] = [];
  let ignoredPartialTail = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      results.push(taskResultSchema.parse(JSON.parse(line)));
    } catch (error) {
      const isUnterminatedTail = !terminated && index === lines.length - 1;
      if (isRunning && isUnterminatedTail) {
        ignoredPartialTail = true;
        continue;
      }
      throw new Error(
        `results.jsonl line ${index + 1} is invalid (${errorMessage(error)})`,
      );
    }
  }
  return { results, ignoredPartialTail };
}

function assertArtifactConsistency(input: {
  status: string;
  selectedTasks: number;
  metadataSelectedTasks?: number;
  observedTasks: number;
  infrastructureErrors: number;
  checkpoint?: z.infer<typeof checkpointSchema>;
  summary?: z.infer<typeof summarySchema>;
}): void {
  const { checkpoint, summary } = input;
  if (input.observedTasks > input.selectedTasks) {
    throw new Error(
      `results.jsonl has ${input.observedTasks} unique results but selectedTasks is `
      + `${input.selectedTasks}`,
    );
  }
  if (checkpoint !== undefined) {
    if (checkpoint.completedTasks !== input.observedTasks) {
      throw new Error(
        `Checkpoint completedTasks ${checkpoint.completedTasks} conflicts with `
        + `${input.observedTasks} unique result task ids`,
      );
    }
    if (checkpoint.selectedTasks !== input.selectedTasks) {
      throw new Error(
        `Checkpoint selectedTasks ${checkpoint.selectedTasks} conflicts with `
        + `run selectedTasks ${input.selectedTasks}`,
      );
    }
    if (checkpoint.errors !== input.infrastructureErrors) {
      throw new Error(
        `Checkpoint errors ${checkpoint.errors} conflicts with `
        + `${input.infrastructureErrors} infrastructure results`,
      );
    }
    if (checkpoint.status !== input.status) {
      throw new Error(
        `Checkpoint status ${checkpoint.status} conflicts with run status ${input.status}`,
      );
    }
  }
  if (
    input.metadataSelectedTasks !== undefined
    && input.metadataSelectedTasks !== input.selectedTasks
  ) {
    throw new Error('run selectedTasks conflicts with public progress artifacts');
  }
  if (summary !== undefined) {
    if (summary.total !== input.observedTasks) {
      throw new Error(
        `Summary total ${summary.total} conflicts with `
        + `${input.observedTasks} unique result task ids`,
      );
    }
    if (summary.errors !== input.infrastructureErrors) {
      throw new Error(
        `Summary errors ${summary.errors} conflicts with `
        + `${input.infrastructureErrors} infrastructure results`,
      );
    }
  }
}

function publicProgress(
  resume: { at: string; taskIds: string[] },
  outcomes: readonly WatchTaskOutcomeV1[],
): NonNullable<RunOverviewV1['progress']> {
  const taskIds = new Set<string>();
  for (const taskId of resume.taskIds) {
    if (taskIds.has(taskId)) {
      throw new Error(`Latest resume progress repeats task ${taskId}`);
    }
    taskIds.add(taskId);
  }
  const outcomeByTaskId = new Map(outcomes.map(outcome => [outcome.taskId, outcome]));
  return {
    at: Date.parse(resume.at),
    taskIds: [...resume.taskIds],
    completedTasks: resume.taskIds.filter(
      taskId => outcomeByTaskId.get(taskId)?.completed === true,
    ).length,
  };
}

async function assertSafeDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`${label} ${path} is a symlink; refusing path escape`);
  }
  if (!info.isDirectory()) throw new Error(`${label} ${path} is not a directory`);
}

async function readOptionalPublicFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string | undefined> {
  assertPositiveSafeInteger(maximumBytes, `${label} byte limit`);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${label} is a symlink; refusing path escape`);
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
  if (info.size > maximumBytes) {
    throw new Error(`${label} is ${info.size} bytes; limit ${maximumBytes}`);
  }

  const noFollow = 'O_NOFOLLOW' in constants
    ? constants.O_NOFOLLOW as number
    : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw new Error(`${label} is not a regular file`);
    if (openedInfo.size > maximumBytes) {
      throw new Error(`${label} is ${openedInfo.size} bytes; limit ${maximumBytes}`);
    }
    const expectedBytes = openedInfo.size;
    const buffer = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        expectedBytes - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const afterReadInfo = await handle.stat();
    if (
      offset !== expectedBytes
      || afterReadInfo.size !== expectedBytes
      || afterReadInfo.mtimeMs !== openedInfo.mtimeMs
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseJsonArtifact<T extends z.ZodTypeAny>(
  schema: T,
  source: string,
  label: string,
): z.infer<T> {
  try {
    return schema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`${label} is invalid (${errorMessage(error)})`);
  }
}

function corruptOverview(directoryName: string, message: string): RunOverviewV1 {
  return {
    runId: directoryName,
    directoryName,
    status: 'corrupt',
    startedAt: 0,
    selectedTasks: 0,
    observedTasks: 0,
    completedTasks: 0,
    okTasks: 0,
    retryableErrors: 0,
    terminalErrors: 0,
    ignoredPartialTail: false,
    tasks: [],
    corruptError: message,
  };
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await worker(values[index] as T);
      }
    },
  );
  await Promise.all(runners);
  return output;
}

function parseInterval(source: string | undefined): number {
  const seconds = source === undefined || source.trim().length === 0
    ? Number.NaN
    : Number(source);
  const milliseconds = seconds * 1_000;
  if (
    !Number.isFinite(seconds)
    || seconds <= 0
    || !Number.isFinite(milliseconds)
    || milliseconds > 2_147_483_647
  ) {
    throw new WatchRunsCliArgumentErrorV1(
      '--interval requires a positive finite number of seconds',
    );
  }
  return milliseconds;
}

async function waitForNextRefresh(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolvePromise();
    }
  });
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '?';
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function escapeDisplay(value: string, maximumLength = 256): string {
  let escaped = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\n') escaped += '\\n';
    else if (character === '\r') escaped += '\\r';
    else if (character === '\t') escaped += '\\t';
    else if (
      code < 0x20
      || code === 0x7f
      || (code >= 0x80 && code <= 0x9f)
    ) {
      escaped += `\\x${code.toString(16).padStart(2, '0')}`;
    } else if (code === 0x2028 || code === 0x2029) {
      escaped += `\\u${code.toString(16)}`;
    } else escaped += character;
    if (escaped.length >= maximumLength) {
      return `${escaped.slice(0, Math.max(0, maximumLength - 1))}…`;
    }
  }
  return escaped;
}

function isPathInside(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
