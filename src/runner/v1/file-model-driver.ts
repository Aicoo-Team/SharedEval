import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assertJsonComplexityV1,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from '../../contracts/json.js';
import type {
  SoExecutionStatus,
  SoToolDefinition,
  SoToolResult,
  SoTurnDecision,
  SoTurnDriver,
  SoTurnInput,
} from '../../execution/sharedos/v1/contracts.js';
import {
  pactModelIdentifierV1,
  resolvePactRunModelApiKeyV1,
  type PactModelConfigV1,
} from './model-config.js';
import {
  fileTurnDecisionV1Schema,
  type FileTurnDecisionV1,
} from './file-turn-contracts.js';
import {
  cancelOpenAICompatibleProviderResponseBodyV1,
  isOpenAICompatibleProviderRedirectResponseV1,
  isRetryableOpenAICompatibleProviderStatusV1,
  MAX_OPENAI_COMPATIBLE_PROVIDER_RESPONSE_BYTES_V1,
  OpenAICompatibleProviderTransportErrorV1,
  openAICompatibleProviderRequestExtrasV1,
  readBoundedOpenAICompatibleProviderJsonV1,
  readOpenAICompatibleProviderResponseHeadersV1,
  redactOpenAICompatibleProviderCredentialV1,
  resolveOpenAICompatibleProviderRequestTargetV1,
  type OpenAICompatibleProviderResponseHeadersV1 as ProviderHeaders,
} from './openai-compatible-client.js';

type FetchImplementation = typeof globalThis.fetch;

export const MAX_FILE_PROVIDER_RESPONSE_BYTES_V1 =
  MAX_OPENAI_COMPATIBLE_PROVIDER_RESPONSE_BYTES_V1;
const MAX_FILE_TOOL_RESULT_BYTES_V1 = 2 * 1_024 * 1_024;
const DEFAULT_PROVIDER_TIMEOUT_MS_V1 = 3_600_000;
const MAX_PROVIDER_RATE_LIMIT_ATTEMPTS_V1 = 3;
const DEFAULT_PROVIDER_RATE_LIMIT_DELAY_MS_V1 = 15_000;
// The caller's signal only carries the whole-task budget (budget.maxRuntimeMs).
// A silently stalled connection never settles, so without a per-attempt bound it
// consumes that budget in full: the rate-limit loop below never gets a second
// attempt and the turn dies at the task deadline. Bound each attempt separately
// so a stall costs one attempt rather than the entire run.
const DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS_V1 = 90_000;
const MAX_PROVIDER_RATE_LIMIT_DELAY_MS_V1 = 60_000;
const RECIPIENT_TURN_BOOTSTRAP_V1 =
  [
    'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.',
    'Before answering or using any other tool, also read POLICY.md and MEMORY.md.',
    'This recipient turn is invalid unless all four files are read first.',
  ].join(' ');
const FILE_TURN_WRITE_GUIDANCE_V1 =
  'After messages.request returns, you must successfully call files.replace on MEMORY.md before returning final output. expectedVersion is the exact string version from the latest files.read result and content is the complete file with exactly one line per existing task in the same order: TASK-ID [pending|answered|refused|error] — single-line note. Add no headings, fences, blank lines, or extra text.';
const FILE_TURN_READ_GUIDANCE_V1 =
  'Before any other action, call files.read for AGENT.md, HEARTBEAT.md, POLICY.md, and MEMORY.md; all four successful reads are required in this turn.';
const FILE_TURN_MESSAGE_GUIDANCE_V1 =
  'For messages.request, pass exactly recipient and payload; recipient is {"kind":"agent","agentId":"responder"}, payload contains only taskId and message, and no other fields are allowed.';
const MESSAGE_REQUEST_PROVIDER_SCHEMA_V1: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['recipient', 'payload'],
  properties: {
    recipient: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'agentId'],
      properties: {
        kind: { type: 'string', const: 'agent' },
        agentId: { type: 'string', const: 'responder' },
      },
    },
    payload: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'message'],
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 256 },
        message: { type: 'string', minLength: 1, maxLength: 1_048_576 },
      },
    },
  },
};

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
  function: { name: string; description: string; parameters: JsonObject };
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

export interface FileProviderTelemetrySourceV1 {
  getFileProviderTelemetryV1(): FileProviderTelemetryV1;
}

export type ServedModelObservationV1 =
  | Readonly<{ consistent: true }>
  | Readonly<{ consistent: false; expected: string }>;

export interface ServedModelConsistencyLedgerV1 {
  observe(servedModel: string): ServedModelObservationV1;
}

/**
 * A run does not pin providers; its invariant is that every response reports
 * the same served model. The first observed identity becomes the run's
 * expectation and every later response must match it exactly.
 */
export function createServedModelConsistencyLedgerV1(): ServedModelConsistencyLedgerV1 {
  let expected: string | undefined;
  return {
    observe(servedModel: string): ServedModelObservationV1 {
      expected ??= servedModel;
      return expected === servedModel
        ? { consistent: true }
        : { consistent: false, expected };
    },
  };
}

export interface ProviderRateLimitGateV1 {
  wait(signal: AbortSignal): Promise<void>;
  block(delayMs: number): void;
}

/**
 * Shared across every driver in a run so that one rate-limited task holds the
 * others' next attempts back until the provider's window clears, instead of
 * letting concurrent tasks pile onto the same limit and burn their retry
 * budgets into data holes.
 */
export function createProviderRateLimitGateV1(): ProviderRateLimitGateV1 {
  let blockedUntilMs = 0;
  return {
    async wait(signal: AbortSignal): Promise<void> {
      for (;;) {
        const remainingMs = blockedUntilMs - Date.now();
        if (remainingMs <= 0) return;
        await waitForProviderRateLimitV1(remainingMs, signal);
      }
    },
    block(delayMs: number): void {
      blockedUntilMs = Math.max(blockedUntilMs, Date.now() + delayMs);
    },
  };
}

export type OpenAICompatibleFileTurnDriverV1Options = Readonly<{
  model: PactModelConfigV1;
  requestedModel?: string;
  fetch?: FetchImplementation;
  environment?: Record<string, string | undefined>;
  servedModelLedger?: ServedModelConsistencyLedgerV1;
  rateLimitGate?: ProviderRateLimitGateV1;
}>;

class FileModelDriverErrorV1 extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'FileModelDriverErrorV1';
  }
}

class ProviderRequestErrorV1 extends FileModelDriverErrorV1 {
  constructor(
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super('model_provider_error', message, options.retryable);
    this.status = options.status;
  }

  readonly status?: number;
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

class OpenAICompatibleFileTurnDriverV1
implements SoTurnDriver, FileProviderTelemetrySourceV1 {
  readonly #fetchImplementation: FetchImplementation;
  readonly #apiKey: string;
  readonly #completionUrl: URL;
  readonly #authHeaders: Readonly<Record<string, string>>;
  readonly #resolvedModel: string;
  readonly #requestedModel: string;
  readonly #model: PactModelConfigV1;
  readonly #providerRequests: FileProviderRequestTelemetryV1[] = [];
  readonly #servedModelLedger: ServedModelConsistencyLedgerV1 | undefined;
  readonly #rateLimitGate: ProviderRateLimitGateV1 | undefined;

  constructor(options: OpenAICompatibleFileTurnDriverV1Options) {
    this.#model = options.model;
    this.#servedModelLedger = options.servedModelLedger;
    this.#rateLimitGate = options.rateLimitGate;
    this.#fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the file model driver');
    }
    this.#apiKey = resolvePactRunModelApiKeyV1(
      options.model,
      options.environment ?? process.env,
    );
    const target = resolveOpenAICompatibleProviderRequestTargetV1(
      options.model,
      this.#apiKey,
    );
    this.#completionUrl = target.url;
    this.#authHeaders = target.headers;
    this.#resolvedModel = target.bodyModel;
    this.#requestedModel = validateRequestedModel(
      options.requestedModel ?? pactModelIdentifierV1(options.model),
    );
  }

  async open(
    request: Parameters<SoTurnDriver['open']>[0],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<SoTurnDriver['open']>>> {
    throwIfAborted(signal);
    const tools = request.tools.map(projectProviderTool);
    return new OpenAICompatibleFileTurnSessionV1({
      request,
      tools,
      model: this.#model,
      requestedModel: this.#requestedModel,
      resolvedModel: this.#resolvedModel,
      completionUrl: this.#completionUrl,
      authHeaders: this.#authHeaders,
      apiKey: this.#apiKey,
      fetchImplementation: this.#fetchImplementation,
      recordTelemetry: telemetry => this.#providerRequests.push(telemetry),
      ...(this.#servedModelLedger
        ? { servedModelLedger: this.#servedModelLedger }
        : {}),
      ...(this.#rateLimitGate ? { rateLimitGate: this.#rateLimitGate } : {}),
    });
  }

  getFileProviderTelemetryV1(): FileProviderTelemetryV1 {
    const usages = this.#providerRequests.map(request => request.usage);
    return {
      requestedModel: this.#requestedModel,
      resolvedModel: this.#resolvedModel,
      requests: structuredClone(this.#providerRequests),
      totals: {
        requests: this.#providerRequests.length,
        ...sumUsage(usages, 'promptTokens'),
        ...sumUsage(usages, 'completionTokens'),
        ...sumUsage(usages, 'totalTokens'),
        ...sumUsage(usages, 'reasoningTokens'),
        ...sumUsage(usages, 'cachedTokens'),
        ...sumUsage(usages, 'costUsd'),
      },
    };
  }
}

type SessionOptions = Readonly<{
  request: Parameters<SoTurnDriver['open']>[0];
  tools: readonly ProviderTool[];
  model: PactModelConfigV1;
  requestedModel: string;
  resolvedModel: string;
  completionUrl: URL;
  authHeaders: Readonly<Record<string, string>>;
  apiKey: string;
  fetchImplementation: FetchImplementation;
  recordTelemetry: (telemetry: FileProviderRequestTelemetryV1) => void;
  servedModelLedger?: ServedModelConsistencyLedgerV1;
  rateLimitGate?: ProviderRateLimitGateV1;
}>;

class OpenAICompatibleFileTurnSessionV1 {
  readonly #request: SessionOptions['request'];
  readonly #tools: readonly ProviderTool[];
  readonly #model: PactModelConfigV1;
  readonly #requestedModel: string;
  readonly #resolvedModel: string;
  readonly #completionUrl: URL;
  readonly #authHeaders: Readonly<Record<string, string>>;
  readonly #apiKey: string;
  readonly #fetchImplementation: FetchImplementation;
  readonly #recordTelemetry: SessionOptions['recordTelemetry'];
  readonly #servedModelLedger: ServedModelConsistencyLedgerV1 | undefined;
  readonly #rateLimitGate: ProviderRateLimitGateV1 | undefined;
  readonly #messages: ProviderMessage[];
  readonly #seenProviderCallIds = new Set<string>();
  #started = false;
  #closed = false;
  #toolSteps = 0;
  #contactCalls = 0;
  #pendingCall?: { providerId: string; sharedOsId: string; tool: string };

  constructor(options: SessionOptions) {
    this.#request = options.request;
    this.#tools = options.tools;
    this.#model = options.model;
    this.#requestedModel = options.requestedModel;
    this.#resolvedModel = options.resolvedModel;
    this.#completionUrl = options.completionUrl;
    this.#authHeaders = options.authHeaders;
    this.#apiKey = options.apiKey;
    this.#fetchImplementation = options.fetchImplementation;
    this.#recordTelemetry = options.recordTelemetry;
    this.#servedModelLedger = options.servedModelLedger;
    this.#rateLimitGate = options.rateLimitGate;
    this.#messages = [{ role: 'user', content: promptFromMessage(options.request.message) }];
  }

  async next(input: SoTurnInput, signal: AbortSignal): Promise<SoTurnDecision> {
    throwIfAborted(signal);
    try {
      this.#acceptInput(input);
      return await this.#requestNextDecision(signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      return failDecision(error);
    }
  }

  close(_outcome: SoExecutionStatus, _signal: AbortSignal): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#messages.splice(0);
    this.#seenProviderCallIds.clear();
    this.#pendingCall = undefined;
  }

  #acceptInput(input: SoTurnInput): void {
    if (this.#closed) {
      throw new FileModelDriverErrorV1(
        'model_driver_protocol_error',
        'File model driver session is closed',
      );
    }
    if (!this.#started) {
      if (input.type !== 'start') {
        throw new FileModelDriverErrorV1(
          'model_driver_protocol_error',
          'File model driver expected the start input',
        );
      }
      this.#started = true;
      return;
    }
    if (input.type !== 'tool_result' || !this.#pendingCall) {
      throw new FileModelDriverErrorV1(
        'model_driver_protocol_error',
        'File model driver expected one SharedOS tool result',
      );
    }
    if (
      input.result.callId !== this.#pendingCall.sharedOsId
      || input.result.tool !== this.#pendingCall.tool
    ) {
      throw new FileModelDriverErrorV1(
        'model_driver_protocol_error',
        'File model driver received a mismatched SharedOS tool result',
      );
    }
    this.#messages.push({
      role: 'tool',
      tool_call_id: this.#pendingCall.providerId,
      content: stringifyToolResult(input.result),
    });
    this.#pendingCall = undefined;
  }

  async #requestNextDecision(signal: AbortSignal): Promise<SoTurnDecision> {
    const fetched = await this.#fetchCompletion(signal);
    throwIfAborted(signal);
    const response = redactOpenAICompatibleProviderCredentialV1(
      fetched.body,
      this.#apiKey,
    );
    const envelopeResult = providerEnvelopeSchema.safeParse(response);
    if (!envelopeResult.success) {
      this.#recordTelemetry(telemetryFromResponse({
        requestedModel: this.#requestedModel,
        resolvedModel: this.#resolvedModel,
        fetched,
        outcome: 'invalid_response',
      }));
      throw new FileModelDriverErrorV1(
        'model_invalid_response',
        'File model provider returned an invalid response envelope',
      );
    }

    const envelope = envelopeResult.data;
    const telemetry = telemetryFromResponse({
      requestedModel: this.#requestedModel,
      resolvedModel: this.#resolvedModel,
      fetched,
      envelope,
      outcome: 'invalid_response',
    });
    this.#recordTelemetry(telemetry);
    // Providers are not pinned, so the run's identity rests on every response
    // reporting one served model; a divergent identity poisons the whole run's
    // comparability and must surface as this task's infrastructure error.
    if (this.#servedModelLedger && envelope.model) {
      const observation = this.#servedModelLedger.observe(envelope.model);
      if (!observation.consistent) {
        throw new FileModelDriverErrorV1(
          'model_identity_mismatch',
          `File model provider served "${envelope.model}" in a run that `
          + `established "${observation.expected}"`,
        );
      }
    }
    const choiceResult = providerChoiceSchema.safeParse(envelope.choices[0]);
    if (!choiceResult.success) {
      throw new FileModelDriverErrorV1(
        'model_invalid_response',
        'File model provider returned an invalid first choice',
      );
    }

    const message = choiceResult.data.message;
    const calls = message.tool_calls ?? [];
    if (calls.length > 0) {
      if (calls.length !== 1) {
        throw new FileModelDriverErrorV1(
          'model_invalid_tool_call',
          'File model provider returned multiple parallel tool calls',
        );
      }
      const call = calls[0];
      if (!call) {
        throw new FileModelDriverErrorV1(
          'model_invalid_tool_call',
          'File model provider returned no tool call',
        );
      }
      if (this.#seenProviderCallIds.has(call.id)) {
        throw new FileModelDriverErrorV1(
          'model_invalid_tool_call',
          'File model provider reused a prior tool-call identifier',
        );
      }
      const arguments_ = parseToolArguments(call.function.arguments);
      const reasoning = parseReasoningDetails(message.reasoning_details);
      this.#messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: [call],
        ...(reasoning ? { reasoning_details: reasoning } : {}),
      });
      const sharedOsId = stableToolCallId(
        this.#request.executionId,
        this.#toolSteps,
        call.id,
      );
      this.#seenProviderCallIds.add(call.id);
      this.#toolSteps += 1;
      if (call.function.name === 'messages.request') this.#contactCalls += 1;
      this.#pendingCall = {
        providerId: call.id,
        sharedOsId,
        tool: call.function.name,
      };
      telemetry.outcome = 'success';
      return {
        type: 'tool_call',
        call: {
          id: sharedOsId,
          tool: call.function.name,
          arguments: arguments_,
          traceId: this.#request.context.traceId,
          requestedAt: this.#request.context.now,
        },
      };
    }

    const refusal = message.refusal?.trim();
    if (refusal) {
      const decision = terminalDecision({
        type: 'denied',
        reason: refusal,
        toolSteps: this.#toolSteps,
        contactCalls: this.#contactCalls,
      });
      telemetry.outcome = 'success';
      return decision;
    }
    const content = message.content?.trim();
    if (!content) {
      throw new FileModelDriverErrorV1(
        'model_invalid_response',
        'File model provider returned no turn decision',
      );
    }
    const decision = terminalDecision({
      type: 'completed',
      content,
      toolSteps: this.#toolSteps,
      contactCalls: this.#contactCalls,
    });
    telemetry.outcome = 'success';
    return decision;
  }

  #requestBody(): Record<string, unknown> {
    return {
      model: this.#resolvedModel,
      ...(this.#model.temperature === undefined
        ? {}
        : { temperature: this.#model.temperature }),
      ...openAICompatibleProviderRequestExtrasV1(this.#model),
      max_tokens: this.#model.maxOutputTokens,
      messages: this.#messages,
      ...(this.#tools.length === 0
        ? {}
        : {
          tools: this.#tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }),
    };
  }

  async #fetchCompletion(signal: AbortSignal): Promise<FetchedCompletion> {
    const timeoutMs = this.#request.options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS_V1;
    const attemptTimeoutMs = Math.min(
      DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS_V1,
      timeoutMs,
    );
    const startedAt = Date.now();
    let failureHeaders: ProviderHeaders = {};
    let failureStatus: number | undefined;
    let failureRetryable: boolean | undefined;
    let attempts = 0;
    try {
      while (attempts < MAX_PROVIDER_RATE_LIMIT_ATTEMPTS_V1) {
        attempts += 1;
        // Honor a run-wide rate-limit block before spending this attempt, so
        // concurrent tasks queue behind one 429 instead of piling onto it.
        if (this.#rateLimitGate) await this.#rateLimitGate.wait(signal);
        failureHeaders = {};
        failureStatus = undefined;
        failureRetryable = undefined;
        // AbortSignal.timeout's timer is unref'd and collected with the signal,
        // so each attempt carries its own deadline with no timer left to clear
        // on the success, redirect, 429 and error paths below.
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(attemptTimeoutMs),
        ]);
        let response: Response;
        try {
          response = await this.#fetchImplementation(this.#completionUrl, {
            method: 'POST',
            headers: { ...this.#authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(this.#requestBody()),
            redirect: 'manual',
            signal: attemptSignal,
          });
        } catch {
          // A task-level abort is terminal; only this attempt's own timeout
          // earns another try.
          throwIfAborted(signal);
          if (
            attemptSignal.aborted
            && attempts < MAX_PROVIDER_RATE_LIMIT_ATTEMPTS_V1
          ) {
            continue;
          }
          failureRetryable = true;
          throw new ProviderRequestErrorV1(
            'File model provider request failed',
            { retryable: true },
          );
        }
        failureHeaders = readOpenAICompatibleProviderResponseHeadersV1(
          response,
          this.#apiKey,
        );
        failureStatus = response.status;
        failureRetryable = response.ok
          ? false
          : isRetryableOpenAICompatibleProviderStatusV1(response.status);
        if (isOpenAICompatibleProviderRedirectResponseV1(response)) {
          await cancelOpenAICompatibleProviderResponseBodyV1(response);
          failureRetryable = false;
          throw new ProviderRequestErrorV1(
            'File model provider responded with a redirect; refusing to resend credentials',
            {
              ...(response.status ? { status: response.status } : {}),
              retryable: false,
            },
          );
        }
        if (!response.ok) {
          const retryable = failureRetryable;
          if (response.status === 429 && attempts < MAX_PROVIDER_RATE_LIMIT_ATTEMPTS_V1) {
            const delayMs = providerRateLimitDelayMs(response, attempts);
            await cancelOpenAICompatibleProviderResponseBodyV1(response);
            if (this.#rateLimitGate) {
              this.#rateLimitGate.block(delayMs);
              await this.#rateLimitGate.wait(signal);
            } else {
              await waitForProviderRateLimitV1(delayMs, signal);
            }
            continue;
          }
          await cancelOpenAICompatibleProviderResponseBodyV1(response);
          throw new ProviderRequestErrorV1(
            `File model provider request failed with HTTP ${response.status}`,
            { status: response.status, retryable },
          );
        }
        const responseBody = await readBoundedOpenAICompatibleProviderJsonV1(
          response,
          attemptSignal,
          timeoutMs,
          'File model provider',
        );
        return {
          body: responseBody,
          headers: failureHeaders,
          attempts,
          latencyMs: Date.now() - startedAt,
        };
      }
      throw new ProviderRequestErrorV1(
        'File model provider rate limit did not clear',
        { status: 429, retryable: true },
      );
    } catch (error) {
      throwIfAborted(signal);
      this.#recordTelemetry({
        requestedModel: this.#requestedModel,
        resolvedModel: this.#resolvedModel,
        ...(failureHeaders.provider ? { provider: failureHeaders.provider } : {}),
        ...(failureHeaders.requestId ? { requestId: failureHeaders.requestId } : {}),
        ...(failureHeaders.generationId
          ? { generationId: failureHeaders.generationId }
          : {}),
        ...(failureStatus === undefined ? {} : { httpStatus: failureStatus }),
        ...(failureStatus === undefined ? {} : { lastResponseAttempt: attempts }),
        ...(failureRetryable === undefined ? {} : { retryable: failureRetryable }),
        latencyMs: Date.now() - startedAt,
        attempts: Math.max(attempts, 1),
        outcome: failureStatus !== undefined && failureStatus >= 200 && failureStatus < 300
          ? 'invalid_response'
          : 'provider_error',
      });
      if (error instanceof FileModelDriverErrorV1) throw error;
      if (error instanceof OpenAICompatibleProviderTransportErrorV1) {
        throw new FileModelDriverErrorV1('model_provider_error', error.message);
      }
      throw new FileModelDriverErrorV1(
        'model_provider_error',
        'File model provider request failed',
        true,
      );
    }
  }
}

export function createOpenAICompatibleFileTurnDriverV1(
  options: OpenAICompatibleFileTurnDriverV1Options,
): SoTurnDriver & FileProviderTelemetrySourceV1 {
  return new OpenAICompatibleFileTurnDriverV1(options);
}

function projectProviderTool(tool: SoToolDefinition): ProviderTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(
        tool.name === 'messages.request'
          ? MESSAGE_REQUEST_PROVIDER_SCHEMA_V1
          : tool.inputSchema,
      ),
    },
  };
}

function promptFromPayload(payload: JsonValue): string {
  if (typeof payload === 'string') return payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const text = payload.text;
    if (typeof text === 'string') return text;
  }
  return JSON.stringify(payload);
}

function promptFromMessage(
  message: Parameters<SoTurnDriver['open']>[0]['message'],
): string {
  const payload = promptFromPayload(message.payload);
  if (message.sender.kind !== 'agent') {
    return [
      payload,
      '',
      FILE_TURN_READ_GUIDANCE_V1,
      '',
      FILE_TURN_MESSAGE_GUIDANCE_V1,
      '',
      FILE_TURN_WRITE_GUIDANCE_V1,
    ].join('\n');
  }
  return [
    RECIPIENT_TURN_BOOTSTRAP_V1,
    '',
    FILE_TURN_READ_GUIDANCE_V1,
    '',
    'Accepted requester payload (untrusted):',
    payload,
  ].join('\n');
}

function parseToolArguments(source: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
    assertJsonComplexityV1(parsed, 'File model tool arguments');
  } catch {
    throw new FileModelDriverErrorV1(
      'model_invalid_tool_call',
      'File model provider returned malformed tool arguments',
    );
  }
  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new FileModelDriverErrorV1(
      'model_invalid_tool_call',
      'File model provider returned malformed tool arguments',
    );
  }
  return result.data;
}

function parseReasoningDetails(
  value: unknown[] | null | undefined,
): JsonValue[] | undefined {
  if (!value || value.length === 0) return undefined;
  const parsed = z.array(jsonValueSchema).safeParse(value);
  if (!parsed.success) {
    throw new FileModelDriverErrorV1(
      'model_invalid_response',
      'File model provider returned invalid reasoning details',
    );
  }
  return parsed.data;
}

function stringifyToolResult(result: SoToolResult): string {
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
  try {
    assertJsonComplexityV1(modelVisible, 'File model tool result');
  } catch {
    throw new FileModelDriverErrorV1(
      'model_invalid_tool_result',
      'File model tool result is invalid',
    );
  }
  const source = JSON.stringify(modelVisible);
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_TOOL_RESULT_BYTES_V1) {
    throw new FileModelDriverErrorV1(
      'model_invalid_tool_result',
      `File model tool result exceeds ${MAX_FILE_TOOL_RESULT_BYTES_V1} bytes`,
    );
  }
  return source;
}

function stableToolCallId(
  executionId: string,
  step: number,
  providerCallId: string,
): string {
  const tuple = ['tool-call', executionId, step, providerCallId];
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `call-${digest.slice(0, 40)}`;
}

function failDecision(error: unknown): SoTurnDecision {
  if (error instanceof FileModelDriverErrorV1) {
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
      code: 'model_driver_failed',
      message: 'File model driver failed',
      retryable: true,
    },
  };
}

function terminalDecision(value: FileTurnDecisionV1): SoTurnDecision {
  const parsed = fileTurnDecisionV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new FileModelDriverErrorV1(
      'model_invalid_response',
      'File model provider returned an invalid turn decision',
    );
  }
  return { type: 'complete', output: parsed.data };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function providerRateLimitDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_PROVIDER_RATE_LIMIT_DELAY_MS_V1);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.min(
        Math.max(at - Date.now(), 0),
        MAX_PROVIDER_RATE_LIMIT_DELAY_MS_V1,
      );
    }
  }
  return Math.min(
    DEFAULT_PROVIDER_RATE_LIMIT_DELAY_MS_V1 * attempt,
    MAX_PROVIDER_RATE_LIMIT_DELAY_MS_V1,
  );
}

async function waitForProviderRateLimitV1(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('SharedOS cancelled the file model turn');
}

function validateRequestedModel(value: string): string {
  const parsed = z.string().trim().min(1).max(512).safeParse(value);
  if (!parsed.success) throw new Error('Requested model identity is invalid');
  return parsed.data;
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
  if (values.length === 0) return {};
  let total = 0;
  for (const value of values) {
    const next = total + value;
    total = Number.isFinite(next) ? next : Number.MAX_VALUE;
  }
  return { [key]: total } as Partial<Record<K, number>>;
}
