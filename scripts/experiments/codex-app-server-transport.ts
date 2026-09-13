import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const CODEX_APP_SERVER_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';
export const CODEX_TRANSPORT_BASE_URL = 'http://127.0.0.1:1/v1';
type JsonRecord = Record<string, unknown>;
type RpcId = number | string;
type RpcFrame = JsonRecord & { id?: RpcId; method?: string; params?: JsonRecord };

const toolCallSchema = z.object({ id: z.string().min(1), type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }).strict() }).strict();
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).optional(), reasoning_details: z.array(z.unknown()).optional(),
    refusal: z.string().optional() }).strict(),
  z.object({ role: z.literal('tool'), tool_call_id: z.string(), content: z.string() }).strict(),
]);
type Message = z.infer<typeof messageSchema>;
const bodySchema = z.object({ model: z.string(), messages: z.array(messageSchema).min(1),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string(),
    description: z.string(), parameters: z.record(z.unknown()) }).strict() }).strict()).default([]),
}).passthrough();
type Body = z.infer<typeof bodySchema>;

const disabledFeatures = [
  'apps', 'plugins', 'remote_plugin', 'browser_use', 'computer_use', 'multi_agent',
  'multi_agent_v2', 'hooks', 'memories', 'shell_tool', 'unified_exec', 'shell_snapshot',
  'view_image', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'image_generation',
  'artifact', 'workspace_dependencies', 'tool_suggest', 'sleep_tool', 'code_mode',
  'code_mode_host', 'code_mode_only', 'unbounded_connection_retries',
] as const;

export const CODEX_ISOLATION_OVERRIDES: Readonly<JsonRecord> = Object.freeze({
  model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'read-only',
  web_search: 'disabled', 'tools.view_image': false, 'tools.web_search': false,
  'agents.enabled': false, instructions: '', developer_instructions: '',
  project_doc_max_bytes: 0, 'features.skip_host_skill_discovery': true,
  ...Object.fromEntries(disabledFeatures.map(name => [`features.${name}`, false])),
});

export class NativeCodexTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NativeCodexTransportError'; }
}
const error = (code: string): NativeCodexTransportError => new NativeCodexTransportError(code);
const record = (value: unknown): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('native_invalid_frame');
  return value as JsonRecord;
};
const textValue = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw error('native_invalid_frame');
  return value;
};
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface CodexRpcPeer {
  request(method: string, params: JsonRecord, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: JsonRecord): Promise<void>;
  respond(id: RpcId, result: JsonRecord): Promise<void>;
  close(): Promise<void>;
}
export interface CodexRpcLaunch {
  binary: string; cwd: string; overrides: Readonly<JsonRecord>;
  onEvent(frame: RpcFrame): void; onFailure(failure: NativeCodexTransportError): void;
}
export type CodexRpcFactory = (launch: CodexRpcLaunch) => Promise<CodexRpcPeer>;
export type CodexAppServerTransportOptions = {
  model: string;
  actorId: string;
  evidenceDirectory: string;
  effort?: string;
  binary?: string;
  syntheticBaseUrl?: string;
  /** Test injection. Evidence explicitly identifies an injected peer. */
  rpcFactory?: CodexRpcFactory;
  /** Bounds native tool continuations, including a two-response canary. */
  maxNativeToolCalls?: number;
  timeoutMs?: number;
};

type NativeCall = { rpcId: RpcId; callId: string; name: string; arguments: JsonRecord };
type Decision = { kind: 'tool'; call: NativeCall } | { kind: 'final'; content: string };
type NativeTurnEvidence = {
  threadId: string; turnId?: string; selectedModel: string; requestedModel: string;
  modelIdentitySource: 'thread/start.selectedModel-not-upstream-served-model';
  environments: []; instructionSourceCount: number; inputHistoryDigest: string;
  toolCatalogDigest: string; dynamicCalls: number; nativeItemTypes: string[];
  completed: boolean; tokenUsage?: unknown; providerErrorCategory?: string;
  requestedMaxOutputTokens?: number; outputTokenLimitEnforced: false;
};

/** No HTTP request is made. The existing driver's dummy credential is never inspected or forwarded. */
export function createCodexAppServerTransport(options: CodexAppServerTransportOptions) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.actorId)) throw error('native_actor_id_invalid');
  if (!options.model.trim()) throw error('native_explicit_model_required');
  const native = new NativeCodexTransport(options);
  return {
    fetch: native.fetch as typeof globalThis.fetch,
    close: () => native.close(),
    preflight: () => native.preflight(),
    evidence: () => native.evidence(),
  };
}

class NativeCodexTransport {
  readonly #options: CodexAppServerTransportOptions;
  readonly #id = randomUUID();
  #peer?: CodexRpcPeer;
  #scratch?: string;
  #opening?: Promise<void>;
  #closed = false;
  #closing?: Promise<void>;
  #busy = false;
  #failure?: NativeCodexTransportError;
  #version = 'not-started';
  #effort?: string;
  #overrides: JsonRecord = { ...CODEX_ISOLATION_OVERRIDES };
  #aliases = new Map<string, string>();
  #reverseAliases = new Map<string, string>();
  #history: Message[] = [];
  #catalog: Body['tools'] = [];
  #pending?: NativeCall;
  #threadId?: string;
  #turnId?: string;
  #turnComplete = true;
  #texts = new Map<string, string>();
  #publishedTextIds = new Set<string>();
  #seenCallIds = new Set<string>();
  #seenRpcIds = new Set<RpcId>();
  #decisions: Decision[] = [];
  #wake?: () => void;
  #turns: NativeTurnEvidence[] = [];
  #models: Array<{ model: string; isDefault: boolean; defaultReasoningEffort: string }> = [];

  constructor(options: CodexAppServerTransportOptions) { this.#options = options; }

  evidence() {
    return structuredClone({ adapter: 'experimental-native-codex-app-server', actorId: this.#options.actorId,
      binary: this.#options.binary ?? CODEX_APP_SERVER_BINARY, cliVersion: this.#version,
      injectedTestPeer: Boolean(this.#options.rpcFactory), requestedModel: this.#options.model,
      effort: this.#effort, httpRequestsMade: 0, closed: this.#closed,
      failure: this.#failure?.code, turns: this.#turns });
  }

  async preflight() {
    try {
      await this.#ensureOpen();
      return { cliVersion: this.#version, models: structuredClone(this.#models), effort: this.#effort };
    } catch (caught) {
      this.#fail(caught instanceof NativeCodexTransportError ? caught : error('native_preflight_failed'));
      await this.close();
      throw this.#failure;
    }
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.#busy) { this.#fail(error('native_concurrent_fetch')); throw this.#failure; }
    this.#busy = true;
    const deadline = AbortSignal.timeout(this.#options.timeoutMs ?? 180_000);
    const supplied = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = supplied ? AbortSignal.any([supplied, deadline]) : deadline;
    const onAbort = () => this.#fail(error('native_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      this.#healthy();
      const url = new URL(input instanceof Request ? input.url : String(input));
      const expected = new URL(`${this.#options.syntheticBaseUrl ?? CODEX_TRANSPORT_BASE_URL}/chat/completions`);
      if (url.href !== expected.href || url.username || url.password) throw error('native_synthetic_endpoint_mismatch');
      if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'POST') throw error('native_method_invalid');
      const source = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : undefined;
      if (!source || Buffer.byteLength(source) > 64 * 1_024 * 1_024) throw error('native_body_invalid');
      let body: Body;
      try { body = bodySchema.parse(JSON.parse(source)); } catch { throw error('native_body_invalid'); }
      if (body.model !== this.#options.model) throw error('native_requested_model_mismatch');
      await this.#ensureOpen();
      this.#healthy();
      if (this.#turnComplete) await this.#start(body, signal);
      else await this.#continue(body, signal);
      const decision = await this.#next(signal);
      this.#healthy();
      const nativeText = this.#takeText();
      let message: Message;
      if (decision.kind === 'tool') {
        message = { role: 'assistant', content: nativeText || null, tool_calls: [{ id: decision.call.callId,
          type: 'function', function: { name: decision.call.name, arguments: JSON.stringify(decision.call.arguments) } }] };
      } else message = { role: 'assistant', content: nativeText || decision.content };
      this.#history.push(structuredClone(message));
      await this.#save();
      return Response.json({ id: `native-codex-${this.#turnId}`, model: this.#options.model,
        provider: 'native-codex-app-server', choices: [{ message }] });
    } catch (caught) {
      this.#fail(caught instanceof NativeCodexTransportError ? caught : error(signal.aborted ? 'native_cancelled' : 'native_transport_failed'));
      await this.close();
      throw this.#failure;
    } finally {
      this.#busy = false;
      signal.removeEventListener('abort', onAbort);
    }
  };

  #healthy() {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw error('native_closed');
  }

  #fail(failure: NativeCodexTransportError) {
    this.#failure ??= failure;
    this.#wake?.();
    void this.#peer?.close().catch(() => undefined);
  }

  async #ensureOpen() {
    this.#healthy();
    this.#opening ??= this.#open();
    await this.#opening;
    this.#healthy();
  }

  async #open() {
    this.#scratch = await mkdtemp(join(tmpdir(), 'sharedeval-codex-'));
    if (this.#options.rpcFactory) this.#version = 'injected-test-peer';
    else {
      try { this.#version = execFileSync(this.#options.binary ?? CODEX_APP_SERVER_BINARY,
        ['--version'], { encoding: 'utf8', timeout: 10_000, env: nativeEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { throw error('native_binary_unavailable'); }
      if (this.#version !== 'codex-cli 0.153.4') throw error('native_unverified_cli_version');
    }
    // CLI table overrides may merge with user tables. Discover names only, then disable every inherited server.
    for (let attempt = 0; attempt < 2; attempt++) {
      this.#peer = await (this.#options.rpcFactory ?? createNativePeer)({
        binary: this.#options.binary ?? CODEX_APP_SERVER_BINARY, cwd: this.#scratch,
        overrides: this.#overrides, onEvent: frame => this.#event(frame), onFailure: failure => this.#fail(failure),
      });
      await this.#peer.request('initialize', { clientInfo: { name: 'sharedeval_native_probe', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      await this.#peer.notify('initialized', {});
      const config = record(record(await this.#peer.request('config/read', { includeLayers: false, cwd: this.#scratch })).config);
      const servers = config.mcp_servers == null ? {} : record(config.mcp_servers);
      const enabled = Object.entries(servers).filter(([, value]) => record(value).enabled !== false).map(([name]) => name);
      if (enabled.length > 0) {
        if (attempt > 0) throw error('native_mcp_isolation_failed');
        for (const name of enabled) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw error('native_mcp_name_unsupported');
          this.#overrides[`mcp_servers.${name}.enabled`] = false;
        }
        await this.#peer.close();
        this.#peer = undefined;
        continue;
      }
      assertIsolationConfig(config);
      const account = record(await this.#peer.request('account/read', { refreshToken: false }));
      if (record(account.account).type !== 'chatgpt') throw error('native_chatgpt_login_required');
      const listed = record(await this.#peer.request('model/list', { limit: 100, includeHidden: false }));
      if (!Array.isArray(listed.data) || listed.nextCursor) throw error('native_model_catalog_incomplete');
      const all = listed.data.map(record);
      this.#models = all.map(m => ({ model: textValue(m.model), isDefault: m.isDefault === true,
        defaultReasoningEffort: textValue(m.defaultReasoningEffort) }));
      const selected = all.find(m => m.model === this.#options.model);
      if (!selected) throw error('native_model_unavailable');
      this.#effort = this.#options.effort ?? textValue(selected.defaultReasoningEffort);
      if (!Array.isArray(selected.supportedReasoningEfforts)
        || !selected.supportedReasoningEfforts.some(e => record(e).reasoningEffort === this.#effort)) {
        throw error('native_effort_unavailable');
      }
      await this.#save();
      return;
    }
    throw error('native_config_isolation_failed');
  }

  async #start(body: Body, signal: AbortSignal) {
    const current = body.messages.at(-1)!;
    if (current.role !== 'user') throw error('native_turn_requires_user_input');
    this.#history = structuredClone(body.messages);
    this.#catalog = structuredClone(body.tools);
    this.#aliases.clear(); this.#reverseAliases.clear(); this.#texts.clear(); this.#publishedTextIds.clear();
    this.#seenCallIds.clear(); this.#seenRpcIds.clear();
    this.#pending = undefined; this.#turnId = undefined;
    this.#decisions = [];
    const dynamicTools = body.tools.map(tool => {
      const name = tool.function.name;
      if (this.#reverseAliases.has(name)) throw error('native_duplicate_tool');
      const alias = `sharedos_${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
      if (this.#aliases.has(alias)) throw error('native_tool_alias_collision');
      this.#aliases.set(alias, name); this.#reverseAliases.set(name, alias);
      return { type: 'function', name: alias, description: `SharedOS tool ${name}. ${tool.function.description}`,
        inputSchema: tool.function.parameters, deferLoading: false };
    });
    const started = record(await this.#peer!.request('thread/start', {
      model: this.#options.model, modelProvider: 'openai', allowProviderModelFallback: false,
      ephemeral: true, cwd: this.#scratch, environments: [], runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [], dynamicTools, approvalPolicy: 'never', sandbox: 'read-only',
      developerInstructions: '', config: this.#overrides,
    }, signal));
    const thread = record(started.thread);
    if (started.model !== this.#options.model || started.modelProvider !== 'openai') throw error('native_model_selection_changed');
    if (thread.ephemeral !== true) throw error('native_thread_not_ephemeral');
    if (!Array.isArray(started.instructionSources) || started.instructionSources.length !== 0) throw error('native_host_instructions_loaded');
    if (started.approvalPolicy !== 'never' || record(started.sandbox).type !== 'readOnly') throw error('native_permissions_changed');
    this.#threadId = textValue(thread.id);
    this.#turns.push({ threadId: this.#threadId, selectedModel: started.model, requestedModel: this.#options.model,
      modelIdentitySource: 'thread/start.selectedModel-not-upstream-served-model', environments: [],
      instructionSourceCount: 0, inputHistoryDigest: digest(body.messages), toolCatalogDigest: digest(body.tools),
      dynamicCalls: 0, nativeItemTypes: [], completed: false, outputTokenLimitEnforced: false,
      ...(typeof body.max_tokens === 'number' ? { requestedMaxOutputTokens: body.max_tokens } : {}),
    });
    const history = projectCodexHistory(body.messages.slice(0, -1), this.#reverseAliases);
    if (history.length > 0) await this.#peer!.request('thread/inject_items', { threadId: this.#threadId, items: history }, signal);
    this.#turnComplete = false;
    const turn = record(record(await this.#peer!.request('turn/start', { threadId: this.#threadId,
      input: [{ type: 'text', text: current.content }], environments: [], model: this.#options.model,
      effort: this.#effort, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }, signal)).turn);
    const turnId = textValue(turn.id);
    if (this.#turnId && this.#turnId !== turnId) throw error('native_turn_id_mismatch');
    this.#turnId = turnId;
    this.#turns.at(-1)!.turnId = turnId;
  }

  async #continue(body: Body, signal: AbortSignal) {
    if (!this.#pending) throw error('native_missing_pending_tool');
    if (digest(body.tools) !== digest(this.#catalog)) throw error('native_midturn_catalog_changed');
    if (body.messages.length !== this.#history.length + 1
      || digest(body.messages.slice(0, -1)) !== digest(this.#history)) throw error('native_history_diverged');
    const result = body.messages.at(-1)!;
    if (result.role !== 'tool' || result.tool_call_id !== this.#pending.callId) throw error('native_tool_result_mismatch');
    let parsed: JsonRecord;
    try { parsed = record(JSON.parse(result.content)); } catch { throw error('native_tool_result_invalid'); }
    if (!['succeeded', 'denied', 'failed'].includes(String(parsed.status))) throw error('native_tool_result_invalid');
    this.#history = structuredClone(body.messages);
    const pending = this.#pending;
    this.#pending = undefined;
    signal.throwIfAborted();
    await this.#peer!.respond(pending.rpcId, { contentItems: [{ type: 'inputText', text: result.content }],
      success: parsed.status === 'succeeded' });
  }

  #event(frame: RpcFrame) {
    if (this.#closed || this.#failure) return;
    try {
      const method = textValue(frame.method);
      const params = record(frame.params ?? {});
      if (frame.id !== undefined) {
        if (method !== 'item/tool/call') throw error('native_unexpected_server_request');
        if (!this.#threadId || this.#turnComplete || params.threadId !== this.#threadId
          || (this.#turnId && params.turnId !== this.#turnId)) throw error('native_call_context_mismatch');
        if (this.#pending) throw error('native_parallel_tool_calls');
        const name = this.#aliases.get(textValue(params.tool));
        if (!name || params.namespace != null) throw error('native_unexpected_tool');
        const entry = this.#turns.at(-1)!;
        if (entry.dynamicCalls >= (this.#options.maxNativeToolCalls ?? 128)) throw error('native_tool_budget_exhausted');
        const call: NativeCall = { rpcId: frame.id, callId: textValue(params.callId), name, arguments: record(params.arguments) };
        if (this.#seenCallIds.has(call.callId) || this.#seenRpcIds.has(call.rpcId)) throw error('native_reused_call_id');
        this.#seenCallIds.add(call.callId); this.#seenRpcIds.add(call.rpcId);
        entry.dynamicCalls++;
        this.#pending = call;
        this.#decisions.push({ kind: 'tool', call }); this.#wake?.();
        return;
      }
      if (method === 'turn/started') {
        if (params.threadId !== this.#threadId) return;
        this.#turnId = textValue(record(params.turn).id);
      } else if (method === 'item/started' || method === 'item/completed') {
        if (params.threadId !== this.#threadId) return;
        const item = record(params.item); const type = textValue(item.type);
        const entry = this.#turns.at(-1)!;
        if (!entry.nativeItemTypes.includes(type)) entry.nativeItemTypes.push(type);
        if (!['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'].includes(type)) throw error('native_unexpected_item');
        if (type === 'dynamicToolCall' && !this.#aliases.has(textValue(item.tool))) throw error('native_unexpected_tool');
        if (type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') {
          this.#texts.set(textValue(item.id), item.text);
        }
      } else if (method === 'turn/completed') {
        if (params.threadId !== this.#threadId) return;
        const turn = record(params.turn);
        if (turn.id !== this.#turnId || turn.status !== 'completed' || this.#pending) throw error('native_turn_failed');
        const content = [...this.#texts.entries()].filter(([id]) => !this.#publishedTextIds.has(id)).map(([, text]) => text).join('\n');
        if (!content?.trim()) throw error('native_empty_completion');
        this.#turnComplete = true; this.#turns.at(-1)!.completed = true;
        this.#decisions.push({ kind: 'final', content }); this.#wake?.();
      } else if (/compact|model.*(?:changed|rerout)/i.test(method)) {
        throw error('native_context_or_model_changed');
      } else if (method === 'error') {
        const detail = params.error == null ? {} : record(params.error);
        const serialized = JSON.stringify(detail);
        const category = /\b401\b|unauthorized/i.test(serialized) ? 'authentication'
          : /\b403\b|forbidden/i.test(serialized) ? 'forbidden'
          : /\b429\b|rate.?limit|usage.?limit/i.test(serialized) ? 'rate_limit'
          : /context.?window|context.*exceed/i.test(serialized) ? 'context_window'
          : /unsupported|not supported|does not support/i.test(serialized) ? 'unsupported_configuration'
          : /network|connect|stream disconnected|timed.?out/i.test(serialized) ? 'connection'
          : /invalid.?request|invalid.*(?:tool|schema)/i.test(serialized) ? 'invalid_request'
          : 'unclassified';
        const turn = this.#turns.at(-1); if (turn) turn.providerErrorCategory = category;
        throw error(`native_provider_error_${category}`);
      }
      else if (method === 'thread/tokenUsage/updated' && params.threadId === this.#threadId) {
        const usage = record(params.tokenUsage);
        const numeric = (v: unknown): JsonRecord => Object.fromEntries(Object.entries(record(v)).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
        this.#turns.at(-1)!.tokenUsage = { total: numeric(usage.total), last: numeric(usage.last) };
      }
    } catch (caught) { this.#fail(caught instanceof NativeCodexTransportError ? caught : error('native_invalid_event')); }
  }

  async #next(signal: AbortSignal): Promise<Decision> {
    for (;;) {
      this.#healthy(); signal.throwIfAborted();
      const next = this.#decisions.shift(); if (next) return next;
      await new Promise<void>(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }

  #takeText(): string {
    const entries = [...this.#texts.entries()].filter(([id]) => !this.#publishedTextIds.has(id));
    for (const [id] of entries) this.#publishedTextIds.add(id);
    return entries.map(([, text]) => text).join('\n');
  }

  async #save() {
    await mkdir(this.#options.evidenceDirectory, { recursive: true });
    await writeFile(join(this.#options.evidenceDirectory, `${this.#options.actorId}-${this.#id}.native.json`),
      `${JSON.stringify(this.evidence(), null, 2)}\n`, { mode: 0o600 });
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true; this.#wake?.();
      await this.#peer?.close();
      if (this.#scratch) await rm(this.#scratch, { recursive: true, force: true });
      await this.#save();
    })();
    return this.#closing;
  }
}

export function projectCodexHistory(messages: readonly Message[], aliases: ReadonlyMap<string, string>): JsonRecord[] {
  const items: JsonRecord[] = [];
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (message.role === 'user') {
      if (outstanding.size) throw error('native_unpaired_history');
      items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] });
    } else if (message.role === 'assistant') {
      if (outstanding.size) throw error('native_unpaired_history');
      if (message.reasoning_details?.length || message.refusal) throw error('native_unprojectable_history');
      if (message.content != null) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.tool_calls ?? []) {
        const alias = aliases.get(call.function.name);
        // A retired tool in historical context gets the same stable name, but no current callable definition.
        const name = alias ?? `sharedos_${createHash('sha256').update(call.function.name).digest('hex').slice(0, 24)}`;
        if (outstanding.has(call.id)) throw error('native_duplicate_history_call');
        outstanding.add(call.id);
        items.push({ type: 'function_call', call_id: call.id, name, arguments: call.function.arguments });
      }
    } else {
      if (!outstanding.delete(message.tool_call_id)) throw error('native_unpaired_history');
      items.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    }
  }
  if (outstanding.size) throw error('native_unpaired_history');
  return items;
}

function assertIsolationConfig(config: JsonRecord) {
  if (config.web_search !== 'disabled' || config.approval_policy !== 'never'
    || config.model_provider !== 'openai' || config.sandbox_mode !== 'read-only'
    || (config.instructions != null && config.instructions !== '')
    || (config.developer_instructions != null && config.developer_instructions !== '')) throw error('native_config_isolation_failed');
  const features = record(config.features);
  if (disabledFeatures.some(key => features[key] !== false) || features.skip_host_skill_discovery !== true) throw error('native_features_not_disabled');
}

export function nativeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'CODEX_HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

async function createNativePeer(launch: CodexRpcLaunch): Promise<CodexRpcPeer> {
  const args = ['app-server', '--stdio'];
  for (const [key, value] of Object.entries(launch.overrides)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  const child = spawn(launch.binary, args, { cwd: launch.cwd, env: nativeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  return new JsonRpcPeer(child, launch.onEvent, launch.onFailure);
}

class JsonRpcPeer implements CodexRpcPeer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #onEvent: (frame: RpcFrame) => void;
  readonly #onFailure: (failure: NativeCodexTransportError) => void;
  readonly #requests = new Map<RpcId, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  #nextId = 1; #buffer = ''; #closed = false; #closePromise?: Promise<void>;
  constructor(child: ChildProcessWithoutNullStreams, onEvent: (frame: RpcFrame) => void,
    onFailure: (failure: NativeCodexTransportError) => void) {
    this.#child = child; this.#onEvent = onEvent; this.#onFailure = onFailure;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => this.#data(chunk));
    child.stderr.resume(); // Diagnostics can contain upstream details; never mirror them into evidence.
    child.on('error', () => this.#fail(error('native_process_error')));
    child.on('close', () => { if (!this.#closed) this.#fail(error('native_process_exited')); });
  }
  async #send(frame: JsonRecord) {
    if (this.#closed) throw error('native_rpc_closed');
    await new Promise<void>((resolve, reject) => this.#child.stdin.write(`${JSON.stringify(frame)}\n`, caught => caught ? reject(error('native_rpc_write_failed')) : resolve()));
  }
  async request(method: string, params: JsonRecord, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.#requests.delete(id); deadline.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); reject(error('native_rpc_timeout')); };
      if (deadline.aborted) { aborted(); return; }
      deadline.addEventListener('abort', aborted, { once: true });
      this.#requests.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: caught => { cleanup(); reject(caught); } });
      void this.#send({ id, method, params }).catch(caught => { cleanup(); reject(caught); });
    });
  }
  notify(method: string, params: JsonRecord) { return this.#send({ method, params }); }
  respond(id: RpcId, result: JsonRecord) { return this.#send({ id, result }); }
  #data(chunk: string) {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > 8 * 1_024 * 1_024) { this.#fail(error('native_rpc_frame_too_large')); return; }
    for (;;) {
      const end = this.#buffer.indexOf('\n'); if (end < 0) return;
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame: RpcFrame;
      try { frame = record(JSON.parse(line)); } catch { this.#fail(error('native_rpc_invalid_json')); return; }
      if (frame.method) this.#onEvent(frame);
      else if (frame.id !== undefined) {
        const pending = this.#requests.get(frame.id);
        if (!pending) { this.#fail(error('native_rpc_unmatched_response')); return; }
        if (frame.error !== undefined) pending.reject(error('native_rpc_rejected'));
        else pending.resolve(frame.result);
      } else { this.#fail(error('native_rpc_invalid_envelope')); return; }
    }
  }
  #fail(failure: NativeCodexTransportError) {
    if (this.#closed) return;
    for (const pending of this.#requests.values()) pending.reject(failure);
    this.#onFailure(failure); void this.close();
  }
  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closed = true;
      for (const pending of this.#requests.values()) pending.reject(error('native_rpc_closed'));
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.#child.kill('SIGKILL'); }, 2_000);
        this.#child.once('close', () => { clearTimeout(timer); resolve(); });
        this.#child.stdin.end(); this.#child.kill('SIGTERM');
      });
    })();
    return this.#closePromise;
  }
}
