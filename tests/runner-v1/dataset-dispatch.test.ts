import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePactRunConfigV1Yaml } from '../../src/runner/v1/config.js';
import { inspectPactBenchmarkV1 } from '../../src/runner/v1/runner.js';

const config = parsePactRunConfigV1Yaml(`
apiVersion: pact-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: example-model
benchmark:
  dataset: pact-pair
  policy: D2
  requester: R1
  gradingMode: category
  tasks:
    kind: all
    ids: [Q1, A1]
`);

test('dispatches inspection through the approved PACT-Pair runtime', () => {
  assert.deepEqual(inspectPactBenchmarkV1(config), {
    dataset: 'pact-pair',
    taskCount: 2,
    firstTask: 'PAIR-Q1',
    lastTask: 'PAIR-A1',
  });
});

test('dispatches inspection through the approved PACT-Net runtime', () => {
  const netConfig = parsePactRunConfigV1Yaml(`
apiVersion: pact-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: example-model
benchmark:
  dataset: pact-net
  policy: D0
  tasks:
    kind: all
    ids: [NET-Q-0001, NET-A-0001]
`);
  assert.deepEqual(inspectPactBenchmarkV1(netConfig), {
    dataset: 'pact-net',
    taskCount: 2,
    firstTask: 'NET-Q-0001',
    lastTask: 'NET-A-0001',
  });
});

test('rejects pact-net configs outside the D0/D2 policy contract', () => {
  const yamlFor = (benchmark: string) => `
apiVersion: pact-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: example-model
benchmark:
${benchmark}
`;
  assert.throws(
    () => parsePactRunConfigV1Yaml(yamlFor('  dataset: pact-net\n  policy: D1')),
    /pact-net supports policies D0, D2/,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(yamlFor('  dataset: pact-net\n  requester: R2')),
    /requester does not apply to pact-net/,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(yamlFor('  dataset: pact-net\n  gradingMode: relationship')),
    /gradingMode does not apply to pact-net/,
  );
  // The sharedos-embedded execution adapter is a supported pact-net path
  // (model-backed trials through the real kernel; see
  // src/suites/pact-net/sharedos-execution.ts).
  const sharedOsNet = parsePactRunConfigV1Yaml(yamlFor(
    '  dataset: pact-net\n  execution:\n    adapter: sharedos-embedded',
  ));
  assert.equal(sharedOsNet.benchmark.execution?.adapter, 'sharedos-embedded');
  // The default D2 with an explicit pact-net dataset parses cleanly.
  const parsed = parsePactRunConfigV1Yaml(yamlFor('  dataset: pact-net'));
  assert.equal(parsed.benchmark.dataset, 'pact-net');
  assert.equal(parsed.benchmark.policy, 'D2');
});

test('does not treat a dataset identifier as executable code', () => {
  const unregistered = structuredClone(config) as unknown as {
    benchmark: { dataset: string };
  };
  unregistered.benchmark.dataset = 'uploaded-dataset';

  assert.throws(
    () => inspectPactBenchmarkV1(unregistered as unknown as typeof config),
    /has no approved local runtime/,
  );
});
