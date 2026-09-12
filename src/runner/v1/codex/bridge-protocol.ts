import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  assertJsonComplexityV1,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from '../../../contracts/json.js';
import type {
  SoToolDefinition,
  SoToolResult,
} from '../../../execution/sharedos/v1/contracts.js';

/**
 * Wire protocol between the Codex responder driver (inside the SharedEval
 * process) and the stdio MCP server that Codex spawns. Both ends speak
 * newline-delimited JSON over one Unix domain socket whose path the driver
 * hands to the MCP server through this environment variable.
 *
 * The protocol is deliberately one-directional per phase: the MCP server
 * greets, the driver publishes the tick's tool list, then the MCP server
 * forwards each Codex tool call and waits for the driver's result. The driver
 * never initiates a call; the SharedOS executor decides when a call runs.
 */
export const CODEX_BRIDGE_SOCKET_ENV_V1 = 'SHAREDEVAL_CODEX_BRIDGE_SOCKET' as const;
export const CODEX_BRIDGE_MCP_SERVER_NAME_V1 = 'sharedos' as const;
export const CODEX_BRIDGE_PROTOCOL_VERSION_V1 = '1' as const;
export const MAX_CODEX_BRIDGE_LINE_BYTES_V1 = 4 * 1_024 * 1_024;
const MAX_CODEX_BRIDGE_TOOL_RESULT_BYTES_V1 = 2 * 1_024 * 1_024;

const bridgeToolSchema = z.object({
  /** SharedOS tool name, e.g. `files.read`. */
  name: z.string().min(1).max(128),
  /** MCP-facing name, e.g. `files_read`. */
  mcpName: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().max(4_096),
  inputSchema: jsonObjectSchema,
}).strict();

export type CodexBridgeToolV1 = z.infer<typeof bridgeToolSchema>;

export const codexBridgeServerMessageV1Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.literal(CODEX_BRIDGE_PROTOCOL_VERSION_V1),
  }).strict(),
  z.object({
    type: z.literal('tool_call'),
    id: z.string().min(1).max(128),
    mcpName: z.string().min(1).max(64),
    arguments: jsonObjectSchema,
  }).strict(),
]);

export const codexBridgeDriverMessageV1Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tools'),
    protocolVersion: z.literal(CODEX_BRIDGE_PROTOCOL_VERSION_V1),
    tools: z.array(bridgeToolSchema).max(64),
  }).strict(),
  z.object({
    type: z.literal('tool_result'),
    id: z.string().min(1).max(128),
    /** Rendered exactly as the built-in driver renders a tool result. */
    text: z.string().max(MAX_CODEX_BRIDGE_TOOL_RESULT_BYTES_V1),
    isError: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('rejected'),
    id: z.string().min(1).max(128),
    message: z.string().max(4_096),
  }).strict(),
]);

export type CodexBridgeServerMessageV1 = z.infer<typeof codexBridgeServerMessageV1Schema>;
export type CodexBridgeDriverMessageV1 = z.infer<typeof codexBridgeDriverMessageV1Schema>;

/**
 * MCP tool names are restricted to `[A-Za-z0-9_-]`; SharedOS names carry
 * dots (`files.read`). The mapping is the mechanical dot-to-underscore
 * rewrite, and the projection refuses a tool set where that rewrite
 * collides, so the reverse lookup on the driver side is always unambiguous.
 */
export function projectCodexBridgeToolsV1(
  tools: readonly SoToolDefinition[],
): readonly CodexBridgeToolV1[] {
  const seen = new Map<string, string>();
  const projected = tools.map(tool => {
    const mcpName = tool.name.replace(/\./g, '_');
    if (!/^[A-Za-z0-9_-]+$/.test(mcpName) || mcpName.length > 64) {
      throw new Error(`SharedOS tool ${tool.name} has no valid MCP projection`);
    }
    const previous = seen.get(mcpName);
    if (previous !== undefined && previous !== tool.name) {
      throw new Error(
        `SharedOS tools ${previous} and ${tool.name} collide as MCP tool ${mcpName}`,
      );
    }
    seen.set(mcpName, tool.name);
    return bridgeToolSchema.parse({
      name: tool.name,
      mcpName,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
    });
  });
  return Object.freeze(projected);
}

/**
 * The text Codex sees for one SharedOS tool result. Kept byte-identical to
 * the content the built-in driver places in its `tool` message so the two
 * responders observe the same tool surface.
 */
export function renderCodexBridgeToolResultV1(
  result: SoToolResult,
): Readonly<{ text: string; isError: boolean }> {
  const modelVisible: JsonValue = result.status === 'succeeded'
    ? {
      status: result.status,
      ...(result.output === undefined ? {} : { output: result.output }),
    }
    : {
      status: result.status,
      error: result.error
        ? {
          code: result.error.code,
          message: result.error.message,
          ...(result.error.retryable === undefined
            ? {}
            : { retryable: result.error.retryable }),
        }
        : { code: 'tool_unavailable', message: 'The requested tool is unavailable.' },
    };
  assertJsonComplexityV1(modelVisible, 'Codex bridge tool result');
  const text = JSON.stringify(modelVisible);
  if (Buffer.byteLength(text, 'utf8') > MAX_CODEX_BRIDGE_TOOL_RESULT_BYTES_V1) {
    throw new Error(
      `Codex bridge tool result exceeds ${MAX_CODEX_BRIDGE_TOOL_RESULT_BYTES_V1} bytes`,
    );
  }
  return Object.freeze({ text, isError: result.status !== 'succeeded' });
}

export function parseCodexBridgeArgumentsV1(value: unknown): JsonObject {
  const parsed = jsonValueSchema.safeParse(value ?? {});
  if (!parsed.success) throw new Error('Codex bridge tool arguments are not JSON');
  assertJsonComplexityV1(parsed.data, 'Codex bridge tool arguments');
  const object = jsonObjectSchema.safeParse(parsed.data);
  if (!object.success) throw new Error('Codex bridge tool arguments must be an object');
  return object.data;
}

/**
 * Splits a byte stream into complete newline-terminated lines with a hard
 * per-line bound. Used by both ends of the socket and by the MCP stdio
 * transport, which is also newline-delimited JSON.
 */
export function createLineSplitterV1(
  onLine: (line: string) => void,
  maxLineBytes: number = MAX_CODEX_BRIDGE_LINE_BYTES_V1,
): Readonly<{ push(chunk: Buffer | string): void; end(): void }> {
  let buffered = Buffer.alloc(0);
  return Object.freeze({
    push(chunk: Buffer | string): void {
      buffered = Buffer.concat([
        buffered,
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
      ]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline === -1) {
          if (buffered.length > maxLineBytes) {
            throw new Error('Codex bridge line exceeds the size bound');
          }
          return;
        }
        const line = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        buffered = buffered.subarray(newline + 1);
        if (newline > maxLineBytes) {
          throw new Error('Codex bridge line exceeds the size bound');
        }
        if (line.trim().length > 0) onLine(line);
      }
    },
    end(): void {
      if (buffered.length === 0) return;
      const line = buffered.toString('utf8').replace(/\r$/, '');
      buffered = Buffer.alloc(0);
      if (line.trim().length > 0) onLine(line);
    },
  });
}
