import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { parsePilotArgs } from '../../../src/suites/pact-net/pilot/cli.js';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = join(import.meta.dirname, 'fixtures/assigned-procurement.json');
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js')) ? 'Pinned SharedOS is unavailable' : false;

test('assigned CLI profile selection retains its path and does not inject a pilot mode', () => {
  assert.deepEqual(parsePilotArgs(['--output', '/tmp/assigned', '--profile', './profile.json']), {
    directory: '/tmp/assigned', profilePath: './profile.json', turns: 20,
  });
  assert.deepEqual(parsePilotArgs(['--max-turns', '0', '--profile', '/tmp/assigned profile.json', '--output', '/tmp/assigned']), {
    directory: '/tmp/assigned', profilePath: '/tmp/assigned profile.json', turns: 0,
  });
});

test('assigned CLI rejects profile combined with either explicit mode in either order', () => {
  for (const mode of ['success', 'safe-partial']) {
    for (const options of [['--profile', './profile.json', '--mode', mode], ['--mode', mode, '--profile', './profile.json']]) {
      assert.throws(() => parsePilotArgs(['--output', '/tmp/assigned', ...options]), /Usage:/);
    }
  }
});

test('assigned CLI rejects duplicate, unknown or incomplete arguments and invalid turn limits', () => {
  for (const args of [
    ['--profile', './profile.json'],
    ['--output', '/tmp/assigned', '--profile'],
    ['--output', '/tmp/assigned', '--profile', ''],
    ['--output', '/tmp/assigned', '--profile', '--max-turns', '0'],
    ['--output', '/tmp/assigned', '--profile', './a.json', '--profile', './b.json'],
    ['--output', '/tmp/assigned', '--profile', './profile.json', '--unknown', 'yes'],
    ['--output', '/tmp/assigned', '--profile', './profile.json', '--max-turns', '-1'],
    ['--output', '/tmp/assigned', '--profile', './profile.json', '--max-turns', '1e2'],
    ['--output', '/tmp/assigned', '--profile', './profile.json', '--max-turns', '101'],
  ]) assert.throws(() => parsePilotArgs(args), /Usage:/);
});

test('assigned CLI runs the JSON fixture and resumes its committed checkpoint in a fresh process', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'net-assigned-cli-'));
  const run = (turns: number) => {
    const child = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/pact-net-pilot.ts'), '--output', directory, '--profile', fixturePath, '--max-turns', String(turns)], { encoding: 'utf8', env: process.env });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  try {
    assert.equal(run(2).turns, 2);
    const first = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'));
    assert.equal(first.case_id, 'SYN-PO-002');
    assert.equal(first.mode, 'assigned');
    assert.equal(first.stop_reason, 'turn_limit');
    assert.equal(first.event_log.length, 2);
    assert.equal(run(20).terminal_success, true);
    const completed = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'));
    assert.equal(completed.final_state.status, 'released');
    assert.equal(completed.processed.length, 8);
    assert.equal(completed.final_state.budget_approval.actor, 'owen_budget');
    assert.equal(completed.final_state.budget_approval.amount, 42000);
    assert.equal(completed.final_state.budget_approval.currency, 'EUR');
    assert.equal(completed.final_state.contract_approval.actor, 'lina_legal');
    assert.equal(completed.event_log.length, 5);
    assert.equal(run(20).turns, 8);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')), completed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
