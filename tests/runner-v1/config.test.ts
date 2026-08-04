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
  assert.deepEqual(config.benchmark, {
    dataset: 'pact-pair',
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
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
  gradingMode: category
  tasks:
    kind: action
    ids: [PAIR-A1, PAIR-A2]
    limit: 2
`);
  assert.deepEqual(configured.benchmark, {
    dataset: 'pact-pair',
    policy: 'D5',
    requester: 'R4',
    gradingMode: 'category',
    tasks: {
      kind: 'action',
      ids: ['PAIR-A1', 'PAIR-A2'],
      limit: 2,
    },
  });

  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  dataset: pact-net
`),
    ZodError,
  );

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

test('accepts explicit reproducibility and provider-routing controls', () => {
  const configured = parsePactRunConfigV1Yaml(minimalConfig.replace(
    '  model: example-model',
    `  model: example-model
  temperature: 0
  seed: 42
  reasoning:
    effort: low
  providerRouting:
    requireParameters: true
    allowFallbacks: false
    only: [deepinfra]
    order: [deepinfra]`,
  ));

  assert.deepEqual(configured.model, {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnv: 'PACT_MODEL_API_KEY',
    model: 'example-model',
    temperature: 0,
    seed: 42,
    reasoning: { effort: 'low' },
    providerRouting: {
      requireParameters: true,
      allowFallbacks: false,
      only: ['deepinfra'],
      order: ['deepinfra'],
    },
    maxOutputTokens: 4_096,
  });

  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      '  model: example-model',
      '  model: example-model\n  providerRouting:\n    only: [deepinfra, deepinfra]',
    )),
    ZodError,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(minimalConfig.replace(
      '  model: example-model',
      '  model: example-model\n  providerRouting:\n    only: [deepinfra]\n    order: [together]',
    )),
    /provider order contains entries outside only/,
  );
});

test('validates matched ablation and relationship policy semantics', () => {
  const ablation = parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: A_CATEGORY_ONLY
  requester: R1
  gradingMode: category
  tasks:
    kind: qa
`);
  assert.equal(ablation.benchmark.policy, 'A_CATEGORY_ONLY');

  for (const gradingMode of ['category', 'relationship'] as const) {
    const submitted = parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: D2_SUBMITTED
  requester: R1
  gradingMode: ${gradingMode}
  tasks:
    kind: qa
`);
    assert.equal(submitted.benchmark.policy, 'D2_SUBMITTED');
    assert.equal(submitted.benchmark.gradingMode, gradingMode);
  }

  const relationship = parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: REL_R3
  requester: R3
  gradingMode: relationship
  tasks:
    kind: qa
`);
  assert.equal(relationship.benchmark.policy, 'REL_R3');

  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: REL_R3
  requester: R1
  gradingMode: relationship
  tasks:
    kind: qa
`),
    /REL_R3 must be paired with requester R3/,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: REL_R3
  requester: R3
  gradingMode: category
  tasks:
    kind: qa
`),
    /REL_R3 requires relationship grading/,
  );
  assert.throws(
    () => parsePactRunConfigV1Yaml(`${minimalConfig}
benchmark:
  policy: REL_R3
  requester: R3
  gradingMode: relationship
  tasks:
    kind: action
`),
    /REL_R3 is validated only for QA tasks/,
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
