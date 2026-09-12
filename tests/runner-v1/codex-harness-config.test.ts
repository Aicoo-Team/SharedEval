import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySharedevalOverridesV1,
  parseSharedevalRunConfigV1Yaml,
} from '../../src/runner/v1/sharedeval-config.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';

function runConfigYaml(mode: 'multi' | 'single', extra = ''): string {
  return `apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://openrouter.ai/api/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: deepseek/deepseek-chat
  maxOutputTokens: 4096
workflow:
  mode: ${mode}
  protocol: files
  maxTicks: 10
  stopWhen: all-terminal
benchmark:
  dataset: pact-pair
  policy: D2
  requester: R1
  gradingMode: category
  tasks:
    kind: all
    limit: 2
budget:
  maxToolCalls: 8
  maxRuntimeMs: 60000
output:
  directory: runs
  saveTraces: false
${extra}`;
}

// Digests recorded at 9c29358 (before the harness field existed). A config
// that does not name a harness must keep producing exactly these bytes.
const BASELINE_DIGESTS = {
  multi: '65ba8a44de128a682d04882c67d933d174795776ecc7fb50cac7ccbf7d1b2082',
  single: '7ed75963bb76d99ccfe832fd5c41c0a5994b5ab4584b78f0438a54c087b8f641',
} as const;

test('configs without a harness keep their pre-harness configDigest byte for byte', () => {
  for (const mode of ['multi', 'single'] as const) {
    const config = parseSharedevalRunConfigV1Yaml(runConfigYaml(mode));
    assert.equal('harness' in config, false);
    const effective = applySharedevalOverridesV1(config, resolveWorkflow([mode]));
    assert.equal(effective.configDigest, BASELINE_DIGESTS[mode]);
    assert.equal('harness' in effective, false);
  }
});

test('the codex harness is strict, defaulted, and changes the run identity', () => {
  const config = parseSharedevalRunConfigV1Yaml(runConfigYaml('single', `harness:
  responder: codex
`));
  assert.deepEqual(config.harness, {
    responder: 'codex',
    codex: { command: 'codex', providerId: 'sharedeval', wireApi: 'chat' },
  });
  const effective = applySharedevalOverridesV1(config, resolveWorkflow(['single']));
  assert.notEqual(effective.configDigest, BASELINE_DIGESTS.single);
  assert.deepEqual(effective.harness, config.harness);

  const explicit = parseSharedevalRunConfigV1Yaml(runConfigYaml('single', `harness:
  responder: codex
  codex:
    command: /opt/codex/bin/codex
    providerId: openrouter
    wireApi: chat
    extraArgs: ["--fake-mode", "ok"]
`));
  assert.deepEqual(explicit.harness?.codex, {
    command: '/opt/codex/bin/codex',
    providerId: 'openrouter',
    wireApi: 'chat',
    extraArgs: ['--fake-mode', 'ok'],
  });
});

test('the harness rejects unknown responders, unknown keys, other wires, and shell syntax', () => {
  assert.throws(() => parseSharedevalRunConfigV1Yaml(runConfigYaml('single', `harness:
  responder: claude-code
`)));
  assert.throws(() => parseSharedevalRunConfigV1Yaml(runConfigYaml('single', `harness:
  responder: codex
  requester: codex
`)));
  assert.throws(() => parseSharedevalRunConfigV1Yaml(runConfigYaml('single', `harness:
  responder: codex
  codex:
    wireApi: responses
`)));
  assert.throws(() => parseSharedevalRunConfigV1Yaml(runConfigYaml('single', `harness:
  responder: codex
  codex:
    command: "codex; rm -rf /"
`)));
});

test('the codex harness requires an openai-compatible model', () => {
  const azure = `apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: azure-openai
  endpoint: https://example.openai.azure.com/openai/v1
  deployment: gpt-5
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
workflow:
  mode: single
  protocol: files
  maxTicks: 10
  stopWhen: all-terminal
harness:
  responder: codex
`;
  assert.throws(
    () => parseSharedevalRunConfigV1Yaml(azure),
    /openai-compatible/,
  );
});
