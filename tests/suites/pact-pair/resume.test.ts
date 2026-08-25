import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
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
  type PactRunExecutionMetadataV1,
} from '../../../src/runner/v1/backends/index.js';
import type { PactPairSingleTaskRunV1 } from '../../../src/suites/pact-pair/environment.js';
import { runPactPairBenchmarkV1 } from '../../../src/suites/pact-pair/runner.js';
import {
  retryablePactPairFailureV1,
  selectPactPairResumeTasksV1,
} from '../../../src/suites/pact-pair/resume.js';

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
      // Byte-identical historical duplicates compact to one outcome.
      { taskId: 'PAIR-Q3', status: 'ok' },
      { taskId: 'PAIR-Q3', status: 'ok' },
    ],
  );
  assert.deepEqual(selection, {
    completedTaskIds: ['PAIR-Q1', 'PAIR-Q3'],
    retryTaskIds: ['PAIR-Q2'],
    missingTaskIds: ['PAIR-Q4'],
  });
});

test('resume selection rejects distinct duplicate outcomes for one task', () => {
  assert.throws(
    () => selectPactPairResumeTasksV1(
      ['PAIR-Q1'],
      [
        {
          taskId: 'PAIR-Q1',
          status: 'infrastructure_error',
          error: 'provider request failed: ECONNRESET',
          violations: ['runner_error'],
          toolCalls: [],
        },
        { taskId: 'PAIR-Q1', status: 'ok' },
      ],
    ),
    /conflicting.*PAIR-Q1|PAIR-Q1.*conflicting/i,
  );
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

test('a committed task rejects a different retry before artifact replacement', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-authority-retry-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const runId = 'immutable-task-authority';
  const runDirectory = join(workingDirectory, 'runs', runId);
  const checkpointPath = join(runDirectory, 'checkpoint.json');
  const local = new LocalBackendV1();
  let modelActions = 0;
  let originalRuntimeMs = -1;
  const conflictingRetryBackend: ExecutionBackendV1 = {
    kind: 'local',
    async run(context) {
      let completed: PactPairSingleTaskRunV1 | undefined;
      await local.run({
        ...context,
        onTaskRun: async taskRun => {
          completed = taskRun;
        },
      });
      assert.ok(completed);
      originalRuntimeMs = completed.result.budgetUsed.runtimeMs;

      // The private commit and all task artifacts publish before the final
      // checkpoint rename. Making the destination a directory injects the
      // real post-commit failure without replacing filesystem APIs.
      mkdirSync(checkpointPath);
      assert.ok(context.onTaskRun);
      await assert.rejects(
        context.onTaskRun(completed),
        /directory|EISDIR|ENOTEMPTY|EEXIST/i,
      );
      rmSync(checkpointPath, { recursive: true });

      const different = structuredClone(completed);
      different.result.budgetUsed.runtimeMs += 1;
      const completion = different.trace.find(event => event.event === 'task_completed');
      assert.ok(completion);
      const completionData = completion.data as Record<string, unknown>;
      completionData.budgetUsed = different.result.budgetUsed;
      await context.onTaskRun(different);
      throw new Error('different payload was accepted for one committed task');
    },
  };

  await assert.rejects(
    runPactPairBenchmarkV1(configFor(['Q1']), {
      adapterFactory: () => new ScriptedAdapter(() => {
        modelActions += 1;
        return {
          type: 'answer',
          content: 'Project Alpha launches on March 15, 2026.',
        };
      }),
      executionBackend: conflictingRetryBackend,
      runId,
      workingDirectory,
    }),
    /Conflicting (?:committed|completed) outcomes.*PAIR-Q1|PAIR-Q1.*Conflicting (?:committed|completed) outcomes/i,
  );

  assert.equal(modelActions, 1);
  assert.equal(
    (JSON.parse(readLines(join(runDirectory, 'results.jsonl'))[0] ?? '{}') as {
      budgetUsed?: { runtimeMs?: number };
    }).budgetUsed?.runtimeMs,
    originalRuntimeMs,
  );
  const commitDirectory = join(runDirectory, 'private', 'task-commits');
  assert.equal(countJournalCommitFiles(commitDirectory), 1);
  const journalNames = readdirSync(commitDirectory);
  const contentName = journalNames.find(name => name.endsWith('.commit.json'));
  const authorityName = journalNames.find(name => name.endsWith('.authority.json'));
  assert.ok(contentName);
  assert.ok(authorityName);
  // The content-addressed compatibility name and stable authority are two
  // directory entries for one immutable inode, never two commit payloads.
  assert.equal(
    statSync(join(commitDirectory, contentName)).ino,
    statSync(join(commitDirectory, authorityName)).ino,
  );

  const resumed = await runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => {
      throw new Error('committed task must not execute during recovery');
    },
    workingDirectory,
    resume: runDirectory,
  });
  assert.equal(modelActions, 1);
  assert.equal(resumed.tasks.length, 1);
  assert.equal(resumed.tasks[0]?.budgetUsed.runtimeMs, originalRuntimeMs);
  assert.equal(readLines(join(runDirectory, 'results.jsonl')).length, 1);
  assert.equal(readLines(join(runDirectory, 'private', 'evaluation.jsonl')).length, 1);
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

test('retry taxonomy is conservative across action, budget, protocol, and HTTP failures', () => {
  const infrastructureFailure = (
    error: string,
    overrides: Partial<{
      finalizeError: string;
      violations: string[];
      toolCalls: Array<{ id: string; name: string; isError: boolean }>;
    }> = {},
  ) => ({
    taskId: 'PAIR-Q1',
    status: 'infrastructure_error' as const,
    error,
    violations: [],
    toolCalls: [],
    ...overrides,
  });
  const cases: Array<{
    name: string;
    result: ReturnType<typeof infrastructureFailure>;
    retryable: boolean;
  }> = [
    {
      name: 'finalize error after a transient request',
      result: infrastructureFailure('provider request failed: 503', {
        finalizeError: 'adapter close failed',
      }),
      retryable: false,
    },
    {
      name: 'prior tool or action',
      result: infrastructureFailure('provider request failed: 503', {
        toolCalls: [{ id: 'call-1', name: 'create_note', isError: false }],
      }),
      retryable: false,
    },
    {
      name: 'runtime budget',
      result: infrastructureFailure('provider request timed out', {
        violations: ['max_runtime_ms_exceeded'],
      }),
      retryable: false,
    },
    {
      name: 'turn budget',
      result: infrastructureFailure('provider request failed: 503', {
        violations: ['max_turns_exceeded'],
      }),
      retryable: false,
    },
    {
      name: 'tool-call budget',
      result: infrastructureFailure('provider request failed: 503', {
        violations: ['max_tool_calls_exceeded'],
      }),
      retryable: false,
    },
    {
      name: 'provider configuration',
      result: infrastructureFailure('provider request failed: 503', {
        violations: ['provider_configuration_error'],
      }),
      retryable: false,
    },
    {
      name: 'adapter protocol',
      result: infrastructureFailure('provider request failed: 503', {
        violations: ['adapter_protocol_error'],
      }),
      retryable: false,
    },
    {
      name: 'side effect before failure',
      result: infrastructureFailure('provider request failed: 503', {
        violations: ['side_effect_before_failure'],
      }),
      retryable: false,
    },
    {
      name: 'unknown infrastructure failure',
      result: infrastructureFailure('unclassified provider failure'),
      retryable: false,
    },
    ...['429', '502', '503', '504'].map(status => ({
      name: `HTTP ${status}`,
      result: infrastructureFailure(`provider request failed: ${status}`),
      retryable: true,
    })),
  ];

  for (const entry of cases) {
    assert.equal(
      retryablePactPairFailureV1(entry.result),
      entry.retryable,
      entry.name,
    );
  }
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

test('no-op Harbor resume preserves exact execution, policy, and source provenance', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-provenance-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configForBackend(['Q1'], 'harbor');
  const execution: PactRunExecutionMetadataV1 = {
    backend: 'harbor',
    executor: 'scripted-harness',
    harbor: {
      version: '0.5.0',
      image: 'pact-bench-harbor:p0',
      imageId: `sha256:${'1'.repeat(64)}`,
    },
  };
  const backend = backendWithExecution(execution);
  const first = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    executionBackend: backend,
    runId: 'resume-provenance-noop',
    workingDirectory,
  });
  assert.ok(first.outputDirectory);
  const firstMetadata = JSON.parse(readFileSync(
    join(first.outputDirectory, 'run.json'),
    'utf8',
  )) as Record<string, unknown>;

  const resumed = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => {
      throw new Error('a completed task must not execute');
    },
    executionBackend: backend,
    workingDirectory,
    resume: first.outputDirectory,
  });
  const resumedMetadata = JSON.parse(readFileSync(
    join(first.outputDirectory, 'run.json'),
    'utf8',
  )) as Record<string, unknown>;
  const withProjection = resumed as typeof resumed & {
    executionProjection?: string;
    executionAttempts?: unknown;
  };

  assert.deepEqual(resumed.execution, execution);
  assert.deepEqual(resumed.policyProvenance, first.policyProvenance);
  assert.equal(resumed.sourceRevision, first.sourceRevision);
  assert.equal(withProjection.executionProjection, 'all-outcomes');
  assert.deepEqual(withProjection.executionAttempts, [{
    taskIds: ['PAIR-Q1'],
    execution,
  }]);
  assert.deepEqual(resumedMetadata.execution, firstMetadata.execution);
  assert.deepEqual(
    resumedMetadata.executionAttempts,
    withProjection.executionAttempts,
  );
  assert.deepEqual(
    resumedMetadata.policyProvenance,
    firstMetadata.policyProvenance,
  );
  assert.equal(resumedMetadata.sourceRevision, firstMetadata.sourceRevision);
});

test('repeated resume preserves pre-return execution identity across torn finalization', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-execution-authority-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configForBackend(['Q1'], 'harbor');
  const execution: PactRunExecutionMetadataV1 = {
    backend: 'harbor',
    executor: 'scripted-harness',
    harbor: {
      version: '0.5.0',
      image: 'pact-bench-harbor:authority',
      imageId: `sha256:${'4'.repeat(64)}`,
    },
  };
  const local = new LocalBackendV1();
  let modelActions = 0;
  let backendCalls = 0;
  const crashAfterCommitBackend: ExecutionBackendV1 = {
    kind: 'harbor',
    async run(context) {
      backendCalls += 1;
      const notifyExecution = (context as typeof context & {
        onExecution?: (value: PactRunExecutionMetadataV1) => Promise<void>;
      }).onExecution;
      if (notifyExecution) await notifyExecution(execution);
      await local.run(context);
      throw new Error('synthetic failure before backend execution metadata return');
    },
  };
  const runId = 'execution-authority-crash';
  const runDirectory = join(workingDirectory, 'runs', runId);

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => new ScriptedAdapter(() => {
        modelActions += 1;
        return {
          type: 'answer',
          content: 'Project Alpha launches on March 15, 2026.',
        };
      }),
      executionBackend: crashAfterCommitBackend,
      runId,
      workingDirectory,
    }),
    /synthetic failure before backend execution metadata return/,
  );
  assert.equal(modelActions, 1);
  assert.equal(readLines(join(runDirectory, 'results.jsonl')).length, 1);

  // The first resume rewrites running run.json before finalization. Force the
  // later summary publication to fail so a second process must recover from
  // that observable intermediate metadata state.
  const summaryPath = join(runDirectory, 'summary.json');
  mkdirSync(summaryPath);
  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => {
        throw new Error('durably committed task must not execute on resume');
      },
      executionBackend: crashAfterCommitBackend,
      workingDirectory,
      resume: runDirectory,
    }),
    /directory|EISDIR|ENOTEMPTY|EEXIST/i,
  );
  assert.equal(modelActions, 1);
  assert.equal(backendCalls, 1);

  rmSync(summaryPath, { recursive: true });
  const resumed = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => {
      throw new Error('durably committed task must not execute on resume');
    },
    executionBackend: crashAfterCommitBackend,
    workingDirectory,
    resume: runDirectory,
  });

  assert.equal(modelActions, 1);
  assert.equal(backendCalls, 1);
  assert.deepEqual(resumed.execution, execution);
  assert.deepEqual(resumed.executionAttempts, [{
    taskIds: ['PAIR-Q1'],
    execution,
  }]);
  const metadata = pactRunMetadataV1Schema.parse(JSON.parse(readFileSync(
    join(runDirectory, 'run.json'),
    'utf8',
  )));
  assert.deepEqual(metadata.execution, execution);
});

test('Harbor fails closed when a task arrives before exact execution identity', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-execution-missing-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configForBackend(['Q1'], 'harbor');
  const local = new LocalBackendV1();
  let modelActions = 0;
  const missingIdentityBackend: ExecutionBackendV1 = {
    kind: 'harbor',
    async run(context) {
      await local.run(context);
      return {
        execution: {
          backend: 'harbor',
          executor: 'scripted-harness',
          harbor: {
            version: '0.5.0',
            image: 'too-late',
            imageId: `sha256:${'5'.repeat(64)}`,
          },
        },
      };
    },
  };
  const runId = 'execution-authority-missing';
  const runDirectory = join(workingDirectory, 'runs', runId);

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => new ScriptedAdapter(() => {
        modelActions += 1;
        return {
          type: 'answer',
          content: 'Project Alpha launches on March 15, 2026.',
        };
      }),
      executionBackend: missingIdentityBackend,
      runId,
      workingDirectory,
    }),
    /exact harbor execution identity was not durably recorded/i,
  );
  assert.equal(modelActions, 1);
  assert.deepEqual(readLines(join(runDirectory, 'results.jsonl')), []);
  assert.equal(
    readdirSync(join(runDirectory, 'private'))
      .includes('task-commits'),
    false,
  );
});

test('mixed resume records authoritative execution identity per outcome', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-mixed-exec-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configForBackend(['Q1', 'Q2'], 'harbor');
  const firstExecution: PactRunExecutionMetadataV1 = {
    backend: 'harbor',
    executor: 'scripted-harness',
    harbor: {
      version: '0.5.0',
      image: 'pact-bench-harbor:p0',
      imageId: `sha256:${'2'.repeat(64)}`,
    },
  };
  const secondExecution: PactRunExecutionMetadataV1 = {
    backend: 'harbor',
    executor: 'custom-harness',
    harbor: {
      version: '0.5.0',
      image: 'pact-bench-harbor:p0',
      imageId: `sha256:${'3'.repeat(64)}`,
    },
  };
  const first = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
    executionBackend: backendWithExecution(firstExecution),
    runId: 'resume-mixed-execution',
    workingDirectory,
  });
  assert.ok(first.outputDirectory);
  for (const artifact of [
    join(first.outputDirectory, 'results.jsonl'),
    join(first.outputDirectory, 'private', 'evaluation.jsonl'),
    join(first.outputDirectory, 'private', 'trace.jsonl'),
  ]) {
    const kept = readLines(artifact).filter(line =>
      (JSON.parse(line) as { taskId?: string }).taskId !== 'PAIR-Q2');
    writeFileSync(artifact, `${kept.join('\n')}\n`, 'utf8');
  }
  // Model a historical run with one retained outcome and one missing task.
  rmSync(join(first.outputDirectory, 'private', 'task-commits'), {
    recursive: true,
    force: true,
  });

  const resumed = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => answerAdapter(publicTask.taskId),
    executionBackend: backendWithExecution(secondExecution),
    workingDirectory,
    resume: first.outputDirectory,
  });
  const withAttempts = resumed as typeof resumed & {
    executionProjection?: string;
    executionAttempts?: unknown;
  };
  assert.deepEqual(resumed.execution, secondExecution);
  assert.equal(withAttempts.executionProjection, 'latest-attempt');
  assert.deepEqual(withAttempts.executionAttempts, [
    { taskIds: ['PAIR-Q1'], execution: firstExecution },
    { taskIds: ['PAIR-Q2'], execution: secondExecution },
  ]);
  const metadata = JSON.parse(readFileSync(
    join(first.outputDirectory, 'run.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(metadata.executionProjection, 'latest-attempt');
  assert.deepEqual(metadata.executionAttempts, withAttempts.executionAttempts);
});

test('resume rejects policy or source provenance drift before model spend', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-source-guard-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1']);
  const createRun = async (runId: string) => {
    const run = await runPactPairBenchmarkV1(config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      runId,
      workingDirectory,
    });
    assert.ok(run.outputDirectory);
    return run.outputDirectory;
  };
  let modelActions = 0;

  const policyRun = await createRun('resume-policy-drift');
  const policyPath = join(policyRun, 'run.json');
  const policyMetadata = JSON.parse(readFileSync(policyPath, 'utf8')) as {
    policyProvenance: { sha256: string };
  };
  policyMetadata.policyProvenance.sha256 = 'a'.repeat(64);
  writeFileSync(policyPath, `${JSON.stringify(policyMetadata)}\n`, 'utf8');
  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => {
        modelActions += 1;
        return answerAdapter('PAIR-Q1');
      },
      workingDirectory,
      resume: policyRun,
    }),
    /policy provenance/i,
  );

  const sourceRun = await createRun('resume-source-drift');
  const sourcePath = join(sourceRun, 'run.json');
  const sourceMetadata = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
    sourceRevision?: string;
  };
  sourceMetadata.sourceRevision = 'a'.repeat(40);
  writeFileSync(sourcePath, `${JSON.stringify(sourceMetadata)}\n`, 'utf8');
  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => {
        modelActions += 1;
        return answerAdapter('PAIR-Q1');
      },
      workingDirectory,
      resume: sourceRun,
    }),
    /source provenance/i,
  );
  assert.equal(modelActions, 0);
});

test('resume gold-mismatch diagnostics name only the task and field', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-private-error-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q101']);

  for (const field of ['expectedBehavior', 'benchmarkExpectedBehavior'] as const) {
    const run = await runPactPairBenchmarkV1(config, {
      adapterFactory: () => answerAdapter('PAIR-Q101'),
      runId: `resume-private-${field}`,
      workingDirectory,
    });
    assert.ok(run.outputDirectory);
    rmSync(join(run.outputDirectory, 'private', 'task-commits'), {
      recursive: true,
      force: true,
    });
    const evaluationPath = join(
      run.outputDirectory,
      'private',
      'evaluation.jsonl',
    );
    const record = JSON.parse(readLines(evaluationPath)[0] ?? '{}') as {
      evaluation: {
        expectedBehavior: string;
        benchmarkExpectedBehavior?: string;
      };
    };
    record.evaluation[field] = 'answer';
    writeFileSync(evaluationPath, `${JSON.stringify(record)}\n`, 'utf8');

    let rejection: unknown;
    try {
      await runPactPairBenchmarkV1(config, {
        adapterFactory: () => new ThrowingAdapter('must not execute'),
        workingDirectory,
        resume: run.outputDirectory,
      });
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection instanceof Error);
    assert.match(rejection.message, /PAIR-Q101/);
    assert.match(rejection.message, new RegExp(field));
    assert.equal(rejection.message.includes('answer'), false);
    assert.equal(rejection.message.includes('refuse'), false);
  }
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
    {
      commits: readdirSync(commitDirectory)
        .filter(name => name.endsWith('.commit.json')).length,
      authorities: readdirSync(commitDirectory)
        .filter(name => name.endsWith('.authority.json')).length,
      prepared: readdirSync(commitDirectory)
        .filter(name => name.endsWith('.prepared.json')).length,
    },
    { commits: 1, authorities: 1, prepared: 0 },
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
  ) as { payload: JournalPayloadFixture };
  const conflictingPayload = structuredClone(commit.payload);
  conflictingPayload.result.budgetUsed.runtimeMs += 1;
  const conflictingDigest = fixtureDigest(conflictingPayload);
  writeFileSync(
    join(
      commitDirectory,
      `${fixtureStringDigest(conflictingPayload.binding.taskId)}.`
      + `${conflictingDigest}.conflict.prepared.json`,
    ),
    `${JSON.stringify({
      apiVersion: 'pact-task-commit/v1',
      payloadDigest: conflictingDigest,
      payload: conflictingPayload,
    })}\n`,
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

test('resume rejects a schema-valid journal edit whose payload digest is stale', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-digest-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const { config, runDirectory, commitPath } = await createJournalRun(
    workingDirectory,
    'journal-stale-digest',
  );
  const before = readFileSync(join(runDirectory, 'results.jsonl'), 'utf8');
  const commit = JSON.parse(readFileSync(commitPath, 'utf8')) as {
    payload?: { result: PactPairSingleTaskRunV1['result'] };
    result?: PactPairSingleTaskRunV1['result'];
  };
  const result = commit.payload?.result ?? commit.result;
  assert.ok(result);
  result.budgetUsed.runtimeMs = 999_999;
  const poisoned = `${JSON.stringify(commit)}\n`;
  writeFileSync(commitPath, poisoned, 'utf8');
  const authorityName = readdirSync(join(runDirectory, 'private', 'task-commits'))
    .find(name => name.endsWith('.authority.json'));
  assert.ok(authorityName);
  writeFileSync(
    join(runDirectory, 'private', 'task-commits', authorityName),
    poisoned,
    'utf8',
  );

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => {
        throw new Error('poisoned committed work must not execute');
      },
      workingDirectory,
      resume: runDirectory,
    }),
    /journal.*digest|payload digest/i,
  );
  assert.equal(readFileSync(join(runDirectory, 'results.jsonl'), 'utf8'), before);
});

test('resume rejects a journal whose content address was renamed', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-name-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const { config, runDirectory, commitPath } = await createJournalRun(
    workingDirectory,
    'journal-renamed-address',
  );
  const renamed = join(
    join(runDirectory, 'private', 'task-commits'),
    `${'0'.repeat(64)}.commit.json`,
  );
  renameSync(commitPath, renamed);

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      workingDirectory,
      resume: runDirectory,
    }),
    /journal.*filename|content address/i,
  );
});

test('resume rejects recomputed journals bound to another run or public task', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-binding-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));

  const foreignRun = await createJournalRun(workingDirectory, 'journal-foreign-run');
  replaceWithStateBoundEnvelope(foreignRun.commitPath, foreignRun.runDirectory, payload => {
    payload.binding.runId = 'another-run';
    for (const event of payload.trace) event.runId = 'another-run';
  });
  await assert.rejects(
    runPactPairBenchmarkV1(foreignRun.config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      workingDirectory,
      resume: foreignRun.runDirectory,
    }),
    /PAIR-Q1.*run identity|run identity.*PAIR-Q1/i,
  );

  const foreignTask = await createJournalRun(workingDirectory, 'journal-foreign-task');
  replaceWithStateBoundEnvelope(
    foreignTask.commitPath,
    foreignTask.runDirectory,
    payload => {
      payload.binding.publicTaskDigest = 'f'.repeat(64);
    },
  );
  await assert.rejects(
    runPactPairBenchmarkV1(foreignTask.config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      workingDirectory,
      resume: foreignTask.runDirectory,
    }),
    /PAIR-Q1.*public task identity|public task identity.*PAIR-Q1/i,
  );
});

test('resume rejects a recomputed journal result outside the recorded budget', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-budget-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const journal = await createJournalRun(workingDirectory, 'journal-budget-poison');
  replaceWithStateBoundEnvelope(journal.commitPath, journal.runDirectory, payload => {
    payload.result.budgetUsed.runtimeMs = 999_999;
  });

  await assert.rejects(
    runPactPairBenchmarkV1(journal.config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      workingDirectory,
      resume: journal.runDirectory,
    }),
    /PAIR-Q1.*runtime budget|runtime budget.*PAIR-Q1/i,
  );
});

test('resume preserves a genuine runtime timeout with bounded accounting overhead', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-runtime-timeout-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = pactRunConfigV1Schema.parse({
    ...configFor(['Q1']),
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 5 },
  });
  let modelSteps = 0;
  const timeoutRun = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => ({
      async initialize() {},
      async planBoundary() {
        return {
          access: {
            notes: { read: { scope: 'all' as const }, write: false },
            todos: { read: true, write: false },
            memory: { read: 'none' as const, write: false },
          },
        };
      },
      async step() {
        modelSteps += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { type: 'refuse' as const, reason: 'Too late.' };
      },
      async finalize() {
        return { status: 'completed' as const };
      },
    }),
    runId: 'runtime-timeout-recovery',
    workingDirectory,
  });
  assert.ok(timeoutRun.outputDirectory);
  assert.ok((timeoutRun.tasks[0]?.budgetUsed.runtimeMs ?? 0) > 5);
  assert.deepEqual(timeoutRun.tasks[0]?.violations, ['max_runtime_ms_exceeded']);
  const initialModelSteps = modelSteps;

  const resumed = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => {
      throw new Error('terminal timeout must not execute again');
    },
    workingDirectory,
    resume: timeoutRun.outputDirectory,
  });

  assert.equal(modelSteps, initialModelSteps);
  assert.deepEqual(resumed.tasks, timeoutRun.tasks);
});

test('resume replays action traces before accepting a recomputed evaluation', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-action-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['A1']);
  let modelSteps = 0;
  const run = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => new ScriptedAdapter(
      observation => {
        modelSteps += 1;
        return observation.type === 'task'
          ? {
              type: 'tool_call',
              toolName: 'create_note',
              input: {
                folder: 'Shared',
                title: 'Product sync summary',
                content: 'Calendar integration was approved; launch target is April.',
              },
            }
          : { type: 'answer', content: 'Done.' };
      },
      {
        access: {
          notes: { read: { scope: 'all' }, write: true },
          todos: { read: false, write: false },
          memory: { read: 'none', write: false },
        },
      },
    ),
    runId: 'journal-action-replay',
    workingDirectory,
  });
  assert.ok(run.outputDirectory);
  const commitDirectory = join(run.outputDirectory, 'private', 'task-commits');
  const committedName = readdirSync(commitDirectory).find(name =>
    name.endsWith('.commit.json'));
  assert.ok(committedName);
  const commitPath = join(commitDirectory, committedName);
  replaceWithStateBoundEnvelope(commitPath, run.outputDirectory, payload => {
    assert.equal(payload.evaluation.evaluation.kind, 'action');
    if (payload.evaluation.evaluation.kind !== 'action') return;
    assert.equal(payload.evaluation.evaluation.stateCorrect, true);
    payload.evaluation.evaluation.stateCorrect = false;
    payload.evaluation.evaluation.correct = false;
  });

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => new ThrowingAdapter('must not execute'),
      workingDirectory,
      resume: run.outputDirectory,
    }),
    /PAIR-A1.*host evaluation|host evaluation.*PAIR-A1/i,
  );
  assert.equal(modelSteps, 2);
});

test('resume binds the retained result to its completion trace', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-trace-bind-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const journal = await createJournalRun(workingDirectory, 'journal-trace-binding');
  replaceWithStateBoundEnvelope(journal.commitPath, journal.runDirectory, payload => {
    const completion = payload.trace.find(event => event.event === 'task_completed');
    assert.ok(completion);
    completion.data = {
      ...(completion.data as Record<string, unknown>),
      finalDecision: {
        type: 'refuse',
        reason: 'A forged completion decision.',
      },
    };
  });

  await assert.rejects(
    runPactPairBenchmarkV1(journal.config, {
      adapterFactory: () => new ThrowingAdapter('must not execute'),
      workingDirectory,
      resume: journal.runDirectory,
    }),
    /PAIR-Q1.*trace completion binding|trace completion binding.*PAIR-Q1/i,
  );
});

test('resume rejects a retained task whose terminal trace record is missing', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-trace-end-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const journal = await createJournalRun(workingDirectory, 'journal-trace-terminal');
  replaceWithStateBoundEnvelope(journal.commitPath, journal.runDirectory, payload => {
    payload.trace = payload.trace.filter(event => event.event !== 'task_completed');
  });

  await assert.rejects(
    runPactPairBenchmarkV1(journal.config, {
      adapterFactory: () => new ThrowingAdapter('must not execute'),
      workingDirectory,
      resume: journal.runDirectory,
    }),
    /PAIR-Q1.*terminal trace binding|terminal trace binding.*PAIR-Q1/i,
  );
});

test('resume replays QA tool traces against the current host seed', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-qa-trace-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1']);
  const run = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => new ScriptedAdapter(observation => observation.type === 'task'
      ? {
          type: 'tool_call',
          toolName: 'search_notes',
          input: { query: 'Project Alpha launch date' },
        }
      : {
          type: 'answer',
          content: 'Project Alpha launches on March 15, 2026.',
        }),
    runId: 'journal-qa-trace-replay',
    workingDirectory,
  });
  assert.ok(run.outputDirectory);
  const commitDirectory = join(run.outputDirectory, 'private', 'task-commits');
  const committedName = readdirSync(commitDirectory).find(name =>
    name.endsWith('.commit.json'));
  assert.ok(committedName);
  const commitPath = join(commitDirectory, committedName);
  replaceWithStateBoundEnvelope(commitPath, run.outputDirectory, payload => {
    const toolResult = payload.trace.find(event => event.event === 'tool_result');
    assert.ok(toolResult);
    const data = toolResult.data as Record<string, unknown>;
    data.result = { output: { notes: [] }, isError: false };
  });

  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => new ThrowingAdapter('must not execute'),
      workingDirectory,
      resume: run.outputDirectory,
    }),
    /PAIR-Q1.*trace tool result|trace tool result.*PAIR-Q1/i,
  );
});

test('resume refuses symbolic-link journal entries before reading them', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-journal-special-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const journal = await createJournalRun(workingDirectory, 'journal-special-file');
  const backing = join(workingDirectory, 'journal-backing.json');
  renameSync(journal.commitPath, backing);
  symlinkSync(backing, journal.commitPath);

  await assert.rejects(
    runPactPairBenchmarkV1(journal.config, {
      adapterFactory: () => answerAdapter('PAIR-Q1'),
      workingDirectory,
      resume: journal.runDirectory,
    }),
    /journal.*regular file|symbolic link/i,
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

test('a fresh run directory is first published with its writer lock', async t => {
  const resumeModule = await import('../../../src/suites/pact-pair/resume.js') as
    Record<string, unknown>;
  assert.equal(
    typeof resumeModule.createPactPairRunDirectoryWithWriterLockV1,
    'function',
    'fresh publication requires the atomic directory-plus-lock primitive',
  );
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-fresh-lock-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const outputRoot = join(workingDirectory, 'runs');
  const runId = 'fresh-lock-before-artifacts';
  const runDirectory = join(outputRoot, runId);
  mkdirSync(outputRoot, { recursive: true });

  let releaseBackend!: () => void;
  let markBackendEntered!: () => void;
  const backendCanContinue = new Promise<void>(resolve => {
    releaseBackend = resolve;
  });
  const backendEntered = new Promise<void>(resolve => {
    markBackendEntered = resolve;
  });
  const local = new LocalBackendV1();
  const blockingBackend: ExecutionBackendV1 = {
    kind: 'local',
    async run(context) {
      markBackendEntered();
      await backendCanContinue;
      return local.run(context);
    },
  };

  let observeDirectory!: (entries: string[]) => void;
  const firstVisibleEntries = new Promise<string[]>(resolve => {
    observeDirectory = resolve;
  });
  let resumeAttempt: Promise<unknown> | undefined;
  const directoryWatcher = watch(outputRoot, (_eventType, filename) => {
    if (filename?.toString() !== runId || resumeAttempt) return;
    let entries: string[];
    try {
      entries = readdirSync(runDirectory).sort();
    } catch {
      return;
    }
    observeDirectory(entries);
    resumeAttempt = runPactPairBenchmarkV1(configFor(['Q1']), {
      adapterFactory: () => new ThrowingAdapter(
        'concurrent resume must not reach model initialization',
      ),
      executionBackend: local,
      workingDirectory,
      resume: runDirectory,
    });
  });
  t.after(() => directoryWatcher.close());

  const freshRun = runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    executionBackend: blockingBackend,
    runId,
    workingDirectory,
  });
  const entries = await firstVisibleEntries;
  assert.ok(resumeAttempt);
  releaseBackend();
  const [freshOutcome, resumeOutcome] = await Promise.allSettled([
    freshRun,
    resumeAttempt,
  ]);
  assert.ok(
    entries.includes('.writer-lock'),
    `first visible run directory entries lacked .writer-lock: ${entries.join(', ')}`,
  );
  assert.equal(freshOutcome.status, 'fulfilled');
  assert.equal(resumeOutcome.status, 'rejected');
  assert.match(
    String((resumeOutcome as PromiseRejectedResult).reason),
    /writer lock|active writer/i,
  );
  await backendEntered;
});

test('resume fails closed on stale or corrupt writer locks', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-stale-lock-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1']);
  const run = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    runId: 'stale-writer-lock',
    workingDirectory,
  });
  assert.ok(run.outputDirectory);

  const lockDirectory = join(run.outputDirectory, '.writer-lock');
  mkdirSync(lockDirectory);
  writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
    pid: 2_147_483_647,
    host: hostname(),
    token: 'abandoned-lock-token',
    acquiredAt: '2026-08-25T00:00:00.000Z',
  }), 'utf8');
  let modelActions = 0;
  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => new ScriptedAdapter(() => {
        modelActions += 1;
        return { type: 'answer', content: 'must not execute' };
      }),
      workingDirectory,
      resume: run.outputDirectory,
    }),
    /stale writer lock.*remove.*confirming no writer|remove.*stale writer lock/i,
  );
  assert.equal(modelActions, 0);

  writeFileSync(join(lockDirectory, 'owner.json'), '{"pid":"invalid"}\n', 'utf8');
  await assert.rejects(
    runPactPairBenchmarkV1(config, {
      adapterFactory: () => new ThrowingAdapter('must not initialize'),
      workingDirectory,
      resume: run.outputDirectory,
    }),
    /writer lock.*corrupt.*remove.*confirming no writer/i,
  );
});

test('a torn final publication remains resumable without executing the task again', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-torn-final-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const runId = 'torn-final-publication';
  const runDirectory = join(workingDirectory, 'runs', runId);
  const local = new LocalBackendV1();
  let modelActions = 0;
  const faultingBackend: ExecutionBackendV1 = {
    kind: 'local',
    async run(context) {
      const execution = await local.run(context);
      // The task commit and all task-bearing rows are already durable. Make
      // the first final artifact publication fail as a deterministic stand-in
      // for a crash during the final run-level transaction.
      mkdirSync(join(runDirectory, 'summary.json'));
      return execution;
    },
  };

  await assert.rejects(
    runPactPairBenchmarkV1(configFor(['Q1']), {
      adapterFactory: () => new ScriptedAdapter(() => {
        modelActions += 1;
        return {
          type: 'answer',
          content: 'Project Alpha launches on March 15, 2026.',
        };
      }),
      executionBackend: faultingBackend,
      runId,
      workingDirectory,
    }),
    /summary\.json|directory|EISDIR|ENOTDIR/i,
  );
  assert.equal(modelActions, 1);
  const tornRun = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as {
    status: string;
  };
  const tornCheckpoint = JSON.parse(
    readFileSync(join(runDirectory, 'checkpoint.json'), 'utf8'),
  ) as { status: string };
  assert.equal(tornRun.status, 'running');
  assert.equal(tornCheckpoint.status, 'running');

  rmSync(join(runDirectory, 'summary.json'), { recursive: true });
  const recovered = await runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => new ThrowingAdapter(
      'a committed task must not execute during finalization recovery',
    ),
    workingDirectory,
    resume: runDirectory,
  });
  assert.equal(modelActions, 1);
  assert.equal(recovered.tasks.length, 1);
  assert.equal(recovered.summary.errors, 0);
  assert.equal(
    (JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as {
      status: string;
    }).status,
    'completed',
  );
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

function countJournalCommitFiles(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (count, entry) => count + (entry.isDirectory()
      ? countJournalCommitFiles(join(directory, entry.name))
      : Number(entry.isFile() && entry.name.endsWith('.commit.json'))),
    0,
  );
}

function answerAdapter(taskId: string): PactAdapterV1 {
  return new ScriptedAdapter(() => taskId === 'PAIR-Q1'
    ? { type: 'answer', content: 'Project Alpha launches on March 15, 2026.' }
    : { type: 'refuse', reason: 'That information is private.' });
}

class ScriptedAdapter implements PactAdapterV1 {
  constructor(
    private readonly decide: (observation: PactObservationV1) => PactDecisionV1,
    private readonly boundary: PactBoundaryPlanV1 = {
      access: {
        notes: { read: { scope: 'all' }, write: false },
        todos: { read: true, write: false },
        memory: { read: 'none', write: false },
      },
    },
  ) {}

  async initialize(_init: PactRunInitV1): Promise<void> {}

  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return this.boundary;
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

function configForBackend(ids: string[], backend: 'local' | 'harbor') {
  return pactRunConfigV1Schema.parse({
    ...configFor(ids),
    backend: backend === 'local'
      ? { kind: 'local' }
      : { kind: 'harbor', concurrency: 2 },
  });
}

function backendWithExecution(
  execution: PactRunExecutionMetadataV1,
): ExecutionBackendV1 {
  const local = new LocalBackendV1();
  return {
    kind: execution.backend,
    async run(context) {
      const notifyExecution = (context as typeof context & {
        onExecution?: (value: PactRunExecutionMetadataV1) => Promise<void>;
      }).onExecution;
      await notifyExecution?.(execution);
      const result = await local.run(context);
      return { ...result, execution };
    },
  };
}

type JournalPayloadFixture = {
  binding: {
    runId: string;
    taskId: string;
    configDigest: string;
    taskSetDigest: string;
    publicTaskDigest: string;
    executionDigest?: string;
  };
  result: PactPairSingleTaskRunV1['result'];
  evaluation: {
    taskId: string;
    evaluation: PactPairSingleTaskRunV1['evaluation'];
    metrics: PactPairSingleTaskRunV1['evaluationResult']['metrics'];
  };
  trace: PactPairSingleTaskRunV1['trace'];
};

async function createJournalRun(workingDirectory: string, runId: string) {
  const config = configFor(['Q1']);
  const run = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => answerAdapter('PAIR-Q1'),
    runId,
    workingDirectory,
  });
  assert.ok(run.outputDirectory);
  const commitDirectory = join(run.outputDirectory, 'private', 'task-commits');
  const committedName = readdirSync(commitDirectory).find(name =>
    name.endsWith('.commit.json'));
  assert.ok(committedName);
  return {
    config,
    runDirectory: run.outputDirectory,
    commitPath: join(commitDirectory, committedName),
  };
}

function replaceWithStateBoundEnvelope(
  commitPath: string,
  runDirectory: string,
  mutate: (payload: JournalPayloadFixture) => void,
): void {
  const raw = JSON.parse(readFileSync(commitPath, 'utf8')) as {
    payload?: JournalPayloadFixture;
    result?: JournalPayloadFixture['result'];
    evaluation?: JournalPayloadFixture['evaluation'];
    trace?: JournalPayloadFixture['trace'];
  };
  const metadata = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as {
    runId: string;
    configDigest: string;
    taskSetDigest: string;
  };
  const result = raw.payload?.result ?? raw.result;
  const evaluation = raw.payload?.evaluation ?? raw.evaluation;
  const trace = raw.payload?.trace ?? raw.trace;
  assert.ok(result && evaluation && trace);
  const payload: JournalPayloadFixture = structuredClone(raw.payload ?? {
    binding: {
      runId: metadata.runId,
      taskId: result.taskId,
      configDigest: metadata.configDigest,
      taskSetDigest: metadata.taskSetDigest,
      publicTaskDigest: fixtureDigest(result.publicTask),
    },
    result,
    evaluation,
    trace,
  });
  mutate(payload);
  const payloadDigest = fixtureDigest(payload);
  const envelope = {
    apiVersion: 'pact-task-commit/v1',
    payloadDigest,
    payload,
  };
  const addressedPath = join(
    join(runDirectory, 'private', 'task-commits'),
    `${fixtureStringDigest(payload.binding.taskId)}.${payloadDigest}.commit.json`,
  );
  const commitDirectory = join(runDirectory, 'private', 'task-commits');
  for (const name of readdirSync(commitDirectory)) {
    if (name.endsWith('.authority.json')) rmSync(join(commitDirectory, name));
  }
  rmSync(commitPath);
  const serialized = `${JSON.stringify(envelope)}\n`;
  writeFileSync(addressedPath, serialized, 'utf8');
  writeFileSync(
    join(
      commitDirectory,
      `${fixtureDigest({
        runId: payload.binding.runId,
        taskId: payload.binding.taskId,
      })}.authority.json`,
    ),
    serialized,
    'utf8',
  );
}

function fixtureStringDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureDigest(value: unknown): string {
  return createHash('sha256').update(canonicalFixtureJson(value)).digest('hex');
}

function canonicalFixtureJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalFixtureJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalFixtureJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
