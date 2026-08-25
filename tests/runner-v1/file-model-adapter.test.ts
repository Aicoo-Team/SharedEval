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
  receiptExtra: Record<string, unknown> = {};
  conflictNextReplace = false;
  private readonly readFailure?: Error;

  constructor(options: { failRead?: boolean; readFailure?: Error } = {}) {
    this.readFailure = options.readFailure
      ?? (options.failRead ? new Error('synthetic host read failure') : undefined);
  }

  async read(input: { actorId: string; path: AgentWorkspaceFilePathV1 }) {
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
