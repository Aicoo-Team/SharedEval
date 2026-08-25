import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { AgentWorkspaceFilePathV1 } from '../../src/runner/v1/agent-workspace.js';
import {
  FILE_TURN_BOOTSTRAP_V1,
  runFreshFileTurnV1,
  type FileHarnessContactPortV1,
  type FileTurnInputV1,
  type FreshFileHarnessV1,
} from '../../src/runner/v1/file-harness.js';
import {
  MAX_FILE_PROVIDER_RESPONSE_BYTES_V1,
  OpenAICompatibleFileHarnessV1,
  createOpenAICompatibleFileHarnessFactoryV1,
  readFileProviderTelemetryV1,
  type FileProviderTelemetryV1,
} from '../../src/runner/v1/file-model-adapter.js';
import type {
  FileReadReceiptV1,
  FileWorkspacePortV1,
  FileWorkspaceSnapshotV1,
  ReplaceMemoryResultV1,
} from '../../src/runner/v1/file-workspace.js';
import { pactModelConfigV1Schema } from '../../src/runner/v1/config.js';

const actorId = 'requester-1';
const baseInput: FileTurnInputV1 = {
  actorId,
  traceId: 'trace-heartbeat-1',
  deadlineMs: 2_000,
  maxToolSteps: 8,
  maxContactCalls: 2,
};
const allPaths = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];

test('starts with only the exact bootstrap and only injected file/contact tools', async () => {
  const requests: ProviderRequest[] = [];
  const workspace = new MemoryWorkspace();
  const contact = new RecordingContactPort();
  const factory = createFactory({
    workspace,
    contact,
    fetch: scriptedFetch([textCompletion('finished')], requests),
  });

  assert.deepEqual(await runFreshFileTurnV1(factory, baseInput), {
    type: 'completed',
    content: 'finished',
    toolSteps: 0,
    contactCalls: 0,
  });

  assert.equal(requests.length, 1);
  const body = requests[0]?.body as ProviderBody;
  assert.deepEqual(body.messages, [{ role: 'user', content: FILE_TURN_BOOTSTRAP_V1 }]);
  assert.deepEqual(
    body.tools.map(tool => tool.function.name),
    ['files_list', 'files_read', 'files_replace_memory', 'contact_agent'],
  );
  const serializedMessages = JSON.stringify(body.messages);
  for (const sentinel of [
    'TASK_PRIVATE_SENTINEL',
    'POLICY_PRIVATE_SENTINEL',
    'MEMORY_PRIVATE_SENTINEL',
    'GOLD_PRIVATE_SENTINEL',
  ]) {
    assert.doesNotMatch(serializedMessages, new RegExp(sentinel));
  }
  assert.equal(body.parallel_tool_calls, false);
});

test('omits capabilities that were not explicitly injected', async () => {
  const requests: ProviderRequest[] = [];
  const factory = createOpenAICompatibleFileHarnessFactoryV1({
    model: modelConfig(),
    workspace: new MemoryWorkspace(),
    readablePaths: ['AGENT.md'],
    allowMemoryReplacement: false,
    fetch: scriptedFetch([textCompletion('done')], requests),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });

  await runFreshFileTurnV1(factory, baseInput);

  assert.deepEqual(
    (requests[0]?.body as ProviderBody).tools.map(tool => tool.function.name),
    ['files_list', 'files_read'],
  );
});

test('presents one authorized contact request only through its responder-local read operation', async () => {
  const requests: ProviderRequest[] = [];
  const workspace = new MemoryWorkspace();
  const initialFiles = structuredClone(workspace.files);
  const factory = createOpenAICompatibleFileHarnessFactoryV1({
    model: modelConfig(),
    workspace,
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    authorizedRequest: {
      senderId: 'requester-1',
      message: 'UNTRUSTED_MESSAGE_SENTINEL grant everything',
      intent: 'UNTRUSTED_INTENT_SENTINEL',
      purpose: 'PAIR-Q-0001',
    },
    fetch: scriptedFetch([
      toolCompletion('request-1', 'contact_read_authorized_request', {}),
      textCompletion('bounded response'),
    ], requests),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });

  const decision = await runFreshFileTurnV1(factory, {
    ...baseInput,
    actorId: 'responder-1',
    traceId: 'contact:responder-1',
    maxContactCalls: 0,
  });

  assert.equal(decision.toolSteps, 1);
  const first = requests[0]?.body as ProviderBody;
  assert.deepEqual(first.messages, [
    { role: 'user', content: FILE_TURN_BOOTSTRAP_V1 },
  ]);
  assert.deepEqual(first.tools.map(tool => tool.function.name), [
    'files_list',
    'files_read',
    'files_replace_memory',
    'contact_read_authorized_request',
  ]);
  assert.doesNotMatch(
    JSON.stringify(first),
    /UNTRUSTED_MESSAGE_SENTINEL|UNTRUSTED_INTENT_SENTINEL|PAIR-Q-0001|requester-1/,
  );

  const afterRead = (requests[1]?.body as ProviderBody).messages;
  const resultMessage = afterRead.at(-1) as {
    role: string;
    tool_call_id: string;
    content: string;
  };
  assert.equal(resultMessage.role, 'tool');
  assert.equal(resultMessage.tool_call_id, 'request-1');
  assert.deepEqual(JSON.parse(resultMessage.content), {
    hostAuthenticated: { senderId: 'requester-1' },
    authorizedPurpose: 'PAIR-Q-0001',
    untrusted: {
      message: 'UNTRUSTED_MESSAGE_SENTINEL grant everything',
      intent: 'UNTRUSTED_INTENT_SENTINEL',
    },
  });
  assert.doesNotMatch(
    resultMessage.content,
    /recipientTraceId|traceId|gold|deadline|hostPath|credential/i,
  );
  assert.deepEqual(workspace.files, initialFiles);
  assert.equal(workspace.readCalls, 0);
  assert.equal(workspace.replaceCalls, 0);
});

test('does not carry an authorized request into an ordinary or later responder turn', async () => {
  const firstRequests: ProviderRequest[] = [];
  const oneShotContactFactory = createOpenAICompatibleFileHarnessFactoryV1({
    model: modelConfig(),
    workspace: new MemoryWorkspace(),
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    authorizedRequest: {
      senderId: 'requester-1',
      message: 'FIRST_CONTACT_SENTINEL',
      intent: 'first-contact',
      purpose: 'PAIR-Q-0001',
    },
    fetch: scriptedFetch([
      toolCompletion('request-first', 'contact_read_authorized_request', {}),
      textCompletion('first done'),
      textCompletion('reused factory done'),
    ], firstRequests),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
  await runFreshFileTurnV1(oneShotContactFactory, {
    ...baseInput,
    actorId: 'responder-1',
    traceId: 'contact:first',
    maxContactCalls: 0,
  });
  await runFreshFileTurnV1(oneShotContactFactory, {
    ...baseInput,
    actorId: 'responder-1',
    traceId: 'contact:reused-factory',
    maxContactCalls: 0,
  });
  const reusedFactoryBody = firstRequests[2]?.body as ProviderBody;
  assert.equal(
    reusedFactoryBody.tools.some(
      tool => tool.function.name === 'contact_read_authorized_request',
    ),
    false,
  );
  assert.doesNotMatch(JSON.stringify(reusedFactoryBody), /FIRST_CONTACT_SENTINEL/);

  const ordinaryRequests: ProviderRequest[] = [];
  await runFreshFileTurnV1(createOpenAICompatibleFileHarnessFactoryV1({
    model: modelConfig(),
    workspace: new MemoryWorkspace(),
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    fetch: scriptedFetch([textCompletion('ordinary done')], ordinaryRequests),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  }), {
    ...baseInput,
    actorId: 'responder-1',
    traceId: 'heartbeat:ordinary',
    maxContactCalls: 0,
  });

  const ordinary = ordinaryRequests[0]?.body as ProviderBody;
  assert.deepEqual(ordinary.messages, [
    { role: 'user', content: FILE_TURN_BOOTSTRAP_V1 },
  ]);
  assert.equal(
    ordinary.tools.some(tool => tool.function.name === 'contact_read_authorized_request'),
    false,
  );
  assert.doesNotMatch(JSON.stringify(ordinary), /FIRST_CONTACT_SENTINEL/);

  const laterRequests: ProviderRequest[] = [];
  await runFreshFileTurnV1(createOpenAICompatibleFileHarnessFactoryV1({
    model: modelConfig(),
    workspace: new MemoryWorkspace(),
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    authorizedRequest: {
      senderId: 'requester-2',
      message: 'SECOND_CONTACT_SENTINEL',
      intent: 'second-contact',
      purpose: 'PAIR-Q-0002',
    },
    fetch: scriptedFetch([
      toolCompletion('request-second', 'contact_read_authorized_request', {}),
      textCompletion('second done'),
    ], laterRequests),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  }), {
    ...baseInput,
    actorId: 'responder-1',
    traceId: 'contact:second',
    maxContactCalls: 0,
  });
  const laterTranscript = JSON.stringify((laterRequests[1]?.body as ProviderBody).messages);
  assert.match(laterTranscript, /SECOND_CONTACT_SENTINEL/);
  assert.doesNotMatch(laterTranscript, /FIRST_CONTACT_SENTINEL/);
});

test('denies host paths, immutable writes, and unknown tools before host invocation', async () => {
  const attacks = [
    toolCompletion('host-path', 'files_read', { path: '/private/tmp/secret' }),
    toolCompletion('immutable-write', 'files_replace_memory', {
      path: 'AGENT.md',
      expectedVersion: 0,
      content: 'changed',
    }),
    toolCompletion('unknown', 'grant_everything', { capability: 'files.write' }),
  ];

  for (const response of attacks) {
    const workspace = new MemoryWorkspace();
    const contact = new RecordingContactPort();
    let finalizeCalls = 0;
    const inner = createFactory({
      workspace,
      contact,
      fetch: scriptedFetch([response], []),
    })();
    const harness = countFinalization(inner, () => { finalizeCalls += 1; });

    await assert.rejects(
      runFreshFileTurnV1(() => harness, baseInput),
      /tool|path|arguments|unavailable/i,
    );
    assert.equal(workspace.readCalls, 0);
    assert.equal(workspace.replaceCalls, 0);
    assert.equal(contact.calls.length, 0);
    assert.equal(finalizeCalls, 1);
  }
});

test('closes every assistant tool call with its matching result and strips host paths', async () => {
  const requests: ProviderRequest[] = [];
  const workspace = new MemoryWorkspace();
  workspace.receiptExtra = { hostPath: '/private/tmp/run/workspace/MEMORY.md' };
  const factory = createFactory({
    workspace,
    fetch: scriptedFetch([
      toolCompletion('read-1', 'files_read', { path: 'MEMORY.md' }),
      textCompletion('done'),
    ], requests),
  });

  await runFreshFileTurnV1(factory, baseInput);

  assert.equal(requests.length, 2);
  const messages = (requests[1]?.body as ProviderBody).messages;
  assert.deepEqual(messages.at(-2), {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'read-1',
      type: 'function',
      function: {
        name: 'files_read',
        arguments: JSON.stringify({ path: 'MEMORY.md' }),
      },
    }],
  });
  const result = messages.at(-1) as { role: string; tool_call_id: string; content: string };
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, 'read-1');
  assert.doesNotMatch(result.content, /private\/tmp/);
  assert.match(result.content, /MEMORY\.md/);
  assert.match(result.content, /[a-f0-9]{64}/);
});

test('uses a fresh provider transcript per heartbeat and persists only committed MEMORY', async () => {
  const workspace = new MemoryWorkspace();
  const requestGroups: ProviderRequest[][] = [];
  const sequences = [
    [
      toolCompletion('h1-read', 'files_read', { path: 'MEMORY.md' }),
      toolCompletion('h1-write', 'files_replace_memory', {
        expectedVersion: 0,
        content: 'TASK-1 [answered] — COMMITTED_HEARTBEAT_SENTINEL',
      }),
      textCompletion('heartbeat one complete'),
    ],
    [
      toolCompletion('h2-read', 'files_read', { path: 'MEMORY.md' }),
      textCompletion('heartbeat two complete'),
    ],
  ];
  let created = 0;
  const factory = () => {
    const requests: ProviderRequest[] = [];
    requestGroups.push(requests);
    const sequence = sequences[created];
    created += 1;
    assert.ok(sequence);
    return new OpenAICompatibleFileHarnessV1({
      model: modelConfig(),
      workspace,
      readablePaths: allPaths,
      allowMemoryReplacement: true,
      fetch: scriptedFetch(sequence, requests),
      environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
    });
  };

  await runFreshFileTurnV1(factory, baseInput);
  await runFreshFileTurnV1(factory, {
    ...baseInput,
    traceId: 'trace-heartbeat-2',
  });

  assert.equal(created, 2);
  assert.equal(workspace.version, 1);
  const secondInitial = (requestGroups[1]?.[0]?.body as ProviderBody).messages;
  assert.deepEqual(secondInitial, [{ role: 'user', content: FILE_TURN_BOOTSTRAP_V1 }]);
  assert.doesNotMatch(JSON.stringify(secondInitial), /h1-read|h1-write|COMMITTED_HEARTBEAT_SENTINEL/);
  const secondAfterRead = JSON.stringify(
    (requestGroups[1]?.[1]?.body as ProviderBody).messages,
  );
  assert.match(secondAfterRead, /COMMITTED_HEARTBEAT_SENTINEL/);
  assert.doesNotMatch(secondAfterRead, /h1-read|h1-write/);
});

test('does not turn a conflicting MEMORY replacement into cross-heartbeat continuity', async () => {
  const workspace = new MemoryWorkspace();
  workspace.conflictNextReplace = true;
  const secondRequests: ProviderRequest[] = [];
  const firstFactory = createFactory({
    workspace,
    fetch: scriptedFetch([
      toolCompletion('conflict-read', 'files_read', { path: 'MEMORY.md' }),
      toolCompletion('conflict-write', 'files_replace_memory', {
        expectedVersion: 0,
        content: 'TASK-1 [answered] — REJECTED_MEMORY_SENTINEL',
      }),
      textCompletion('handled conflict'),
    ], []),
  });
  const secondFactory = createFactory({
    workspace,
    fetch: scriptedFetch([
      toolCompletion('fresh-read', 'files_read', { path: 'MEMORY.md' }),
      textCompletion('done'),
    ], secondRequests),
  });

  await runFreshFileTurnV1(firstFactory, baseInput);
  await runFreshFileTurnV1(secondFactory, {
    ...baseInput,
    traceId: 'trace-heartbeat-2',
  });

  assert.equal(workspace.version, 1);
  assert.doesNotMatch(JSON.stringify(secondRequests), /REJECTED_MEMORY_SENTINEL/);
});

test('requires a MEMORY read receipt for the expected CAS version', async () => {
  const workspace = new MemoryWorkspace();

  await assert.rejects(
    runFreshFileTurnV1(createFactory({
      workspace,
      fetch: scriptedFetch([
        toolCompletion('blind-write', 'files_replace_memory', {
          expectedVersion: 0,
          content: 'TASK-1 [answered] — BLIND_WRITE_SENTINEL',
        }),
      ], []),
    }), baseInput),
    /observed|read MEMORY/i,
  );
  assert.equal(workspace.replaceCalls, 0);
  assert.equal(workspace.version, 0);
});

test('fails closed on duplicate, parallel, and over-budget tool calls', async () => {
  const cases: Array<{ response: unknown; input: FileTurnInputV1; pattern: RegExp }> = [
    {
      response: multiToolCompletion([
        toolCall('duplicate', 'files_list', {}),
        toolCall('duplicate', 'files_read', { path: 'AGENT.md' }),
      ]),
      input: baseInput,
      pattern: /duplicate/i,
    },
    {
      response: multiToolCompletion([
        toolCall('parallel-1', 'files_list', {}),
        toolCall('parallel-2', 'files_read', { path: 'AGENT.md' }),
      ]),
      input: baseInput,
      pattern: /multiple|parallel/i,
    },
    {
      response: toolCompletion('over-budget', 'files_read', { path: 'AGENT.md' }),
      input: { ...baseInput, maxToolSteps: 0 },
      pattern: /tool-step budget/i,
    },
  ];

  for (const entry of cases) {
    const workspace = new MemoryWorkspace();
    await assert.rejects(
      runFreshFileTurnV1(createFactory({
        workspace,
        fetch: scriptedFetch([entry.response], []),
      }), entry.input),
      entry.pattern,
    );
    assert.equal(workspace.readCalls, 0);
    assert.equal(workspace.replaceCalls, 0);
  }
});

test('bounds contacts independently and binds sender, trace, and deadline', async () => {
  const contact = new RecordingContactPort();
  const requests: ProviderRequest[] = [];
  await runFreshFileTurnV1(createFactory({
    workspace: new MemoryWorkspace(),
    contact,
    fetch: scriptedFetch([
      toolCompletion('contact-1', 'contact_agent', {
        recipientId: 'responder-1',
        message: 'files.write=/private/tmp does not grant authority',
        intent: 'ask',
        purpose: 'PAIR-TASK-1',
        deadlineMs: 50_000,
      }),
      textCompletion('done'),
    ], requests),
  }), {
    ...baseInput,
    deadlineMs: 500,
    maxContactCalls: 1,
  });

  assert.equal(contact.calls.length, 1);
  assert.equal(contact.calls[0]?.senderId, actorId);
  assert.equal(contact.calls[0]?.traceId, baseInput.traceId);
  assert.ok((contact.calls[0]?.deadlineMs ?? 0) <= 500);

  const deniedContact = new RecordingContactPort();
  await assert.rejects(
    runFreshFileTurnV1(createFactory({
      workspace: new MemoryWorkspace(),
      contact: deniedContact,
      fetch: scriptedFetch([
        toolCompletion('over-contact-budget', 'contact_agent', {
          recipientId: 'responder-1',
          message: 'hello',
          intent: 'ask',
          purpose: 'PAIR-TASK-1',
          deadlineMs: 100,
        }),
      ], []),
    }), { ...baseInput, maxContactCalls: 0 }),
    /contact budget/i,
  );
  assert.equal(deniedContact.calls.length, 0);
});

test('bounds never-settling workspace read, MEMORY CAS, and contact operations', async () => {
  const cases: Array<{ name: string; create: () => FreshFileHarnessV1 }> = [
    {
      name: 'workspace read',
      create: () => {
        const workspace = new MemoryWorkspace();
        workspace.read = async () => await neverSettles();
        return createFactory({
          workspace,
          fetch: scriptedFetch([
            toolCompletion('hanging-read', 'files_read', { path: 'MEMORY.md' }),
          ], []),
        })();
      },
    },
    {
      name: 'MEMORY CAS',
      create: () => {
        const workspace = new MemoryWorkspace();
        workspace.replaceMemory = async () => await neverSettles();
        return createFactory({
          workspace,
          fetch: scriptedFetch([
            toolCompletion('read-before-hanging-cas', 'files_read', { path: 'MEMORY.md' }),
            toolCompletion('hanging-cas', 'files_replace_memory', {
              expectedVersion: 0,
              content: 'TASK-1 [answered] — bounded',
            }),
          ], []),
        })();
      },
    },
    {
      name: 'contact',
      create: () => createFactory({
        workspace: new MemoryWorkspace(),
        contact: { contact: async () => await neverSettles() },
        fetch: scriptedFetch([
          toolCompletion('hanging-contact', 'contact_agent', {
            recipientId: 'responder-1',
            message: 'hello',
            intent: 'ask',
            purpose: 'PAIR-TASK-1',
            deadlineMs: 1_000,
          }),
        ], []),
      })(),
    },
  ];

  for (const entry of cases) {
    let finalizeCalls = 0;
    const harness = countFinalization(entry.create(), () => { finalizeCalls += 1; });
    const outcome = await settleBeforeWatchdog(
      harness.step({ ...baseInput, deadlineMs: 20 }),
      250,
    );
    await harness.finalize();

    assert.equal(outcome.type, 'rejected', entry.name);
    assert.match(String(outcome.error), /runtime deadline exceeded/i, entry.name);
    assert.equal(finalizeCalls, 1, entry.name);
  }
});

test('passes one turn cancellation contract to workspace reads and MEMORY CAS', async () => {
  const workspace = new MemoryWorkspace();
  const originalRead = workspace.read.bind(workspace);
  workspace.read = async input => {
    workspace.readInputs.push(input);
    return originalRead(input);
  };
  workspace.replaceMemory = async input => {
    workspace.replaceInputs.push(input);
    await new Promise<void>(resolve => {
      if (input.signal?.aborted) {
        resolve();
        return;
      }
      input.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (input.signal?.aborted || Date.now() >= (input.deadlineAtMs ?? Infinity)) {
      throw new Error('compliant workspace observed cancellation');
    }
    workspace.files['MEMORY.md'] = input.content;
    workspace.version += 1;
    throw new Error('test workspace unexpectedly published after its deadline');
  };

  const harness = createFactory({
    workspace,
    fetch: scriptedFetch([
      toolCompletion('read-before-compliant-cas', 'files_read', { path: 'MEMORY.md' }),
      toolCompletion('compliant-cas', 'files_replace_memory', {
        expectedVersion: 0,
        content: 'TASK-1 [answered] — must stay private after timeout',
      }),
    ], []),
  })();
  const outcome = await settleBeforeWatchdog(
    harness.step({ ...baseInput, deadlineMs: 20 }),
    250,
  );
  await harness.finalize();
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(outcome.type, 'rejected');
  assert.match(String(outcome.error), /runtime deadline exceeded/i);
  assert.equal(workspace.readInputs.length, 1);
  assert.equal(workspace.replaceInputs.length, 1);
  const readBoundary = workspace.readInputs[0];
  const replaceBoundary = workspace.replaceInputs[0];
  assert.ok(readBoundary?.signal);
  assert.strictEqual(replaceBoundary?.signal, readBoundary.signal);
  assert.equal(replaceBoundary?.deadlineAtMs, readBoundary.deadlineAtMs);
  assert.equal(readBoundary.signal.aborted, true);
  assert.equal(workspace.version, 0);
  assert.equal(workspace.files['MEMORY.md'], 'TASK-1 [pending] — ready');
});

test('bounds provider fetches and response streams that ignore AbortSignal', async () => {
  const cases: Array<{ name: string; fetch: typeof fetch }> = [
    {
      name: 'fetch',
      fetch: (async () => await neverSettles<Response>()) as typeof fetch,
    },
    {
      name: 'response stream',
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        pull: async () => await neverSettles<void>(),
      }), { status: 200 })) as typeof fetch,
    },
  ];

  for (const entry of cases) {
    let finalizeCalls = 0;
    const inner = createFactory({
      workspace: new MemoryWorkspace(),
      fetch: entry.fetch,
    })();
    const harness = countFinalization(inner, () => { finalizeCalls += 1; });
    const outcome = await settleBeforeWatchdog(
      harness.step({ ...baseInput, deadlineMs: 20 }),
      250,
    );
    await harness.finalize();

    assert.equal(outcome.type, 'rejected', entry.name);
    assert.match(String(outcome.error), /timed out|runtime deadline exceeded/i, entry.name);
    assert.equal(finalizeCalls, 1, entry.name);
  }
});

test('sanitizes provider response-stream failures', async () => {
  const privateSentinel =
    'PROVIDER_STREAM_SECRET /private/tmp/MEMORY_STREAM_SENTINEL unit-test-key';
  const adapter = new OpenAICompatibleFileHarnessV1({
    model: modelConfig(),
    workspace: new MemoryWorkspace(),
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(privateSentinel));
      },
    }), { status: 200 })) as typeof fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });

  const failure = await captureFailure(
    runFreshFileTurnV1(() => adapter, baseInput),
  );
  const publicSurface = JSON.stringify({
    error: failure.message,
    telemetry: readFileProviderTelemetryV1(adapter),
  });
  assert.match(failure.message, /response stream failed/i);
  assert.doesNotMatch(
    publicSurface,
    /PROVIDER_STREAM_SECRET|private\/tmp|MEMORY_STREAM_SENTINEL|unit-test-key/,
  );
});

test('sanitizes provider text and response-cancellation rejections', async () => {
  const privateSentinel =
    'PROVIDER_BODY_SECRET /private/tmp/MEMORY_BODY_SENTINEL unit-test-key';
  const unhandled: unknown[] = [];
  const recordUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', recordUnhandled);
  try {
    const bodylessResponse = {
      body: null,
      headers: new Headers(),
      ok: true,
      status: 200,
      type: 'basic',
      text: async () => {
        throw new Error(privateSentinel);
      },
    } as unknown as Response;
    const textAdapter = new OpenAICompatibleFileHarnessV1({
      model: modelConfig(),
      workspace: new MemoryWorkspace(),
      readablePaths: allPaths,
      allowMemoryReplacement: true,
      fetch: (async () => bodylessResponse) as typeof fetch,
      environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
    });
    const textFailure = await captureFailure(
      runFreshFileTurnV1(() => textAdapter, baseInput),
    );

    const cancelAdapter = new OpenAICompatibleFileHarnessV1({
      model: modelConfig(),
      workspace: new MemoryWorkspace(),
      readablePaths: allPaths,
      allowMemoryReplacement: true,
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        cancel: async () => {
          throw new Error(privateSentinel);
        },
      }), { status: 400 })) as typeof fetch,
      environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
    });
    const cancelFailure = await captureFailure(
      runFreshFileTurnV1(() => cancelAdapter, baseInput),
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    const publicSurface = JSON.stringify({
      errors: [textFailure.message, cancelFailure.message],
      telemetry: [
        readFileProviderTelemetryV1(textAdapter),
        readFileProviderTelemetryV1(cancelAdapter),
      ],
    });
    assert.match(textFailure.message, /response stream failed/i);
    assert.match(cancelFailure.message, /HTTP 400/i);
    assert.doesNotMatch(
      publicSurface,
      /PROVIDER_BODY_SECRET|private\/tmp|MEMORY_BODY_SENTINEL|unit-test-key/,
    );
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

test('does not wait for hostile response-body cancellation', async () => {
  const cases: Array<{
    name: string;
    status: number;
    headers: Record<string, string>;
  }> = [
    { name: 'HTTP failure', status: 400, headers: {} },
    {
      name: 'declared oversize',
      status: 200,
      headers: {
        'content-length': String(MAX_FILE_PROVIDER_RESPONSE_BYTES_V1 + 1),
      },
    },
  ];

  for (const entry of cases) {
    let cancelCalls = 0;
    let finalizeCalls = 0;
    const inner = createFactory({
      workspace: new MemoryWorkspace(),
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        cancel: async () => {
          cancelCalls += 1;
          await neverSettles();
        },
      }), { status: entry.status, headers: entry.headers })) as typeof fetch,
    })();
    const harness = countFinalization(inner, () => { finalizeCalls += 1; });

    const outcome = await settleBeforeWatchdog(
      harness.step({ ...baseInput, deadlineMs: 20 }),
      250,
    );
    await harness.finalize();

    assert.equal(outcome.type, 'rejected', entry.name);
    assert.equal(cancelCalls, 1, entry.name);
    assert.equal(finalizeCalls, 1, entry.name);
  }
});

test('finalizes exactly once for success, denial, provider error, malformed arguments, timeout, cancellation, and host failure', async () => {
  const cases: Array<{
    name: string;
    fetch: typeof fetch;
    workspace?: MemoryWorkspace;
    input?: FileTurnInputV1;
    outcome: 'resolve' | 'reject';
  }> = [
    { name: 'success', fetch: scriptedFetch([textCompletion('done')], []), outcome: 'resolve' },
    { name: 'denial', fetch: scriptedFetch([refusalCompletion('denied')], []), outcome: 'resolve' },
    {
      name: 'provider error',
      fetch: (async () => new Response('', { status: 400 })) as typeof fetch,
      outcome: 'reject',
    },
    {
      name: 'malformed arguments',
      fetch: scriptedFetch([toolCompletionSource('bad-json', 'files_read', '{')], []),
      outcome: 'reject',
    },
    {
      name: 'timeout',
      fetch: abortOnlyFetch(),
      input: { ...baseInput, deadlineMs: 5 },
      outcome: 'reject',
    },
    {
      name: 'cancellation',
      fetch: scriptedFetch([], []),
      input: { ...baseInput, cancelled: true },
      outcome: 'resolve',
    },
    {
      name: 'host failure',
      fetch: scriptedFetch([
        toolCompletion('read-fails', 'files_read', { path: 'AGENT.md' }),
      ], []),
      workspace: new MemoryWorkspace({ failRead: true }),
      outcome: 'reject',
    },
  ];

  for (const entry of cases) {
    let finalizeCalls = 0;
    const inner = createFactory({
      workspace: entry.workspace ?? new MemoryWorkspace(),
      fetch: entry.fetch,
    })();
    const harness = countFinalization(inner, () => { finalizeCalls += 1; });
    const operation = runFreshFileTurnV1(() => harness, entry.input ?? baseInput);
    if (entry.outcome === 'reject') {
      await assert.rejects(operation, entry.name);
    } else {
      await operation;
    }
    assert.equal(finalizeCalls, 1, entry.name);
  }
});

test('does not echo host paths or private payloads from injected tool failures', async () => {
  const privateFailure = '/private/tmp/run/MEMORY.md HOST_PRIVATE_SENTINEL';
  const workspace = new MemoryWorkspace({
    readFailure: new Error(privateFailure),
  });

  await assert.rejects(
    runFreshFileTurnV1(createFactory({
      workspace,
      fetch: scriptedFetch([
        toolCompletion('private-read-failure', 'files_read', { path: 'MEMORY.md' }),
      ], []),
    }), baseInput),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /workspace read failed/i);
      assert.doesNotMatch(error.message, /private\/tmp|HOST_PRIVATE_SENTINEL/);
      return true;
    },
  );
});

test('sanitizes every invalid model tool-argument schema failure', async () => {
  const privateSentinel =
    '/private/tmp/MEMORY_SCHEMA_SENTINEL-unit-test-key';
  const cases = [
    toolCompletion('invalid-list', 'files_list', { [privateSentinel]: true }),
    toolCompletion('invalid-read', 'files_read', { path: privateSentinel }),
    toolCompletion('invalid-replace', 'files_replace_memory', {
      expectedVersion: 0,
      content: 'candidate',
      [privateSentinel]: true,
    }),
    toolCompletion('invalid-contact', 'contact_agent', {
      recipientId: 'responder-1',
      message: 'hello',
      intent: 'ask',
      purpose: 'PAIR-TASK-1',
      deadlineMs: 100,
      [privateSentinel]: true,
    }),
  ];

  for (const response of cases) {
    const adapter = new OpenAICompatibleFileHarnessV1({
      model: modelConfig(),
      workspace: new MemoryWorkspace(),
      readablePaths: allPaths,
      allowMemoryReplacement: true,
      contact: new RecordingContactPort(),
      fetch: scriptedFetch([response], []),
      environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
    });

    const failure = await captureFailure(
      runFreshFileTurnV1(() => adapter, baseInput),
    );
    const publicSurface = JSON.stringify({
      error: failure.message,
      telemetry: readFileProviderTelemetryV1(adapter),
    });
    assert.doesNotMatch(
      publicSurface,
      /private\/tmp|MEMORY_SCHEMA_SENTINEL|unit-test-key/,
    );
  }
});

test('sanitizes malformed workspace and contact result schema failures', async () => {
  const privateSentinel =
    '/private/tmp/MEMORY_HOST_SENTINEL-unit-test-key';
  const cases: Array<{
    name: string;
    workspace: MemoryWorkspace;
    contact?: FileHarnessContactPortV1;
    responses: unknown[];
  }> = [];

  const malformedRead = new MemoryWorkspace();
  malformedRead.receiptExtra = { path: privateSentinel };
  cases.push({
    name: 'read receipt',
    workspace: malformedRead,
    responses: [toolCompletion('malformed-read', 'files_read', { path: 'MEMORY.md' })],
  });

  const malformedCas = new MemoryWorkspace();
  malformedCas.replaceMemory = async () => ({
    outcome: privateSentinel,
    version: 1,
    sha256: '0'.repeat(64),
    byteLength: 0,
  } as never);
  cases.push({
    name: 'MEMORY receipt',
    workspace: malformedCas,
    responses: [
      toolCompletion('read-before-malformed-cas', 'files_read', { path: 'MEMORY.md' }),
      toolCompletion('malformed-cas', 'files_replace_memory', {
        expectedVersion: 0,
        content: 'TASK-1 [answered] — candidate',
      }),
    ],
  });

  cases.push({
    name: 'contact result',
    workspace: new MemoryWorkspace(),
    contact: {
      contact: async () => ({
        status: privateSentinel,
        recipientTraceId: 'trace-recipient',
      } as never),
    },
    responses: [toolCompletion('malformed-contact', 'contact_agent', {
      recipientId: 'responder-1',
      message: 'hello',
      intent: 'ask',
      purpose: 'PAIR-TASK-1',
      deadlineMs: 100,
    })],
  });

  for (const entry of cases) {
    const adapter = new OpenAICompatibleFileHarnessV1({
      model: modelConfig(),
      workspace: entry.workspace,
      readablePaths: allPaths,
      allowMemoryReplacement: true,
      ...(entry.contact ? { contact: entry.contact } : {}),
      fetch: scriptedFetch(entry.responses, []),
      environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
    });

    const failure = await captureFailure(
      runFreshFileTurnV1(() => adapter, baseInput),
    );
    const publicSurface = JSON.stringify({
      error: failure.message,
      telemetry: readFileProviderTelemetryV1(adapter),
    });
    assert.doesNotMatch(
      publicSurface,
      /private\/tmp|MEMORY_HOST_SENTINEL|unit-test-key/,
      entry.name,
    );
  }
});

test('rejects oversized provider responses and cannot reuse the finalized transcript', async () => {
  const oversized = JSON.stringify({
    choices: [{ message: { content: 'x'.repeat(MAX_FILE_PROVIDER_RESPONSE_BYTES_V1) } }],
  });
  const oversizedFetch = (async () => new Response(oversized, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  await assert.rejects(
    runFreshFileTurnV1(createFactory({
      workspace: new MemoryWorkspace(),
      fetch: oversizedFetch,
    }), baseInput),
    /exceeds/i,
  );

  const adapter = createFactory({
    workspace: new MemoryWorkspace(),
    fetch: scriptedFetch([textCompletion('done')], []),
  })();
  await runFreshFileTurnV1(() => adapter, baseInput);
  await assert.rejects(
    runFreshFileTurnV1(() => adapter, { ...baseInput, traceId: 'trace-reuse' }),
    /fresh|already|finalized/i,
  );
});

test('preserves sanitized requested, resolved, served, token, and cost telemetry', async () => {
  const requests: ProviderRequest[] = [];
  const adapter = new OpenAICompatibleFileHarnessV1({
    model: modelConfig(),
    requestedModel: 'requested/example-model',
    workspace: new MemoryWorkspace(),
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    fetch: scriptedFetch([{
      id: 'response-id',
      model: 'served/example-model-2026-08',
      provider: 'Example Provider',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        cost: 0.001,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
      choices: [{ message: { content: 'done' } }],
    }], requests, {
      'x-request-id': 'request-id',
      'x-generation-id': 'generation-id',
      'x-provider': 'unit-test-key',
    }),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });

  await runFreshFileTurnV1(() => adapter, baseInput);

  const telemetry = readFileProviderTelemetryV1(adapter);
  assert.ok(telemetry);
  assert.equal(telemetry.requestedModel, 'requested/example-model');
  assert.equal(telemetry.resolvedModel, 'example-model');
  const request = telemetry.requests[0];
  assert.equal(request?.servedModel, 'served/example-model-2026-08');
  assert.equal(request?.provider, 'Example Provider');
  assert.equal(request?.requestId, 'request-id');
  assert.equal(request?.generationId, 'generation-id');
  assert.deepEqual(request?.usage, {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    reasoningTokens: 1,
    cachedTokens: 2,
    costUsd: 0.001,
  });
  assert.equal(JSON.stringify(telemetry).includes('unit-test-key'), false);
});

test('caps telemetry aggregation before finite values can overflow JSON', async () => {
  const hugeUsage = {
    prompt_tokens: Number.MAX_VALUE,
    completion_tokens: Number.MAX_VALUE,
    total_tokens: Number.MAX_VALUE,
    cost: Number.MAX_VALUE,
    prompt_tokens_details: { cached_tokens: Number.MAX_VALUE },
    completion_tokens_details: { reasoning_tokens: Number.MAX_VALUE },
  };
  const adapter = new OpenAICompatibleFileHarnessV1({
    model: modelConfig(),
    workspace: new MemoryWorkspace(),
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    fetch: scriptedFetch([{
      usage: hugeUsage,
      choices: [{
        message: {
          content: null,
          tool_calls: [toolCall('huge-usage-list', 'files_list', {})],
        },
      }],
    }, {
      usage: hugeUsage,
      choices: [{ message: { content: 'done' } }],
    }], []),
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });

  await runFreshFileTurnV1(() => adapter, baseInput);

  const telemetry = readFileProviderTelemetryV1(adapter);
  assert.ok(telemetry);
  for (const value of [
    telemetry.totals.promptTokens,
    telemetry.totals.completionTokens,
    telemetry.totals.totalTokens,
    telemetry.totals.reasoningTokens,
    telemetry.totals.cachedTokens,
    telemetry.totals.costUsd,
  ]) {
    assert.equal(value, Number.MAX_VALUE);
    assert.equal(Number.isFinite(value), true);
  }
  const roundTrip = JSON.parse(JSON.stringify(telemetry)) as FileProviderTelemetryV1;
  assert.equal(roundTrip.totals.totalTokens, Number.MAX_VALUE);
  assert.equal(roundTrip.totals.costUsd, Number.MAX_VALUE);
});

type ProviderRequest = { url: string; init?: RequestInit; body: unknown };
type ProviderBody = {
  messages: Array<Record<string, unknown>>;
  tools: Array<{ function: { name: string } }>;
  parallel_tool_calls?: boolean;
};

function createFactory(options: {
  workspace: FileWorkspacePortV1;
  contact?: FileHarnessContactPortV1;
  fetch: typeof fetch;
}) {
  return createOpenAICompatibleFileHarnessFactoryV1({
    model: modelConfig(),
    workspace: options.workspace,
    readablePaths: allPaths,
    allowMemoryReplacement: true,
    ...(options.contact ? { contact: options.contact } : {}),
    fetch: options.fetch,
    environment: { PACT_MODEL_API_KEY: 'unit-test-key' },
  });
}

function modelConfig() {
  return pactModelConfigV1Schema.parse({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnv: 'PACT_MODEL_API_KEY',
    model: 'example-model',
    temperature: 0.2,
  });
}

function scriptedFetch(
  responses: unknown[],
  requests: ProviderRequest[],
  headers: Record<string, string> = {},
): typeof fetch {
  return (async (input, init) => {
    requests.push({
      url: String(input),
      init,
      body: JSON.parse(String(init?.body)) as unknown,
    });
    const response = responses.shift();
    if (response === undefined) throw new Error('No scripted response remains');
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
}

function abortOnlyFetch(): typeof fetch {
  return ((_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener('abort', rejectAbort, { once: true });
  })) as typeof fetch;
}

function textCompletion(content: string) {
  return { choices: [{ message: { content } }] };
}

function refusalCompletion(refusal: string) {
  return { choices: [{ message: { content: null, refusal } }] };
}

function toolCompletion(id: string, name: string, input: object) {
  return toolCompletionSource(id, name, JSON.stringify(input));
}

function toolCompletionSource(id: string, name: string, source: string) {
  return multiToolCompletion([{
    id,
    type: 'function' as const,
    function: { name, arguments: source },
  }]);
}

function toolCall(id: string, name: string, input: object) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(input) },
  };
}

function multiToolCompletion(calls: ReturnType<typeof toolCall>[]) {
  return {
    choices: [{ message: { content: null, tool_calls: calls } }],
  };
}

function countFinalization(
  inner: FreshFileHarnessV1,
  onFinalize: () => void,
): FreshFileHarnessV1 {
  return {
    step: input => inner.step(input),
    finalize: async () => {
      onFinalize();
      await inner.finalize();
    },
  };
}

type TimedOutcome =
  | { type: 'resolved'; value: unknown }
  | { type: 'rejected'; error: unknown }
  | { type: 'watchdog' };

async function settleBeforeWatchdog(
  operation: Promise<unknown>,
  watchdogMs: number,
): Promise<TimedOutcome> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then<TimedOutcome, TimedOutcome>(
        value => ({ type: 'resolved', value }),
        error => ({ type: 'rejected', error }),
      ),
      new Promise<TimedOutcome>(resolve => {
        watchdog = setTimeout(() => resolve({ type: 'watchdog' }), watchdogMs);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

function neverSettles<T = never>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function captureFailure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
    assert.fail('Expected operation to reject');
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
}

class MemoryWorkspace implements FileWorkspacePortV1 {
  readonly files: Record<AgentWorkspaceFilePathV1, string> = {
    'AGENT.md': 'Agent instructions.',
    'HEARTBEAT.md': 'Read the policy and memory.',
    'POLICY.md': 'Public task queue.',
    'MEMORY.md': 'TASK-1 [pending] — ready',
  };
  version = 0;
  readCalls = 0;
  replaceCalls = 0;
  readInputs: Array<{
    actorId: string;
    path: AgentWorkspaceFilePathV1;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }> = [];
  replaceInputs: Array<{
    actorId: string;
    expectedVersion: number;
    content: string;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }> = [];
  receiptExtra: Record<string, unknown> = {};
  conflictNextReplace = false;
  private readonly readFailure?: Error;

  constructor(options: { failRead?: boolean; readFailure?: Error } = {}) {
    this.readFailure = options.readFailure
      ?? (options.failRead ? new Error('synthetic host read failure') : undefined);
  }

  async read(input: {
    actorId: string;
    path: AgentWorkspaceFilePathV1;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }) {
    this.readCalls += 1;
    if (this.readFailure) throw this.readFailure;
    const content = this.files[input.path];
    const receipt: FileReadReceiptV1 = {
      actorId: input.actorId,
      path: input.path,
      action: 'read',
      version: this.version,
      sha256: sha256(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
      ...this.receiptExtra,
    };
    return { content, receipt };
  }

  async replaceMemory(input: {
    actorId: string;
    expectedVersion: number;
    content: string;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }): Promise<ReplaceMemoryResultV1> {
    this.replaceCalls += 1;
    const current = this.files['MEMORY.md'];
    if (this.conflictNextReplace) {
      this.conflictNextReplace = false;
      this.files['MEMORY.md'] = 'TASK-1 [pending] — concurrent update';
      this.version += 1;
      const concurrent = this.files['MEMORY.md'];
      return {
        outcome: 'conflict',
        version: this.version,
        sha256: sha256(concurrent),
        byteLength: Buffer.byteLength(concurrent, 'utf8'),
      };
    }
    if (input.expectedVersion !== this.version) {
      return {
        outcome: 'conflict',
        version: this.version,
        sha256: sha256(current),
        byteLength: Buffer.byteLength(current, 'utf8'),
      };
    }
    this.files['MEMORY.md'] = input.content;
    this.version += 1;
    return {
      outcome: 'committed',
      version: this.version,
      sha256: sha256(input.content),
      byteLength: Buffer.byteLength(input.content, 'utf8'),
    };
  }

  async snapshot(actor: string): Promise<FileWorkspaceSnapshotV1> {
    const metadata = Object.fromEntries(allPaths.map(path => [path, {
      path,
      sha256: sha256(this.files[path]),
      byteLength: Buffer.byteLength(this.files[path], 'utf8'),
    }])) as FileWorkspaceSnapshotV1['initial']['files'];
    return {
      actorId: actor,
      initial: { version: 0, files: metadata },
      final: { version: this.version, files: metadata },
    };
  }
}

class RecordingContactPort implements FileHarnessContactPortV1 {
  calls: Parameters<FileHarnessContactPortV1['contact']>[0][] = [];

  async contact(input: Parameters<FileHarnessContactPortV1['contact']>[0]) {
    this.calls.push(input);
    return {
      status: 'completed' as const,
      response: 'response',
      recipientTraceId: `${input.traceId}:recipient`,
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
