import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { nativeNetConfigSchema, resolveNativeNetConfig } from '../../src/runner/net/config.js';

const config = { version: 'pact-net-native-run/v1', runId: 'native-regression', outputDirectory: './run',
  provider: { type: 'scripted-procurement/v1' }, execution: { kind: 'p01-pilot', mode: 'success' } };
test('native NET configuration exposes only implemented adapters and the explicit scripted provider', () => {
  assert.ok(nativeNetConfigSchema.safeParse(config).success);
  for (const value of [
    { ...config, provider: { type: 'openai' } },
    { ...config, provider: { ...config.provider, apiKey: 'should-not-be-read' } },
    { ...config, execution: { kind: 'general-net', taskIds: ['H-13'] } },
    { ...config, execution: { kind: 'p01-pilot', mode: 'assigned' } },
    { ...config, execution: { kind: 'assigned-pilot' } },
    { ...config, execution: { kind: 'procurement-world', profileFile: 'world.json', score: 'P-01' } },
    { ...config, tasks: ['P-01'] },
    { ...config, runId: '../outside' },
  ]) assert.equal(nativeNetConfigSchema.safeParse(value).success, false);
});

test('resolving a native NET config binds materialized content and creates no run directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-config-'));
  try {
    const path = join(directory, 'run.yaml');
    await writeFile(path, JSON.stringify(config));
    const first = await resolveNativeNetConfig(path);
    assert.equal(first.kind, 'p01-pilot');
    assert.equal(first.directory, join(directory, 'run'));
    assert.equal(existsSync(first.directory), false);
    await writeFile(path, JSON.stringify({ ...config, outputDirectory: './copied-run' }));
    assert.equal((await resolveNativeNetConfig(path)).configDigest, first.configDigest);
    await writeFile(path, JSON.stringify({ ...config, execution: { kind: 'p01-pilot', mode: 'safe-partial' } }));
    assert.notEqual((await resolveNativeNetConfig(path)).configDigest, first.configDigest);
    await writeFile(path, 'version: invalid\n');
    await assert.rejects(() => resolveNativeNetConfig(path), /native_net_config_invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('world profile file location is independent from its frozen execution contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-profile-config-'));
  try {
    const fixture = JSON.parse(await readFile(resolve(import.meta.dirname, '../suites/pact-net/fixtures/procurement-world-multi.json'), 'utf8'));
    await writeFile(join(directory, 'first.json'), JSON.stringify(fixture));
    await writeFile(join(directory, 'copy.json'), JSON.stringify(fixture));
    const path = join(directory, 'run.json');
    const input = { ...config, execution: { kind: 'procurement-world', profileFile: 'first.json' } };
    await writeFile(path, JSON.stringify(input));
    const first = await resolveNativeNetConfig(path);
    await writeFile(path, JSON.stringify({ ...input, execution: { ...input.execution, profileFile: 'copy.json' } }));
    assert.equal((await resolveNativeNetConfig(path)).configDigest, first.configDigest);
    fixture.publicState.readers = [];
    await writeFile(join(directory, 'copy.json'), JSON.stringify(fixture));
    assert.notEqual((await resolveNativeNetConfig(path)).configDigest, first.configDigest);
    assert.equal(existsSync(join(directory, 'run')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('NET JSON/YAML inspection rejects duplicate keys, extra documents, tags and aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-config-inspection-'));
  try {
    const path = join(directory, 'config.yaml');
    const valid = 'version: pact-net-native-run/v1\nrunId: native-regression\noutputDirectory: ./run\nprovider: { type: scripted-procurement/v1 }\nexecution: { kind: p01-pilot, mode: success }\n';
    await writeFile(path, valid);
    assert.equal((await resolveNativeNetConfig(path)).kind, 'p01-pilot');
    for (const invalid of [valid + 'runId: duplicate\n', valid + '---\n' + valid,
      valid.replace('./run', '&output ./run').replace('native-regression', '*output'),
      valid.replace('./run', '!!js/function function(){}'),
    ]) {
      await writeFile(path, invalid);
      await assert.rejects(() => resolveNativeNetConfig(path), /native_net_config_invalid/);
    }
    assert.equal(existsSync(join(directory, 'run')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
