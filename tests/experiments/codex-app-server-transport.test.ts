import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CODEX_TRANSPORT_BASE_URL, CODEX_ISOLATION_OVERRIDES, createCodexAppServerTransport,
  nativeEnvironment, projectCodexHistory, type CodexRpcFactory, type CodexRpcLaunch,
} from '../../scripts/experiments/codex-app-server-transport.js';

type Obj = Record<string, any>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'mock turn started');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const tool = { type: 'function', function: { name: 'files.read', description: 'Read a permitted file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const initial = [{ role: 'user', content: 'Actor-private input.' }];
function effectiveConfig(overrides: Record<string, unknown>): Obj {
  const config: Obj = {};
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split('.'); let object = config;
    for (const part of parts.slice(0, -1)) object = object[part] ??= {};
    object[parts.at(-1)!] = value;
  }
  return config;
}

async function harness(options: { mode?: 'normal' | 'parallel' | 'native' | 'wait' | 'compaction'; instructionSources?: string[]; commentary?: boolean;
  closeGate?: ReturnType<typeof deferred>; closeFailure?: boolean; openGate?: ReturnType<typeof deferred> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-transport-test-'));
  const calls: Array<{ method: string; params: Obj }> = [];
  const replies: Array<{ id: string | number; result: Obj }> = [];
  let launch!: CodexRpcLaunch; let closed = 0; let alias = ''; let thread = 0; let launches = 0;
  const event = (method: string, params: Obj, id?: number) => launch.onEvent({ method, params, ...(id === undefined ? {} : { id }) });
  const item = (type: string, extra: Obj = {}) => event('item/started', { threadId: `thread-${thread}`, turnId: 'turn-1', item: { type, id: 'item-1', ...extra } });
  const dynamic = (id = 77) => event('item/tool/call', { threadId: `thread-${thread}`, turnId: 'turn-1',
    callId: `call-${id}`, tool: alias, arguments: { path: 'MEMORY.md' } }, id);
  const factory: CodexRpcFactory = async input => {
    launch = input;
    launches++;
    await options.openGate?.promise;
    return {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') return { userAgent: 'test' };
        if (method === 'config/read') return { config: effectiveConfig(input.overrides) };
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'model/list') return { data: [{ model: 'native-test', isDefault: true,
          defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
        if (method === 'thread/start') {
          thread++; alias = (params.dynamicTools as Obj[])[0]!.name;
          return { thread: { id: `thread-${thread}`, ephemeral: true }, model: 'native-test', modelProvider: 'openai',
            instructionSources: options.instructionSources ?? [], approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
        }
        if (method === 'thread/inject_items') return {};
        if (method === 'turn/start') {
          event('turn/started', { threadId: `thread-${thread}`, turn: { id: 'turn-1' } });
          if (options.commentary) event('item/completed', { threadId: `thread-${thread}`, turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'commentary-1', phase: 'commentary', text: 'Reading the scoped file.' } });
          if (options.mode === 'native') item('commandExecution', { command: 'not-executed-by-test' });
          else if (options.mode === 'compaction') item('contextCompaction');
          else if (options.mode !== 'wait') {
            item('dynamicToolCall', { tool: alias }); dynamic();
            if (options.mode === 'parallel') dynamic(78);
          }
          return { turn: { id: 'turn-1', status: 'inProgress' } };
        }
        throw new Error(`Unexpected method ${method}`);
      },
      async notify(method, params) { calls.push({ method, params }); },
      async respond(id, result) {
        replies.push({ id, result });
        if (options.commentary) event('item/completed', { threadId: `thread-${thread}`, turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'commentary-2', phase: 'commentary', text: 'The file has been read.' } });
        event('item/completed', { threadId: `thread-${thread}`, turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: 'Done.' } });
        event('turn/completed', { threadId: `thread-${thread}`, turn: { id: 'turn-1', status: 'completed' } });
      },
      async close() {
        closed++; await options.closeGate?.promise;
        if (options.closeFailure) throw new Error('private peer cleanup detail');
      },
    };
  };
  const transport = createCodexAppServerTransport({ model: 'native-test', actorId: 'requester',
    evidenceDirectory: directory, rpcFactory: factory, runtimeTurnTimeoutMs: 300_000 });
  const send = (messages: unknown[], extra: RequestInit = {}) => transport.fetch(`${CODEX_TRANSPORT_BASE_URL}/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer secret-never-forwarded' },
    body: JSON.stringify({ model: 'native-test', messages, tools: [tool] }), ...extra,
  });
  return { transport, directory, calls, replies, send, dynamic, event,
    get closed() { return closed; }, get launches() { return launches; },
    async cleanup() {
      try { await transport.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    } };
}

test('pairs native requests to actual SharedOS results, with opaque aliases and isolated start', async () => {
  const h = await harness();
  try {
    const first = await (await h.send(initial)).json() as Obj;
    assert.equal(first.provider, 'native-codex-app-server');
    assert.equal(first.model, 'native-test');
    assert.equal(first.choices[0].message.tool_calls[0].function.name, 'files.read');
    assert.equal(h.replies.length, 0, 'native execution waits for SharedOS');
    const start = h.calls.find(c => c.method === 'thread/start')!.params;
    assert.deepEqual(start.environments, []); assert.equal(start.ephemeral, true);
    assert.equal(start.allowProviderModelFallback, false);
    assert.match(start.dynamicTools[0].name, /^sharedos_[0-9a-f]{24}$/);
    assert.equal(start.dynamicTools[0].name.includes('.'), false);
    const content = JSON.stringify({ status: 'succeeded', output: { content: 'Scoped file only.' } });
    const second = await (await h.send([...initial, first.choices[0].message,
      { role: 'tool', tool_call_id: 'call-77', content }])).json() as Obj;
    assert.equal(second.choices[0].message.content, 'Done.');
    assert.deepEqual(h.replies, [{ id: 77, result: { contentItems: [{ type: 'inputText', text: content }], success: true } }]);
    assert.deepEqual(h.calls.filter(c => c.method === 'turn/start').map(c => c.params.environments), [[]]);
    assert.doesNotMatch(JSON.stringify(h.calls), /secret-never-forwarded|Authorization/);
    await h.transport.close();
    const names = await readdir(h.directory);
    const evidence = await readFile(join(h.directory, names[0]!), 'utf8');
    assert.doesNotMatch(evidence, /Actor-private|Scoped file|secret-never-forwarded|Authorization/);
    assert.match(evidence, /not-upstream-served-model/);
    assert.ok(h.closed > 0);
  } finally { await h.cleanup(); }
});

test('returns SharedOS denials as tool results without granting native authority', async () => {
  const h = await harness();
  try {
    const first = await (await h.send(initial)).json() as Obj;
    await h.send([...initial, first.choices[0].message, { role: 'tool', tool_call_id: 'call-77',
      content: JSON.stringify({ status: 'denied', error: { code: 'access_denied', message: 'Denied.' } }) }]);
    assert.equal(h.replies[0]!.result.success, false);
    assert.match(h.replies[0]!.result.contentItems[0].text, /access_denied/);
  } finally { await h.cleanup(); }
});

test('preserves native commentary in both tool decisions and final actor history', async () => {
  const h = await harness({ commentary: true });
  try {
    const first = await (await h.send(initial)).json() as Obj;
    assert.equal(first.choices[0].message.content, 'Reading the scoped file.');
    const second = await (await h.send([...initial, first.choices[0].message, { role: 'tool',
      tool_call_id: 'call-77', content: '{"status":"succeeded","output":{}}' }])).json() as Obj;
    assert.equal(second.choices[0].message.content, 'The file has been read.\nDone.');
    assert.equal(h.transport.evidence().turns[0]!.outputTokenLimitEnforced, false);
  } finally { await h.cleanup(); }
});

test('opens a fresh native thread and replays exact prior file history on the second actor turn', async () => {
  const h = await harness();
  try {
    const first = await (await h.send(initial)).json() as Obj;
    const oldResult = { role: 'tool', tool_call_id: 'call-77',
      content: JSON.stringify({ status: 'succeeded', output: { content: 'Old MEMORY snapshot.', version: '1' } }) };
    const firstHistory = [...initial, first.choices[0].message, oldResult];
    const final = await (await h.send(firstHistory)).json() as Obj;
    const secondInput = [...firstHistory, final.choices[0].message, { role: 'user', content: 'Next actor tick.' }];
    const next = await (await h.send(secondInput)).json() as Obj;
    const injected = h.calls.find(c => c.method === 'thread/inject_items')!.params.items as Obj[];
    assert.equal(injected.find(i => i.type === 'function_call_output')!.output, oldResult.content);
    const newResult = { role: 'tool', tool_call_id: 'call-77',
      content: JSON.stringify({ status: 'succeeded', output: { content: 'New MEMORY snapshot.', version: '2' } }) };
    await h.send([...secondInput, next.choices[0].message, newResult]);
    assert.equal(h.calls.filter(c => c.method === 'thread/start').length, 2);
    assert.deepEqual(h.transport.evidence().turns.map(t => t.threadId), ['thread-1', 'thread-2']);
    assert.equal(h.replies[1]!.result.contentItems[0].text, newResult.content);
  } finally { await h.cleanup(); }
});

test('rejects mismatched tool results before replying to native process', async () => {
  const h = await harness();
  try {
    const first = await (await h.send(initial)).json() as Obj;
    await assert.rejects(h.send([...initial, first.choices[0].message,
      { role: 'tool', tool_call_id: 'another-call', content: '{"status":"succeeded"}' }]), /native_tool_result_mismatch/);
    assert.equal(h.replies.length, 0); assert.ok(h.closed > 0);
  } finally { await h.cleanup(); }
});

test('rejects altered actor history and correction text before native continuation', async () => {
  const h = await harness();
  try {
    const first = await (await h.send(initial)).json() as Obj;
    await assert.rejects(h.send([{ role: 'user', content: 'Another actor history' }, first.choices[0].message,
      { role: 'tool', tool_call_id: 'call-77', content: '{"status":"succeeded"}' }]), /native_history_diverged/);
    assert.equal(h.replies.length, 0);
  } finally { await h.cleanup(); }
});

test('fails closed on parallel native calls instead of dispatching an arbitrary first member', async () => {
  const h = await harness({ mode: 'parallel' });
  try { await assert.rejects(h.send(initial), /native_parallel_tool_calls/); assert.equal(h.replies.length, 0); }
  finally { await h.cleanup(); }
});

for (const mode of ['native', 'compaction'] as const) test(`rejects ${mode} activity`, async () => {
  const h = await harness({ mode });
  try { await assert.rejects(h.send(initial), /native_unexpected_item/); assert.ok(h.closed > 0); }
  finally { await h.cleanup(); }
});

test('rejects host instruction files before starting any model turn', async () => {
  const h = await harness({ instructionSources: ['/host/AGENTS.md'] });
  try {
    await assert.rejects(h.send(initial), /native_host_instructions_loaded/);
    assert.equal(h.calls.some(c => c.method === 'turn/start'), false);
  } finally { await h.cleanup(); }
});

test('cancels a waiting native turn and closes process', async () => {
  const h = await harness({ mode: 'wait' }); const abort = new AbortController();
  try {
    const pending = h.send(initial, { signal: abort.signal });
    await until(() => h.calls.some(call => call.method === 'turn/start')); abort.abort();
    await assert.rejects(pending, /native_cancelled/); assert.ok(h.closed > 0);
  } finally { await h.cleanup(); }
});

test('cancellation during the decision evidence write never returns a successful bridge response', async t => {
  const h = await harness();
  const abort = new AbortController();
  const savingDecision = deferred();
  const releaseWrite = deferred();
  const write = fsPromises.writeFile;
  let intercepted = false;
  const mocked = t.mock.method(fsPromises, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (!intercepted && String(args[0]).endsWith('.native.json')
      && JSON.parse(String(args[1])).turns.length > 0) {
      intercepted = true;
      savingDecision.resolve();
      await releaseWrite.promise;
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    const pending = h.send(initial, { signal: abort.signal });
    await savingDecision.promise;
    abort.abort(new Error('private caller reason must not enter evidence'));
    releaseWrite.resolve();
    await assert.rejects(pending, /native_cancelled/);
    assert.equal(h.replies.length, 0);
    assert.ok(h.closed > 0);
    const evidence = h.transport.evidence();
    assert.equal(evidence.failure, 'native_cancelled');
    assert.equal(evidence.abortSource, 'caller_signal');
    assert.equal(evidence.lifecycle.closeSource, 'transport_failure');
    assert.doesNotMatch(JSON.stringify(evidence), /private caller reason/);
    await h.transport.close({ source: 'session_close', outcome: 'cancelled',
      actorSettlement: 'failed', runtimeSignalAborted: true });
    const enriched = h.transport.evidence();
    assert.equal(enriched.lifecycle.closeRequestedAt, evidence.lifecycle.closeRequestedAt);
    assert.equal(enriched.lifecycle.closeSource, 'transport_failure');
    assert.equal(enriched.lifecycle.outer?.actorSettlement, 'failed');
    const names = await readdir(h.directory);
    assert.deepEqual(JSON.parse(await readFile(join(h.directory, names[0]!), 'utf8')),
      JSON.parse(JSON.stringify(enriched)));
  } finally {
    releaseWrite.resolve();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await h.cleanup();
  }
});

test('versioned close evidence distinguishes requested cleanup from a settled peer and incomplete native turn', async () => {
  const closeGate = deferred();
  const h = await harness({ closeGate });
  try {
    await h.send(initial);
    const closing = h.transport.close({ source: 'session_close', outcome: 'cancelled',
      actorSettlement: 'failed', runtimeSignalAborted: true });
    const pending = h.transport.evidence() as Obj;
    assert.equal(pending.apiVersion, 'sharedeval-native-codex-evidence/v2');
    assert.equal(pending.closeState, 'closing');
    assert.ok(pending.lifecycle.closeRequestedAt);
    assert.equal(pending.lifecycle.peerClosedAt, undefined);
    assert.equal(pending.lifecycle.cleanupCompletedAt, undefined);
    assert.equal(pending.turns[0].completed, false);
    assert.equal(pending.turns[0].completedAt, undefined);
    closeGate.resolve();
    await closing;
    const evidence = h.transport.evidence() as Obj;
    assert.equal(evidence.closeState, 'closed');
    assert.equal(evidence.failure, undefined, 'Outer cancellation is not a fabricated native failure');
    assert.ok(evidence.lifecycle.peerClosedAt >= evidence.lifecycle.closeRequestedAt);
    assert.ok(evidence.lifecycle.cleanupCompletedAt >= evidence.lifecycle.peerClosedAt);
    assert.deepEqual(evidence.lifecycle.outer, { source: 'session_close', outcome: 'cancelled',
      actorSettlement: 'failed', runtimeSignalAborted: true });
    assert.deepEqual(evidence.timeouts, { runtimeTurnMs: 300_000, bridgeFetchMs: 180_000, rpcRequestMs: 30_000 });
  } finally { closeGate.resolve(); await h.cleanup(); }
});

test('native completion and failed outer settlement remain distinct across idempotent close calls', async () => {
  const h = await harness();
  try {
    const first = await (await h.send(initial)).json() as Obj;
    await h.send([...initial, first.choices[0].message,
      { role: 'tool', tool_call_id: 'call-77', content: '{"status":"succeeded","output":{}}' }]);
    await h.transport.close({ source: 'session_close', outcome: 'failed',
      actorSettlement: 'failed', runtimeSignalAborted: false });
    const evidence = h.transport.evidence() as Obj;
    assert.equal(evidence.turns[0].completed, true);
    assert.ok(evidence.turns[0].startedAt);
    assert.ok(evidence.turns[0].completedAt >= evidence.turns[0].startedAt);
    assert.equal(evidence.lifecycle.outer.outcome, 'failed');
    assert.equal(evidence.failure, undefined);
    await h.transport.close({ source: 'run_cleanup' });
    assert.deepEqual(h.transport.evidence(), evidence, 'A later cleanup must not rewrite the first close cause');
    const names = await readdir(h.directory);
    assert.deepEqual(JSON.parse(await readFile(join(h.directory, names[0]!), 'utf8')),
      JSON.parse(JSON.stringify(evidence)));
  } finally { await h.cleanup(); }
});

test('failed native cleanup persists its outer cause without inventing cleanup completion', async () => {
  const h = await harness({ closeFailure: true });
  try {
    await h.send(initial);
    await assert.rejects(h.transport.close({ source: 'session_close', outcome: 'failed',
      actorSettlement: 'failed', runtimeSignalAborted: false }));
    const names = await readdir(h.directory);
    const evidence = JSON.parse(await readFile(join(h.directory, names[0]!), 'utf8')) as Obj;
    assert.equal(evidence.closeState, 'failed');
    assert.equal(evidence.lifecycle.outer.outcome, 'failed');
    assert.equal(evidence.lifecycle.cleanupError, 'native_cleanup_failed');
    assert.equal(evidence.lifecycle.peerClosedAt, undefined);
    assert.equal(evidence.lifecycle.cleanupCompletedAt, undefined);
    assert.doesNotMatch(JSON.stringify(evidence), /private peer cleanup detail/);
  } finally { await h.cleanup().catch(() => {}); }
});

test('close accounts for a peer created by an already-pending open without initializing it afterward', async () => {
  const openGate = deferred();
  const closeGate = deferred();
  const h = await harness({ openGate, closeGate });
  try {
    const opening = h.transport.preflight().then(() => assert.fail('A closed transport must not open'),
      error => { assert.match(String(error), /native_closed/); });
    await until(() => h.launches === 1);
    const closing = h.transport.close({ source: 'run_cleanup' });
    openGate.resolve();
    await until(() => h.closed > 0);
    closeGate.resolve();
    await Promise.all([opening, closing]);
    const evidence = h.transport.evidence();
    assert.ok(evidence.lifecycle.peerClosedAt, 'The late-created peer must be included in awaited cleanup');
    assert.ok(evidence.lifecycle.cleanupCompletedAt! >= evidence.lifecycle.peerClosedAt);
    assert.equal(h.calls.length, 0, 'Closing must prevent post-cancellation initialization RPCs');
    assert.equal(evidence.lifecycle.closeSource, 'run_cleanup');
  } finally { openGate.resolve(); closeGate.resolve(); await h.cleanup(); }
});

test('rejects unexpected native server requests without responding with an approval', async () => {
  const h = await harness({ mode: 'wait' });
  try {
    const pending = h.send(initial);
    await until(() => h.calls.some(call => call.method === 'turn/start'));
    h.event('item/commandExecution/requestApproval', { command: 'do not execute' }, 42);
    await assert.rejects(pending, /native_unexpected_server_request/);
    assert.equal(h.replies.length, 0);
  } finally { await h.cleanup(); }
});

test('synthetic HTTP endpoint does not accept real provider URLs', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.transport.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }), /native_synthetic_endpoint_mismatch/);
    assert.equal(h.calls.length, 0);
  } finally { await h.cleanup(); }
});

test('preserves only actor journal messages and exact tool pairs in native history projection', () => {
  const projected = projectCodexHistory([
    { role: 'user', content: 'Earlier own input.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: 'files.read', arguments: '{"path":"MEMORY.md"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"status":"succeeded","output":"own data"}' },
    { role: 'assistant', content: 'Earlier answer.' },
  ], new Map([['files.read', 'safe_alias']]));
  assert.equal(projected.length, 4);
  assert.deepEqual(projected[1], { type: 'function_call', call_id: 'call-1', name: 'safe_alias', arguments: '{"path":"MEMORY.md"}' });
  assert.equal(projected[2]!.output, '{"status":"succeeded","output":"own data"}');
  assert.throws(() => projectCodexHistory([{ role: 'tool', tool_call_id: 'other', content: 'x' }], new Map()), /native_unpaired_history/);
  assert.throws(() => projectCodexHistory([{ role: 'assistant', content: null, reasoning_details: [{}] }], new Map()), /native_unprojectable_history/);
});

test('subprocess inherits login location but no model keys, shell init, or caller tokens', () => {
  const env = nativeEnvironment({ HOME: '/test/home', CODEX_HOME: '/test/codex', PATH: '/bin',
    SHAREDEVAL_MODEL_API_KEY: 'secret1', OPENROUTER_API_KEY: 'secret2', OPENAI_API_KEY: 'secret3',
    CODEX_API_KEY: 'secret4', BASH_ENV: '/unsafe/init', NODE_OPTIONS: 'unsafe', ACCESS_TOKEN: 'secret5' });
  assert.deepEqual(env, { HOME: '/test/home', PATH: '/bin', CODEX_HOME: '/test/codex' });
  assert.equal(CODEX_ISOLATION_OVERRIDES['features.shell_tool'], false);
  assert.equal(CODEX_ISOLATION_OVERRIDES['features.unified_exec'], false);
  assert.equal(CODEX_ISOLATION_OVERRIDES['features.plugins'], false);
});
