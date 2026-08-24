import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  PactAdapterV1,
  PactBoundaryPlanV1,
  PactDecisionV1,
  PactFinalizeReportV1,
  PactObservationV1,
  PactRunInitV1,
  PactTaskIntroV1,
} from '../../../src/protocol/v1/index.js';
import { pactRunConfigV1Schema } from '../../../src/runner/v1/config.js';
import { pactRunMetadataV1Schema } from '../../../src/runner/v1/artifacts.js';
import {
  LocalBackendV1,
  type ExecutionBackendV1,
} from '../../../src/runner/v1/backends/index.js';
import type { PactPairSingleTaskRunV1 } from '../../../src/suites/pact-pair/environment.js';
import { runPactPairBenchmarkV1 } from '../../../src/suites/pact-pair/runner.js';
import { selectPactPairResumeTasksV1 } from '../../../src/suites/pact-pair/resume.js';

test('partitions resume tasks into completed, retry, and missing', () => {
  const selection = selectPactPairResumeTasksV1(
    ['PAIR-Q1', 'PAIR-Q2', 'PAIR-Q3', 'PAIR-Q4'],
    [
      { taskId: 'PAIR-Q1', status: 'ok' },
      {
        taskId: 'PAIR-Q2',
        status: 'infrastructure_error',
        error: 'provider request failed: ECONNRESET',
        violations: ['runner_error'],
        toolCalls: [],
      },
      // A stale error line beside a later ok line: the ok result wins, the
      // task counts as completed and is never re-run.
      {
        taskId: 'PAIR-Q3',
        status: 'infrastructure_error',
        error: 'provider request failed: ECONNRESET',
        violations: ['runner_error'],
        toolCalls: [],
      },
      { taskId: 'PAIR-Q3', status: 'ok' },
    ],
  );
  assert.deepEqual(selection, {
    completedTaskIds: ['PAIR-Q1', 'PAIR-Q3'],
    retryTaskIds: ['PAIR-Q2'],
    missingTaskIds: ['PAIR-Q4'],
  });
});

test('rejects prior results for tasks outside the current selection', () => {
  assert.throws(
    () => selectPactPairResumeTasksV1(
      ['PAIR-Q1'],
      [{ taskId: 'PAIR-Q99', status: 'ok' }],
    ),
    /PAIR-Q99.*not part of the current task selection/s,
  );
});

test('a retried host checkpoint converges every task artifact exactly once', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-partial-checkpoint-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const runId = 'partial-checkpoint-retry';
  const evaluationPath = join(
    workingDirectory,
    'runs',
    runId,
    'private',
    'evaluation.jsonl',
  );
  let modelActions = 0;
  let checkpointAttempts = 0;
  const local = new LocalBackendV1();
  const retryingBackend: ExecutionBackendV1 = {
    kind: 'local',
    run: context => local.run({
      ...context,
      onTaskRun: async taskRun => {
        if (checkpointAttempts === 0) {
          // Fault injection after results.jsonl is appendable but before the
          // private evaluation can be published. This is the real host
          // callback used by the runner, and the backend retries the same
          // already-executed task run just as Harbor does.
          rmSync(evaluationPath);
          mkdirSync(evaluationPath);
          try {
            checkpointAttempts += 1;
            await context.onTaskRun?.(taskRun);
          } catch {
            // A transient storage repair makes the callback retry possible.
          } finally {
            rmSync(evaluationPath, { recursive: true });
            writeFileSync(evaluationPath, '', 'utf8');
          }
        }
        checkpointAttempts += 1;
        await context.onTaskRun?.(taskRun);
      },
    }),
  };

  const result = await runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => new ScriptedAdapter(() => {
      modelActions += 1;
      return {
        type: 'answer',
        content: 'Project Alpha launches on March 15, 2026.',
      };
    }),
    executionBackend: retryingBackend,
    runId,
    workingDirectory,
  });
  assert.ok(result.outputDirectory);

  const resultRows = readLines(join(result.outputDirectory, 'results.jsonl'));
  const evaluationRows = readLines(evaluationPath);
  const traceRows = readLines(join(
    result.outputDirectory,
    'private',
    'trace.jsonl',
  )).filter(line => (JSON.parse(line) as { event?: string }).event === 'task_completed');
  const checkpoint = JSON.parse(readFileSync(
    join(result.outputDirectory, 'checkpoint.json'),
    'utf8',
  )) as { completedTasks: number };
  assert.deepEqual({
    modelActions,
    checkpointAttempts,
    resultRows: resultRows.length,
    evaluationRows: evaluationRows.length,
    completedTraceRows: traceRows.length,
    inMemoryTasks: result.tasks.length,
    summaryTotal: result.summary.total,
    summaryErrors: result.summary.errors,
    checkpointCompletedTasks: checkpoint.completedTasks,
    runnerExitCode: result.summary.errors > 0 ? 1 : 0,
  }, {
    modelActions: 1,
    checkpointAttempts: 2,
    resultRows: 1,
    evaluationRows: 1,
    completedTraceRows: 1,
    inMemoryTasks: 1,
    summaryTotal: 1,
    summaryErrors: 0,
    checkpointCompletedTasks: 1,
    runnerExitCode: 0,
  });
});

test('out-of-order backend completions publish artifacts in task selection order', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-canonical-order-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const local = new LocalBackendV1();
  const reversedCompletionBackend: ExecutionBackendV1 = {
    kind: 'local',
    async run(context) {
      const completed: PactPairSingleTaskRunV1[] = [];
      const execution = await local.run({
        ...context,
        onTaskRun: async taskRun => {
          completed.push(taskRun);
        },
      });
      for (const taskRun of completed.reverse()) {
        await context.onTaskRun?.(taskRun);
      }
      return execution;
    },
  };
  const expectedOrder = ['PAIR-Q1', 'PAIR-Q101', 'PAIR-Q201'];

  const result = await runPactPairBenchmarkV1(
    configFor(['Q1', 'Q101', 'Q201']),
    {
      adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
      executionBackend: reversedCompletionBackend,
      runId: 'canonical-order',
      workingDirectory,
    },
  );
  assert.ok(result.outputDirectory);
  const artifactTaskIds = (path: string) => readLines(path).map(line =>
    (JSON.parse(line) as { taskId: string }).taskId);

  assert.deepEqual(
    artifactTaskIds(join(result.outputDirectory, 'results.jsonl')),
    expectedOrder,
  );
  assert.deepEqual(
    artifactTaskIds(join(result.outputDirectory, 'private', 'evaluation.jsonl')),
    expectedOrder,
  );
  assert.deepEqual(
    [...new Set(artifactTaskIds(
      join(result.outputDirectory, 'private', 'trace.jsonl'),
    ))],
    expectedOrder,
  );
});

test('resume canonicalizes a crash after the final out-of-order task commit', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-order-recovery-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const runId = 'canonical-order-recovery';
  const runDirectory = join(workingDirectory, 'runs', runId);
  const local = new LocalBackendV1();
  const crashingBackend: ExecutionBackendV1 = {
    kind: 'local',
    async run(context) {
      const completed: PactPairSingleTaskRunV1[] = [];
      await local.run({
        ...context,
        onTaskRun: async taskRun => {
          completed.push(taskRun);
        },
      });
      for (const taskRun of completed.reverse()) {
        await context.onTaskRun?.(taskRun);
      }
      throw new Error('simulated crash before canonical finalization');
    },
  };
  const config = configFor(['Q1', 'Q101', 'Q201']);
  const adapterFactory = ({ publicTask }: {
    publicTask: { taskId: string };
  }) => answerAdapter(publicTask.taskId);

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory,
      executionBackend: crashingBackend,
      runId,
      workingDirectory,
    }),
    /simulated crash before canonical finalization/,
  );
  assert.deepEqual(
    readLines(join(runDirectory, 'results.jsonl')).map(line =>
      (JSON.parse(line) as { taskId: string }).taskId),
    ['PAIR-Q201', 'PAIR-Q101', 'PAIR-Q1'],
  );

  let recoveredModelActions = 0;
  const recovered = await runPactPairBenchmarkV1(config, {
    adapterFactory: context => {
      recoveredModelActions += 1;
      return adapterFactory(context);
    },
    resume: runDirectory,
    workingDirectory,
  });
  const expectedOrder = ['PAIR-Q1', 'PAIR-Q101', 'PAIR-Q201'];
  const artifactTaskIds = (path: string) => readLines(path).map(line =>
    (JSON.parse(line) as { taskId: string }).taskId);
  assert.equal(recoveredModelActions, 0);
  assert.deepEqual(recovered.tasks.map(task => task.taskId), expectedOrder);
  assert.deepEqual(artifactTaskIds(join(runDirectory, 'results.jsonl')), expectedOrder);
  assert.deepEqual(
    artifactTaskIds(join(runDirectory, 'private', 'evaluation.jsonl')),
    expectedOrder,
  );
  assert.deepEqual(
    [...new Set(artifactTaskIds(join(runDirectory, 'private', 'trace.jsonl')))],
    expectedOrder,
  );
  const checkpoint = JSON.parse(
    readFileSync(join(runDirectory, 'checkpoint.json'), 'utf8'),
  ) as { status: string; completedTasks: number; lastTaskId: string };
  assert.deepEqual({
    status: checkpoint.status,
    completedTasks: checkpoint.completedTasks,
    lastTaskId: checkpoint.lastTaskId,
  }, {
    status: 'completed',
    completedTasks: 3,
    lastTaskId: 'PAIR-Q201',
  });
});

test('resume retries only failures proven transient and safe to repeat', async () => {
  const config = configFor(['Q1']);
  const runFailure = async (
    runId: string,
    adapter: () => PactAdapterV1,
  ) => {
    const result = await runPactPairBenchmarkV1(config, {
      adapterFactory: adapter,
      runId,
      writeOutputs: false,
    });
    const task = result.tasks[0];
    assert.ok(task);
    assert.equal(task.status, 'infrastructure_error');
    return task;
  };

  const noDecision = await runFailure(
    'taxonomy-no-decision',
    () => new ThrowingAdapter('OpenAI-compatible provider returned no decision'),
  );
  const invalidArguments = await runFailure(
    'taxonomy-invalid-arguments',
    () => new ThrowingAdapter(
      'OpenAI-compatible provider returned invalid tool arguments',
    ),
  );
  const protocolFailure = await runFailure(
    'taxonomy-protocol',
    () => new ScriptedAdapter(() => ({
      type: 'tool_call',
      toolName: 'drop_database',
      input: {},
    })),
  );
  const transientProvider = await runFailure(
    'taxonomy-transient-provider',
    () => new ThrowingAdapter('provider request failed: ECONNRESET'),
  );

  assert.deepEqual(
    selectPactPairResumeTasksV1(
      ['PAIR-Q1'],
      [noDecision],
    ),
    {
      completedTaskIds: ['PAIR-Q1'],
      retryTaskIds: [],
      missingTaskIds: [],
    },
  );
  assert.deepEqual(
    selectPactPairResumeTasksV1(['PAIR-Q1'], [invalidArguments]),
    {
      completedTaskIds: ['PAIR-Q1'],
      retryTaskIds: [],
      missingTaskIds: [],
    },
  );
  assert.deepEqual(
    selectPactPairResumeTasksV1(['PAIR-Q1'], [protocolFailure]),
    {
      completedTaskIds: ['PAIR-Q1'],
      retryTaskIds: [],
      missingTaskIds: [],
    },
  );
  assert.deepEqual(
    selectPactPairResumeTasksV1(['PAIR-Q1'], [transientProvider]),
    {
      completedTaskIds: [],
      retryTaskIds: ['PAIR-Q1'],
      missingTaskIds: [],
    },
  );
});

test('resume re-runs only missing and proven transient tasks', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-e2e-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1', 'Q2', 'Q101']);

  // First attempt: PAIR-Q1 and PAIR-Q2 complete, PAIR-Q101 hits an
  // transient provider error before any tool action.
  const first = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => publicTask.taskId === 'PAIR-Q101'
      ? new ThrowingAdapter('provider request failed: ECONNRESET')
      : answerAdapter(publicTask.taskId),
    runId: 'resume-e2e',
    workingDirectory,
  });
  assert.ok(first.outputDirectory);
  assert.equal(first.summary.errors, 1);
  const runDirectory = first.outputDirectory;
  const firstResultLines = readLines(join(runDirectory, 'results.jsonl'));
  const firstQ1Line = firstResultLines.find(line =>
    (JSON.parse(line) as { taskId: string }).taskId === 'PAIR-Q1');
  assert.ok(firstQ1Line);

  // Simulate a crash before PAIR-Q2's checkpoint landed: drop its lines from
  // every artifact, leaving it "missing" rather than errored.
  for (const artifact of [
    join(runDirectory, 'results.jsonl'),
    join(runDirectory, 'private', 'evaluation.jsonl'),
    join(runDirectory, 'private', 'trace.jsonl'),
  ]) {
    const kept = readLines(artifact).filter(line =>
      (JSON.parse(line) as { taskId?: string }).taskId !== 'PAIR-Q2');
    writeFileSync(artifact, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
  }
  // This fixture models a historical pre-journal run whose Q2 publication
  // was lost entirely; a current journal would recover Q2 instead of rerunning.
  rmSync(join(runDirectory, 'private', 'task-commits'), {
    recursive: true,
    force: true,
  });

  const resumedTaskIds: string[] = [];
  const resumed = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => {
      resumedTaskIds.push(publicTask.taskId);
      return answerAdapter(publicTask.taskId);
    },
    workingDirectory,
    resume: runDirectory,
  });

  // Only the missing and errored tasks ran; the completed trial is retained
  // verbatim (same run id, same recorded result line — no overwrite).
  assert.deepEqual(resumedTaskIds, ['PAIR-Q2', 'PAIR-Q101']);
  assert.equal(resumed.runId, 'resume-e2e');
  assert.equal(resumed.startedAt, first.startedAt);
  assert.equal(resumed.summary.total, 3);
  assert.equal(resumed.summary.errors, 0);
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(
    resumed.tasks.map(task => task.taskId),
    ['PAIR-Q1', 'PAIR-Q2', 'PAIR-Q101'],
  );
  assert.equal(resumed.resumed, true);
  assert.deepEqual(
    resumed.resumes?.map(record => record.taskIds),
    [['PAIR-Q2', 'PAIR-Q101']],
  );

  const resultLines = readLines(join(runDirectory, 'results.jsonl'));
  const resultsById = resultLines.map(line =>
    JSON.parse(line) as { taskId: string; status: string });
  assert.deepEqual(
    resultsById.map(result => result.taskId).sort(),
    ['PAIR-Q1', 'PAIR-Q101', 'PAIR-Q2'],
  );
  assert.equal(resultsById.every(result => result.status === 'ok'), true);
  // The retained trial's checkpoint line is byte-identical to the original.
  assert.equal(resultLines.find(line =>
    (JSON.parse(line) as { taskId: string }).taskId === 'PAIR-Q1'), firstQ1Line);

  const runMetadata = pactRunMetadataV1Schema.parse(
    JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')),
  );
  assert.equal(runMetadata.resumed, true);
  assert.deepEqual(
    runMetadata.resumes?.map(record => record.taskIds),
    [['PAIR-Q2', 'PAIR-Q101']],
  );
  assert.equal(runMetadata.status, 'completed');

  // The resumed summary matches a clean end-to-end run of the same trio.
  const clean = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
    runId: 'resume-clean-reference',
    writeOutputs: false,
  });
  const normalize = (summary: typeof clean.summary) =>
    JSON.parse(JSON.stringify(summary)) as unknown;
  assert.deepEqual(normalize(resumed.summary), normalize(clean.summary));
});

test('resuming a fully completed run re-runs nothing and keeps results intact', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-noop-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1', 'Q101']);

  const first = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
    runId: 'resume-noop',
    workingDirectory,
  });
  assert.ok(first.outputDirectory);
  assert.equal(first.summary.errors, 0);
  const before = readFileSync(join(first.outputDirectory, 'results.jsonl'), 'utf8');

  const resumed = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => {
      throw new Error('completed trials must never be re-run');
    },
    workingDirectory,
    resume: first.outputDirectory,
  });

  assert.equal(resumed.summary.total, 2);
  assert.equal(resumed.summary.errors, 0);
  assert.deepEqual(resumed.resumes?.map(record => record.taskIds), [[]]);
  // No task re-ran, so the checkpoint artifact is untouched.
  assert.equal(
    readFileSync(join(String(first.outputDirectory), 'results.jsonl'), 'utf8'),
    before,
  );
});

test('resume promotes a prepared task commit and recovers missing artifacts', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-recovery-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1']);
  const initial = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    runId: 'resume-prepared-recovery',
    workingDirectory,
  });
  assert.ok(initial.outputDirectory);
  const commitDirectory = join(initial.outputDirectory, 'private', 'task-commits');
  const committedName = readdirSync(commitDirectory).find(name =>
    name.endsWith('.commit.json'));
  assert.ok(committedName);
  renameSync(
    join(commitDirectory, committedName),
    join(commitDirectory, `${committedName.slice(0, -'.commit.json'.length)}.crash.prepared.json`),
  );
  for (const artifact of [
    join(initial.outputDirectory, 'results.jsonl'),
    join(initial.outputDirectory, 'private', 'evaluation.jsonl'),
    join(initial.outputDirectory, 'private', 'trace.jsonl'),
  ]) writeFileSync(artifact, '', 'utf8');

  let modelActions = 0;
  const recovered = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => new ScriptedAdapter(() => {
      modelActions += 1;
      throw new Error('a committed task must not execute again');
    }),
    workingDirectory,
    resume: initial.outputDirectory,
  });

  assert.equal(modelActions, 0);
  assert.equal(recovered.summary.total, 1);
  assert.equal(recovered.tasks.length, 1);
  assert.equal(readLines(join(initial.outputDirectory, 'results.jsonl')).length, 1);
  assert.equal(readLines(
    join(initial.outputDirectory, 'private', 'evaluation.jsonl'),
  ).length, 1);
  assert.deepEqual(
    readdirSync(commitDirectory).map(name => name.endsWith('.commit.json')),
    [true],
  );
});

test('resume rejects conflicting committed outcomes for one task', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-conflict-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1']);
  const initial = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    runId: 'resume-commit-conflict',
    workingDirectory,
  });
  assert.ok(initial.outputDirectory);
  const commitDirectory = join(initial.outputDirectory, 'private', 'task-commits');
  const committedName = readdirSync(commitDirectory).find(name =>
    name.endsWith('.commit.json'));
  assert.ok(committedName);
  const commit = JSON.parse(
    readFileSync(join(commitDirectory, committedName), 'utf8'),
  ) as { result: { budgetUsed: { runtimeMs: number } } };
  commit.result.budgetUsed.runtimeMs += 1;
  writeFileSync(
    join(commitDirectory, `${committedName.slice(0, 12)}.conflict.prepared.json`),
    `${JSON.stringify(commit)}\n`,
    'utf8',
  );

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      workingDirectory,
      resume: initial.outputDirectory,
    }),
    /Conflicting committed outcomes for task PAIR-Q1/,
  );
});

test('a second resume writer fails before spend or artifact mutation', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-lock-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1']);
  const initial = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    runId: 'resume-writer-lock',
    workingDirectory,
  });
  assert.ok(initial.outputDirectory);

  // Leave one selected task missing so the first resume enters its backend
  // while retaining the original provenance and artifact layout.
  for (const artifact of [
    join(initial.outputDirectory, 'results.jsonl'),
    join(initial.outputDirectory, 'private', 'evaluation.jsonl'),
    join(initial.outputDirectory, 'private', 'trace.jsonl'),
  ]) {
    writeFileSync(artifact, '', 'utf8');
  }
  rmSync(join(initial.outputDirectory, 'private', 'task-commits'), {
    recursive: true,
    force: true,
  });

  let backendCalls = 0;
  let modelActions = 0;
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const firstCanContinue = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise<void>(resolve => { markEntered = resolve; });
  const local = new LocalBackendV1();
  const blockingBackend: ExecutionBackendV1 = {
    kind: 'local',
    async run(context) {
      backendCalls += 1;
      if (backendCalls === 1) {
        markEntered();
        await firstCanContinue;
      }
      return local.run(context);
    },
  };
  const runOptions = {
    adapterFactory: () => new ScriptedAdapter(() => {
      modelActions += 1;
      return {
        type: 'answer' as const,
        content: 'Project Alpha launches on March 15, 2026.',
      };
    }),
    executionBackend: blockingBackend,
    workingDirectory,
    resume: initial.outputDirectory,
  };

  const firstResume = runPactPairBenchmarkV1(config, runOptions);
  await firstEntered;
  const metadataBeforeSecond = readFileSync(
    join(initial.outputDirectory, 'run.json'),
    'utf8',
  );
  let secondError: unknown;
  let metadataAfterSecond = '';
  try {
    await runPactPairBenchmarkV1(config, runOptions);
  } catch (error) {
    secondError = error;
  } finally {
    metadataAfterSecond = readFileSync(
      join(initial.outputDirectory, 'run.json'),
      'utf8',
    );
    releaseFirst();
  }
  await firstResume;

  assert.deepEqual({
    secondRejected: secondError instanceof Error,
    lockDiagnostic: secondError instanceof Error
      && /active writer|writer lock/i.test(secondError.message),
    backendCalls,
    modelActions,
    secondMutatedMetadata: metadataAfterSecond !== metadataBeforeSecond,
  }, {
    secondRejected: true,
    lockDiagnostic: true,
    backendCalls: 1,
    modelActions: 1,
    secondMutatedMetadata: false,
  });
});

test('resume fails closed on config drift, missing traces, and runId overrides', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-guard-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1', 'Q101']);
  const first = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => publicTask.taskId === 'PAIR-Q101'
      ? new ThrowingAdapter('synthetic backend outage')
      : answerAdapter(publicTask.taskId),
    runId: 'resume-guards',
    workingDirectory,
  });
  assert.ok(first.outputDirectory);

  // A different configuration must never mix results into this run directory.
  const driftedConfig = pactRunConfigV1Schema.parse({
    ...config,
    budget: { maxTurns: 6, maxToolCalls: 3, maxRuntimeMs: 10_000 },
  });
  await assert.rejects(
    runPactPairBenchmarkV1(driftedConfig, {
      adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
      workingDirectory,
      resume: first.outputDirectory,
    }),
    /configDigest mismatch/,
  );

  // resume keeps the original run identity.
  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
      workingDirectory,
      runId: 'a-new-run-id',
      resume: first.outputDirectory,
    }),
    /resume keeps the original run id/,
  );

  // Without private evaluation retention the run summary cannot be rebuilt.
  const untracedConfig = configFor(['Q1', 'Q101'], false);
  const untraced = await runPactPairBenchmarkV1(untracedConfig, {
    adapterFactory: ({ publicTask }) => publicTask.taskId === 'PAIR-Q101'
      ? new ThrowingAdapter('synthetic backend outage')
      : answerAdapter(publicTask.taskId),
    runId: 'resume-untraced',
    workingDirectory,
  });
  assert.ok(untraced.outputDirectory);
  await assert.rejects(
    runPactPairBenchmarkV1(untracedConfig, {
      adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
      workingDirectory,
      resume: untraced.outputDirectory,
    }),
    /output\.saveTraces: true/,
  );
});

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim().length > 0);
}

function answerAdapter(taskId: string): PactAdapterV1 {
  return new ScriptedAdapter(() => taskId === 'PAIR-Q1'
    ? { type: 'answer', content: 'Project Alpha launches on March 15, 2026.' }
    : { type: 'refuse', reason: 'That information is private.' });
}

class ScriptedAdapter implements PactAdapterV1 {
  constructor(
    private readonly decide: (observation: PactObservationV1) => PactDecisionV1,
  ) {}

  async initialize(_init: PactRunInitV1): Promise<void> {}

  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return {
      access: {
        notes: { read: { scope: 'all' }, write: false },
        todos: { read: true, write: false },
        memory: { read: 'none', write: false },
      },
    };
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    return this.decide(observation);
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'completed' };
  }
}

class ThrowingAdapter implements PactAdapterV1 {
  constructor(private readonly message: string) {}

  async initialize(): Promise<void> {
    throw new Error(this.message);
  }

  async planBoundary(): Promise<PactBoundaryPlanV1> {
    throw new Error('unreachable');
  }

  async step(): Promise<PactDecisionV1> {
    throw new Error('unreachable');
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'failed' };
  }
}

function configFor(ids: string[], saveTraces = true) {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'test-model',
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
    output: { directory: 'runs', saveTraces },
  });
}
