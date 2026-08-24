import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPactNetContainerRunConfigV1,
  mainPactContainerV1,
} from '../../src/runner/v1/container-entrypoint.js';

function withoutModelInjection(t: { after(fn: () => unknown): void }): void {
  const previousModel = process.env.PACT_MODEL_CONFIG_JSON;
  const previousAdapter = process.env.PACT_EXECUTION_ADAPTER;
  delete process.env.PACT_MODEL_CONFIG_JSON;
  delete process.env.PACT_EXECUTION_ADAPTER;
  t.after(() => {
    if (previousModel !== undefined) process.env.PACT_MODEL_CONFIG_JSON = previousModel;
    if (previousAdapter !== undefined) process.env.PACT_EXECUTION_ADAPTER = previousAdapter;
  });
}

test('builds the Net container run config through the strict schema', () => {
  const scripted = buildPactNetContainerRunConfigV1({
    taskId: 'NET-Q-0001',
    policy: 'D2',
    maxTurns: 4,
    maxToolCalls: 2,
    maxRuntimeMs: 30_000,
    outputDirectoryName: 'pact-output',
  });
  assert.equal(scripted.benchmark.dataset, 'pact-net');
  assert.equal(scripted.benchmark.policy, 'D2');
  assert.deepEqual(scripted.benchmark.tasks, { kind: 'qa', ids: ['NET-Q-0001'] });
  // Scripted default: the `.invalid` parity endpoint, public-runner adapter,
  // local backend (the container never nests an orchestrator).
  assert.equal(scripted.model.provider, 'openai-compatible');
  assert.ok(
    scripted.model.provider === 'openai-compatible'
    && scripted.model.baseUrl === 'https://scripted.invalid/v1',
  );
  assert.equal('execution' in scripted.benchmark, false);
  assert.deepEqual(scripted.backend, { kind: 'local' });
  assert.equal(scripted.output.saveTraces, true);

  // Action ids derive the action filter kind; the injected real-model
  // configuration and execution adapter flow through verbatim.
  const model = buildPactNetContainerRunConfigV1({
    taskId: 'NET-A-0014',
    policy: 'D0',
    maxTurns: 8,
    maxToolCalls: 4,
    maxRuntimeMs: 120_000,
    outputDirectoryName: 'pact-output',
    modelConfig: {
      provider: 'azure-openai',
      endpoint: 'https://hanxiang-resource.openai.azure.com/openai/v1',
      deployment: 'hanxiang-deployment',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      maxOutputTokens: 4096,
    },
    executionAdapter: 'sharedos-embedded',
  });
  assert.deepEqual(model.benchmark.tasks, { kind: 'action', ids: ['NET-A-0014'] });
  assert.equal(model.model.provider, 'azure-openai');
  assert.equal(model.benchmark.execution?.adapter, 'sharedos-embedded');

  // Net policies outside the D0/D2 contract are rejected by the schema.
  assert.throws(() => buildPactNetContainerRunConfigV1({
    taskId: 'NET-Q-0001',
    policy: 'D3',
    maxTurns: 4,
    maxToolCalls: 2,
    maxRuntimeMs: 30_000,
    outputDirectoryName: 'pact-output',
  }));
});

test('container entrypoint dispatches --dataset pact-net to the Net engine', async t => {
  withoutModelInjection(t);
  const temporary = await mkdtemp(join(tmpdir(), 'pact-net-entrypoint-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const outputDirectory = join(temporary, 'pact-output');

  const exitCode = await mainPactContainerV1([
    '--dataset', 'pact-net',
    '--task-id', 'NET-Q-0021',
    '--output-directory', outputDirectory,
    '--policy', 'D2',
    '--max-turns', '4',
    '--max-tool-calls', '2',
    '--max-runtime-ms', '30000',
  ]);
  assert.equal(exitCode, 0);

  const runDirectory = join(outputDirectory, 'harbor-NET-Q-0021');
  const resultsLines = (await readFile(join(runDirectory, 'results.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.equal(resultsLines.length, 1);
  const result = JSON.parse(resultsLines[0] ?? '{}') as {
    taskId: string;
    status: string;
    finalDecision: { type: string };
    routing: { allowed: boolean };
  };
  assert.equal(result.taskId, 'NET-Q-0021');
  assert.equal(result.status, 'ok');
  // NET-Q-0021 is the non-contact probe: the environment blocks routing
  // before any harness runs — LOCAL semantics preserved in the container path.
  assert.equal(result.finalDecision.type, 'routing_blocked');
  assert.equal(result.routing.allowed, false);

  // Gold-bearing artifacts live under private/ only (same contract as pair).
  assert.ok((await stat(join(runDirectory, 'private', 'evaluation.jsonl'))).size > 0);
  await assert.rejects(stat(join(runDirectory, 'evaluation.jsonl')));
  await assert.rejects(stat(join(runDirectory, 'trace.jsonl')));

  const runMetadata = JSON.parse(
    await readFile(join(runDirectory, 'run.json'), 'utf8'),
  ) as { execution: { backend: string; executor: string } };
  assert.deepEqual(runMetadata.execution, {
    backend: 'local',
    executor: 'scripted-harness',
  });
});

test('container entrypoint enforces per-dataset task-id gates and dataset allow-list', async t => {
  withoutModelInjection(t);
  const argvFor = (dataset: string | undefined, taskId: string) => [
    ...(dataset ? ['--dataset', dataset] : []),
    '--task-id', taskId,
    '--output-directory', '/tmp/pact-output-unused',
    '--policy', 'D2',
    ...(dataset === 'pact-net' ? [] : ['--requester', 'R1', '--grading-mode', 'category']),
    '--max-turns', '4',
    '--max-tool-calls', '2',
    '--max-runtime-ms', '30000',
  ];

  // Net dataset rejects non-canonical and pair-shaped ids.
  await assert.rejects(
    mainPactContainerV1(argvFor('pact-net', 'PAIR-Q1')),
    /Invalid PACT-Net task id: PAIR-Q1/,
  );
  await assert.rejects(
    mainPactContainerV1(argvFor('pact-net', 'NET-Q-1')),
    /Invalid PACT-Net task id: NET-Q-1/,
  );
  // The default (pair) dataset keeps its original gate and error surface.
  await assert.rejects(
    mainPactContainerV1(argvFor(undefined, 'NET-Q-0001')),
    /Invalid PACT task id: NET-Q-0001/,
  );
  // Datasets outside the host-owned registry never run.
  await assert.rejects(
    mainPactContainerV1(argvFor('pact-unknown', 'NET-Q-0001')),
    /Unsupported PACT container dataset: pact-unknown/,
  );
});
