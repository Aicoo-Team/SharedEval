import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PactBoundaryPlanV1,
  PactObservationV1,
} from '../../src/protocol/v1/index.js';
import {
  MAX_PACT_PROVIDER_RESPONSE_BYTES_V1,
  OpenAICompatiblePactAdapterV1,
  PactProviderRequestErrorV1,
  readPactProviderTelemetryV1,
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
  assert.equal(firstBody.max_tokens, 4_096);
  assert.equal(firstBody.max_completion_tokens, undefined);
  assert.equal(firstBody.parallel_tool_calls, undefined);
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

test('SharedOS tool scoping narrows the model catalog and cannot widen it', async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ init });
    return jsonResponse(completionWithTool(
      'provider-answer',
      'pact_answer',
      { content: 'No tool was needed.' },
    ));
  }) as typeof fetch;
  const adapter = createAdapter(fetchMock);
  await adapter.initialize(validRunInitV1);
  adapter.setExecutionToolsV1([]);

  const decision = await adapter.step(taskObservation(deniedAccessV1));
  assert.deepEqual(decision, { type: 'answer', content: 'No tool was needed.' });
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(
    body.tools.map((tool: { function: { name: string } }) => tool.function.name),
    ['pact_answer', 'pact_refuse', 'pact_escalate'],
  );

  const widening = createAdapter(fetchMock);
  await widening.initialize(validRunInitV1);
  assert.throws(() => widening.setExecutionToolsV1([{
    name: 'create_note',
    description: 'Create a note.',
    inputSchema: { type: 'object', properties: {} },
    sideEffects: 'write',
  }]), /cannot add create_note/);
});

test('supports refusal and text-only compatibility fallbacks', async () => {
  const responses = [
    completionWithTool('provider-refuse', 'pact_refuse', { reason: 'That information is private.' }),
    {
      choices: [{
        message: {
          content: null,
          refusal: 'The provider blocked this request.',
          tool_calls: null,
        },
      }],
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

test('serializes compatible multi-tool responses and preserves reasoning details', async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const responses = [
    {
      id: 'gen-multi-1',
      model: 'served-reasoning-model',
      choices: [{
        message: {
          content: null,
          reasoning_details: [{
            type: 'reasoning.text',
            text: 'Need both note searches.',
          }],
          tool_calls: [
            {
              id: 'provider-call-a',
              type: 'function',
              function: {
                name: 'search_notes',
                arguments: JSON.stringify({ query: 'launch date' }),
              },
            },
            {
              id: 'provider-call-b',
              type: 'function',
              function: {
                name: 'search_notes',
                arguments: JSON.stringify({ query: 'launch owner' }),
              },
            },
          ],
        },
      }],
    },
    completionWithTool(
      'provider-answer',
      'pact_answer',
      { content: 'Friday, owned by Alex.' },
    ),
  ];
  const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ init });
    return jsonResponse(responses.shift());
  }) as typeof fetch;
  const adapter = createAdapter(fetchMock);
  await adapter.initialize(validRunInitV1);
  const grantedAccess = await adapter.planBoundary(validTaskV1);

  assert.deepEqual(await adapter.step(taskObservation(grantedAccess)), {
    type: 'tool_call',
    toolName: 'search_notes',
    input: { query: 'launch date' },
  });
  assert.deepEqual(await adapter.step(toolResultObservation(
    1,
    'search_notes',
    { matches: [] },
  )), {
    type: 'tool_call',
    toolName: 'search_notes',
    input: { query: 'launch owner' },
  });
  assert.equal(calls.length, 1, 'the queued call must not trigger another completion');

  assert.deepEqual(await adapter.step(toolResultObservation(
    2,
    'search_notes',
    { matches: [] },
  )), {
    type: 'answer',
    content: 'Friday, owned by Alex.',
  });
  assert.equal(calls.length, 2);

  const secondBody = JSON.parse(String(calls[1]?.init?.body));
  const assistant = secondBody.messages.find(
    (message: { role: string }) => message.role === 'assistant',
  );
  assert.equal(assistant.tool_calls.length, 2);
  assert.deepEqual(assistant.reasoning_details, [{
    type: 'reasoning.text',
    text: 'Need both note searches.',
  }]);
  assert.equal(
    secondBody.messages.filter(
      (message: { role: string }) => message.role === 'tool',
    ).length,
    2,
  );
});

test('captures sanitized model, provider, request, token, and cost telemetry', async () => {
  const fetchMock = (async () => jsonResponse({
    id: 'generation-body-id',
    model: 'served/example-model-2026-07',
    provider: 'Example Provider',
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      cost: 0.0042,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 7 },
    },
    choices: [{ message: { content: 'A compatible response.', tool_calls: null } }],
  }, {
    'x-request-id': 'request-header-id',
    'x-generation-id': 'generation-header-id',
  })) as typeof fetch;
  const adapter = createAdapter(fetchMock);
  await adapter.initialize(validRunInitV1);
  await adapter.step(taskObservation(deniedAccessV1));

  const telemetry = readPactProviderTelemetryV1(adapter);
  assert.ok(telemetry);
  assert.equal(telemetry.requests.length, 1);
  const request = telemetry.requests[0];
  assert.ok(request);
  assert.equal(Number.isSafeInteger(request.latencyMs), true);
  assert.ok(request.latencyMs >= 0);
  assert.deepEqual({ ...telemetry, requests: [{ ...request, latencyMs: 0 }] }, {
    requestedModel: 'example-model',
    requests: [{
      requestedModel: 'example-model',
      servedModel: 'served/example-model-2026-07',
      provider: 'Example Provider',
      responseId: 'generation-body-id',
      requestId: 'request-header-id',
      generationId: 'generation-header-id',
      latencyMs: 0,
      attempts: 1,
      choiceCount: 1,
      outcome: 'success',
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        reasoningTokens: 7,
        cachedTokens: 20,
        costUsd: 0.0042,
      },
    }],
    totals: {
      requests: 1,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      reasoningTokens: 7,
      cachedTokens: 20,
      costUsd: 0.0042,
    },
  });
});

test('reports response-shape diagnostics without echoing provider content', async () => {
  const secretContent = 'DO_NOT_ECHO_PROVIDER_BODY';
  const adapter = createAdapter((async () => jsonResponse({
    choices: [{
      message: {
        content: secretContent,
        tool_calls: { malformed: secretContent },
      },
    }],
  })) as typeof fetch);
  await adapter.initialize(validRunInitV1);

  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid first choice/);
      assert.match(error.message, /tool_calls/);
      assert.doesNotMatch(error.message, new RegExp(secretContent));
      return true;
    },
  );
  assert.equal(
    readPactProviderTelemetryV1(adapter)?.requests[0]?.outcome,
    'invalid_response',
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
      seed: 42,
      reasoning: { effort: 'low' },
      providerRouting: {
        requireParameters: true,
        allowFallbacks: false,
        only: ['example-provider'],
      },
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
  assert.equal(requestBody.seed, 42);
  assert.deepEqual(requestBody.reasoning, { effort: 'low' });
  assert.deepEqual(requestBody.provider, {
    require_parameters: true,
    allow_fallbacks: false,
    only: ['example-provider'],
  });
});

test('plans task-surface access without requesting unavailable memory', async () => {
  const fetchMock = (async () => jsonResponse({
    choices: [{ message: { content: 'unused' } }],
  })) as typeof fetch;
  const config = validConfig({
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R0',
      gradingMode: 'category',
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

test('treats exhausted provider credit as a fatal run configuration', () => {
  const error = new PactProviderRequestErrorV1(
    'OpenAI-compatible provider request failed with HTTP 402',
    { status: 402 },
  );
  assert.equal(error.fatalConfiguration, true);
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
      if (calls < 8) {
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
  assert.equal(calls, 8);
});

test('records exhausted provider retries as one failed logical request', async () => {
  let calls = 0;
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => {
      calls += 1;
      return new Response(null, {
        status: 429,
        headers: {
          'retry-after': '0',
          'x-openrouter-provider': 'Example Provider',
          'x-request-id': `request-${calls}`,
        },
      });
    }) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);

  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    /HTTP 429/,
  );
  assert.equal(calls, 8);
  const request = readPactProviderTelemetryV1(adapter)?.requests[0];
  assert.ok(request);
  assert.deepEqual({ ...request, latencyMs: 0 }, {
    requestedModel: 'example-model',
    provider: 'Example Provider',
    requestId: 'request-8',
    httpStatus: 429,
    lastResponseAttempt: 8,
    retryable: true,
    latencyMs: 0,
    attempts: 8,
    outcome: 'provider_error',
  });
});

test('preserves the last response metadata when a later retry has no response', async () => {
  let calls = 0;
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => {
      calls += 1;
      if (calls < 8) {
        return new Response(null, {
          status: 429,
          headers: {
            'retry-after': '0',
            'x-openrouter-provider': 'Example Provider',
            'x-request-id': `response-${calls}`,
          },
        });
      }
      throw new TypeError('synthetic network failure');
    }) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);

  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    /provider request failed/,
  );
  const request = readPactProviderTelemetryV1(adapter)?.requests[0];
  assert.ok(request);
  assert.equal(request.attempts, 8);
  assert.equal(request.httpStatus, 429);
  assert.equal(request.lastResponseAttempt, 7);
  assert.equal(request.provider, 'Example Provider');
  assert.equal(request.requestId, 'response-7');
  assert.equal(request.outcome, 'provider_error');
});

test('records unreadable successful HTTP responses as invalid responses', async () => {
  const adapter = new OpenAICompatiblePactAdapterV1(validConfig(), {
    fetch: (async () => new Response('{', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-openrouter-provider': 'Example Provider',
        'x-request-id': 'invalid-json-response',
      },
    })) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await adapter.initialize(validRunInitV1);

  await assert.rejects(
    adapter.step(taskObservation(deniedAccessV1)),
    /invalid JSON/,
  );
  const request = readPactProviderTelemetryV1(adapter)?.requests[0];
  assert.ok(request);
  assert.equal(request.attempts, 1);
  assert.equal(request.httpStatus, 200);
  assert.equal(request.lastResponseAttempt, 1);
  assert.equal(request.provider, 'Example Provider');
  assert.equal(request.requestId, 'invalid-json-response');
  assert.equal(request.outcome, 'invalid_response');
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
      dataset: 'pact-pair',
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

function toolResultObservation(
  turn: number,
  toolName: string,
  output: Extract<PactObservationV1, { type: 'tool_result' }>['output'],
): PactObservationV1 {
  return {
    type: 'tool_result',
    turn,
    toolCallId: `runner-tool-${turn}`,
    toolName,
    output,
    isError: false,
    budgetRemaining: {
      turns: 8 - turn,
      toolCalls: 4 - turn,
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

function jsonResponse(
  value: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
