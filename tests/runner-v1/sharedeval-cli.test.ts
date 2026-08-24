import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mainSharedevalV1,
  parseSharedevalCliArgumentsV1,
} from '../../src/runner/v1/sharedeval-cli.js';

test('parses strict sharedeval arguments without an implicit legacy fallback', () => {
  assert.deepEqual(
    parseSharedevalCliArgumentsV1(['--config', 'run.yaml', '--check']),
    {
      configPath: 'run.yaml',
      check: true,
      workflow: { id: 'files-multi', mode: 'multi', protocol: 'files', maxTicks: 240, stopWhen: 'all-terminal' },
    },
  );
  assert.deepEqual(
    parseSharedevalCliArgumentsV1([
      'single', '--legacy', '--config=legacy.yaml', '--task', 'PAIR-Q-0101', '--max-ticks=7',
    ]),
    {
      configPath: 'legacy.yaml',
      check: false,
      taskIds: ['PAIR-Q-0101'],
      maxTicks: 7,
      workflow: {
        id: 'legacy-single-prompt',
        mode: 'single',
        protocol: 'legacy-prompt',
        maxTicks: 240,
        stopWhen: 'all-terminal',
      },
    },
  );
});

test('rejects unknown flags and invalid max tick counts before execution', () => {
  assert.throws(
    () => parseSharedevalCliArgumentsV1(['--config', 'run.yaml', '--unknown']),
    /Unknown Sharedeval argument: --unknown/,
  );
  assert.throws(
    () => parseSharedevalCliArgumentsV1(['--config', 'run.yaml', '--max-ticks', '0']),
    /--max-ticks must be a positive safe integer/,
  );
  assert.throws(
    () => parseSharedevalCliArgumentsV1(['--config', 'run.yaml', '--max-ticks=1.5']),
    /--max-ticks must be a positive safe integer/,
  );
  assert.throws(
    () => parseSharedevalCliArgumentsV1(['--config', 'run.yaml', '--max-ticks=10001']),
    /--max-ticks must be a positive safe integer/,
  );
});

test('rejects pact-run/v1 without explicit legacy selection before any model call', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharedeval-cli-'));
  const configPath = path.join(directory, 'legacy.yaml');
  await writeFile(configPath, 'apiVersion: pact-run/v1\nkind: RunConfig\n', 'utf8');
  try {
    await assert.rejects(
      () => mainSharedevalV1(['--config', configPath, '--check']),
      /pact-run\/v1 configurations require --legacy/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recognizes quoted historical YAML with an inline comment before any model call', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharedeval-cli-'));
  const configPath = path.join(directory, 'legacy.yaml');
  await writeFile(configPath, 'apiVersion: "pact-run/v1" # legacy\nkind: RunConfig\n', 'utf8');
  try {
    await assert.rejects(
      () => mainSharedevalV1(['--config', configPath, '--check']),
      /pact-run\/v1 configurations require --legacy/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('marks the benchmark command as deprecated while preserving its legacy CLI', () => {
  const command = spawnSync('npm', ['run', 'benchmark', '--', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stderr, /deprecated/i);
  assert.match(command.stdout, /Usage: npm run benchmark/);
});
