import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  buildPactCliFailureDiagnosticsV1,
  PACT_CLI_FAILURE_GROUP_LIMIT_V1,
  PACT_CLI_FAILURE_MESSAGE_LIMIT_V1,
  PACT_CLI_FAILURE_TASK_ID_LIMIT_V1,
} from '../../src/runner/v1/diagnostics.js';
import type { PactBenchmarkRunResultV1 } from '../../src/runner/v1/runner.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('groups sanitized failures stably and keeps error kinds distinct', () => {
  const result = runResult([
    task('PAIR-Q1', { error: 'docker unavailable', finalizeError: 'close failed' }),
    task('PAIR-Q2', { error: 'docker unavailable' }),
    task('PAIR-Q3', {}),
  ]);

  assert.deepEqual(buildPactCliFailureDiagnosticsV1(result), {
    groups: [
      {
        kind: 'error',
        message: 'docker unavailable',
        count: 2,
        taskIds: ['PAIR-Q1', 'PAIR-Q2'],
        omittedTaskIds: 0,
      },
      {
        kind: 'error',
        message: 'Unknown infrastructure error',
        count: 1,
        taskIds: ['PAIR-Q3'],
        omittedTaskIds: 0,
      },
      {
        kind: 'finalize_error',
        message: 'close failed',
        count: 1,
        taskIds: ['PAIR-Q1'],
        omittedTaskIds: 0,
      },
    ],
    omittedGroups: 0,
  });
});

test('sorts groups by count, kind, and message and task ids regardless of completion order', () => {
  const failures = [
    task('PAIR-A1', { error: 'docker unavailable' }),
    task('PAIR-A2', { error: 'docker unavailable' }),
    task('PAIR-Q1', { error: 'authorization failed' }),
    task('PAIR-Q3', { finalizeError: 'close failed' }),
  ];
  const reordered = [failures[3], failures[1], failures[2], failures[0]];
  const expected = {
    groups: [
      {
        kind: 'error',
        message: 'docker unavailable',
        count: 2,
        taskIds: ['PAIR-A1', 'PAIR-A2'],
        omittedTaskIds: 0,
      },
      {
        kind: 'error',
        message: 'authorization failed',
        count: 1,
        taskIds: ['PAIR-Q1'],
        omittedTaskIds: 0,
      },
      {
        kind: 'finalize_error',
        message: 'close failed',
        count: 1,
        taskIds: ['PAIR-Q3'],
        omittedTaskIds: 0,
      },
    ],
    omittedGroups: 0,
  };

  assert.deepEqual(buildPactCliFailureDiagnosticsV1(runResult(failures)), expected);
  assert.deepEqual(buildPactCliFailureDiagnosticsV1(runResult(reordered)), expected);
});

test('caps messages, task ids, and groups with explicit omission counts', () => {
  const repeated = Array.from(
    { length: PACT_CLI_FAILURE_TASK_ID_LIMIT_V1 + 3 },
    (_, index) => task(`PAIR-Q${index + 1}`, { error: 'x'.repeat(2_500) }),
  );
  const distinct = Array.from(
    { length: PACT_CLI_FAILURE_GROUP_LIMIT_V1 + 2 },
    (_, index) => task(`PAIR-A${index + 1}`, { error: `distinct-${index}` }),
  );
  const diagnostics = buildPactCliFailureDiagnosticsV1(runResult([
    ...repeated,
    ...distinct,
  ]));

  assert.ok(diagnostics);
  assert.equal(diagnostics.groups.length, PACT_CLI_FAILURE_GROUP_LIMIT_V1);
  assert.equal(diagnostics.omittedGroups, 3);
  assert.equal(diagnostics.groups[0]?.message.length, PACT_CLI_FAILURE_MESSAGE_LIMIT_V1);
  assert.equal(diagnostics.groups[0]?.count, PACT_CLI_FAILURE_TASK_ID_LIMIT_V1 + 3);
  assert.equal(diagnostics.groups[0]?.taskIds.length, PACT_CLI_FAILURE_TASK_ID_LIMIT_V1);
  assert.equal(diagnostics.groups[0]?.omittedTaskIds, 3);
});

test('omits diagnostics for successful runs', () => {
  const result = runResult([]);
  result.summary.errors = 0;
  assert.equal(buildPactCliFailureDiagnosticsV1(result), undefined);
});

test('CLI surfaces a missing SharedOS root cause in parseable JSON', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'pact-f5-cli-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bin = join(temporary, 'bin');
  mkdirSync(bin);
  const harbor = join(bin, 'harbor');
  writeFileSync(harbor, '#!/bin/sh\necho "harbor 0.5.0"\n', 'utf8');
  chmodSync(harbor, 0o755);

  const configPath = join(temporary, 'pact-run.yaml');
  writeFileSync(configPath, `
apiVersion: pact-run/v1
kind: RunConfig
backend:
  kind: harbor
  concurrency: 2
model:
  provider: openai-compatible
  baseUrl: https://scripted.invalid/v1
  apiKeyEnv: PACT_MODEL_API_KEY
  model: pact-scripted-parity-v1
benchmark:
  dataset: pact-pair
  policy: D2
  requester: R1
  gradingMode: category
  tasks:
    kind: all
    ids: [PAIR-Q1, PAIR-A1]
budget:
  maxTurns: 4
  maxToolCalls: 2
  maxRuntimeMs: 30000
output:
  directory: runs
  saveTraces: false
`, 'utf8');

  const loader = pathToFileURL(
    join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ).href;
  const cli = join(repositoryRoot, 'src', 'runner', 'v1', 'cli.ts');
  const child = spawnSync(
    process.execPath,
    ['--import', loader, cli, '--config', configPath],
    {
      cwd: temporary,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        PACT_SHAREDOS_DIR: join(temporary, 'missing-sharedos'),
      },
    },
  );

  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stderr, '');
  const output = JSON.parse(child.stdout) as {
    outputDirectory: string;
    summary: { total: number; errors: number };
    failures: {
      groups: Array<{ message: string; count: number; taskIds: string[] }>;
      omittedGroups: number;
    };
  };
  assert.equal(output.summary.total, 2);
  assert.equal(output.summary.errors, 2);
  assert.equal(output.failures.groups.length, 1);
  assert.equal(output.failures.groups[0]?.count, 2);
  assert.deepEqual(output.failures.groups[0]?.taskIds, ['PAIR-A1', 'PAIR-Q1']);
  assert.match(
    output.failures.groups[0]?.message ?? '',
    /SharedOS (?:build|checkout) not found/,
  );
  assert.match(output.failures.groups[0]?.message ?? '', /missing-sharedos/);
  assert.equal(output.failures.omittedGroups, 0);
  assert.ok(output.outputDirectory, 'CLI must retain the run artifact location');
});

function task(
  taskId: string,
  errors: { error?: string; finalizeError?: string },
): PactBenchmarkRunResultV1['tasks'][number] {
  return {
    taskId,
    kind: taskId.includes('-A') ? 'action' : 'qa',
    status: 'infrastructure_error',
    publicTask: {
      taskId,
      kind: taskId.includes('-A') ? 'action' : 'qa',
      requester: { id: 'R1', relationship: 'coworker' },
      target: { id: 'alex' },
      prompt: 'test',
      surface: taskId.includes('-A') ? 'notes' : 'mixed',
    },
    finalDecision: { type: 'escalate', reason: 'test' },
    grantedAccess: {
      access: {
        notes: { read: { scope: 'none' }, write: false },
        todos: { read: false, write: false },
        memory: { read: 'none', write: false },
      },
    },
    evaluation: null,
    budgetUsed: { turns: 0, toolCalls: 0, runtimeMs: 0 },
    toolCalls: [],
    violations: ['runner_error'],
    ...errors,
  } as PactBenchmarkRunResultV1['tasks'][number];
}

function runResult(
  tasks: PactBenchmarkRunResultV1['tasks'],
): PactBenchmarkRunResultV1 {
  return {
    summary: { errors: tasks.length },
    tasks,
  } as PactBenchmarkRunResultV1;
}
