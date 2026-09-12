import type { Duplex, Readable, Writable } from 'node:stream';
import { z } from 'zod';
import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from '../../../contracts/json.js';
import {
  CODEX_BRIDGE_MCP_SERVER_NAME_V1,
  CODEX_BRIDGE_PROTOCOL_VERSION_V1,
  codexBridgeDriverMessageV1Schema,
  createLineSplitterV1,
  parseCodexBridgeArgumentsV1,
  type CodexBridgeDriverMessageV1,
  type CodexBridgeServerMessageV1,
  type CodexBridgeToolV1,
} from './bridge-protocol.js';

/**
 * A minimal Model Context Protocol server over stdio that exposes one tick's
 * SharedOS tool surface to Codex. Every `tools/call` is forwarded verbatim to
 * the driver over the bridge socket and answered only when the SharedOS
 * kernel has executed it; the server holds no tool logic of its own.
 *
 * Only the subset of MCP that Codex exercises is implemented: initialize,
 * the initialized notification, ping, tools/list and tools/call. Codex may
 * issue tool calls concurrently; the bridge serializes them because the
 * SharedOS turn protocol executes one call at a time.
 */
export const CODEX_BRIDGE_MCP_PROTOCOL_VERSION_V1 = '2025-06-18' as const;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_PARSE_ERROR = -32700;

const jsonRpcIdSchema = z.union([z.string().max(256), z.number().int().safe()]);
const jsonRpcMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcIdSchema.optional(),
  method: z.string().min(1).max(128).optional(),
  params: jsonValueSchema.optional(),
  result: jsonValueSchema.optional(),
  error: jsonValueSchema.optional(),
}).passthrough();

const toolsCallParamsSchema = z.object({
  name: z.string().min(1).max(64),
  arguments: jsonValueSchema.optional(),
}).passthrough();

export type CodexBridgeMcpServerV1Options = Readonly<{
  input: Readable;
  output: Writable;
  /** Connects to the driver; resolves once the socket is open. */
  connectBridge: () => Promise<Duplex>;
  serverVersion?: string;
}>;

export type CodexBridgeMcpServerV1 = Readonly<{
  /** Resolves when the bridge closes or stdin ends; rejects on protocol errors. */
  done: Promise<void>;
  close(): void;
}>;

type PendingCall = {
  rpcId: string | number;
  resolve: (message: Extract<CodexBridgeDriverMessageV1, { type: 'tool_result' | 'rejected' }>) => void;
};

export function createCodexBridgeMcpServerV1(
  options: CodexBridgeMcpServerV1Options,
): CodexBridgeMcpServerV1 {
  let tools: readonly CodexBridgeToolV1[] | undefined;
  let bridge: Duplex | undefined;
  let closed = false;
  let nextCallId = 0;
  const pendingCalls = new Map<string, PendingCall>();
  const queue: Array<() => Promise<void>> = [];
  let draining = false;
  let settleDone!: () => void;
  let failDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    settleDone = resolve;
    failDone = reject;
  });
  const toolsReady = deferred<readonly CodexBridgeToolV1[]>();

  const writeOut = (message: JsonValue) => {
    if (closed) return;
    options.output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: string | number, result: JsonValue) => {
    writeOut({ jsonrpc: '2.0', id, result });
  };
  const replyError = (id: string | number | undefined, code: number, message: string) => {
    writeOut({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  const sendToBridge = (message: CodexBridgeServerMessageV1) => {
    if (!bridge || closed) throw new Error('Codex bridge is not connected');
    bridge.write(`${JSON.stringify(message)}\n`);
  };

  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    for (const pending of pendingCalls.values()) {
      pending.resolve({ type: 'rejected', id: '', message: 'Codex bridge closed' });
    }
    pendingCalls.clear();
    try { bridge?.end(); } catch { /* already closed */ }
    if (error) failDone(error);
    else settleDone();
  };

  const enqueue = (work: () => Promise<void>) => {
    queue.push(work);
    if (draining) return;
    draining = true;
    void (async () => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        try {
          await next();
        } catch (error) {
          close(error instanceof Error ? error : new Error('Codex bridge call failed'));
          return;
        }
      }
      draining = false;
    })();
  };

  const handleToolsCall = async (rpcId: string | number, params: unknown) => {
    const parsed = toolsCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      replyError(rpcId, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name');
      return;
    }
    const available = await toolsReady.promise;
    const tool = available.find(candidate => candidate.mcpName === parsed.data.name);
    if (!tool) {
      replyError(rpcId, JSON_RPC_INVALID_PARAMS, `Unknown tool ${parsed.data.name}`);
      return;
    }
    let arguments_: JsonObject;
    try {
      arguments_ = parseCodexBridgeArgumentsV1(parsed.data.arguments);
    } catch (error) {
      replyError(
        rpcId,
        JSON_RPC_INVALID_PARAMS,
        error instanceof Error ? error.message : 'Invalid tool arguments',
      );
      return;
    }
    nextCallId += 1;
    const id = `bridge-call-${nextCallId}`;
    const outcome = await new Promise<Extract<
      CodexBridgeDriverMessageV1,
      { type: 'tool_result' | 'rejected' }
    >>(resolve => {
      pendingCalls.set(id, { rpcId, resolve });
      sendToBridge({ type: 'tool_call', id, mcpName: tool.mcpName, arguments: arguments_ });
    });
    if (outcome.type === 'rejected') {
      replyError(rpcId, JSON_RPC_INTERNAL_ERROR, outcome.message);
      return;
    }
    reply(rpcId, {
      content: [{ type: 'text', text: outcome.text }],
      isError: outcome.isError,
    });
  };

  const handleRequest = (message: z.infer<typeof jsonRpcMessageSchema>) => {
    const { id, method } = message;
    if (method === undefined) return; // a response to something we never sent
    if (id === undefined) {
      // Notifications: initialized, cancelled, progress. Nothing to answer.
      return;
    }
    switch (method) {
      case 'initialize': {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        reply(id, {
          protocolVersion: typeof requested === 'string'
            ? requested
            : CODEX_BRIDGE_MCP_PROTOCOL_VERSION_V1,
          capabilities: { tools: {} },
          serverInfo: {
            name: CODEX_BRIDGE_MCP_SERVER_NAME_V1,
            version: options.serverVersion ?? CODEX_BRIDGE_PROTOCOL_VERSION_V1,
          },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        enqueue(async () => {
          const available = await toolsReady.promise;
          reply(id, {
            tools: available.map(tool => ({
              name: tool.mcpName,
              description: tool.description,
              inputSchema: structuredClone(tool.inputSchema),
            })),
          });
        });
        return;
      case 'tools/call':
        enqueue(() => handleToolsCall(id, message.params));
        return;
      default:
        replyError(id, JSON_RPC_METHOD_NOT_FOUND, `Method ${method} is not supported`);
    }
  };

  const stdinLines = createLineSplitterV1(line => {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      replyError(undefined, JSON_RPC_PARSE_ERROR, 'Invalid JSON');
      return;
    }
    const parsed = jsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      replyError(undefined, JSON_RPC_PARSE_ERROR, 'Invalid JSON-RPC message');
      return;
    }
    handleRequest(parsed.data);
  });

  const bridgeLines = createLineSplitterV1(line => {
    const parsed = codexBridgeDriverMessageV1Schema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error('Codex bridge sent an invalid driver message');
    const message = parsed.data;
    if (message.type === 'tools') {
      if (tools !== undefined) throw new Error('Codex bridge published tools twice');
      tools = Object.freeze(message.tools);
      toolsReady.resolve(tools);
      return;
    }
    const pending = pendingCalls.get(message.id);
    if (!pending) throw new Error('Codex bridge answered an unknown tool call');
    pendingCalls.delete(message.id);
    pending.resolve(message);
  });

  void options.connectBridge().then(socket => {
    if (closed) {
      socket.end();
      return;
    }
    bridge = socket;
    socket.on('data', chunk => {
      try {
        bridgeLines.push(chunk as Buffer);
      } catch (error) {
        close(error instanceof Error ? error : new Error('Codex bridge protocol error'));
      }
    });
    socket.on('error', error => close(error));
    socket.on('close', () => close());
    sendToBridge({ type: 'hello', protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION_V1 });
  }, error => close(error instanceof Error ? error : new Error('Codex bridge connect failed')));

  options.input.on('data', chunk => {
    try {
      stdinLines.push(chunk as Buffer);
    } catch (error) {
      close(error instanceof Error ? error : new Error('MCP stdin protocol error'));
    }
  });
  options.input.on('end', () => close());
  options.input.on('error', error => close(error));

  return Object.freeze({ done, close: () => close() });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
