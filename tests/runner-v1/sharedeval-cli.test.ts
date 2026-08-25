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

test('npm run sharedeval routes explicit multi --legacy through the legacy transcript authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharedeval-legacy-multi-'));
  const configPath = path.join(directory, 'legacy.json');
  await writeFile(configPath, JSON.stringify(legacyMultiCheckConfig()), 'utf8');
  try {
    const command = spawnSync('npm', [
      'run', 'sharedeval', '--',
      'multi', '--legacy', '--config', configPath, '--check',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PACT_MODEL_API_KEY: 'test-only-key' },
    });

    assert.equal(command.status, 0, command.stderr);
    assert.match(command.stdout, /"workflowId": "legacy-multi-transcript"/);
    assert.match(command.stdout, /preflight completed without creating factories or calling a model API/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit legacy multi rejects resume and duplicate or contradictory flags before config loading', async () => {
  await assert.rejects(
    () => mainSharedevalV1([
      'multi', '--legacy', '--resume', 'prior-run', '--config', 'missing.yaml',
    ]),
    /resume.*not supported.*start a new run/i,
  );
  await assert.rejects(
    () => mainSharedevalV1([
      'multi', '--legacy', '--config', 'first.yaml', '--config', 'second.yaml',
    ]),
    /accepts --config only once/i,
  );
  await assert.rejects(
    () => mainSharedevalV1([
      'multi', '--legacy', '--config', 'missing.yaml',
      '--task', 'PAIR-Q1', '--tasks', 'PAIR-Q2',
    ]),
    /either --task or --tasks/i,
  );
  await assert.rejects(
    () => mainSharedevalV1([
      'multi', 'single', '--legacy', '--config', 'missing.yaml',
    ]),
    /accepts only one workflow mode/i,
  );
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

function legacyMultiCheckConfig() {
  return {
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    backend: { kind: 'local' },
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'responder-v1',
      maxOutputTokens: 100,
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      gradingMode: 'category',
      tasks: { kind: 'all', limit: 1 },
      execution: { adapter: 'pact-public-runner' },
      agentConfig: {
        persona: 'alex',
        coo: 'dataset/pact-pair/agent_configs/alex/COO.md',
        policy: 'dataset/pact-pair/agent_configs/alex/POLICY.md',
        memory: 'dataset/pact-pair/agent_configs/alex/MEMORY.md',
      },
      trajectory: {
        maxTicks: 1,
        count: 1,
        maxRuntimeMs: 1_000,
        requesterDriver: {
          kind: 'scripted',
          script: 'dataset/pact-pair/legacy-transcript/scripted_driver_v1.json',
        },
      },
    },
    budget: { maxTurns: 1, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    output: { directory: 'runs', saveTraces: false },
  };
}
