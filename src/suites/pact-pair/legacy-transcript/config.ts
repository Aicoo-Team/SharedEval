import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import {
  assertPactJsonComplexityV1,
  safeRelativePathSchema,
} from '../../../protocol/v1/index.js';
import {
  MAX_PACT_RUN_CONFIG_BYTES_V1,
  PACT_RUN_CONFIG_API_VERSION_V1,
  pactModelConfigV1Schema,
  pactRunBudgetV1Schema,
  pactTaskFilterV1Schema,
} from '../../../runner/v1/config.js';
import {
  PACT_PAIR_GRADING_MODES_V1,
  PACT_PAIR_POLICIES_V1,
  PACT_PAIR_REQUESTERS_V1,
} from '../task-loader.js';

export const LEGACY_MULTI_WORKFLOW_ID_V1 = 'legacy-multi-transcript' as const;
export const LEGACY_MULTI_PROTOCOL_ID_V1 = 'pact-pair/legacy-transcript-v1' as const;
export const LEGACY_MULTI_METRIC_FAMILY_ID_V1 =
  'pact-pair/legacy-trajectory-metrics-v1' as const;
export const MAX_LEGACY_MULTI_TICKS_V1 = 240;

const personaSchema = z.enum(['alex', 'tina', 'marcus', 'jordan', 'dana']);

export const legacyAgentConfigV1Schema = z
  .object({
    persona: personaSchema,
    coo: safeRelativePathSchema,
    policy: safeRelativePathSchema,
    memory: safeRelativePathSchema,
  })
  .strict();

export const legacyRequesterDriverConfigV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('scripted'),
      script: safeRelativePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('model'),
      model: pactModelConfigV1Schema,
      agentConfig: legacyAgentConfigV1Schema,
    })
    .strict(),
]);

export const legacyTrajectoryConfigV1Schema = z
  .object({
    maxTicks: z.number().int().safe().min(1).max(MAX_LEGACY_MULTI_TICKS_V1),
    phase2StartTick: z.number().int().safe().min(2).max(MAX_LEGACY_MULTI_TICKS_V1).optional(),
    count: z.number().int().safe().min(1).max(240),
    maxRuntimeMs: z.number().int().safe().min(1_000).max(21_600_000),
    requesterDriver: legacyRequesterDriverConfigV1Schema,
  })
  .strict()
  .superRefine((trajectory, context) => {
    if (
      trajectory.phase2StartTick !== undefined
      && trajectory.phase2StartTick > trajectory.maxTicks
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phase2StartTick'],
        message: 'phase2StartTick must not exceed maxTicks',
      });
    }
  });

export const legacyMultiConfigV1Schema = z
  .object({
    apiVersion: z.literal(PACT_RUN_CONFIG_API_VERSION_V1),
    kind: z.literal('RunConfig'),
    backend: z.object({ kind: z.literal('local') }).strict(),
    model: pactModelConfigV1Schema,
    benchmark: z
      .object({
        dataset: z.literal('pact-pair'),
        policy: z.enum(PACT_PAIR_POLICIES_V1),
        requester: z.enum(PACT_PAIR_REQUESTERS_V1),
        gradingMode: z.enum(PACT_PAIR_GRADING_MODES_V1),
        tasks: pactTaskFilterV1Schema,
        execution: z
          .object({
            adapter: z.enum(['pact-public-runner', 'sharedos-embedded']),
          })
          .strict(),
        agentConfig: legacyAgentConfigV1Schema,
        trajectory: legacyTrajectoryConfigV1Schema,
      })
      .strict()
      .superRefine((benchmark, context) => {
        if (!benchmark.policy.startsWith('REL_')) return;
        const expectedRequester = benchmark.policy.slice('REL_'.length);
        if (benchmark.requester !== expectedRequester) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['requester'],
            message: `${benchmark.policy} must be paired with requester ${expectedRequester}`,
          });
        }
        if (benchmark.gradingMode !== 'relationship') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['gradingMode'],
            message: `${benchmark.policy} requires relationship grading`,
          });
        }
      }),
    budget: pactRunBudgetV1Schema,
    output: z
      .object({
        directory: safeRelativePathSchema,
        saveTraces: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type LegacyAgentConfigV1 = z.infer<typeof legacyAgentConfigV1Schema>;
export type LegacyRequesterDriverConfigV1 = z.infer<
  typeof legacyRequesterDriverConfigV1Schema
>;
export type LegacyTrajectoryConfigV1 = z.infer<typeof legacyTrajectoryConfigV1Schema>;
export type LegacyMultiConfigV1 = z.infer<typeof legacyMultiConfigV1Schema>;
export type ResolvedLegacyMultiConfigV1 = LegacyMultiConfigV1 & {
  sourcePath: string;
  configDirectory: string;
};
export type EffectiveLegacyMultiConfigV1 = LegacyMultiConfigV1 & {
  effectiveConfigDigest: string;
};

export type LegacyMultiOverridesV1 = {
  taskIds?: string[];
  maxTicks?: number;
};

export function parseLegacyMultiConfigV1Yaml(source: string): LegacyMultiConfigV1 {
  if (Buffer.byteLength(source, 'utf8') > MAX_PACT_RUN_CONFIG_BYTES_V1) {
    throw new Error(`Legacy multi config exceeds ${MAX_PACT_RUN_CONFIG_BYTES_V1} bytes`);
  }
  const documents = parseAllDocuments(source, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new Error('Legacy multi config must contain exactly one YAML document');
  }
  const [document] = documents;
  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('Legacy multi config is not valid YAML');
  }
  const input = document.toJS({ maxAliasCount: 0 }) as unknown;
  assertPactJsonComplexityV1(input, 'Legacy multi config');
  return legacyMultiConfigV1Schema.parse(input);
}

export async function loadLegacyMultiConfigV1(
  configPath: string,
): Promise<ResolvedLegacyMultiConfigV1> {
  const sourcePath = path.resolve(configPath);
  const source = await readFile(sourcePath, 'utf8');
  return {
    ...parseLegacyMultiConfigV1Yaml(source),
    sourcePath,
    configDirectory: path.dirname(sourcePath),
  };
}

export function applyLegacyMultiOverridesV1(
  config: LegacyMultiConfigV1,
  overrides: LegacyMultiOverridesV1 = {},
): EffectiveLegacyMultiConfigV1 {
  const taskIds = overrides.taskIds;
  if (taskIds && (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length)) {
    throw new Error('Legacy multi task overrides must be non-empty and unique');
  }
  const configuredIds = config.benchmark.tasks.ids;
  if (
    taskIds
    && configuredIds
    && (
      taskIds.length !== configuredIds.length
      || taskIds.some((taskId, index) => taskId !== configuredIds[index])
    )
  ) {
    throw new Error('Legacy multi command contradicts config task selection');
  }
  const maxTicks = overrides.maxTicks ?? config.benchmark.trajectory.maxTicks;
  if (!Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > MAX_LEGACY_MULTI_TICKS_V1) {
    throw new Error(`Legacy multi maxTicks must be between 1 and ${MAX_LEGACY_MULTI_TICKS_V1}`);
  }
  const parsed = legacyMultiConfigV1Schema.parse({
    ...config,
    benchmark: {
      ...config.benchmark,
      tasks: taskIds && !configuredIds
        ? { ...config.benchmark.tasks, ids: taskIds }
        : config.benchmark.tasks,
      trajectory: {
        ...config.benchmark.trajectory,
        maxTicks,
      },
    },
  });
  return {
    ...parsed,
    effectiveConfigDigest: digestLegacyConfigV1(parsed),
  };
}

export function validateLegacyPhaseBoundaryV1(
  config: Pick<LegacyMultiConfigV1, 'benchmark'>,
  selectedTaskIds: readonly string[],
): void {
  if (selectedTaskIds.length === 0 || new Set(selectedTaskIds).size !== selectedTaskIds.length) {
    throw new Error('Legacy multi selected tasks must be non-empty and unique');
  }
  const start = config.benchmark.trajectory.phase2StartTick;
  if (start !== undefined && start !== selectedTaskIds.length + 1) {
    throw new Error(
      'Legacy multi phase2StartTick must equal selected task count + 1',
    );
  }
}

export function digestLegacyConfigV1(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
