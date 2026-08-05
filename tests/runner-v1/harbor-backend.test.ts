import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  HarborBackendV1,
  PACT_HARBOR_IMAGE_V1,
  PACT_HARBOR_SMOKE_TASK_IDS_V1,
} from '../../src/runner/v1/backends/harbor-backend.js';
import { materializeHarborDatasetV1 } from '../../src/runner/v1/backends/harbor-task-package.js';
import {
  parsePactRunConfigV1Yaml,
  pactRunConfigV1Schema,
} from '../../src/runner/v1/config.js';
import { runPactPairBenchmarkV1 } from '../../src/runner/v1/runner.js';
import { createScriptedPactHarnessV1 } from '../../src/runner/v1/scripted-harness.js';
import {
  loadPactPairSplitTaskIdsV1,
  loadPactPairTasksV1,
  pactPairSplitPathV1,
} from '../../src/runner/v1/task-loader.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('materializes strict Harbor task packages from one shared template', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-template-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = configFor('local', ['PAIR-Q1']);
  const tasks = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids: ['PAIR-Q1'],
  });

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory: join(repositoryRoot, 'harbor', 'task-template'),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks,
  });

  const taskDirectory = join(temporary, 'pair-q1');
  const taskToml = await readFile(join(taskDirectory, 'task.toml'), 'utf8');
  const solution = await readFile(join(taskDirectory, 'solution', 'solve.sh'), 'utf8');
  assert.match(taskToml, /name = "pact\/pair-pair-q1"/);
  assert.match(taskToml, /docker_image = "pact-bench-harbor:p0-pair-q1"/);
  assert.match(solution, /--task-id "PAIR-Q1"/);
  assert.match(solution, /--policy "D2"/);
  assert.doesNotMatch(`${taskToml}${solution}`, /\{\{[A-Z_]+\}\}/);
});

test('scripted smoke harness deterministically covers six QA and action tasks', async () => {
  const result = await runPactPairBenchmarkV1(
    configFor('local', [...PACT_HARBOR_SMOKE_TASK_IDS_V1]),
    {
      harnessFactory: () => createScriptedPactHarnessV1(),
      environment: {},
      runId: 'local-scripted-smoke',
      writeOutputs: false,
    },
  );

  assert.equal(result.summary.total, 6);
  assert.equal(result.summary.correct, 6);
  assert.equal(result.summary.errors, 0);
  assert.deepEqual(result.tasks.map(task => task.taskId), PACT_HARBOR_SMOKE_TASK_IDS_V1);
  assert.equal(result.tasks.every(task => task.violations.length === 0), true);

  const goldenDirectory = join(
    repositoryRoot,
    'tests',
    'golden',
    'pact-pair-smoke-v1',
  );
  const goldenSummary = JSON.parse(
    await readFile(join(goldenDirectory, 'summary.json'), 'utf8'),
  );
  const goldenResults = (await readFile(
    join(goldenDirectory, 'results.jsonl'),
    'utf8',
  ))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const normalized = structuredClone(result.tasks);
  for (const task of normalized) task.budgetUsed.runtimeMs = 0;
  assert.deepEqual(result.summary, goldenSummary);
  assert.deepEqual(normalized, goldenResults);
});

test('Harbor backend generalizes materialization beyond the smoke set', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-nonsmoke-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // PAIR-Q2 and PAIR-A8 are ordinary dataset tasks, never part of the old
  // six-task allowlist. They must now materialize like any other task.
  const ids = ['PAIR-Q2', 'PAIR-A8'];
  const config = configFor('harbor', ids);
  const tasks = loadPactPairTasksV1({ policy: 'D2', requester: 'R1', gradingMode: 'category', ids });

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory: join(repositoryRoot, 'harbor', 'task-template'),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks,
  });

  for (const id of ids) {
    const slug = id.toLocaleLowerCase('en-US');
    const taskToml = await readFile(join(temporary, slug, 'task.toml'), 'utf8');
    const solution = await readFile(join(temporary, slug, 'solution', 'solve.sh'), 'utf8');
    assert.ok(taskToml.includes(`pact_task_id = "${id}"`));
    assert.ok(solution.includes(`--task-id "${id}"`));
    assert.doesNotMatch(`${taskToml}${solution}`, /\{\{[A-Z_]+\}\}/);
  }
});

test('Harbor backend maps command failures to canonical backend errors', async () => {
  // Force the external toolchain to be missing so the run fails before any
  // Docker/Harbor work. This exercises the backend_error mapping deterministically
  // and without Docker, and confirms the removed allowlist no longer short-circuits
  // a non-smoke task (PAIR-Q2) before the backend attempts to run it.
  const backend = new HarborBackendV1({
    dockerExecutable: 'pact-nonexistent-docker-binary',
    harborExecutable: 'pact-nonexistent-harbor-binary',
  });
  const result = await runPactPairBenchmarkV1(configFor('harbor', ['PAIR-Q2']), {
    executionBackend: backend,
    environment: {},
    runId: 'harbor-command-failure',
    writeOutputs: false,
  });

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.errors, 1);
  assert.deepEqual(result.tasks[0]?.violations, ['backend_error']);
  assert.match(result.tasks[0]?.error ?? '', /pact-nonexistent-docker-binary/);
  assert.doesNotMatch(result.tasks[0]?.error ?? '', /smoke set/);
});

test('scripted harness reproduces the committed split-01 golden (deterministic parity)', async () => {
  const ids = loadPactPairSplitTaskIdsV1(
    pactPairSplitPathV1({ rootDir: repositoryRoot, index: 1 }),
  );
  const result = await runPactPairBenchmarkV1(configFor('local', ids), {
    harnessFactory: () => createScriptedPactHarnessV1(),
    environment: {},
    runId: 'local-scripted-split-01',
    writeOutputs: false,
  });

  assert.equal(result.summary.total, 60);
  assert.equal(result.tasks.length, 60);
  assert.deepEqual(result.tasks.map(task => task.taskId), ids);

  const goldenDirectory = join(
    repositoryRoot,
    'tests',
    'golden',
    'pact-pair-split-01-v1',
  );
  const goldenSummary = JSON.parse(
    await readFile(join(goldenDirectory, 'summary.json'), 'utf8'),
  );
  const goldenResults = (await readFile(
    join(goldenDirectory, 'results.jsonl'),
    'utf8',
  ))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const normalized = structuredClone(result.tasks);
  for (const task of normalized) task.budgetUsed.runtimeMs = 0;
  assert.deepEqual(result.summary, goldenSummary);
  assert.deepEqual(normalized, goldenResults);
});

test('split-01 example config selects the split ids in canonical order', async () => {
  const source = await readFile(
    join(repositoryRoot, 'examples', 'pact-run.harbor-split-01.yaml'),
    'utf8',
  );
  const config = parsePactRunConfigV1Yaml(source);
  const expected = loadPactPairSplitTaskIdsV1(
    pactPairSplitPathV1({ rootDir: repositoryRoot, index: 1 }),
  );
  assert.equal(config.backend?.kind, 'harbor');
  assert.deepEqual(config.benchmark.tasks.ids, expected);
});

function configFor(backend: 'local' | 'harbor', ids: string[]) {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    backend: backend === 'local'
      ? { kind: 'local' }
      : { kind: 'harbor', concurrency: 2 },
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://scripted.invalid/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'pact-scripted-parity-v1',
      maxOutputTokens: 256,
    },
    benchmark: {
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 30_000 },
    output: { directory: 'runs', saveTraces: true },
  });
}
