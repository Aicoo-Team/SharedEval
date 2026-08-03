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
