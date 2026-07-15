import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  PactAdapterHostV1,
  servePactAdapterV1,
} from '../../src/adapter-host/v1/index.js';
import {
  MAX_PACT_WIRE_LINE_BYTES_V1,
  parsePactSubmissionResponseLineV1,
  type PactAdapterV1,
  type PactDecisionV1,
  type PactObservationV1,
  type PactRunnerRequestV1,
} from '../../src/protocol/v1/index.js';
import { deniedAccessV1, validRunInitV1, validTaskV1 } from './fixtures.js';

test('enforces a complete initialize-plan-step-finalize lifecycle', async () => {
  const host = new PactAdapterHostV1(createAdapter());

  const initialized = await send(host, {
    jsonrpc: '2.0',
    id: 'host-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  assert.ok(!('error' in initialized));
  assert.equal(host.state, 'initialized');

  const planned = await send(host, {
    jsonrpc: '2.0',
    id: 'host-plan',
    method: 'pact.planBoundary',
    params: { task: validTaskV1 },
  });
  assert.ok(!('error' in planned));
  assert.equal(host.state, 'planned');

  const firstStep = await send(host, taskStepRequest('host-task'));
  assert.ok(!('error' in firstStep));
  assert.equal(host.state, 'active');

  const secondStep = await send(host, toolResultRequest('host-tool-result'));
  assert.ok(!('error' in secondStep));
  assert.equal(host.state, 'decided');

  const finalized = await send(host, {
    jsonrpc: '2.0',
    id: 'host-finalize',
    method: 'pact.finalize',
    params: { reason: 'completed' },
  });
  assert.ok(!('error' in finalized));
  assert.equal(host.state, 'finalized');
});

test('returns lifecycle errors without advancing state', async () => {
  const host = new PactAdapterHostV1(createAdapter());
  const beforeInitialize = await send(host, taskStepRequest('host-too-early'));
  assert.ok('error' in beforeInitialize);
  if ('error' in beforeInitialize) assert.equal(beforeInitialize.error.code, -32_001);
  assert.equal(host.state, 'new');

  await send(host, {
    jsonrpc: '2.0',
    id: 'host-initialize-once',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  const duplicate = await send(host, {
    jsonrpc: '2.0',
    id: 'host-initialize-twice',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  assert.ok('error' in duplicate);
  if ('error' in duplicate) assert.equal(duplicate.error.code, -32_001);
  assert.equal(host.state, 'initialized');
});

test('requires a task first and one tool result after each tool call', async () => {
  const host = new PactAdapterHostV1(createAdapter());
  await send(host, {
    jsonrpc: '2.0',
    id: 'sequence-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  await send(host, {
    jsonrpc: '2.0',
    id: 'sequence-plan',
    method: 'pact.planBoundary',
    params: { task: validTaskV1 },
  });

  const toolResultFirst = await send(host, toolResultRequest('sequence-result-first'));
  assert.ok('error' in toolResultFirst);
  assert.equal(host.state, 'planned');

  await send(host, taskStepRequest('sequence-task'));
  const taskTwice = await send(host, taskStepRequest('sequence-task-twice'));
  assert.ok('error' in taskTwice);
  assert.equal(host.state, 'active');
});

test('converts invalid adapter output into a correlated adapter error', async () => {
  const invalidAdapter = createAdapter();
  invalidAdapter.planBoundary = async () => ({ invalid: true }) as never;
  const host = new PactAdapterHostV1(invalidAdapter);
  await send(host, {
    jsonrpc: '2.0',
    id: 'invalid-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  const response = await send(host, {
    jsonrpc: '2.0',
    id: 'invalid-plan',
    method: 'pact.planBoundary',
    params: { task: validTaskV1 },
  });
  assert.ok('error' in response);
  if ('error' in response) {
    assert.equal(response.id, 'invalid-plan');
    assert.equal(response.error.code, -32_000);
  }
  assert.equal(host.state, 'failed');

  const aborted = await send(host, {
    jsonrpc: '2.0',
    id: 'invalid-finalize',
    method: 'pact.finalize',
    params: { reason: 'aborted' },
  });
  assert.ok(!('error' in aborted));
  assert.equal(host.state, 'finalized');
});

test('binds the effective task and granted access to the boundary plan', async () => {
  const host = new PactAdapterHostV1(createAdapter());
  await send(host, {
    jsonrpc: '2.0',
    id: 'binding-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  await send(host, {
    jsonrpc: '2.0',
    id: 'binding-plan',
    method: 'pact.planBoundary',
    params: { task: validTaskV1 },
  });

  const changedTask = taskStepRequest('binding-changed-task');
  changedTask.params.observation.task = {
    ...validTaskV1,
    prompt: 'A different task with the same identifier',
  };
  const taskResponse = await send(host, changedTask);
  assert.ok('error' in taskResponse);
  assert.equal(host.state, 'planned');

  const widerAccess = taskStepRequest('binding-wider-access');
  widerAccess.params.observation.grantedAccess = {
    access: {
      notes: { read: { scope: 'all' }, write: false },
      todos: { read: false, write: false },
      memory: { read: 'none', write: false },
    },
  };
  const accessResponse = await send(host, widerAccess);
  assert.ok('error' in accessResponse);
  assert.equal(host.state, 'planned');
});

test('correlates tool results with the pending tool and turn', async () => {
  const host = new PactAdapterHostV1(createAdapter());
  await send(host, {
    jsonrpc: '2.0',
    id: 'tool-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  await send(host, {
    jsonrpc: '2.0',
    id: 'tool-plan',
    method: 'pact.planBoundary',
    params: { task: validTaskV1 },
  });
  await send(host, taskStepRequest('tool-task'));

  const wrongTool = toolResultRequest('tool-wrong-name');
  wrongTool.params.observation.toolName = 'search_todos';
  const wrongToolResponse = await send(host, wrongTool);
  assert.ok('error' in wrongToolResponse);
  assert.equal(host.state, 'active');

  const wrongTurn = toolResultRequest('tool-wrong-turn');
  wrongTurn.params.observation.turn = 2;
  const wrongTurnResponse = await send(host, wrongTurn);
  assert.ok('error' in wrongTurnResponse);
  assert.equal(host.state, 'active');

  const matching = await send(host, toolResultRequest('tool-matching-result'));
  assert.ok(!('error' in matching));
  assert.equal(host.state, 'decided');
});

test('allows completed finalize only after a terminal decision', async () => {
  const host = new PactAdapterHostV1(createAdapter());
  await send(host, {
    jsonrpc: '2.0',
    id: 'finalize-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  const early = await send(host, {
    jsonrpc: '2.0',
    id: 'finalize-early-completed',
    method: 'pact.finalize',
    params: { reason: 'completed' },
  });
  assert.ok('error' in early);
  assert.equal(host.state, 'initialized');

  const aborted = await send(host, {
    jsonrpc: '2.0',
    id: 'finalize-aborted',
    method: 'pact.finalize',
    params: { reason: 'aborted' },
  });
  assert.ok(!('error' in aborted));
  assert.equal(host.state, 'finalized');
});

test('redacts adapter exceptions and poisons the failed session', async () => {
  let planCalls = 0;
  const adapter = createAdapter();
  adapter.planBoundary = async () => {
    planCalls += 1;
    throw new Error('provider failed api_key=SECRET_CANARY');
  };
  const host = new PactAdapterHostV1(adapter);
  await send(host, {
    jsonrpc: '2.0',
    id: 'redact-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  const line = await host.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'redact-plan',
      method: 'pact.planBoundary',
      params: { task: validTaskV1 },
    }),
  );
  assert.doesNotMatch(line, /SECRET_CANARY|api_key/);
  assert.match(line, /Adapter execution failed/);
  assert.equal(host.state, 'failed');

  const retry = await send(host, {
    jsonrpc: '2.0',
    id: 'redact-plan-retry',
    method: 'pact.planBoundary',
    params: { task: validTaskV1 },
  });
  assert.ok('error' in retry);
  assert.equal(planCalls, 1);
});

test('attempts adapter finalization at most once even when it fails', async () => {
  let finalizeCalls = 0;
  const adapter = createAdapter();
  adapter.finalize = async () => {
    finalizeCalls += 1;
    throw new Error('cleanup failed after a partial side effect');
  };
  const host = new PactAdapterHostV1(adapter);
  await send(host, {
    jsonrpc: '2.0',
    id: 'finalize-once-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });

  const first = await send(host, {
    jsonrpc: '2.0',
    id: 'finalize-once-first',
    method: 'pact.finalize',
    params: { reason: 'aborted' },
  });
  const second = await send(host, {
    jsonrpc: '2.0',
    id: 'finalize-once-second',
    method: 'pact.finalize',
    params: { reason: 'aborted' },
  });

  assert.ok('error' in first);
  assert.ok('error' in second);
  if ('error' in second) assert.equal(second.error.code, -32_001);
  assert.equal(finalizeCalls, 1);
  assert.equal(host.state, 'failed');
});

test('bounds oversized stdin lines and continues at the next frame', async () => {
  const initializeRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 'bounded-initialize',
    method: 'pact.initialize',
    params: validRunInitV1,
  });
  const input = Readable.from([
    Buffer.alloc(MAX_PACT_WIRE_LINE_BYTES_V1 + 1, 0x20),
    Buffer.from(`\n${initializeRequest}\n`),
  ]);
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  await servePactAdapterV1(createAdapter(), { input, output: sink });

  const responses = output.trimEnd().split('\n').map(line => JSON.parse(line) as {
    id: string | null;
    result?: { ready?: boolean };
    error?: { code: number };
  });
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0], {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_600, message: 'Invalid JSON-RPC request' },
  });
  assert.equal(responses[1]?.id, 'bounded-initialize');
  assert.equal(responses[1]?.result?.ready, true);
});

test('classifies JSON-RPC parse, request, method, and params errors', async () => {
  const host = new PactAdapterHostV1(createAdapter());
  const cases = [
    { line: '{', id: null, code: -32_700 },
    { line: '[]', id: null, code: -32_600 },
    {
      line: JSON.stringify({ jsonrpc: '2.0', id: 'unknown-1', method: 'pact.unknown', params: {} }),
      id: 'unknown-1',
      code: -32_601,
    },
    {
      line: JSON.stringify({ jsonrpc: '2.0', id: 'params-1', method: 'pact.initialize', params: {} }),
      id: 'params-1',
      code: -32_602,
    },
  ];

  for (const entry of cases) {
    const response = JSON.parse(await host.handleLine(entry.line)) as {
      id: string | null;
      error: { code: number };
    };
    assert.equal(response.id, entry.id);
    assert.equal(response.error.code, entry.code);
  }
});

test('rejects duplicate request ids without invoking the adapter twice', async () => {
  let initializeCalls = 0;
  const adapter = createAdapter();
  adapter.initialize = async () => {
    initializeCalls += 1;
  };
  const host = new PactAdapterHostV1(adapter);
  const request = {
    jsonrpc: '2.0' as const,
    id: 'duplicate-initialize',
    method: 'pact.initialize' as const,
    params: validRunInitV1,
  };
  await send(host, request);
  const duplicate = await send(host, request);
  assert.ok('error' in duplicate);
  assert.equal(initializeCalls, 1);
  assert.equal(host.state, 'initialized');
});

function createAdapter(): PactAdapterV1 {
  return {
    async initialize() {},
    async planBoundary() {
      return deniedAccessV1;
    },
    async step(observation: PactObservationV1): Promise<PactDecisionV1> {
      return observation.type === 'task'
        ? { type: 'tool_call', toolName: 'search_notes', input: { query: 'launch' } }
        : { type: 'answer', content: 'September' };
    },
    async finalize() {
      return { status: 'completed', summary: 'Host test completed.' };
    },
  };
}

async function send<R extends PactRunnerRequestV1>(
  host: PactAdapterHostV1,
  request: R,
) {
  const line = await host.handleLine(JSON.stringify(request));
  return parsePactSubmissionResponseLineV1(line, {
    id: request.id,
    method: request.method,
  });
}

type StepRequest = Extract<PactRunnerRequestV1, { method: 'pact.step' }>;
type TaskStepRequest = Omit<StepRequest, 'params'> & {
  params: { observation: Extract<PactObservationV1, { type: 'task' }> };
};
type ToolResultRequest = Omit<StepRequest, 'params'> & {
  params: { observation: Extract<PactObservationV1, { type: 'tool_result' }> };
};

function taskStepRequest(id: string): TaskStepRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'pact.step',
    params: {
      observation: {
        type: 'task',
        turn: 0,
        task: validTaskV1,
        grantedAccess: deniedAccessV1,
        budgetRemaining: { turns: 8, toolCalls: 4, runtimeMs: 60_000 },
      },
    },
  };
}

function toolResultRequest(id: string): ToolResultRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'pact.step',
    params: {
      observation: {
        type: 'tool_result',
        turn: 1,
        toolCallId: 'tool-call-1',
        toolName: 'search_notes',
        output: { matches: [] },
        isError: false,
        budgetRemaining: { turns: 7, toolCalls: 3, runtimeMs: 59_000 },
      },
    },
  };
}
