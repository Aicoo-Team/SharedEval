import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  applySharedevalOverridesV1,
  parseSharedevalRunConfigV1Yaml,
} from '../../src/runner/v1/sharedeval-config.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';

const validConfig = `
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
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

test('parses the one Sharedeval protocol with bounded SharedOS runtime defaults', () => {
  const parsed = parseSharedevalRunConfigV1Yaml(validConfig);

  assert.equal(parsed.apiVersion, 'sharedeval-run/v1');
  assert.deepEqual(parsed.workflow, {
    mode: 'multi',
    protocol: 'files',
    maxTicks: 240,
    stopWhen: 'all-terminal',
  });
  assert.deepEqual(parsed.benchmark, {
    dataset: 'pact-pair',
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    tasks: { kind: 'all' },
  });
  assert.deepEqual(parsed.budget, {
    maxToolCalls: 8,
    maxRuntimeMs: 60_000,
  });
});

test('cross-validates relationship policy, requester, and grading mode', () => {
  const relationship = validConfig.replace(
    'benchmark:\n  tasks:',
    'benchmark:\n  policy: REL_R3\n  requester: R3\n  gradingMode: relationship\n  tasks:',
  );
  assert.deepEqual(parseSharedevalRunConfigV1Yaml(relationship).benchmark, {
    dataset: 'pact-pair',
    policy: 'REL_R3',
    requester: 'R3',
    gradingMode: 'relationship',
    tasks: { kind: 'all' },
  });

  for (const source of [
    relationship.replace('requester: R3', 'requester: R2'),
    relationship.replace('gradingMode: relationship', 'gradingMode: category'),
  ]) {
    assert.throws(() => parseSharedevalRunConfigV1Yaml(source), ZodError);
  }
});

test('rejects retired protocol, dataset, and backend selectors', () => {
  for (const source of [
    validConfig.replace('sharedeval-run/v1', 'pact-run/v1'),
    validConfig.replace('protocol: files', 'protocol: legacy-prompt'),
    validConfig.replace('  tasks:\n', '  dataset: pact-net\n  tasks:\n'),
    validConfig.replace('model:\n', 'backend:\n  kind: local\nmodel:\n'),
  ]) {
    assert.throws(() => parseSharedevalRunConfigV1Yaml(source), ZodError);
  }
});

test('enforces the minimum tool budget and ten-minute runtime ceiling', () => {
  assert.doesNotThrow(() => parseSharedevalRunConfigV1Yaml(withBudget(6, 600_000)));

  for (const source of [
    withBudget(5, 60_000),
    withBudget(8, 600_001),
  ]) {
    assert.throws(() => parseSharedevalRunConfigV1Yaml(source), ZodError);
  }
});

test('parses strict YAML with a safe relative output path', () => {
  assert.throws(
    () => parseSharedevalRunConfigV1Yaml(validConfig.replace('directory: runs', 'directory: ../runs')),
    ZodError,
  );
  assert.throws(
    () => parseSharedevalRunConfigV1Yaml(`${validConfig}unexpected: true\n`),
    ZodError,
  );
});

test('makes task and tick overrides part of the effective digest', () => {
  const parsed = parseSharedevalRunConfigV1Yaml(validConfig);
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
});

test('treats CLI task IDs as an exact selection instead of inheriting a limit', () => {
  const parsed = parseSharedevalRunConfigV1Yaml(validConfig.replace(
    '    kind: all',
    '    kind: all\n    limit: 1',
  ));
  const effective = applySharedevalOverridesV1(parsed, resolveWorkflow(['multi']), {
    taskIds: ['PAIR-Q-0101', 'PAIR-Q-0102'],
  });
  assert.deepEqual(effective.benchmark.tasks, {
    kind: 'all',
    ids: ['PAIR-Q-0101', 'PAIR-Q-0102'],
  });
});

test('rejects invalid overrides and command/config contradictions', () => {
  const parsed = parseSharedevalRunConfigV1Yaml(validConfig);
  for (const maxTicks of [0, 1.5, Number.MAX_SAFE_INTEGER + 1, 10_001]) {
    assert.throws(
      () => applySharedevalOverridesV1(parsed, resolveWorkflow(['multi']), { maxTicks }),
      ZodError,
    );
  }
  assert.throws(
    () => applySharedevalOverridesV1(parsed, resolveWorkflow(['multi']), {
      taskIds: ['../not-a-task'],
    }),
    ZodError,
  );
  assert.throws(
    () => applySharedevalOverridesV1(parsed, resolveWorkflow(['single'])),
    /contradicts config workflow/,
  );

  const selected = parseSharedevalRunConfigV1Yaml(validConfig.replace(
    '    kind: all',
    '    kind: all\n    ids: [PAIR-Q-0101]',
  ));
  assert.throws(
    () => applySharedevalOverridesV1(selected, resolveWorkflow(['multi']), {
      taskIds: ['PAIR-Q-0102'],
    }),
    /contradicts config task selection/,
  );
});

function withBudget(maxToolCalls: number, maxRuntimeMs: number): string {
  return `${validConfig}budget:\n  maxToolCalls: ${maxToolCalls}\n  maxRuntimeMs: ${maxRuntimeMs}\n`;
}

test('parses taskConcurrency for the single workflow and keeps absence out of the parse', () => {
  const single = validConfig
    .replace('mode: multi', 'mode: single')
    .replace('stopWhen: all-terminal', 'stopWhen: all-terminal\n  taskConcurrency: 8');
  assert.equal(parseSharedevalRunConfigV1Yaml(single).workflow.taskConcurrency, 8);

  const absent = parseSharedevalRunConfigV1Yaml(validConfig);
  assert.equal('taskConcurrency' in absent.workflow, false);
});

test('rejects taskConcurrency outside its bounds or on the multi workflow', () => {
  const withConcurrency = (mode: string, value: number) => validConfig
    .replace('mode: multi', `mode: ${mode}`)
    .replace('stopWhen: all-terminal', `stopWhen: all-terminal\n  taskConcurrency: ${value}`);

  assert.throws(() => parseSharedevalRunConfigV1Yaml(withConcurrency('single', 0)), ZodError);
  assert.throws(() => parseSharedevalRunConfigV1Yaml(withConcurrency('single', 33)), ZodError);
  assert.throws(() => parseSharedevalRunConfigV1Yaml(withConcurrency('single', 1.5)), ZodError);
  assert.throws(() => parseSharedevalRunConfigV1Yaml(withConcurrency('multi', 2)), ZodError);
  assert.equal(
    parseSharedevalRunConfigV1Yaml(withConcurrency('multi', 1)).workflow.taskConcurrency,
    1,
  );
});

test('written taskConcurrency is part of the digest and absence leaves it unchanged', () => {
  const single = validConfig.replace('mode: multi', 'mode: single');
  const digestOf = (source: string) => applySharedevalOverridesV1(
    parseSharedevalRunConfigV1Yaml(source),
    resolveWorkflow(['single']),
  ).configDigest;
  const absent = digestOf(single);
  const explicitOne = digestOf(single.replace(
    'stopWhen: all-terminal',
    'stopWhen: all-terminal\n  taskConcurrency: 1',
  ));
  const explicitEight = digestOf(single.replace(
    'stopWhen: all-terminal',
    'stopWhen: all-terminal\n  taskConcurrency: 8',
  ));

  assert.notEqual(explicitOne, absent);
  assert.notEqual(explicitEight, explicitOne);
  assert.equal(absent, digestOf(single));
});
