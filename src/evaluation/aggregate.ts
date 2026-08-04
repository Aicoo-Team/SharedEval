import type {
  AggregatedMetric,
  EvaluationResult,
  MetricAggregates,
  MetricContribution,
} from './types.js';
import {
  assertMetricContribution,
  assertValidIdentifier,
} from './validation.js';

export type MetricAggregationInput = MetricContribution | EvaluationResult<unknown>;

/**
 * Aggregates either bare contributions, evaluation results, or a mixture of
 * both. Optional metric names seed the output with `0 / 0 = null` entries.
 */
export function aggregateMetricContributions(
  values: Iterable<MetricAggregationInput>,
  metricNames: Iterable<string> = [],
): MetricAggregates {
  const totals = new Map<string, { numerator: number; denominator: number }>();

  for (const metric of metricNames) {
    assertValidIdentifier(metric, 'metric name');
    if (totals.has(metric)) {
      throw new TypeError(`metric name ${JSON.stringify(metric)} is duplicated`);
    }
    totals.set(metric, { numerator: 0, denominator: 0 });
  }

  for (const value of values) {
    for (const contribution of contributionsFrom(value)) {
      assertMetricContribution(contribution);
      const total = totals.get(contribution.metric) ?? {
        numerator: 0,
        denominator: 0,
      };
      total.numerator += contribution.numerator;
      total.denominator += contribution.denominator;
      if (!Number.isFinite(total.numerator) || !Number.isFinite(total.denominator)) {
        throw new RangeError(`metric ${JSON.stringify(contribution.metric)} aggregate overflowed`);
      }
      totals.set(contribution.metric, total);
    }
  }

  return Object.fromEntries(
    [...totals].map(([metric, total]): [string, AggregatedMetric] => [
      metric,
      {
        ...total,
        value: total.denominator === 0
          ? null
          : total.numerator / total.denominator,
      },
    ]),
  );
}

/** Convenience wrapper for callers that hold complete evaluation results. */
export function aggregateEvaluationResults(
  results: Iterable<EvaluationResult<unknown>>,
  metricNames: Iterable<string> = [],
): MetricAggregates {
  return aggregateMetricContributions(results, metricNames);
}

function contributionsFrom(value: MetricAggregationInput): readonly MetricContribution[] {
  if (!value || typeof value !== 'object') {
    throw new TypeError('metric aggregation input must be an object');
  }
  if ('metrics' in value) {
    if (!Array.isArray(value.metrics)) {
      throw new TypeError('evaluation result metrics must be an array');
    }
    return value.metrics;
  }
  return [value];
}
