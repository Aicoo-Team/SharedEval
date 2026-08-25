import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyWatchTaskResultV1,
  collectRunOverviewsV1,
  formatRunEtaV1,
  inspectRunDirectoryV1,
  parseWatchRunsArgsV1,
  renderRunOverviewTableV1,
  watchRunOverviewsV1,
  type RunOverviewV1,
} from '../../src/runner/v1/watch-runs.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('preserves outer task status while using the formal retry taxonomy', () => {
  const cases = [
    {
      name: 'transient provider failure before tools',
      result: result('Q-transient', 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
      }),
      disposition: 'retryable',
    },
    {
      name: 'provider-invalid response',
      result: result('Q-invalid', 'infrastructure_error', {
        error: 'model returned no tool decision',
      }),
      disposition: 'terminal',
    },
    {
      name: 'finalize failure',
      result: result('Q-finalize', 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
        finalizeError: 'adapter close failed',
      }),
      disposition: 'terminal',
    },
    {
      name: 'failure after a tool call',
      result: result('Q-tool', 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
        toolCalls: [{ id: 'call-1', name: 'answer', isError: false }],
      }),
      disposition: 'terminal',
    },
    {
      name: 'provider configuration failure',
      result: result('Q-config', 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
        violations: ['provider_configuration_error'],
      }),
      disposition: 'terminal',
    },
    {
      name: 'adapter protocol failure',
      result: result('Q-protocol', 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
        violations: ['adapter_protocol_error'],
      }),
      disposition: 'terminal',
    },
    ...[
      'max_runtime_ms_exceeded',
      'max_turns_exceeded',
      'max_tool_calls_exceeded',
    ].map((violation, index) => ({
      name: `budget failure ${violation}`,
      result: result(`Q-budget-${index}`, 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
        violations: [violation],
      }),
      disposition: 'terminal',
    })),
    {
      name: 'SharedOS denial is an experiment outcome',
      result: result('Q-denied', 'infrastructure_error', {
        error: 'HTTP 503 temporarily unavailable',
        sharedOs: { status: 'denied' },
      }),
      disposition: 'terminal',
    },
    {
      name: 'successful trial',
      result: result('Q-ok', 'ok'),
      disposition: 'ok',
    },
  ] as const;

  for (const entry of cases) {
    const classified = classifyWatchTaskResultV1(entry.result);
    assert.equal(classified.status, entry.result.status, entry.name);
    assert.equal(classified.disposition, entry.disposition, entry.name);
    assert.equal(
      classified.completed,
      entry.disposition === 'ok' || entry.disposition === 'terminal',
      entry.name,
    );
  }
});

test('reads current and pre-journal public artifacts and counts unique task ids', async t => {
  const root = await temporaryDirectory(t);
  await createRun(root, 'current', {
    run: runMetadata('current', 'completed_with_errors', 3),
    results: [
      result('Q1', 'ok', { extraCurrentField: { provider: 'example' } }),
      result('Q2', 'infrastructure_error', { error: 'invalid tool arguments' }),
      result('Q3', 'infrastructure_error', { error: 'HTTP 503 temporarily unavailable' }),
    ],
    checkpoint: checkpoint('completed_with_errors', 3, 3, 2),
    summary: { total: 3, errors: 2, historicalExtra: true },
  });
  await createRun(root, 'historical', {
    run: runMetadata('historical', 'running', 2),
    results: [
      { taskId: 'old-Q1', status: 'ok' },
      { taskId: 'old-Q2', status: 'infrastructure_error', error: 'ECONNRESET' },
    ],
    checkpoint: checkpoint('running', 2, 2, 1),
  });

  const runs = await collectRunOverviewsV1(root);
  assert.equal(runs.length, 2);
  const current = runs.find(run => run.runId === 'current');
  assert.ok(current);
  assert.deepEqual(
    pickCounts(current),
    { observed: 3, completed: 2, ok: 1, retryable: 1, terminal: 1 },
  );
  const historical = runs.find(run => run.runId === 'historical');
  assert.ok(historical);
  assert.deepEqual(
    pickCounts(historical),
    { observed: 2, completed: 1, ok: 1, retryable: 1, terminal: 0 },
  );
});

test('collapses identical duplicate outcomes and rejects distinct same-task outcomes', async t => {
  const root = await temporaryDirectory(t);
  const duplicate = result('Q1', 'ok');
  const identicalDirectory = await createRun(root, 'identical', {
    run: runMetadata('identical', 'running', 1),
    results: [duplicate, { ...duplicate }],
    checkpoint: checkpoint('running', 1, 1, 0),
  });
  const identical = await inspectRunDirectoryV1(identicalDirectory);
  assert.ok(identical);
  assert.equal(identical.observedTasks, 1);
  assert.equal(identical.completedTasks, 1);

  const conflictDirectory = await createRun(root, 'conflict', {
    run: runMetadata('conflict', 'running', 1),
    results: [
      result('Q1', 'infrastructure_error', { error: 'ECONNRESET' }),
      result('Q1', 'ok'),
    ],
    checkpoint: checkpoint('running', 1, 1, 1),
  });
  await assert.rejects(
    inspectRunDirectoryV1(conflictDirectory),
    /conflicting public outcomes for task Q1/i,
  );
});

test('accepts a valid final JSONL line without a newline', async t => {
  const root = await temporaryDirectory(t);
  const directory = await createRun(root, 'no-newline', {
    run: runMetadata('no-newline', 'completed', 1),
    results: [result('Q1', 'ok')],
    resultsEndWithNewline: false,
    checkpoint: checkpoint('completed', 1, 1, 0),
    summary: { total: 1, errors: 0 },
  });

  const overview = await inspectRunDirectoryV1(directory);
  assert.ok(overview);
  assert.equal(overview.observedTasks, 1);
  assert.equal(overview.ignoredPartialTail, false);
});

test('tolerates only one malformed unterminated tail while a run is running', async t => {
  const root = await temporaryDirectory(t);
  const running = await createRun(root, 'running-tail', {
    run: runMetadata('running-tail', 'running', 1),
    rawResults: `${JSON.stringify(result('Q1', 'ok'))}\n{"taskId":`,
    checkpoint: checkpoint('running', 1, 1, 0),
  });
  const overview = await inspectRunDirectoryV1(running);
  assert.ok(overview);
  assert.equal(overview.observedTasks, 1);
  assert.equal(overview.ignoredPartialTail, true);

  const terminated = await createRun(root, 'terminated-tail', {
    run: runMetadata('terminated-tail', 'running', 1),
    rawResults: `${JSON.stringify(result('Q1', 'ok'))}\n{"taskId":\n`,
    checkpoint: checkpoint('running', 1, 1, 0),
  });
  await assert.rejects(inspectRunDirectoryV1(terminated), /results\.jsonl line 2/i);

  const interior = await createRun(root, 'interior-tail', {
    run: runMetadata('interior-tail', 'running', 2),
    rawResults: `${JSON.stringify(result('Q1', 'ok'))}\n{"taskId":\n${JSON.stringify(result('Q2', 'ok'))}`,
    checkpoint: checkpoint('running', 2, 2, 0),
  });
  await assert.rejects(inspectRunDirectoryV1(interior), /results\.jsonl line 2/i);

  const finalized = await createRun(root, 'final-tail', {
    run: runMetadata('final-tail', 'completed', 1),
    rawResults: `${JSON.stringify(result('Q1', 'ok'))}\n{"taskId":`,
    checkpoint: checkpoint('completed', 1, 1, 0),
    summary: { total: 1, errors: 0 },
  });
  await assert.rejects(inspectRunDirectoryV1(finalized), /results\.jsonl line 2/i);
});

test('fails closed on checkpoint and results conflicts', async t => {
  const root = await temporaryDirectory(t);
  const cases = [
    {
      name: 'completed count',
      checkpoint: checkpoint('running', 0, 1, 0),
      summary: undefined,
      pattern: /checkpoint completedTasks 0.*1 unique result/i,
    },
    {
      name: 'selected count',
      checkpoint: checkpoint('running', 1, 2, 0),
      summary: undefined,
      pattern: /selectedTasks.*conflicts/i,
    },
    {
      name: 'error count',
      checkpoint: checkpoint('running', 1, 1, 1),
      summary: undefined,
      pattern: /checkpoint errors 1.*0 infrastructure/i,
    },
    {
      name: 'status',
      checkpoint: checkpoint('completed', 1, 1, 0),
      summary: undefined,
      pattern: /checkpoint status.*conflicts/i,
    },
    {
      name: 'summary total',
      checkpoint: checkpoint('completed', 1, 1, 0),
      summary: { total: 2, errors: 0 },
      runStatus: 'completed',
      pattern: /summary total 2.*1 unique result/i,
    },
  ] as const;

  for (const entry of cases) {
    const directory = await createRun(root, entry.name.replaceAll(' ', '-'), {
      run: runMetadata(
        entry.name,
        'runStatus' in entry ? entry.runStatus : 'running',
        1,
      ),
      results: [result('Q1', 'ok')],
      checkpoint: entry.checkpoint,
      ...('summary' in entry && entry.summary !== undefined
        ? { summary: entry.summary }
        : {}),
    });
    await assert.rejects(inspectRunDirectoryV1(directory), entry.pattern, entry.name);
  }
});

test('uses the latest public resume epoch for ETA instead of the original start or file mtime', async t => {
  const root = await temporaryDirectory(t);
  const directory = await createRun(root, 'resumed', {
    run: {
      ...runMetadata('resumed', 'running', 5),
      startedAt: '2020-01-01T00:00:00.000Z',
      resumed: true,
      resumes: [{
        at: '2026-08-25T00:00:00.000Z',
        taskIds: ['Q1', 'Q2', 'Q3'],
      }],
    },
    results: [
      result('Q1', 'ok'),
      result('Q2', 'infrastructure_error', { error: 'invalid tool arguments' }),
      result('Q4', 'ok'),
      result('Q5', 'ok'),
    ],
    checkpoint: checkpoint('running', 4, 5, 1),
  });
  const overview = await inspectRunDirectoryV1(directory);
  assert.ok(overview);
  assert.equal(overview.progress?.at, Date.parse('2026-08-25T00:00:00.000Z'));
  assert.deepEqual(overview.progress?.taskIds, ['Q1', 'Q2', 'Q3']);
  assert.equal(overview.progress?.completedTasks, 2);
  assert.equal(
    formatRunEtaV1(overview, Date.parse('2026-08-25T00:00:20.000Z')),
    '~10s',
  );

  const initial = { ...overview, progress: undefined };
  assert.equal(
    formatRunEtaV1(initial, Date.parse('2026-08-25T00:00:20.000Z')),
    '?',
  );
});

test('undercounts commit-only private state without reading or rendering it', async t => {
  const root = await temporaryDirectory(t);
  const directory = await createRun(root, 'public-only', {
    run: runMetadata('public-only', 'running', 2),
    results: [result('Q1', 'ok')],
    checkpoint: checkpoint('running', 1, 2, 0),
  });
  const privateDirectory = join(directory, 'private');
  await mkdir(privateDirectory);
  const commitsDirectory = join(privateDirectory, 'task-commits');
  await mkdir(commitsDirectory);
  await writeFile(
    join(commitsDirectory, 'Q2-PRIVATE_COMMIT_SENTINEL.json'),
    'GOLD_PRIVATE_SENTINEL',
  );
  await chmod(privateDirectory, 0o000);
  let runs: RunOverviewV1[];
  let rendered: string;
  try {
    runs = await collectRunOverviewsV1(root);
    rendered = renderRunOverviewTableV1(runs, root, Date.now());
  } finally {
    await chmod(privateDirectory, 0o700);
  }
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.observedTasks, 1);
  assert.equal(runs[0]?.completedTasks, 1);
  assert.equal(rendered.includes('GOLD_PRIVATE_SENTINEL'), false);
  assert.equal(rendered.includes('Q2-PRIVATE_COMMIT_SENTINEL'), false);
});

test('rejects symlinked roots, run directories, and public artifacts without leaking targets', async t => {
  const root = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await createRun(outside, 'outside-run', {
    run: runMetadata('PRIVATE_TARGET_SENTINEL', 'running', 0),
    results: [],
  });
  await symlink(join(outside, 'outside-run'), join(root, 'linked-run'), 'dir');
  const collected = await collectRunOverviewsV1(root);
  assert.equal(collected.length, 1);
  assert.equal(collected[0]?.status, 'corrupt');
  assert.equal(
    renderRunOverviewTableV1(collected, root, Date.now()).includes('PRIVATE_TARGET_SENTINEL'),
    false,
  );

  const rootLink = join(dirname(root), `${root.split('/').at(-1)}-link`);
  await symlink(root, rootLink, 'dir');
  t.after(async () => { await rm(rootLink, { force: true }); });
  await assert.rejects(collectRunOverviewsV1(rootLink), /runs root.*symlink/i);

  const publicLinkRun = await createRun(root, 'public-link', {
    run: runMetadata('public-link', 'running', 1),
  });
  const target = join(outside, 'target-results.jsonl');
  await writeFile(target, 'PRIVATE_FILE_SENTINEL');
  await symlink(target, join(publicLinkRun, 'results.jsonl'));
  await assert.rejects(
    inspectRunDirectoryV1(publicLinkRun),
    error => error instanceof Error
      && /results\.jsonl.*symlink/i.test(error.message)
      && !error.message.includes('PRIVATE_FILE_SENTINEL'),
  );
});

test('rejects oversized public artifacts before reading them', async t => {
  const root = await temporaryDirectory(t);
  const directory = join(root, 'oversized');
  await mkdir(directory);
  await writeFile(join(directory, 'run.json'), 'x'.repeat(129));

  await assert.rejects(
    inspectRunDirectoryV1(directory, {
      limits: { runJsonBytes: 128 },
    }),
    /run\.json.*129 bytes.*limit 128/i,
  );
});

test('bounds concurrent run scans', async t => {
  const root = await temporaryDirectory(t);
  for (let index = 0; index < 7; index += 1) {
    await mkdir(join(root, `run-${index}`));
  }
  let active = 0;
  let maximumActive = 0;
  const runs = await collectRunOverviewsV1(root, { concurrency: 2 }, {
    inspectRunDirectory: async directory => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return overview(directory.split('/').at(-1) ?? directory);
    },
  });

  assert.equal(runs.length, 7);
  assert.equal(maximumActive, 2);
});

test('waits for each refresh to finish before starting the next one', async () => {
  const controller = new AbortController();
  let active = 0;
  let maximumActive = 0;
  let scans = 0;
  await watchRunOverviewsV1({
    runsRoot: '/unused',
    intervalMs: 1,
    signal: controller.signal,
  }, {
    collectRuns: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      scans += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      if (scans === 3) controller.abort();
      return [];
    },
    write: () => {},
    now: () => 0,
    wait: async () => {},
  });

  assert.equal(scans, 3);
  assert.equal(maximumActive, 1);
});

test('escapes control characters from root, run id, status, path, and errors', () => {
  const run: RunOverviewV1 = {
    ...overview('run\n\u001b[31m'),
    status: 'running\rBAD',
    directoryName: 'dir\nBAD',
    corruptError: 'failure\n\u001b[2J',
  };
  const rendered = renderRunOverviewTableV1([run], 'root\n\u001b[H', 0);

  assert.equal(rendered.includes('\u001b'), false);
  assert.equal(rendered.includes('\r'), false);
  assert.equal(rendered.includes('run\n'), false);
  assert.match(rendered, /run\\n\\x1b\[31m/);
  assert.match(rendered, /running\\rBAD/);
  assert.match(rendered, /root\\n\\x1b\[H/);
  assert.match(rendered, /failure\\n\\x1b\[2J/);
});

test('renders retryable and terminal error counts without relabeling task status', () => {
  const run = {
    ...overview('display'),
    selectedTasks: 4,
    observedTasks: 4,
    completedTasks: 3,
    okTasks: 2,
    retryableErrors: 1,
    terminalErrors: 1,
  };
  const rendered = renderRunOverviewTableV1([run], '/runs', 0);
  assert.match(rendered, /ERR\(retryable\/terminal\)/);
  assert.match(rendered, /3\/4/);
  assert.match(rendered, /2/);
  assert.match(rendered, /2 \(1\/1\)/);
  assert.equal(rendered.includes('model/other'), false);
});

test('rejects missing, non-positive, and non-finite CLI intervals', () => {
  for (const argv of [
    ['--interval'],
    ['--interval', '0'],
    ['--interval=-1'],
    ['--interval', 'NaN'],
    ['--interval=Infinity'],
  ]) {
    assert.throws(
      () => parseWatchRunsArgsV1(argv),
      /--interval requires a positive finite number/i,
      argv.join(' '),
    );
  }
  assert.throws(
    () => parseWatchRunsArgsV1(['--dir']),
    /--dir requires a non-empty path/i,
  );
});

test('thin CLI exits 2 for invalid interval forms', () => {
  const tsxCli = join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  for (const argv of [['--interval', '0'], ['--interval']]) {
    const child = spawnSync(
      process.execPath,
      [tsxCli, 'scripts/watch_runs.ts', ...argv, '--once'],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(child.status, 2, `${argv.join(' ')}\n${child.stderr}`);
    assert.match(child.stderr, /positive finite number/i);
    assert.match(child.stderr, /Usage: npm run watch:runs/i);
  }
});

type RunFixtureOptions = {
  run: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
  rawResults?: string;
  resultsEndWithNewline?: boolean;
  checkpoint?: Record<string, unknown>;
  summary?: Record<string, unknown>;
};

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-watch-runs-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function createRun(
  root: string,
  name: string,
  options: RunFixtureOptions,
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, 'run.json'), `${JSON.stringify(options.run)}\n`);
  if (options.rawResults !== undefined) {
    await writeFile(join(directory, 'results.jsonl'), options.rawResults);
  } else if (options.results !== undefined) {
    const body = options.results.map(value => JSON.stringify(value)).join('\n');
    await writeFile(
      join(directory, 'results.jsonl'),
      `${body}${options.resultsEndWithNewline === false || body === '' ? '' : '\n'}`,
    );
  }
  if (options.checkpoint !== undefined) {
    await writeFile(
      join(directory, 'checkpoint.json'),
      `${JSON.stringify(options.checkpoint)}\n`,
    );
  }
  if (options.summary !== undefined) {
    await writeFile(join(directory, 'summary.json'), `${JSON.stringify(options.summary)}\n`);
  }
  return directory;
}

function runMetadata(
  runId: string,
  status: 'running' | 'completed' | 'completed_with_errors',
  selectedTasks: number,
): Record<string, unknown> {
  return {
    runId,
    status,
    startedAt: '2026-08-24T00:00:00.000Z',
    selectedTasks,
  };
}

function checkpoint(
  status: 'running' | 'completed' | 'completed_with_errors',
  completedTasks: number,
  selectedTasks: number,
  errors: number,
): Record<string, unknown> {
  return { status, completedTasks, selectedTasks, lastTaskId: null, errors };
}

function result(
  taskId: string,
  status: 'ok' | 'infrastructure_error',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { taskId, status, ...extra };
}

function overview(runId: string): RunOverviewV1 {
  return {
    runId,
    directoryName: runId,
    status: 'running',
    startedAt: Date.parse('2026-08-24T00:00:00.000Z'),
    selectedTasks: 0,
    observedTasks: 0,
    completedTasks: 0,
    okTasks: 0,
    retryableErrors: 0,
    terminalErrors: 0,
    ignoredPartialTail: false,
    tasks: [],
  };
}

function pickCounts(run: RunOverviewV1) {
  return {
    observed: run.observedTasks,
    completed: run.completedTasks,
    ok: run.okTasks,
    retryable: run.retryableErrors,
    terminal: run.terminalErrors,
  };
}
