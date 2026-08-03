import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EvaluatorRegistry,
  evaluateWithRegisteredEvaluator,
  type EvaluationTarget,
} from '../../src/evaluation/index.js';

type DemoInput = { answer: boolean };
type DemoDetails = { explanation: string };

const definition: EvaluationTarget<DemoInput, DemoDetails> = {
  evaluation: {
    evaluator: { id: 'test-evaluator', version: '1.0.0' },
    metrics: ['correct', 'optional'],
  },
};

test('evaluates through an explicitly approved evaluator', async () => {
  const registry = new EvaluatorRegistry();
  registry.register<DemoInput, DemoDetails>({
    id: 'test-evaluator',
    version: '1.0.0',
    evaluate(input, spec) {
      assert.deepEqual(spec.metrics, ['correct', 'optional']);
      return {
        metrics: [{
          metric: 'correct',
          numerator: input.answer ? 1 : 0,
          denominator: 1,
        }],
        details: { explanation: 'deterministic test' },
      };
    },
  });

  const result = await evaluateWithRegisteredEvaluator(
    definition,
    { answer: true },
    registry,
  );
  assert.deepEqual(result, {
    metrics: [
      { metric: 'correct', numerator: 1, denominator: 1 },
      { metric: 'optional', numerator: 0, denominator: 0 },
    ],
    details: { explanation: 'deterministic test' },
  });
});

test('requires an exact approved evaluator id and version', async () => {
  const registry = new EvaluatorRegistry();
  registry.register<DemoInput, DemoDetails>({
    id: 'test-evaluator',
    version: '2.0.0',
    evaluate: () => ({ metrics: [] }),
  });

  await assert.rejects(
    evaluateWithRegisteredEvaluator(definition, { answer: true }, registry),
    /test-evaluator@1\.0\.0 is not in the approved registry/,
  );
});

test('rejects evaluator output outside the dataset metric contract', async () => {
  const undeclared = new EvaluatorRegistry();
  undeclared.register<DemoInput, DemoDetails>({
    id: 'test-evaluator',
    version: '1.0.0',
    evaluate: () => ({
      metrics: [{ metric: 'surprise', numerator: 1, denominator: 1 }],
    }),
  });
  await assert.rejects(
    evaluateWithRegisteredEvaluator(definition, { answer: true }, undeclared),
    /undeclared metric/,
  );

  const duplicate = new EvaluatorRegistry();
  duplicate.register<DemoInput, DemoDetails>({
    id: 'test-evaluator',
    version: '1.0.0',
    evaluate: () => ({
      metrics: [
        { metric: 'correct', numerator: 1, denominator: 1 },
        { metric: 'correct', numerator: 0, denominator: 1 },
      ],
    }),
  });
  await assert.rejects(
    evaluateWithRegisteredEvaluator(definition, { answer: true }, duplicate),
    /more than once/,
  );
});

test('validates programmatic evaluation specs before dispatch', async () => {
  const registry = new EvaluatorRegistry();
  const invalid = {
    evaluation: {
      evaluator: { id: 'test-evaluator', version: '1.0.0' },
      metrics: ['correct', 'correct'],
    },
  };
  await assert.rejects(
    evaluateWithRegisteredEvaluator(invalid, {}, registry),
    /duplicated/,
  );

  await assert.rejects(
    evaluateWithRegisteredEvaluator({
      evaluation: {
        evaluator: {
          id: 'test-evaluator',
          version: '1.0.0',
          module: './unapproved.ts',
        },
        metrics: ['correct'],
      },
    } as never, {}, registry),
    /unknown field "module"/,
  );
});
