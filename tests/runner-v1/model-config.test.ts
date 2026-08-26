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
