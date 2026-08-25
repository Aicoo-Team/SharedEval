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
  InternalFileTurnDeadlineV1,
  InternalFileTurnPublicErrorV1,
  fileTurnDecisionV1Schema,
  fileTurnInputV1Schema,
  parseExternalFileTurnValueV1,
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
  OpenAICompatibleProviderTransportErrorV1,
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

export class FileProviderRequestErrorV1 extends InternalFileTurnPublicErrorV1 {
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
  private readonly activeDeadlines = new Set<InternalFileTurnDeadlineV1>();
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
      throw new InternalFileTurnPublicErrorV1(
        'A fresh file harness instance is required for every turn',
      );
    }
    this.started = true;
    const parsed = parseExternalFileTurnValueV1(
      fileTurnInputV1Schema,
      input,
      'File turn input is invalid',
    );
    if (parsed.cancelled) {
      return {
        type: 'cancelled',
        reason: 'The file turn was cancelled before it started.',
        toolSteps: 0,
        contactCalls: 0,
      };
    }

    const deadline = new InternalFileTurnDeadlineV1(parsed.deadlineMs);
    this.activeDeadlines.add(deadline);
    try {
      return await this.runStep(parsed, deadline);
    } finally {
      deadline.close();
      this.activeDeadlines.delete(deadline);
    }
  }

  private async runStep(
    parsed: FileTurnInputV1,
    deadline: InternalFileTurnDeadlineV1,
  ): Promise<FileTurnDecisionV1> {
    this.messages = [{ role: 'user', content: FILE_TURN_BOOTSTRAP_V1 }];
    let toolSteps = 0;
    let contactCalls = 0;
    while (true) {
      const fetched = await this.fetchCompletion(
        this.requestBody(),
        deadline,
      );
      deadline.remainingMs();
      const response = redactOpenAICompatibleProviderCredentialV1(
        fetched.body,
        this.apiKey,
      );
      const envelopeResult = providerEnvelopeSchema.safeParse(response);
      if (!envelopeResult.success) {
        this.providerRequests.push(telemetryFromResponse({
          requestedModel: this.requestedModel,
          resolvedModel: this.resolvedModel,
          fetched,
          outcome: 'invalid_response',
        }));
        throw new InternalFileTurnPublicErrorV1(
          'File model provider returned an invalid response envelope',
        );
      }
      const envelope = envelopeResult.data;
      const telemetry = telemetryFromResponse({
        requestedModel: this.requestedModel,
        resolvedModel: this.resolvedModel,
        fetched,
        envelope,
        outcome: 'invalid_response',
      });
      this.providerRequests.push(telemetry);
      const choice = parseExternalFileTurnValueV1(
        providerChoiceSchema,
        envelope.choices[0],
        'File model provider returned an invalid first choice',
      );
      const message = choice.message;
      const calls = message.tool_calls ?? [];
      if (calls.length > 0) {
        assertUniqueAndFreshCallIds(calls, this.seenToolCallIds);
        if (calls.length !== 1) {
          throw new InternalFileTurnPublicErrorV1(
            'File model provider returned multiple parallel tool calls',
          );
        }
        if (toolSteps >= parsed.maxToolSteps) {
          throw new InternalFileTurnPublicErrorV1('File turn tool-step budget exhausted');
        }
        const call = calls[0];
        if (!call) {
          throw new InternalFileTurnPublicErrorV1(
            'File model provider returned no tool call',
          );
        }
        if (!this.availableToolNames.has(call.function.name)) {
          throw new InternalFileTurnPublicErrorV1(
            'File model provider selected an unavailable tool',
          );
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
          deadline,
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
        return parseExternalFileTurnValueV1(fileTurnDecisionV1Schema, {
          type: 'denied',
          reason: refusal,
          toolSteps,
          contactCalls,
        }, 'File model provider returned an invalid turn decision');
      }
      const content = message.content?.trim();
      if (!content) {
        throw new InternalFileTurnPublicErrorV1(
          'File model provider returned no turn decision',
        );
      }
      telemetry.outcome = 'success';
      return parseExternalFileTurnValueV1(fileTurnDecisionV1Schema, {
        type: 'completed',
        content,
        toolSteps,
        contactCalls,
      }, 'File model provider returned an invalid turn decision');
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    for (const deadline of this.activeDeadlines) deadline.close();
    this.activeDeadlines.clear();
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
    deadline: InternalFileTurnDeadlineV1;
    contactCalls: number;
  }): Promise<{ result: JsonValue; contactCalls: number }> {
    const raw = parseToolArguments(input.call.function.arguments);
    const name = input.call.function.name as FileToolNameV1;
    if (name === 'files_list') {
      parseExternalFileTurnValueV1(
        noArgumentsSchema,
        raw,
        'File model provider returned invalid files_list arguments',
      );
      return {
        result: { actorId: input.turn.actorId, paths: [...this.readablePaths] },
        contactCalls: 0,
      };
    }
    if (name === 'files_read') {
      const args = parseExternalFileTurnValueV1(
        readArgumentsSchema,
        raw,
        'File model provider returned invalid files_read arguments',
      );
      if (!this.readablePathSet.has(args.path)) {
        throw new InternalFileTurnPublicErrorV1(
          'File model provider selected an unauthorized logical path',
        );
      }
      input.deadline.remainingMs();
      const loaded = parseExternalFileTurnValueV1(
        fileReadResultSchema,
        await invokeHostOperation(
          () => this.options.workspace.read({
            actorId: input.turn.actorId,
            path: args.path,
            signal: input.deadline.signal,
            deadlineAtMs: input.deadline.deadlineAtMs,
          }),
          'File workspace read failed',
          input.deadline,
        ),
        'File workspace returned an invalid read result',
      );
      input.deadline.remainingMs();
      if (
        loaded.receipt.actorId !== input.turn.actorId
        || loaded.receipt.path !== args.path
      ) {
        throw new InternalFileTurnPublicErrorV1(
          'File workspace returned a mismatched read receipt',
        );
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
        throw new InternalFileTurnPublicErrorV1(
          'MEMORY replacement is not authorized for this file turn',
        );
      }
      const args = parseExternalFileTurnValueV1(
        replaceMemoryArgumentsSchema,
        raw,
        'File model provider returned invalid files_replace_memory arguments',
      );
      if (!this.observedMemoryVersions.has(args.expectedVersion)) {
        throw new InternalFileTurnPublicErrorV1(
          'MEMORY replacement requires the expected version observed by a read in this file turn',
        );
      }
      // A failed or conflicting attempt requires a fresh read. A successful
      // commit receipt below establishes the only new observable version.
      this.observedMemoryVersions.clear();
      input.deadline.remainingMs();
      const replaced = parseExternalFileTurnValueV1(
        replaceMemoryResultSchema,
        await invokeHostOperation(
          () => this.options.workspace.replaceMemory({
            actorId: input.turn.actorId,
            expectedVersion: args.expectedVersion,
            content: args.content,
            signal: input.deadline.signal,
            deadlineAtMs: input.deadline.deadlineAtMs,
          }),
          'File workspace MEMORY replacement failed',
          input.deadline,
        ),
        'File workspace returned an invalid MEMORY replacement result',
      );
      input.deadline.remainingMs();
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
        throw new InternalFileTurnPublicErrorV1(
          'Agent contact is not authorized for this file turn',
        );
      }
      if (input.contactCalls >= input.turn.maxContactCalls) {
        throw new InternalFileTurnPublicErrorV1('File turn contact budget exhausted');
      }
      const args = parseExternalFileTurnValueV1(
        contactArgumentsSchema,
        raw,
        'File model provider returned invalid contact_agent arguments',
      );
      const remaining = input.deadline.remainingMs();
      const contacted = parseExternalFileTurnValueV1(
        contactResultSchema,
        await invokeHostOperation(
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
          input.deadline,
        ),
        'Agent contact returned an invalid result',
      );
      input.deadline.remainingMs();
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
    throw new InternalFileTurnPublicErrorV1(
      'File model provider selected an unavailable tool',
    );
  }

  private async fetchCompletion(
    body: unknown,
    turnDeadline: InternalFileTurnDeadlineV1,
  ): Promise<FetchedCompletion> {
    const timeoutMs = Math.min(
      this.configuredTimeoutMs,
      turnDeadline.remainingMs(),
    );
    const requestDeadline = new InternalFileTurnDeadlineV1(
      timeoutMs,
      `File model provider timed out after ${timeoutMs}ms`,
    );
    this.activeDeadlines.add(requestDeadline);
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
          const fetching = this.fetchImplementation(this.completionUrl, {
            method: 'POST',
            headers: { ...this.authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'manual',
            signal: requestDeadline.signal,
          });
          response = await turnDeadline.settle(
            requestDeadline.settle(
              fetching,
              cancelOpenAICompatibleProviderResponseBodyV1,
            ),
            cancelOpenAICompatibleProviderResponseBodyV1,
          );
        } catch {
          if (turnDeadline.signal.aborted) {
            throw new InternalFileTurnPublicErrorV1(
              'File turn runtime deadline exceeded',
            );
          }
          if (requestDeadline.signal.aborted) {
            throw new InternalFileTurnPublicErrorV1(
              `File model provider timed out after ${timeoutMs}ms`,
            );
          }
          if (attempt < MAX_PROVIDER_ATTEMPTS_V1) {
            await turnDeadline.settle(
              waitForOpenAICompatibleProviderRetryV1(
                openAICompatibleProviderDefaultRetryDelayMsV1(attempt),
                requestDeadline.signal,
                timeoutMs,
                'File model provider',
              ),
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
            await turnDeadline.settle(
              waitForOpenAICompatibleProviderRetryV1(
                delay,
                requestDeadline.signal,
                timeoutMs,
                'File model provider',
              ),
            );
            continue;
          }
          throw new FileProviderRequestErrorV1(
            `File model provider request failed with HTTP ${response.status}`,
            { status: response.status, retryable },
          );
        }
        const responseBody = await turnDeadline.settle(
          readBoundedOpenAICompatibleProviderJsonV1(
            response,
            requestDeadline.signal,
            timeoutMs,
            'File model provider',
          ),
          () => cancelOpenAICompatibleProviderResponseBodyV1(response),
        );
        return {
          body: responseBody,
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
      if (!this.finalized) {
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
      }
      if (error instanceof InternalFileTurnPublicErrorV1) throw error;
      if (error instanceof OpenAICompatibleProviderTransportErrorV1) {
        throw new InternalFileTurnPublicErrorV1(error.message);
      }
      throw new InternalFileTurnPublicErrorV1('File model provider request failed');
    } finally {
      requestDeadline.close();
      this.activeDeadlines.delete(requestDeadline);
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
  const publicMessage = 'File model provider returned malformed tool arguments';
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new InternalFileTurnPublicErrorV1(publicMessage);
  }
  try {
    assertPactJsonComplexityV1(parsed, 'File model tool arguments');
  } catch {
    throw new InternalFileTurnPublicErrorV1(publicMessage);
  }
  return parseExternalFileTurnValueV1(jsonObjectSchema, parsed, publicMessage);
}

function stringifyToolResult(result: JsonValue): string {
  try {
    assertPactJsonComplexityV1(result, 'File model tool result');
  } catch {
    throw new InternalFileTurnPublicErrorV1('File model tool result is invalid');
  }
  const source = JSON.stringify(result);
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_TOOL_RESULT_BYTES_V1) {
    throw new InternalFileTurnPublicErrorV1(
      `File model tool result exceeds ${MAX_FILE_TOOL_RESULT_BYTES_V1} bytes`,
    );
  }
  return source;
}

function assertUniqueAndFreshCallIds(
  calls: ProviderToolCall[],
  seen: ReadonlySet<string>,
): void {
  if (new Set(calls.map(call => call.id)).size !== calls.length) {
    throw new InternalFileTurnPublicErrorV1(
      'File model provider returned duplicate tool-call identifiers',
    );
  }
  if (calls.some(call => seen.has(call.id))) {
    throw new InternalFileTurnPublicErrorV1(
      'File model provider reused a prior tool-call identifier',
    );
  }
}

function parseReasoningDetails(value: unknown[] | null | undefined): JsonValue[] | undefined {
  if (!value || value.length === 0) return undefined;
  return parseExternalFileTurnValueV1(
    z.array(jsonValueSchema),
    value,
    'File model provider returned invalid reasoning details',
  );
}

async function invokeHostOperation<T>(
  operation: () => Promise<T>,
  publicMessage: string,
  deadline: InternalFileTurnDeadlineV1,
): Promise<T> {
  try {
    return await deadline.settle(operation());
  } catch (error) {
    if (deadline.ownsFailure(error)) throw error;
    throw new InternalFileTurnPublicErrorV1(publicMessage);
  }
}

function validateRequestedModel(value: string): string {
  const parsed = z.string().trim().min(1).max(512).safeParse(value);
  if (!parsed.success) {
    throw new InternalFileTurnPublicErrorV1('Requested model identity is invalid');
  }
  return parsed.data;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3_600_000) {
    throw new InternalFileTurnPublicErrorV1(
      'File model timeout must be a positive integer up to 3600000ms',
    );
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
    : { [key]: sumFiniteUsage(values) } as Partial<Record<K, number>>;
}

function sumFiniteUsage(values: number[]): number {
  let total = 0;
  for (const value of values) {
    const next = total + value;
    total = Number.isFinite(next) ? next : Number.MAX_VALUE;
  }
  return total;
}
