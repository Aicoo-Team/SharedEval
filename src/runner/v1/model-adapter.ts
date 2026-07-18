import { z } from 'zod';
import {
  assertPactJsonComplexityV1,
  jsonObjectSchema,
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  pactTaskIntroV1Schema,
  type JsonObject,
  type JsonValue,
  type PactAdapterV1,
  type PactBoundaryPlanV1,
  type PactDecisionV1,
  type PactFinalizeReportV1,
  type PactObservationV1,
  type PactRunInitV1,
  type PactTaskIntroV1,
  type PactToolSpecV1,
} from '../../protocol/v1/index.js';
import {
  type PactRunConfigV1,
  resolvePactRunModelApiKeyV1,
} from './config.js';
import {
  buildPactSystemPromptV1,
  buildPactTaskMessageV1,
  PACT_TERMINAL_TOOL_NAMES_V1,
} from './prompt.js';

type FetchImplementation = typeof globalThis.fetch;

export const MAX_PACT_PROVIDER_RESPONSE_BYTES_V1 = 2 * 1_024 * 1_024;
const MAX_PROVIDER_ATTEMPTS_V1 = 3;
const MAX_PROVIDER_RETRY_DELAY_MS_V1 = 2_000;

export type OpenAICompatiblePactAdapterV1Options = {
  fetch?: FetchImplementation;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export class PactProviderRequestErrorV1 extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly fatalConfiguration: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'PactProviderRequestErrorV1';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    // Only unambiguous credential/endpoint failures abort the whole
    // selection. Other 4xx responses may be task-specific (content policy,
    // payload size, or context length) and remain isolated task errors.
    this.fatalConfiguration = options.status !== undefined
      && [401, 403, 404, 405].includes(options.status);
  }
}

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

const providerResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullable().optional(),
                refusal: z.string().nullable().optional(),
                tool_calls: z.array(providerToolCallSchema).max(1).optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();

const terminalReasonSchema = z.object({ reason: z.string().trim().min(1).max(4_096) }).strict();
const terminalAnswerSchema = z.object({ content: z.string().trim().min(1).max(65_536) }).strict();
const terminalToolNames = new Set<string>(PACT_TERMINAL_TOOL_NAMES_V1);

export class OpenAICompatiblePactAdapterV1 implements PactAdapterV1 {
  private readonly fetchImplementation: FetchImplementation;
  private readonly apiKey: string;
  private readonly configuredTimeoutMs: number;
  private requestTimeoutMs: number;
  private runInit: PactRunInitV1 | null = null;
  private messages: OpenAICompatibleMessage[] = [];
  private availableToolNames = new Set<string>();
  private pendingToolCall: { id: string; name: string } | null = null;
  private failed = false;

  constructor(
    private readonly config: PactRunConfigV1,
    options: OpenAICompatiblePactAdapterV1Options = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImplementation !== 'function') {
      throw new Error('A fetch implementation is required for the model adapter');
    }
    this.apiKey = resolvePactRunModelApiKeyV1(
      config,
      options.environment ?? process.env,
    );
    this.configuredTimeoutMs = validateTimeout(
      options.timeoutMs ?? config.budget.maxRuntimeMs,
    );
    this.requestTimeoutMs = this.configuredTimeoutMs;
  }

  async initialize(init: PactRunInitV1): Promise<void> {
    const parsed = pactRunInitV1Schema.parse(init);
    const reservedCollision = parsed.tools.find(tool => terminalToolNames.has(tool.name));
    if (reservedCollision) {
      throw new Error(`Runner tool name is reserved: ${reservedCollision.name}`);
    }

    this.runInit = parsed;
    this.availableToolNames = new Set(parsed.tools.map(tool => tool.name));
    this.messages = [];
    this.pendingToolCall = null;
    this.failed = false;
    this.requestTimeoutMs = this.configuredTimeoutMs;
  }

  async planBoundary(task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    const parsed = pactTaskIntroV1Schema.parse(task);
    const correlatedQa = parsed.kind === 'qa' && parsed.surface === 'unknown';
    const notesTask = parsed.surface === 'notes' || correlatedQa;
    const todosTask = parsed.surface === 'todos' || correlatedQa;
    const isAction = parsed.kind === 'action';

    return {
      access: {
        notes: {
          read: notesTask ? { scope: 'all' } : { scope: 'none' },
          write: notesTask && isAction,
        },
        todos: {
          read: todosTask,
          write: todosTask && isAction,
        },
        memory: {
          read: 'none',
          write: false,
        },
      },
    };
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    const init = this.requireRunInit();
    const parsed = pactObservationV1Schema.parse(observation);
    this.requestTimeoutMs = Math.max(
      1,
      Math.min(this.configuredTimeoutMs, parsed.budgetRemaining.runtimeMs),
    );

    try {
      if (parsed.type === 'task') {
        this.pendingToolCall = null;
        this.messages = [
          {
            role: 'system',
            content: buildPactSystemPromptV1({
              policy: this.config.benchmark.policy,
              requester: this.config.benchmark.requester,
              init,
              task: parsed.task,
            }),
          },
          {
            role: 'user',
            content: [
              buildPactTaskMessageV1(parsed.task),
              `Runner-granted access: ${JSON.stringify(parsed.grantedAccess)}`,
              `Budget remaining: ${JSON.stringify(parsed.budgetRemaining)}`,
            ].join('\n'),
          },
        ];
      } else {
        this.appendToolResult(parsed);
      }

      return await this.requestDecision(init.tools);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    this.pendingToolCall = null;
    this.messages = [];
    return this.failed
      ? {
        status: 'failed',
        summary: 'The model adapter did not complete the session.',
      }
      : {
        status: 'completed',
        summary: 'The OpenAI-compatible model adapter completed the session.',
      };
  }

  private appendToolResult(
    observation: Extract<PactObservationV1, { type: 'tool_result' }>,
  ): void {
    const pending = this.pendingToolCall;
    if (!pending || pending.name !== observation.toolName) {
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
    this.pendingToolCall = null;
  }

  private async requestDecision(
    runnerTools: PactToolSpecV1[],
  ): Promise<PactDecisionV1> {
    const response = redactProviderCredential(await this.fetchCompletion({
      model: this.config.model.model,
      ...(this.config.model.temperature === undefined
        ? {}
        : { temperature: this.config.model.temperature }),
      max_completion_tokens: this.config.model.maxOutputTokens,
      messages: this.messages,
      tools: [
        ...runnerTools.map(toProviderTool),
        ...terminalTools(),
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    }), this.apiKey);

    const parsedResponse = providerResponseSchema.safeParse(response);
    if (!parsedResponse.success) {
      throw new Error('OpenAI-compatible provider returned an invalid response');
    }

    const message = parsedResponse.data.choices[0].message;
    const calls = message.tool_calls ?? [];
    if (calls.length > 1) {
      throw new Error('OpenAI-compatible provider returned multiple tool calls');
    }

    if (calls.length === 1) {
      const call = calls[0] as OpenAICompatibleToolCall;
      this.messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: [call],
      });
      return this.decisionFromToolCall(call);
    }

    const refusal = message.refusal?.trim();
    if (refusal) {
      this.messages.push({ role: 'assistant', content: refusal });
      return pactDecisionV1Schema.parse({ type: 'refuse', reason: refusal });
    }

    const content = message.content?.trim();
    if (!content) {
      throw new Error('OpenAI-compatible provider returned no decision');
    }
    this.messages.push({ role: 'assistant', content });
    return pactDecisionV1Schema.parse({ type: 'answer', content });
  }

  private decisionFromToolCall(call: OpenAICompatibleToolCall): PactDecisionV1 {
    const input = parseToolArguments(call.function.arguments);

    if (call.function.name === 'pact_answer') {
      const { content } = terminalAnswerSchema.parse(input);
      return pactDecisionV1Schema.parse({ type: 'answer', content });
    }
    if (call.function.name === 'pact_refuse') {
      const { reason } = terminalReasonSchema.parse(input);
      return pactDecisionV1Schema.parse({ type: 'refuse', reason });
    }
    if (call.function.name === 'pact_escalate') {
      const { reason } = terminalReasonSchema.parse(input);
      return pactDecisionV1Schema.parse({ type: 'escalate', reason });
    }
    if (!this.availableToolNames.has(call.function.name)) {
      throw new Error('OpenAI-compatible provider selected an unavailable tool');
    }

    this.pendingToolCall = { id: call.id, name: call.function.name };
    return pactDecisionV1Schema.parse({
      type: 'tool_call',
      toolName: call.function.name,
      input,
    });
  }

  private async fetchCompletion(body: unknown): Promise<unknown> {
    const init = this.requireRunInit();
    const timeoutMs = Math.min(
      this.requestTimeoutMs,
      init.budget.maxRuntimeMs,
    );
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const endpoint = new URL(
      'chat/completions',
      `${this.config.model.baseUrl}/`,
    );

    try {
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS_V1; attempt += 1) {
        let response: Response;
        try {
          response = await this.fetchImplementation(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
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
          throw new PactProviderRequestErrorV1(
            'OpenAI-compatible provider request failed',
            { retryable: true },
          );
        }

        if (!response.ok) {
          const retryable = isRetryableProviderStatus(response.status);
          await cancelProviderResponseBody(response);
          if (retryable && attempt < MAX_PROVIDER_ATTEMPTS_V1) {
            await waitForProviderRetry(
              providerRetryDelayMs(response, attempt),
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

        return await readBoundedProviderJson(response, abortController.signal, timeoutMs);
      }
      throw new PactProviderRequestErrorV1('OpenAI-compatible provider request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireRunInit(): PactRunInitV1 {
    if (!this.runInit) {
      throw new Error('Model adapter must be initialized before use');
    }
    return this.runInit;
  }
}

function isRetryableProviderStatus(status: number): boolean {
  return [408, 409, 429].includes(status) || status >= 500;
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

export function createOpenAICompatiblePactAdapterV1(
  config: PactRunConfigV1,
  options: OpenAICompatiblePactAdapterV1Options = {},
): PactAdapterV1 {
  return new OpenAICompatiblePactAdapterV1(config, options);
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
