import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PactBoundaryPlanV1, PactTaskIntroV1 } from '../../../src/protocol/v1/index.js';
import type {
  SharedOsModulesV1,
  SoTurnDriver,
} from '../../../src/execution/sharedos/v1/index.js';
import { createEmbeddedPersistentLegacyWorldV1 } from '../../../src/suites/pact-pair/legacy-transcript/embedded-world.js';
import { createLocalPersistentLegacyWorldV1 } from '../../../src/suites/pact-pair/legacy-transcript/world.js';
import { PersistentLegacyResponderSessionV1 } from '../../../src/suites/pact-pair/legacy-transcript/responder-session.js';
import { expectedVisibleSharedOsToolsV1 } from '../../../src/suites/pact-pair/sharedos-execution.js';
import { PACT_PAIR_TOOL_SPECS_V1 } from '../../../src/suites/pact-pair/tools.js';
import { loadCanonicalPactPairStoreV1 } from '../../../src/suites/pact-pair/workspace.js';

const task: PactTaskIntroV1 = {
  taskId: 'PAIR-A-test',
  kind: 'action',
  prompt: 'Create then find a note.',
  operation: 'create_note',
  surface: 'notes',
  requester: { id: 'R1', relationship: 'colleague' },
  target: { id: 'ALEX', relationship: 'owner' },
};
const access: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: true },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
};

function toolResponse(id: string, name: string, input: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      }],
    } }],
  }), { status: 200 });
}

function answerResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  }), { status: 200 });
}

test('the public-runner legacy world persists workspace and transcript across ticks', async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const responses = [
    toolResponse('create-1', 'create_note', {
      folder: 'Work', title: 'Legacy persistent note', content: 'survives tick one',
    }),
    answerResponse('created'),
    toolResponse('search-2', 'search_notes', { query: 'Legacy persistent note' }),
    answerResponse('found it'),
  ];
  const responder = new PersistentLegacyResponderSessionV1({
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'responder-v1',
      maxOutputTokens: 100,
    },
    credential: 'secret',
    requesterId: 'R1',
    persona: { coo: 'COO', policy: 'POLICY', memory: 'MEMORY' },
    tools: PACT_PAIR_TOOL_SPECS_V1,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
      const response = responses.shift();
      if (!response) throw new Error('unexpected provider call');
      return response;
    },
    retryWait: async () => {},
  });
  await responder.initialize({ sessionId: 'trajectory-1', publicChecklist: [task] });
  const world = createLocalPersistentLegacyWorldV1({
    seed: loadCanonicalPactPairStoreV1(),
    sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
  });
  const visible = expectedVisibleSharedOsToolsV1(access);

  const first = await world.runTick({
    trajectoryId: 'trajectory-1', tick: 1, task,
    requesterPrompt: task.prompt, principalId: 'requester-R1',
    grantedAccess: access, expectedVisibleTools: visible,
    budget: { maxTurns: 3, maxToolCalls: 2 },
    deadlineMs: Date.now() + 1_000, responder,
  });
  assert.equal(first.substrateStatus, 'succeeded');
  assert.equal(first.terminalReceived, true);
  assert.equal(first.toolCalls.length, 1);
  assert.equal(world.snapshot().notes.some(note => note.title === 'Legacy persistent note'), true);

  const second = await world.runTick({
    trajectoryId: 'trajectory-1', tick: 2, task,
    requesterPrompt: 'Find the note from the prior tick.', principalId: 'requester-R1',
    grantedAccess: access, expectedVisibleTools: visible,
    budget: { maxTurns: 3, maxToolCalls: 2 },
    deadlineMs: Date.now() + 1_000, responder,
  });
  assert.equal(second.substrateStatus, 'succeeded');
  assert.equal(second.finalDecision.type, 'answer');
  assert.match(JSON.stringify(requests.at(-1)), /Legacy persistent note/);

  const providerCalls = responder.privateTranscript().flatMap(message =>
    message.role === 'assistant' ? (message.tool_calls ?? []).map(call => call.id) : []);
  const providerResults = responder.privateTranscript().flatMap(message =>
    message.role === 'tool' ? [message.tool_call_id] : []);
  assert.deepEqual(providerResults.sort(), providerCalls.sort());
});

test('turn budget closure records a result for every provider call without continuation', async () => {
  let providerCalls = 0;
  const responder = new PersistentLegacyResponderSessionV1({
    model: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'responder-v1', maxOutputTokens: 100,
    },
    credential: 'secret', requesterId: 'R1',
    persona: { coo: 'COO', policy: 'POLICY', memory: 'MEMORY' },
    tools: PACT_PAIR_TOOL_SPECS_V1,
    fetch: async () => {
      providerCalls += 1;
      return toolResponse('search-only', 'search_notes', { query: 'alpha' });
    },
    retryWait: async () => {},
  });
  await responder.initialize({ sessionId: 'trajectory-budget', publicChecklist: [task] });
  const world = createLocalPersistentLegacyWorldV1({
    seed: loadCanonicalPactPairStoreV1(),
    sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
  });
  const result = await world.runTick({
    trajectoryId: 'trajectory-budget', tick: 1, task,
    requesterPrompt: task.prompt, principalId: 'requester-R1',
    grantedAccess: access, expectedVisibleTools: expectedVisibleSharedOsToolsV1(access),
    budget: { maxTurns: 1, maxToolCalls: 2 },
    deadlineMs: Date.now() + 1_000, responder,
  });
  assert.equal(result.substrateStatus, 'budget');
  assert.equal(result.terminalReceived, false);
  assert.equal(providerCalls, 1);
  assert.equal(
    responder.privateTranscript().filter(message => message.role === 'tool').length,
    1,
  );
});

test('embedded and public worlds expose the same per-tick tool surface while grants change', async () => {
  const responses = [
    toolResponse('notes-call', 'search_notes', { query: 'alpha' }),
    answerResponse('notes done'),
    toolResponse('todos-call', 'search_todos', { query: 'alpha' }),
    answerResponse('todos done'),
  ];
  const responder = new PersistentLegacyResponderSessionV1({
    model: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'responder-v1', maxOutputTokens: 100,
    },
    credential: 'secret', requesterId: 'R1',
    persona: { coo: 'COO', policy: 'POLICY', memory: 'MEMORY' },
    tools: PACT_PAIR_TOOL_SPECS_V1,
    fetch: async () => {
      const response = responses.shift();
      if (!response) throw new Error('unexpected provider call');
      return response;
    },
    retryWait: async () => {},
  });
  const todoTask: PactTaskIntroV1 = {
    taskId: 'PAIR-Q-todos', kind: 'qa', prompt: 'Search todos.',
    surface: 'todos',
    requester: task.requester,
    target: task.target,
  };
  await responder.initialize({
    sessionId: 'embedded-trajectory', publicChecklist: [task, todoTask],
  });
  const embedded = await createEmbeddedPersistentLegacyWorldV1({
    modules: fakeSharedOsModules(),
    seed: loadCanonicalPactPairStoreV1(),
    trajectoryId: 'embedded-trajectory',
    worldId: 'embedded-world',
    namespaceId: 'embedded-namespace',
    principalId: 'requester-R1',
    responder,
    requestedModel: 'responder-v1',
    sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
  });
  const notes = await embedded.runTick({
    trajectoryId: 'embedded-trajectory', tick: 1, task,
    requesterPrompt: task.prompt, principalId: 'requester-R1',
    grantedAccess: access, expectedVisibleTools: expectedVisibleSharedOsToolsV1(access),
    budget: { maxTurns: 3, maxToolCalls: 2 }, deadlineMs: Date.now() + 1_000,
    responder,
  });
  const todoAccess: PactBoundaryPlanV1 = {
    access: {
      notes: { read: { scope: 'none' }, write: false },
      todos: { read: true, write: false },
      memory: { read: 'none', write: false },
    },
  };
  const todos = await embedded.runTick({
    trajectoryId: 'embedded-trajectory', tick: 2, task: todoTask,
    requesterPrompt: todoTask.prompt, principalId: 'requester-R1',
    grantedAccess: todoAccess,
    expectedVisibleTools: expectedVisibleSharedOsToolsV1(todoAccess),
    budget: { maxTurns: 3, maxToolCalls: 2 }, deadlineMs: Date.now() + 1_000,
    responder,
  });
  assert.equal(notes.substrateStatus, 'succeeded');
  assert.deepEqual(notes.toolCalls.map(call => call.name), ['search_notes']);
  assert.equal(todos.substrateStatus, 'succeeded');
  assert.deepEqual(todos.toolCalls.map(call => call.name), ['search_todos']);
  assert.equal(notes.sharedOsRevision, todos.sharedOsRevision);
  await embedded.close();
});

function fakeSharedOsModules(): SharedOsModulesV1 {
  type Handler = {
    definition: {
      name: string;
      requiredCapability: { resource: { namespace: string }; action: string };
    };
    invoke(
      context: { now: string },
      call: { id: string; tool: string; arguments: Record<string, unknown> },
    ): Promise<unknown>;
  };
  const modules = {
    core: {
      agentExecutionCapability: () => ({ execution: true }),
    },
    runtime: {
      TurnExecutor: class {
        constructor(
          private readonly kernel: { __handlers: Handler[] },
          private readonly driver: SoTurnDriver,
        ) {}
        async execute(request: Record<string, unknown>) {
          const context = request.context as Record<string, unknown>;
          const tools = request.tools as Array<{ name: string }>;
          const controller = new AbortController();
          const session = await this.driver.open({
            context, tools, message: request.message as Record<string, unknown>,
          }, controller.signal);
          let input: Parameters<Awaited<ReturnType<SoTurnDriver['open']>>['next']>[0] = {
            type: 'start',
          };
          for (let step = 0; step < 20; step += 1) {
            const decision = await session.next(input, controller.signal);
            if (decision.type === 'complete') {
              await session.close?.('complete', controller.signal);
              return executionResult('succeeded', request, context, decision.output);
            }
            if (decision.type === 'fail') {
              await session.close?.('failed', controller.signal);
              return executionResult('failed', request, context, undefined, decision.error);
            }
            const visible = tools.some(tool => tool.name === decision.call.tool);
            const handler = this.kernel.__handlers.find(entry =>
              entry.definition.name === decision.call.tool);
            const result = visible && handler
              ? await handler.invoke({ now: String(context.now) }, {
                  id: decision.call.id,
                  tool: decision.call.tool,
                  arguments: decision.call.arguments,
                })
              : {
                  callId: decision.call.id, tool: decision.call.tool,
                  status: 'failed', error: { code: 'tool_unavailable' },
                  completedAt: String(context.now),
                };
            input = { type: 'tool_result', result: result as never };
          }
          return executionResult('failed', request, context, undefined, {
            code: 'step_limit',
          });
        }
      },
    },
    os: { createFileTools: () => [] },
    testkit: {
      createTestKernel() {
        const handlers: Handler[] = [];
        const kernel = {
          __handlers: handlers,
          registerTool(handler: unknown) { handlers.push(handler as Handler); },
          async listTools(context: Record<string, unknown>) {
            const grants = context.grants as Array<Record<string, unknown>>;
            return handlers
              .filter(handler => grants.some(grant =>
                (grant.capabilities as Array<Record<string, unknown>> | undefined)?.some(capability => {
                  const resource = capability.resource as { namespace?: string } | undefined;
                  const actions = capability.actions as string[] | undefined;
                  return resource?.namespace === handler.definition.requiredCapability.resource.namespace
                    && actions?.includes(handler.definition.requiredCapability.action);
                })))
              .map(handler => handler.definition);
          },
        };
        return { kernel, audit: { events: [] }, messages: [] };
      },
      createTestGrant(options: Record<string, unknown>) { return options; },
      InMemoryResourceProvider: class {},
    },
  };
  return modules as unknown as SharedOsModulesV1;
}

function executionResult(
  status: 'succeeded' | 'failed',
  request: Record<string, unknown>,
  context: Record<string, unknown>,
  output?: unknown,
  error?: unknown,
) {
  return {
    status,
    executionId: String(request.executionId),
    traceId: String(context.traceId),
    events: [],
    startedAt: String(context.now),
    completedAt: String(context.now),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
  };
}
