import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

test('the real repository validator accepts the shared-eval infrastructure registry', () => {
  const result = spawnSync(process.execPath, [tsxCli, 'src/validate.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  assert.equal(
    result.status,
    0,
    `validator stderr:\n${result.stderr}\nvalidator stdout:\n${result.stdout}`,
  );
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Dataset catalog validation passed \(2 manifests\)/);
});

test('the infrastructure exemption still rejects another unmanifested dataset directory', async () => {
  const { validateDatasetCatalogV1 } = await import(
    '../../src/datasets/validate-catalog.js'
  );
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-catalog-'));
  try {
    await mkdir(
      join(rootDir, 'dataset', 'shared-eval', 'workspaces', 'v1'),
      { recursive: true },
    );
    await writeFile(
      join(rootDir, 'dataset', 'shared-eval', 'workspaces', 'v1', 'registry.json'),
      '{}\n',
    );

    assert.equal(
      validateDatasetCatalogV1({ repoRoot: rootDir, log: () => undefined }).size,
      0,
    );

    await mkdir(join(rootDir, 'dataset', 'unmanifested-benchmark'));
    assert.throws(
      () => validateDatasetCatalogV1({ repoRoot: rootDir, log: () => undefined }),
      /unmanifested-benchmark.*missing manifest\.yaml/i,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('shared-eval is not exempt without its exact infrastructure marker', async () => {
  const { validateDatasetCatalogV1 } = await import(
    '../../src/datasets/validate-catalog.js'
  );
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-catalog-'));
  try {
    await mkdir(join(rootDir, 'dataset', 'shared-eval'), { recursive: true });
    assert.throws(
      () => validateDatasetCatalogV1({ repoRoot: rootDir, log: () => undefined }),
      /shared-eval.*missing manifest\.yaml/i,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
