import { Buffer } from 'node:buffer';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { JsonObject } from '../../../contracts/json.js';
import type {
  SoExecutionStatus,
  SoTurnDecision,
  SoTurnDriver,
  SoTurnInput,
} from '../../../execution/sharedos/v1/contracts.js';
import {
  renderFileTurnPromptV1,
  type FileProviderRequestTelemetryV1,
  type FileProviderTelemetrySourceV1,
  type FileProviderTelemetryV1,
  type FileProviderUsageV1,
} from '../file-model-driver.js';
import {
  fileTurnDecisionV1Schema,
  type FileTurnDecisionV1,
} from '../file-turn-contracts.js';
import {
  SHAREDEVAL_MODEL_API_KEY_ENV_V1,
  type PactOpenAICompatibleModelConfigV1,
} from '../model-config.js';
import {
  CODEX_BRIDGE_MCP_SERVER_NAME_V1,
  CODEX_BRIDGE_PROTOCOL_VERSION_V1,
  CODEX_BRIDGE_SOCKET_ENV_V1,
  codexBridgeServerMessageV1Schema,
  createLineSplitterV1,
  projectCodexBridgeToolsV1,
  renderCodexBridgeToolResultV1,
  type CodexBridgeDriverMessageV1,
  type CodexBridgeToolV1,
} from './bridge-protocol.js';
import type { SharedevalCodexHarnessV1 } from './codex-harness-config.js';

/**
 * Responder-side turn driver that delegates one SharedOS execution to the
 * Codex CLI. It implements the same SoTurnDriver contract as the built-in
 * OpenAI-compatible driver, so the SharedOS executor, kernel, grants, audit
 * and the message router are untouched: every tool Codex invokes is still
 * executed by the kernel, and Codex's final message becomes the same
 * `completed` turn decision the built-in responder returns.
 *
 * Lifecycle of one tick:
 *   1. `next({type:'start'})` writes a private CODEX_HOME (config.toml naming
 *      the run's endpoint as a custom provider and this repo's MCP server),
 *      opens a Unix socket, spawns `codex exec` with the bootstrap prompt on
 *      stdin, and waits.
 *   2. Codex spawns the MCP server, which connects to the socket; the driver
 *      publishes the tick's tool list.
 *   3. Each MCP `tools/call` arrives as a bridge `tool_call`; the driver
 *      returns it to the executor as a SharedOS tool call. The executor's
 *      next `tool_result` is rendered and sent back so Codex sees the result.
 *   4. When Codex exits, its last message (the `-o` file) becomes the
 *      `completed` decision; a failed exit or an empty message is a `fail`.
 */
export const CODEX_HARNESS_PROVIDER_ID_V1 = 'codex' as const;
export const CODEX_HARNESS_PREAMBLE_V1 = [
  `Tool access for this turn is provided only by the MCP server "${CODEX_BRIDGE_MCP_SERVER_NAME_V1}".`,
  'Its tools are the workspace tools named in the instructions with "." replaced by "_" '
  + '(for example files_read is files.read).',
  'Do not run shell commands and do not read or write files on disk; the workspace '
  + 'files exist only behind those tools.',
  'Your final assistant message is delivered verbatim as your reply.',
].join(' ');
const MAX_CODEX_STDERR_BYTES_V1 = 16 * 1_024;
const MAX_CODEX_STDOUT_LINE_BYTES_V1 = 4 * 1_024 * 1_024;
const MAX_CODEX_LAST_MESSAGE_BYTES_V1 = 1_048_576;
const DEFAULT_CODEX_TIMEOUT_MS_V1 = 3_600_000;
const CODEX_KILL_GRACE_MS_V1 = 2_000;

export type CodexChildProcessV1 = Readonly<{
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** `close` fires after stdio has drained, so the event stream is complete. */
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}>;

export type CodexSpawnV1 = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>> }>,
) => CodexChildProcessV1;

export type CodexBridgeMcpServerCommandV1 = Readonly<{
  command: string;
  args: readonly string[];
}>;

export type CodexResponderTurnDriverV1Options = Readonly<{
  harness: SharedevalCodexHarnessV1;
  model: PactOpenAICompatibleModelConfigV1;
  requestedModel?: string;
  /** Only SHAREDEVAL_MODEL_API_KEY is forwarded to Codex from here. */
  environment?: Record<string, string | undefined>;
  /** Injected in tests; defaults to node:child_process spawn. */
  spawn?: CodexSpawnV1;
  /** Overrides how Codex launches the bridge MCP server. */
  mcpServerCommand?: CodexBridgeMcpServerCommandV1;
  /** Parent of the per-tick scratch directories; defaults to os.tmpdir(). */
  tempRoot?: string;
}>;

type OpenRequest = Parameters<SoTurnDriver['open']>[0];

type BridgeEvent =
  | { type: 'tool_call'; id: string; mcpName: string; arguments: JsonObject }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; error: Error };

class CodexHarnessErrorV1 extends Error {
  constructor(readonly code: string, message: string, readonly retryable?: boolean) {
    super(message);
    this.name = 'CodexHarnessErrorV1';
  }
}

const codexUsageSchema = z.object({
  input_tokens: z.number().finite().nonnegative().nullish(),
  cached_input_tokens: z.number().finite().nonnegative().nullish(),
  output_tokens: z.number().finite().nonnegative().nullish(),
}).passthrough();

const codexEventSchema = z.object({
  type: z.string(),
  usage: codexUsageSchema.nullish(),
  item: z.object({
    type: z.string().optional(),
    text: z.string().optional(),
  }).passthrough().nullish(),
}).passthrough();

export function defaultCodexBridgeMcpServerCommandV1(): CodexBridgeMcpServerCommandV1 {
  const require = createRequire(import.meta.url);
  const tsxPackage = require.resolve('tsx/package.json');
  const loader = join(dirname(tsxPackage), 'dist', 'loader.mjs');
  const serverMain = fileURLToPath(new URL('./mcp-server-main.ts', import.meta.url));
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze(['--import', loader, serverMain]),
  });
}

/** Renders the private config.toml Codex reads for one tick. */
export function renderCodexConfigTomlV1(input: Readonly<{
  harness: SharedevalCodexHarnessV1;
  model: PactOpenAICompatibleModelConfigV1;
  mcpServer: CodexBridgeMcpServerCommandV1;
  socketPath: string;
  toolTimeoutSec: number;
}>): string {
  const providerId = input.harness.providerId;
  return [
    `model = ${toml(input.model.model)}`,
    `model_provider = ${toml(providerId)}`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    `[model_providers.${providerId}]`,
    `name = ${toml(providerId)}`,
    `base_url = ${toml(input.model.baseUrl)}`,
    `env_key = ${toml(SHAREDEVAL_MODEL_API_KEY_ENV_V1)}`,
    `wire_api = ${toml(input.harness.wireApi)}`,
    '',
    `[mcp_servers.${CODEX_BRIDGE_MCP_SERVER_NAME_V1}]`,
    `command = ${toml(input.mcpServer.command)}`,
    `args = [${input.mcpServer.args.map(toml).join(', ')}]`,
    'startup_timeout_sec = 30',
    `tool_timeout_sec = ${Math.max(1, Math.floor(input.toolTimeoutSec))}`,
    '',
    `[mcp_servers.${CODEX_BRIDGE_MCP_SERVER_NAME_V1}.env]`,
    `${CODEX_BRIDGE_SOCKET_ENV_V1} = ${toml(input.socketPath)}`,
    '',
    '[history]',
    'persistence = "none"',
    '',
  ].join('\n');
}

export function renderCodexResponderPromptV1(message: OpenRequest['message']): string {
  return `${renderFileTurnPromptV1(message)}\n\n${CODEX_HARNESS_PREAMBLE_V1}`;
}

class CodexResponderTurnDriverV1 implements SoTurnDriver, FileProviderTelemetrySourceV1 {
  readonly #options: CodexResponderTurnDriverV1Options;
  readonly #requestedModel: string;
  readonly #apiKey: string;
  readonly #mcpServer: CodexBridgeMcpServerCommandV1;
  readonly #requests: FileProviderRequestTelemetryV1[] = [];

  constructor(options: CodexResponderTurnDriverV1Options) {
    if (options.model.provider !== 'openai-compatible') {
      throw new Error('The Codex responder harness requires an openai-compatible model');
    }
    const environment = options.environment ?? process.env;
    const apiKey = environment[SHAREDEVAL_MODEL_API_KEY_ENV_V1]?.trim();
    if (!apiKey) {
      throw new Error(
        `Model credential environment variable ${SHAREDEVAL_MODEL_API_KEY_ENV_V1} is not set`,
      );
    }
    this.#options = options;
    this.#apiKey = apiKey;
    this.#requestedModel = options.requestedModel ?? options.model.model;
    this.#mcpServer = options.mcpServerCommand ?? defaultCodexBridgeMcpServerCommandV1();
  }

  async open(request: OpenRequest, signal: AbortSignal) {
    if (signal.aborted) throw abortReason(signal);
    const tools = projectCodexBridgeToolsV1(request.tools);
    return new CodexResponderTurnSessionV1({
      request,
      tools,
      harness: this.#options.harness,
      model: this.#options.model,
      requestedModel: this.#requestedModel,
      apiKey: this.#apiKey,
      spawn: this.#options.spawn ?? defaultSpawn,
      mcpServer: this.#mcpServer,
      tempRoot: this.#options.tempRoot ?? tmpdir(),
      recordTelemetry: telemetry => this.#requests.push(telemetry),
    });
  }

  getFileProviderTelemetryV1(): FileProviderTelemetryV1 {
    const usages = this.#requests.map(request => request.usage);
    return {
      requestedModel: this.#requestedModel,
      resolvedModel: this.#options.model.model,
      requests: structuredClone(this.#requests),
      totals: {
        requests: this.#requests.length,
        ...sumUsage(usages, 'promptTokens'),
        ...sumUsage(usages, 'completionTokens'),
        ...sumUsage(usages, 'totalTokens'),
        ...sumUsage(usages, 'cachedTokens'),
      },
    };
  }
}

type SessionOptions = Readonly<{
  request: OpenRequest;
  tools: readonly CodexBridgeToolV1[];
  harness: SharedevalCodexHarnessV1;
  model: PactOpenAICompatibleModelConfigV1;
  requestedModel: string;
  apiKey: string;
  spawn: CodexSpawnV1;
  mcpServer: CodexBridgeMcpServerCommandV1;
  tempRoot: string;
  recordTelemetry: (telemetry: FileProviderRequestTelemetryV1) => void;
}>;

class CodexResponderTurnSessionV1 {
  readonly #options: SessionOptions;
  readonly #toolsBySharedOsName: ReadonlyMap<string, CodexBridgeToolV1>;
  readonly #toolsByMcpName: ReadonlyMap<string, CodexBridgeToolV1>;
  readonly #events: BridgeEvent[] = [];
  #waiter?: { resolve: (event: BridgeEvent) => void; reject: (error: unknown) => void };
  #started = false;
  #closed = false;
  #exited = false;
  #toolSteps = 0;
  #pendingCall?: { bridgeId: string; sharedOsId: string; tool: string };
  #scratchDir?: string;
  #lastMessagePath?: string;
  #server?: Server;
  #bridgeSocket?: Socket;
  #child?: CodexChildProcessV1;
  #startedAtMs = 0;
  #exit?: { code: number | null; signal: string | null };
  #stderr = '';
  #lastAgentMessage?: string;
  #usage: FileProviderUsageV1 | undefined;
  #telemetryRecorded = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#toolsBySharedOsName = new Map(options.tools.map(tool => [tool.name, tool]));
    this.#toolsByMcpName = new Map(options.tools.map(tool => [tool.mcpName, tool]));
  }

  async next(input: SoTurnInput, signal: AbortSignal): Promise<SoTurnDecision> {
    if (signal.aborted) throw abortReason(signal);
    try {
      await this.#acceptInput(input, signal);
      const event = await this.#nextEvent(signal);
      return await this.#decide(event);
    } catch (error) {
      if (signal.aborted) {
        await this.#teardown();
        throw abortReason(signal);
      }
      await this.#teardown();
      return failDecision(error);
    }
  }

  async close(_outcome: SoExecutionStatus, _signal: AbortSignal): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#teardown();
    this.#events.splice(0);
    this.#pendingCall = undefined;
  }

  async #acceptInput(input: SoTurnInput, signal: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new CodexHarnessErrorV1('model_driver_protocol_error', 'Codex session is closed');
    }
    if (!this.#started) {
      if (input.type !== 'start') {
        throw new CodexHarnessErrorV1(
          'model_driver_protocol_error',
          'Codex session expected the start input',
        );
      }
      this.#started = true;
      await this.#launch(signal);
      return;
    }
    if (input.type !== 'tool_result' || !this.#pendingCall) {
      throw new CodexHarnessErrorV1(
        'model_driver_protocol_error',
        'Codex session expected one SharedOS tool result',
      );
    }
    if (
      input.result.callId !== this.#pendingCall.sharedOsId
      || input.result.tool !== this.#pendingCall.tool
    ) {
      throw new CodexHarnessErrorV1(
        'model_driver_protocol_error',
        'Codex session received a mismatched SharedOS tool result',
      );
    }
    const rendered = renderCodexBridgeToolResultV1(input.result);
    this.#sendToBridge({
      type: 'tool_result',
      id: this.#pendingCall.bridgeId,
      text: rendered.text,
      isError: rendered.isError,
    });
    this.#pendingCall = undefined;
  }

  async #decide(event: BridgeEvent): Promise<SoTurnDecision> {
    if (event.type === 'error') throw event.error;
    if (event.type === 'tool_call') {
      const tool = this.#toolsByMcpName.get(event.mcpName);
      if (!tool || !this.#toolsBySharedOsName.has(tool.name)) {
        this.#sendToBridge({
          type: 'rejected',
          id: event.id,
          message: `Unknown tool ${event.mcpName}`,
        });
        throw new CodexHarnessErrorV1(
          'model_invalid_tool_call',
          `Codex requested a tool outside this turn's surface: ${event.mcpName}`,
        );
      }
      const sharedOsId = stableToolCallId(
        this.#options.request.executionId,
        this.#toolSteps,
        event.id,
      );
      this.#toolSteps += 1;
      this.#pendingCall = { bridgeId: event.id, sharedOsId, tool: tool.name };
      return {
        type: 'tool_call',
        call: {
          id: sharedOsId,
          tool: tool.name,
          arguments: structuredClone(event.arguments),
          traceId: this.#options.request.context.traceId,
          requestedAt: this.#options.request.context.now,
        },
      };
    }
    return await this.#finalize(event);
  }

  async #finalize(exit: Extract<BridgeEvent, { type: 'exit' }>): Promise<SoTurnDecision> {
    const content = (await this.#readLastMessage()) ?? this.#lastAgentMessage?.trim();
    const succeeded = exit.code === 0 && !!content;
    this.#recordTelemetry(succeeded ? 'success' : 'provider_error');
    await this.#teardown();
    if (!succeeded) {
      const detail = exit.code === null
        ? `terminated by signal ${exit.signal ?? 'unknown'}`
        : `exited with code ${exit.code}`;
      const stderr = redact(this.#stderr.trim(), this.#options.apiKey);
      throw new CodexHarnessErrorV1(
        'codex_harness_failed',
        exit.code === 0
          ? 'Codex exited without a final message'
          : `Codex ${detail}${stderr ? `: ${stderr.slice(-2_048)}` : ''}`,
        false,
      );
    }
    return terminalDecision({
      type: 'completed',
      content,
      toolSteps: this.#toolSteps,
      contactCalls: 0,
    });
  }

  async #launch(signal: AbortSignal): Promise<void> {
    const request = this.#options.request;
    const scratchDir = await mkdtemp(join(this.#options.tempRoot, 'sharedeval-codex-'));
    this.#scratchDir = scratchDir;
    const home = join(scratchDir, 'home');
    const cwd = join(scratchDir, 'cwd');
    const socketPath = join(scratchDir, 'bridge.sock');
    this.#lastMessagePath = join(scratchDir, 'last-message.txt');
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const timeoutMs = request.options?.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS_V1;
    await writeFile(join(home, 'config.toml'), renderCodexConfigTomlV1({
      harness: this.#options.harness,
      model: this.#options.model,
      mcpServer: this.#options.mcpServer,
      socketPath,
      toolTimeoutSec: Math.ceil(timeoutMs / 1_000),
    }), { mode: 0o600 });

    await this.#listen(socketPath);
    if (signal.aborted) throw abortReason(signal);

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '-C', cwd,
      '-o', this.#lastMessagePath,
      ...(this.#options.harness.extraArgs ?? []),
      '-',
    ];
    const env: Record<string, string> = {
      ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),
      ...(process.env['HOME'] ? { HOME: process.env['HOME'] } : {}),
      CODEX_HOME: home,
      [SHAREDEVAL_MODEL_API_KEY_ENV_V1]: this.#options.apiKey,
    };
    this.#startedAtMs = Date.now();
    let child: CodexChildProcessV1;
    try {
      child = this.#options.spawn(this.#options.harness.command, args, { cwd, env });
    } catch (error) {
      throw new CodexHarnessErrorV1(
        'codex_harness_unavailable',
        `Unable to launch Codex: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.#child = child;
    child.on('error', error => {
      this.#push({
        type: 'error',
        error: new CodexHarnessErrorV1(
          'codex_harness_unavailable',
          `Unable to launch Codex: ${redact(error.message, this.#options.apiKey)}`,
        ),
      });
    });
    child.on('close', (code, exitSignal) => {
      this.#exited = true;
      this.#exit = { code, signal: exitSignal };
      this.#push({ type: 'exit', code, signal: exitSignal });
    });
    const stdoutLines = createLineSplitterV1(
      line => this.#observeCodexEvent(line),
      MAX_CODEX_STDOUT_LINE_BYTES_V1,
    );
    child.stdout.on('data', chunk => {
      try {
        stdoutLines.push(chunk as Buffer);
      } catch {
        // An oversized stdout line is not fatal; Codex's last message is read
        // from its output file, not from the event stream.
      }
    });
    child.stderr.on('data', chunk => {
      const text = (chunk as Buffer).toString('utf8');
      this.#stderr = (this.#stderr + text).slice(-MAX_CODEX_STDERR_BYTES_V1);
    });
    const prompt = renderCodexResponderPromptV1(request.message);
    child.stdin.on('error', () => { /* Codex may exit before reading stdin */ });
    child.stdin.end(prompt);
  }

  #listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(socket => this.#acceptBridge(socket));
      this.#server = server;
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        server.on('error', error => this.#push({ type: 'error', error }));
        resolve();
      });
    });
  }

  #acceptBridge(socket: Socket): void {
    if (this.#bridgeSocket) {
      socket.destroy();
      return;
    }
    this.#bridgeSocket = socket;
    const lines = createLineSplitterV1(line => {
      const parsed = codexBridgeServerMessageV1Schema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error('Codex bridge sent an invalid server message');
      const message = parsed.data;
      if (message.type === 'hello') {
        this.#sendToBridge({
          type: 'tools',
          protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION_V1,
          tools: this.#options.tools.map(tool => structuredClone(tool)),
        });
        return;
      }
      this.#push({
        type: 'tool_call',
        id: message.id,
        mcpName: message.mcpName,
        arguments: message.arguments,
      });
    });
    socket.on('data', chunk => {
      try {
        lines.push(chunk as Buffer);
      } catch (error) {
        this.#push({
          type: 'error',
          error: new CodexHarnessErrorV1(
            'codex_bridge_protocol_error',
            error instanceof Error ? error.message : 'Codex bridge protocol error',
          ),
        });
      }
    });
    socket.on('error', () => { /* the exit event carries the outcome */ });
    socket.on('close', () => {
      if (this.#bridgeSocket === socket) this.#bridgeSocket = undefined;
    });
  }

  #sendToBridge(message: CodexBridgeDriverMessageV1): void {
    const socket = this.#bridgeSocket;
    if (!socket || socket.destroyed) return;
    socket.write(`${JSON.stringify(message)}\n`);
  }

  #observeCodexEvent(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const parsed = codexEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.usage) {
      const usage = event.usage;
      const prompt = usage.input_tokens ?? undefined;
      const completion = usage.output_tokens ?? undefined;
      const cached = usage.cached_input_tokens ?? undefined;
      const next: FileProviderUsageV1 = {
        ...(prompt === undefined ? {} : { promptTokens: prompt }),
        ...(completion === undefined ? {} : { completionTokens: completion }),
        ...(prompt === undefined && completion === undefined
          ? {}
          : { totalTokens: (prompt ?? 0) + (completion ?? 0) }),
        ...(cached === undefined ? {} : { cachedTokens: cached }),
      };
      this.#usage = mergeUsage(this.#usage, next);
    }
    if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      this.#lastAgentMessage = event.item.text;
    }
  }

  async #readLastMessage(): Promise<string | undefined> {
    if (!this.#lastMessagePath) return undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(this.#lastMessagePath);
    } catch {
      return undefined;
    }
    if (bytes.length > MAX_CODEX_LAST_MESSAGE_BYTES_V1) {
      throw new CodexHarnessErrorV1(
        'model_invalid_response',
        `Codex final message exceeds ${MAX_CODEX_LAST_MESSAGE_BYTES_V1} bytes`,
      );
    }
    const text = bytes.toString('utf8').trim();
    return text.length === 0 ? undefined : text;
  }

  #push(event: BridgeEvent): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.resolve(event);
      return;
    }
    this.#events.push(event);
  }

  #nextEvent(signal: AbortSignal): Promise<BridgeEvent> {
    const queued = this.#events.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#exited && this.#exit) {
      // Codex already finished; nothing further will arrive.
      return Promise.resolve({ type: 'exit', ...this.#exit });
    }
    return new Promise<BridgeEvent>((resolve, reject) => {
      const onAbort = () => {
        this.#waiter = undefined;
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#waiter = {
        resolve: event => {
          signal.removeEventListener('abort', onAbort);
          resolve(event);
        },
        reject: error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
    });
  }

  #recordTelemetry(outcome: FileProviderRequestTelemetryV1['outcome']): void {
    if (this.#telemetryRecorded) return;
    this.#telemetryRecorded = true;
    this.#options.recordTelemetry({
      requestedModel: this.#options.requestedModel,
      resolvedModel: this.#options.model.model,
      provider: CODEX_HARNESS_PROVIDER_ID_V1,
      latencyMs: this.#startedAtMs === 0 ? 0 : Date.now() - this.#startedAtMs,
      attempts: 1,
      outcome,
      ...(this.#usage ? { usage: this.#usage } : {}),
    });
  }

  async #teardown(): Promise<void> {
    if (this.#startedAtMs !== 0) this.#recordTelemetry('provider_error');
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(new CodexHarnessErrorV1('codex_harness_failed', 'Codex session torn down'));
    if (this.#child && !this.#exited) {
      const child = this.#child;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise<void>(resolve => {
        if (this.#exited) return resolve();
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, CODEX_KILL_GRACE_MS_V1);
        child.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#child = undefined;
    this.#bridgeSocket?.destroy();
    this.#bridgeSocket = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    const scratchDir = this.#scratchDir;
    this.#scratchDir = undefined;
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
}

export function createCodexResponderTurnDriverV1(
  options: CodexResponderTurnDriverV1Options,
): SoTurnDriver & FileProviderTelemetrySourceV1 {
  return new CodexResponderTurnDriverV1(options);
}

const defaultSpawn: CodexSpawnV1 = (command, args, options) => {
  const child: ChildProcess = nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child as unknown as CodexChildProcessV1;
};

function toml(value: string): string {
  return JSON.stringify(value);
}

function stableToolCallId(executionId: string, step: number, bridgeId: string): string {
  const tuple = ['tool-call', executionId, step, bridgeId];
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `call-${digest.slice(0, 40)}`;
}

function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[redacted]');
}

function mergeUsage(
  current: FileProviderUsageV1 | undefined,
  next: FileProviderUsageV1,
): FileProviderUsageV1 {
  if (!current) return next;
  const merged: FileProviderUsageV1 = { ...current };
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'] as const) {
    const value = next[key];
    if (value === undefined) continue;
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

function sumUsage<K extends keyof FileProviderUsageV1>(
  usages: Array<FileProviderUsageV1 | undefined>,
  key: K,
): Partial<Record<K, number>> {
  const values = usages.flatMap(usage => {
    const value = usage?.[key];
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return {};
  return { [key]: values.reduce((total, value) => total + value, 0) } as Partial<Record<K, number>>;
}

function failDecision(error: unknown): SoTurnDecision {
  if (error instanceof CodexHarnessErrorV1) {
    return {
      type: 'fail',
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      },
    };
  }
  return {
    type: 'fail',
    error: {
      code: 'codex_harness_failed',
      message: error instanceof Error ? error.message : 'Codex responder harness failed',
      retryable: false,
    },
  };
}

function terminalDecision(value: FileTurnDecisionV1): SoTurnDecision {
  const parsed = fileTurnDecisionV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new CodexHarnessErrorV1(
      'model_invalid_response',
      'Codex returned an invalid turn decision',
    );
  }
  return { type: 'complete', output: parsed.data };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('SharedOS cancelled the Codex responder turn');
}
