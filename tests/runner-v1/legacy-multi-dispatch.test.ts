import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  classifyLegacyMultiTranscriptRouteV1,
  mainLegacyMultiTranscriptCliV1,
  parseLegacyMultiTranscriptCliArgumentsV1,
  runLegacyMultiTranscriptCliV1,
} from '../../src/suites/pact-pair/legacy-transcript/cli.js';
import { legacyMultiConfigV1Schema } from '../../src/suites/pact-pair/legacy-transcript/config.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

function config() {
  return legacyMultiConfigV1Schema.parse({
    apiVersion: 'pact-run/v1', kind: 'RunConfig', backend: { kind: 'local' },
    model: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'responder-v1', maxOutputTokens: 100,
    },
    benchmark: {
      dataset: 'pact-pair', policy: 'D2', requester: 'R1', gradingMode: 'category',
      tasks: { kind: 'all' }, execution: { adapter: 'pact-public-runner' },
      agentConfig: {
        persona: 'alex', coo: 'agents/alex/COO.md',
        policy: 'agents/alex/POLICY.md', memory: 'agents/alex/MEMORY.md',
      },
      trajectory: {
        maxTicks: 4, count: 1, maxRuntimeMs: 10_000,
        requesterDriver: { kind: 'scripted', script: 'requester.json' },
      },
    },
    budget: { maxTurns: 3, maxToolCalls: 2, maxRuntimeMs: 2_000 },
    output: { directory: 'runs', saveTraces: false },
  });
}

test('the four command routes remain distinct and only multi --legacy is handled', () => {
  assert.deepEqual(classifyLegacyMultiTranscriptRouteV1(['multi']), {
    handled: false, workflowId: 'files-multi',
  });
  assert.deepEqual(classifyLegacyMultiTranscriptRouteV1(['single']), {
    handled: false, workflowId: 'files-single',
  });
  assert.deepEqual(classifyLegacyMultiTranscriptRouteV1(['single', '--legacy']), {
    handled: false, workflowId: 'legacy-single-prompt',
  });
  assert.deepEqual(classifyLegacyMultiTranscriptRouteV1(['multi', '--legacy']), {
    handled: true, workflowId: 'legacy-multi-transcript',
  });
});

test('legacy multi accepts only its exact config, task, tick, and check options', () => {
  assert.deepEqual(parseLegacyMultiTranscriptCliArgumentsV1([
    'multi', '--legacy', '--config', 'legacy.yaml', '--tasks', 'PAIR-Q1,PAIR-Q2',
    '--max-ticks=4', '--check',
  ]), {
    configPath: 'legacy.yaml', check: true,
    taskIds: ['PAIR-Q1', 'PAIR-Q2'], maxTicks: 4,
  });
  assert.throws(
    () => parseLegacyMultiTranscriptCliArgumentsV1([
      'multi', '--legacy', '--config', 'legacy.yaml', '--task', 'PAIR-Q1',
      '--tasks', 'PAIR-Q2',
    ]),
    /either --task or --tasks/i,
  );
  assert.throws(
    () => parseLegacyMultiTranscriptCliArgumentsV1([
      'multi', '--legacy', '--config', 'legacy.yaml', '--execution.adapter', 'adapter-host',
    ]),
    /unknown legacy multi argument/i,
  );
  assert.throws(
    () => parseLegacyMultiTranscriptCliArgumentsV1([
      '--legacy', '--config', 'legacy.yaml',
    ]),
    /explicit `multi --legacy`/i,
  );
});

test('--resume fails before config loading, factories, model spend, or output', async () => {
  let configLoads = 0;
  let runs = 0;
  let writes = 0;
  await assert.rejects(() => mainLegacyMultiTranscriptCliV1([
    'multi', '--legacy', '--resume', 'prior-run', '--config', 'missing.yaml',
  ], {
    loadConfig: async () => { configLoads += 1; throw new Error('config loaded'); },
    runBenchmark: async () => { runs += 1; throw new Error('runner called'); },
    writeOutput: () => { writes += 1; },
    repositoryRoot: '/repo',
  }), /resume.*not supported.*start a new run/i);
  assert.equal(configLoads, 0);
  assert.equal(runs, 0);
  assert.equal(writes, 0);
});

test('the dispatcher strips loader metadata and forwards only supported overrides', async () => {
  const loaded = {
    ...config(), sourcePath: '/config/legacy.yaml', configDirectory: '/config',
  };
  let received: Record<string, unknown> | undefined;
  let output = '';
  const code = await runLegacyMultiTranscriptCliV1({
    configPath: 'legacy.yaml', check: true,
    taskIds: ['PAIR-Q1'], maxTicks: 3,
  }, {
    loadConfig: async () => loaded,
    runBenchmark: async options => {
      received = options as unknown as Record<string, unknown>;
      return {
        mode: 'check',
        preflight: {
          workflowId: 'legacy-multi-transcript',
          protocolId: 'pact-pair/legacy-transcript-v1',
          metricFamilyId: 'pact-pair/legacy-trajectory-metrics-v1',
          effectiveConfigDigest: '1'.repeat(64), taskSetDigest: '2'.repeat(64),
          sourceRevision: '3'.repeat(40), selectedTaskIds: ['PAIR-Q1'],
          sourcePrHeads: {
            pr20: 'b313a3940ebb400ba4866d2967f7587564a1a7a2',
            pr27: 'ea0508133cb2633b6a1e7656eb48844e844a12c1',
            pr35: '226e47f6e3a01317a7046649bf5870f8b0533c1d',
          },
          execution: {
            backend: 'local', adapterId: 'pact-public-runner',
            sharedOsRevision: '4'.repeat(40),
          },
          assets: {
            responder: {
              persona: 'alex',
              coo: { kind: 'coo', path: 'c', rawSha256: '5'.repeat(64), bytes: 1, status: 'legacy' },
              policy: { kind: 'policy', path: 'p', rawSha256: '6'.repeat(64), bytes: 1, status: 'legacy' },
              memory: { kind: 'memory', path: 'm', rawSha256: '7'.repeat(64), bytes: 1, status: 'legacy' },
            },
            requester: {
              kind: 'scripted',
              script: { kind: 'script', path: 's', rawSha256: '8'.repeat(64), bytes: 1, status: 'legacy' },
            },
          },
        },
      };
    },
    writeOutput: value => { output += value; },
    repositoryRoot: '/repo', workingDirectory: '/work',
    environment: { PACT_MODEL_API_KEY: 'secret' },
  });

  assert.equal(code, 0);
  assert.deepEqual((received?.overrides), { taskIds: ['PAIR-Q1'], maxTicks: 3 });
  assert.equal(received?.rootDir, '/repo');
  assert.equal(received?.workingDirectory, '/work');
  assert.equal(received?.check, true);
  const forwardedConfig = received?.config as Record<string, unknown>;
  assert.equal('sourcePath' in forwardedConfig, false);
  assert.equal('configDirectory' in forwardedConfig, false);
  assert.doesNotMatch(output, /secret|sourcePath|configDirectory/);
  assert.match(output, /legacy-multi-transcript/);
});

test('the CLI smoke runs two scripted trajectories without entering legacy-single artifacts', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-multi-cli-smoke-'));
  const smokeConfig = legacyMultiConfigV1Schema.parse({
    ...config(),
    benchmark: {
      ...config().benchmark,
      tasks: { kind: 'all', ids: ['PAIR-Q1'] },
      agentConfig: {
        persona: 'alex',
        coo: 'dataset/pact-pair/agent_configs/alex/COO.md',
        policy: 'dataset/pact-pair/agent_configs/alex/POLICY.md',
        memory: 'dataset/pact-pair/agent_configs/alex/MEMORY.md',
      },
      trajectory: {
        ...config().benchmark.trajectory,
        maxTicks: 1,
        count: 2,
        requesterDriver: {
          kind: 'scripted',
          script: 'dataset/pact-pair/legacy-transcript/scripted_driver_v1.json',
        },
      },
    },
  });
  let output = '';
  try {
    const code = await runLegacyMultiTranscriptCliV1({
      configPath: 'legacy.yaml', check: false,
    }, {
      loadConfig: async () => ({
        ...smokeConfig,
        sourcePath: path.join(repositoryRoot, 'legacy.yaml'),
        configDirectory: repositoryRoot,
      }),
      repositoryRoot,
      workingDirectory,
      environment: { PACT_MODEL_API_KEY: 'secret' },
      fetch: async () => new Response(JSON.stringify({
        model: 'served-v1',
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
          id: 'terminal-1', type: 'function',
          function: {
            name: 'pact_refuse',
            arguments: JSON.stringify({ reason: 'private' }),
          },
        }] } }],
      }), { status: 200 }),
      writeOutput: value => { output += value; },
    });
    assert.equal(code, 0);
    const printed = JSON.parse(output) as { outputDirectory: string; workflowId: string };
    assert.equal(printed.workflowId, 'legacy-multi-transcript');
    const rows = (await readFile(
      path.join(printed.outputDirectory, 'trajectories.jsonl'),
      'utf8',
    )).trim().split('\n');
    assert.equal(rows.length, 2);
    await assert.rejects(() => stat(path.join(printed.outputDirectory, 'results.jsonl')));
    await assert.rejects(() => stat(path.join(printed.outputDirectory, 'private')));
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
