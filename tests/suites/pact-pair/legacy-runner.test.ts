import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { legacyMultiConfigV1Schema } from '../../../src/suites/pact-pair/legacy-transcript/config.js';
import { runLegacyMultiTranscriptBenchmarkV1 } from '../../../src/suites/pact-pair/legacy-transcript/runner.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
);

function config(adapter: 'pact-public-runner' | 'sharedos-embedded' = 'pact-public-runner') {
  return legacyMultiConfigV1Schema.parse({
    apiVersion: 'pact-run/v1', kind: 'RunConfig', backend: { kind: 'local' },
    model: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'responder-v1', maxOutputTokens: 100,
    },
    benchmark: {
      dataset: 'pact-pair', policy: 'D2', requester: 'R1', gradingMode: 'category',
      tasks: { kind: 'all', ids: ['PAIR-Q1'] },
      execution: { adapter },
      agentConfig: {
        persona: 'alex',
        coo: 'dataset/pact-pair/agent_configs/alex/COO.md',
        policy: 'dataset/pact-pair/agent_configs/alex/POLICY.md',
        memory: 'dataset/pact-pair/agent_configs/alex/MEMORY.md',
      },
      trajectory: {
        maxTicks: 1, count: 1, maxRuntimeMs: 10_000,
        requesterDriver: {
          kind: 'scripted',
          script: 'dataset/pact-pair/legacy-transcript/scripted_driver_v1.json',
        },
      },
    },
    budget: { maxTurns: 3, maxToolCalls: 2, maxRuntimeMs: 2_000 },
    output: { directory: 'runs', saveTraces: true },
  });
}

test('--check completes all preflight gates with zero factories, spend, or run directory', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-check-'));
  let factories = 0;
  let spend = 0;
  const result = await runLegacyMultiTranscriptBenchmarkV1({
    config: config(), rootDir: repositoryRoot, workingDirectory,
    environment: { PACT_MODEL_API_KEY: 'secret' }, check: true,
    fetch: async () => {
      spend += 1;
      throw new Error('check must not spend');
    },
    factories: {
      createRequester: () => { factories += 1; throw new Error('factory called'); },
      createResponder: () => { factories += 1; throw new Error('factory called'); },
      createWorld: async () => { factories += 1; throw new Error('factory called'); },
    },
  });
  assert.equal(result.mode, 'check');
  assert.equal(factories, 0);
  assert.equal(spend, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret|COO bytes|POLICY bytes/);
  await assert.rejects(() => stat(path.join(workingDirectory, 'runs')));
});

test('an explicit task override replaces an inherited limit before zero-spend preflight', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-exact-tasks-'));
  let factories = 0;
  let spend = 0;
  const limited = legacyMultiConfigV1Schema.parse({
    ...config(),
    benchmark: {
      ...config().benchmark,
      tasks: { kind: 'all', limit: 1 },
    },
  });
  const result = await runLegacyMultiTranscriptBenchmarkV1({
    config: limited,
    overrides: { taskIds: ['PAIR-Q1', 'PAIR-Q2'] },
    rootDir: repositoryRoot,
    workingDirectory,
    environment: { PACT_MODEL_API_KEY: 'secret' },
    check: true,
    fetch: async () => { spend += 1; throw new Error('check must not spend'); },
    factories: {
      createRequester: () => { factories += 1; throw new Error('factory called'); },
      createResponder: () => { factories += 1; throw new Error('factory called'); },
      createWorld: async () => { factories += 1; throw new Error('factory called'); },
    },
  });
  assert.equal(result.mode, 'check');
  if (result.mode !== 'check') assert.fail('expected preflight result');
  assert.deepEqual(result.preflight.selectedTaskIds, ['PAIR-Q1', 'PAIR-Q2']);
  assert.equal(factories, 0);
  assert.equal(spend, 0);
  await assert.rejects(() => stat(path.join(workingDirectory, 'runs')));
});

test('missing credentials fail before factories, model calls, or output directories', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-no-key-'));
  let factories = 0;
  let spend = 0;
  await assert.rejects(() => runLegacyMultiTranscriptBenchmarkV1({
    config: config(), rootDir: repositoryRoot, workingDirectory,
    environment: {},
    fetch: async () => { spend += 1; throw new Error('must not spend'); },
    factories: {
      createRequester: () => { factories += 1; throw new Error('factory called'); },
      createResponder: () => { factories += 1; throw new Error('factory called'); },
      createWorld: async () => { factories += 1; throw new Error('factory called'); },
    },
  }), /credential/i);
  assert.equal(factories, 0);
  assert.equal(spend, 0);
  await assert.rejects(() => stat(path.join(workingDirectory, 'runs')));
});

test('a mismatched embedded SharedOS build fails before factories or spend', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'legacy-sharedos-mismatch-'));
  let factories = 0;
  let spend = 0;
  await assert.rejects(() => runLegacyMultiTranscriptBenchmarkV1({
    config: config('sharedos-embedded'), rootDir: repositoryRoot, workingDirectory,
    environment: { PACT_MODEL_API_KEY: 'secret' }, check: true,
    fetch: async () => { spend += 1; throw new Error('must not spend'); },
    dependencies: {
      loadSharedOs: async () => ({
        ok: true,
        dir: '/not-used',
        revision: 'f'.repeat(40),
        runtimeDigest: 'e'.repeat(64),
        modules: {} as never,
      }),
    },
    factories: {
      createRequester: () => { factories += 1; throw new Error('factory called'); },
      createResponder: () => { factories += 1; throw new Error('factory called'); },
      createWorld: async () => { factories += 1; throw new Error('factory called'); },
    },
  }), /mismatched SharedOS build/i);
  assert.equal(factories, 0);
  assert.equal(spend, 0);
  await assert.rejects(() => stat(path.join(workingDirectory, 'runs')));
});

test('one scripted public-runner trajectory uses the frozen legacy lane end to end', async () => {
  let providerCalls = 0;
  const result = await runLegacyMultiTranscriptBenchmarkV1({
    config: config(), rootDir: repositoryRoot,
    environment: { PACT_MODEL_API_KEY: 'secret' },
    writeOutputs: false,
    runId: 'legacy-smoke',
    fetch: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        model: 'served-v1',
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
          id: 'terminal-1', type: 'function',
          function: { name: 'pact_refuse', arguments: JSON.stringify({ reason: 'private' }) },
        }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }), { status: 200 });
    },
  });
  assert.equal(result.mode, 'run');
  if (result.mode !== 'run') assert.fail('expected run result');
  assert.equal(providerCalls, 1);
  assert.equal(result.trajectories.length, 1);
  assert.equal(result.trajectories[0]?.public.tickCount, 1);
  assert.equal(result.metrics.metricFamilyId, 'pact-pair/legacy-trajectory-metrics-v1');
  assert.equal(result.manifest.execution.adapterId, 'pact-public-runner');
  assert.equal(result.outputDirectory, undefined);
});
