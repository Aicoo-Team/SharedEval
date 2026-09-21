import { z } from 'zod';

// Model configuration may choose an endpoint, so it may name only this
// dedicated credential alias rather than an arbitrary process secret.
export const SHAREDEVAL_MODEL_API_KEY_ENV_V1 = 'SHAREDEVAL_MODEL_API_KEY' as const;

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
      providers => new Set(providers).size === providers.length,
      { message: 'provider order entries must be unique' },
    ).optional(),
    only: z.array(providerSlugSchema).min(1).max(32).refine(
      providers => new Set(providers).size === providers.length,
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
      const outsideAllowlist = routing.order.filter(provider => !allowed.has(provider));
      if (outsideAllowlist.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['order'],
          message: `provider order contains entries outside only: ${outsideAllowlist.join(', ')}`,
        });
      }
    }
  });

export const pactReasoningV1Schema = z
  .object({ effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'max']) })
  .strict();

/**
 * Azure's deployments take the effort as a top-level `reasoning_effort` string
 * and reject the object form above with HTTP 400
 * `unrecognized_request_argument`, so the two shapes cannot share a schema.
 * The enum is narrower than pactReasoningV1Schema's for the same reason: only
 * these four are OpenAI-standard efforts, and `minimal`/`max` have never been
 * observed honoured on an Azure deployment.
 *
 * This enum has to do the whole job, because the deployment does none of it:
 * a probe against DeepSeek-V4-Flash-0731 found that `reasoning_effort:
 * "bogus"` does NOT 400 -- it is simply treated as reasoning ON. Only the
 * exact string `none` turns the channel off. A typo in a run config would
 * therefore move that run onto the other arm silently rather than failing, so
 * the value is pinned here and rejected at config-parse time instead.
 */
export const pactAzureReasoningEffortV1Schema = z.enum([
  'none',
  'low',
  'medium',
  'high',
]);

export type PactAzureReasoningEffortV1 = z.infer<
  typeof pactAzureReasoningEffortV1Schema
>;

const providerBaseUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must use http or https' });
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
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain credentials' });
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
    apiKeyEnv: z.literal(SHAREDEVAL_MODEL_API_KEY_ENV_V1),
    model: z.string().trim().min(1).max(256),
    temperature: z.number().finite().min(0).max(2).optional(),
    seed: z.number().int().safe().optional(),
    reasoning: pactReasoningV1Schema.optional(),
    providerRouting: pactProviderRoutingV1Schema.optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536).default(4_096),
    /**
     * Per-attempt provider deadline. Absent, the driver scales it from the
     * task budget; set it explicitly for models whose single generation is
     * long relative to that budget.
     */
    attemptTimeoutMs: z.number().int().safe().min(1_000).max(3_600_000).optional(),
  })
  .strict();

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
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain credentials' });
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
    apiVersion: z
      .string()
      .trim()
      .regex(
        /^(?:\d{4}-\d{2}-\d{2}(?:-preview)?|preview)$/,
        'must be an Azure api-version, e.g. 2024-10-21 or preview',
      )
      .optional(),
    apiKeyEnv: z.literal(SHAREDEVAL_MODEL_API_KEY_ENV_V1),
    temperature: z.number().finite().min(0).max(2).optional(),
    /**
     * Absent is a different arm from `none`: absent sends no key at all, while
     * `none` explicitly asks the deployment to answer without a separate
     * deliberation channel. Both have to stay expressible, so this stays
     * optional rather than defaulting.
     *
     * Any value other than `none` shares `maxOutputTokens` between the
     * deliberation and the reply; a budget sized for the reply alone comes
     * back with `finish_reason: length` and an empty `content`. Raise
     * maxOutputTokens on an arm that sets this.
     */
    reasoningEffort: pactAzureReasoningEffortV1Schema.optional(),
    maxOutputTokens: z.number().int().safe().min(1).max(65_536).default(4_096),
  })
  .strict();

export const pactModelConfigV1Schema = z.discriminatedUnion('provider', [
  pactOpenAICompatibleModelConfigV1Schema,
  pactAzureOpenAIModelConfigV1Schema,
]);

export type PactOpenAICompatibleModelConfigV1 = z.infer<
  typeof pactOpenAICompatibleModelConfigV1Schema
>;
export type PactAzureOpenAIModelConfigV1 = z.infer<
  typeof pactAzureOpenAIModelConfigV1Schema
>;
export type PactModelConfigV1 = z.infer<typeof pactModelConfigV1Schema>;

export function pactModelIdentifierV1(model: PactModelConfigV1): string {
  return model.provider === 'azure-openai' ? model.deployment : model.model;
}

export function resolvePactRunModelApiKeyV1(
  model: PactModelConfigV1,
  environment: Record<string, string | undefined> = process.env,
): string {
  const apiKey = environment[model.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `Model credential environment variable ${model.apiKeyEnv} is not set`,
    );
  }
  return apiKey;
}
