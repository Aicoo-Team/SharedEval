import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  PactAdapterV1,
  PactBoundaryPlanV1,
  PactDecisionV1,
  PactFinalizeReportV1,
  PactObservationV1,
  PactRunInitV1,
  PactTaskIntroV1,
  PactToolSpecV1,
} from '../../../src/protocol/v1/index.js';
import type {
  SharedOsModulesV1,
  SoKernel,
  SoToolCall,
  SoToolResult,
} from '../../../src/execution/sharedos/v1/index.js';
import {
  createPactAdapterSoTurnDriverV1,
  createPactPairEmbeddedWorldV1,
  derivePactPairSharedOsCapabilitiesV1,
  parsePactPairSharedOsTerminalOutputV1,
  visiblePactPairSharedOsToolNamesV1,
} from '../../../src/suites/pact-pair/sharedos.js';
import { PACT_PAIR_TOOL_SPECS_V1 } from '../../../src/suites/pact-pair/tools.js';
import { loadCanonicalPactPairStoreV1 } from '../../../src/suites/pact-pair/workspace.js';

const PUBLIC_TASK: PactTaskIntroV1 = {
  taskId: 'qa:sharedos-1',
  kind: 'qa',
  surface: 'notes',
  prompt: 'What is Project Alpha?',
  requester: { id: 'requester-1', displayName: 'Requester' },
  target: { id: 'owner-1', displayName: 'Owner' },
};

const NOTES_READ: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: false },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
};

const FULL_PAIR_ACCESS: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: true },
    todos: { read: true, write: true },
    memory: { read: 'none', write: false },
  },
};

const identityDecisionSanitizer = (
  decision: PactDecisionV1,
): PactDecisionV1 => structuredClone(decision);

class ToolThenAnswerAdapter implements PactAdapterV1 {
  readonly observations: PactObservationV1[] = [];
  scopedTools: PactToolSpecV1[] = [];

  async initialize(_init: PactRunInitV1): Promise<void> {}

  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return NOTES_READ;
  }

  setExecutionToolsV1(tools: readonly PactToolSpecV1[]): void {
    this.scopedTools = tools.map(tool => structuredClone(tool));
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    this.observations.push(structuredClone(observation));
    if (observation.type === 'task') {
      return {
        type: 'tool_call',
        toolName: 'get_note',
        input: { title: 'Project Alpha Overview' },
      };
    }
    return {
      type: 'answer',
      content: JSON.stringify(observation.output),
    };
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'completed' };
  }
}

type CapturedHandler = {
  definition: {
    name: string;
    namespace: string;
    source: string;
    readWrite: 'read' | 'write';
    requiredCapability: {
      resource: { namespace: string; path: string[] };
      action: string;
    };
  };
  parseArguments(arguments_: Record<string, never> | Record<string, unknown>): Record<string, unknown>;
  invoke(
    context: Record<string, unknown>,
    call: SoToolCall,
    signal: AbortSignal,
  ): Promise<SoToolResult>;
};

test('PACT adapter tool calls run through a registered Pair SharedOS handler', async () => {
  const adapter = new ToolThenAnswerAdapter();
  let id = 0;
  const driver = createPactAdapterSoTurnDriverV1({
    adapter,
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
    sanitizeDecision: identityDecisionSanitizer,
    clock: { nowMs: () => 1_000 },
    now: () => '2026-08-06T00:00:00.000Z',
    idGen: { next: prefix => `${prefix}-${++id}` },
  });

  const visibleNames = visiblePactPairSharedOsToolNamesV1(NOTES_READ);
  const session = await driver.open({
    context: {
      traceId: 'trace-pair-1',
      now: '2026-08-06T00:00:00.000Z',
    },
    message: {},
    tools: visibleNames.map(name => ({ name })),
  }, new AbortController().signal);

  const first = await session.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.equal(first.type, 'tool_call');
  if (first.type !== 'tool_call') return;
  assert.equal(first.call.tool, 'get_note');
  assert.equal(first.call.traceId, 'trace-pair-1');

  const pairWorld = createPactPairEmbeddedWorldV1({
    seed: loadCanonicalPactPairStoreV1(),
    grantedAccess: NOTES_READ,
  });
  const handlers: CapturedHandler[] = [];
  await pairWorld.world.setup({
    registerTool(handler: unknown) {
      handlers.push(handler as CapturedHandler);
    },
  } as SoKernel, {} as SharedOsModulesV1);

  assert.equal(handlers.length, PACT_PAIR_TOOL_SPECS_V1.length);
  const getNote = handlers.find(handler => handler.definition.name === 'get_note');
  assert.ok(getNote);
  assert.deepEqual(
    {
      namespace: getNote.definition.namespace,
      source: getNote.definition.source,
      readWrite: getNote.definition.readWrite,
    },
    { namespace: 'pact-pair', source: 'pact', readWrite: 'read' },
  );
  assert.deepEqual(getNote.definition.requiredCapability, {
    resource: {
      namespace: 'pact-pair',
      path: ['notes'],
      owner: { kind: 'human', userId: 'pact-pair-owner' },
    },
    action: 'read',
  });
  assert.deepEqual(
    getNote.parseArguments({ title: '  Project Alpha Overview  ' }),
    { title: 'Project Alpha Overview' },
  );
  assert.throws(() => getNote.parseArguments({ title: '   ' }));

  const result = await getNote.invoke(
    { now: '2026-08-06T00:00:01.000Z' },
    first.call,
    new AbortController().signal,
  );
  assert.equal(result.status, 'succeeded');
  assert.match(JSON.stringify(result.output), /Project Alpha Overview/);

  const terminal = await session.next(
    { type: 'tool_result', result },
    new AbortController().signal,
  );
  assert.equal(terminal.type, 'complete');
  if (terminal.type !== 'complete') return;
  const decision = parsePactPairSharedOsTerminalOutputV1(terminal.output);
  assert.equal(decision.type, 'answer');
  assert.match(decision.type === 'answer' ? decision.content : '', /Project Alpha Overview/);

  assert.deepEqual(
    adapter.scopedTools.map(tool => tool.name),
    visibleNames,
  );
  assert.equal(adapter.observations.length, 2);
  assert.deepEqual(driver.getStateV1(), {
    turns: 2,
    toolCallCount: 1,
    toolCalls: [{ id: 'pact-call-1', name: 'get_note', isError: false }],
    finalDecision: decision,
  });
});

test('Pair grants and visible tools are the least-privilege projection of access', () => {
  assert.deepEqual(derivePactPairSharedOsCapabilitiesV1(NOTES_READ), [{
    resource: {
      namespace: 'pact-pair',
      path: ['notes'],
      owner: { kind: 'human', userId: 'pact-pair-owner' },
    },
    actions: ['read'],
    scope: 'exact',
  }]);
  assert.deepEqual(visiblePactPairSharedOsToolNamesV1(NOTES_READ), [
    'search_notes',
    'get_note',
  ]);
  assert.equal(visiblePactPairSharedOsToolNamesV1(FULL_PAIR_ACCESS).length, 9);
  assert.deepEqual(
    derivePactPairSharedOsCapabilitiesV1(FULL_PAIR_ACCESS)
      .map(capability => [capability.resource.path[0], capability.actions]),
    [
      ['notes', ['read', 'write']],
      ['todos', ['read', 'write']],
    ],
  );

  const bundle = createPactPairEmbeddedWorldV1({
    seed: loadCanonicalPactPairStoreV1(),
    grantedAccess: NOTES_READ,
  });
  const grants = bundle.world.senderGrants({
    testkit: {
      createTestGrant: (options: Record<string, unknown>) => structuredClone(options),
    },
  } as unknown as SharedOsModulesV1, 'namespace-pair-1');
  assert.deepEqual(grants, [{
    id: 'grant-pact-pair-tools',
    namespaceId: 'namespace-pair-1',
    subject: { kind: 'agent', agentId: 'pact-pair-requester' },
    issuer: { kind: 'human', userId: 'pact-pair-owner' },
    capabilities: derivePactPairSharedOsCapabilitiesV1(NOTES_READ),
    purposes: ['pact-pair-task'],
    issuedAt: '1970-01-01T00:00:00.000Z',
  }]);
});

test('visible-tool mismatches fail closed before the PACT adapter sees the task', async () => {
  const adapter = new ToolThenAnswerAdapter();
  const driver = createPactAdapterSoTurnDriverV1({
    adapter,
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: identityDecisionSanitizer,
  });

  await assert.rejects(
    driver.open({
      context: { traceId: 'trace-bad-tools' },
      message: {},
      tools: [{ name: 'get_note' }, { name: 'create_note' }],
    }, new AbortController().signal),
    /visible tool mismatch/,
  );
  assert.equal(adapter.observations.length, 0);
  assert.equal(adapter.scopedTools.length, 0);
});

test('a PACT tool decision outside the granted SharedOS surface is rejected', async () => {
  const adapter = new ToolThenAnswerAdapter();
  adapter.step = async observation => {
    adapter.observations.push(structuredClone(observation));
    return {
      type: 'tool_call',
      toolName: 'create_note',
      input: { folder: 'Projects', title: 'Nope', content: 'Nope' },
    };
  };
  const driver = createPactAdapterSoTurnDriverV1({
    adapter,
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: identityDecisionSanitizer,
  });
  const session = await driver.open({
    context: { traceId: 'trace-outside-grant' },
    message: {},
    tools: visiblePactPairSharedOsToolNamesV1(NOTES_READ).map(name => ({ name })),
  }, new AbortController().signal);

  const decision = await session.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.deepEqual(decision, {
    type: 'fail',
    error: {
      code: 'pact_tool_outside_grant',
      message: 'The PACT adapter requested a tool outside the visible SharedOS surface.',
    },
  });
  assert.equal(driver.getStateV1().toolCallCount, 0);
});

test('host sanitizer transforms tool input before it enters SharedOS', async () => {
  const credential = 'sk-private-credential';
  const adapter = new ToolThenAnswerAdapter();
  adapter.step = async observation => {
    adapter.observations.push(structuredClone(observation));
    return {
      type: 'tool_call',
      toolName: 'get_note',
      input: { title: `Bearer ${credential}` },
    };
  };
  const driver = createPactAdapterSoTurnDriverV1({
    adapter,
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: decision => decision.type === 'tool_call'
      ? {
          ...decision,
          input: { title: String(decision.input.title).replace(credential, '[REDACTED]') },
        }
      : decision,
  });
  const session = await driver.open({
    context: { traceId: 'trace-sanitized-input' },
    message: {},
    tools: visiblePactPairSharedOsToolNamesV1(NOTES_READ).map(name => ({ name })),
  }, new AbortController().signal);

  const decision = await session.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.equal(decision.type, 'tool_call');
  if (decision.type !== 'tool_call') return;
  assert.deepEqual(decision.call.arguments, { title: 'Bearer [REDACTED]' });
  assert.doesNotMatch(JSON.stringify(decision), new RegExp(credential));
});

test('sanitizer failures are preserved by the out-of-band failure channel', async () => {
  const sanitizerFailure = new Error('credential sanitizer failed');
  const driver = createPactAdapterSoTurnDriverV1({
    adapter: new ToolThenAnswerAdapter(),
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: () => {
      throw sanitizerFailure;
    },
  });
  const session = await driver.open({
    context: { traceId: 'trace-sanitizer-failure' },
    message: {},
    tools: visiblePactPairSharedOsToolNamesV1(NOTES_READ).map(name => ({ name })),
  }, new AbortController().signal);

  const decision = await session.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.equal(decision.type, 'fail');
  assert.equal(driver.getFailureV1(), sanitizerFailure);
  assert.doesNotMatch(JSON.stringify(driver.getStateV1()), /sanitizer failed/);
});

test('adapter.step failures remain available out of band and reset on open', async () => {
  const adapter = new ToolThenAnswerAdapter();
  const originalFailure = new Error('provider exploded with diagnostic context');
  adapter.step = async observation => {
    adapter.observations.push(structuredClone(observation));
    throw originalFailure;
  };
  const driver = createPactAdapterSoTurnDriverV1({
    adapter,
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: identityDecisionSanitizer,
  });
  const request = {
    context: { traceId: 'trace-adapter-failure' },
    message: {},
    tools: visiblePactPairSharedOsToolNamesV1(NOTES_READ).map(name => ({ name })),
  };
  const session = await driver.open(request, new AbortController().signal);

  const decision = await session.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.equal(decision.type, 'fail');
  assert.equal(driver.getFailureV1(), originalFailure);
  const serializableState = driver.getStateV1();
  assert.doesNotThrow(() => structuredClone(serializableState));
  assert.doesNotMatch(JSON.stringify(serializableState), /provider exploded/);

  await session.close?.('failed', new AbortController().signal);
  const nextSession = await driver.open(request, new AbortController().signal);
  assert.equal(driver.getFailureV1(), undefined);
  await nextSession.close?.('cancelled', new AbortController().signal);
});

test('driver state identifies max-tool-call and max-turn forced escalations', async () => {
  const visibleTools = visiblePactPairSharedOsToolNamesV1(NOTES_READ)
    .map(name => ({ name }));

  const toolBudgetDriver = createPactAdapterSoTurnDriverV1({
    adapter: new ToolThenAnswerAdapter(),
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 0, maxRuntimeMs: 1_000 },
    sanitizeDecision: identityDecisionSanitizer,
  });
  const toolBudgetSession = await toolBudgetDriver.open({
    context: { traceId: 'trace-tool-budget' },
    message: {},
    tools: visibleTools,
  }, new AbortController().signal);
  const toolBudgetDecision = await toolBudgetSession.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.equal(toolBudgetDecision.type, 'complete');
  assert.equal(
    toolBudgetDriver.getStateV1().terminationReason,
    'max_tool_calls_exceeded',
  );

  const turnBudgetDriver = createPactAdapterSoTurnDriverV1({
    adapter: new ToolThenAnswerAdapter(),
    task: PUBLIC_TASK,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 1, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: identityDecisionSanitizer,
  });
  const turnBudgetSession = await turnBudgetDriver.open({
    context: { traceId: 'trace-turn-budget' },
    message: {},
    tools: visibleTools,
  }, new AbortController().signal);
  const toolCall = await turnBudgetSession.next(
    { type: 'start' },
    new AbortController().signal,
  );
  assert.equal(toolCall.type, 'tool_call');
  if (toolCall.type !== 'tool_call') return;
  const turnBudgetDecision = await turnBudgetSession.next({
    type: 'tool_result',
    result: {
      callId: toolCall.call.id,
      tool: toolCall.call.tool,
      status: 'succeeded',
      output: { note: 'irrelevant' },
      completedAt: '2026-08-06T00:00:00.000Z',
    },
  }, new AbortController().signal);
  assert.equal(turnBudgetDecision.type, 'complete');
  assert.equal(
    turnBudgetDriver.getStateV1().terminationReason,
    'max_turns_exceeded',
  );
});

test('private gold fields cannot enter the driver task or canonical Pair world', () => {
  const sentinel = 'PRIVATE_GOLD_CANARY_7d41';
  const contaminatedTask = {
    ...PUBLIC_TASK,
    gold_key_facts: [sentinel],
  } as PactTaskIntroV1;
  assert.throws(() => createPactAdapterSoTurnDriverV1({
    adapter: new ToolThenAnswerAdapter(),
    task: contaminatedTask,
    grantedAccess: NOTES_READ,
    budget: { maxTurns: 2, maxToolCalls: 1, maxRuntimeMs: 1_000 },
    sanitizeDecision: identityDecisionSanitizer,
  }));

  const privateWrapper = {
    seed: loadCanonicalPactPairStoreV1(),
    expectedBehavior: sentinel,
    goldLabel: sentinel,
  };
  const bundle = createPactPairEmbeddedWorldV1({
    seed: privateWrapper.seed,
    grantedAccess: NOTES_READ,
  });
  const exposed = JSON.stringify({
    canonicalWorld: bundle.world.canonicalWorld,
    expectedVisibleTools: bundle.expectedVisibleTools,
  });
  assert.doesNotMatch(exposed, new RegExp(sentinel));
  assert.doesNotMatch(exposed, /goldLabel|expectedBehavior/);
  assert.deepEqual(bundle.canonicalWorld.grantedAccess, NOTES_READ);
  assert.deepEqual(
    bundle.canonicalWorld.visibleToolNames,
    bundle.expectedVisibleTools,
  );
  assert.equal(bundle.canonicalWorld.allTools.length, 9);
});
