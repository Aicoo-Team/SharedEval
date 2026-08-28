import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SoTurnDriver,
  SoToolDefinition,
} from '../../src/execution/sharedos/v1/contracts.js';
import {
  createOpenAICompatibleFileTurnDriverV1,
  createProviderRateLimitGateV1,
  createServedModelConsistencyLedgerV1,
} from '../../src/runner/v1/file-model-driver.js';
import {
  SHAREDEVAL_MODEL_API_KEY_ENV_V1,
  pactModelConfigV1Schema,
} from '../../src/runner/v1/model-config.js';

const apiKey = 'unit-test-key';

test('projects only SharedOS-visible tool syntax and returns tool work to SharedOS', async () => {
  const requests: ProviderRequest[] = [];
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      completion({
        content: null,
        reasoning_details: [{ type: 'reasoning.text', text: 'bounded reasoning' }],
        tool_calls: [{
          id: 'provider-call-1',
          type: 'function',
          function: {
            name: 'files.read',
            arguments: JSON.stringify({ path: ['MEMORY.md'] }),
          },
        }],
      }, {
        usage: {
          prompt_tokens: 11,
          completion_tokens: 3,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
          cost: 0.01,
        },
      }),
      completion({ content: '  all done  ' }, {
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    ], requests),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const abort = new AbortController();
  const session = await driver.open(turnRequest(), abort.signal);

  const call = await session.next({ type: 'start' }, abort.signal);
  assert.deepEqual(call, {
    type: 'tool_call',
    call: {
      id: 'call-702de98fc392c60d3e3106b27635a0ee70d4fb71',
      tool: 'files.read',
      arguments: { path: ['MEMORY.md'] },
      traceId: 'trace-1',
      requestedAt: '2026-08-26T00:00:00.000Z',
    },
  });

  const complete = await session.next({
    type: 'tool_result',
    result: {
      callId: call.type === 'tool_call' ? call.call.id : 'unreachable',
      tool: 'files.read',
      status: 'succeeded',
      output: { content: 'memory bytes' },
      completedAt: '2026-08-26T00:00:01.000Z',
    },
  }, abort.signal);
  assert.deepEqual(complete, {
    type: 'complete',
    output: {
      type: 'completed',
      content: 'all done',
      toolSteps: 1,
      contactCalls: 0,
    },
  });

  const firstBody = requests[0]?.body;
  assert.ok(firstBody);
  assert.deepEqual(firstBody.tools, [{
    type: 'function',
    function: {
      name: 'files.read',
      description: 'Read one file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'array', items: { type: 'string' } } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  }]);
  assert.deepEqual(firstBody.messages, [{
    role: 'user',
    content: [
      'Follow the heartbeat.',
      '',
      'Before any other action, call files.read for AGENT.md, HEARTBEAT.md, POLICY.md, and MEMORY.md; all four successful reads are required in this turn.',
      '',
      'For messages.request, pass exactly recipient and payload; recipient is {"kind":"agent","agentId":"responder"}, payload contains only taskId and message, and no other fields are allowed.',
      '',
      'After messages.request returns, you must successfully call files.replace on MEMORY.md before returning final output. expectedVersion is the exact string version from the latest files.read result and content is the complete file with exactly one line per existing task in the same order: TASK-ID [pending|answered|refused|error] — single-line note. Add no headings, fences, blank lines, or extra text.',
    ].join('\n'),
  }]);
  assert.equal(firstBody.parallel_tool_calls, false);
  assert.equal(firstBody.tool_choice, 'auto');
  for (const privateField of [
    'requiredCapability',
    'private-owner',
    'private/resource/path',
    'authority',
    'grants',
    'namespaceId',
    'trace-1',
  ]) {
    assert.doesNotMatch(JSON.stringify(firstBody), new RegExp(privateField));
  }

  const secondMessages = requests[1]?.body.messages;
  assert.ok(secondMessages);
  assert.deepEqual(secondMessages.at(-2), {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'provider-call-1',
      type: 'function',
      function: {
        name: 'files.read',
        arguments: JSON.stringify({ path: ['MEMORY.md'] }),
      },
    }],
    reasoning_details: [{ type: 'reasoning.text', text: 'bounded reasoning' }],
  });
  assert.deepEqual(JSON.parse(String(secondMessages.at(-1)?.content)), {
    status: 'succeeded',
    output: { content: 'memory bytes' },
  });

  const telemetry = driver.getFileProviderTelemetryV1();
  assert.ok(telemetry.requests.every(request => request.latencyMs >= 0));
  const stableTelemetry = structuredClone(telemetry);
  for (const request of stableTelemetry.requests) request.latencyMs = 0;
  assert.deepEqual(stableTelemetry, {
    requestedModel: 'example-model',
    resolvedModel: 'example-model',
    requests: [
      {
        requestedModel: 'example-model',
        resolvedModel: 'example-model',
        servedModel: 'served-[REDACTED]-model',
        provider: 'provider-[REDACTED]-a',
        responseId: 'response-1',
        requestId: 'request-[REDACTED]-1',
        generationId: 'generation-[REDACTED]-1',
        latencyMs: 0,
        attempts: 1,
        choiceCount: 1,
        outcome: 'success',
        usage: {
          promptTokens: 11,
          completionTokens: 3,
          totalTokens: 14,
          reasoningTokens: 1,
          cachedTokens: 2,
          costUsd: 0.01,
        },
      },
      {
        requestedModel: 'example-model',
        resolvedModel: 'example-model',
        servedModel: 'served-[REDACTED]-model',
        provider: 'provider-[REDACTED]-a',
        responseId: 'response-1',
        requestId: 'request-[REDACTED]-1',
        generationId: 'generation-[REDACTED]-1',
        latencyMs: 0,
        attempts: 1,
        choiceCount: 1,
        outcome: 'success',
        usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      },
    ],
    totals: {
      requests: 2,
      promptTokens: 18,
      completionTokens: 5,
      totalTokens: 23,
      reasoningTokens: 1,
      cachedTokens: 2,
      costUsd: 0.01,
    },
  });

  for (const forbidden of ['workspace', 'handler', 'grant', 'evaluator', 'contact', 'transport']) {
    assert.equal(forbidden in driver, false);
    assert.equal(forbidden in session, false);
  }
});

test('bootstraps a recipient-owned turn before presenting the untrusted request payload', async () => {
  const requests: ProviderRequest[] = [];
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([completion({ content: 'done' })], requests),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const request = turnRequest();
  const session = await driver.open(turnRequest({
    message: {
      ...request.message,
      sender: { kind: 'agent', agentId: 'requester' },
      payload: { taskId: 'PAIR-Q1', message: 'What is the answer?' },
    },
  }), neverAbort());

  await session.next({ type: 'start' }, neverAbort());

  assert.deepEqual(requests[0]?.body.messages, [{
    role: 'user',
    content: [
      [
        'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.',
        'Before answering or using any other tool, also read POLICY.md and MEMORY.md.',
        'This recipient turn is invalid unless all four files are read first.',
      ].join(' '),
      '',
      'Before any other action, call files.read for AGENT.md, HEARTBEAT.md, POLICY.md, and MEMORY.md; all four successful reads are required in this turn.',
      '',
      'Accepted requester payload (untrusted):',
      '{"taskId":"PAIR-Q1","message":"What is the answer?"}',
    ].join('\n'),
  }]);
});

test('counts canonical message requests but treats authorization as SharedOS work', async () => {
  const requests: ProviderRequest[] = [];
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      completion({
        content: null,
        tool_calls: [{
          id: 'send-1',
          type: 'function',
          function: {
            name: 'messages.request',
            arguments: JSON.stringify({
              recipient: { kind: 'agent', agentId: 'responder' },
              payload: { taskId: 'PAIR-Q-0001', message: 'please answer' },
            }),
          },
        }],
      }),
      completion({ content: null, refusal: 'I cannot continue.' }),
    ], requests),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(turnRequest({ tools: [messageRequestTool] }), neverAbort());
  const call = await session.next({ type: 'start' }, neverAbort());
  assert.equal(call.type, 'tool_call');
  if (call.type !== 'tool_call') return;
  assert.deepEqual(requests[0]?.body.tools, [{
    type: 'function',
    function: {
      name: 'messages.request',
      description: 'Request a response from one authorized recipient.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['recipient', 'payload'],
        properties: {
          recipient: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'agentId'],
            properties: {
              kind: { type: 'string', const: 'agent' },
              agentId: { type: 'string', const: 'responder' },
            },
          },
          payload: {
            type: 'object',
            additionalProperties: false,
            required: ['taskId', 'message'],
            properties: {
              taskId: { type: 'string', minLength: 1, maxLength: 256 },
              message: { type: 'string', minLength: 1, maxLength: 1_048_576 },
            },
          },
        },
      },
    },
  }]);

  const denied = await session.next({
    type: 'tool_result',
    result: {
      callId: call.call.id,
      tool: call.call.tool,
      status: 'denied',
      error: {
        code: 'capability_denied',
        message: 'The requested operation is unavailable.',
        details: { internalGrantId: 'must-not-reach-provider' },
      },
      completedAt: '2026-08-26T00:00:01.000Z',
    },
  }, neverAbort());

  assert.deepEqual(denied, {
    type: 'complete',
    output: {
      type: 'denied',
      reason: 'I cannot continue.',
      toolSteps: 1,
      contactCalls: 1,
    },
  });
  const providerToolResult = String(requests[1]?.body.messages.at(-1)?.content);
  assert.doesNotMatch(providerToolResult, /internalGrantId|must-not-reach-provider/);
  assert.deepEqual(JSON.parse(providerToolResult), {
    status: 'denied',
    error: {
      code: 'capability_denied',
      message: 'The requested operation is unavailable.',
    },
  });
});

test('returns guessed tools to SharedOS instead of enforcing a second local policy', async () => {
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([completion({
      content: null,
      tool_calls: [{
        id: 'guess-1',
        type: 'function',
        function: { name: 'admin.grant_everything', arguments: '{}' },
      }],
    })], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(turnRequest(), neverAbort());

  const decision = await session.next({ type: 'start' }, neverAbort());

  assert.equal(decision.type, 'tool_call');
  if (decision.type === 'tool_call') {
    assert.equal(decision.call.tool, 'admin.grant_everything');
    assert.deepEqual(decision.call.arguments, {});
  }
});

test('fails closed with fixed text for malformed provider tool data', async () => {
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([completion({
      content: null,
      tool_calls: [{
        id: 'bad-1',
        type: 'function',
        function: { name: 'files.read', arguments: `${apiKey}{` },
      }],
    })], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(turnRequest(), neverAbort());

  const decision = await session.next({ type: 'start' }, neverAbort());

  assert.deepEqual(decision, {
    type: 'fail',
    error: {
      code: 'model_invalid_tool_call',
      message: 'File model provider returned malformed tool arguments',
    },
  });
  assert.doesNotMatch(JSON.stringify(decision), /unit-test-key/);
});

test('strictly bounds the terminal decision before returning it to SharedOS', async () => {
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([completion({ content: 'x'.repeat(1_048_577) })], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(turnRequest(), neverAbort());

  const decision = await session.next({ type: 'start' }, neverAbort());

  assert.deepEqual(decision, {
    type: 'fail',
    error: {
      code: 'model_invalid_response',
      message: 'File model provider returned an invalid turn decision',
    },
  });
  assert.equal(
    driver.getFileProviderTelemetryV1().requests[0]?.outcome,
    'invalid_response',
  );
});

test('retries only a definitive provider rate-limit rejection', async () => {
  const requests: ProviderRequest[] = [];
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      new Response('busy', { status: 429, headers: { 'retry-after': '0' } }),
      completion({ content: 'done' }),
    ], requests),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(turnRequest(), neverAbort());

  assert.deepEqual(await session.next({ type: 'start' }, neverAbort()), {
    type: 'complete',
    output: {
      type: 'completed',
      content: 'done',
      toolSteps: 0,
      contactCalls: 0,
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(driver.getFileProviderTelemetryV1().requests[0]?.attempts, 2);
});

test('never retries a provider operation whose external completion is unknown', async () => {
  const requests: ProviderRequest[] = [];
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      new Error('socket closed after write'),
      completion({ content: 'must not be used' }),
    ], requests),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(turnRequest(), neverAbort());

  const decision = await session.next({ type: 'start' }, neverAbort());
  assert.equal(decision.type, 'fail');
  assert.equal(requests.length, 1);
  assert.equal(driver.getFileProviderTelemetryV1().requests[0]?.attempts, 1);
});

test('refuses credential-bearing redirects without retrying', async () => {
  const redirectRequests: ProviderRequest[] = [];
  const redirecting = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      new Response('redirect', {
        status: 307,
        headers: { location: `https://evil.example/${apiKey}` },
      }),
    ], redirectRequests),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const redirectSession = await redirecting.open(turnRequest(), neverAbort());

  assert.deepEqual(await redirectSession.next({ type: 'start' }, neverAbort()), {
    type: 'fail',
    error: {
      code: 'model_provider_error',
      message: 'File model provider responded with a redirect; refusing to resend credentials',
      retryable: false,
    },
  });
  assert.equal(redirectRequests.length, 1);
  assert.equal(redirectRequests[0]?.init.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(redirecting.getFileProviderTelemetryV1()), /unit-test-key/);
});

test('uses the SharedOS timeout or cancellation signal for in-flight provider work', async () => {
  let observedSignal: AbortSignal | undefined;
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: async (_input, init) => {
      observedSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => {
          reject(observedSignal?.reason ?? new Error('aborted'));
        }, { once: true });
      });
    },
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const abort = new AbortController();
  const session = await driver.open(turnRequest(), abort.signal);
  const pending = session.next({ type: 'start' }, abort.signal);

  abort.abort(new Error('sharedos cancelled the turn'));

  await assert.rejects(pending, /sharedos cancelled the turn/);
  // The driver hands fetch a derived signal (the caller's, combined with this
  // attempt's own deadline), so assert that cancellation still propagates
  // rather than that the very same object was forwarded.
  assert.equal(observedSignal?.aborted, true);
});

test('bounds each provider attempt so one stalled request cannot drain the task budget', async () => {
  const outer = new AbortController();
  let calls = 0;
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: async (_input, init) => {
      calls += 1;
      const signal = init?.signal as AbortSignal;
      if (calls === 1) {
        // Stall the way a silently wedged provider connection does: never
        // respond, and settle only once some deadline aborts this request.
        // A real stall holds a live socket; this fake one must hold the event
        // loop itself, because the attempt deadline's AbortSignal.timeout
        // timer is unref'd and cannot keep the process alive on its own.
        return await new Promise<Response>((_resolve, reject) => {
          const keepAlive = setTimeout(() => {}, 10_000);
          signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(signal.reason ?? new Error('aborted'));
          }, { once: true });
        });
      }
      return completion({
        content: null,
        tool_calls: [{
          id: 'provider-call-1',
          type: 'function',
          function: {
            name: 'files.read',
            arguments: JSON.stringify({ path: ['MEMORY.md'] }),
          },
        }],
      });
    },
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
  });
  const session = await driver.open(
    turnRequest({ options: { maxSteps: 4, maxToolCalls: 3, timeoutMs: 50 } }),
    outer.signal,
  );

  const decision = await session.next({ type: 'start' }, outer.signal);

  // The stalled attempt was abandoned on its own deadline and the next attempt
  // ran, instead of the whole task budget draining into the first request.
  assert.equal(calls, 2);
  assert.equal(decision.type, 'tool_call');
  assert.equal(outer.signal.aborted, false);
});

test('accepts any provider while one run-shared ledger holds the served model fixed', async () => {
  const ledger = createServedModelConsistencyLedgerV1();
  const first = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      completion({ content: 'from provider a' }, { provider: 'provider-a' }),
    ], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    servedModelLedger: ledger,
  });
  const second = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      completion({ content: 'from provider b' }, { provider: 'provider-b' }),
    ], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    servedModelLedger: ledger,
  });

  const firstSession = await first.open(turnRequest(), neverAbort());
  const secondSession = await second.open(turnRequest(), neverAbort());

  assert.equal((await firstSession.next({ type: 'start' }, neverAbort())).type, 'complete');
  assert.equal((await secondSession.next({ type: 'start' }, neverAbort())).type, 'complete');
  assert.equal(second.getFileProviderTelemetryV1().requests[0]?.provider, 'provider-b');
});

test('fails the turn when a response reports a different served model than the run', async () => {
  const ledger = createServedModelConsistencyLedgerV1();
  const establishing = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([completion({ content: 'establishes identity' })], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    servedModelLedger: ledger,
  });
  const diverging = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      completion({ content: 'wrong model' }, { model: 'some-other-model' }),
    ], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    servedModelLedger: ledger,
  });

  const establishingSession = await establishing.open(turnRequest(), neverAbort());
  const divergingSession = await diverging.open(turnRequest(), neverAbort());
  assert.equal(
    (await establishingSession.next({ type: 'start' }, neverAbort())).type,
    'complete',
  );

  // The fixture's served model embeds the API key, so the mismatch message
  // must pass through credential redaction like every other provider string.
  assert.deepEqual(await divergingSession.next({ type: 'start' }, neverAbort()), {
    type: 'fail',
    error: {
      code: 'model_identity_mismatch',
      message: 'File model provider served "some-other-model" in a run that '
        + 'established "served-[REDACTED]-model"',
    },
  });
  // The divergent response is still fully recorded before the turn fails.
  assert.equal(
    diverging.getFileProviderTelemetryV1().requests[0]?.servedModel,
    'some-other-model',
  );
});

test('skips served-model enforcement when the provider omits the model field', async () => {
  const ledger = createServedModelConsistencyLedgerV1();
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      completion({ content: 'anonymous response' }, { model: undefined }),
    ], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    servedModelLedger: ledger,
  });
  const session = await driver.open(turnRequest(), neverAbort());

  assert.equal((await session.next({ type: 'start' }, neverAbort())).type, 'complete');
  assert.deepEqual(ledger.observe('later-model'), { consistent: true });
});

type ProviderMessage = {
  content?: string | null;
  refusal?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  reasoning_details?: unknown[];
};

type ProviderBody = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
};

type ProviderRequest = {
  url: string;
  init: RequestInit;
  body: ProviderBody;
  latencyMs?: number;
};

function completion(
  message: ProviderMessage,
  extras: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({
    id: 'response-1',
    model: `served-${apiKey}-model`,
    provider: `provider-${apiKey}-a`,
    choices: [{ message }],
    ...extras,
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `request-${apiKey}-1`,
      'x-generation-id': `generation-${apiKey}-1`,
    },
  });
}

function scriptedFetch(
  responses: Array<Response | Error>,
  requests: ProviderRequest[],
): typeof globalThis.fetch {
  let index = 0;
  return async (input, init = {}) => {
    const startedAt = Date.now();
    const body = JSON.parse(String(init.body)) as ProviderBody;
    const recorded: ProviderRequest = { url: String(input), init, body };
    requests.push(recorded);
    const response = responses[index];
    index += 1;
    if (!response) throw new Error('Unexpected provider request');
    recorded.latencyMs = Date.now() - startedAt;
    if (response instanceof Error) throw response;
    return response;
  };
}

function modelConfig() {
  return pactModelConfigV1Schema.parse({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnv: SHAREDEVAL_MODEL_API_KEY_ENV_V1,
    model: 'example-model',
  });
}

const fileReadTool: SoToolDefinition = {
  name: 'files.read',
  description: 'Read one file.',
  namespace: 'files',
  source: 'sharedos',
  readWrite: 'read',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'array', items: { type: 'string' } } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', privateAnnotation: 'do-not-send' },
  requiredCapability: {
    resource: {
      namespace: 'files',
      path: ['private', 'resource', 'path'],
      owner: { kind: 'agent', agentId: 'private-owner' },
    },
    action: 'read',
  },
};

const messageRequestTool: SoToolDefinition = {
  name: 'messages.request',
  description: 'Request a response from one authorized recipient.',
  namespace: 'messages',
  source: 'sharedos',
  readWrite: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      recipient: { type: 'object' },
      payload: { type: 'object' },
    },
    required: ['recipient', 'payload'],
    additionalProperties: false,
  },
  requiredCapability: {
    resource: { namespace: 'messages', path: ['recipient'] },
    action: 'send',
  },
};

function turnRequest(
  overrides: Partial<Parameters<SoTurnDriver['open']>[0]> = {},
): Parameters<SoTurnDriver['open']>[0] {
  return {
    version: '1',
    executionId: 'execution-1',
    agent: { kind: 'agent', agentId: 'requester' },
    context: {
      actor: { kind: 'agent', agentId: 'requester' },
      owner: { kind: 'service', serviceId: 'sharedeval' },
      namespaceId: 'namespace-private',
      purpose: 'heartbeat',
      traceId: 'trace-1',
      now: '2026-08-26T00:00:00.000Z',
    },
    message: {
      version: '1',
      id: 'message-1',
      sender: { kind: 'service', serviceId: 'sharedeval' },
      receiver: { kind: 'agent', agentId: 'requester' },
      purpose: 'heartbeat',
      payload: { text: 'Follow the heartbeat.' },
      traceId: 'trace-1',
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    tools: [fileReadTool],
    ...overrides,
  };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

test('rate-limit gate lets unblocked work pass and holds callers through a block', async () => {
  const gate = createProviderRateLimitGateV1();
  await gate.wait(neverAbort());

  gate.block(60);
  const startedAt = Date.now();
  await gate.wait(neverAbort());
  assert.ok(Date.now() - startedAt >= 45, 'wait returned before the block cleared');

  gate.block(5_000);
  const controller = new AbortController();
  const waiting = assert.rejects(gate.wait(controller.signal), /cancelled|abort/i);
  controller.abort();
  await waiting;
});

test('one 429 blocks the shared gate and every driver still settles through it', async () => {
  const gate = createProviderRateLimitGateV1();
  const limited = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([
      new Response('busy', { status: 429, headers: { 'retry-after': '0.05' } }),
      completion({ content: 'recovered' }),
    ], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    rateLimitGate: gate,
  });
  const limitedSession = await limited.open(turnRequest(), neverAbort());
  const limitedStart = Date.now();

  assert.equal(
    (await limitedSession.next({ type: 'start' }, neverAbort())).type,
    'complete',
  );
  assert.ok(Date.now() - limitedStart >= 40, '429 retry skipped the blocked window');
  assert.equal(limited.getFileProviderTelemetryV1().requests[0]?.attempts, 2);

  // A sibling driver arriving while the gate is blocked waits the window out.
  gate.block(60);
  const sibling = createOpenAICompatibleFileTurnDriverV1({
    model: modelConfig(),
    fetch: scriptedFetch([completion({ content: 'after the window' })], []),
    environment: { SHAREDEVAL_MODEL_API_KEY: apiKey },
    rateLimitGate: gate,
  });
  const siblingSession = await sibling.open(turnRequest(), neverAbort());
  const siblingStart = Date.now();
  assert.equal(
    (await siblingSession.next({ type: 'start' }, neverAbort())).type,
    'complete',
  );
  assert.ok(Date.now() - siblingStart >= 45, 'sibling ignored the shared block');
});
