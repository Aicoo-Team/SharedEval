import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import {
  assertPactJsonComplexityV1,
  pactBudgetV1Schema,
  safeRelativePathSchema,
} from '../../protocol/v1/index.js';
import {
  PACT_PAIR_GRADING_MODES_V1,
  PACT_PAIR_POLICIES_V1,
  PACT_PAIR_REQUESTERS_V1,
} from './task-loader.js';

export const PACT_RUN_CONFIG_API_VERSION_V1 = 'pact-run/v1' as const;
export const PACT_BUILTIN_DATASET_ID_V1 = 'pact-pair' as const;
export const MAX_PACT_RUN_CONFIG_BYTES_V1 = 256 * 1_024;

// A config may choose an arbitrary model endpoint, so it must not also be able
// to select an arbitrary process secret (for example an AWS or GitHub token).
// Callers explicitly bind their provider credential to this dedicated alias.
export const PACT_MODEL_API_KEY_ENV_V1 = 'PACT_MODEL_API_KEY' as const;

const providerSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'must be a valid provider slug');

export const pactProviderRoutingV1Schema = z
  .object({
    requireParameters: z.boolean().optional(),
    allowFallbacks: z.boolean().optional(),
    order: z.array(providerSlugSchema).min(1).max(32).refine(
      values => new Set(values).size === values.length,
      { message: 'provider order entries must be unique' },
    ).optional(),
    only: z.array(providerSlugSchema).min(1).max(32).refine(
      values => new Set(values).size === values.length,
      { message: 'allowed providers must be unique' },
    ).optional(),
  })
  .strict()
  .superRefine((routing, context) => {
    if (Object.values(routing).every(value => value === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provider routing must set at least one control',
      });
    }
    if (routing.only && routing.order) {
      const allowed = new Set(routing.only);
      const disallowed = routing.order.filter(provider => !allowed.has(provider));
      if (disallowed.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['order'],
          message: `provider order contains entries outside only: ${disallowed.join(', ')}`,
        });
      }
    }
  });

export const pactReasoningV1Schema = z
  .object({
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'max']),
  })
  .strict();

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
    seed: z.number().int().safe().optional(),
    reasoning: pactReasoningV1Schema.optional(),
    providerRouting: pactProviderRoutingV1Schema.optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536).default(4_096),
  })
  .strict();

// Azure's v1 API (an endpoint ending in `/openai/v1`) is OpenAI-compatible: the
// deployment is named in the request body and the path is the standard
// `/chat/completions`, so only the auth differs — an `api-key` header (Azure's
// key auth) rather than a bearer token. The endpoint is validated on its own
// (https-only, must end in `/openai/v1` so the resource/foundry endpoint is used
// rather than the project endpoint or a full completions URL) and the credential
// resolves from PACT_MODEL_API_KEY at request time, so no credential or query
// string is ever embedded in user config, images, logs, or artifacts.
const azureOpenAIEndpointSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must use https' });
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
    if (!/\/openai\/v1\/?$/.test(url.pathname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be an Azure OpenAI v1 endpoint ending in /openai/v1',
      });
    }
  })
  .transform(value => value.replace(/\/+$/, ''));

export const pactAzureOpenAIModelConfigV1Schema = z
  .object({
    provider: z.literal('azure-openai'),
    endpoint: azureOpenAIEndpointSchema,
    deployment: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._-]+$/, 'must be a valid Azure deployment name'),
    // The v1 API is GA without a version. Set "preview" (or a dated preview) only
    // if the deployment needs preview-only features; it is appended as the
    // api-version query parameter when present.
    apiVersion: z
      .string()
      .trim()
      .regex(
        /^(?:\d{4}-\d{2}-\d{2}(?:-preview)?|preview)$/,
        'must be an Azure api-version, e.g. 2024-10-21 or preview',
      )
      .optional(),
    apiKeyEnv: z.literal(PACT_MODEL_API_KEY_ENV_V1),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536).default(4_096),
  })
  .strict();

export const pactModelConfigV1Schema = z.discriminatedUnion('provider', [
  pactOpenAICompatibleModelConfigV1Schema,
  pactAzureOpenAIModelConfigV1Schema,
]);

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

/**
 * Which execution substrate runs each trial's agent turn.
 *
 * - `pact-public-runner` (default): the in-repository tool loop in
 *   `runSinglePactPairTaskV1` — the public benchmark path.
 * - `sharedos-embedded`: every turn executes through the real SharedOS
 *   permission kernel (`EmbeddedSharedOsAdapterV1`); requires a built
 *   SharedOS checkout reachable via `PACT_SHAREDOS_DIR`.
 *
 * The default stays `pact-public-runner` until full 600-task parity between
 * the two paths has been demonstrated; batch runs opt in explicitly. Never
 * combine absolute outcome rates across adapters without demonstrated
 * equivalence.
 */
export const pactExecutionAdapterIdV1Schema = z.enum([
  'pact-public-runner',
  'sharedos-embedded',
]);
export type PactExecutionAdapterIdV1 = z.infer<typeof pactExecutionAdapterIdV1Schema>;

export const pactExecutionConfigV1Schema = z
  .object({
    adapter: pactExecutionAdapterIdV1Schema.default('pact-public-runner'),
  })
  .strict();

/**
 * Multi-attempt requester protocol ("attacker" persistence): after a
 * responder-level terminal refusal or escalation, the requester renews the
 * ask with a scripted follow-up message and the trial continues in the same
 * conversation, workspace, and grant set — up to `max` attempts total.
 *
 * Retries are host-side PACT orchestration only. They never widen the
 * principal, patch a grant, or re-run a kernel-denied turn; a SharedOS
 * `denied` status, budget exhaustion, and infrastructure errors all end the
 * task without further attempts (see docs/multi-attempt-requester.md).
 */
export const pactAttemptsConfigV1Schema = z
  .object({
    max: z.number().int().min(1).max(3),
  })
  .strict();
export type PactAttemptsConfigV1 = z.infer<typeof pactAttemptsConfigV1Schema>;

export const pactExecutionBackendConfigV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('local'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('harbor'),
      concurrency: z.number().int().safe().min(1).max(256).default(4),
    })
    .strict(),
]);

export const pactRunConfigV1Schema = z
  .object({
    apiVersion: z.literal(PACT_RUN_CONFIG_API_VERSION_V1),
    kind: z.literal('RunConfig'),
    // Kept optional in the parsed representation so existing configurations
    // retain their byte-identical reproducibility digest. Absence selects the
    // local backend through selectedPactExecutionBackendV1 below.
    backend: pactExecutionBackendConfigV1Schema.optional(),
    model: pactModelConfigV1Schema,
    benchmark: z
      .object({
        dataset: z.literal(PACT_BUILTIN_DATASET_ID_V1).default(PACT_BUILTIN_DATASET_ID_V1),
        policy: z.enum(PACT_PAIR_POLICIES_V1).default('D2'),
        requester: z.enum(PACT_PAIR_REQUESTERS_V1).default('R1'),
        gradingMode: z.enum(PACT_PAIR_GRADING_MODES_V1).default('category'),
        tasks: pactTaskFilterV1Schema,
        // Kept optional (no default in the parsed representation) so existing
        // configurations retain their byte-identical reproducibility digest;
        // absence selects pact-public-runner through
        // selectedPactExecutionAdapterV1 below.
        execution: pactExecutionConfigV1Schema.optional(),
        // Kept optional for the same digest-stability reason; absence selects
        // the single-attempt protocol through selectedPactAttemptLimitV1
        // below, and single-attempt artifacts stay byte-identical.
        attempts: pactAttemptsConfigV1Schema.optional(),
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
        if (benchmark.tasks.kind !== 'qa') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', 'kind'],
            message: `${benchmark.policy} is validated only for QA tasks`,
          });
        }
      })
      .default({
        dataset: PACT_BUILTIN_DATASET_ID_V1,
        policy: 'D2',
        requester: 'R1',
        gradingMode: 'category',
        tasks: { kind: 'all' },
      }),
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
export type PactAzureOpenAIModelConfigV1 = z.infer<
  typeof pactAzureOpenAIModelConfigV1Schema
>;
export type PactModelConfigV1 = z.infer<typeof pactModelConfigV1Schema>;
export type PactExecutionBackendConfigV1 = z.infer<
  typeof pactExecutionBackendConfigV1Schema
>;

/**
 * The model/deployment identifier used in request bodies, run metadata, and the
 * --check summary. For Azure the deployment name is the load-bearing identifier
 * (the model is chosen by URL), so there is no separate `model` field.
 */
export function pactModelIdentifierV1(model: PactModelConfigV1): string {
  return model.provider === 'azure-openai' ? model.deployment : model.model;
}
export type PactTaskFilterV1 = z.infer<typeof pactTaskFilterV1Schema>;
export type PactRunConfigV1 = z.infer<typeof pactRunConfigV1Schema>;

export function selectedPactExecutionAdapterV1(
  config: Pick<PactRunConfigV1, 'benchmark'>,
): PactExecutionAdapterIdV1 {
  return config.benchmark.execution?.adapter ?? 'pact-public-runner';
}

/** Total attempts per task; 1 (the default) is the single-attempt protocol. */
export function selectedPactAttemptLimitV1(
  config: Pick<PactRunConfigV1, 'benchmark'>,
): number {
  return config.benchmark.attempts?.max ?? 1;
}

/**
 * Whether this run opted into the multi-attempt requester protocol. Presence
 * of the config block — not its value — gates the attempt-level artifact
 * fields, so `attempts: {max: 1}` still produces the extended row shape while
 * an absent block keeps every artifact byte-identical to older runs.
 */
export function pactAttemptsEnabledV1(
  config: Pick<PactRunConfigV1, 'benchmark'>,
): boolean {
  return config.benchmark.attempts !== undefined;
}

export function selectedPactExecutionBackendV1(
  config: Pick<PactRunConfigV1, 'backend'>,
): PactExecutionBackendConfigV1 {
  return config.backend ?? { kind: 'local' };
}

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
