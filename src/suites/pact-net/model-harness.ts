import { z } from 'zod';
import {
  assertPactJsonComplexityV1,
  jsonObjectSchema,
  jsonValueSchema,
  pactDecisionV1Schema,
  type JsonObject,
  type JsonValue,
  type PactDecisionV1,
  type PactTaskIntroV1,
  type PactToolSpecV1,
} from '../../protocol/v1/index.js';
import {
  pactModelIdentifierV1,
  resolvePactRunModelApiKeyV1,
  type PactModelConfigV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import {
  MAX_PACT_PROVIDER_RESPONSE_BYTES_V1,
  PactProviderRequestErrorV1,
  type PactProviderRequestTelemetryV1,
  type PactProviderTelemetryV1,
  type PactProviderUsageV1,
} from '../../runner/v1/model-adapter.js';
import { PACT_TERMINAL_TOOL_NAMES_V1 } from '../pact-pair/prompt.js';
import type {
  PactNetHarnessFactoryV1,
  PactNetHarnessV1,
  PactNetObservationV1,
} from './environment.js';
import { buildPactNetSystemPromptV1, buildPactNetTaskMessageV1 } from './prompt.js';
import { requirePactNetPolicyV1 } from './task-loader.js';
import { PACT_NET_TOOL_SPECS_V1 } from './tools.js';

/**
 * OpenAI-compatible model harness for PACT-Net (`openai-compatible` and
 * `azure-openai` providers — the PACT-Pair support surface).
 *
 * The Pair model adapter (`src/runner/v1/model-adapter.ts`) implements the
 * Pair adapter protocol (initialize/planBoundary lifecycle, Pair prompts,
 * `grantedAccess` observations), so it cannot back the suite-private
 * `PactNetHarnessV1` step contract directly, and its provider HTTP client is
 * not exported. This file therefore reuses the Pair adapter's exported
 * generics (`PactProviderRequestErrorV1`, response-size bound, telemetry
 * types) and re-implements the transport with the same semantics: identical
 * retry/backoff policy, redirect refusal (never resend the credential),
 * bounded response reads, credential redaction, `tool_choice` handling, and
 * byte-identical error strings — so watch_runs failure classification treats
 * both suites uniformly. Extracting one shared provider client is a tracked
 * follow-up that requires touching the Pair-owned module.
 *
 * Credential handling matches Pair: the config names only the dedicated env
 * alias (`apiKeyEnv`), the value is resolved at construction and used solely
 * in the request Authorization/api-key header — it is never serialized into
 * request bodies, decisions, traces, or artifacts, and any provider response
 * echoing it is redacted before parsing.
 */

type FetchImplementation = typeof globalThis.fetch;

const MAX_PROVIDER_ATTEMPTS_V1 = 8;
const MAX_PROVIDER_RETRY_DELAY_MS_V1 = 30_000;

export type PactNetModelHarnessV1Options = {
  fetch?: FetchImplementation;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
};

type OpenAICompatibleToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAICompatibleMessage =
  | { role: 'system' | 'user'; content: string }
  | {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAICompatibleToolCall[];
    reasoning_details?: JsonValue[];
  }
  | { role: 'tool'; tool_call_id: string; content: string };

type OpenAICompatibleTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
};

const providerToolCallSchema = z
  .object({
    id: z.string().min(1).max(512),
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1).max(128),
        arguments: z.string().max(1_048_576),
      })
      .passthrough(),
  })
  .passthrough();

const providerEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(512).nullish(),
    model: z.string().min(1).max(512).nullish(),
    provider: z.string().min(1).max(512).nullish(),
    usage: z.unknown().optional(),
    choices: z.array(z.unknown()).min(1).max(128),
  })
  .passthrough();

const providerChoiceSchema = z
  .object({
    message: z
      .object({
        content: z.string().nullable().optional(),
        refusal: z.string().nullable().optional(),
        tool_calls: z.array(providerToolCallSchema).max(128).nullish(),
        reasoning_details: z.array(z.unknown()).max(256).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const nonnegativeFiniteNumberSchema = z.number().finite().nonnegative();

const providerUsageSchema = z
  .object({
    prompt_tokens: nonnegativeFiniteNumberSchema.nullish(),
    completion_tokens: nonnegativeFiniteNumberSchema.nullish(),
    total_tokens: nonnegativeFiniteNumberSchema.nullish(),
    cost: nonnegativeFiniteNumberSchema.nullish(),
    prompt_tokens_details: z
      .object({
        cached_tokens: nonnegativeFiniteNumberSchema.nullish(),
      })
      .passthrough()
      .nullish(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: nonnegativeFiniteNumberSchema.nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

type ProviderResponseHeadersV1 = {
  requestId?: string;
  generationId?: string;
  provider?: string;
};

type FetchedProviderCompletionV1 = {
  body: unknown;
  headers: ProviderResponseHeadersV1;
  attempts: number;
  latencyMs: number;
};

const terminalReasonSchema = z.object({ reason: z.string().trim().min(1).max(4_096) }).strict();
const terminalAnswerSchema = z.object({ content: z.string().trim().min(1).max(65_536) }).strict();
const terminalToolNames = new Set<string>(PACT_TERMINAL_TOOL_NAMES_V1);
const runnerToolNames = new Set(PACT_NET_TOOL_SPECS_V1.map(tool => tool.name));

export class OpenAICompatiblePactNetHarnessV1 implements PactNetHarnessV1 {
  private readonly fetchImplementation: FetchImplementation;
  private readonly apiKey: string;
  private readonly completionUrl: URL;
  private readonly authHeaders: Readonly<Record<string, string>>;
  private readonly requestModel: string;
  private readonly configuredTimeoutMs: number;
  private requestTimeoutMs: number;
  private messages: OpenAICompatibleMessage[] = [];
  private pendingToolCalls: OpenAICompatibleToolCall[] = [];
  private providerRequests: PactProviderRequestTelemetryV1[] = [];

  constructor(
    private readonly config: PactRunConfigV1,
    private readonly publicTask: PactTaskIntroV1,
    options: PactNetModelHarnessV1Options = {},
  ) {
    for (const spec of PACT_NET_TOOL_SPECS_V1) {
      if (terminalToolNames.has(spec.name)) {
        throw new Error(`Runner tool name is reserved: ${spec.name}`);
      }
    }
    requirePactNetPolicyV1(config.benchmark.policy);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the model adapter');
    }
    this.apiKey = resolvePactRunModelApiKeyV1(
      config,
      options.environment ?? process.env,
    );
    const target = resolveProviderRequestTargetV1(config.model, this.apiKey);
    this.completionUrl = target.url;
    this.authHeaders = target.headers;
    this.requestModel = target.bodyModel;
    this.configuredTimeoutMs = validateTimeout(
      options.timeoutMs ?? config.budget.maxRuntimeMs,
    );
    this.requestTimeoutMs = this.configuredTimeoutMs;
  }

  async step(observation: PactNetObservationV1): Promise<PactDecisionV1> {
    this.requestTimeoutMs = Math.max(
      1,
      Math.min(this.configuredTimeoutMs, observation.budgetRemaining.runtimeMs),
    );

    if (observation.type === 'task') {
      if (observation.task.taskId !== this.publicTask.taskId) {
        throw new Error(
          `Model harness was created for task ${this.publicTask.taskId} but observed ${observation.task.taskId}`,
        );
      }
      this.pendingToolCalls = [];
      this.messages = [
        {
          role: 'system',
          content: buildPactNetSystemPromptV1({
            policy: requirePactNetPolicyV1(this.config.benchmark.policy),
            task: observation.task,
          }),
        },
        {
          role: 'user',
          content: [
            buildPactNetTaskMessageV1(observation.task),
            `Budget remaining: ${JSON.stringify(observation.budgetRemaining)}`,
          ].join('\n'),
        },
      ];
    } else {
      this.appendToolResult(observation);
      const queuedCall = this.pendingToolCalls[0];
      if (queuedCall) {
        return this.decisionFromToolCall(queuedCall, false);
      }
    }

    return this.requestDecision();
  }

  finalize(): void {
    this.pendingToolCalls = [];
    this.messages = [];
  }

  getProviderTelemetryV1(): PactProviderTelemetryV1 {
    const usage = this.providerRequests.map(request => request.usage);
    return {
      requestedModel: this.requestModel,
      requests: structuredClone(this.providerRequests),
      totals: {
        requests: this.providerRequests.length,
        ...sumOptionalUsage(usage, 'promptTokens'),
        ...sumOptionalUsage(usage, 'completionTokens'),
        ...sumOptionalUsage(usage, 'totalTokens'),
        ...sumOptionalUsage(usage, 'reasoningTokens'),
        ...sumOptionalUsage(usage, 'cachedTokens'),
        ...sumOptionalUsage(usage, 'costUsd'),
      },
    };
  }

  private appendToolResult(
    observation: Extract<PactNetObservationV1, { type: 'tool_result' }>,
  ): void {
    const pending = this.pendingToolCalls[0];
    if (!pending || pending.function.name !== observation.toolName) {
      throw new Error('Tool result does not match the model adapter pending call');
    }
    this.messages.push({
      role: 'tool',
      tool_call_id: pending.id,
      content: JSON.stringify({
        isError: observation.isError,
        output: observation.output,
        budgetRemaining: observation.budgetRemaining,
      }),
    });
    this.pendingToolCalls.shift();
  }

  private async requestDecision(): Promise<PactDecisionV1> {
    const fetched = await this.fetchCompletion({
      model: this.requestModel,
      ...(this.config.model.temperature === undefined
        ? {}
        : { temperature: this.config.model.temperature }),
      ...openAICompatibleRequestExtrasV1(this.config.model),
      max_tokens: this.config.model.maxOutputTokens,
      messages: this.messages,
      tools: [
        ...PACT_NET_TOOL_SPECS_V1.map(toProviderTool),
        ...terminalTools(),
      ],
      tool_choice: 'auto',
    });
    const response = redactProviderCredential(fetched.body, this.apiKey);

    const parsedEnvelope = providerEnvelopeSchema.safeParse(response);
    if (!parsedEnvelope.success) {
      this.providerRequests.push(providerTelemetryFromResponse({
        requestedModel: this.requestModel,
        fetched,
        outcome: 'invalid_response',
      }));
      throw new Error(
        `OpenAI-compatible provider returned an invalid response envelope: ${
          summarizeProviderSchemaIssues(parsedEnvelope.error)
        }`,
      );
    }

    const telemetry = providerTelemetryFromResponse({
      requestedModel: this.requestModel,
      fetched,
      envelope: parsedEnvelope.data,
      outcome: 'invalid_response',
    });
    this.providerRequests.push(telemetry);

    const parsedChoice = providerChoiceSchema.safeParse(
      parsedEnvelope.data.choices[0],
    );
    if (!parsedChoice.success) {
      throw new Error(
        `OpenAI-compatible provider returned an invalid first choice: ${
          summarizeProviderSchemaIssues(parsedChoice.error)
        }`,
      );
    }

    const message = parsedChoice.data.message;
    const calls = message.tool_calls ?? [];
    const reasoningDetails = parseReasoningDetails(message.reasoning_details);

    if (calls.length > 0) {
      assertUniqueToolCallIds(calls);
      const decisions = calls.map(call => this.decisionFromToolCall(call, true));
      if (
        calls.length > 1
        && decisions.some(decision => decision.type !== 'tool_call')
      ) {
        throw new Error(
          'OpenAI-compatible provider mixed terminal and runner tool calls',
        );
      }
      this.messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: calls,
        ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
      });
      telemetry.outcome = 'success';
      if (decisions[0]?.type === 'tool_call') {
        this.pendingToolCalls = [...calls];
      }
      const firstDecision = decisions[0];
      if (!firstDecision) {
        throw new Error('OpenAI-compatible provider returned no tool decision');
      }
      return firstDecision;
    }

    const refusal = message.refusal?.trim();
    if (refusal) {
      this.messages.push({ role: 'assistant', content: refusal });
      telemetry.outcome = 'success';
      return pactDecisionV1Schema.parse({ type: 'refuse', reason: refusal });
    }

    const content = message.content?.trim();
    if (!content) {
      throw new Error('OpenAI-compatible provider returned no decision');
    }
    this.messages.push({ role: 'assistant', content });
    telemetry.outcome = 'success';
    return pactDecisionV1Schema.parse({ type: 'answer', content });
  }

  private decisionFromToolCall(
    call: OpenAICompatibleToolCall,
    allowTerminal: boolean,
  ): PactDecisionV1 {
    const input = parseToolArguments(call.function.arguments);

    if (call.function.name === 'pact_answer') {
      if (!allowTerminal) {
        throw new Error('Queued provider tool call cannot be terminal');
      }
      const { content } = terminalAnswerSchema.parse(input);
      return pactDecisionV1Schema.parse({ type: 'answer', content });
    }
    if (call.function.name === 'pact_refuse') {
      if (!allowTerminal) {
        throw new Error('Queued provider tool call cannot be terminal');
      }
      const { reason } = terminalReasonSchema.parse(input);
      return pactDecisionV1Schema.parse({ type: 'refuse', reason });
    }
    if (call.function.name === 'pact_escalate') {
      if (!allowTerminal) {
        throw new Error('Queued provider tool call cannot be terminal');
      }
      const { reason } = terminalReasonSchema.parse(input);
      return pactDecisionV1Schema.parse({ type: 'escalate', reason });
    }
    if (!runnerToolNames.has(call.function.name)) {
      throw new Error('OpenAI-compatible provider selected an unavailable tool');
    }

    return pactDecisionV1Schema.parse({
      type: 'tool_call',
      toolName: call.function.name,
      input,
    });
  }

  private async fetchCompletion(body: unknown): Promise<FetchedProviderCompletionV1> {
    const timeoutMs = Math.min(
      this.requestTimeoutMs,
      this.config.budget.maxRuntimeMs,
    );
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const startedAt = Date.now();
    let attempts = 0;
    let failureHeaders: ProviderResponseHeadersV1 = {};
    let failureStatus: number | undefined;
    let failureResponseAttempt: number | undefined;
    let failureRetryable: boolean | undefined;

    try {
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS_V1; attempt += 1) {
        attempts = attempt;
        let response: Response;
        try {
          // Never follow redirects: the request carries a provider credential
          // (authorization bearer or Azure api-key header), and a transparent
          // redirect could replay that header against a different origin.
          response = await this.fetchImplementation(this.completionUrl, {
            method: 'POST',
            headers: {
              ...this.authHeaders,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            redirect: 'manual',
            signal: abortController.signal,
          });
        } catch {
          if (abortController.signal.aborted) {
            throw new Error(`OpenAI-compatible provider timed out after ${timeoutMs}ms`);
          }
          if (attempt < MAX_PROVIDER_ATTEMPTS_V1) {
            await waitForProviderRetry(
              retryDelayMs(attempt),
              abortController.signal,
              timeoutMs,
            );
            continue;
          }
          failureRetryable = true;
          throw new PactProviderRequestErrorV1(
            'OpenAI-compatible provider request failed',
            { retryable: true },
          );
        }

        failureHeaders = providerResponseHeaders(response, this.apiKey);
        failureStatus = response.status;
        failureResponseAttempt = attempt;
        failureRetryable = response.ok
          ? false
          : isRetryableProviderStatus(response.status);
        if (isRedirectProviderResponse(response)) {
          // Fail closed instead of re-sending the credential to wherever the
          // Location header points (it may be a different origin).
          failureRetryable = false;
          failureStatus = response.status || undefined;
          await cancelProviderResponseBody(response);
          throw new PactProviderRequestErrorV1(
            'OpenAI-compatible provider responded with a redirect; refusing to resend credentials',
            {
              ...(response.status ? { status: response.status } : {}),
              retryable: false,
            },
          );
        }
        if (!response.ok) {
          const retryable = failureRetryable;
          const retryDelay = providerRetryDelayMs(response, attempt);
          await cancelProviderResponseBody(response);
          if (retryable && attempt < MAX_PROVIDER_ATTEMPTS_V1) {
            await waitForProviderRetry(
              retryDelay,
              abortController.signal,
              timeoutMs,
            );
            continue;
          }
          throw new PactProviderRequestErrorV1(
            `OpenAI-compatible provider request failed with HTTP ${response.status}`,
            { status: response.status, retryable },
          );
        }

        return {
          body: await readBoundedProviderJson(
            response,
            abortController.signal,
            timeoutMs,
          ),
          headers: providerResponseHeaders(response, this.apiKey),
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
        };
      }
      throw new PactProviderRequestErrorV1('OpenAI-compatible provider request failed');
    } catch (error) {
      this.providerRequests.push({
        requestedModel: this.requestModel,
        ...(failureHeaders.provider
          ? { provider: failureHeaders.provider }
          : {}),
        ...(failureHeaders.requestId
          ? { requestId: failureHeaders.requestId }
          : {}),
        ...(failureHeaders.generationId
          ? { generationId: failureHeaders.generationId }
          : {}),
        ...(failureStatus === undefined
          ? {}
          : { httpStatus: failureStatus }),
        ...(failureResponseAttempt === undefined
          ? {}
          : { lastResponseAttempt: failureResponseAttempt }),
        ...(failureRetryable === undefined
          ? {}
          : { retryable: failureRetryable }),
        latencyMs: Date.now() - startedAt,
        attempts: Math.max(1, attempts),
        outcome: failureStatus !== undefined
          && failureStatus >= 200
          && failureStatus < 300
          ? 'invalid_response'
          : 'provider_error',
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPactNetModelHarnessV1(
  config: PactRunConfigV1,
  publicTask: PactTaskIntroV1,
  options: PactNetModelHarnessV1Options = {},
): PactNetHarnessV1 {
  return new OpenAICompatiblePactNetHarnessV1(config, publicTask, options);
}

export function createPactNetModelHarnessFactoryV1(
  options: PactNetModelHarnessV1Options = {},
): PactNetHarnessFactoryV1 {
  return context =>
    createPactNetModelHarnessV1(context.config, context.publicTask, options);
}

function providerTelemetryFromResponse(options: {
  requestedModel: string;
  fetched: FetchedProviderCompletionV1;
  envelope?: z.infer<typeof providerEnvelopeSchema>;
  outcome: PactProviderRequestTelemetryV1['outcome'];
}): PactProviderRequestTelemetryV1 {
  const usage = providerUsage(options.envelope?.usage);
  return {
    requestedModel: options.requestedModel,
    ...(options.envelope?.model
      ? { servedModel: options.envelope.model }
      : {}),
    ...(options.envelope?.provider ?? options.fetched.headers.provider
      ? {
        provider: options.envelope?.provider
          ?? options.fetched.headers.provider,
      }
      : {}),
    ...(options.envelope?.id
      ? { responseId: options.envelope.id }
      : {}),
    ...(options.fetched.headers.requestId
      ? { requestId: options.fetched.headers.requestId }
      : {}),
    ...(options.fetched.headers.generationId
      ? { generationId: options.fetched.headers.generationId }
      : {}),
    latencyMs: options.fetched.latencyMs,
    attempts: options.fetched.attempts,
    ...(options.envelope
      ? { choiceCount: options.envelope.choices.length }
      : {}),
    outcome: options.outcome,
    ...(usage ? { usage } : {}),
  };
}

function providerUsage(value: unknown): PactProviderUsageV1 | undefined {
  const parsed = providerUsageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const usage: PactProviderUsageV1 = {
    ...(parsed.data.prompt_tokens == null
      ? {}
      : { promptTokens: parsed.data.prompt_tokens }),
    ...(parsed.data.completion_tokens == null
      ? {}
      : { completionTokens: parsed.data.completion_tokens }),
    ...(parsed.data.total_tokens == null
      ? {}
      : { totalTokens: parsed.data.total_tokens }),
    ...(parsed.data.completion_tokens_details?.reasoning_tokens == null
      ? {}
      : {
        reasoningTokens:
          parsed.data.completion_tokens_details.reasoning_tokens,
      }),
    ...(parsed.data.prompt_tokens_details?.cached_tokens == null
      ? {}
      : { cachedTokens: parsed.data.prompt_tokens_details.cached_tokens }),
    ...(parsed.data.cost == null ? {} : { costUsd: parsed.data.cost }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function sumOptionalUsage<K extends keyof PactProviderUsageV1>(
  usages: Array<PactProviderUsageV1 | undefined>,
  key: K,
): Partial<Record<K, number>> {
  const values = usages.flatMap(usage => {
    const value = usage?.[key];
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return {};
  return { [key]: values.reduce((sum, value) => sum + value, 0) } as Partial<
    Record<K, number>
  >;
}

function parseReasoningDetails(value: unknown[] | null | undefined): JsonValue[] | undefined {
  if (!value || value.length === 0) return undefined;
  const parsed = z.array(jsonValueSchema).safeParse(value);
  if (!parsed.success) {
    // Do not include nested object paths: reasoning payload keys are
    // provider-controlled and could themselves contain sensitive text.
    throw new Error('OpenAI-compatible provider returned invalid reasoning details');
  }
  return parsed.data;
}

function assertUniqueToolCallIds(calls: OpenAICompatibleToolCall[]): void {
  if (new Set(calls.map(call => call.id)).size !== calls.length) {
    throw new Error('OpenAI-compatible provider returned duplicate tool-call identifiers');
  }
}

function summarizeProviderSchemaIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 6).map(issue => {
    const path = issue.path.length === 0
      ? '<root>'
      : issue.path.map(segment =>
        typeof segment === 'number' ? `[${segment}]` : String(segment)).join('.');
    if (issue.code === z.ZodIssueCode.invalid_type) {
      return `${path}: expected ${issue.expected}, received ${issue.received}`;
    }
    return `${path}: ${issue.code}`;
  });
  const omitted = error.issues.length - issues.length;
  return `${issues.join('; ')}${omitted > 0 ? `; +${omitted} more issue(s)` : ''}`;
}

function providerResponseHeaders(
  response: Response,
  secret: string,
): ProviderResponseHeadersV1 {
  return {
    ...firstSafeProviderHeader(
      response,
      ['x-request-id', 'request-id'],
      'requestId',
      secret,
    ),
    ...firstSafeProviderHeader(
      response,
      ['x-generation-id', 'x-openrouter-generation-id'],
      'generationId',
      secret,
    ),
    ...firstSafeProviderHeader(
      response,
      ['x-openrouter-provider', 'x-provider'],
      'provider',
      secret,
    ),
  };
}

function firstSafeProviderHeader<K extends keyof ProviderResponseHeadersV1>(
  response: Response,
  names: string[],
  key: K,
  secret: string,
): Partial<Record<K, string>> {
  for (const name of names) {
    const raw = response.headers.get(name);
    if (!raw) continue;
    const sanitized = raw
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .split(secret)
      .join('[REDACTED]')
      .slice(0, 512);
    if (sanitized) {
      return { [key]: sanitized } as Partial<Record<K, string>>;
    }
  }
  return {};
}

/**
 * OpenRouter/OpenAI-specific request extras (seed, reasoning, provider
 * routing). Azure's v1 chat-completions API accepts none of these controls.
 */
function openAICompatibleRequestExtrasV1(
  model: PactModelConfigV1,
): Record<string, unknown> {
  if (model.provider !== 'openai-compatible') return {};
  return {
    ...(model.seed === undefined ? {} : { seed: model.seed }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.providerRouting === undefined
      ? {}
      : {
        provider: {
          ...(model.providerRouting.requireParameters === undefined
            ? {}
            : { require_parameters: model.providerRouting.requireParameters }),
          ...(model.providerRouting.allowFallbacks === undefined
            ? {}
            : { allow_fallbacks: model.providerRouting.allowFallbacks }),
          ...(model.providerRouting.order === undefined
            ? {}
            : { order: model.providerRouting.order }),
          ...(model.providerRouting.only === undefined
            ? {}
            : { only: model.providerRouting.only }),
        },
      }),
  };
}

/**
 * Completion endpoint, auth headers, and request-body model per provider —
 * identical rules to the Pair adapter so both providers share one request
 * and response body handling path.
 */
function resolveProviderRequestTargetV1(
  model: PactModelConfigV1,
  apiKey: string,
): { url: URL; headers: Record<string, string>; bodyModel: string } {
  const bodyModel = pactModelIdentifierV1(model);
  if (model.provider === 'azure-openai') {
    const url = new URL('chat/completions', `${model.endpoint}/`);
    if (model.apiVersion) url.searchParams.set('api-version', model.apiVersion);
    return { url, headers: { 'api-key': apiKey }, bodyModel };
  }
  const url = new URL('chat/completions', `${model.baseUrl}/`);
  return { url, headers: { authorization: `Bearer ${apiKey}` }, bodyModel };
}

function isRetryableProviderStatus(status: number): boolean {
  return [408, 409, 429].includes(status) || status >= 500;
}

function isRedirectProviderResponse(response: Response): boolean {
  return (response.status >= 300 && response.status < 400)
    || response.type === 'opaqueredirect';
}

function providerRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_PROVIDER_RETRY_DELAY_MS_V1, Math.round(seconds * 1_000));
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(
        MAX_PROVIDER_RETRY_DELAY_MS_V1,
        Math.max(0, date - Date.now()),
      );
    }
  }
  return retryDelayMs(attempt);
}

function retryDelayMs(attempt: number): number {
  return Math.min(MAX_PROVIDER_RETRY_DELAY_MS_V1, 250 * 2 ** (attempt - 1));
}

async function waitForProviderRetry(
  delayMs: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) {
    throw new Error(`OpenAI-compatible provider timed out after ${timeoutMs}ms`);
  }
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(`OpenAI-compatible provider timed out after ${timeoutMs}ms`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toProviderTool(tool: PactToolSpecV1): OpenAICompatibleTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? `PACT runner tool ${tool.name}`,
      parameters: tool.inputSchema,
    },
  };
}

function terminalTools(): OpenAICompatibleTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'pact_answer',
        description: 'Return the final answer to the external requester.',
        parameters: stringArgumentSchema('content'),
      },
    },
    {
      type: 'function',
      function: {
        name: 'pact_refuse',
        description: 'Refuse the external request without revealing restricted information.',
        parameters: stringArgumentSchema('reason'),
      },
    },
    {
      type: 'function',
      function: {
        name: 'pact_escalate',
        description: 'Request owner review when the request cannot be decided safely.',
        parameters: stringArgumentSchema('reason'),
      },
    },
  ];
}

function stringArgumentSchema(name: 'content' | 'reason'): JsonObject {
  return {
    type: 'object',
    properties: {
      [name]: { type: 'string' },
    },
    required: [name],
    additionalProperties: false,
  };
}

function parseToolArguments(source: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(source) as JsonValue;
  } catch {
    throw new Error('OpenAI-compatible provider returned invalid tool arguments');
  }
  assertPactJsonComplexityV1(parsed, 'OpenAI-compatible tool arguments');
  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('OpenAI-compatible provider returned invalid tool arguments');
  }
  return result.data;
}

async function readBoundedProviderJson(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PACT_PROVIDER_RESPONSE_BYTES_V1) {
    await cancelProviderResponseBody(response);
    throw new Error(
      `OpenAI-compatible provider response exceeds ${MAX_PACT_PROVIDER_RESPONSE_BYTES_V1} bytes`,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  try {
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        totalBytes += part.value.byteLength;
        if (totalBytes > MAX_PACT_PROVIDER_RESPONSE_BYTES_V1) {
          await reader.cancel();
          throw new Error(
            `OpenAI-compatible provider response exceeds ${MAX_PACT_PROVIDER_RESPONSE_BYTES_V1} bytes`,
          );
        }
        chunks.push(part.value);
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`OpenAI-compatible provider timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    reader?.releaseLock();
  }

  const source = reader
    ? Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), totalBytes).toString('utf8')
    : await response.text();
  if (Buffer.byteLength(source, 'utf8') > MAX_PACT_PROVIDER_RESPONSE_BYTES_V1) {
    throw new Error(
      `OpenAI-compatible provider response exceeds ${MAX_PACT_PROVIDER_RESPONSE_BYTES_V1} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error('OpenAI-compatible provider returned invalid JSON');
  }
  assertPactJsonComplexityV1(parsed, 'OpenAI-compatible provider response');
  return parsed;
}

async function cancelProviderResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded; cancellation failure must not expose
    // provider details or replace the bounded runner error.
  }
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3_600_000) {
    throw new Error('Model adapter timeout must be a positive integer up to 3600000ms');
  }
  return value;
}

function redactProviderCredential(value: unknown, secret: string): unknown {
  if (typeof value === 'string') {
    return value.includes(secret) ? value.split(secret).join('[REDACTED]') : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactProviderCredential(item, secret));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.includes(secret) ? key.split(secret).join('[REDACTED]') : key,
        redactProviderCredential(item, secret),
      ]),
    );
  }
  return value;
}
