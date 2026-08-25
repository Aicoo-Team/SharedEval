import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { assertPactJsonComplexityV1, safeRelativePathSchema } from '../../protocol/v1/index.js';
import {
  pactExecutionBackendConfigV1Schema,
  pactModelConfigV1Schema,
  pactRunBudgetV1Schema,
  pactTaskFilterV1Schema,
} from './config.js';
import type { ResolvedSharedevalWorkflowV1, SharedevalWorkflowV1 } from './workflow.js';

export const SHAREDEVAL_RUN_CONFIG_API_VERSION_V1 = 'sharedeval-run/v1' as const;
export const MAX_SHAREDEVAL_RUN_CONFIG_BYTES_V1 = 256 * 1_024;
export const MAX_SHAREDEVAL_TICKS_V1 = 10_000;

export const sharedevalWorkflowV1Schema = z
  .object({
    mode: z.enum(['multi', 'single']),
    protocol: z.enum(['files', 'legacy-prompt', 'legacy-transcript']),
    maxTicks: z.number().int().safe().positive().max(MAX_SHAREDEVAL_TICKS_V1),
    stopWhen: z.literal('all-terminal'),
  })
  .strict()
  .superRefine((workflow, context) => {
    if (
      (workflow.mode === 'multi' && workflow.protocol === 'legacy-prompt')
      || (workflow.mode === 'single' && workflow.protocol === 'legacy-transcript')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocol'],
        message: 'workflow mode and protocol do not form a supported Sharedeval workflow',
      });
    }
  });

export const sharedevalRunConfigV1Schema = z
  .object({
    apiVersion: z.literal(SHAREDEVAL_RUN_CONFIG_API_VERSION_V1),
    kind: z.literal('RunConfig'),
    backend: pactExecutionBackendConfigV1Schema.optional(),
    model: pactModelConfigV1Schema,
    workflow: sharedevalWorkflowV1Schema,
    benchmark: z
      .object({
        dataset: z.enum(['pact-pair', 'pact-net']).default('pact-pair'),
        tasks: pactTaskFilterV1Schema,
      })
      .strict()
      .default({ dataset: 'pact-pair', tasks: { kind: 'all' } }),
    budget: pactRunBudgetV1Schema.default({
      maxTurns: 8,
      maxToolCalls: 4,
      maxRuntimeMs: 60_000,
    }),
    output: z
      .object({
        directory: safeRelativePathSchema.default('runs'),
        saveTraces: z.boolean().default(false),
      })
      .strict()
      .default({ directory: 'runs', saveTraces: false }),
  })
  .strict();

export type SharedevalRunConfigV1 = z.infer<typeof sharedevalRunConfigV1Schema>;
export type ResolvedSharedevalRunConfigV1 = SharedevalRunConfigV1 & {
  sourcePath: string;
  rootDir: string;
};
export type SharedevalCliOverridesV1 = {
  taskIds?: string[];
  maxTicks?: number;
};
export type EffectiveSharedevalRunConfigV1 = SharedevalRunConfigV1 & {
  workflow: SharedevalWorkflowV1 & { id: ResolvedSharedevalWorkflowV1['id'] };
  configDigest: string;
};

export function parseSharedevalRunConfigV1Yaml(source: string): SharedevalRunConfigV1 {
  return sharedevalRunConfigV1Schema.parse(inspectSharedevalRunConfigV1Yaml(source));
}

/**
 * Safely materializes a config document before protocol-specific validation.
 * The legacy gate uses this same bounded, strict parser instead of inspecting
 * YAML source text.
 */
export function inspectSharedevalRunConfigV1Yaml(source: string): unknown {
  if (Buffer.byteLength(source, 'utf8') > MAX_SHAREDEVAL_RUN_CONFIG_BYTES_V1) {
    throw new Error(
      `Sharedeval run config exceeds ${MAX_SHAREDEVAL_RUN_CONFIG_BYTES_V1} bytes`,
    );
  }
  const documents = parseAllDocuments(source, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new Error('Sharedeval run config must contain exactly one YAML document');
  }
  const [document] = documents;
  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('Sharedeval run config is not valid YAML');
  }
  const input = document.toJS({ maxAliasCount: 0 }) as unknown;
  assertPactJsonComplexityV1(input, 'Sharedeval run config');
  return input;
}

export async function loadSharedevalRunConfigV1(
  configPath: string,
): Promise<ResolvedSharedevalRunConfigV1> {
  const sourcePath = path.resolve(configPath);
  const source = await readFile(sourcePath, 'utf8');
  return {
    ...parseSharedevalRunConfigV1Yaml(source),
    sourcePath,
    rootDir: path.dirname(sourcePath),
  };
}

export function applySharedevalOverridesV1(
  config: SharedevalRunConfigV1,
  selectedWorkflow: ResolvedSharedevalWorkflowV1,
  overrides: SharedevalCliOverridesV1 = {},
): EffectiveSharedevalRunConfigV1 {
  if (
    config.workflow.mode !== selectedWorkflow.mode
    || config.workflow.protocol !== selectedWorkflow.protocol
    || config.workflow.stopWhen !== selectedWorkflow.stopWhen
  ) {
    throw new Error(
      `Sharedeval command contradicts config workflow: requested ${selectedWorkflow.id}`,
    );
  }
  const taskIds = overrides.taskIds;
  if (taskIds && config.benchmark.tasks.ids && !sameValues(taskIds, config.benchmark.tasks.ids)) {
    throw new Error('Sharedeval command contradicts config task selection');
  }
  const selectedTasks = taskIds && !config.benchmark.tasks.ids
    ? { ...config.benchmark.tasks, ids: taskIds }
    : config.benchmark.tasks;
  const tasks = pactTaskFilterV1Schema.parse(selectedTasks);
  const workflow = sharedevalWorkflowV1Schema.parse({
    ...config.workflow,
    ...(overrides.maxTicks === undefined ? {} : { maxTicks: overrides.maxTicks }),
  });
  const effective: Omit<EffectiveSharedevalRunConfigV1, 'configDigest'> = {
    ...config,
    workflow: { ...workflow, id: selectedWorkflow.id },
    benchmark: { ...config.benchmark, tasks },
  };
  return { ...effective, configDigest: digestSharedevalConfigV1(effective) };
}

export function digestSharedevalConfigV1(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
