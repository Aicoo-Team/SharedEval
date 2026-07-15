import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { validatePactSubmissionBundleV1 } from '../../src/submission/v1/index.js';
import { MAX_PACT_MANIFEST_BYTES_V1 } from '../../src/protocol/v1/index.js';
import { validManifestV1 } from './fixtures.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sampleManifestPath = 'examples/submissions/typescript-basic/pact.yaml';

test('validates every referenced file in the canonical sample bundle', async () => {
  const bundle = await validatePactSubmissionBundleV1({
    rootDir: repoRoot,
    manifestPath: sampleManifestPath,
  });
  assert.equal(bundle.manifest.id, 'typescript-basic');
  assert.equal(bundle.manifest.runtime.kind, 'docker');
  assert.equal(bundle.runtime.kind, 'docker');
  if (bundle.runtime.kind === 'docker') {
    assert.ok(isAbsolute(bundle.runtime.contextPath));
    assert.ok(isAbsolute(bundle.runtime.dockerfilePath));
  }
});

test('rejects missing entrypoints and directories masquerading as files', async () => {
  await withTemporaryBundle(async rootDir => {
    await writeManifest(rootDir, 'missing.ts');
    await assert.rejects(
      validatePactSubmissionBundleV1({ rootDir, manifestPath: 'pact.yaml' }),
      /does not exist/,
    );

    await mkdir(join(rootDir, 'src'));
    await writeManifest(rootDir, 'src');
    await assert.rejects(
      validatePactSubmissionBundleV1({ rootDir, manifestPath: 'pact.yaml' }),
      /must be a regular file/,
    );
  });
});

test('rejects symlinks that resolve outside the submission root', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'pact-bundle-symlink-'));
  const bundleRoot = join(temporaryRoot, 'bundle');
  const outsideEntrypoint = join(temporaryRoot, 'outside.ts');
  try {
    await mkdir(join(bundleRoot, 'src'), { recursive: true });
    await writeFile(outsideEntrypoint, 'export {}\n');
    await symlink(outsideEntrypoint, join(bundleRoot, 'src', 'adapter.ts'));
    await writeManifest(bundleRoot, 'src/adapter.ts');

    await assert.rejects(
      validatePactSubmissionBundleV1({ rootDir: bundleRoot, manifestPath: 'pact.yaml' }),
      /resolves outside the submission root/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('requires a Dockerfile to live inside its declared build context', async () => {
  await withTemporaryBundle(async rootDir => {
    await mkdir(join(rootDir, 'context'));
    await writeFile(join(rootDir, 'Dockerfile'), 'FROM scratch\n');
    await writeFile(
      join(rootDir, 'pact.yaml'),
      stringify({
        ...validManifestV1,
        runtime: {
          kind: 'docker',
          protocol: 'jsonrpc-stdio/v1',
          source: { kind: 'build', context: 'context', dockerfile: 'Dockerfile' },
          network: 'disabled',
        },
      }),
    );

    await assert.rejects(
      validatePactSubmissionBundleV1({ rootDir, manifestPath: 'pact.yaml' }),
      /Dockerfile must be inside the build context/,
    );
  });
});

test('rejects local TypeScript entrypoints under the official runtime policy', async () => {
  await withTemporaryBundle(async rootDir => {
    await writeFile(join(rootDir, 'adapter.ts'), 'export {}\n');
    await writeManifest(rootDir, 'adapter.ts');

    const developmentBundle = await validatePactSubmissionBundleV1({
      rootDir,
      manifestPath: 'pact.yaml',
    });
    assert.equal(developmentBundle.runtime.kind, 'local-ts');
    if (developmentBundle.runtime.kind === 'local-ts') {
      assert.ok(isAbsolute(developmentBundle.runtime.entrypointPath));
    }

    await assert.rejects(
      validatePactSubmissionBundleV1({
        rootDir,
        manifestPath: 'pact.yaml',
        runtimePolicy: 'official',
      }),
      /official submissions must use the isolated Docker runtime/,
    );
  });
});

test('allows in-root paths whose names begin with two dots', async () => {
  await withTemporaryBundle(async rootDir => {
    await writeFile(join(rootDir, '..adapter.ts'), 'export {}\n');
    await writeManifest(rootDir, '..adapter.ts');

    const bundle = await validatePactSubmissionBundleV1({
      rootDir,
      manifestPath: 'pact.yaml',
    });
    assert.equal(bundle.runtime.kind, 'local-ts');
    if (bundle.runtime.kind === 'local-ts') {
      assert.equal(bundle.runtime.entrypointPath, await realpath(join(rootDir, '..adapter.ts')));
    }
  });
});

test('rejects an oversized manifest before reading its contents', async () => {
  await withTemporaryBundle(async rootDir => {
    const manifestPath = join(rootDir, 'pact.yaml');
    await writeFile(manifestPath, 'x');
    await truncate(manifestPath, MAX_PACT_MANIFEST_BYTES_V1 + 1);

    await assert.rejects(
      validatePactSubmissionBundleV1({ rootDir, manifestPath: 'pact.yaml' }),
      new RegExp(`exceeds ${MAX_PACT_MANIFEST_BYTES_V1} bytes`),
    );
  });
});

async function writeManifest(rootDir: string, entrypoint: string): Promise<void> {
  await writeFile(
    join(rootDir, 'pact.yaml'),
    stringify({
      ...validManifestV1,
      runtime: { kind: 'local-ts', entrypoint },
    }),
  );
}

async function withTemporaryBundle(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'pact-bundle-'));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}
