import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLegacyMultiOverridesV1,
  parseLegacyMultiConfigV1Yaml,
  validateLegacyPhaseBoundaryV1,
} from '../../../src/suites/pact-pair/legacy-transcript/config.js';

const validConfig = `
apiVersion: pact-run/v1
kind: RunConfig
backend: { kind: local }
model:
  provider: openai-compatible
  baseUrl: https://example.test/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: responder-v1
  maxOutputTokens: 1024
benchmark:
  dataset: pact-pair
  policy: D2
  requester: R4
  gradingMode: category
  tasks:
    kind: qa
    ids: [Q156, Q157]
  execution: { adapter: pact-public-runner }
  agentConfig:
    persona: alex
    coo: dataset/pact-pair/agent_configs/alex/COO.md
    policy: dataset/pact-pair/agent_configs/alex/POLICY.md
    memory: dataset/pact-pair/agent_configs/alex/MEMORY.md
  trajectory:
    maxTicks: 7
    phase2StartTick: 3
    count: 1
    maxRuntimeMs: 60000
    requesterDriver:
      kind: scripted
      script: dataset/pact-pair/legacy-transcript/scripted_driver_v1.json
budget: { maxTurns: 8, maxToolCalls: 4, maxRuntimeMs: 60000 }
output: { directory: runs, saveTraces: false }
`;

test('strict legacy config accepts only the explicit local Pair trajectory lane', () => {
  const parsed = parseLegacyMultiConfigV1Yaml(validConfig);
  assert.equal(parsed.apiVersion, 'pact-run/v1');
  assert.equal(parsed.backend.kind, 'local');
  assert.equal(parsed.benchmark.dataset, 'pact-pair');
  assert.equal(parsed.benchmark.execution.adapter, 'pact-public-runner');
  assert.equal(parsed.benchmark.trajectory.requesterDriver.kind, 'scripted');
});

test('unsupported datasets, backends, adapters, and missing explicit blocks are rejected', () => {
  const invalid = [
    validConfig.replace('dataset: pact-pair', 'dataset: pact-net'),
    validConfig.replace('backend: { kind: local }', 'backend: { kind: harbor }'),
    validConfig.replace('adapter: pact-public-runner', 'adapter: mock-sharedos'),
    validConfig.replace(/\n  agentConfig:[\s\S]*?\n  trajectory:/, '\n  trajectory:'),
    validConfig.replace(/\n  trajectory:[\s\S]*?\nbudget:/, '\nbudget:'),
    validConfig.replace(/\n    requesterDriver:[\s\S]*?\nbudget:/, '\nbudget:'),
    validConfig.replace('output: { directory: runs, saveTraces: false }', 'output: { directory: runs, saveTraces: false, extra: true }'),
  ];
  for (const source of invalid) {
    assert.throws(() => parseLegacyMultiConfigV1Yaml(source));
  }
});

test('task and tick overrides are exact, unique, and part of the effective digest', () => {
  const parsed = parseLegacyMultiConfigV1Yaml(validConfig);
  const effective = applyLegacyMultiOverridesV1(parsed, {
    taskIds: ['Q156', 'Q157'],
    maxTicks: 9,
  });
  assert.deepEqual(effective.benchmark.tasks.ids, ['Q156', 'Q157']);
  assert.equal(effective.benchmark.trajectory.maxTicks, 9);
  assert.match(effective.effectiveConfigDigest, /^[0-9a-f]{64}$/);

  assert.throws(
    () => applyLegacyMultiOverridesV1(parsed, { taskIds: ['Q156', 'Q156'] }),
    /unique/i,
  );
  assert.throws(
    () => applyLegacyMultiOverridesV1(parsed, { taskIds: ['Q157', 'Q156'] }),
    /contradicts/i,
  );
  assert.notEqual(
    effective.effectiveConfigDigest,
    applyLegacyMultiOverridesV1(parsed, { maxTicks: 10 }).effectiveConfigDigest,
  );
});

test('phase 2 starts exactly after every selected task has one first ask', () => {
  const parsed = parseLegacyMultiConfigV1Yaml(validConfig);
  assert.doesNotThrow(() => validateLegacyPhaseBoundaryV1(parsed, ['Q156', 'Q157']));
  assert.throws(
    () => validateLegacyPhaseBoundaryV1(parsed, ['Q156']),
    /selected task count \+ 1/i,
  );
  const noPhase2 = parseLegacyMultiConfigV1Yaml(
    validConfig.replace('    phase2StartTick: 3\n', ''),
  );
  assert.doesNotThrow(() => validateLegacyPhaseBoundaryV1(noPhase2, ['Q156']));
});

test('model requester selection is explicit and includes its own frozen persona files', () => {
  const source = validConfig.replace(
    `kind: scripted
      script: dataset/pact-pair/legacy-transcript/scripted_driver_v1.json`,
    `kind: model
      model:
        provider: openai-compatible
        baseUrl: https://example.test/v1
        apiKeyEnv: PACT_MODEL_API_KEY
        model: requester-v1
        maxOutputTokens: 1024
      agentConfig:
        persona: dana
        coo: dataset/pact-pair/agent_configs/dana/COO.md
        policy: dataset/pact-pair/agent_configs/dana/POLICY.md
        memory: dataset/pact-pair/agent_configs/dana/MEMORY.md`,
  );
  const parsed = parseLegacyMultiConfigV1Yaml(source);
  assert.equal(parsed.benchmark.trajectory.requesterDriver.kind, 'model');
  if (parsed.benchmark.trajectory.requesterDriver.kind !== 'model') {
    assert.fail('expected model requester');
  }
  assert.equal(parsed.benchmark.trajectory.requesterDriver.agentConfig.persona, 'dana');
});

