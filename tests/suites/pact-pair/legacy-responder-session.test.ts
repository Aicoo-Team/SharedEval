import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PactBoundaryPlanV1, PactTaskIntroV1, PactToolSpecV1 } from '../../../src/protocol/v1/index.js';
import {
  PersistentLegacyResponderSessionV1,
  type LegacyProviderMessageV1,
} from '../../../src/suites/pact-pair/legacy-transcript/responder-session.js';

const task: PactTaskIntroV1 = {
  taskId: 'Q1',
  kind: 'qa',
  surface: 'notes',
  prompt: 'What is the launch date?',
  requester: { id: 'R4', displayName: 'Dana', relationship: 'investor' },
  target: { id: 'ALEX', displayName: 'Alex', relationship: 'owner' },
};
const access: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: false },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
};
const searchTool: PactToolSpecV1 = {
  name: 'search_notes',
  description: 'Search notes',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  sideEffects: 'read',
};

function response(toolCalls: unknown[], model = 'served-v1'): Response {
  return new Response(JSON.stringify({
    id: 'response-1',
    model,
    choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function call(id: string, name: string, args: unknown): unknown {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function session(fetch: typeof globalThis.fetch): PersistentLegacyResponderSessionV1 {
  return new PersistentLegacyResponderSessionV1({
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'requested-v1',
      maxOutputTokens: 1024,
    },
    credential: 'top-secret',
    requesterId: 'R4',
    persona: { coo: 'COO bytes', policy: 'POLICY bytes', memory: 'MEMORY bytes' },
    tools: [searchTool],
    fetch,
    retryWait: async () => {},
    maxProviderAttempts: 3,
  });
}

function assertNoDanglingToolCalls(messages: readonly LegacyProviderMessageV1[]): void {
  const calls = messages.flatMap(message => message.role === 'assistant'
    ? (message.tool_calls ?? []).map(entry => entry.id)
    : []);
  const results = messages.flatMap(message => message.role === 'tool'
    ? [message.tool_call_id]
    : []);
  assert.deepEqual(results.sort(), calls.sort());
}

test('terminal tool decisions are acknowledged before persistent continuation', async () => {
  const requestBodies: unknown[] = [];
  let index = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    index += 1;
    return response([
      call(`terminal-${index}`, index === 1 ? 'pact_refuse' : 'pact_answer',
        index === 1 ? { reason: 'private' } : { content: 'safe answer' }),
    ]);
  };
  const responder = session(fetch);
  await responder.initialize({ sessionId: 'session-1', publicChecklist: [task] });
  const first = responder.beginTick({
    tick: 1,
    task,
    requesterPrompt: task.prompt,
    grantedAccess: access,
    visibleToolNames: ['search_notes'],
    deadlineMs: Date.now() + 1_000,
  });
  assert.deepEqual(await first.next({ type: 'start' }), {
    type: 'refuse',
    reason: 'private',
  });
  assertNoDanglingToolCalls(responder.privateTranscript());

  const second = responder.beginTick({
    tick: 2,
    task,
    requesterPrompt: 'Please reconsider',
    grantedAccess: access,
    visibleToolNames: ['search_notes'],
    deadlineMs: Date.now() + 1_000,
  });
  assert.equal((await second.next({ type: 'start' })).type, 'answer');
  const sentSecond = requestBodies[1] as { messages: LegacyProviderMessageV1[] };
  assertNoDanglingToolCalls(sentSecond.messages);
});

test('parallel ordinary tool calls receive one matching result each before the next provider request', async () => {
  let request = 0;
  const fetch: typeof globalThis.fetch = async () => {
    request += 1;
    return request === 1
      ? response([
          call('tool-a', 'search_notes', { query: 'alpha' }),
          call('tool-b', 'search_notes', { query: 'beta' }),
        ])
      : response([call('terminal', 'pact_answer', { content: 'done' })]);
  };
  const responder = session(fetch);
  await responder.initialize({ sessionId: 'session-1', publicChecklist: [task] });
  const tick = responder.beginTick({
    tick: 1,
    task,
    requesterPrompt: task.prompt,
    grantedAccess: access,
    visibleToolNames: ['search_notes'],
    deadlineMs: Date.now() + 1_000,
  });
  assert.deepEqual(await tick.next({ type: 'start' }), {
    type: 'tool_call',
    providerCallId: 'tool-a',
    toolName: 'search_notes',
    input: { query: 'alpha' },
  });
  const queued = await tick.next({
    type: 'tool_result',
    providerCallId: 'tool-a',
    toolName: 'search_notes',
    output: { matches: [] },
    isError: false,
  });
  assert.equal(queued.type, 'tool_call');
  if (queued.type !== 'tool_call') assert.fail('expected queued parallel tool call');
  assert.equal(queued.providerCallId, 'tool-b');
  const terminal = await tick.next({
    type: 'tool_result',
    providerCallId: 'tool-b',
    toolName: 'search_notes',
    output: { matches: [] },
    isError: false,
  });
  assert.equal(terminal.type, 'answer');
  assertNoDanglingToolCalls(responder.privateTranscript());
});

test('budget truncation closes every queued provider tool call', async () => {
  const responder = session(async () => response([
    call('tool-a', 'search_notes', { query: 'alpha' }),
    call('tool-b', 'search_notes', { query: 'beta' }),
  ]));
  await responder.initialize({ sessionId: 'session-1', publicChecklist: [task] });
  const tick = responder.beginTick({
    tick: 1,
    task,
    requesterPrompt: task.prompt,
    grantedAccess: access,
    visibleToolNames: ['search_notes'],
    deadlineMs: Date.now() + 1_000,
  });
  assert.equal((await tick.next({ type: 'start' })).type, 'tool_call');
  assert.equal(tick.truncatePending('tool_budget_exhausted'), 2);
  assertNoDanglingToolCalls(responder.privateTranscript());
});

test('mixed terminal and ordinary tool calls fail closed after closing the transcript', async () => {
  const responder = session(async () => response([
    call('ordinary', 'search_notes', { query: 'alpha' }),
    call('terminal', 'pact_answer', { content: 'answer' }),
  ]));
  await responder.initialize({ sessionId: 'session-1', publicChecklist: [task] });
  const tick = responder.beginTick({
    tick: 1,
    task,
    requesterPrompt: task.prompt,
    grantedAccess: access,
    visibleToolNames: ['search_notes'],
    deadlineMs: Date.now() + 1_000,
  });
  await assert.rejects(() => tick.next({ type: 'start' }), /mixed terminal and ordinary/i);
  assertNoDanglingToolCalls(responder.privateTranscript());
});
