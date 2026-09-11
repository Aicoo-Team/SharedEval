import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySharedevalOverridesV1,
  parseSharedevalRunConfigYaml,
  parseSharedevalRunConfigV1Yaml,
} from '../../src/runner/v1/sharedeval-config.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';
import { runSharedevalPactPairFilesV1, type RunSharedevalPactPairFilesV1Options } from '../../src/runner/v1/sharedeval-runner.js';

const config = `
apiVersion: sharedeval-run/v2
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: example-model
workflow:
  protocol: files
  maxTicks: 8
  stopWhen: all-terminal
`;

test('v2 defaults to a persistent multi world without silently enabling a retry strategy', () => {
  const parsed = parseSharedevalRunConfigYaml(config);
  assert.equal(parsed.workflow.mode, 'multi');
  assert.deepEqual(parsed.workflow.world, {
    protocol: 'actor-context/v1',
    maxContextBytes: 1_048_576,
  });
  assert.equal(parsed.workflow.multiTurn, undefined);
  const effective = applySharedevalOverridesV1(parsed, resolveWorkflow([]));
  assert.deepEqual(effective.workflow.world, parsed.workflow.world);
  assert.equal(effective.apiVersion, 'sharedeval-run/v2');
});

test('legacy configurations retain their exact absent-context representation and digest', () => {
  const legacy = config.replace('sharedeval-run/v2', 'sharedeval-run/v1')
    .replace('  protocol:', '  mode: multi\n  protocol:');
  const old = parseSharedevalRunConfigV1Yaml(legacy);
  const current = parseSharedevalRunConfigYaml(legacy);
  assert.deepEqual(current, old);
  assert.equal('world' in current.workflow, false);
  assert.equal(
    applySharedevalOverridesV1(current, resolveWorkflow([])).configDigest,
    applySharedevalOverridesV1(old, resolveWorkflow([])).configDigest,
  );
  assert.throws(() => parseSharedevalRunConfigV1Yaml(config));
  assert.throws(() => parseSharedevalRunConfigYaml(`${legacy}  world: {}\n`));
});

test('context limits are strict experiment identity, with no silent-reset or truncation mode', () => {
  const world = (extra: string) => `${config}  world:\n${extra}`;
  const smaller = parseSharedevalRunConfigYaml(world('    maxContextBytes: 4096\n'));
  assert.notEqual(
    applySharedevalOverridesV1(smaller, resolveWorkflow([])).configDigest,
    applySharedevalOverridesV1(parseSharedevalRunConfigYaml(config), resolveWorkflow([])).configDigest,
  );
  for (const extra of [
    '    maxContextBytes: 0\n',
    '    maxContextBytes: 16777217\n',
    '    protocol: reset\n',
    '    truncation: auto\n',
    '    scope: task\n',
  ]) assert.throws(() => parseSharedevalRunConfigYaml(world(extra)));
});

test('single is an explicit isolated-world mode and still rejects multi-turn retries', () => {
  const single = config.replace('  protocol:', '  mode: single\n  protocol:');
  const parsed = parseSharedevalRunConfigYaml(single);
  const effective = applySharedevalOverridesV1(parsed, resolveWorkflow(['single']));
  assert.equal(effective.workflow.id, 'files-single');
  assert.equal(effective.workflow.world?.protocol, 'actor-context/v1');
  assert.throws(() => parseSharedevalRunConfigYaml(`${single}  multiTurn:\n    phase2StartTick: 2\n    finalizeTick: 8\n`));
});

test('programmatic v2 cannot bypass world validation or silently fall back to reset context', () => {
  const effective = applySharedevalOverridesV1(parseSharedevalRunConfigYaml(config), resolveWorkflow([]));
  for (const world of [undefined, { protocol: 'reset', maxContextBytes: 4096 }]) {
    assert.throws(() => runSharedevalPactPairFilesV1({ config: {
      ...effective, workflow: { ...effective.workflow, world },
    } } as RunSharedevalPactPairFilesV1Options), /world/i);
  }
});
