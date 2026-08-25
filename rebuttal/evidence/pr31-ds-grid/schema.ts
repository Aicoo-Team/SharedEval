import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  pactRunConfigV1Schema,
  type PactRunConfigV1,
} from '../../../src/runner/v1/config.js';
import { inspectPactBenchmarkV1 } from '../../../src/runner/v1/runner.js';

const protocolSchema = z.literal('legacy-single-prompt');
const statusSchema = z.literal('historical');
const completenessSchema = z.literal('incomplete');
const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const requesterSchema = z.enum(['R0', 'R1', 'R2', 'R3', 'R4']);

const historicalLabels = {
  protocol: protocolSchema,
  status: statusSchema,
  completeness: completenessSchema,
} as const;

export const pr31ConfigurationSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_]+$/),
    ...historicalLabels,
    sourcePath: z
      .string()
      .regex(/^rebuttal\/runs\/configs_ds_grid\/[A-Za-z0-9_]+\.yaml$/),
    sourceBlobSha: sha1Schema,
    sourceSha256: sha256Schema,
    policy: z.string().regex(/^[A-Z0-9_]+$/),
    requester: requesterSchema,
    gradingMode: z.enum(['category', 'relationship']),
    taskKind: z.enum(['all', 'qa', 'action']),
    taskIds: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[QA0-9,-]+$/)
      .nullable(),
    taskCount: z.number().int().positive().max(600),
    taskSelectionSha256: sha256Schema,
    disposition: z.enum(['executable-current-main', 'historical-only']),
  })
  .strict();

const exclusionSchema = z
  .object({
    category: z.string().regex(/^[a-z-]+$/),
    count: z.number().int().positive(),
    paths: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(64),
    reason: z.string().min(1).max(512),
  })
  .strict();

export const pr31ManifestSchema = z
  .object({
    schemaVersion: z.literal('pact-pr31-historical-evidence/v1'),
    ...historicalLabels,
    source: z
      .object({
        repository: z.literal('xisen-w/PACT'),
        pullRequest: z.literal(31),
        url: z.literal('https://github.com/xisen-w/PACT/pull/31'),
        head: z.literal('c86dc8a49cae12129d4d991b9691142a3357f463'),
        base: z.literal('d195d4529966ecf32ee734abe35d90cf191c6967'),
        reviewedAgainstMain: z.literal(
          '514dd9c535481b3c4521f4871b082c8a1ca6d9e6',
        ),
        changedFiles: z.literal(106),
        sourceFileSetSha256: z.literal(
          '14b837cf401e2b33e1c183538c5fd0a4eced9a58d17b216a4ef7575856f2e369',
        ),
        preservedConfigurationsSha256: z.literal(
          '1ac16d62e5339c02551ade52ecf086c40f12495b394313b02bcf70e66e11747d',
        ),
      })
      .strict(),
    reportedRuntime: z
      .object({
        ...historicalLabels,
        sharedOsRevision: z.literal('846cbf6'),
        revisionForm: z.literal('abbreviated-as-reported'),
        verification: z.literal('not-independently-verified'),
      })
      .strict(),
    sourceInventory: z
      .object({
        configurations: z.literal(50),
        preservedConfigurationRecords: z.literal(49),
        executableCurrentMain: z.literal(32),
        historicalOnly: z.literal(17),
        aggregateSources: z.literal(1),
        excludedArtifacts: z.literal(56),
      })
      .strict(),
    configurations: z.array(pr31ConfigurationSchema).length(49),
    exclusions: z.array(exclusionSchema).min(1).max(16),
  })
  .strict();

const percentSchema = z.number().finite().min(0).max(100);
const countSchema = z.number().int().nonnegative().max(10_000);

const qaAggregateSchema = z
  .object({
    utility_L: percentSchema,
    overRefusal_L: percentSchema,
    disclosure_P: percentSchema,
    answeredProtected_P: percentSchema,
    denominators: z
      .object({
        L: countSchema,
        L_scorable: countSchema,
        P: countSchema,
      })
      .strict(),
    infraErrors: countSchema,
  })
  .strict();

const actionAggregateSchema = z
  .object({
    executeCorrect: percentSchema.nullable(),
    executeRefusedInstead: percentSchema.nullable(),
    refuseSafe: percentSchema,
    unsafeMutations: countSchema,
    denominators: z
      .object({
        execute: countSchema,
        refuse: countSchema,
      })
      .strict(),
    infraErrors: countSchema,
  })
  .strict();

export const pr31AggregateRecordSchema = z
  .object({
    id: z.string().regex(/^[A-Z0-9_]+:R[0-4]$/),
    ...historicalLabels,
    policy: z.string().regex(/^[A-Z0-9_]+$/),
    requester: requesterSchema,
    qa: qaAggregateSchema,
    actions: actionAggregateSchema,
  })
  .strict();

export const pr31AggregatesSchema = z
  .object({
    schemaVersion: z.literal('pact-pr31-sanitized-aggregates/v1'),
    ...historicalLabels,
    source: z
      .object({
        path: z.literal('rebuttal/runs/configs_ds_grid/rescore_v2_3arms.json'),
        gitBlobSha: z.literal('4c8a187721c85fecc203bf6af4214930467acf02'),
        sha256: z.literal(
          'cb77e31192b5e60ca7f914a0b66664fe31b664eeacb523044bac5719a595b11d',
        ),
      })
      .strict(),
    records: z.array(pr31AggregateRecordSchema).length(16),
  })
  .strict();

export type Pr31Configuration = z.infer<typeof pr31ConfigurationSchema>;
export type Pr31Manifest = z.infer<typeof pr31ManifestSchema>;
export type Pr31Aggregates = z.infer<typeof pr31AggregatesSchema>;

function readJson(path: string): unknown {
  const source = readFileSync(path, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > 1_048_576) {
    throw new Error('evidence file is oversized');
  }
  return JSON.parse(source) as unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function expandPr31TaskIds(spec: string | null): string[] | undefined {
  if (spec === null) return undefined;
  const result: string[] = [];
  for (const token of spec.split(',')) {
    const single = /^([QA])(\d+)$/.exec(token);
    if (single) {
      result.push(token);
      continue;
    }
    const range = /^([QA])(\d+)-\1(\d+)$/.exec(token);
    if (!range) throw new Error('invalid compact task selection');
    const start = Number(range[2]);
    const end = Number(range[3]);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 1
      || end < start
      || end - start > 10_000
    ) {
      throw new Error('invalid compact task range');
    }
    for (let value = start; value <= end; value += 1) {
      result.push(`${range[1]}${value}`);
    }
  }
  if (new Set(result).size !== result.length) {
    throw new Error('duplicate compact task ids');
  }
  return result;
}

function taskSelection(row: Pr31Configuration) {
  const ids = expandPr31TaskIds(row.taskIds);
  return ids ? { kind: row.taskKind, ids } : { kind: row.taskKind };
}

function rawSanitizedConfig(row: Pr31Configuration): unknown {
  return {
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'deepseek/deepseek-v4-flash-0731',
      temperature: 0,
      providerRouting: {
        requireParameters: true,
        allowFallbacks: false,
        only: ['relace', 'baidu'],
      },
      maxOutputTokens: 4_096,
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: row.policy,
      requester: row.requester,
      gradingMode: row.gradingMode,
      execution: { adapter: 'sharedos-embedded' },
      tasks: taskSelection(row),
    },
    budget: {
      maxTurns: 8,
      maxToolCalls: 4,
      maxRuntimeMs: 120_000,
    },
    output: {
      directory: `runs/pr31-ds-grid/${row.id}`,
      saveTraces: false,
    },
  };
}

export function buildPr31SanitizedConfig(
  row: Pr31Configuration,
): PactRunConfigV1 {
  if (row.disposition !== 'executable-current-main') {
    throw new Error('historical-only configuration is not executable');
  }
  return pactRunConfigV1Schema.parse(rawSanitizedConfig(row));
}

function validateManifest(manifest: Pr31Manifest): void {
  const ids = manifest.configurations.map(row => row.id);
  if (new Set(ids).size !== ids.length || ids.join('\n') !== [...ids].sort().join('\n')) {
    throw new Error('configuration ids must be unique and sorted');
  }
  if (ids.includes('smoke_R1')) {
    throw new Error('superseded smoke configuration is present');
  }
  const preservedConfigurationRecords = manifest.configurations.map(row => [
    row.id,
    row.sourcePath,
    row.sourceBlobSha,
    row.sourceSha256,
    row.policy,
    row.requester,
    row.gradingMode,
    row.taskKind,
    row.taskIds,
    row.taskCount,
    row.taskSelectionSha256,
    row.disposition,
  ]);
  if (
    sha256(JSON.stringify(preservedConfigurationRecords))
    !== manifest.source.preservedConfigurationsSha256
  ) {
    throw new Error('preserved configuration inventory checksum mismatch');
  }

  let executable = 0;
  let historicalOnly = 0;
  for (const row of manifest.configurations) {
    if (row.sourcePath !== `rebuttal/runs/configs_ds_grid/${row.id}.yaml`) {
      throw new Error('configuration source path does not match its id');
    }
    const selection = taskSelection(row);
    if (sha256(JSON.stringify(selection)) !== row.taskSelectionSha256) {
      throw new Error('task selection checksum mismatch');
    }
    const idsForRow = selection.ids;
    const expectedCount = idsForRow?.length
      ?? (row.taskKind === 'qa' ? 400 : row.taskKind === 'action' ? 200 : 600);
    if (expectedCount !== row.taskCount) {
      throw new Error('task selection count mismatch');
    }

    if (row.disposition === 'executable-current-main') {
      executable += 1;
      const config = buildPr31SanitizedConfig(row);
      const inspected = inspectPactBenchmarkV1(config);
      if (inspected.taskCount !== row.taskCount) {
        throw new Error('current-main task inspection count mismatch');
      }
      if (config.output.saveTraces || !config.output.directory.startsWith('runs/')) {
        throw new Error('sanitized output contract mismatch');
      }
    } else {
      historicalOnly += 1;
      if (!['D2R_PRINCIPLES', 'D6_PRINCIPLES_TIGHT'].includes(row.policy)) {
        throw new Error('historical-only policy is not allowlisted');
      }
      if (pactRunConfigV1Schema.safeParse(rawSanitizedConfig(row)).success) {
        throw new Error('historical-only policy became executable');
      }
    }
  }
  if (executable !== 32 || historicalOnly !== 17) {
    throw new Error('configuration disposition count mismatch');
  }

  const excluded = manifest.exclusions.flatMap(group => {
    if (group.paths.length !== group.count) {
      throw new Error('exclusion count mismatch');
    }
    return group.paths;
  });
  if (excluded.length !== 56 || new Set(excluded).size !== 56) {
    throw new Error('excluded source inventory mismatch');
  }
  if (manifest.configurations.length + 1 + excluded.length !== 106) {
    throw new Error('source inventory does not account for all PR files');
  }
  const sourcePaths = [
    ...manifest.configurations.map(row => row.sourcePath),
    'rebuttal/runs/configs_ds_grid/rescore_v2_3arms.json',
    ...excluded,
  ].sort();
  if (sha256(sourcePaths.join('\n')) !== manifest.source.sourceFileSetSha256) {
    throw new Error('source file-set checksum mismatch');
  }
}

const expectedAggregateIds = [
  'D2_SUBMITTED:R0',
  'D2_SUBMITTED:R1',
  'D2_SUBMITTED:R2',
  'D2_SUBMITTED:R3',
  'D2_SUBMITTED:R4',
  'D0:R0',
  'D0:R1',
  'D0:R2',
  'D0:R3',
  'D0:R4',
  'D2R_PRINCIPLES:R0',
  'D2R_PRINCIPLES:R1',
  'D2R_PRINCIPLES:R2',
  'D2R_PRINCIPLES:R3',
  'D2R_PRINCIPLES:R4',
  'D6_PRINCIPLES_TIGHT:R4',
] as const;

function validateAggregates(aggregates: Pr31Aggregates): void {
  const ids = aggregates.records.map(row => row.id);
  if (ids.join('\n') !== expectedAggregateIds.join('\n')) {
    throw new Error('aggregate record order or membership mismatch');
  }
  for (const row of aggregates.records) {
    if (row.id !== `${row.policy}:${row.requester}`) {
      throw new Error('aggregate identity mismatch');
    }
  }
}

export function loadAndValidatePr31Evidence(
  manifestPath: string,
  aggregatesPath: string,
): { manifest: Pr31Manifest; aggregates: Pr31Aggregates } {
  const manifest = pr31ManifestSchema.parse(readJson(manifestPath));
  const aggregates = pr31AggregatesSchema.parse(readJson(aggregatesPath));
  validateManifest(manifest);
  validateAggregates(aggregates);
  return { manifest, aggregates };
}
