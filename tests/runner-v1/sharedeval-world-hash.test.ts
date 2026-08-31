import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySharedevalOverridesV1,
  type SharedevalRunConfigV1,
} from '../../src/runner/v1/sharedeval-config.js';
import {
  computeSharedevalWorldHashV1,
  SHAREDEVAL_WORLD_HASH_SCHEMA_V1,
} from '../../src/runner/v1/sharedeval-world-hash.js';
import { parseSharedevalCliArgumentsV1 } from '../../src/runner/v1/sharedeval-cli.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';

const SINGLE_WORKFLOW = resolveWorkflow(['single']);

function effectiveConfig(overrides: Partial<SharedevalRunConfigV1['benchmark']> = {}) {
  const config: SharedevalRunConfigV1 = {
    apiVersion: 'sharedeval-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      model: 'example/example-model',
      temperature: 0,
      maxOutputTokens: 4096,
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D0',
      requester: 'R1',
      gradingMode: 'category',
      tasks: { kind: 'all', ids: ['PAIR-Q1', 'PAIR-Q2', 'PAIR-Q3'] },
      ...overrides,
    },
    workflow: {
      mode: 'single',
      protocol: 'files',
      maxTicks: 24,
      stopWhen: 'all-terminal',
    },
    budget: { maxToolCalls: 32, maxRuntimeMs: 300_000 },
    output: { directory: 'runs' },
  } as unknown as SharedevalRunConfigV1;
  return applySharedevalOverridesV1(config, SINGLE_WORKFLOW);
}

test('hashes the same declared world to the same digest, twice', () => {
  const first = computeSharedevalWorldHashV1({ config: effectiveConfig() });
  const second = computeSharedevalWorldHashV1({ config: effectiveConfig() });

  assert.equal(first.schema, SHAREDEVAL_WORLD_HASH_SCHEMA_V1);
  assert.match(first.worldHash, /^[0-9a-f]{64}$/);
  assert.equal(first.taskCount, 3);
  assert.deepEqual(first, second);
});

test('a different policy, requester, or selection is a different world', () => {
  const base = computeSharedevalWorldHashV1({ config: effectiveConfig() });
  const otherPolicy = computeSharedevalWorldHashV1({
    config: effectiveConfig({ policy: 'D1' }),
  });
  const otherRequester = computeSharedevalWorldHashV1({
    config: effectiveConfig({ requester: 'R2' }),
  });
  const otherSelection = computeSharedevalWorldHashV1({
    config: effectiveConfig({ tasks: { kind: 'all', ids: ['PAIR-Q1', 'PAIR-Q2'] } }),
  });

  assert.notEqual(base.worldHash, otherPolicy.worldHash);
  assert.notEqual(base.worldHash, otherRequester.worldHash);
  assert.notEqual(base.worldHash, otherSelection.worldHash);
  // The provenance digests do not move with the selection: same dataset bytes.
  assert.deepEqual(base.dataset, otherSelection.dataset);
});

test('the summary states what the digest covers, without the task bodies', () => {
  const hash = computeSharedevalWorldHashV1({ config: effectiveConfig() });

  assert.equal(hash.benchmark.policy, 'D0');
  assert.equal(hash.benchmark.requester, 'R1');
  assert.equal(hash.benchmark.gradingMode, 'category');
  assert.match(hash.dataset.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(hash.goldSet.sha256, /^[0-9a-f]{64}$/);
  assert.match(hash.workspaceRegistrySha256, /^[0-9a-f]{64}$/);
  assert.equal('tasks' in hash, false);
});

test('the CLI accepts --world-hash without a run id', () => {
  const options = parseSharedevalCliArgumentsV1([
    'single',
    '--config',
    'run.yaml',
    '--world-hash',
  ]);
  assert.equal(options.worldHash, true);
  assert.equal(options.check, false);
  assert.equal(options.runId, undefined);
});
