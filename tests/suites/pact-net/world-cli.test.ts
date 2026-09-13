import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorldArgs } from '../../../src/suites/pact-net/world/cli.js';

test('world CLI requires an explicit experiment profile and bounded turns', () => {
  const args = ['--profile', 'world.json', '--output', 'artifacts'];
  assert.deepEqual(parseWorldArgs(args), { profilePath: 'world.json', directory: 'artifacts', turns: 40 });
  assert.equal(parseWorldArgs([...args, '--max-turns', '0']).turns, 0);
  assert.equal(parseWorldArgs([...args, '--max-turns', '1000']).turns, 1000);
  for (const invalid of [[], ['--output', 'artifacts'], ['--profile', 'world.json'],
    [...args, '--mode', 'single'], [...args, '--profile', 'second.json'], [...args, '--unknown', 'x'],
    ...['-1', '1.5', '01', '1e2', 'Infinity', '1001', ''].map(value => [...args, '--max-turns', value]),
  ]) assert.throws(() => parseWorldArgs(invalid), /Usage:/);
});
