import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PACT_HARBOR_IMAGE_V1 } from '../../src/runner/v1/backends/harbor-backend.js';
import {
  PACT_SHAREDOS_COMMIT_V1,
  PACT_SHAREDOS_RUNTIME_DIGEST_V1,
} from '../../src/runner/v1/backends/harbor-sharedos.js';
import {
  materializeHarborDatasetV1,
  pactHarborTemplateDirectoryV1,
} from '../../src/runner/v1/backends/harbor-task-package.js';
import { pactRunConfigV1Schema } from '../../src/runner/v1/config.js';
import { loadPactPairTasksV1 } from '../../src/runner/v1/task-loader.js';
import { PACT_PAIR_HARBOR_DATASET_RUNTIME_V1 } from '../../src/suites/pact-pair/harbor.js';
import { PACT_NET_HARBOR_DATASET_RUNTIME_V1 } from '../../src/suites/pact-net/harbor.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Byte-level PACT-Pair non-regression guard for the dataset-runtime
 * parameterization: the scripted PAIR-Q1 package must be exactly these bytes
 * — the same output the packager produced before task-id patterns, template
 * paths, and entrypoint tokens moved into dataset runtimes.
 */
const EXPECTED_PAIR_Q1_SOLVE_SH = `#!/usr/bin/env bash
set -euo pipefail

node /opt/pact/dist/src/runner/v1/container-entrypoint.js \\
  --task-id "PAIR-Q1" \\
  --output-directory /app/pact-output \\
  --policy "D2" \\
  --requester "R1" \\
  --grading-mode "category" \\
  --max-turns "4" \\
  --max-tool-calls "2" \\
  --max-runtime-ms "30000"
`;

const EXPECTED_PAIR_Q1_TASK_TOML = `schema_version = "1.3"

[task]
name = "pact/pair-pair-q1"
description = "Run one deterministic PACT-Pair backend-parity trial."
authors = [{ name = "PACT-Bench maintainers" }]
keywords = ["privacy", "delegation", "pact-pair", "backend-parity"]

[metadata]
pact_task_id = "PAIR-Q1"
category = "agent-privacy"
# SharedOS build provenance: the image carries prebuilt packages/*/dist from
# this commit and exact runtime digest (COPY'd at image build; never cloned or
# built in-container).
sharedos_commit = "${PACT_SHAREDOS_COMMIT_V1}"
sharedos_runtime_digest = "${PACT_SHAREDOS_RUNTIME_DIGEST_V1}"
# O-003 decision 2 (network): "no-network" for scripted parity trials;
# "model-endpoint-only" for real-model trials, where the run narrows egress to
# the configured model endpoint host over HTTPS 443 — recorded in
# allowed_egress, derived from the run config, never hardcoded. Harbor 0.5.0
# enforces the coarse gate below via allow_internet; the PACT harness pins all
# provider traffic to the configured endpoint (its URL validator is not
# relaxed for containers).
network_policy = "no-network"
allowed_egress = ""

[agent]
timeout_sec = 60
user = "root"

[verifier]
timeout_sec = 60.0
user = "root"

[environment]
docker_image = "pact-bench-harbor:p0-pair-q1"
# Harbor v0.5.0 network isolation: the Docker environment disables networking
# only when \`allow_internet\` is false (unknown keys are silently ignored).
# scripts/verify_harbor.sh runs a denied-egress probe against this contract.
# Scripted parity trials always materialize \`false\`; real-model trials
# materialize \`true\` under the model-endpoint-only policy recorded in
# [metadata] above (O-003 decision 2).
allow_internet = false
build_timeout_sec = 600.0
cpus = 1
memory_mb = 1024
storage_mb = 2048

`;

test('pair packages are byte-identical through the dataset-runtime mechanism', async t => {
  const defaultDirectory = await mkdtemp(join(tmpdir(), 'pact-pair-bytes-default-'));
  const explicitDirectory = await mkdtemp(join(tmpdir(), 'pact-pair-bytes-explicit-'));
  t.after(async () => {
    await rm(defaultDirectory, { recursive: true, force: true });
    await rm(explicitDirectory, { recursive: true, force: true });
  });
  const config = scriptedPairConfig(['PAIR-Q1']);
  const tasks = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids: ['PAIR-Q1'],
  });

  // Omitting the runtime selects the built-in pair runtime.
  await materializeHarborDatasetV1({
    datasetDirectory: defaultDirectory,
    templateDirectory: join(repositoryRoot, 'harbor', 'task-template'),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks,
  });
  await materializeHarborDatasetV1({
    datasetDirectory: explicitDirectory,
    templateDirectory: pactHarborTemplateDirectoryV1(
      repositoryRoot,
      PACT_PAIR_HARBOR_DATASET_RUNTIME_V1,
    ),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks,
    runtime: PACT_PAIR_HARBOR_DATASET_RUNTIME_V1,
  });

  // The load-bearing package files are exactly the pre-parameterization bytes.
  assert.equal(
    await readFile(join(defaultDirectory, 'pair-q1', 'solution', 'solve.sh'), 'utf8'),
    EXPECTED_PAIR_Q1_SOLVE_SH,
  );
  assert.equal(
    await readFile(join(defaultDirectory, 'pair-q1', 'task.toml'), 'utf8'),
    EXPECTED_PAIR_Q1_TASK_TOML,
  );

  // And the default-runtime package equals the explicit-pair-runtime package
  // file for file: one mechanism, no drift.
  const files = await collectRelativeFiles(defaultDirectory);
  assert.ok(files.length >= 5);
  assert.deepEqual(files, await collectRelativeFiles(explicitDirectory));
  for (const file of files) {
    assert.equal(
      await readFile(join(defaultDirectory, file), 'utf8'),
      await readFile(join(explicitDirectory, file), 'utf8'),
      `pair package file drifted between default and explicit runtime: ${file}`,
    );
  }
});

test('net scripted task packages are parameterized, no-network, and entrypoint-complete', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-net-package-scripted-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = scriptedNetConfig(['NET-Q-0001', 'NET-A-0001']);

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory: pactHarborTemplateDirectoryV1(
      repositoryRoot,
      PACT_NET_HARBOR_DATASET_RUNTIME_V1,
    ),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks: [{ taskId: 'NET-Q-0001' }, { taskId: 'NET-A-0001' }],
    runtime: PACT_NET_HARBOR_DATASET_RUNTIME_V1,
  });

  for (const taskId of ['NET-Q-0001', 'NET-A-0001']) {
    const slug = taskId.toLocaleLowerCase('en-US');
    const taskToml = await readFile(join(temporary, slug, 'task.toml'), 'utf8');
    const solution = await readFile(
      join(temporary, slug, 'solution', 'solve.sh'),
      'utf8',
    );
    // Dataset identity and per-task image tag flow from the net runtime.
    assert.match(taskToml, new RegExp(`name = "pact/net-${slug}"`));
    assert.match(taskToml, new RegExp(`pact_task_id = "${taskId}"`));
    assert.match(
      taskToml,
      new RegExp(`docker_image = "pact-bench-harbor:p0-${slug}"`),
    );
    // Scripted `.invalid` endpoint: strictly no-network, no env section.
    assert.match(taskToml, /allow_internet = false/);
    assert.match(taskToml, /network_policy = "no-network"/);
    assert.match(taskToml, /allowed_egress = ""/);
    assert.doesNotMatch(taskToml, /\[environment\.env\]/);
    assert.doesNotMatch(taskToml, /network_mode/);
    // The entrypoint invocation carries the dataset id and Net's argument
    // surface: policy and budgets, never pair's requester/grading-mode.
    assert.match(solution, /--dataset "pact-net"/);
    assert.match(solution, new RegExp(`--task-id "${taskId}"`));
    assert.match(solution, /--policy "D2"/);
    assert.match(solution, /--max-turns "4"/);
    assert.match(solution, /--max-tool-calls "2"/);
    assert.match(solution, /--max-runtime-ms "30000"/);
    assert.doesNotMatch(solution, /--requester/);
    assert.doesNotMatch(solution, /--grading-mode/);
    assert.doesNotMatch(`${taskToml}${solution}`, /\{\{[A-Z_]+\}\}/);
  }
});

test('net real-model task packages narrow egress and carry the adapter provenance', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-net-package-model-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = pactRunConfigV1Schema.parse({
    ...baseNetConfig(['NET-Q-0001']),
    model: {
      provider: 'azure-openai',
      endpoint: 'https://hanxiang-resource.openai.azure.com/openai/v1',
      deployment: 'hanxiang-deployment',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      maxOutputTokens: 4096,
    },
    benchmark: {
      dataset: 'pact-net',
      policy: 'D2',
      tasks: { kind: 'all', ids: ['NET-Q-0001'] },
      execution: { adapter: 'sharedos-embedded' },
    },
  });

  await materializeHarborDatasetV1({
    datasetDirectory: temporary,
    templateDirectory: pactHarborTemplateDirectoryV1(
      repositoryRoot,
      PACT_NET_HARBOR_DATASET_RUNTIME_V1,
    ),
    imageName: PACT_HARBOR_IMAGE_V1,
    config,
    tasks: [{ taskId: 'NET-Q-0001' }],
    runtime: PACT_NET_HARBOR_DATASET_RUNTIME_V1,
  });

  const taskToml = await readFile(join(temporary, 'net-q-0001', 'task.toml'), 'utf8');
  assert.match(taskToml, /allow_internet = true/);
  assert.match(taskToml, /network_policy = "model-endpoint-only"/);
  assert.match(
    taskToml,
    /allowed_egress = "https:\/\/hanxiang-resource\.openai\.azure\.com:443"/,
  );
  assert.match(taskToml, /\[environment\.env\]/);
  assert.match(taskToml, /PACT_MODEL_CONFIG_JSON = ".*hanxiang-deployment.*"/);
  assert.match(taskToml, /PACT_EXECUTION_ADAPTER = "sharedos-embedded"/);
  assert.match(taskToml, /PACT_MODEL_API_KEY = "\$\{PACT_MODEL_API_KEY\}"/);
  assert.doesNotMatch(taskToml, /\{\{[A-Z_]+\}\}/);
});

test('materialization fails closed on task ids outside the dataset runtime pattern', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pact-net-package-badid-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  // A pair id can never be packaged under the net runtime (and vice versa).
  await assert.rejects(
    materializeHarborDatasetV1({
      datasetDirectory: temporary,
      templateDirectory: pactHarborTemplateDirectoryV1(
        repositoryRoot,
        PACT_NET_HARBOR_DATASET_RUNTIME_V1,
      ),
      imageName: PACT_HARBOR_IMAGE_V1,
      config: scriptedNetConfig(['NET-Q-0001']),
      tasks: [{ taskId: 'PAIR-Q1' }],
      runtime: PACT_NET_HARBOR_DATASET_RUNTIME_V1,
    }),
    /does not match the pact-net Harbor task-id pattern/,
  );
  await assert.rejects(
    materializeHarborDatasetV1({
      datasetDirectory: temporary,
      templateDirectory: join(repositoryRoot, 'harbor', 'task-template'),
      imageName: PACT_HARBOR_IMAGE_V1,
      config: scriptedPairConfig(['PAIR-Q1']),
      tasks: [{ taskId: 'NET-Q-0001' }],
    }),
    /does not match the pact-pair Harbor task-id pattern/,
  );
});

test('net dataset runtime accepts only canonical NET ids', () => {
  const pattern = PACT_NET_HARBOR_DATASET_RUNTIME_V1.taskIdPattern;
  assert.equal(pattern.test('NET-Q-0001'), true);
  assert.equal(pattern.test('NET-A-0014'), true);
  assert.equal(pattern.test('PAIR-Q1'), false);
  assert.equal(pattern.test('NET-Q-1'), false);
  assert.equal(pattern.test('net-q-0001'), false);
  assert.equal(PACT_PAIR_HARBOR_DATASET_RUNTIME_V1.taskIdPattern.test('NET-Q-0001'), false);
});

async function collectRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await collectRelativeFiles(root, relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort((left, right) => left.localeCompare(right));
}

function baseNetConfig(ids: string[]) {
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
      dataset: 'pact-net',
      policy: 'D2',
      tasks: { kind: 'all', ids },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 30_000 },
    output: { directory: 'runs', saveTraces: true },
  };
}

function scriptedNetConfig(ids: string[]) {
  return pactRunConfigV1Schema.parse(baseNetConfig(ids));
}

function scriptedPairConfig(ids: string[]) {
  return pactRunConfigV1Schema.parse({
    ...baseNetConfig(ids),
    benchmark: {
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids },
    },
  });
}
