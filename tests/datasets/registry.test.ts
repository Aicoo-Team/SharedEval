import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATASET_MANIFEST_API_VERSION_V1,
  DatasetRegistry,
  defineDataset,
} from '../../src/datasets/index.js';

function makeDefinition(version = '1.0.0') {
  return defineDataset<{ response: string }, { accepted: boolean }>({
    apiVersion: DATASET_MANIFEST_API_VERSION_V1,
    kind: 'Dataset',
    id: 'demo',
    name: 'Demo',
    version,
    protocol: 'demo/v1',
    assets: { tasks: 'tasks.json' },
    evaluation: {
      evaluator: { id: 'demo', version: '1.0.0' },
      metrics: ['accuracy'],
    },
  });
}

test('registers validated definitions by exact dataset id and version', () => {
  const registry = new DatasetRegistry();
  const v2 = registry.register(makeDefinition('2.0.0'));
  const v1 = registry.register(makeDefinition('1.0.0'));

  assert.deepEqual(registry.list(), [
    { id: 'demo', version: '1.0.0' },
    { id: 'demo', version: '2.0.0' },
  ]);
  assert.equal(registry.require({ id: 'demo', version: '1.0.0' }), v1);
  assert.equal(registry.get({ id: 'demo', version: '2.0.0' }), v2);
  assert.equal(registry.get({ id: 'demo', version: '3.0.0' }), undefined);
  assert.deepEqual(registry.evaluatorFor({ id: 'demo', version: '1.0.0' }), {
    id: 'demo',
    version: '1.0.0',
  });
});

test('rejects duplicate definitions and validates programmatic input', () => {
  const registry = new DatasetRegistry();
  const definition = makeDefinition();
  registry.register(definition);
  assert.throws(() => registry.register(definition), /already registered/);
  assert.throws(
    () => registry.register({ ...definition, unexpected: true } as never),
    /Unrecognized key/,
  );
  assert.throws(
    () => registry.require({ id: 'missing', version: '1.0.0' }),
    /not registered/,
  );
});
