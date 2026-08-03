import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateEvaluationResults,
  aggregateMetricContributions,
  type EvaluationResult,
} from '../../src/evaluation/index.js';

test('aggregates bare metric contributions without dataset-specific logic', () => {
  const aggregate = aggregateMetricContributions([
    { metric: 'utility', numerator: 1, denominator: 1 },
    { metric: 'utility', numerator: 1, denominator: 2 },
    { metric: 'safety', numerator: 4, denominator: 5 },
  ]);

  assert.deepEqual(aggregate, {
    utility: { numerator: 2, denominator: 3, value: 2 / 3 },
    safety: { numerator: 4, denominator: 5, value: 0.8 },
  });
});

test('aggregates EvaluationResult values and keeps zero-denominator metrics null', () => {
  const results: EvaluationResult[] = [
    {
      metrics: [
        { metric: 'utility', numerator: 1, denominator: 1 },
        { metric: 'safety', numerator: 0, denominator: 0 },
      ],
    },
    {
      metrics: [
        { metric: 'utility', numerator: 0, denominator: 1 },
      ],
    },
  ];

  const expected = {
    utility: { numerator: 1, denominator: 2, value: 0.5 },
    safety: { numerator: 0, denominator: 0, value: null },
    untouched: { numerator: 0, denominator: 0, value: null },
  };
  assert.deepEqual(
    aggregateMetricContributions(results, ['utility', 'safety', 'untouched']),
    expected,
  );
  assert.deepEqual(
    aggregateEvaluationResults(results, ['utility', 'safety', 'untouched']),
    expected,
  );
});

test('can aggregate a mixture of results and individual contributions', () => {
  assert.deepEqual(
    aggregateMetricContributions([
      { metrics: [{ metric: 'score', numerator: 2, denominator: 3 }] },
      { metric: 'score', numerator: 1, denominator: 1 },
    ]),
    { score: { numerator: 3, denominator: 4, value: 0.75 } },
  );
});

test('rejects invalid contributions and duplicate seeded metric names', () => {
  assert.throws(
    () => aggregateMetricContributions([
      { metric: 'score', numerator: Number.NaN, denominator: 1 },
    ]),
    /numerator must be finite/,
  );
  assert.throws(
    () => aggregateMetricContributions([
      { metric: 'score', numerator: 1, denominator: 0 },
    ]),
    /non-zero numerator with a zero denominator/,
  );
  assert.throws(
    () => aggregateMetricContributions([], ['score', 'score']),
    /duplicated/,
  );
  assert.throws(
    () => aggregateMetricContributions([
      { metric: '__proto__', numerator: 0, denominator: 0 },
    ]),
    /safe identifier/,
  );
});
