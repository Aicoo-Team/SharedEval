import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  SoAccessContext, SoCapabilityGrant, SoExecutionRequest, SoKernel, SoToolCall,
  SoToolDefinition, SoToolResult, SoTurnDriver,
} from '../../src/execution/sharedos/v1/contracts.js';
import { defaultSharedOsDirV1, loadSharedOsModulesV1 } from '../../src/execution/sharedos/v1/load-sharedos.js';
import { openActorContextStore } from '../../src/runner/context/actor-context-store.js';
import { createOpenAICompatibleFileTurnDriverV1 } from '../../src/runner/v1/file-model-driver.js';

const NOW = '2026-09-13T00:00:00.000Z';
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js'))
  ? 'Pinned SharedOS build is unavailable' : false;
const actor = { kind: 'agent', agentId: 'requester' } as const;
const owner = { kind: 'service', serviceId: 'late-operation-test' } as const;
const context: SoAccessContext = {
  namespaceId: 'late-operation-test', actor, owner, authority: owner,
  enabledToolNamespaces: ['files'], purpose: 'test-cancellation', traceId: 'trace-test', now: NOW,
};
const definition: SoToolDefinition = {
  name: 'files.replace', description: 'Replace the test-owned MEMORY fixture.',
  namespace: 'files', source: 'sharedos', readWrite: 'write',
  inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  requiredCapability: { resource: { namespace: 'files', owner, path: ['MEMORY.md'] }, action: 'replace' },
};
const request: SoExecutionRequest = {
  version: '1', executionId: 'execution-test', agent: actor, context,
  message: { version: '1', id: 'message-test', sender: owner, receiver: actor,
    purpose: context.purpose, traceId: context.traceId, createdAt: NOW,
    payload: { text: 'Update the test-owned memory.' } },
  tools: [definition], options: { maxSteps: 3, maxToolCalls: 1, timeoutMs: 60_000 },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, options: { gate?: ReturnType<typeof deferred>; allow?: boolean } = {}) {
  const loaded = await loadSharedOsModulesV1();
  assert.ok(loaded.ok, loaded.ok ? undefined : loaded.reason);
  const root = await mkdtemp(join(tmpdir(), 'pair-late-operation-'));
  const memory = join(root, 'MEMORY.md');
  await writeFile(memory, 'before\n');
  const store = await openActorContextStore({ directory: join(root, 'context'),
    worldId: 'late-operation-test', bindingDigest: 'a'.repeat(64),
    actorIds: ['requester'], maxContextBytes: 1024 * 1024 });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const grant: SoCapabilityGrant = {
    id: 'test-grant', namespaceId: context.namespaceId, subject: actor, issuer: owner,
    capabilities: [
      { resource: { namespace: 'sharedos.execution', owner, path: ['agent', actor.agentId] },
        actions: ['invoke'], scope: 'exact' },
      ...(options.allow === false ? [] : [{ resource: definition.requiredCapability.resource,
        actions: ['replace'], scope: 'exact' as const }]),
    ], constraints: { purposes: [context.purpose] }, issuedAt: NOW,
  };
  const entered = deferred();
  const finished = deferred();
  const kernel = new loaded.modules.core.SharedOSKernel({ grantSource: { load: async () => [grant] } });
  kernel.registerTool({ definition, parseArguments: args => args,
    invoke: async (_context, call) => {
      entered.resolve();
      // Models an already-started storage operation that cannot be cancelled by a signal.
      await options.gate?.promise;
      await writeFile(memory, String(call.arguments.content));
      const content = await readFile(memory, 'utf8');
      finished.resolve();
      return { callId: call.id, tool: call.tool, status: 'succeeded', completedAt: NOW,
        output: { byteLength: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } };
    },
  });
  let fetchCount = 0;
  const driver = createOpenAICompatibleFileTurnDriverV1({
    model: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY', model: 'test-model', maxOutputTokens: 128 },
    environment: { SHAREDEVAL_MODEL_API_KEY: 'not-a-secret' },
    actorContext: { store, actorId: 'requester', maxContextBytes: 1024 * 1024 },
    fetch: async () => {
      fetchCount += 1;
      assert.equal(fetchCount, 1, 'Cancellation must not make a continuation/model request');
      return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: {
        role: 'assistant', content: null, tool_calls: [{ id: 'provider-call-1', type: 'function',
          function: { name: definition.name, arguments: JSON.stringify({ content: 'after\n' }) } }],
      } }] }), { status: 200 });
    },
  });
  const invoke = (call: SoToolCall, signal: AbortSignal) => (kernel as SoKernel & {
    invokeTool(context: SoAccessContext, call: SoToolCall, options: { signal: AbortSignal }): Promise<SoToolResult>;
  }).invokeTool(context, call, { signal });
  const records = async () => {
    const directory = join(root, 'context', 'actors', createHash('sha256').update('requester').digest('hex'));
    const names = (await readdir(directory)).filter(name => name.startsWith('record-')).sort();
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  };
  return { root, memory, driver, kernel, loaded, entered, finished, invoke, records, fetchCount: () => fetchCount };
}

test('persists an already-returned real tool result before honoring cancellation without another fetch', { skip }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const session = await f.driver.open(request, controller.signal);
  const decision = await session.next({ type: 'start' }, controller.signal);
  assert.equal(decision.type, 'tool_call');
  if (decision.type !== 'tool_call') return;
  const result = await f.invoke(decision.call, controller.signal);
  assert.equal(result.status, 'succeeded');
  assert.equal(await readFile(f.memory, 'utf8'), 'after\n');
  controller.abort(new Error('test cancellation after the actual tool result'));
  await assert.rejects(session.next({ type: 'tool_result', result }, controller.signal), /test cancellation/);
  await assert.doesNotReject(async () => session.close!('cancelled', new AbortController().signal));
  await assert.doesNotReject(f.driver.assertActorContextSettled());
  const records = await f.records();
  const results = records.filter(record => record.kind === 'message' && record.message.role === 'tool');
  assert.equal(results.length, 1);
  assert.deepEqual(JSON.parse(results[0].message.content).output, result.output);
  assert.equal(records.at(-1).kind, 'finish');
  assert.equal(records.at(-1).status, 'cancelled');
  assert.equal(f.fetchCount(), 1);
});

test('does not invent a result when an authorized MEMORY operation completes only after cancellation', { skip }, async t => {
  const gate = deferred();
  const f = await fixture(t, { gate });
  const controller = new AbortController();
  const session = await f.driver.open(request, controller.signal);
  const decision = await session.next({ type: 'start' }, controller.signal);
  assert.equal(decision.type, 'tool_call');
  if (decision.type !== 'tool_call') return;
  const pending = f.invoke(decision.call, controller.signal).then(result => ({ result }), error => ({ error }));
  await f.entered.promise;
  controller.abort(new Error('test cancellation while storage is pending'));
  try {
    await assert.rejects(async () => session.close!('cancelled', new AbortController().signal), { code: 'context_turn_incomplete' });
    assert.equal(await readFile(f.memory, 'utf8'), 'before\n');
  } finally {
    gate.resolve();
    await pending;
    await f.finished.promise;
  }
  assert.equal(await readFile(f.memory, 'utf8'), 'after\n');
  const records = await f.records();
  assert.equal(records.some(record => record.kind === 'finish'), false);
  assert.equal(records.some(record => record.message?.role === 'tool'), false);
  await assert.rejects(f.driver.assertActorContextSettled(), { code: 'context_turn_incomplete' });
  assert.equal(f.fetchCount(), 1);
});

test('cancellation does not let an unrelated call or unknown tool settle the pending call', { skip }, async t => {
  for (const mismatch of [{ callId: 'prior-turn-call' }, { tool: 'unknown-tool' }]) {
    const f = await fixture(t);
    const controller = new AbortController();
    const session = await f.driver.open(request, controller.signal);
    const decision = await session.next({ type: 'start' }, controller.signal);
    assert.equal(decision.type, 'tool_call');
    if (decision.type !== 'tool_call') return;
    const result = await f.invoke(decision.call, controller.signal);
    controller.abort(new Error('test cancellation before mismatched result'));
    await assert.rejects(session.next({ type: 'tool_result', result: { ...result, ...mismatch } },
      controller.signal), /test cancellation/);
    await assert.rejects(async () => session.close!('cancelled', new AbortController().signal), { code: 'context_turn_incomplete' });
    assert.equal((await f.records()).some(record => record.message?.role === 'tool'), false);
    assert.equal(f.fetchCount(), 1);
  }
});

test('a result delivered only after session close cannot reopen or backfill a cancelled turn', { skip }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const session = await f.driver.open(request, controller.signal);
  const decision = await session.next({ type: 'start' }, controller.signal);
  assert.equal(decision.type, 'tool_call');
  if (decision.type !== 'tool_call') return;
  const result = await f.invoke(decision.call, controller.signal);
  controller.abort(new Error('test cancellation before close'));
  await assert.rejects(async () => session.close!('cancelled', new AbortController().signal), { code: 'context_turn_incomplete' });
  const closedRecords = await f.records();
  await assert.rejects(session.next({ type: 'tool_result', result }, controller.signal), /test cancellation/);
  assert.deepEqual(await f.records(), closedRecords);
  assert.equal(closedRecords.some(record => record.kind === 'finish'), false);
  assert.equal(closedRecords.some(record => record.message?.role === 'tool'), false);
  await assert.rejects(f.driver.assertActorContextSettled(), { code: 'context_turn_incomplete' });
  assert.equal(f.fetchCount(), 1);
});

test('denied MEMORY capability prevents the test storage operation', { skip }, async t => {
  const f = await fixture(t, { allow: false });
  const result = await f.invoke({ id: 'denied-call', tool: definition.name,
    arguments: { content: 'must not write\n' }, traceId: context.traceId, requestedAt: NOW },
  new AbortController().signal);
  assert.equal(result.status, 'denied');
  assert.equal(await readFile(f.memory, 'utf8'), 'before\n');
  assert.equal(f.fetchCount(), 0);
});

test('pinned SharedOS cancellation can return before the runtime session close settles', { skip }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const closeStarted = deferred();
  const releaseClose = deferred();
  const closeFinished = deferred();
  let closeSettled = false;
  const driver: SoTurnDriver = {
    open: async () => ({
      next: async () => ({ type: 'complete', output: { test: true } }),
      close: async () => {
        closeStarted.resolve();
        await releaseClose.promise;
        closeSettled = true;
        closeFinished.resolve();
      },
    }),
  };
  const runtime = new f.loaded.modules.runtime.StandardRuntime(driver);
  const executor = new f.loaded.modules.runtime.SharedOSExecutor(f.kernel, runtime);
  const execution = executor.execute(request, { signal: controller.signal });
  await closeStarted.promise;
  controller.abort(new Error('cancel while cleanup is still active'));
  try {
    const result = await execution;
    assert.equal(result.status, 'cancelled');
    assert.equal(closeSettled, false);
    t.diagnostic('Ownership evidence: executor cancellation is not a cleanup-completion acknowledgement.');
  } finally {
    releaseClose.resolve();
    await closeFinished.promise;
  }
  assert.equal(f.fetchCount(), 0);
});
