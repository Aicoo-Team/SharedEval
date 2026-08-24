import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  applySharedevalOverridesV1,
  parseSharedevalRunConfigV1Yaml,
} from '../../src/runner/v1/sharedeval-config.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';

const config = `
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: example-model
workflow:
  mode: multi
  protocol: files
  maxTicks: 240
  stopWhen: all-terminal
benchmark:
  tasks:
    kind: all
output:
  directory: runs
  saveTraces: false
`;

test('resolves the exact file-driven and explicit legacy command matrix', () => {
  assert.equal(resolveWorkflow([]).id, 'files-multi');
  assert.equal(resolveWorkflow(['multi']).id, 'files-multi');
  assert.equal(resolveWorkflow(['single']).id, 'files-single');
  assert.equal(resolveWorkflow(['multi', '--legacy']).id, 'legacy-multi-transcript');
  assert.equal(resolveWorkflow(['single', '--legacy']).id, 'legacy-single-prompt');
});

test('parses only the strict sharedeval-run protocol with safe output paths', () => {
  const parsed = parseSharedevalRunConfigV1Yaml(config);
  assert.equal(parsed.apiVersion, 'sharedeval-run/v1');
  assert.deepEqual(parsed.workflow, {
    mode: 'multi',
    protocol: 'files',
    maxTicks: 240,
    stopWhen: 'all-terminal',
  });

  assert.throws(
    () => parseSharedevalRunConfigV1Yaml(config.replace('sharedeval-run/v1', 'pact-run/v1')),
    ZodError,
  );
  assert.throws(
    () => parseSharedevalRunConfigV1Yaml(config.replace('directory: runs', 'directory: ../runs')),
    ZodError,
  );
  assert.throws(
    () => parseSharedevalRunConfigV1Yaml(`${config}unexpected: true\n`), ZodError);
});

test('makes task and tick overrides part of the effective digest', () => {
  const parsed = parseSharedevalRunConfigV1Yaml(config);
  const effective = applySharedevalOverridesV1(parsed, resolveWorkflow(['multi']), {
    taskIds: ['PAIR-Q-0101'],
    maxTicks: 12,
  });

  assert.deepEqual(effective.benchmark.tasks, { kind: 'all', ids: ['PAIR-Q-0101'] });
  assert.equal(effective.workflow.maxTicks, 12);
  assert.match(effective.configDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(
    effective.configDigest,
    applySharedevalOverridesV1(parsed, resolveWorkflow(['multi']), {
      taskIds: ['PAIR-Q-0102'],
      maxTicks: 12,
    }).configDigest,
  );
  assert.throws(
    () => applySharedevalOverridesV1(parsed, resolveWorkflow(['multi']), {
      taskIds: ['../not-a-task'],
    }),
    ZodError,
  );
});

test('rejects contradictory command and config task selection without a legacy fallback', () => {
  const selected = parseSharedevalRunConfigV1Yaml(config.replace(
    '    kind: all',
    '    kind: all\n    ids: [PAIR-Q-0101]',
  ));
  assert.throws(
    () => applySharedevalOverridesV1(selected, resolveWorkflow(['multi']), {
      taskIds: ['PAIR-Q-0102'],
    }),
    /contradicts config task selection/,
  );
  assert.throws(
    () => applySharedevalOverridesV1(parseSharedevalRunConfigV1Yaml(config), resolveWorkflow(['single'])),
    /contradicts config workflow/,
  );
});
