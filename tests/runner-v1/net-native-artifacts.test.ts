import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveNativeNetConfig } from '../../src/runner/net/config.js';
import { withNativeNetArtifacts } from '../../src/runner/net/artifacts.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'net-artifacts-'));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ version: 'pact-net-native-run/v1', runId: 'artifact-regression', outputDirectory: 'run',
    provider: { type: 'scripted-procurement/v1' }, execution: { kind: 'p01-pilot', mode: 'success' } }));
  return { config: await resolveNativeNetConfig(path), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('post-hoc command ownership excludes a direct native adapter writer for its entire operation', async () => {
  const f = await fixture();
  try {
    await withNativeNetArtifacts(f.config, true, async () => undefined);
    const path = join(f.config.directory, 'writer.lock');
    await withNativeNetArtifacts(f.config, false, async () => {
      let writer: Awaited<ReturnType<typeof open>> | undefined;
      try { await assert.rejects(async () => { writer = await open(path, 'wx'); }, { code: 'EEXIST' }); }
      finally { if (writer) { await writer.close(); await unlink(path); } }
    });
    const writer = await open(path, 'wx'); // Ownership was released after scoring.
    await writer.close(); await unlink(path);
  } finally { await f.cleanup(); }
});

test('initial manifest publication holds native writer ownership against a direct adapter', async context => {
  const f = await fixture();
  const originalOpen = fs.open;
  const writerPath = join(f.config.directory, 'writer.lock');
  let publicationChecked = false;
  const patchedOpen = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (!publicationChecked && String(args[0]).startsWith(join(f.config.directory, '.stage-'))) {
      publicationChecked = true;
      let competingWriter: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        await assert.rejects(async () => { competingWriter = await originalOpen(writerPath, 'wx'); }, { code: 'EEXIST' });
      } finally {
        if (competingWriter) { await competingWriter.close(); await unlink(writerPath); }
      }
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await withNativeNetArtifacts(f.config, true, async () => {
      assert.equal(publicationChecked, true);
      assert.equal(JSON.parse(await readFile(join(f.config.directory, 'run-manifest.json'), 'utf8')).runId, f.config.runId);
      // The bootstrap token is handed off before the real native session opens.
      const nativeWriter = await open(writerPath, 'wx');
      await nativeWriter.close(); await unlink(writerPath);
    });
  } finally {
    patchedOpen.mock.restore();
    syncBuiltinESMExports();
    await f.cleanup();
  }
});

test('a different run configuration cannot replace an existing command manifest', async () => {
  const f = await fixture();
  try {
    await withNativeNetArtifacts(f.config, true, async () => undefined);
    const path = join(f.config.directory, 'run-manifest.json');
    const before = await readFile(path, 'utf8');
    await assert.rejects(() => withNativeNetArtifacts({ ...f.config, runId: 'different-run', configDigest: 'changed' }, true, async () => undefined), /run_binding_mismatch/);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('the unified command does not silently adopt a legacy or orphaned execution directory', async () => {
  const f = await fixture();
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(f.config.directory);
    await writeFile(join(f.config.directory, 'checkpoint.json'), '{}');
    await assert.rejects(() => withNativeNetArtifacts(f.config, true, async () => undefined), /run_manifest_missing/);
    await assert.rejects(() => readFile(join(f.config.directory, 'run-manifest.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.config.directory, 'checkpoint.json'), 'utf8'), '{}');
  } finally { await f.cleanup(); }
});
