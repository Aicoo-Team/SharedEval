import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createLineSplitterV1,
  projectCodexBridgeToolsV1,
  renderCodexBridgeToolResultV1,
  type CodexBridgeDriverMessageV1,
  type CodexBridgeServerMessageV1,
} from '../../src/runner/v1/codex/bridge-protocol.js';
import { createCodexBridgeMcpServerV1 } from '../../src/runner/v1/codex/mcp-server.js';
import type { SoToolDefinition } from '../../src/execution/sharedos/v1/contracts.js';

const fileReadTool: SoToolDefinition = {
  name: 'files.read',
  description: 'Read content from a granted file path.',
  namespace: 'files',
  source: 'sharedos',
  readWrite: 'read',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  requiredCapability: { resource: { namespace: 'files', path: [] }, action: 'read' },
};
const searchNotesTool: SoToolDefinition = {
  ...fileReadTool,
  name: 'search_notes',
  description: 'Search notes.',
  namespace: 'pact-pair',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

type Harness = {
  send(message: unknown): void;
  responses(): Promise<Record<string, unknown>[]>;
  bridgeMessages: CodexBridgeServerMessageV1[];
  toBridge(message: CodexBridgeDriverMessageV1): void;
  nextBridgeMessage(): Promise<CodexBridgeServerMessageV1>;
  server: ReturnType<typeof createCodexBridgeMcpServerV1>;
  stdin: PassThrough;
};

function harness(): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const serverSide = new PassThrough();
  // The fake socket: what the MCP server writes lands on serverSide; what
  // the test pushes into the socket is what the MCP server reads.
  const socket = new Duplex({
    read() { /* pushed by toBridge */ },
    write(chunk, _encoding, callback) {
      serverSide.write(chunk);
      callback();
    },
    final(callback) {
      serverSide.end();
      callback();
    },
  });
  const outputs: Record<string, unknown>[] = [];
  const stdoutLines = createLineSplitterV1(line => {
    outputs.push(JSON.parse(line) as Record<string, unknown>);
  });
  stdout.on('data', chunk => stdoutLines.push(chunk as Buffer));
  const bridgeMessages: CodexBridgeServerMessageV1[] = [];
  const bridgeWaiters: ((message: CodexBridgeServerMessageV1) => void)[] = [];
  const bridgeLines = createLineSplitterV1(line => {
    const message = JSON.parse(line) as CodexBridgeServerMessageV1;
    bridgeMessages.push(message);
    bridgeWaiters.shift()?.(message);
  });
  serverSide.on('data', chunk => bridgeLines.push(chunk as Buffer));
  const server = createCodexBridgeMcpServerV1({
    input: stdin,
    output: stdout,
    connectBridge: async () => socket,
  });
  return {
    stdin,
    server,
    bridgeMessages,
    send: message => stdin.write(`${JSON.stringify(message)}\n`),
    responses: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return outputs.splice(0);
    },
    toBridge: message => socket.push(`${JSON.stringify(message)}\n`),
    nextBridgeMessage: () => {
      const queued = bridgeMessages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise(resolve => bridgeWaiters.push(message => {
        bridgeMessages.shift();
        resolve(message);
      }));
    },
  };
}

test('the MCP server greets the bridge, answers initialize/ping, and lists the published tools', async () => {
  const h = harness();
  const hello = await h.nextBridgeMessage();
  assert.deepEqual(hello, { type: 'hello', protocolVersion: '1' });

  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  let outputs = await h.responses();
  assert.deepEqual(outputs.map(output => output['id']), [1, 2]);
  assert.deepEqual((outputs[0] as any).result.protocolVersion, '2025-03-26');
  assert.deepEqual((outputs[0] as any).result.serverInfo.name, 'sharedos');
  assert.deepEqual((outputs[0] as any).result.capabilities, { tools: {} });

  // tools/list blocks until the driver publishes the tick's tools.
  h.toBridge({
    type: 'tools',
    protocolVersion: '1',
    tools: [...projectCodexBridgeToolsV1([fileReadTool, searchNotesTool])],
  });
  outputs = await h.responses();
  assert.deepEqual(outputs, [{
    jsonrpc: '2.0',
    id: 3,
    result: {
      tools: [
        {
          name: 'files_read',
          description: fileReadTool.description,
          inputSchema: fileReadTool.inputSchema,
        },
        {
          name: 'search_notes',
          description: searchNotesTool.description,
          inputSchema: searchNotesTool.inputSchema,
        },
      ],
    },
  }]);

  h.send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  outputs = await h.responses();
  assert.equal((outputs[0] as any).error.code, -32601);
  h.server.close();
  await h.server.done;
});

test('tools/call is forwarded to the driver, serialized, and answered with the rendered result', async () => {
  const h = harness();
  await h.nextBridgeMessage();
  h.toBridge({
    type: 'tools',
    protocolVersion: '1',
    tools: [...projectCodexBridgeToolsV1([fileReadTool])],
  });
  h.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'files_read', arguments: { path: 'AGENT.md' } } });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'files_read', arguments: { path: 'POLICY.md' } } });

  const first = await h.nextBridgeMessage();
  assert.deepEqual(first, {
    type: 'tool_call',
    id: 'bridge-call-1',
    mcpName: 'files_read',
    arguments: { path: 'AGENT.md' },
  });
  // The second call is not forwarded until the first is answered.
  assert.deepEqual(await h.responses(), []);
  assert.equal(h.bridgeMessages.length, 0);

  const rendered = renderCodexBridgeToolResultV1({
    callId: 'call-1',
    tool: 'files.read',
    status: 'succeeded',
    output: { content: '# Agent', version: 'v1' },
    completedAt: '2026-09-12T00:00:00.000Z',
  });
  assert.equal(rendered.text, '{"status":"succeeded","output":{"content":"# Agent","version":"v1"}}');
  h.toBridge({ type: 'tool_result', id: 'bridge-call-1', ...rendered });
  let outputs = await h.responses();
  assert.deepEqual(outputs, [{
    jsonrpc: '2.0',
    id: 10,
    result: { content: [{ type: 'text', text: rendered.text }], isError: false },
  }]);

  const second = await h.nextBridgeMessage();
  assert.equal(second.type, 'tool_call');
  assert.equal((second as any).id, 'bridge-call-2');
  const denied = renderCodexBridgeToolResultV1({
    callId: 'call-2',
    tool: 'files.read',
    status: 'denied',
    error: { code: 'capability_denied', message: 'no grant', retryable: false },
    completedAt: '2026-09-12T00:00:00.000Z',
  });
  h.toBridge({ type: 'tool_result', id: 'bridge-call-2', ...denied });
  outputs = await h.responses();
  assert.deepEqual((outputs[0] as any).result, {
    content: [{ type: 'text', text: '{"status":"denied","error":{"code":"capability_denied","message":"no grant","retryable":false}}' }],
    isError: true,
  });

  // Unknown tools and non-object arguments are refused locally, never forwarded.
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'files_replace', arguments: {} } });
  h.send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'files_read', arguments: 'AGENT.md' } });
  outputs = await h.responses();
  assert.deepEqual(outputs.map(output => [(output as any).id, (output as any).error.code]), [
    [12, -32602],
    [13, -32602],
  ]);
  assert.equal(h.bridgeMessages.length, 0);

  h.stdin.end();
  await h.server.done;
});

test('tool projection maps dots to underscores and refuses collisions', () => {
  const projected = projectCodexBridgeToolsV1([fileReadTool, searchNotesTool]);
  assert.deepEqual(projected.map(tool => [tool.name, tool.mcpName]), [
    ['files.read', 'files_read'],
    ['search_notes', 'search_notes'],
  ]);
  assert.throws(
    () => projectCodexBridgeToolsV1([fileReadTool, { ...fileReadTool, name: 'files_read' }]),
    /collide/,
  );
});
