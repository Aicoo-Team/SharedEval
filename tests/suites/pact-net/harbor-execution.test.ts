import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectHarborDatasetTaskRunsV1 } from '../../../src/runner/v1/backends/harbor-backend.js';
import { pactRunConfigV1Schema } from '../../../src/runner/v1/config.js';
import {
  createScriptedPactNetHarnessV1,
  loadPactNetTasksV1,
  pactNetMetricContributionsV1,
  runPactNetBenchmarkV1,
  PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1,
} from '../../../src/suites/pact-net/index.js';

const FIXTURE_TASK_IDS = ['NET-Q-0001', 'NET-Q-0010', 'NET-A-0001'];

test('collects containerized Net trials with host-recomputed metrics', async t => {
  const fixture = await buildNetVerifierFixture(t, FIXTURE_TASK_IDS);

  const { taskRuns, failures } = await collectHarborDatasetTaskRunsV1(
    fixture.jobsDirectory,
    fixture.tasks,
    PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1,
  );

  assert.equal(failures.size, 0);
  assert.deepEqual([...taskRuns.keys()].sort(), [...FIXTURE_TASK_IDS].sort());
  for (const taskId of FIXTURE_TASK_IDS) {
    const run = taskRuns.get(taskId);
    assert.ok(run);
    assert.equal(run.result.taskId, taskId);
    assert.equal(run.result.status, 'ok');
    // Only host-recomputed contributions enter the run summary.
    assert.deepEqual(
      run.evaluationResult.metrics,
      pactNetMetricContributionsV1(run.evaluation),
    );
    assert.ok(run.trace.length > 0);
  }
});

test('one malformed Net artifact only fails its own task', async t => {
  const fixture = await buildNetVerifierFixture(t, ['NET-Q-0001', 'NET-Q-0010']);
  await writeFile(
    join(fixture.verifierDirectories.get('NET-Q-0010') ?? '', 'pact-result.json'),
    '{ this is not json',
    'utf8',
  );

  const { taskRuns, failures } = await collectHarborDatasetTaskRunsV1(
    fixture.jobsDirectory,
    fixture.tasks,
    PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1,
  );
  assert.deepEqual([...taskRuns.keys()], ['NET-Q-0001']);
  assert.match(failures.get('NET-Q-0010') ?? '', /invalid trial artifact/);
});

test('rejects Net metric rows that do not match the host recomputation', async t => {
  const fixture = await buildNetVerifierFixture(t, ['NET-Q-0010']);
  const evaluationPath = join(
    fixture.verifierDirectories.get('NET-Q-0010') ?? '',
    'evaluation.jsonl',
  );
  const record = JSON.parse(await readFile(evaluationPath, 'utf8')) as {
    metrics: Array<{ metric: string; numerator: number; denominator: number }>;
  };
  // NET-Q-0010 is a scoped refuse-expected task: its informationSecurity
  // contribution is 1/1. A container must not be able to zero it out (or
  // inflate any other row) past what its own evaluation implies.
  const target = record.metrics.find(row => row.metric === 'informationSecurity');
  assert.ok(target);
  assert.equal(target.denominator, 1);
  target.numerator = target.denominator = 0;
  await writeFile(evaluationPath, `${JSON.stringify(record)}\n`, 'utf8');

  const { taskRuns, failures } = await collectHarborDatasetTaskRunsV1(
    fixture.jobsDirectory,
    fixture.tasks,
    PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1,
  );
  assert.equal(taskRuns.size, 0);
  assert.match(
    failures.get('NET-Q-0010') ?? '',
    /metric contributions do not match the host recomputation/,
  );
});

test('rejects Net evaluations that contradict the host gold labels', async t => {
  const fixture = await buildNetVerifierFixture(t, ['NET-Q-0010']);
  const evaluationPath = join(
    fixture.verifierDirectories.get('NET-Q-0010') ?? '',
    'evaluation.jsonl',
  );
  const original = await readFile(evaluationPath, 'utf8');

  const tamper = async (mutate: (record: {
    evaluation: {
      expectedBehavior: string;
      category: string;
      routingBlocked: boolean;
    };
  }) => void) => {
    const record = JSON.parse(original) as Parameters<typeof mutate>[0];
    mutate(record);
    await writeFile(evaluationPath, `${JSON.stringify(record)}\n`, 'utf8');
    return collectHarborDatasetTaskRunsV1(
      fixture.jobsDirectory,
      fixture.tasks,
      PACT_NET_HARBOR_ARTIFACT_COLLECTION_V1,
    );
  };

  // Gold expected behavior (NET-Q-0010 expects refuse).
  const behaviorTamper = await tamper(record => {
    assert.equal(record.evaluation.expectedBehavior, 'refuse');
    record.evaluation.expectedBehavior = 'answer';
  });
  assert.equal(behaviorTamper.taskRuns.size, 0);
  const behaviorFailure = behaviorTamper.failures.get('NET-Q-0010') ?? '';
  assert.equal(
    behaviorFailure,
    'Harbor returned an invalid trial artifact: '
      + 'Harbor evaluation mismatch for NET-Q-0010: expectedBehavior',
  );
  assert.doesNotMatch(behaviorFailure, /\b(?:answer|refuse)\b/);

  // Category feeds the metric denominators, so it is cross-checked too.
  const categoryTamper = await tamper(record => {
    record.evaluation.category = 'transitive_risk';
  });
  assert.equal(categoryTamper.taskRuns.size, 0);
  assert.equal(
    categoryTamper.failures.get('NET-Q-0010') ?? '',
    'Harbor returned an invalid trial artifact: '
      + 'Harbor evaluation mismatch for NET-Q-0010: category',
  );

  // routingBlocked must equal the host routing verdict: only the environment
  // can synthesize routing_blocked outcomes.
  const routingTamper = await tamper(record => {
    record.evaluation.routingBlocked = true;
  });
  assert.equal(routingTamper.taskRuns.size, 0);
  assert.equal(
    routingTamper.failures.get('NET-Q-0010') ?? '',
    'Harbor returned an invalid trial artifact: '
      + 'Harbor evaluation mismatch for NET-Q-0010: routingBlocked',
  );
});

type NetVerifierFixture = {
  jobsDirectory: string;
  tasks: ReturnType<typeof loadPactNetTasksV1>;
  verifierDirectories: Map<string, string>;
};

/**
 * Runs the selected Net tasks locally with the scripted harness, then lays
 * the canonical artifacts out exactly like Harbor's per-trial verifier
 * directories, so the Net collection can be exercised without Docker (the
 * pair fixture in tests/runner-v1/harbor-backend.test.ts is the precedent).
 */
async function buildNetVerifierFixture(
  t: { after(fn: () => unknown): void },
  ids: string[],
): Promise<NetVerifierFixture> {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-net-harbor-collect-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://scripted.invalid/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'pact-scripted-parity-v1',
      maxOutputTokens: 256,
    },
    benchmark: {
      dataset: 'pact-net',
      policy: 'D2',
      tasks: { kind: 'all', ids },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 30_000 },
    output: { directory: 'runs', saveTraces: true },
  });
  const result = await runPactNetBenchmarkV1(config, {
    harnessFactory: createScriptedPactNetHarnessV1,
    executor: 'scripted-harness',
    environment: {},
    runId: 'net-harbor-collect-fixture',
    workingDirectory: temporary,
  });
  assert.ok(result.outputDirectory);
  const lines = async (path: string) =>
    (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
  const resultsLines = await lines(join(result.outputDirectory, 'results.jsonl'));
  const evaluationLines = await lines(
    join(result.outputDirectory, 'private', 'evaluation.jsonl'),
  );
  const traceLines = await lines(
    join(result.outputDirectory, 'private', 'trace.jsonl'),
  );

  const jobsDirectory = join(temporary, 'jobs');
  const verifierDirectories = new Map<string, string>();
  for (const id of ids) {
    const slug = id.toLocaleLowerCase('en-US');
    const verifierDirectory = join(
      jobsDirectory,
      'pact-net-collect-job',
      `${slug}__trial-0`,
      'verifier',
    );
    await mkdir(verifierDirectory, { recursive: true });
    verifierDirectories.set(id, verifierDirectory);
    const resultLine = resultsLines.find(line =>
      (JSON.parse(line) as { taskId: string }).taskId === id);
    const evaluationLine = evaluationLines.find(line =>
      (JSON.parse(line) as { taskId: string }).taskId === id);
    const taskTrace = traceLines.filter(line =>
      (JSON.parse(line) as { taskId?: string }).taskId === id);
    assert.ok(resultLine && evaluationLine);
    await writeFile(
      join(verifierDirectory, 'pact-result.json'),
      `${resultLine}\n`,
      'utf8',
    );
    await writeFile(
      join(verifierDirectory, 'evaluation.jsonl'),
      `${evaluationLine}\n`,
      'utf8',
    );
    await writeFile(
      join(verifierDirectory, 'trace.jsonl'),
      `${taskTrace.join('\n')}\n`,
      'utf8',
    );
  }
  const tasks = loadPactNetTasksV1({ policy: 'D2', ids });
  return { jobsDirectory, tasks, verifierDirectories };
}
