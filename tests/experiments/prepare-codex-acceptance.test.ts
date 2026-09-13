import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { acceptanceConfig, FROZEN_SOURCE, PREFLIGHT_IDS, prepareAcceptance, SPLIT_IDS, SPLIT_PATH, QUESTIONS_PATH } from '../../scripts/experiments/prepare-pair-acceptance.js';
import { codexAcceptanceConfig, prepareCodexAcceptance } from '../../scripts/experiments/prepare-codex-acceptance.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('Codex changes only model transport identity and routing for the frozen split and preflight', () => {
  for (const [ids, preflight] of [[PREFLIGHT_IDS, true], [SPLIT_IDS, false]] as const) {
    const baseline = acceptanceConfig(ids, preflight);
    const before = structuredClone(baseline);
    const native = codexAcceptanceConfig(ids, preflight);
    assert.ok(baseline.model.provider === 'openai-compatible');
    const { providerRouting: _routing, ...model } = baseline.model;
    assert.deepEqual(native, { ...baseline, model: { ...model,
      provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-5.5',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY' } });
    assert.deepEqual(baseline, before);
    assert.equal(native.model.temperature, 0);
    assert.equal(native.model.maxOutputTokens, 4096);
    assert.equal('providerRouting' in native.model, false);
  }
});

test('native preparation hashes independent immutable artifacts and records enforcement boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pair-prepare-'));
  try {
    await prepareAcceptance(directory);
    const originals = await Promise.all((await readdir(directory)).map(async name => ({
      name, bytes: await readFile(join(directory, name), 'utf8'),
      mtime: (await stat(join(directory, name))).mtimeMs,
    })));
    const prepared = await prepareCodexAcceptance(directory);
    assert.equal(prepared.manifest.sourceRevision, FROZEN_SOURCE);
    assert.deepEqual(prepared.manifest.selectedTaskIds, SPLIT_IDS);
    assert.deepEqual(prepared.manifest.preflightTaskIds, PREFLIGHT_IDS);
    assert.equal(prepared.manifest.selectedIdsSha256, sha256(JSON.stringify(SPLIT_IDS)));
    assert.equal(prepared.manifest.frozenSplitManifest.sha256,
      sha256(await readFile(join(directory, 'pair-split-02.manifest.json'), 'utf8')));
    assert.equal(prepared.manifest.nativeBridge.status, 'experimental');
    assert.equal(prepared.manifest.nativeBridge.outputTokenLimitEnforced, false);
    assert.equal(prepared.manifest.nativeBridge.temperatureEnforcement, 'not-guaranteed');
    assert.equal(prepared.manifest.nativeBridge.dummyEnvironment.SHAREDEVAL_MODEL_API_KEY,
      'native-codex-no-http-key');
    for (const [name, hash] of Object.entries(prepared.manifest.configurationSha256)) {
      const bytes = await readFile(join(directory, name), 'utf8');
      assert.equal(sha256(bytes), hash);
      assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
      const preflight = name.includes('preflight');
      assert.deepEqual(parse(bytes), codexAcceptanceConfig(preflight ? PREFLIGHT_IDS : SPLIT_IDS, preflight));
    }
    const names = await readdir(directory);
    const mtimes = await Promise.all(names.map(async name => (await stat(join(directory, name))).mtimeMs));
    assert.deepEqual((await prepareCodexAcceptance(directory)).manifest, prepared.manifest);
    assert.deepEqual(await Promise.all(names.map(async name => (await stat(join(directory, name))).mtimeMs)), mtimes);
    for (const original of originals) {
      assert.equal(await readFile(join(directory, original.name), 'utf8'), original.bytes);
      assert.equal((await stat(join(directory, original.name))).mtimeMs, original.mtime);
    }
    const changed = join(directory, 'codex-pair-preflight.yaml');
    await writeFile(changed, 'existing artifact');
    await assert.rejects(prepareCodexAcceptance(directory), /Refusing to replace/);
    assert.equal(await readFile(changed, 'utf8'), 'existing artifact');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native preparation rejects changed baseline configuration before generating outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pair-baseline-'));
  try {
    await prepareAcceptance(directory);
    await writeFile(join(directory, 'deepseek-pair-60x300.yaml'), 'changed baseline');
    await assert.rejects(prepareCodexAcceptance(directory), /Frozen baseline configuration mismatch/);
    assert.equal((await readdir(directory)).some(name => name.startsWith('codex-')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native preparation rejects changed split manifest before generating outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pair-manifest-'));
  try {
    await prepareAcceptance(directory);
    const path = join(directory, 'pair-split-02.manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.selectedTaskIds.reverse();
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(prepareCodexAcceptance(directory), /Frozen split manifest mismatch/);
    assert.equal((await readdir(directory)).some(name => name.startsWith('codex-')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a shallow bare source and dirty shallow worktree preserve exact frozen preparation bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pair-shallow-source-'));
  const bare = join(directory, 'source.git');
  const working = join(directory, 'working');
  const runGit = (args: string[], cwd = directory) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    runGit(['init', '--bare', '--quiet', '--initial-branch=frozen', bare]);
    await assert.rejects(prepareAcceptance(join(directory, 'missing-output'), bare), {
      code: 'ACCEPTANCE_FROZEN_SOURCE_UNAVAILABLE',
    });
    // This is a local fetch, not a network/model call. Fetch only the pinned
    // object and its snapshot; a full repository history is not required.
    runGit(['fetch', '--quiet', '--no-tags', '--depth=1', resolve('.'),
      `${FROZEN_SOURCE}:refs/heads/frozen`], bare);
    assert.equal(runGit(['rev-parse', '--is-shallow-repository'], bare), 'true');
    const bareOutput = join(directory, 'bare-output');
    const fromBare = await prepareAcceptance(bareOutput, bare);
    runGit(['clone', '--quiet', '--no-checkout', '--depth=1', pathToFileURL(bare).href, working]);
    assert.equal(runGit(['rev-parse', '--is-shallow-repository'], working), 'true');
    assert.equal(runGit(['rev-parse', 'HEAD'], working), FROZEN_SOURCE);
    for (const path of [SPLIT_PATH, QUESTIONS_PATH]) {
      await mkdir(dirname(join(working, path)), { recursive: true });
      await writeFile(join(working, path), 'dirty working-tree bytes, not frozen JSON');
    }
    const dirtyOutput = join(directory, 'dirty-output');
    const fromDirty = await prepareAcceptance(dirtyOutput, working);
    assert.deepEqual(fromDirty.manifest, fromBare.manifest);
    const frozenHashes = {
      'deepseek-pair-preflight.yaml': '33158595b69eebe22989a033c8eef79d0c25368c261497cb38ba025ace8ea70d',
      'deepseek-pair-60x300.yaml': '1bf3373d6cbba410fcf60f557f16de422086e32f34f85895f59bbc5c2a8a3f59',
      'pair-split-02.manifest.json': '0b779e77bd51d212a61d5caf6c7da04e25255d6d4a9bf64391c3dbc8aa0eb3ef',
    };
    for (const [name, digest] of Object.entries(frozenHashes)) {
      assert.equal(sha256(await readFile(join(bareOutput, name), 'utf8')), digest);
      assert.equal(sha256(await readFile(join(dirtyOutput, name), 'utf8')), digest);
    }
    const nativeBare = await prepareCodexAcceptance(bareOutput);
    const nativeDirty = await prepareCodexAcceptance(dirtyOutput);
    assert.deepEqual(nativeDirty.manifest, nativeBare.manifest);
    for (const [name, digest] of Object.entries(nativeBare.manifest.configurationSha256)) {
      assert.equal(sha256(await readFile(join(dirtyOutput, name), 'utf8')), digest);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
