import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import {
  assertJsonComplexityV1,
  safeRelativePathSchema,
} from '../../contracts/json.js';
import { pactModelConfigV1Schema } from './model-config.js';
import { worldProfileSchema } from '../world/profile.js';
import { fileMultiTurnSchema, isFirstAskCoverageV2 } from './file-multi-turn.js';
import {
  PACT_PAIR_GRADING_MODES_V1,
  PACT_PAIR_POLICIES_V1,
  PACT_REQUESTER_IDS_V1,
} from '../../suites/pact-pair/task-loader.js';
import type {
  ResolvedSharedevalWorkflowV1,
  SharedevalWorkflowV1,
} from './workflow.js';

export const SHAREDEVAL_RUN_CONFIG_API_VERSION_V1 = 'sharedeval-run/v1' as const;
export const SHAREDEVAL_RUN_CONFIG_API_VERSION_V2 = 'sharedeval-run/v2' as const;
export const MAX_SHAREDEVAL_RUN_CONFIG_BYTES_V1 = 256 * 1_024;
export const MAX_SHAREDEVAL_TICKS_V1 = 10_000;
export const MIN_SHAREDEVAL_TOOL_CALLS_V1 = 6;
export const MAX_SHAREDEVAL_TOOL_CALLS_V1 = 128;
export const MAX_SHAREDEVAL_RUNTIME_MS_V1 = 600_000;
export const MAX_SHAREDEVAL_TASK_CONCURRENCY_V1 = 32;

// The multi-turn probe protocol gate. Absent means the files-multi workflow
// behaves exactly as today and the configDigest of pre-existing configs is
// unchanged byte for byte; present, it parameterizes the trajectory phases.
export const sharedevalMultiTurnV1Schema = fileMultiTurnSchema;

export type SharedevalMultiTurnV1 = z.infer<typeof sharedevalMultiTurnV1Schema>;

export const sharedevalWorkflowV1Schema = z
  .object({
    mode: z.enum(['multi', 'single']),
    protocol: z.literal('files'),
    maxTicks: z.number().int().safe().positive().max(MAX_SHAREDEVAL_TICKS_V1),
    stopWhen: z.literal('all-terminal'),
    // Absent means 1 and stays absent so pre-existing configs keep their
    // configDigest; a written value, 1 included, is part of the identity.
    taskConcurrency: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(MAX_SHAREDEVAL_TASK_CONCURRENCY_V1)
      .optional(),
    multiTurn: sharedevalMultiTurnV1Schema.optional(),
    // Capability profile. Absent means 'strict' and stays absent, so every
    // pre-existing config keeps its configDigest byte for byte. 'simple'
    // gives the responder one standing capability set for all tasks: PACT-Pair
    // measures the disclosure decision, not whether the datastore is reachable.
    pairProfile: z.enum(['strict', 'simple']).optional(),
  })
  .strict()
  .superRefine(validateWorkflow);

function validateWorkflow(
  workflow: { mode: 'multi' | 'single'; taskConcurrency?: number; maxTicks: number;
    multiTurn?: SharedevalMultiTurnV1 },
  context: z.RefinementCtx,
) {
  if (workflow.mode === 'multi' && (workflow.taskConcurrency ?? 1) > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['taskConcurrency'],
      message: 'taskConcurrency applies only to the single workflow',
    });
  }
  if (!workflow.multiTurn) return;
  if (workflow.mode !== 'multi') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['multiTurn'],
      message: 'multiTurn applies only to the multi workflow',
    });
    return;
  }
  if (!isFirstAskCoverageV2(workflow.multiTurn)
    && workflow.multiTurn.phase2StartTick > workflow.multiTurn.finalizeTick) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['multiTurn', 'finalizeTick'],
      message: 'finalizeTick must be at or after phase2StartTick',
    });
  }
  if (workflow.multiTurn.finalizeTick > workflow.maxTicks) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['multiTurn', 'finalizeTick'],
      message: 'finalizeTick must not exceed maxTicks',
    });
  }
}

export const sharedevalWorkflowV2Schema = sharedevalWorkflowV1Schema.innerType()
  .extend({
    mode: z.enum(['multi', 'single']).default('multi'),
    world: worldProfileSchema.default({}),
  })
  .superRefine(validateWorkflow);

export const sharedevalTaskSelectionV1Schema = z
  .object({
    kind: z.enum(['all', 'qa', 'action']).default('all'),
    ids: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/, 'must be a valid task identifier'),
      )
      .min(1)
      .max(10_000)
      .refine(ids => new Set(ids).size === ids.length, {
        message: 'task ids must be unique',
      })
      .optional(),
    limit: z.number().int().safe().positive().max(10_000).optional(),
  })
  .strict()
  .default({ kind: 'all' });

export const sharedevalRuntimeBudgetV1Schema = z
  .object({
    maxToolCalls: z
      .number()
      .int()
      .safe()
      .min(MIN_SHAREDEVAL_TOOL_CALLS_V1)
      .max(MAX_SHAREDEVAL_TOOL_CALLS_V1)
      .default(8),
    maxRuntimeMs: z
      .number()
      .int()
      .safe()
      .positive()
      .max(MAX_SHAREDEVAL_RUNTIME_MS_V1)
      .default(60_000),
  })
  .strict()
  .default({ maxToolCalls: 8, maxRuntimeMs: 60_000 });

export const sharedevalBenchmarkV1Schema = z.object({
  // pact-net selects PACT-Net v2 disclosure probes instead of PACT-Pair QA items.
  // Probe ids go in tasks.ids, and every probe in one run must share a responder,
  // because a session seats exactly one responder agent.
  dataset: z.enum(['pact-pair', 'pact-net']).default('pact-pair'),
  policy: z.enum(PACT_PAIR_POLICIES_V1).default('D2'),
  requester: z.enum(PACT_REQUESTER_IDS_V1).default('R1'),
  gradingMode: z.enum(PACT_PAIR_GRADING_MODES_V1).default('category'),
  /**
   * pact-net only: also seat probes whose forbidden fact names a class rather
   * than quoting a value. Their rows come back `scorable: false` and enter no
   * rate -- the run exists to collect transcripts for a judge. 47 of 51 probes
   * are in that state, so this is how the main population gets run at all.
   *
   * Optional rather than defaulted on purpose. A defaulted field materialises
   * into every serialised config, which changes the bytes of configs nobody
   * meant to touch -- the frozen preflight manifests are pinned by sha256 and
   * would all have moved.
   */
  rubricProbes: z.boolean().optional(),
  tasks: sharedevalTaskSelectionV1Schema,
}).strict().superRefine((benchmark, context) => {
  if (!benchmark.policy.startsWith('REL_')) return;
  const requester = benchmark.policy.slice('REL_'.length);
  if (benchmark.requester !== requester) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requester'],
      message: `${benchmark.policy} must be paired with requester ${requester}`,
    });
  }
  if (benchmark.gradingMode !== 'relationship') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gradingMode'],
      message: `${benchmark.policy} requires relationship grading`,
    });
  }
}).default({
  dataset: 'pact-pair',
  policy: 'D2',
  requester: 'R1',
  gradingMode: 'category',
  tasks: { kind: 'all' },
});

export const sharedevalRunConfigV1Schema = z
  .object({
    apiVersion: z.literal(SHAREDEVAL_RUN_CONFIG_API_VERSION_V1),
    kind: z.literal('RunConfig'),
    model: pactModelConfigV1Schema,
    workflow: sharedevalWorkflowV1Schema,
    benchmark: sharedevalBenchmarkV1Schema,
    budget: sharedevalRuntimeBudgetV1Schema,
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
export const sharedevalRunConfigV2Schema = sharedevalRunConfigV1Schema.extend({
  apiVersion: z.literal(SHAREDEVAL_RUN_CONFIG_API_VERSION_V2),
  workflow: sharedevalWorkflowV2Schema,
});
export type SharedevalRunConfigV2 = z.infer<typeof sharedevalRunConfigV2Schema>;
export type SharedevalRunConfig = (SharedevalRunConfigV1 | SharedevalRunConfigV2)
  & Readonly<{ workflow: SharedevalWorkflowV1 }>;
export type ResolvedSharedevalRunConfigV1 = SharedevalRunConfig & Readonly<{
  sourcePath: string;
  rootDir: string;
}>;
export type SharedevalCliOverridesV1 = Readonly<{
  taskIds?: string[];
  maxTicks?: number;
}>;
export type EffectiveSharedevalRunConfigV1 = Omit<SharedevalRunConfig, 'workflow'> & Readonly<{
  workflow: z.infer<typeof sharedevalWorkflowV1Schema> & SharedevalWorkflowV1
    & { id: ResolvedSharedevalWorkflowV1['id'] };
  configDigest: string;
}>;

export function parseSharedevalRunConfigV1Yaml(source: string): SharedevalRunConfigV1 {
  return sharedevalRunConfigV1Schema.parse(inspectSharedevalRunConfigV1Yaml(source));
}

export function parseSharedevalRunConfigYaml(source: string): SharedevalRunConfig {
  return z.discriminatedUnion('apiVersion', [
    sharedevalRunConfigV1Schema,
    sharedevalRunConfigV2Schema,
  ]).parse(inspectSharedevalRunConfigV1Yaml(source));
}

/** Safely materializes one bounded YAML document before schema validation. */
export function inspectSharedevalRunConfigV1Yaml(source: string): unknown {
  if (Buffer.byteLength(source, 'utf8') > MAX_SHAREDEVAL_RUN_CONFIG_BYTES_V1) {
    throw new Error('Sharedeval run configuration is too large');
  }
  const documents = parseAllDocuments(source, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new Error('Sharedeval run configuration must contain one YAML document');
  }
  const [document] = documents;
  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('Sharedeval run configuration is invalid YAML');
  }
  const input = document.toJS({ maxAliasCount: 0 }) as unknown;
  assertJsonComplexityV1(input, 'Sharedeval run configuration');
  return input;
}

export async function loadSharedevalRunConfigV1(
  configPath: string,
): Promise<ResolvedSharedevalRunConfigV1> {
  const sourcePath = path.resolve(configPath);
  let source: string;
  try {
    source = await readFile(sourcePath, 'utf8');
  } catch {
    throw new Error('Unable to read Sharedeval run configuration');
  }
  return {
    ...parseSharedevalRunConfigYaml(source),
    sourcePath,
    rootDir: path.dirname(sourcePath),
  };
}

export function applySharedevalOverridesV1(
  config: SharedevalRunConfig,
  selectedWorkflow: ResolvedSharedevalWorkflowV1,
  overrides: SharedevalCliOverridesV1 = {},
): EffectiveSharedevalRunConfigV1 {
  if (
    config.workflow.mode !== selectedWorkflow.mode
    || config.workflow.protocol !== selectedWorkflow.protocol
    || config.workflow.stopWhen !== selectedWorkflow.stopWhen
  ) {
    throw new Error('Sharedeval command contradicts config workflow');
  }

  const taskIds = overrides.taskIds;
  if (taskIds && config.benchmark.tasks.ids && !sameValues(taskIds, config.benchmark.tasks.ids)) {
    throw new Error('Sharedeval command contradicts config task selection');
  }
  const selectedTasks = taskIds
    ? { kind: config.benchmark.tasks.kind, ids: taskIds }
    : config.benchmark.tasks;
  const tasks = sharedevalTaskSelectionV1Schema.parse(selectedTasks);
  const workflowSchema = config.apiVersion === SHAREDEVAL_RUN_CONFIG_API_VERSION_V2
    ? sharedevalWorkflowV2Schema : sharedevalWorkflowV1Schema;
  const workflow = workflowSchema.parse({
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

function sameValues(left: readonly string[], right: readonly string[]): boolean {
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
