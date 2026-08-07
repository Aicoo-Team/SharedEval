import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PACT_HARBOR_IMAGE_V1 } from '../../src/runner/v1/backends/harbor-backend.js';
import {
  defaultHostSharedOsDirV1,
  PACT_SHAREDOS_COMMIT_V1,
  PACT_SHAREDOS_PROVENANCE_FILE_V1,
  resolveSharedOsCommitV1,
  stageSharedOsBuildV1,
} from '../../src/runner/v1/backends/harbor-sharedos.js';
import {
  materializeHarborDatasetV1,
  pactHarborAllowedEgressV1,
  pactHarborScriptedModelV1,
} from '../../src/runner/v1/backends/harbor-task-package.js';
import { pactRunConfigV1Schema } from '../../src/runner/v1/config.js';
import { loadPactPairTasksV1 } from '../../src/runner/v1/task-loader.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templateDirectory = join(repositoryRoot, 'harbor', 'task-template');

const SHAREDOS_FIXTURE_PACKAGES = [
  'client',
  'contracts',
  'core',
  'http',
  'os',
  'runtime',
  'testkit',
] as const;

test('stages SharedOS dist artifacts with pinned-commit provenance', async t => {
  const checkout = await buildSharedOsFixture(t, PACT_SHAREDOS_COMMIT_V1);
  const stageDirectory = join(checkout, '..', 'stage');

  const staged = await stageSharedOsBuildV1({ sharedOsDir: checkout, stageDirectory });

  assert.equal(staged.commit, PACT_SHAREDOS_COMMIT_V1);
  assert.deepEqual(staged.packages, [...SHAREDOS_FIXTURE_PACKAGES].sort());
  for (const name of SHAREDOS_FIXTURE_PACKAGES) {
    assert.ok(existsSync(join(stageDirectory, 'packages', name, 'dist', 'index.js')));
    assert.ok(existsSync(join(stageDirectory, 'packages', name, 'package.json')));
    // The workspace link keeps bare @sharedos/* imports and the loader's
    // direct dist imports on one realpath (single module instance).
    assert.equal(
      await readlink(join(stageDirectory, 'node_modules', '@sharedos', name)),
      `../../packages/${name}`,
    );
  }
  // Test bundles never ship (they import vitest, which is not staged).
  assert.equal(
    existsSync(join(stageDirectory, 'packages', 'core', 'dist', 'index.test.js')),
    false,
  );
  // The checkout's own zod copy is staged for the contracts/os bare imports.
  assert.ok(existsSync(join(stageDirectory, 'node_modules', 'zod', 'package.json')));

  const provenance = JSON.parse(await readFile(
    join(stageDirectory, PACT_SHAREDOS_PROVENANCE_FILE_V1),
    'utf8',
  )) as { repository: string; commit: string; packages: string[] };
  assert.equal(provenance.repository, 'Aicoo-Team/SharedOS');
  assert.equal(provenance.commit, PACT_SHAREDOS_COMMIT_V1);
  assert.deepEqual(provenance.packages, [...SHAREDOS_FIXTURE_PACKAGES].sort());
});

test('staging fails closed on commit drift and missing build artifacts', async t => {
  const drifted = await buildSharedOsFixture(
    t,
    'beef00000000000000000000000000000000beef',
  );
  await assert.rejects(
    stageSharedOsBuildV1({
      sharedOsDir: drifted,
      stageDirectory: join(drifted, '..', 'stage-drift'),
    }),
    /is at commit beef0000/,
  );

  const unbuilt = await buildSharedOsFixture(t, PACT_SHAREDOS_COMMIT_V1);
  await rm(join(unbuilt, 'packages', 'runtime', 'dist'), { recursive: true });
  await assert.rejects(
    stageSharedOsBuildV1({
      sharedOsDir: unbuilt,
      stageDirectory: join(unbuilt, '..', 'stage-unbuilt'),
    }),
    /missing for runtime/,
  );
});

test('host SharedOS dir resolution honors PACT_SHAREDOS_DIR', async t => {
  assert.equal(
    defaultHostSharedOsDirV1('/repo/pact', { PACT_SHAREDOS_DIR: '/elsewhere/sharedos' }),
    '/elsewhere/sharedos',
  );
  assert.equal(
    defaultHostSharedOsDirV1('/repo/pact', {}),
    '/repo/sharedos-repo',
  );
  // resolveSharedOsCommitV1 reads git metadata directly (loose ref via HEAD).
  const checkout = await buildSharedOsFixture(t, PACT_SHAREDOS_COMMIT_V1);
  assert.equal(await resolveSharedOsCommitV1(checkout), PACT_SHAREDOS_COMMIT_V1);
});

test('scripted task packages stay strictly no-network with SharedOS provenance', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-scripted-net-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = scriptedConfig(['PAIR-Q1']);
  assert.equal(pactHarborScriptedModelV1(config.model), true);

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory,
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks: tasksFor(['PAIR-Q1']),
  });

  const taskToml = await readFile(join(temporary, 'pair-q1', 'task.toml'), 'utf8');
  assert.match(taskToml, /allow_internet = false/);
  assert.match(taskToml, /network_policy = "no-network"/);
  assert.match(taskToml, /allowed_egress = ""/);
  assert.match(
    taskToml,
    new RegExp(`sharedos_commit = "${PACT_SHAREDOS_COMMIT_V1}"`),
  );
  // No env section at all: scripted trials need no credential and no model
  // configuration, and must not depend on any host environment variable.
  assert.doesNotMatch(taskToml, /\[environment\.env\]/);
  assert.doesNotMatch(taskToml, /PACT_MODEL_API_KEY =/);
  // Harbor 0.5.0 ignores the legacy network_mode key; it must never re-enter.
  assert.doesNotMatch(taskToml, /network_mode/);
  assert.doesNotMatch(taskToml, /\{\{[A-Z_]+\}\}/);
});

test('real-model task packages narrow egress to the configured endpoint host', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-model-net-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = azureConfig(['PAIR-Q1']);
  assert.equal(pactHarborScriptedModelV1(config.model), false);
  assert.equal(
    pactHarborAllowedEgressV1(config.model),
    'https://hanxiang-resource.openai.azure.com:443',
  );

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory,
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks: tasksFor(['PAIR-Q1']),
  });

  const taskToml = await readFile(join(temporary, 'pair-q1', 'task.toml'), 'utf8');
  assert.match(taskToml, /allow_internet = true/);
  assert.match(taskToml, /network_policy = "model-endpoint-only"/);
  // The allowed host comes from the run config's model endpoint, not from any
  // hardcoded provider list.
  assert.match(
    taskToml,
    /allowed_egress = "https:\/\/hanxiang-resource\.openai\.azure\.com:443"/,
  );
  // Non-secret model configuration travels in the package; the credential is
  // only ever the ${...} template Harbor resolves from the HOST at runtime.
  assert.match(taskToml, /\[environment\.env\]/);
  assert.match(taskToml, /PACT_MODEL_CONFIG_JSON = ".*hanxiang-deployment.*"/);
  assert.match(taskToml, /PACT_MODEL_API_KEY = "\$\{PACT_MODEL_API_KEY\}"/);
  assert.doesNotMatch(taskToml, /network_mode/);
  assert.doesNotMatch(taskToml, /\{\{[A-Z_]+\}\}/);
});

test('rejects real-model endpoints outside the HTTPS-443 egress contract', () => {
  const loopback = pactRunConfigV1Schema.parse({
    ...baseConfig(['PAIR-Q1']),
    model: {
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:8080/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'local-proxy',
    },
  });
  assert.throws(
    () => pactHarborAllowedEgressV1(loopback.model),
    /only permit HTTPS egress/,
  );

  const oddPort = pactRunConfigV1Schema.parse({
    ...baseConfig(['PAIR-Q1']),
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://gateway.example.com:8443/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'gateway-model',
    },
  });
  assert.throws(
    () => pactHarborAllowedEgressV1(oddPort.model),
    /only permit egress on port 443/,
  );
});

test('the secret never enters any generated task-package file', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-secret-'));
  const sentinel = 'pact-test-secret-3c1f9d2e-value-never-in-package';
  const previous = process.env.PACT_MODEL_API_KEY;
  process.env.PACT_MODEL_API_KEY = sentinel;
  t.after(async () => {
    if (previous === undefined) delete process.env.PACT_MODEL_API_KEY;
    else process.env.PACT_MODEL_API_KEY = previous;
    await rm(temporary, { recursive: true, force: true });
  });

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory,
    imageName: PACT_HARBOR_IMAGE_V1,
    config: azureConfig(['PAIR-Q1', 'PAIR-A1']),
    tasks: tasksFor(['PAIR-Q1', 'PAIR-A1']),
  });

  const files = await collectFiles(temporary);
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.equal(
      content.includes(sentinel),
      false,
      `secret value leaked into ${file}`,
    );
    // Every mention of the credential alias is either its env-alias name in
    // the model config JSON or the host-resolved runtime template — never a
    // value assignment.
    for (const line of content.split('\n')) {
      if (!line.includes('PACT_MODEL_API_KEY =')) continue;
      assert.equal(
        line.trim(),
        'PACT_MODEL_API_KEY = "${PACT_MODEL_API_KEY}"',
        `unexpected credential assignment in ${file}: ${line}`,
      );
    }
  }
});

async function collectFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(entryPath));
    else if (entry.isFile()) found.push(entryPath);
  }
  return found;
}

async function buildSharedOsFixture(
  t: { after(fn: () => unknown): void },
  commit: string,
): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-sharedos-fixture-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const checkout = join(temporary, 'sharedos-repo');
  for (const name of SHAREDOS_FIXTURE_PACKAGES) {
    const packageDirectory = join(checkout, 'packages', name);
    await mkdir(join(packageDirectory, 'dist'), { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({
        name: `@sharedos/${name}`,
        version: '0.1.0',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(packageDirectory, 'dist', 'index.js'),
      `export const packageName = '@sharedos/${name}';\n`,
      'utf8',
    );
    await writeFile(
      join(packageDirectory, 'dist', 'index.test.js'),
      'import "vitest";\n',
      'utf8',
    );
  }
  const zodDirectory = join(checkout, 'packages', 'contracts', 'node_modules', 'zod');
  await mkdir(zodDirectory, { recursive: true });
  await writeFile(
    join(zodDirectory, 'package.json'),
    `${JSON.stringify({ name: 'zod', version: '3.25.76', main: 'index.js' })}\n`,
    'utf8',
  );
  await writeFile(join(zodDirectory, 'index.js'), 'module.exports = {};\n', 'utf8');
  await mkdir(join(checkout, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await writeFile(join(checkout, '.git', 'refs', 'heads', 'main'), `${commit}\n`, 'utf8');
  return checkout;
}

function tasksFor(ids: string[]) {
  return loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids,
  });
}

function baseConfig(ids: string[]) {
  return {
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
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 30_000 },
    output: { directory: 'runs', saveTraces: true },
  };
}

function scriptedConfig(ids: string[]) {
  return pactRunConfigV1Schema.parse(baseConfig(ids));
}

function azureConfig(ids: string[]) {
  return pactRunConfigV1Schema.parse({
    ...baseConfig(ids),
    model: {
      provider: 'azure-openai',
      endpoint: 'https://hanxiang-resource.openai.azure.com/openai/v1',
      deployment: 'hanxiang-deployment',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      maxOutputTokens: 4096,
    },
  });
}

test('real-model task packages carry the selected execution adapter and the container honors it', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-harbor-adapter-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = pactRunConfigV1Schema.parse({
    ...JSON.parse(JSON.stringify(azureConfig(['PAIR-Q1']))),
    benchmark: {
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids: ['PAIR-Q1'] },
      execution: { adapter: 'sharedos-embedded' },
    },
  });

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory,
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks: tasksFor(['PAIR-Q1']),
  });

  const taskToml = await readFile(join(temporary, 'pair-q1', 'task.toml'), 'utf8');
  assert.match(taskToml, /PACT_EXECUTION_ADAPTER = "sharedos-embedded"/);

  // The container entrypoint rebuilds the exact run configuration from the
  // injected literals: real model, selected adapter, same strict schema.
  const { buildPactContainerRunConfigV1 } = await import(
    '../../src/runner/v1/container-entrypoint.js'
  );
  const containerConfig = buildPactContainerRunConfigV1({
    taskId: 'PAIR-Q1',
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    maxTurns: 4,
    maxToolCalls: 2,
    maxRuntimeMs: 30_000,
    outputDirectoryName: 'pact-output',
    modelConfig: JSON.parse(JSON.stringify(config.model)),
    executionAdapter: 'sharedos-embedded',
  });
  assert.equal(containerConfig.model.provider, 'azure-openai');
  assert.equal(containerConfig.benchmark.execution?.adapter, 'sharedos-embedded');

  // Scripted packages keep the public-runner default and no env section.
  const scriptedContainerConfig = buildPactContainerRunConfigV1({
    taskId: 'PAIR-Q1',
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    maxTurns: 4,
    maxToolCalls: 2,
    maxRuntimeMs: 30_000,
    outputDirectoryName: 'pact-output',
  });
  assert.equal(scriptedContainerConfig.model.provider, 'openai-compatible');
  assert.equal('execution' in scriptedContainerConfig.benchmark, false);
});
