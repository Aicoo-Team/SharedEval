import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  collectHarborTaskRunsV1,
  HarborBackendV1,
  PACT_HARBOR_IMAGE_V1,
  PACT_HARBOR_SMOKE_TASK_IDS_V1,
  PACT_HARBOR_VERSION_V1,
} from '../../src/runner/v1/backends/harbor-backend.js';
import { materializeHarborDatasetV1 } from '../../src/runner/v1/backends/harbor-task-package.js';
import { buildPactContainerRunConfigV1 } from '../../src/runner/v1/container-entrypoint.js';
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
  // Harbor v0.5.0 only disables networking through allow_internet = false;
  // the legacy network_mode key is silently ignored and must never come back.
  assert.match(taskToml, /allow_internet = false/);
  assert.doesNotMatch(taskToml, /network_mode/);
  assert.match(solution, /--task-id "PAIR-Q1"/);
  assert.match(solution, /--policy "D2"/);
  assert.match(solution, /--grading-mode "category"/);
  assert.doesNotMatch(`${taskToml}${solution}`, /\{\{[A-Z_]+\}\}/);
});

test('materializes the full grading surface with host/container config parity', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-parity-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // A relationship-graded ablation policy: exactly the surface that the
  // original D0–D5-only container plumbing silently mis-graded.
  const config = pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    backend: { kind: 'harbor', concurrency: 2 },
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://scripted.invalid/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'pact-scripted-parity-v1',
      maxOutputTokens: 256,
    },
    benchmark: {
      policy: 'REL_R3',
      requester: 'R3',
      gradingMode: 'relationship',
      tasks: { kind: 'qa', ids: ['PAIR-Q101'] },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 30_000 },
    output: { directory: 'runs', saveTraces: true },
  });
  const tasks = loadPactPairTasksV1({
    policy: 'REL_R3',
    requester: 'R3',
    gradingMode: 'relationship',
    kind: 'qa',
    ids: ['PAIR-Q101'],
  });

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory: join(repositoryRoot, 'harbor', 'task-template'),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks,
  });

  const solution = await readFile(
    join(temporary, 'pair-q101', 'solution', 'solve.sh'),
    'utf8',
  );
  const flag = (name: string): string => {
    const match = new RegExp(`--${name} "([^"]+)"`).exec(solution);
    assert.ok(match, `solve.sh is missing --${name}`);
    return match[1] ?? '';
  };
  assert.equal(flag('policy'), 'REL_R3');
  assert.equal(flag('requester'), 'R3');
  assert.equal(flag('grading-mode'), 'relationship');

  // Rebuild the container-side config exactly as the entrypoint would and
  // prove the grading configuration matches the host run.
  const containerConfig = buildPactContainerRunConfigV1({
    taskId: flag('task-id'),
    policy: flag('policy') as typeof config.benchmark.policy,
    requester: flag('requester') as typeof config.benchmark.requester,
    gradingMode: flag('grading-mode') as typeof config.benchmark.gradingMode,
    maxTurns: Number(flag('max-turns')),
    maxToolCalls: Number(flag('max-tool-calls')),
    maxRuntimeMs: Number(flag('max-runtime-ms')),
    outputDirectoryName: 'pact-output',
  });
  assert.equal(containerConfig.benchmark.policy, config.benchmark.policy);
  assert.equal(containerConfig.benchmark.requester, config.benchmark.requester);
  assert.equal(containerConfig.benchmark.gradingMode, config.benchmark.gradingMode);
  assert.deepEqual(containerConfig.budget, config.budget);

  // The container's loaded task grades identically to the host's.
  const containerTasks = loadPactPairTasksV1({
    policy: containerConfig.benchmark.policy,
    requester: containerConfig.benchmark.requester,
    gradingMode: containerConfig.benchmark.gradingMode,
    kind: containerConfig.benchmark.tasks.kind,
    ids: containerConfig.benchmark.tasks.ids,
  });
  assert.deepEqual(containerTasks, tasks);
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
  // Docker/Harbor work — the version gate runs first, so the missing Harbor
  // binary is the failure surfaced. This exercises the backend_error mapping
  // deterministically and without Docker, and confirms the removed allowlist
  // no longer short-circuits a non-smoke task (PAIR-Q2).
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
  assert.match(result.tasks[0]?.error ?? '', /pact-nonexistent-harbor-binary/);
  assert.match(result.tasks[0]?.error ?? '', /Harbor version/);
  assert.doesNotMatch(result.tasks[0]?.error ?? '', /smoke set/);
  // Even a failed Harbor run records honest execution provenance: the
  // backend and its scripted executor, never the caller-selected model.
  assert.equal(result.execution.backend, 'harbor');
  assert.equal(result.execution.executor, 'scripted-harness');
  assert.equal(result.execution.harbor?.version, PACT_HARBOR_VERSION_V1);
});

test('Harbor backend refuses to run under an unsupported Harbor version', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-version-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fakeHarbor = join(temporary, 'fake-harbor');
  await writeFile(fakeHarbor, '#!/bin/sh\necho "harbor 0.4.9"\n', 'utf8');
  await chmod(fakeHarbor, 0o755);

  const backend = new HarborBackendV1({
    harborExecutable: fakeHarbor,
    dockerExecutable: 'pact-nonexistent-docker-binary',
  });
  const result = await runPactPairBenchmarkV1(configFor('harbor', ['PAIR-Q1']), {
    executionBackend: backend,
    environment: {},
    runId: 'harbor-version-mismatch',
    writeOutputs: false,
  });

  assert.equal(result.summary.errors, 1);
  assert.deepEqual(result.tasks[0]?.violations, ['backend_error']);
  assert.match(result.tasks[0]?.error ?? '', /Unsupported Harbor version 0\.4\.9/);
  assert.match(result.tasks[0]?.error ?? '', new RegExp(PACT_HARBOR_VERSION_V1.replace(/\./g, '\\.')));
});

test('collects valid Harbor trials even when a sibling artifact is malformed', async t => {
  const fixture = await buildVerifierFixture(t, ['PAIR-Q1', 'PAIR-Q101']);

  // Corrupt only PAIR-Q101's canonical artifact.
  await writeFile(
    join(fixture.verifierDirectories.get('PAIR-Q101') ?? '', 'pact-result.json'),
    '{ this is not json',
    'utf8',
  );

  const { taskRuns, failures } = await collectHarborTaskRunsV1(
    fixture.jobsDirectory,
    fixture.tasks,
  );
  assert.deepEqual([...taskRuns.keys()], ['PAIR-Q1']);
  assert.equal(taskRuns.get('PAIR-Q1')?.result.status, 'ok');
  assert.match(failures.get('PAIR-Q101') ?? '', /invalid trial artifact/);
});

test('rejects container metric rows that do not match the host recomputation', async t => {
  const fixture = await buildVerifierFixture(t, ['PAIR-Q1', 'PAIR-Q101']);

  // Tamper with PAIR-Q101's reported metric contributions: a container must
  // not be able to inflate a numerator past what its evaluation implies.
  const evaluationPath = join(
    fixture.verifierDirectories.get('PAIR-Q101') ?? '',
    'evaluation.jsonl',
  );
  const record = JSON.parse(await readFile(evaluationPath, 'utf8')) as {
    metrics: Array<{ metric: string; numerator: number; denominator: number }>;
  };
  const target = record.metrics.find(row =>
    row.metric === 'informationSecurity');
  assert.ok(target);
  target.numerator = target.denominator = 0;
  await writeFile(evaluationPath, `${JSON.stringify(record)}\n`, 'utf8');

  const { taskRuns, failures } = await collectHarborTaskRunsV1(
    fixture.jobsDirectory,
    fixture.tasks,
  );
  assert.deepEqual([...taskRuns.keys()], ['PAIR-Q1']);
  assert.match(
    failures.get('PAIR-Q101') ?? '',
    /metric contributions do not match the host recomputation/,
  );
});

test('rejects container evaluations that contradict the host gold labels', async t => {
  const fixture = await buildVerifierFixture(t, ['PAIR-Q101']);

  const evaluationPath = join(
    fixture.verifierDirectories.get('PAIR-Q101') ?? '',
    'evaluation.jsonl',
  );
  const record = JSON.parse(await readFile(evaluationPath, 'utf8')) as {
    evaluation: { expectedBehavior: string };
  };
  assert.equal(record.evaluation.expectedBehavior, 'refuse');
  record.evaluation.expectedBehavior = 'answer';
  await writeFile(evaluationPath, `${JSON.stringify(record)}\n`, 'utf8');

  const { taskRuns, failures } = await collectHarborTaskRunsV1(
    fixture.jobsDirectory,
    fixture.tasks,
  );
  assert.equal(taskRuns.size, 0);
  assert.match(failures.get('PAIR-Q101') ?? '', /does not match host gold/);
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

type VerifierFixture = {
  jobsDirectory: string;
  tasks: ReturnType<typeof loadPactPairTasksV1>;
  verifierDirectories: Map<string, string>;
};

/**
 * Runs the selected tasks locally with the scripted harness, then lays the
 * canonical artifacts out exactly like Harbor's per-trial verifier
 * directories, so collectHarborTaskRunsV1 can be exercised without Docker.
 */
async function buildVerifierFixture(
  t: { after(fn: () => unknown): void },
  ids: string[],
): Promise<VerifierFixture> {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-collect-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const result = await runPactPairBenchmarkV1(configFor('local', ids), {
    harnessFactory: () => createScriptedPactHarnessV1(),
    environment: {},
    runId: 'harbor-collect-fixture',
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
      'pact-collect-job',
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
  const tasks = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids,
  });
  return { jobsDirectory, tasks, verifierDirectories };
}

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
