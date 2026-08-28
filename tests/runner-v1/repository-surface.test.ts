import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const retiredRoots = [
  'examples',
  'harbor',
  'rebuttal',
  'src/adapter-host',
  'src/protocol',
  'src/runner/v1/backends',
  'src/submission',
  'src/suites/pact-pair/legacy-transcript',
  'tests/golden',
  'tests/protocol-v1',
] as const;

const retiredFiles = [
  '.dockerignore',
  'dataset/pact-pair/heartbeat_experiment.md',
  'dataset/pact-pair/tasks/gold_answers_legacy.json',
  'dataset/pact-pair/tasks/gold_answers_legacy.md',
  'src/schemas.ts',
  'tsconfig.harbor.json',
] as const;

test('retired execution surfaces and historical artifacts are absent', () => {
  for (const relativePath of retiredRoots) {
    assert.deepEqual(filesUnder(relativePath), [], relativePath);
  }
  for (const relativePath of retiredFiles) {
    assert.equal(existsSync(join(repoRoot, relativePath)), false, relativePath);
  }
});

test('scripts contain only the supported exporter and experiment launchers', () => {
  assert.deepEqual(readdirSync(join(repoRoot, 'scripts')).sort(), [
    'README.md',
    'experiments',
    'huggingface',
  ]);
  assert.deepEqual(readdirSync(join(repoRoot, 'scripts', 'huggingface')).sort(), [
    'README.md',
    'export-pact-pair.mjs',
  ]);
  assert.deepEqual(readdirSync(join(repoRoot, 'scripts', 'experiments')).sort(), [
    'build-image.sh',
    'egress-probe.mjs',
    'egress-probe.sh',
    'run-cell-lib.mjs',
    'run-cell.sh',
    'stage-sharedos-provenance.ts',
  ]);
});

test('package and public docs expose only the retained product surface', () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), [
    'eval:pact-pair',
    'export:huggingface:pact-pair',
    'sharedeval',
    'smoke:pact-net',
    'smoke:pact-pair',
    'test',
    'test:evaluation',
    'test:execution',
    'test:experiments',
    'test:sharedos',
    'type-check',
    'validate',
  ]);

  const publicFiles = [
    '.github/workflows/ci.yml',
    'README.md',
    'dataset/pact-pair/BENCHMARK_DATA.md',
    'docs/architecture.md',
    'docs/datasets.md',
    'docs/running.md',
    'package.json',
    'scripts/README.md',
  ] as const;
  const retiredReference = /rebuttal|harbor|submission|pact-run\/v1|pact-run\.|public runner|getPactPolicySha256V1|runner-loading|sharedos-embedded|legacy-(?:prompt|transcript)/i;
  for (const relativePath of publicFiles) {
    assert.doesNotMatch(
      readFileSync(join(repoRoot, relativePath), 'utf8'),
      retiredReference,
      relativePath,
    );
  }

  const policyRegistry = 'dataset/pact-pair/policies/EXPERIMENT_POLICIES.md';
  assert.doesNotMatch(
    readFileSync(join(repoRoot, policyRegistry), 'utf8'),
    /rebuttal|public runner|getPactPolicySha256V1|runner-loading/i,
    policyRegistry,
  );
});

test('retained configuration and source do not name deleted code or retry APIs', () => {
  const tsconfig = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8');
  assert.doesNotMatch(tsconfig, /examples\/submissions/);

  const matching = readFileSync(
    join(repoRoot, 'src/suites/pact-pair/evaluation-tools/v1/matching.ts'),
    'utf8',
  );
  assert.doesNotMatch(matching, /src\/runner\/v1\/evaluator\.ts/);

  const providerClient = readFileSync(
    join(repoRoot, 'src/runner/v1/openai-compatible-client.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    providerClient,
    /openAICompatibleProvider(?:RetryDelayMs|DefaultRetryDelayMs|Retry)V1/,
  );
  assert.doesNotMatch(providerClient, /\btranscript\b|harness protocols?/i);

  for (const relativePath of [
    'tests/runner-v1/file-workflow-test-fixtures.ts',
    'tests/runner-v1/file-workflow-artifacts.test.ts',
  ]) {
    assert.doesNotMatch(
      readFileSync(join(repoRoot, relativePath), 'utf8'),
      /pact-public-runner|scripted-harness/,
      relativePath,
    );
  }
});

function filesUnder(relativePath: string): string[] {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const child = join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else files.push(child);
  }
  return files.sort();
}
