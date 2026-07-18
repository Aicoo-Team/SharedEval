import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import {
  assertPactJsonComplexityV1,
  pactBudgetV1Schema,
  safeRelativePathSchema,
} from '../../protocol/v1/index.js';

export const PACT_RUN_CONFIG_API_VERSION_V1 = 'pact-run/v1' as const;
export const MAX_PACT_RUN_CONFIG_BYTES_V1 = 256 * 1_024;

// A config may choose an arbitrary model endpoint, so it must not also be able
// to select an arbitrary process secret (for example an AWS or GitHub token).
// Callers explicitly bind their provider credential to this dedicated alias.
export const PACT_MODEL_API_KEY_ENV_V1 = 'PACT_MODEL_API_KEY' as const;

const providerBaseUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must use http or https',
      });
    }
    if (
      url.protocol === 'http:'
      && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plain HTTP is allowed only for loopback model endpoints',
      });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not contain credentials',
      });
    }
    if (url.search || url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not contain a query string or fragment',
      });
    }
    if (/\/chat\/completions\/?$/i.test(url.pathname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be an API base URL, not the chat completions endpoint',
      });
    }
  })
  .transform(value => value.replace(/\/+$/, ''));

export const pactOpenAICompatibleModelConfigV1Schema = z
  .object({
    provider: z.literal('openai-compatible'),
    baseUrl: providerBaseUrlSchema,
    apiKeyEnv: z.literal(PACT_MODEL_API_KEY_ENV_V1),
    model: z.string().trim().min(1).max(256),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536).default(4_096),
  })
  .strict();

export const pactTaskFilterV1Schema = z
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

// The local runner can enforce these three budgets exactly. Token and cost
// accounting vary across compatible providers, so accepting them here would
// falsely imply enforcement.
export const pactRunBudgetV1Schema = pactBudgetV1Schema.pick({
  maxTurns: true,
  maxToolCalls: true,
  maxRuntimeMs: true,
});

export const pactRunConfigV1Schema = z
  .object({
    apiVersion: z.literal(PACT_RUN_CONFIG_API_VERSION_V1),
    kind: z.literal('RunConfig'),
    model: pactOpenAICompatibleModelConfigV1Schema,
    benchmark: z
      .object({
        policy: z.enum(['D0', 'D1', 'D2', 'D3', 'D4', 'D5']).default('D2'),
        requester: z.enum(['R0', 'R1', 'R2', 'R3', 'R4']).default('R1'),
        tasks: pactTaskFilterV1Schema,
      })
      .strict()
      .default({ policy: 'D2', requester: 'R1', tasks: { kind: 'all' } }),
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

export type PactOpenAICompatibleModelConfigV1 = z.infer<
  typeof pactOpenAICompatibleModelConfigV1Schema
>;
export type PactTaskFilterV1 = z.infer<typeof pactTaskFilterV1Schema>;
export type PactRunConfigV1 = z.infer<typeof pactRunConfigV1Schema>;

export type ResolvedPactRunConfigV1 = PactRunConfigV1 & {
  sourcePath: string;
  rootDir: string;
};

export function parsePactRunConfigV1Yaml(source: string): PactRunConfigV1 {
  if (Buffer.byteLength(source, 'utf8') > MAX_PACT_RUN_CONFIG_BYTES_V1) {
    throw new Error(`PACT run config exceeds ${MAX_PACT_RUN_CONFIG_BYTES_V1} bytes`);
  }

  const documents = parseAllDocuments(source, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new Error('PACT run config must contain exactly one YAML document');
  }

  const [document] = documents;
  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('PACT run config is not valid YAML');
  }

  const input = document.toJS({ maxAliasCount: 0 }) as unknown;
  assertPactJsonComplexityV1(input, 'PACT run config');
  return pactRunConfigV1Schema.parse(input);
}

export async function loadPactRunConfigV1(
  configPath: string,
): Promise<ResolvedPactRunConfigV1> {
  const sourcePath = path.resolve(configPath);
  const source = await readFile(sourcePath, 'utf8');
  return {
    ...parsePactRunConfigV1Yaml(source),
    sourcePath,
    rootDir: path.dirname(sourcePath),
  };
}

export function resolvePactRunModelApiKeyV1(
  config: Pick<PactRunConfigV1, 'model'>,
  environment: Record<string, string | undefined> = process.env,
): string {
  const apiKey = environment[config.model.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `Model credential environment variable ${config.model.apiKeyEnv} is not set`,
    );
  }
  return apiKey;
}
