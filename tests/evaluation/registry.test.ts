import assert from 'node:assert/strict';
import test from 'node:test';
import { EvaluatorRegistry } from '../../src/evaluation/index.js';

test('registry versions evaluator implementations independently', () => {
  const registry = new EvaluatorRegistry();
  const v1 = {
    id: 'scorer',
    version: '1.0.0',
    evaluate: () => ({ metrics: [] }),
  };
  const v2 = {
    id: 'scorer',
    version: '2.0.0',
    evaluate: () => ({ metrics: [] }),
  };
  registry.register(v2);
  registry.register(v1);

  assert.equal(registry.get({ id: 'scorer', version: '1.0.0' }), v1);
  assert.equal(registry.get({ id: 'scorer', version: '2.0.0' }), v2);
  assert.deepEqual(registry.list(), [
    { id: 'scorer', version: '1.0.0' },
    { id: 'scorer', version: '2.0.0' },
  ]);
});

test('registry rejects duplicate, malformed, and non-executable entries', () => {
  const registry = new EvaluatorRegistry();
  const evaluator = {
    id: 'scorer',
    version: '1.0.0',
    evaluate: () => ({ metrics: [] }),
  };
  registry.register(evaluator);
  assert.throws(() => registry.register(evaluator), /already registered/);
  assert.throws(
    () => registry.register({ ...evaluator, id: '__proto__' }),
    /safe identifier/,
  );
  assert.throws(
    () => registry.register({ ...evaluator, id: 'other', version: 'latest' }),
    /semantic version/,
  );
  assert.throws(
    () => registry.register({ id: 'other', version: '1.0.0' } as never),
    /evaluate function/,
  );
});
