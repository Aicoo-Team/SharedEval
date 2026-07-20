import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  loadPactRunConfigV1,
  parsePactRunConfigV1Yaml,
  resolvePactRunModelApiKeyV1,
  selectedPactExecutionBackendV1,
} from '../../src/runner/v1/config.js';

const minimalConfig = `
apiVersion: pact-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1/
  apiKeyEnv: PACT_MODEL_API_KEY
  model: example-model
`;

test('parses a strict run config and applies safe defaults', () => {
  const config = parsePactRunConfigV1Yaml(minimalConfig);

  assert.equal(config.model.baseUrl, 'https://api.example.com/v1');
  assert.equal('temperature' in config.model, false);
  assert.equal(config.model.maxOutputTokens, 4_096);
  assert.equal(config.backend, undefined);
  assert.deepEqual(selectedPactExecutionBackendV1(config), { kind: 'local' });
  assert.deepEqual(config.benchmark, {
    policy: 'D2',
    requester: 'R1',
    tasks: { kind: 'all' },
  });
  assert.deepEqual(config.budget, {
    maxTurns: 8,
    maxToolCalls: 4,
    maxRuntimeMs: 60_000,
  });
  assert.deepEqual(config.output, {
    directory: 'runs',
    saveTraces: false,
  });
});

test('selects local by default and validates explicit backend settings', () => {
  const local = parsePactRunConfigV1Yaml(`${minimalConfig}
backend:
  kind: local
`);
  assert.deepEqual(selectedPactExecutionBackendV1(local), { kind: 'local' });

  const harbor = parsePactRunConfigV1Yaml(`${minimalConfig}
backend:
  kind: harbor
`);
  assert.deepEqual(selectedPactExecutionBackendV1(harbor), {
    kind: 'harbor',
    concurrency: 4,
  });

  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
backend:
  kind: harbor
  concurrency: 0
`),
    ZodError,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
backend:
  kind: local
  concurrency: 4
`),
    ZodError,
  );
});

test('rejects literal credentials and unknown config fields', () => {
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      '  apiKeyEnv: PACT_MODEL_API_KEY',
      '  apiKeyEnv: PACT_MODEL_API_KEY\n  apiKey: sk-should-not-be-here',
    )),
    ZodError,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      'apiKeyEnv: PACT_MODEL_API_KEY',
      'apiKeyEnv: sk-literal-secret',
    )),
    ZodError,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      'apiKeyEnv: PACT_MODEL_API_KEY',
      'apiKeyEnv: AWS_SECRET_ACCESS_KEY',
    )),
    ZodError,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      'baseUrl: https://api.example.com/v1/',
      'baseUrl: https://user:password@api.example.com/v1/',
    )),
    ZodError,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      'https://api.example.com/v1/',
      'http://api.example.com/v1/',
    )),
    ZodError,
  );
  assert.equal(
    parsePactRunConfigV1Yaml(minimalConfig.replace(
      'https://api.example.com/v1/',
      'http://127.0.0.1:11434/v1/',
    )).model.baseUrl,
    'http://127.0.0.1:11434/v1',
  );
});

test('rejects aliases and multiple YAML documents', () => {
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      '  model: example-model',
      '  model: &model example-model\n  extraModel: *model',
    )),
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}\n---\n${minimalConfig}`),
    /exactly one YAML document/,
  );
});

test('validates requester and task filters strictly', () => {
  const configured = parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: D5
  requester: R4
  tasks:
    kind: action
    ids: [PAIR-A1, PAIR-A2]
    limit: 2
`);
  assert.deepEqual(configured.benchmark, {
    policy: 'D5',
    requester: 'R4',
    tasks: {
      kind: 'action',
      ids: ['PAIR-A1', 'PAIR-A2'],
      limit: 2,
    },
  });

  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  requester: R9
  tasks:
    ids: [PAIR-A1, PAIR-A1]
`),
    ZodError,
  );
});

test('rejects token and cost budgets that the compatible runner cannot enforce', () => {
  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
budget:
  maxTurns: 8
  maxToolCalls: 4
  maxRuntimeMs: 60000
  maxTokens: 1000
`),
    ZodError,
  );
});

test('loads config paths without materializing the API key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pact-run-config-'));
  const configPath = path.join(directory, 'pact-run.yaml');
  try {
    await writeFile(configPath, minimalConfig, 'utf8');
    const loaded = await loadPactRunConfigV1(configPath);

    assert.equal(loaded.sourcePath, configPath);
    assert.equal(loaded.rootDir, directory);
    assert.equal('apiKey' in loaded.model, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolves only the named environment variable', () => {
  const config = parsePactRunConfigV1Yaml(minimalConfig);
  assert.equal(
    resolvePactRunModelApiKeyV1(config, { PACT_MODEL_API_KEY: '  test-token  ' }),
    'test-token',
  );
  assert.throws(
    () => resolvePactRunModelApiKeyV1(config, {}),
    /PACT_MODEL_API_KEY is not set/,
  );
});
