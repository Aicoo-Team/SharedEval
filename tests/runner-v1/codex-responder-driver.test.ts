import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '../../src/contracts/json.js';
import type {
  SoToolDefinition,
  SoToolResult,
  SoTurnDecision,
  SoTurnDriver,
} from '../../src/execution/sharedos/v1/contracts.js';
import { sharedevalCodexHarnessV1Schema } from '../../src/runner/v1/codex/codex-harness-config.js';
import {
  CODEX_HARNESS_PREAMBLE_V1,
  createCodexResponderTurnDriverV1,
  defaultCodexBridgeMcpServerCommandV1,
  renderCodexConfigTomlV1,
  renderCodexResponderPromptV1,
  type CodexChildProcessV1,
} from '../../src/runner/v1/codex/codex-responder-driver.js';
import { renderFileTurnPromptV1 } from '../../src/runner/v1/file-model-driver.js';
import { pactOpenAICompatibleModelConfigV1Schema } from '../../src/runner/v1/model-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsxLoader = join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs');
const API_KEY = 'test-secret-key-0123456789';

const model = pactOpenAICompatibleModelConfigV1Schema.parse({
  provider: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
  model: 'deepseek/deepseek-chat',
});

const fileReadTool: SoToolDefinition = {
  name: 'files.read',
  description: 'Read content from a granted file path.',
  namespace: 'files',
  source: 'sharedos',
  readWrite: 'read',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  requiredCapability: { resource: { namespace: 'files', path: [] }, action: 'read' },
};
const fileReplaceTool: SoToolDefinition = {
  ...fileReadTool,
  name: 'files.replace',
  description: 'Replace a file.',
  readWrite: 'write',
};
const searchNotesTool: SoToolDefinition = {
  ...fileReadTool,
  name: 'search_notes',
  description: 'Search notes.',
  namespace: 'pact-pair',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

/** A shell wrapper that makes the fake CLI look like a `codex` executable. */
function fakeCodexCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
  const wrapper = join(dir, 'codex');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsxLoader)} ${JSON.stringify(join(here, 'codex-fake-cli.ts'))} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function harness(mode: string, command = fakeCodexCommand()) {
  return sharedevalCodexHarnessV1Schema.parse({
    command,
    extraArgs: ['--fake-mode', mode],
  });
}

function openRequest(tools: readonly SoToolDefinition[]): Parameters<SoTurnDriver['open']>[0] {
  return {
    version: '1',
    executionId: 'execution-responder-1',
    agent: { kind: 'agent', agentId: 'responder' },
    context: {
      actor: { kind: 'agent', agentId: 'responder' },
      owner: { kind: 'service', serviceId: 'sharedeval' },
      namespaceId: 'namespace-private',
      purpose: 'sharedeval:pact-pair',
      traceId: 'trace-1',
      now: '2026-09-12T00:00:00.000Z',
    },
    message: {
      version: '1',
      id: 'message-request-1',
      sender: { kind: 'agent', agentId: 'requester' },
      receiver: { kind: 'agent', agentId: 'responder' },
      purpose: 'sharedeval:pact-pair',
      payload: { taskId: 'PAIR-Q1', message: 'What is on my calendar?' },
      traceId: 'trace-1',
      createdAt: '2026-09-12T00:00:00.000Z',
    },
    tools,
    options: { maxSteps: 9, maxToolCalls: 8, timeoutMs: 30_000 },
  };
}

/** Plays the SharedOS executor: executes each requested tool with a canned result. */
async function driveToCompletion(
  session: Awaited<ReturnType<SoTurnDriver['open']>>,
  signal: AbortSignal,
  execute: (tool: string, arguments_: Record<string, unknown>) => SoToolResult['output'],
): Promise<{ decision: SoTurnDecision; calls: { tool: string; arguments: unknown; id: string }[] }> {
  const calls: { tool: string; arguments: unknown; id: string }[] = [];
  let decision = await session.next({ type: 'start' }, signal);
  while (decision.type === 'tool_call') {
    calls.push({ tool: decision.call.tool, arguments: decision.call.arguments, id: decision.call.id });
    decision = await session.next({
      type: 'tool_result',
      result: {
        callId: decision.call.id,
        tool: decision.call.tool,
        status: 'succeeded',
        output: execute(decision.call.tool, decision.call.arguments),
        completedAt: '2026-09-12T00:00:01.000Z',
      },
    }, signal);
  }
  return { decision, calls };
}

test('one tick round-trips through the fake codex, the stdio MCP server, and the socket bridge', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'codex-driver-'));
  const driver = createCodexResponderTurnDriverV1({
    harness: harness('ok'),
    model,
    environment: { SHAREDEVAL_MODEL_API_KEY: API_KEY },
    tempRoot,
  });
  const signal = new AbortController().signal;
  const session = await driver.open(openRequest([fileReadTool, fileReplaceTool, searchNotesTool]), signal);
  const { decision, calls } = await driveToCompletion(session, signal, (tool, arguments_): JsonValue => (
    tool === 'files.read'
      ? { content: `# ${String(arguments_['path'])}`, version: 'v1' }
      : { notes: [] }
  ));
  await session.close?.('succeeded', signal);

  assert.deepEqual(calls.map(call => [call.tool, call.arguments]), [
    ['files.read', { path: 'AGENT.md' }],
    ['files.read', { path: 'HEARTBEAT.md' }],
    ['files.read', { path: 'POLICY.md' }],
    ['files.read', { path: 'MEMORY.md' }],
    ['search_notes', { query: 'anything' }],
  ]);
  assert.ok(calls.every(call => /^call-[a-f0-9]{40}$/.test(call.id)));
  assert.equal(new Set(calls.map(call => call.id)).size, calls.length);

  assert.equal(decision.type, 'complete');
  const output = (decision as Extract<SoTurnDecision, { type: 'complete' }>).output as {
    type: string; content: string; toolSteps: number; contactCalls: number;
  };
  assert.equal(output.type, 'completed');
  assert.equal(output.toolSteps, 5);
  assert.equal(output.contactCalls, 0);
  const reply = JSON.parse(output.content) as Record<string, unknown>;
  assert.equal(reply['promptHead'], renderFileTurnPromptV1(openRequest([]).message).split('\n')[0]);
  assert.equal(reply['promptHasPreamble'], true);
  assert.deepEqual(reply['tools'], ['files_read', 'files_replace', 'search_notes']);
  const results = reply['results'] as Record<string, { content: { text: string }[]; isError: boolean }>;
  assert.deepEqual(results['AGENT.md'], {
    content: [{ type: 'text', text: '{"status":"succeeded","output":{"content":"# AGENT.md","version":"v1"}}' }],
    isError: false,
  });
  assert.deepEqual(results['search_notes']!.content[0]!.text, '{"status":"succeeded","output":{"notes":[]}}');
  assert.match(String((results['unknown'] as unknown as { rpcError: string }).rpcError), /-32602/);

  const telemetry = driver.getFileProviderTelemetryV1();
  assert.equal(telemetry.requestedModel, 'deepseek/deepseek-chat');
  assert.equal(telemetry.requests.length, 1);
  assert.equal(telemetry.requests[0]!.provider, 'codex');
  assert.equal(telemetry.requests[0]!.outcome, 'success');
  assert.deepEqual(telemetry.requests[0]!.usage, {
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    cachedTokens: 20,
  });
  assert.deepEqual(telemetry.totals, {
    requests: 1,
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
    cachedTokens: 20,
  });
  // Scratch state (CODEX_HOME, socket, last message) does not outlive the tick.
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('concurrent MCP calls from codex are serialized into one SharedOS call at a time', async () => {
  const driver = createCodexResponderTurnDriverV1({
    harness: harness('parallel'),
    model,
    environment: { SHAREDEVAL_MODEL_API_KEY: API_KEY },
  });
  const signal = new AbortController().signal;
  const session = await driver.open(openRequest([fileReadTool]), signal);
  const { decision, calls } = await driveToCompletion(session, signal, () => ({ content: 'x', version: 'v1' }));
  await session.close?.('succeeded', signal);
  assert.equal(decision.type, 'complete');
  assert.deepEqual(calls.map(call => call.arguments), [{ path: 'AGENT.md' }, { path: 'HEARTBEAT.md' }]);
});

test('a failed codex exit is a fail decision with redacted stderr, and no final message is a fail too', async () => {
  const signal = new AbortController().signal;
  for (const [mode, pattern] of [
    ['fail', /exited with code 2: fake codex failed while holding \[redacted\]/],
    ['silent', /exited without a final message/],
  ] as const) {
    const driver = createCodexResponderTurnDriverV1({
      harness: harness(mode),
      model,
      environment: { SHAREDEVAL_MODEL_API_KEY: API_KEY },
    });
    const session = await driver.open(openRequest([fileReadTool]), signal);
    const decision = await session.next({ type: 'start' }, signal);
    await session.close?.('failed', signal);
    assert.equal(decision.type, 'fail');
    const error = (decision as Extract<SoTurnDecision, { type: 'fail' }>).error;
    assert.equal(error.code, 'codex_harness_failed');
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, new RegExp(API_KEY));
    assert.equal(error.retryable, false);
    assert.equal(driver.getFileProviderTelemetryV1().requests[0]!.outcome, 'provider_error');
  }
});

test('a missing codex executable is reported, not thrown', async () => {
  const driver = createCodexResponderTurnDriverV1({
    harness: harness('ok', '/nonexistent/codex-binary'),
    model,
    environment: { SHAREDEVAL_MODEL_API_KEY: API_KEY },
  });
  const signal = new AbortController().signal;
  const session = await driver.open(openRequest([fileReadTool]), signal);
  const decision = await session.next({ type: 'start' }, signal);
  await session.close?.('failed', signal);
  assert.equal(decision.type, 'fail');
  assert.match((decision as any).error.code, /^codex_harness_(unavailable|failed)$/);
});

test('aborting the turn kills a hung codex and rejects with the abort reason', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'codex-driver-'));
  const driver = createCodexResponderTurnDriverV1({
    harness: harness('hang'),
    model,
    environment: { SHAREDEVAL_MODEL_API_KEY: API_KEY },
    tempRoot,
  });
  const controller = new AbortController();
  const session = await driver.open(openRequest([fileReadTool]), controller.signal);
  const pending = session.next({ type: 'start' }, controller.signal);
  setTimeout(() => controller.abort(new Error('deadline')), 300);
  await assert.rejects(pending, /deadline/);
  await session.close?.('cancelled', controller.signal);
  assert.deepEqual(readdirSync(tempRoot), []);
});

test('protocol misuse yields a protocol-error fail decision', async () => {
  const exited: string[] = [];
  const fakeSpawn = (): CodexChildProcessV1 => {
    const { PassThrough } = require('node:stream') as typeof import('node:stream');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    return {
      stdin,
      stdout,
      stderr,
      on: () => undefined,
      kill: (signal?: string) => { exited.push(signal ?? 'SIGTERM'); return true; },
    };
  };
  const driver = createCodexResponderTurnDriverV1({
    harness: harness('ok'),
    model,
    environment: { SHAREDEVAL_MODEL_API_KEY: API_KEY },
    spawn: fakeSpawn,
  });
  const signal = new AbortController().signal;
  const session = await driver.open(openRequest([fileReadTool]), signal);
  const decision = await session.next({
    type: 'tool_result',
    result: { callId: 'x', tool: 'files.read', status: 'succeeded', completedAt: 'now' },
  }, signal);
  assert.deepEqual(decision, {
    type: 'fail',
    error: {
      code: 'model_driver_protocol_error',
      message: 'Codex session expected the start input',
    },
  });
});

test('the driver refuses to start without the model credential and never writes it to config.toml', () => {
  assert.throws(
    () => createCodexResponderTurnDriverV1({ harness: harness('ok'), model, environment: {} }),
    /SHAREDEVAL_MODEL_API_KEY is not set/,
  );
  const toml = renderCodexConfigTomlV1({
    harness: sharedevalCodexHarnessV1Schema.parse({ providerId: 'openrouter' }),
    model,
    mcpServer: { command: '/usr/bin/node', args: ['--import', '/x/loader.mjs', '/x/mcp-server-main.ts'] },
    socketPath: '/tmp/bridge.sock',
    toolTimeoutSec: 30,
  });
  assert.equal(toml, [
    'model = "deepseek/deepseek-chat"',
    'model_provider = "openrouter"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.openrouter]',
    'name = "openrouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'env_key = "SHAREDEVAL_MODEL_API_KEY"',
    'wire_api = "chat"',
    '',
    '[mcp_servers.sharedos]',
    'command = "/usr/bin/node"',
    'args = ["--import", "/x/loader.mjs", "/x/mcp-server-main.ts"]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 30',
    '',
    '[mcp_servers.sharedos.env]',
    'SHAREDEVAL_CODEX_BRIDGE_SOCKET = "/tmp/bridge.sock"',
    '',
    '[history]',
    'persistence = "none"',
    '',
  ].join('\n'));
  // The credential is named by env var only; no literal key material appears.
  assert.doesNotMatch(toml, /api_key\s*=|Bearer|sk-/i);
});

test('the codex prompt is the built-in bootstrap text plus the harness preamble', () => {
  const message = openRequest([]).message;
  assert.equal(
    renderCodexResponderPromptV1(message),
    `${renderFileTurnPromptV1(message)}\n\n${CODEX_HARNESS_PREAMBLE_V1}`,
  );
  assert.match(renderFileTurnPromptV1(message), /^Read AGENT\.md and HEARTBEAT\.md/);
});

test('the default MCP server command points at this repository and the tsx loader', () => {
  const command = defaultCodexBridgeMcpServerCommandV1();
  assert.equal(command.command, process.execPath);
  assert.equal(command.args[0], '--import');
  assert.ok(existsSync(command.args[1]!), command.args[1]);
  assert.match(command.args[2]!, /src\/runner\/v1\/codex\/mcp-server-main\.ts$/);
  assert.ok(existsSync(command.args[2]!));
});
