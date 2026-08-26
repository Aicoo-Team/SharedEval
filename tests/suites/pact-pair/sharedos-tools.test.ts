import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SoAccessContext,
  SoAddress,
  SoCapabilityRequirement,
  SoToolCall,
} from '../../../src/execution/sharedos/v1/contracts.js';
import type { JsonObject } from '../../../src/contracts/json.js';
import { createPactPairSharedOsToolHandlersV1 } from '../../../src/suites/pact-pair/sharedos-tools.js';
import {
  loadPactPairTasksV1,
  type LoadedPactPairTaskV1,
} from '../../../src/suites/pact-pair/task-loader.js';
import { PACT_PAIR_TOOL_SPECS_V1 } from '../../../src/suites/pact-pair/tools.js';
import {
  createPactPairWorkspaceV1,
  type PactPairWorkspaceV1,
} from '../../../src/suites/pact-pair/workspace.js';

const owner: SoAddress = { kind: 'service', serviceId: 'sharedeval' };
const context: SoAccessContext = {
  namespaceId: 'namespace-1',
  actor: { kind: 'agent', agentId: 'responder' },
  authority: owner,
  owner,
  purpose: 'sharedeval:pact-pair',
  traceId: 'trace-1',
  enabledToolNamespaces: ['pact-pair'],
  now: '2026-08-26T10:00:00.000Z',
};

const notesQa = loadTask('Q1');
const todosQa = loadTask('Q201');
const notesAction = loadTask('A1');
const todosAction = loadTask('A101');
const mixedQa: LoadedPactPairTaskV1 = {
  ...notesQa,
  publicTask: { ...notesQa.publicTask, surface: 'unknown' },
};

test('exposes only the accepted task surface and read/write task kind', () => {
  const cases: Array<readonly [LoadedPactPairTaskV1, readonly string[]]> = [
    [notesQa, ['search_notes', 'get_note']],
    [todosQa, ['search_todos', 'get_todo']],
    [mixedQa, ['search_notes', 'get_note', 'search_todos', 'get_todo']],
    [notesAction, ['search_notes', 'get_note', 'create_note', 'edit_note']],
    [
      todosAction,
      ['search_todos', 'get_todo', 'create_todo', 'edit_todo', 'complete_todo'],
    ],
  ];

  for (const [task, expected] of cases) {
    const handlers = createPactPairSharedOsToolHandlersV1({
      task,
      owner,
      workspace: createPactPairWorkspaceV1(),
    });
    assert.deepEqual(
      handlers.map(handler => handler.definition.name),
      expected,
      task.taskId,
    );
  }
});

test('binds every definition and argument-derived requirement to the accepted task', () => {
  const handlers = [
    ...createPactPairSharedOsToolHandlersV1({
      task: notesAction,
      owner,
      workspace: createPactPairWorkspaceV1(),
    }),
    ...createPactPairSharedOsToolHandlersV1({
      task: todosAction,
      owner,
      workspace: createPactPairWorkspaceV1(),
    }),
  ];
  const specs = new Map(PACT_PAIR_TOOL_SPECS_V1.map(spec => [spec.name, spec]));
  assert.equal(handlers.length, 9);

  for (const handler of handlers) {
    const name = handler.definition.name;
    const spec = specs.get(name);
    assert.ok(spec);
    const surface = name.endsWith('_note') || name.endsWith('_notes') ? 'notes' : 'todos';
    const action = name.startsWith('search_') || name.startsWith('get_')
      ? 'read'
      : name.startsWith('create_')
        ? 'create'
        : 'update';
    const task = surface === 'notes' ? notesAction : todosAction;
    const requirement: SoCapabilityRequirement = {
      resource: {
        namespace: 'pact-pair',
        path: ['task', task.taskId, surface],
        owner,
      },
      action,
    };

    assert.equal(handler.definition.namespace, 'pact-pair');
    assert.equal(handler.definition.source, 'sharedeval');
    assert.equal(handler.definition.readWrite, spec.sideEffects);
    assert.deepEqual(handler.definition.inputSchema, spec.inputSchema);
    assert.notEqual(handler.definition.inputSchema, spec.inputSchema);
    assert.deepEqual(handler.definition.requiredCapability, requirement);
    assert.deepEqual(
      handler.resolveRequirement?.(context, call(name, validArguments(name))),
      requirement,
    );
  }
});

test('maps raw success and sanitized failure to the SharedOS result identity and time', async () => {
  const handlers = createPactPairSharedOsToolHandlersV1({
    task: notesQa,
    owner,
    workspace: createPactPairWorkspaceV1(),
  });
  const getNote = requireHandler(handlers, 'get_note');

  const succeeded = await getNote.invoke(
    context,
    call('get_note', { title: 'Project Alpha Overview' }, 'call-success'),
    new AbortController().signal,
  );
  assert.equal(succeeded.callId, 'call-success');
  assert.equal(succeeded.tool, 'get_note');
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.completedAt, context.now);
  assert.match(JSON.stringify(succeeded.output), /Project Alpha Overview/);

  const failed = await getNote.invoke(
    context,
    call('get_note', { title: 'Does not exist' }, 'call-failure'),
    new AbortController().signal,
  );
  assert.deepEqual(failed, {
    callId: 'call-failure',
    tool: 'get_note',
    status: 'failed',
    error: { code: 'not_found', message: 'Note was not found' },
    completedAt: context.now,
  });

  const secret = 'postgres://secret-host/internal';
  const explodingWorkspace = new Proxy(createPactPairWorkspaceV1(), {
    get(target, property, receiver) {
      if (property === 'searchNotes') return () => { throw new Error(secret); };
      return Reflect.get(target, property, receiver);
    },
  });
  const search = requireHandler(createPactPairSharedOsToolHandlersV1({
    task: notesQa,
    owner,
    workspace: explodingWorkspace,
  }), 'search_notes');
  const unexpected = await search.invoke(
    context,
    call('search_notes', { query: 'alpha' }, 'call-error'),
    new AbortController().signal,
  );
  assert.equal(unexpected.status, 'failed');
  assert.deepEqual(unexpected.error, {
    code: 'tool_error',
    message: 'PACT-Pair tool execution failed',
  });
  assert.doesNotMatch(JSON.stringify(unexpected), /secret-host/);
});

test('rejects malformed arguments before any workspace work', async () => {
  const counted = countingWorkspace();
  const createNote = requireHandler(createPactPairSharedOsToolHandlersV1({
    task: notesAction,
    owner,
    workspace: counted.workspace,
  }), 'create_note');
  const malformed = {
    folder: 'Shared',
    title: 'Must not be created',
    content: 'Rejected before the workspace boundary.',
    privateOverride: true,
  };

  assert.throws(() => createNote.parseArguments(malformed));
  assert.throws(() => createNote.resolveRequirement?.(
    context,
    call('create_note', malformed),
  ));
  const result = await createNote.invoke(
    context,
    call('create_note', malformed, 'call-malformed'),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    callId: 'call-malformed',
    tool: 'create_note',
    status: 'failed',
    error: {
      code: 'invalid_arguments',
      message: 'Tool arguments did not match the declared schema',
    },
    completedAt: context.now,
  });
  assert.deepEqual(counted.touches, []);
});

test('observes a pre-cancelled signal before parsing or workspace work', async () => {
  const counted = countingWorkspace();
  const search = requireHandler(createPactPairSharedOsToolHandlersV1({
    task: notesQa,
    owner,
    workspace: counted.workspace,
  }), 'search_notes');
  const controller = new AbortController();
  const cancellation = new Error('turn cancelled');
  controller.abort(cancellation);

  await assert.rejects(
    search.invoke(
      context,
      call('search_notes', { query: 'alpha' }, 'call-cancelled'),
      controller.signal,
    ),
    cancellation,
  );
  assert.deepEqual(counted.touches, []);
});

function loadTask(id: string): LoadedPactPairTaskV1 {
  const task = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids: [id],
  })[0];
  assert.ok(task);
  return task;
}

function call(
  tool: string,
  arguments_: JsonObject,
  id = `call-${tool}`,
): SoToolCall {
  return {
    id,
    tool,
    arguments: arguments_,
    traceId: context.traceId,
    requestedAt: '2026-08-26T09:59:59.000Z',
  };
}

function validArguments(tool: string): JsonObject {
  switch (tool) {
    case 'search_notes':
    case 'search_todos': return { query: 'alpha' };
    case 'get_note': return { title: 'Project Alpha Overview' };
    case 'get_todo': return { title: 'Submit Q1 board deck' };
    case 'create_note': return { folder: 'Shared', title: 'Title', content: 'Content' };
    case 'edit_note': return { title: 'Project Alpha Overview', content: 'Content' };
    case 'create_todo': return { folder: 'Work', title: 'Title', description: 'Description' };
    case 'edit_todo': return { title: 'Submit Q1 board deck', description: 'Description' };
    case 'complete_todo': return { title: 'Submit Q1 board deck' };
    default: throw new Error(`No test arguments for ${tool}`);
  }
}

function requireHandler(
  handlers: ReturnType<typeof createPactPairSharedOsToolHandlersV1>,
  name: string,
) {
  const handler = handlers.find(candidate => candidate.definition.name === name);
  assert.ok(handler);
  return handler;
}

function countingWorkspace(): {
  workspace: PactPairWorkspaceV1;
  touches: string[];
} {
  const target = createPactPairWorkspaceV1();
  const touches: string[] = [];
  const workspace = new Proxy(target, {
    get(candidate, property) {
      const value = Reflect.get(candidate, property, candidate) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        touches.push(String(property));
        return Reflect.apply(value, candidate, args);
      };
    },
  });
  return { workspace, touches };
}
