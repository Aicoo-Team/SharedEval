import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePilotArgs } from '../../../src/suites/pact-net/pilot/cli.js';

test('pilot CLI requires explicit output and rejects unknown, duplicate and missing values', () => {
  for (const args of [[], ['--output'], ['--output', '/tmp/pilot', '--mode'], ['--output', '/tmp/pilot', '--unknown', 'yes'], ['--output', '/tmp/a', '--output', '/tmp/b'], ['--output', '/tmp/a', '--mode', 'wrong'], ['--output', '/tmp/a', '--max-turns', '-1'], ['--output', '/tmp/a', '--max-turns', '1e2'], ['--output', '/tmp/a', '--max-turns', '101']]) assert.throws(() => parsePilotArgs(args), /Usage:/);
  assert.deepEqual(parsePilotArgs(['--output', '/tmp/a']), { directory: '/tmp/a', mode: 'success', turns: 20 });
  assert.deepEqual(parsePilotArgs(['--max-turns', '0', '--mode', 'safe-partial', '--output', '/tmp/a']), { directory: '/tmp/a', mode: 'safe-partial', turns: 0 });
});
