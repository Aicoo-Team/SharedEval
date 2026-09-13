import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { mainSharedevalV1 } from '../../src/runner/v1/sharedeval-cli.js';
import { parseNativeNetArgs } from '../../src/runner/net/cli.js';

const root = resolve(import.meta.dirname, '../..');
const executeFile = promisify(execFile);
const config = { version: 'pact-net-native-run/v1', runId: 'cli-test', outputDirectory: 'run',
  provider: { type: 'scripted-procurement/v1' }, execution: { kind: 'p01-pilot', mode: 'success' } };

test('NET arguments require an explicit stage and reject incompatible or unbounded options', () => {
  assert.deepEqual(parseNativeNetArgs(['run', '--config', 'run.yaml', '--max-turns', '0']), { command: 'run', configPath: 'run.yaml', turns: 0 });
  assert.equal(parseNativeNetArgs(['run', '--config', 'run.yaml', '--max-turns', '1000']).turns, 1000);
  for (const args of [[], ['multi', '--config', 'x'], ['run'], ['run', '--config'],
    ['score', '--config', 'x', '--max-turns', '8'], ['check', '--config', 'x', '--max-turns', '0'],
    ['run', '--config', 'x', '--config', 'y'], ['run', '--config', 'x', '--model', 'private-model-canary'],
    ...['-1', '1.5', '01', '1e2', '1001', 'Infinity'].map(value => ['run', '--config', 'x', '--max-turns', value]),
  ]) assert.throws(() => parseNativeNetArgs(args), error => error instanceof Error && /Usage:/.test(error.message) && !error.message.includes('private-model-canary'));
});

test('main CLI validates NET without entering PAIR production or emitting private profile contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-check-cli-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ ...config, execution: { kind: 'procurement-world', profileFile: join(root, 'tests/suites/pact-net/fixtures/procurement-world-multi.json') } }));
    let output = '';
    assert.equal(await mainSharedevalV1(['net', 'check', '--config', path], {
      writeOutput: source => { output += source; },
      runProduction: async () => { throw new Error('PAIR production must not be called'); },
    }), 0);
    const checked = JSON.parse(output);
    assert.equal(checked.workflowId, 'net-multi');
    assert.equal(checked.scoringRegistered, false);
    assert.equal(checked.cases.length, 2);
    assert.doesNotMatch(output, /PRIVATE-CANARY|private_text|gold_success|gold_safe_partial|budget_approval|signed_contract/);
    assert.equal(existsSync(join(directory, 'run')), false);
    await assert.rejects(() => mainSharedevalV1(['net', 'score', '--config', path]), /native_net_evaluator_not_registered/);
    assert.equal(existsSync(join(directory, 'run')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config check works without SharedOS while execution fails before creating a run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-no-runtime-cli-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(config));
    const options = { cwd: root, env: { ...process.env, SHAREDEVAL_SHAREDOS_DIR: join(directory, 'missing-runtime'), SHAREDEVAL_REQUIRE_SHAREDOS: '1' }, encoding: 'utf8' as const, timeout: 20_000 };
    const args = ['--import', 'tsx', join(root, 'src/runner/v1/sharedeval-cli.ts')];
    const result = await executeFile(process.execPath, [...args, 'net', 'check', '--config', path], options);
    assert.equal(JSON.parse(result.stdout).scoringRegistered, true);
    await assert.rejects(() => executeFile(process.execPath, [...args, 'net', 'run', '--config', path], options));
    assert.equal(existsSync(join(directory, 'run')), false);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).runId, config.runId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
