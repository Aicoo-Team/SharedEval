import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertJsonComplexityV1 } from '../../contracts/json.js';
import {
  sharedevalBenchmarkV1Schema,
  sharedevalRuntimeBudgetV1Schema,
  sharedevalWorkflowV1Schema,
} from '../../runner/v1/sharedeval-config.js';
import { pactModelConfigV1Schema } from '../../runner/v1/model-config.js';

export const EXPERIMENT_PLAN_API_VERSION_V1 = 'sharedeval-experiment-plan/v1' as const;
export const MAX_EXPERIMENT_PLAN_CELLS_V1 = 512;
export const MAX_EXPERIMENT_REPLICATES_V1 = 1_000;
export const EXPERIMENT_ID_PATTERN_V1 = /^[a-z][a-z0-9-]{2,63}$/;
export const EXPERIMENT_CELL_ID_PATTERN_V1 = /^[a-f0-9]{64}$/;

const sha256HexV1Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256 digest');

const gitRevisionV1Schema = z
  .string()
  .regex(/^[a-f0-9]{40}$/, 'must be a lowercase hex git revision');

const ociImageDigestV1Schema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'must be an OCI sha256 image digest');

export const experimentEgressProbeV1Schema = z
  .object({
    directEgressBlocked: z.boolean(),
    nonAllowlistedEgressBlocked: z.boolean(),
    modelEndpointReachable: z.boolean(),
  })
  .strict();

// imageDigest and egressProbe are execution provenance: they are recorded on
// the cell but are excluded from cell identity, so re-baking an image or
// re-running the probe never re-keys a cell.
export const experimentCellProvenanceV1Schema = z
  .object({
    configDigest: sha256HexV1Schema,
    taskSetDigest: sha256HexV1Schema,
    sharedosRevision: gitRevisionV1Schema,
    sharedosRuntimeDigest: sha256HexV1Schema,
    imageDigest: ociImageDigestV1Schema.optional(),
    egressProbe: experimentEgressProbeV1Schema.optional(),
  })
  .strict();

// Budget bounds are the runner's own (sharedevalRuntimeBudgetV1Schema):
// maxToolCalls 6-128, maxRuntimeMs <= 600000. The plan layer must never be
// looser than the CLI it drives.
export const experimentCellV1Schema = z
  .object({
    model: pactModelConfigV1Schema,
    benchmark: sharedevalBenchmarkV1Schema,
    workflow: sharedevalWorkflowV1Schema,
    budget: sharedevalRuntimeBudgetV1Schema,
    replicate: z.number().int().safe().min(1).max(MAX_EXPERIMENT_REPLICATES_V1),
    provenance: experimentCellProvenanceV1Schema,
  })
  .strict();

export type ExperimentEgressProbeV1 = z.infer<typeof experimentEgressProbeV1Schema>;
export type ExperimentCellProvenanceV1 = z.infer<typeof experimentCellProvenanceV1Schema>;
export type ExperimentCellV1 = z.infer<typeof experimentCellV1Schema>;
export type ExperimentCellIdentityInputV1 = Omit<ExperimentCellV1, 'provenance'> & {
  provenance: Omit<ExperimentCellProvenanceV1, 'imageDigest' | 'egressProbe'>;
};

export const experimentPlanV1Schema = z
  .object({
    apiVersion: z.literal(EXPERIMENT_PLAN_API_VERSION_V1),
    kind: z.literal('ExperimentPlan'),
    experimentId: z
      .string()
      .regex(EXPERIMENT_ID_PATTERN_V1, 'must be a lowercase experiment slug'),
    description: z.string().min(1).max(2_000).optional(),
    cells: z.array(experimentCellV1Schema).min(1).max(MAX_EXPERIMENT_PLAN_CELLS_V1),
  })
  .strict()
  .superRefine((plan, context) => {
    const firstIndexByCellId = new Map<string, number>();
    plan.cells.forEach((cell, index) => {
      const cellId = deriveExperimentCellIdV1(cell);
      const firstIndex = firstIndexByCellId.get(cellId);
      if (firstIndex === undefined) {
        firstIndexByCellId.set(cellId, index);
        return;
      }
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cells', index],
        message: `duplicates cell ${firstIndex} (cellId ${cellId})`,
      });
    });
  });

export type ExperimentPlanV1 = z.infer<typeof experimentPlanV1Schema>;

/**
 * Deterministic serialization: codepoint-sorted object keys, no whitespace,
 * finite numbers only, undefined entries dropped. Mirrors the unexported
 * canonicalJsonV1 in src/contracts/json.ts so digests are reproducible from
 * the serialized bytes alone.
 */
export function canonicalExperimentJsonV1(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Experiment canonical JSON requires finite numbers');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`Experiment canonical JSON cannot encode ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (value.some(entry => entry === undefined)) {
      throw new Error('Experiment canonical JSON arrays cannot contain undefined');
    }
    return `[${value.map(entry => canonicalExperimentJsonV1(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalExperimentJsonV1(entry)}`)
    .join(',')}}`;
}

export function sha256ExperimentJsonV1(value: unknown): string {
  assertJsonComplexityV1(value, 'Experiment canonical JSON');
  return createHash('sha256')
    .update(canonicalExperimentJsonV1(value), 'utf8')
    .digest('hex');
}

export function experimentCellIdentityInputV1(
  cell: ExperimentCellV1,
): ExperimentCellIdentityInputV1 {
  const {
    imageDigest: _imageDigest,
    egressProbe: _egressProbe,
    ...identityProvenance
  } = cell.provenance;
  return { ...cell, provenance: identityProvenance };
}

/** cellId = sha256 of the canonical JSON of the validated cell identity input. */
export function deriveExperimentCellIdV1(cell: unknown): string {
  const parsed = experimentCellV1Schema.parse(cell);
  return sha256ExperimentJsonV1(experimentCellIdentityInputV1(parsed));
}

export function serializeExperimentPlanV1(plan: ExperimentPlanV1): string {
  return `${canonicalExperimentJsonV1(experimentPlanV1Schema.parse(plan))}\n`;
}

/** planDigest = sha256 of the canonical JSON of the validated plan. */
export function deriveExperimentPlanDigestV1(plan: unknown): string {
  return sha256ExperimentJsonV1(experimentPlanV1Schema.parse(plan));
}
