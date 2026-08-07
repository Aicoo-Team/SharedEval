import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { runPactPairBenchmarkV1 } from '../../../src/suites/pact-pair/runner.js';
import { selectPactPairResumeTasksV1 } from '../../../src/suites/pact-pair/resume.js';

test('partitions resume tasks into completed, retry, and missing', () => {
  const selection = selectPactPairResumeTasksV1(
    ['PAIR-Q1', 'PAIR-Q2', 'PAIR-Q3', 'PAIR-Q4'],
    [
      { taskId: 'PAIR-Q1', status: 'ok' },
      { taskId: 'PAIR-Q2', status: 'infrastructure_error' },
      // A stale error line beside a later ok line: the ok result wins, the
      // task counts as completed and is never re-run.
      { taskId: 'PAIR-Q3', status: 'infrastructure_error' },
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

test('resume re-runs only missing and infrastructure_error tasks', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-resume-e2e-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const config = configFor(['Q1', 'Q2', 'Q101']);

  // First attempt: PAIR-Q1 and PAIR-Q2 complete, PAIR-Q101 hits an
  // infrastructure error.
  const first = await runPactPairBenchmarkV1(config, {
    adapterFactory: ({ publicTask }) => publicTask.taskId === 'PAIR-Q101'
      ? new ThrowingAdapter('synthetic backend outage')
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
