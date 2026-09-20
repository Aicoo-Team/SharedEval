import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  SHAREDEVAL_MODEL_API_KEY_ENV_V1,
  pactModelConfigV1Schema,
  pactModelIdentifierV1,
  resolvePactRunModelApiKeyV1,
} from '../../src/runner/v1/model-config.js';

test('normalizes strict OpenAI-compatible model configuration', () => {
  const model = pactModelConfigV1Schema.parse({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1///',
    apiKeyEnv: SHAREDEVAL_MODEL_API_KEY_ENV_V1,
    model: '  example-model  ',
    reasoning: { effort: 'high' },
    providerRouting: {
      requireParameters: true,
      allowFallbacks: false,
      order: ['provider-a', 'provider-b'],
      only: ['provider-a', 'provider-b'],
    },
  });

  assert.ok(model.provider === 'openai-compatible');
  assert.equal(model.baseUrl, 'https://api.example.com/v1');
  assert.equal(model.model, 'example-model');
  assert.equal(model.maxOutputTokens, 4_096);
  assert.equal(pactModelIdentifierV1(model), 'example-model');
});

test('normalizes Azure OpenAI configuration and identifies the deployment', () => {
  const model = pactModelConfigV1Schema.parse({
    provider: 'azure-openai',
    endpoint: 'https://contoso.openai.azure.com/openai/v1/',
    deployment: '  gpt-4o-eval  ',
    apiVersion: 'preview',
    apiKeyEnv: SHAREDEVAL_MODEL_API_KEY_ENV_V1,
  });

  assert.ok(model.provider === 'azure-openai');
  assert.equal(model.endpoint, 'https://contoso.openai.azure.com/openai/v1');
  assert.equal(model.deployment, 'gpt-4o-eval');
  assert.equal(model.maxOutputTokens, 4_096);
  assert.equal(pactModelIdentifierV1(model), 'gpt-4o-eval');
});

test('pins the Azure reasoning effort at parse time, because the deployment will not', () => {
  const base = {
    provider: 'azure-openai',
    endpoint: 'https://contoso.openai.azure.com/openai/v1',
    deployment: 'DeepSeek-V4-Flash-0731',
    apiKeyEnv: SHAREDEVAL_MODEL_API_KEY_ENV_V1,
  } as const;

  const requested = pactModelConfigV1Schema.parse({ ...base, reasoningEffort: 'low' });
  assert.ok(requested.provider === 'azure-openai');
  assert.equal(requested.reasoningEffort, 'low');

  // Not asking is its own arm, so an unset config must stay unset rather than
  // acquiring a default of 'none' -- the two produce different request bodies.
  const unset = pactModelConfigV1Schema.parse(base);
  assert.ok(unset.provider === 'azure-openai');
  assert.equal('reasoningEffort' in unset, false);

  // The deployment answers reasoning_effort: "bogus" with HTTP 200 and
  // reasoning switched ON; only the exact string 'none' turns it off. A typo
  // would therefore move a run onto the other arm without any error, so this
  // schema is the only place the value can be refused at all.
  for (const effort of ['bogus', 'minimal', 'max', 'LOW', 'None', '', 'low ']) {
    assert.throws(
      () => pactModelConfigV1Schema.parse({ ...base, reasoningEffort: effort }),
      ZodError,
      `reasoningEffort must be rejected at parse time: ${JSON.stringify(effort)}`,
    );
  }

  // The nested object form is the OpenRouter branch's shape. Azure rejects it
  // with 400 unrecognized_request_argument, so it is not accepted here either.
  assert.throws(
    () => pactModelConfigV1Schema.parse({ ...base, reasoning: { effort: 'low' } }),
    ZodError,
    'the Azure branch must not accept the nested reasoning object',
  );
});

test('rejects model configuration that could smuggle credentials or unsafe endpoints', () => {
  const base = {
    provider: 'openai-compatible',
    apiKeyEnv: SHAREDEVAL_MODEL_API_KEY_ENV_V1,
    model: 'example-model',
  } as const;

  for (const candidate of [
    { ...base, baseUrl: 'http://api.example.com/v1' },
    { ...base, baseUrl: 'https://user:password@api.example.com/v1' },
    { ...base, baseUrl: 'https://api.example.com/v1?secret=value' },
    { ...base, baseUrl: 'https://api.example.com/v1/chat/completions' },
    { ...base, baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'AWS_SECRET_ACCESS_KEY' },
    { ...base, baseUrl: 'https://api.example.com/v1', apiKey: 'literal-secret' },
  ]) {
    assert.throws(() => pactModelConfigV1Schema.parse(candidate), ZodError);
  }

  const loopback = pactModelConfigV1Schema.parse({
    ...base,
    baseUrl: 'http://127.0.0.1:11434/v1/',
  });
  assert.ok(loopback.provider === 'openai-compatible');
  assert.equal(loopback.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('resolves only the dedicated trimmed model credential', () => {
  const model = pactModelConfigV1Schema.parse({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnv: SHAREDEVAL_MODEL_API_KEY_ENV_V1,
    model: 'example-model',
  });

  assert.equal(
    resolvePactRunModelApiKeyV1(model, { SHAREDEVAL_MODEL_API_KEY: '  test-token  ' }),
    'test-token',
  );
  assert.throws(
    () => resolvePactRunModelApiKeyV1(model, {}),
    /Model credential environment variable SHAREDEVAL_MODEL_API_KEY is not set/,
  );
});
