import type {
  EvaluationResult,
  EvaluationSpec,
  EvaluatorReference,
  MetricContribution,
} from './types.js';

const identifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const reservedNames = new Set(['__proto__', 'constructor', 'prototype']);

export function assertValidIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !identifierPattern.test(value)
    || reservedNames.has(value)
  ) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
}

export function assertSemanticVersion(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !semanticVersionPattern.test(value)) {
    throw new TypeError(`${label} must be a semantic version`);
  }
}

export function assertEvaluatorReference(
  value: EvaluatorReference,
  label = 'evaluator',
): void {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${label} must be an evaluator reference`);
  }
  assertOnlyKeys(value, ['id', 'version'], label);
  assertValidIdentifier(value.id, `${label}.id`);
  assertSemanticVersion(value.version, `${label}.version`);
}

export function assertEvaluationSpec(
  spec: Pick<EvaluationSpec, 'evaluator' | 'metrics'>,
): void {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('evaluation must be an evaluation spec');
  }
  assertOnlyKeys(spec, ['evaluator', 'metrics'], 'evaluation');
  assertEvaluatorReference(spec.evaluator, 'evaluation.evaluator');
  if (!Array.isArray(spec.metrics) || spec.metrics.length === 0) {
    throw new TypeError('evaluation.metrics must contain at least one metric');
  }
  const metrics = new Set<string>();
  for (const metric of spec.metrics) {
    assertValidIdentifier(metric, 'evaluation metric');
    if (metrics.has(metric)) {
      throw new TypeError(`evaluation metric ${JSON.stringify(metric)} is duplicated`);
    }
    metrics.add(metric);
  }
}

export function assertMetricContribution(
  value: MetricContribution,
): void {
  if (!value || typeof value !== 'object') {
    throw new TypeError('metric contribution must be an object');
  }
  assertValidIdentifier(value.metric, 'metric contribution name');
  if (!Number.isFinite(value.numerator) || value.numerator < 0) {
    throw new TypeError(`metric ${JSON.stringify(value.metric)} numerator must be finite and non-negative`);
  }
  if (!Number.isFinite(value.denominator) || value.denominator < 0) {
    throw new TypeError(`metric ${JSON.stringify(value.metric)} denominator must be finite and non-negative`);
  }
  if (value.denominator === 0 && value.numerator !== 0) {
    throw new TypeError(`metric ${JSON.stringify(value.metric)} cannot have a non-zero numerator with a zero denominator`);
  }
}

export function normalizeEvaluationResult<TDetails>(
  value: EvaluationResult<TDetails>,
  spec: Pick<EvaluationSpec, 'evaluator' | 'metrics'>,
): EvaluationResult<TDetails> {
  if (!value || typeof value !== 'object' || !Array.isArray(value.metrics)) {
    throw new TypeError('evaluator must return an EvaluationResult with a metrics array');
  }

  const declared = new Set(spec.metrics);
  const contributions = new Map<string, MetricContribution>();
  for (const contribution of value.metrics) {
    assertMetricContribution(contribution);
    if (!declared.has(contribution.metric)) {
      throw new TypeError(
        `evaluator returned undeclared metric ${JSON.stringify(contribution.metric)}`,
      );
    }
    if (contributions.has(contribution.metric)) {
      throw new TypeError(
        `evaluator returned metric ${JSON.stringify(contribution.metric)} more than once`,
      );
    }
    contributions.set(contribution.metric, {
      metric: contribution.metric,
      numerator: contribution.numerator,
      denominator: contribution.denominator,
    });
  }

  const metrics = spec.metrics.map(metric => contributions.get(metric) ?? {
    metric,
    numerator: 0,
    denominator: 0,
  });

  return Object.prototype.hasOwnProperty.call(value, 'details')
    ? { metrics, details: value.details }
    : { metrics };
}

function assertOnlyKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${label} contains unknown field ${JSON.stringify(unknown)}`);
  }
}
