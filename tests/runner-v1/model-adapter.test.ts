import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PactBoundaryPlanV1,
  PactObservationV1,
} from '../../src/protocol/v1/index.js';
import {
  MAX_PACT_PROVIDER_RESPONSE_BYTES_V1,
  OpenAICompatiblePactAdapterV1,
} from '../../src/runner/v1/model-adapter.js';
import {
  pactRunConfigV1Schema,
  type PactRunConfigV1,
} from '../../src/runner/v1/config.js';
import {
  deniedAccessV1,
  validRunInitV1,
  validTaskV1,
} from '../protocol-v1/fixtures.js';

test('converts OpenAI-compatible runner and terminal tool calls into decisions', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    completionWithTool('provider-call-1', 'search_notes', { query: 'launch target' }),
    completionWithTool('provider-call-2', 'pact_answer', { content: 'The launch target is Friday.' }),
  ];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(responses.shift());
  }) as typeof fetch;
  const adapter = createAdapter(fetchMock);
  await adapter.initialize(validRunInitV1);
  const grantedAccess = await adapter.planBoundary(validTaskV1);

  const first = await adapter.step(taskObservation(grantedAccess));
  assert.deepEqual(first, {
    type: 'tool_call',
    toolName: 'search_notes',
    input: { query: 'launch target' },
  });

  const second = await adapter.step({
    type: 'tool_result',
    turn: 1,
    toolCallId: 'runner-tool-1',
    toolName: 'search_notes',
    output: { matches: [{ title: 'Launch', content: 'Friday' }] },
    isError: false,
    budgetRemaining: {
      turns: 6,
      toolCalls: 3,
      runtimeMs: 50_000,
    },
  });
  assert.deepEqual(second, {
    type: 'answer',
    content: 'The launch target is Friday.',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer unit-test-key');
  const firstBody = JSON.parse(String(calls[0].init?.body));
  assert.equal(firstBody.model, 'example-model');
  assert.equal(firstBody.temperature, 0.2);
  assert.equal(firstBody.max_completion_tokens, 4_096);
  assert.equal(firstBody.parallel_tool_calls, false);
  assert.deepEqual(
    firstBody.tools.map((tool: { function: { name: string } }) => tool.function.name),
    ['search_notes', 'pact_answer', 'pact_refuse', 'pact_escalate'],
  );
  assert.match(firstBody.messages[0].content, /Policy profile D2/);
  assert.doesNotMatch(firstBody.messages[0].content, /untrusted|cannot override/i);
  assert.match(firstBody.messages[1].content, /PAIR-TASK-001/);

  const secondBody = JSON.parse(String(calls[1].init?.body));
  assert.equal(secondBody.messages.at(-1).role, 'tool');
  assert.equal(secondBody.messages.at(-1).tool_call_id, 'provider-call-1');
});

test('supports refusal and text-only compatibility fallbacks', async () => {
  const responses = [
    completionWithTool('provider-refuse', 'pact_refuse', { reason: 'That information is private.' }),
    {
      choices: [{ message: { content: null, refusal: 'The provider blocked this request.' } }],
    },
    {
      choices: [{ message: { content: 'A plain compatible response.' } }],
    },
  ];
  const fetchMock = (async () => jsonResponse(responses.shift())) as typeof fetch;

  const refusalAdapter = createAdapter(fetchMock);
  await refusalAdapter.initialize(validRunInitV1);
  assert.deepEqual(
    await refusalAdapter.step(taskObservation(deniedAccessV1)),
    { type: 'refuse', reason: 'That information is private.' },
  );

  const providerRefusalAdapter = createAdapter(fetchMock);
  await providerRefusalAdapter.initialize(validRunInitV1);
  assert.deepEqual(
    await providerRefusalAdapter.step(taskObservation(deniedAccessV1)),
    { type: 'refuse', reason: 'The provider blocked this request.' },
  );

  const textAdapter = createAdapter(fetchMock);
  await textAdapter.initialize(validRunInitV1);
  assert.deepEqual(
    await textAdapter.step(taskObservation(deniedAccessV1)),
    { type: 'answer', content: 'A plain compatible response.' },
  );
});

test('omits temperature when the config leaves it to the provider default', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      choices: [{ message: { content: 'A compatible response.' } }],
    });
  }) as typeof fetch;
  const config = pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'reasoning-model',
    },
  });
  const adapter = new OpenAICompatiblePactAdapterV1(config, {
    fetch: fetchMock,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);
  await adapter.step(taskObservation(deniedAccessV1));

  assert.ok(requestBody);
  assert.equal('temperature' in requestBody, false);
});

test('plans task-surface access without requesting unavailable memory', async () => {
  const fetchMock = (async () => jsonResponse({
    choices: [{ message: { content: 'unused' } }],
  })) as typeof fetch;
  const config = validConfig({
    benchmark: {
      policy: 'D2',
      requester: 'R0',
      tasks: { kind: 'all' },
    },
  });
  const adapter = new OpenAICompatiblePactAdapterV1(config, {
    fetch: fetchMock,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);

  const plan = await adapter.planBoundary({
    ...validTaskV1,
    kind: 'action',
    operation: 'complete',
    surface: 'todos',
  });
  assert.deepEqual(plan, {
    access: {
      notes: { read: { scope: 'none' }, write: false },
      todos: { read: true, write: true },
      memory: { read: 'none', write: false },
    },
  });

  const correlatedPlan = await adapter.planBoundary({
    ...validTaskV1,
    surface: 'unknown',
  });
  assert.deepEqual(correlatedPlan, {
    access: {
      notes: { read: { scope: 'all' }, write: false },
      todos: { read: true, write: false },
      memory: { read: 'none', write: false },
    },
  });
});

test('redacts provider response bodies and configured credentials from errors', async () => {
  const secret = 'SECRET_PROVIDER_CANARY';
  const fetchMock = (async () => new Response(
    JSON.stringify({ error: `invalid api_key ${secret}` }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: fetchMock,
    environment: { PACT_MODEL_API_KEY: secret },
  });
  await adapter.initialize(validRunInitV1);

  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /SECRET_PROVIDER_CANARY|api_key/);
      return true;
    },
  );
});

test('redacts a configured credential echoed by the provider', async () => {
  const secret = 'unit-test-echoed-key';
  const fetchMock = (async () => jsonResponse({
    choices: [{ message: { content: `unexpected ${secret}` } }],
  })) as typeof fetch;
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: fetchMock,
    environment: { PACT_MODEL_API_KEY: secret },
  });
  await adapter.initialize(validRunInitV1);
  const decision = await adapter.step(taskObservation(deniedAccessV1));
  assert.deepEqual(decision, { type: 'answer', content: 'unexpected [REDACTED]' });
});

test('aborts a provider request at the configured deadline', async () => {
  let observedSignal: AbortSignal | undefined;
  const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  }) as typeof fetch;
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: fetchMock,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
    timeoutMs: 5,
  });
  await adapter.initialize(validRunInitV1);

  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    /timed out after 5ms/,
  );
  assert.equal(observedSignal?.aborted, true);
});

test('rejects oversized or structurally hostile provider responses', async () => {
  const oversizedAdapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => new Response(
      'x'.repeat(MAX_PACT_PROVIDER_RESPONSE_BYTES_V1 + 1),
      { status: 200 },
    )) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await oversizedAdapter.initialize(validRunInitV1);
  await assert.rejects(
    oversizedAdapter.step(taskObservation(deniedAccessV1)),
    /response exceeds .* bytes/,
  );

  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 70; depth += 1) nested = { nested };
  const deepAdapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => jsonResponse({
      choices: [{ message: { content: 'unused' } }],
      untrusted: nested,
    })) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await deepAdapter.initialize(validRunInitV1);
  await assert.rejects(
    deepAdapter.step(taskObservation(deniedAccessV1)),
    /exceeds JSON depth/,
  );
});

test('bounds parsed tool argument complexity before protocol validation', async () => {
  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 70; depth += 1) nested = { nested };
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => jsonResponse(
      completionWithTool('deep-call', 'search_notes', nested as object),
    )) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);
  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    /tool arguments exceeds JSON depth/,
  );
});

test('retries transient provider responses within the request budget', async () => {
  let calls = 0;
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      }
      return jsonResponse({ choices: [{ message: { content: 'Recovered.' } }] });
    }) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);

  assert.deepEqual(
    await adapter.step(taskObservation(deniedAccessV1)),
    { type: 'answer', content: 'Recovered.' },
  );
  assert.equal(calls, 2);
});

function createAdapter(fetchImplementation: typeof fetch): OpenAICompatiblePactAdapterV1 {
  return new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: fetchImplementation,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
}

function validConfig(overrides: Partial<PactRunConfigV1> = {}): PactRunConfigV1 {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'example-model',
      temperature: 0.2,
    },
    benchmark: {
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all' },
    },
    budget: {
      maxTurns: 8,
      maxToolCalls: 4,
      maxRuntimeMs: 60_000,
    },
    output: {
      directory: 'runs',
      saveTraces: false,
    },
    ...overrides,
  });
}

function taskObservation(grantedAccess: PactBoundaryPlanV1): PactObservationV1 {
  return {
    type: 'task',
    turn: 0,
    task: validTaskV1,
    grantedAccess,
    budgetRemaining: {
      turns: 8,
      toolCalls: 4,
      runtimeMs: 60_000,
    },
  };
}

function completionWithTool(id: string, name: string, input: object) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(input),
          },
        }],
      },
    }],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
