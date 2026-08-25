import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  assertPactJsonComplexityV1,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from '../../protocol/v1/index.js';
import type { AgentWorkspaceFilePathV1 } from './agent-workspace.js';
import {
  resolvePactRunModelApiKeyV1,
  type PactModelConfigV1,
} from './config.js';
import {
  FILE_TURN_BOOTSTRAP_V1,
  fileTurnDecisionV1Schema,
  fileTurnInputV1Schema,
  type FileHarnessContactPortV1,
  type FileTurnDecisionV1,
  type FileTurnInputV1,
  type FreshFileHarnessFactoryV1,
  type FreshFileHarnessV1,
} from './file-harness.js';
import type { FileWorkspacePortV1 } from './file-workspace.js';
import {
  cancelOpenAICompatibleProviderResponseBodyV1,
  isOpenAICompatibleProviderRedirectResponseV1,
  isRetryableOpenAICompatibleProviderStatusV1,
  MAX_OPENAI_COMPATIBLE_PROVIDER_RESPONSE_BYTES_V1,
  openAICompatibleProviderDefaultRetryDelayMsV1,
  openAICompatibleProviderRequestExtrasV1,
  openAICompatibleProviderRetryDelayMsV1,
  readBoundedOpenAICompatibleProviderJsonV1,
  readOpenAICompatibleProviderResponseHeadersV1,
  redactOpenAICompatibleProviderCredentialV1,
  resolveOpenAICompatibleProviderRequestTargetV1,
  waitForOpenAICompatibleProviderRetryV1,
  type OpenAICompatibleProviderResponseHeadersV1 as ProviderHeaders,
} from './openai-compatible-client.js';

type FetchImplementation = typeof globalThis.fetch;

export const MAX_FILE_PROVIDER_RESPONSE_BYTES_V1 =
  MAX_OPENAI_COMPATIBLE_PROVIDER_RESPONSE_BYTES_V1;
const MAX_FILE_TOOL_RESULT_BYTES_V1 = 2 * 1_024 * 1_024;
const MAX_PROVIDER_ATTEMPTS_V1 = 8;
const logicalPaths = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];
const logicalPathSet = new Set<string>(logicalPaths);

type FileToolNameV1 =
  | 'files_list'
  | 'files_read'
  | 'files_replace_memory'
  | 'contact_agent';

type ProviderToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ProviderMessage =
  | { role: 'user'; content: string }
  | {
    role: 'assistant';
    content: string | null;
    tool_calls: ProviderToolCall[];
    reasoning_details?: JsonValue[];
  }
  | { role: 'tool'; tool_call_id: string; content: string };

type ProviderTool = {
  type: 'function';
  function: { name: FileToolNameV1; description: string; parameters: JsonObject };
};

type FetchedCompletion = {
  body: unknown;
  headers: ProviderHeaders;
  attempts: number;
  latencyMs: number;
};

export type FileProviderUsageV1 = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
};

export type FileProviderRequestTelemetryV1 = {
  requestedModel: string;
  resolvedModel: string;
  servedModel?: string;
  provider?: string;
  responseId?: string;
  requestId?: string;
  generationId?: string;
  httpStatus?: number;
  lastResponseAttempt?: number;
  retryable?: boolean;
  latencyMs: number;
  attempts: number;
  choiceCount?: number;
  outcome: 'success' | 'invalid_response' | 'provider_error';
  usage?: FileProviderUsageV1;
};

export type FileProviderTelemetryV1 = {
  requestedModel: string;
  resolvedModel: string;
  requests: FileProviderRequestTelemetryV1[];
  totals: {
    requests: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    costUsd?: number;
  };
};

type FileProviderTelemetrySourceV1 = {
  getFileProviderTelemetryV1(): FileProviderTelemetryV1;
};

export type OpenAICompatibleFileHarnessV1Options = {
  model: PactModelConfigV1;
  requestedModel?: string;
  workspace: FileWorkspacePortV1;
  readablePaths: readonly AgentWorkspaceFilePathV1[];
  allowMemoryReplacement: boolean;
  contact?: FileHarnessContactPortV1;
  fetch?: FetchImplementation;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export class FileProviderRequestErrorV1 extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'FileProviderRequestErrorV1';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

const providerToolCallSchema = z.object({
  id: z.string().min(1).max(512),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(128),
    arguments: z.string().max(1_048_576),
  }).passthrough(),
}).passthrough();

const providerEnvelopeSchema = z.object({
  id: z.string().min(1).max(512).nullish(),
  model: z.string().min(1).max(512).nullish(),
  provider: z.string().min(1).max(512).nullish(),
  usage: z.unknown().optional(),
  choices: z.array(z.unknown()).min(1).max(128),
}).passthrough();

const providerChoiceSchema = z.object({
  message: z.object({
    content: z.string().nullable().optional(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(providerToolCallSchema).max(128).nullish(),
    reasoning_details: z.array(z.unknown()).max(256).nullish(),
  }).passthrough(),
}).passthrough();

const nonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const providerUsageSchema = z.object({
  prompt_tokens: nonnegativeFiniteNumberSchema.nullish(),
  completion_tokens: nonnegativeFiniteNumberSchema.nullish(),
  total_tokens: nonnegativeFiniteNumberSchema.nullish(),
  cost: nonnegativeFiniteNumberSchema.nullish(),
  prompt_tokens_details: z.object({
    cached_tokens: nonnegativeFiniteNumberSchema.nullish(),
  }).passthrough().nullish(),
  completion_tokens_details: z.object({
    reasoning_tokens: nonnegativeFiniteNumberSchema.nullish(),
  }).passthrough().nullish(),
}).passthrough();

const noArgumentsSchema = z.object({}).strict();
const readArgumentsSchema = z.object({
  path: z.enum(logicalPaths),
}).strict();
const replaceMemoryArgumentsSchema = z.object({
  expectedVersion: z.number().int().safe().nonnegative(),
  content: z.string().max(1_048_576),
}).strict();
const contactArgumentsSchema = z.object({
  recipientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  message: z.string().min(1).max(65_536),
  intent: z.string().min(1).max(256),
  purpose: z.string().min(1).max(256),
  deadlineMs: z.number().int().safe().positive().max(3_600_000),
}).strict();
const fileReadResultSchema = z.object({
  content: z.string().max(1_048_576),
  receipt: z.object({
    actorId: z.string(),
    path: z.enum(logicalPaths),
    action: z.literal('read'),
    version: z.number().int().safe().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().safe().nonnegative(),
  }).passthrough(),
}).passthrough();
const replaceMemoryResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('committed'),
    version: z.number().int().safe().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().safe().nonnegative(),
    durability: z.literal('published_unsynced').optional(),
  }).passthrough(),
  z.object({
    outcome: z.literal('conflict'),
    version: z.number().int().safe().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().safe().nonnegative(),
  }).passthrough(),
]);
const contactResultSchema = z.object({
  status: z.enum(['completed', 'denied', 'failed', 'cancelled']),
  response: z.string().max(1_048_576).optional(),
  errorCode: z.string().min(1).max(256).optional(),
  recipientTraceId: z.string().min(1).max(128),
}).passthrough();

export class OpenAICompatibleFileHarnessV1 implements FreshFileHarnessV1 {
  private readonly fetchImplementation: FetchImplementation;
  private readonly apiKey: string;
  private readonly completionUrl: URL;
  private readonly authHeaders: Readonly<Record<string, string>>;
  private readonly resolvedModel: string;
  private readonly requestedModel: string;
  private readonly configuredTimeoutMs: number;
  private readonly readablePaths: readonly AgentWorkspaceFilePathV1[];
  private readonly readablePathSet: ReadonlySet<string>;
  private readonly providerTools: ProviderTool[];
  private readonly availableToolNames: ReadonlySet<string>;
  private readonly activeControllers = new Set<AbortController>();
  private messages: ProviderMessage[] = [];
  private seenToolCallIds = new Set<string>();
  private observedMemoryVersions = new Set<number>();
  private providerRequests: FileProviderRequestTelemetryV1[] = [];
  private started = false;
  private finalized = false;

  constructor(private readonly options: OpenAICompatibleFileHarnessV1Options) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the file model adapter');
    }
    this.apiKey = resolvePactRunModelApiKeyV1(
      { model: options.model },
      options.environment ?? process.env,
    );
    const target = resolveOpenAICompatibleProviderRequestTargetV1(
      options.model,
      this.apiKey,
    );
    this.completionUrl = target.url;
    this.authHeaders = target.headers;
    this.resolvedModel = target.bodyModel;
    this.requestedModel = validateRequestedModel(
      options.requestedModel ?? this.resolvedModel,
    );
    this.configuredTimeoutMs = validateTimeout(options.timeoutMs ?? 3_600_000);
    this.readablePaths = validateReadablePaths(options.readablePaths);
    this.readablePathSet = new Set(this.readablePaths);
    this.providerTools = buildProviderTools({
      readablePaths: this.readablePaths,
      allowMemoryReplacement: options.allowMemoryReplacement,
      allowContact: options.contact !== undefined,
    });
    this.availableToolNames = new Set(
      this.providerTools.map(tool => tool.function.name),
    );
  }

  async step(input: FileTurnInputV1): Promise<FileTurnDecisionV1> {
    if (this.started || this.finalized) {
      throw new Error('A fresh file harness instance is required for every turn');
    }
    this.started = true;
    const parsed = fileTurnInputV1Schema.parse(input);
    if (parsed.cancelled) {
      return {
        type: 'cancelled',
        reason: 'The file turn was cancelled before it started.',
        toolSteps: 0,
        contactCalls: 0,
      };
    }

    this.messages = [{ role: 'user', content: FILE_TURN_BOOTSTRAP_V1 }];
    const deadlineAt = Date.now() + parsed.deadlineMs;
    let toolSteps = 0;
    let contactCalls = 0;
    while (true) {
      const fetched = await this.fetchCompletion(
        this.requestBody(),
        remainingTime(deadlineAt),
      );
      const response = redactOpenAICompatibleProviderCredentialV1(
        fetched.body,
        this.apiKey,
      );
      const envelope = providerEnvelopeSchema.safeParse(response);
      if (!envelope.success) {
        this.providerRequests.push(telemetryFromResponse({
          requestedModel: this.requestedModel,
          resolvedModel: this.resolvedModel,
          fetched,
          outcome: 'invalid_response',
        }));
        throw new Error(
          `File model provider returned an invalid response envelope: ${summarizeIssues(envelope.error)}`,
        );
      }
      const telemetry = telemetryFromResponse({
        requestedModel: this.requestedModel,
        resolvedModel: this.resolvedModel,
        fetched,
        envelope: envelope.data,
        outcome: 'invalid_response',
      });
      this.providerRequests.push(telemetry);
      const choice = providerChoiceSchema.safeParse(envelope.data.choices[0]);
      if (!choice.success) {
        throw new Error(
          `File model provider returned an invalid first choice: ${summarizeIssues(choice.error)}`,
        );
      }
      const message = choice.data.message;
      const calls = message.tool_calls ?? [];
      if (calls.length > 0) {
        assertUniqueAndFreshCallIds(calls, this.seenToolCallIds);
        if (calls.length !== 1) {
          throw new Error('File model provider returned multiple parallel tool calls');
        }
        if (toolSteps >= parsed.maxToolSteps) {
          throw new Error('File turn tool-step budget exhausted');
        }
        const call = calls[0];
        if (!call) throw new Error('File model provider returned no tool call');
        if (!this.availableToolNames.has(call.function.name)) {
          throw new Error('File model provider selected an unavailable tool');
        }
        const reasoning = parseReasoningDetails(message.reasoning_details);
        this.messages.push({
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: [call],
          ...(reasoning ? { reasoning_details: reasoning } : {}),
        });
        this.seenToolCallIds.add(call.id);
        toolSteps += 1;
        const dispatched = await this.dispatchTool({
          call,
          turn: parsed,
          deadlineAt,
          contactCalls,
        });
        contactCalls += dispatched.contactCalls;
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: stringifyToolResult(dispatched.result),
        });
        telemetry.outcome = 'success';
        continue;
      }

      const refusal = message.refusal?.trim();
      if (refusal) {
        telemetry.outcome = 'success';
        return fileTurnDecisionV1Schema.parse({
          type: 'denied',
          reason: refusal,
          toolSteps,
          contactCalls,
        });
      }
      const content = message.content?.trim();
      if (!content) throw new Error('File model provider returned no turn decision');
      telemetry.outcome = 'success';
      return fileTurnDecisionV1Schema.parse({
        type: 'completed',
        content,
        toolSteps,
        contactCalls,
      });
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
    this.messages = [];
    this.seenToolCallIds.clear();
    this.observedMemoryVersions.clear();
  }

  getFileProviderTelemetryV1(): FileProviderTelemetryV1 {
    const usages = this.providerRequests.map(request => request.usage);
    return {
      requestedModel: this.requestedModel,
      resolvedModel: this.resolvedModel,
      requests: structuredClone(this.providerRequests),
      totals: {
        requests: this.providerRequests.length,
        ...sumUsage(usages, 'promptTokens'),
        ...sumUsage(usages, 'completionTokens'),
        ...sumUsage(usages, 'totalTokens'),
        ...sumUsage(usages, 'reasoningTokens'),
        ...sumUsage(usages, 'cachedTokens'),
        ...sumUsage(usages, 'costUsd'),
      },
    };
  }

  private requestBody(): Record<string, unknown> {
    return {
      model: this.resolvedModel,
      ...(this.options.model.temperature === undefined
        ? {}
        : { temperature: this.options.model.temperature }),
      ...openAICompatibleProviderRequestExtrasV1(this.options.model),
      max_tokens: this.options.model.maxOutputTokens,
      messages: this.messages,
      ...(this.providerTools.length === 0
        ? {}
        : {
          tools: this.providerTools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }),
    };
  }

  private async dispatchTool(input: {
    call: ProviderToolCall;
    turn: FileTurnInputV1;
    deadlineAt: number;
    contactCalls: number;
  }): Promise<{ result: JsonValue; contactCalls: number }> {
    const raw = parseToolArguments(input.call.function.arguments);
    const name = input.call.function.name as FileToolNameV1;
    if (name === 'files_list') {
      noArgumentsSchema.parse(raw);
      return {
        result: { actorId: input.turn.actorId, paths: [...this.readablePaths] },
        contactCalls: 0,
      };
    }
    if (name === 'files_read') {
      const args = readArgumentsSchema.parse(raw);
      if (!this.readablePathSet.has(args.path)) {
        throw new Error('File model provider selected an unauthorized logical path');
      }
      remainingTime(input.deadlineAt);
      const loaded = fileReadResultSchema.parse(await invokeHostOperation(
        () => this.options.workspace.read({
          actorId: input.turn.actorId,
          path: args.path,
        }),
        'File workspace read failed',
      ));
      remainingTime(input.deadlineAt);
      if (
        loaded.receipt.actorId !== input.turn.actorId
        || loaded.receipt.path !== args.path
      ) {
        throw new Error('File workspace returned a mismatched read receipt');
      }
      if (args.path === 'MEMORY.md') {
        this.observedMemoryVersions.add(loaded.receipt.version);
      }
      return {
        result: {
          content: loaded.content,
          receipt: {
            actorId: loaded.receipt.actorId,
            path: loaded.receipt.path,
            action: loaded.receipt.action,
            version: loaded.receipt.version,
            sha256: loaded.receipt.sha256,
            byteLength: loaded.receipt.byteLength,
          },
        },
        contactCalls: 0,
      };
    }
    if (name === 'files_replace_memory') {
      if (!this.options.allowMemoryReplacement) {
        throw new Error('MEMORY replacement is not authorized for this file turn');
      }
      const args = replaceMemoryArgumentsSchema.parse(raw);
      if (!this.observedMemoryVersions.has(args.expectedVersion)) {
        throw new Error(
          'MEMORY replacement requires the expected version observed by a read in this file turn',
        );
      }
      // A failed or conflicting attempt requires a fresh read. A successful
      // commit receipt below establishes the only new observable version.
      this.observedMemoryVersions.clear();
      remainingTime(input.deadlineAt);
      const replaced = replaceMemoryResultSchema.parse(
        await invokeHostOperation(
          () => this.options.workspace.replaceMemory({
            actorId: input.turn.actorId,
            expectedVersion: args.expectedVersion,
            content: args.content,
          }),
          'File workspace MEMORY replacement failed',
        ),
      );
      remainingTime(input.deadlineAt);
      if (replaced.outcome === 'committed') {
        this.observedMemoryVersions.add(replaced.version);
      }
      return {
        result: {
          actorId: input.turn.actorId,
          path: 'MEMORY.md',
          action: 'replace',
          outcome: replaced.outcome,
          version: replaced.version,
          sha256: replaced.sha256,
          byteLength: replaced.byteLength,
          ...(replaced.outcome === 'committed'
            && replaced.durability === 'published_unsynced'
            ? { durability: 'published_unsynced' }
            : {}),
        },
        contactCalls: 0,
      };
    }
    if (name === 'contact_agent') {
      if (!this.options.contact) {
        throw new Error('Agent contact is not authorized for this file turn');
      }
      if (input.contactCalls >= input.turn.maxContactCalls) {
        throw new Error('File turn contact budget exhausted');
      }
      const args = contactArgumentsSchema.parse(raw);
      const remaining = remainingTime(input.deadlineAt);
      const contacted = contactResultSchema.parse(await invokeHostOperation(
        () => this.options.contact!.contact({
          senderId: input.turn.actorId,
          recipientId: args.recipientId,
          message: args.message,
          intent: args.intent,
          purpose: args.purpose,
          traceId: input.turn.traceId,
          deadlineMs: Math.min(args.deadlineMs, remaining),
        }),
        'Agent contact failed',
      ));
      remainingTime(input.deadlineAt);
      return {
        result: {
          status: contacted.status,
          ...(contacted.response === undefined ? {} : { response: contacted.response }),
          ...(contacted.errorCode === undefined ? {} : { errorCode: contacted.errorCode }),
          recipientTraceId: contacted.recipientTraceId,
        },
        contactCalls: 1,
      };
    }
    throw new Error('File model provider selected an unavailable tool');
  }

  private async fetchCompletion(
    body: unknown,
    remainingRuntimeMs: number,
  ): Promise<FetchedCompletion> {
    const timeoutMs = Math.min(this.configuredTimeoutMs, remainingRuntimeMs);
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let attempts = 0;
    let failureHeaders: ProviderHeaders = {};
    let failureStatus: number | undefined;
    let failureAttempt: number | undefined;
    let failureRetryable: boolean | undefined;
    try {
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS_V1; attempt += 1) {
        attempts = attempt;
        let response: Response;
        try {
          response = await this.fetchImplementation(this.completionUrl, {
            method: 'POST',
            headers: { ...this.authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) {
            throw new Error(`File model provider timed out after ${timeoutMs}ms`);
          }
          if (attempt < MAX_PROVIDER_ATTEMPTS_V1) {
            await waitForOpenAICompatibleProviderRetryV1(
              openAICompatibleProviderDefaultRetryDelayMsV1(attempt),
              controller.signal,
              timeoutMs,
              'File model provider',
            );
            continue;
          }
          failureRetryable = true;
          throw new FileProviderRequestErrorV1(
            'File model provider request failed',
            { retryable: true },
          );
        }
        failureHeaders = readOpenAICompatibleProviderResponseHeadersV1(
          response,
          this.apiKey,
        );
        failureStatus = response.status;
        failureAttempt = attempt;
        failureRetryable = response.ok
          ? false
          : isRetryableOpenAICompatibleProviderStatusV1(response.status);
        if (isOpenAICompatibleProviderRedirectResponseV1(response)) {
          await cancelOpenAICompatibleProviderResponseBodyV1(response);
          failureRetryable = false;
          throw new FileProviderRequestErrorV1(
            'File model provider responded with a redirect; refusing to resend credentials',
            { ...(response.status ? { status: response.status } : {}), retryable: false },
          );
        }
        if (!response.ok) {
          const retryable = failureRetryable;
          const delay = openAICompatibleProviderRetryDelayMsV1(response, attempt);
          await cancelOpenAICompatibleProviderResponseBodyV1(response);
          if (retryable && attempt < MAX_PROVIDER_ATTEMPTS_V1) {
            await waitForOpenAICompatibleProviderRetryV1(
              delay,
              controller.signal,
              timeoutMs,
              'File model provider',
            );
            continue;
          }
          throw new FileProviderRequestErrorV1(
            `File model provider request failed with HTTP ${response.status}`,
            { status: response.status, retryable },
          );
        }
        return {
          body: await readBoundedOpenAICompatibleProviderJsonV1(
            response,
            controller.signal,
            timeoutMs,
            'File model provider',
          ),
          headers: readOpenAICompatibleProviderResponseHeadersV1(
            response,
            this.apiKey,
          ),
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
        };
      }
      throw new FileProviderRequestErrorV1('File model provider request failed');
    } catch (error) {
      this.providerRequests.push({
        requestedModel: this.requestedModel,
        resolvedModel: this.resolvedModel,
        ...(failureHeaders.provider ? { provider: failureHeaders.provider } : {}),
        ...(failureHeaders.requestId ? { requestId: failureHeaders.requestId } : {}),
        ...(failureHeaders.generationId
          ? { generationId: failureHeaders.generationId }
          : {}),
        ...(failureStatus === undefined ? {} : { httpStatus: failureStatus }),
        ...(failureAttempt === undefined ? {} : { lastResponseAttempt: failureAttempt }),
        ...(failureRetryable === undefined ? {} : { retryable: failureRetryable }),
        latencyMs: Date.now() - startedAt,
        attempts: Math.max(1, attempts),
        outcome: failureStatus !== undefined && failureStatus >= 200 && failureStatus < 300
          ? 'invalid_response'
          : 'provider_error',
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }
}

export function createOpenAICompatibleFileHarnessFactoryV1(
  options: OpenAICompatibleFileHarnessV1Options,
): FreshFileHarnessFactoryV1 {
  const frozenOptions = {
    ...options,
    readablePaths: [...options.readablePaths],
  };
  return () => new OpenAICompatibleFileHarnessV1(frozenOptions);
}

export function readFileProviderTelemetryV1(
  harness: FreshFileHarnessV1,
): FileProviderTelemetryV1 | undefined {
  const source = harness as FreshFileHarnessV1 & Partial<FileProviderTelemetrySourceV1>;
  return typeof source.getFileProviderTelemetryV1 === 'function'
    ? source.getFileProviderTelemetryV1()
    : undefined;
}

function buildProviderTools(options: {
  readablePaths: readonly AgentWorkspaceFilePathV1[];
  allowMemoryReplacement: boolean;
  allowContact: boolean;
}): ProviderTool[] {
  const tools: ProviderTool[] = [];
  if (options.readablePaths.length > 0) {
    tools.push({
      type: 'function',
      function: {
        name: 'files_list',
        description: 'List the authorized logical files in this agent workspace.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }, {
      type: 'function',
      function: {
        name: 'files_read',
        description: 'Read one authorized logical file from this agent workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', enum: [...options.readablePaths] },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    });
  }
  if (options.allowMemoryReplacement) {
    tools.push({
      type: 'function',
      function: {
        name: 'files_replace_memory',
        description: 'Replace all MEMORY.md bytes using the version observed by a prior read.',
        parameters: {
          type: 'object',
          properties: {
            expectedVersion: { type: 'integer', minimum: 0 },
            content: { type: 'string' },
          },
          required: ['expectedVersion', 'content'],
          additionalProperties: false,
        },
      },
    });
  }
  if (options.allowContact) {
    tools.push({
      type: 'function',
      function: {
        name: 'contact_agent',
        description: 'Contact one agent through the authorized host boundary.',
        parameters: {
          type: 'object',
          properties: {
            recipientId: { type: 'string' },
            message: { type: 'string' },
            intent: { type: 'string' },
            purpose: { type: 'string' },
            deadlineMs: { type: 'integer', minimum: 1 },
          },
          required: ['recipientId', 'message', 'intent', 'purpose', 'deadlineMs'],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

function validateReadablePaths(
  input: readonly AgentWorkspaceFilePathV1[],
): readonly AgentWorkspaceFilePathV1[] {
  if (input.length > logicalPaths.length || new Set(input).size !== input.length) {
    throw new Error('Readable file paths must be unique logical workspace paths');
  }
  for (const path of input) {
    if (!logicalPathSet.has(path)) {
      throw new Error('Readable file path is not a logical workspace path');
    }
  }
  return Object.freeze([...input]);
}

function parseToolArguments(source: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error('File model provider returned malformed tool arguments');
  }
  assertPactJsonComplexityV1(parsed, 'File model tool arguments');
  const object = jsonObjectSchema.safeParse(parsed);
  if (!object.success) {
    throw new Error('File model provider returned malformed tool arguments');
  }
  return object.data;
}

function stringifyToolResult(result: JsonValue): string {
  assertPactJsonComplexityV1(result, 'File model tool result');
  const source = JSON.stringify(result);
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_TOOL_RESULT_BYTES_V1) {
    throw new Error(`File model tool result exceeds ${MAX_FILE_TOOL_RESULT_BYTES_V1} bytes`);
  }
  return source;
}

function assertUniqueAndFreshCallIds(
  calls: ProviderToolCall[],
  seen: ReadonlySet<string>,
): void {
  if (new Set(calls.map(call => call.id)).size !== calls.length) {
    throw new Error('File model provider returned duplicate tool-call identifiers');
  }
  if (calls.some(call => seen.has(call.id))) {
    throw new Error('File model provider reused a prior tool-call identifier');
  }
}

function parseReasoningDetails(value: unknown[] | null | undefined): JsonValue[] | undefined {
  if (!value || value.length === 0) return undefined;
  const parsed = z.array(jsonValueSchema).safeParse(value);
  if (!parsed.success) {
    throw new Error('File model provider returned invalid reasoning details');
  }
  return parsed.data;
}

function remainingTime(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('File turn runtime deadline exceeded');
  return remaining;
}

async function invokeHostOperation<T>(
  operation: () => Promise<T>,
  publicMessage: string,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(publicMessage);
  }
}

function validateRequestedModel(value: string): string {
  const parsed = z.string().trim().min(1).max(512).safeParse(value);
  if (!parsed.success) throw new Error('Requested model identity is invalid');
  return parsed.data;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3_600_000) {
    throw new Error('File model timeout must be a positive integer up to 3600000ms');
  }
  return value;
}

function telemetryFromResponse(options: {
  requestedModel: string;
  resolvedModel: string;
  fetched: FetchedCompletion;
  envelope?: z.infer<typeof providerEnvelopeSchema>;
  outcome: FileProviderRequestTelemetryV1['outcome'];
}): FileProviderRequestTelemetryV1 {
  const usage = providerUsage(options.envelope?.usage);
  return {
    requestedModel: options.requestedModel,
    resolvedModel: options.resolvedModel,
    ...(options.envelope?.model ? { servedModel: options.envelope.model } : {}),
    ...(options.envelope?.provider ?? options.fetched.headers.provider
      ? { provider: options.envelope?.provider ?? options.fetched.headers.provider }
      : {}),
    ...(options.envelope?.id ? { responseId: options.envelope.id } : {}),
    ...(options.fetched.headers.requestId
      ? { requestId: options.fetched.headers.requestId }
      : {}),
    ...(options.fetched.headers.generationId
      ? { generationId: options.fetched.headers.generationId }
      : {}),
    latencyMs: options.fetched.latencyMs,
    attempts: options.fetched.attempts,
    ...(options.envelope ? { choiceCount: options.envelope.choices.length } : {}),
    outcome: options.outcome,
    ...(usage ? { usage } : {}),
  };
}

function providerUsage(value: unknown): FileProviderUsageV1 | undefined {
  const parsed = providerUsageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const usage: FileProviderUsageV1 = {
    ...(parsed.data.prompt_tokens == null ? {} : { promptTokens: parsed.data.prompt_tokens }),
    ...(parsed.data.completion_tokens == null
      ? {}
      : { completionTokens: parsed.data.completion_tokens }),
    ...(parsed.data.total_tokens == null ? {} : { totalTokens: parsed.data.total_tokens }),
    ...(parsed.data.completion_tokens_details?.reasoning_tokens == null
      ? {}
      : { reasoningTokens: parsed.data.completion_tokens_details.reasoning_tokens }),
    ...(parsed.data.prompt_tokens_details?.cached_tokens == null
      ? {}
      : { cachedTokens: parsed.data.prompt_tokens_details.cached_tokens }),
    ...(parsed.data.cost == null ? {} : { costUsd: parsed.data.cost }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function sumUsage<K extends keyof FileProviderUsageV1>(
  usages: Array<FileProviderUsageV1 | undefined>,
  key: K,
): Partial<Record<K, number>> {
  const values = usages.flatMap(usage => {
    const value = usage?.[key];
    return value === undefined ? [] : [value];
  });
  return values.length === 0
    ? {}
    : { [key]: values.reduce((sum, value) => sum + value, 0) } as Partial<Record<K, number>>;
}

function summarizeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 6).map(issue => {
    const path = issue.path.length === 0 ? '<root>' : issue.path.map(segment =>
      typeof segment === 'number' ? `[${segment}]` : String(segment)).join('.');
    return issue.code === z.ZodIssueCode.invalid_type
      ? `${path}: expected ${issue.expected}, received ${issue.received}`
      : `${path}: ${issue.code}`;
  });
  const omitted = error.issues.length - issues.length;
  return `${issues.join('; ')}${omitted > 0 ? `; +${omitted} more issue(s)` : ''}`;
}
