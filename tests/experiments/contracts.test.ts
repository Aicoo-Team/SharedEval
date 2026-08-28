import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  EXPERIMENT_CELL_ID_PATTERN_V1,
  canonicalExperimentJsonV1,
  deriveExperimentCellIdV1,
  deriveExperimentPlanDigestV1,
  experimentCellV1Schema,
  experimentPlanV1Schema,
  sha256ExperimentJsonV1,
} from '../../src/experiments/v1/contracts.js';
import {
  MAX_SHAREDEVAL_RUNTIME_MS_V1,
  MAX_SHAREDEVAL_TOOL_CALLS_V1,
  MIN_SHAREDEVAL_TOOL_CALLS_V1,
} from '../../src/runner/v1/sharedeval-config.js';
import {
  experimentCellInput,
  experimentPlanInput,
} from './experiment-test-fixtures.js';

function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  const reversed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).reverse()) {
    reversed[key] = reverseKeys(entry);
  }
  return reversed;
}

test('canonical JSON is independent of key insertion order and drops undefined', () => {
  const canonical = canonicalExperimentJsonV1({
    zulu: [1, { b: 2, a: 1 }],
    alpha: 'value',
    skipped: undefined,
  });

  assert.equal(canonical, '{"alpha":"value","zulu":[1,{"a":1,"b":2}]}');
  assert.equal(
    canonicalExperimentJsonV1(reverseKeys({ zulu: [1, { b: 2, a: 1 }], alpha: 'value' })),
    '{"alpha":"value","zulu":[1,{"a":1,"b":2}]}',
  );
});

test('canonical JSON fails closed on values a digest cannot represent', () => {
  assert.throws(() => canonicalExperimentJsonV1(Number.NaN), /finite numbers/);
  assert.throws(() => canonicalExperimentJsonV1({ value: Infinity }), /finite numbers/);
  assert.throws(() => canonicalExperimentJsonV1([1, undefined]), /cannot contain undefined/);
  assert.throws(() => canonicalExperimentJsonV1(() => 0), /cannot encode function/);
  assert.throws(() => canonicalExperimentJsonV1(10n), /cannot encode bigint/);
  assert.equal(
    sha256ExperimentJsonV1({ a: 1 }),
    sha256ExperimentJsonV1(reverseKeys({ a: 1 })),
  );
});

test('cellId is a sha256 digest and stable under key reordering', () => {
  const cellId = deriveExperimentCellIdV1(experimentCellInput());

  assert.match(cellId, EXPERIMENT_CELL_ID_PATTERN_V1);
  assert.equal(deriveExperimentCellIdV1(experimentCellInput()), cellId);
  assert.equal(deriveExperimentCellIdV1(reverseKeys(experimentCellInput())), cellId);
});

test('execution provenance (imageDigest, egressProbe) never re-keys a cell', () => {
  const baseCellId = deriveExperimentCellIdV1(experimentCellInput());
  const provenance = {
    ...(experimentCellInput().provenance as Record<string, unknown>),
    imageDigest: `sha256:${'d'.repeat(64)}`,
    egressProbe: {
      directEgressBlocked: true,
      nonAllowlistedEgressBlocked: true,
      modelEndpointReachable: true,
    },
  };

  assert.equal(
    deriveExperimentCellIdV1(experimentCellInput({ provenance })),
    baseCellId,
  );
});

test('cellId changes with every identity dimension', () => {
  const base = experimentCellInput();
  const baseModel = base.model as Record<string, unknown>;
  const baseBenchmark = base.benchmark as Record<string, unknown>;
  const baseWorkflow = base.workflow as Record<string, unknown>;
  const baseProvenance = base.provenance as Record<string, unknown>;
  const variants: Record<string, Record<string, unknown>> = {
    providerRouting: experimentCellInput({
      model: {
        ...baseModel,
        providerRouting: { requireParameters: true, only: ['provider-b'] },
      },
    }),
    seed: experimentCellInput({ model: { ...baseModel, seed: 8 } }),
    temperature: experimentCellInput({ model: { ...baseModel, temperature: 0.5 } }),
    policy: experimentCellInput({ benchmark: { ...baseBenchmark, policy: 'D3' } }),
    requester: experimentCellInput({ benchmark: { ...baseBenchmark, requester: 'R2' } }),
    mode: experimentCellInput({ workflow: { ...baseWorkflow, mode: 'single' } }),
    tasks: experimentCellInput({
      benchmark: { ...baseBenchmark, tasks: { kind: 'all', ids: ['A101'] } },
    }),
    replicate: experimentCellInput({ replicate: 2 }),
    configDigest: experimentCellInput({
      provenance: { ...baseProvenance, configDigest: 'e'.repeat(64) },
    }),
    taskSetDigest: experimentCellInput({
      provenance: { ...baseProvenance, taskSetDigest: 'e'.repeat(64) },
    }),
    sharedosRevision: experimentCellInput({
      provenance: { ...baseProvenance, sharedosRevision: 'e'.repeat(40) },
    }),
    sharedosRuntimeDigest: experimentCellInput({
      provenance: { ...baseProvenance, sharedosRuntimeDigest: 'e'.repeat(64) },
    }),
  };

  const baseCellId = deriveExperimentCellIdV1(base);
  const cellIds = new Map<string, string>();
  for (const [dimension, variant] of Object.entries(variants)) {
    cellIds.set(dimension, deriveExperimentCellIdV1(variant));
  }
  for (const [dimension, cellId] of cellIds) {
    assert.notEqual(cellId, baseCellId, `${dimension} must change the cellId`);
  }
  assert.equal(new Set(cellIds.values()).size, cellIds.size);
});

test('budget bounds are exactly the runner bounds, not looser', () => {
  const budgetAt = (budget: Record<string, unknown>) =>
    experimentCellV1Schema.parse(experimentCellInput({ budget }));

  const accepted = budgetAt({
    maxToolCalls: MIN_SHAREDEVAL_TOOL_CALLS_V1,
    maxRuntimeMs: MAX_SHAREDEVAL_RUNTIME_MS_V1,
  });
  assert.equal(accepted.budget.maxToolCalls, 6);
  assert.equal(accepted.budget.maxRuntimeMs, 600_000);
  budgetAt({ maxToolCalls: MAX_SHAREDEVAL_TOOL_CALLS_V1, maxRuntimeMs: 1 });

  for (const rejected of [
    { maxToolCalls: MIN_SHAREDEVAL_TOOL_CALLS_V1 - 1, maxRuntimeMs: 60_000 },
    { maxToolCalls: MAX_SHAREDEVAL_TOOL_CALLS_V1 + 1, maxRuntimeMs: 60_000 },
    { maxToolCalls: 8, maxRuntimeMs: MAX_SHAREDEVAL_RUNTIME_MS_V1 + 1 },
    { maxToolCalls: 8, maxRuntimeMs: 0 },
    { maxToolCalls: 8.5, maxRuntimeMs: 60_000 },
  ]) {
    assert.throws(() => budgetAt(rejected), ZodError);
  }
});

test('cell schema fails closed on malformed identity and provenance', () => {
  const baseProvenance = experimentCellInput().provenance as Record<string, unknown>;

  for (const invalid of [
    experimentCellInput({ replicate: 0 }),
    experimentCellInput({ replicate: 1.5 }),
    experimentCellInput({ replicate: 1_001 }),
    experimentCellInput({ unexpected: true }),
    experimentCellInput({ provenance: { ...baseProvenance, configDigest: 'not-hex' } }),
    experimentCellInput({ provenance: { ...baseProvenance, sharedosRevision: 'short' } }),
    experimentCellInput({ provenance: { ...baseProvenance, imageDigest: 'd'.repeat(64) } }),
  ]) {
    assert.throws(() => experimentCellV1Schema.parse(invalid), ZodError);
  }
});

test('plan digest is deterministic and reordering-stable', () => {
  const planDigest = deriveExperimentPlanDigestV1(experimentPlanInput());

  assert.match(planDigest, /^[a-f0-9]{64}$/);
  assert.equal(deriveExperimentPlanDigestV1(experimentPlanInput()), planDigest);
  assert.equal(deriveExperimentPlanDigestV1(reverseKeys(experimentPlanInput())), planDigest);
  assert.notEqual(
    deriveExperimentPlanDigestV1(experimentPlanInput({ experimentId: 'pair-grid-sep' })),
    planDigest,
  );
});

test('plan schema rejects duplicate cells and malformed experiment ids', () => {
  assert.throws(
    () => experimentPlanV1Schema.parse(
      experimentPlanInput({ cells: [experimentCellInput(), experimentCellInput()] }),
    ),
    (error: unknown) => error instanceof ZodError
      && error.issues.some(issue => issue.message.includes('duplicates cell 0')),
  );
  for (const experimentId of ['Pair-Grid', 'ab', 'pair grid', `x${'a'.repeat(64)}`]) {
    assert.throws(
      () => experimentPlanV1Schema.parse(experimentPlanInput({ experimentId })),
      ZodError,
    );
  }
  assert.throws(
    () => experimentPlanV1Schema.parse(experimentPlanInput({ cells: [] })),
    ZodError,
  );
});
