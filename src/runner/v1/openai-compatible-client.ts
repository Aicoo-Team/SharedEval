import { Buffer } from 'node:buffer';
import { assertPactJsonComplexityV1 } from '../../protocol/v1/index.js';
import {
  pactModelIdentifierV1,
  type PactModelConfigV1,
} from './config.js';

export const MAX_OPENAI_COMPATIBLE_PROVIDER_RESPONSE_BYTES_V1 =
  2 * 1_024 * 1_024;

const MAX_OPENAI_COMPATIBLE_PROVIDER_RETRY_DELAY_MS_V1 = 30_000;

/** @internal Fixed transport failures that contain no provider-controlled bytes. */
export class OpenAICompatibleProviderTransportErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAICompatibleProviderTransportErrorV1';
  }
}

export type OpenAICompatibleProviderResponseHeadersV1 = {
  requestId?: string;
  generationId?: string;
  provider?: string;
};

export type OpenAICompatibleProviderRequestTargetV1 = {
  url: URL;
  headers: Record<string, string>;
  bodyModel: string;
};

/**
 * Resolves only transport-facing provider configuration. Transcript and tool
 * semantics stay with the harness that owns the turn.
 */
export function resolveOpenAICompatibleProviderRequestTargetV1(
  model: PactModelConfigV1,
  apiKey: string,
): OpenAICompatibleProviderRequestTargetV1 {
  const bodyModel = pactModelIdentifierV1(model);
  if (model.provider === 'azure-openai') {
    const url = new URL('chat/completions', `${model.endpoint}/`);
    if (model.apiVersion) url.searchParams.set('api-version', model.apiVersion);
    return { url, headers: { 'api-key': apiKey }, bodyModel };
  }
  return {
    url: new URL('chat/completions', `${model.baseUrl}/`),
    headers: { authorization: `Bearer ${apiKey}` },
    bodyModel,
  };
}

/** Provider-specific request controls shared by both harness protocols. */
export function openAICompatibleProviderRequestExtrasV1(
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

export function readOpenAICompatibleProviderResponseHeadersV1(
  response: Response,
  secret: string,
): OpenAICompatibleProviderResponseHeadersV1 {
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

export function redactOpenAICompatibleProviderCredentialV1(
  value: unknown,
  secret: string,
): unknown {
  if (typeof value === 'string') {
    return value.includes(secret) ? value.split(secret).join('[REDACTED]') : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactOpenAICompatibleProviderCredentialV1(item, secret));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.includes(secret) ? key.split(secret).join('[REDACTED]') : key,
        redactOpenAICompatibleProviderCredentialV1(item, secret),
      ]),
    );
  }
  return value;
}

export function isRetryableOpenAICompatibleProviderStatusV1(status: number): boolean {
  return [408, 409, 429].includes(status) || status >= 500;
}

export function isOpenAICompatibleProviderRedirectResponseV1(
  response: Response,
): boolean {
  return (response.status >= 300 && response.status < 400)
    || response.type === 'opaqueredirect';
}

export function openAICompatibleProviderRetryDelayMsV1(
  response: Response,
  attempt: number,
): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(
        MAX_OPENAI_COMPATIBLE_PROVIDER_RETRY_DELAY_MS_V1,
        Math.round(seconds * 1_000),
      );
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(
        MAX_OPENAI_COMPATIBLE_PROVIDER_RETRY_DELAY_MS_V1,
        Math.max(0, date - Date.now()),
      );
    }
  }
  return openAICompatibleProviderDefaultRetryDelayMsV1(attempt);
}

export function openAICompatibleProviderDefaultRetryDelayMsV1(
  attempt: number,
): number {
  return Math.min(
    MAX_OPENAI_COMPATIBLE_PROVIDER_RETRY_DELAY_MS_V1,
    250 * 2 ** (attempt - 1),
  );
}

export async function waitForOpenAICompatibleProviderRetryV1(
  delayMs: number,
  signal: AbortSignal,
  timeoutMs: number,
  errorPrefix: string,
): Promise<void> {
  if (signal.aborted) {
    throw new OpenAICompatibleProviderTransportErrorV1(
      `${errorPrefix} timed out after ${timeoutMs}ms`,
    );
  }
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OpenAICompatibleProviderTransportErrorV1(
        `${errorPrefix} timed out after ${timeoutMs}ms`,
      ));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settles one provider operation against the caller's shared deadline signal.
 * The losing operation stays observed so a late rejection cannot become
 * unhandled; callers may dispose a late value without mutating run state.
 */
export function settleOpenAICompatibleProviderOperationV1<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  publicMessage: string,
  onLateValue?: (value: T) => void,
): Promise<T> {
  const observed = Promise.resolve(operation);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void) => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      continuation();
      return true;
    };
    const onAbort = () => finish(() => reject(
      new OpenAICompatibleProviderTransportErrorV1(publicMessage),
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    observed.then(
      value => {
        if (!finish(() => resolve(value))) onLateValue?.(value);
      },
      error => { finish(() => reject(error)); },
    );
    if (signal.aborted) onAbort();
  });
}

export async function readBoundedOpenAICompatibleProviderJsonV1(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
  errorPrefix: string,
  maxBytes = MAX_OPENAI_COMPATIBLE_PROVIDER_RESPONSE_BYTES_V1,
): Promise<unknown> {
  const declaredLength = Number.parseInt(
    response.headers.get('content-length') ?? '',
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelOpenAICompatibleProviderResponseBodyV1(response);
    throw new OpenAICompatibleProviderTransportErrorV1(
      `${errorPrefix} response exceeds ${maxBytes} bytes`,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  try {
    if (reader) {
      while (true) {
        const part = await settleOpenAICompatibleProviderOperationV1(
          reader.read(),
          signal,
          `${errorPrefix} timed out after ${timeoutMs}ms`,
        );
        if (part.done) break;
        totalBytes += part.value.byteLength;
        if (totalBytes > maxBytes) {
          cancelProviderReaderBestEffort(reader);
          throw new OpenAICompatibleProviderTransportErrorV1(
            `${errorPrefix} response exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(part.value);
      }
    }
  } catch (error) {
    cancelProviderReaderBestEffort(reader);
    if (totalBytes > maxBytes) {
      throw new OpenAICompatibleProviderTransportErrorV1(
        `${errorPrefix} response exceeds ${maxBytes} bytes`,
      );
    }
    if (signal.aborted) {
      throw new OpenAICompatibleProviderTransportErrorV1(
        `${errorPrefix} timed out after ${timeoutMs}ms`,
      );
    }
    throw new OpenAICompatibleProviderTransportErrorV1(
      `${errorPrefix} response stream failed`,
    );
  } finally {
    releaseProviderReaderBestEffort(reader);
  }

  let source: string;
  if (reader) {
    source = Buffer.concat(
      chunks.map(chunk => Buffer.from(chunk)),
      totalBytes,
    ).toString('utf8');
  } else {
    try {
      source = await settleOpenAICompatibleProviderOperationV1(
        response.text(),
        signal,
        `${errorPrefix} timed out after ${timeoutMs}ms`,
      );
    } catch {
      if (signal.aborted) {
        throw new OpenAICompatibleProviderTransportErrorV1(
          `${errorPrefix} timed out after ${timeoutMs}ms`,
        );
      }
      throw new OpenAICompatibleProviderTransportErrorV1(
        `${errorPrefix} response stream failed`,
      );
    }
  }
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    throw new OpenAICompatibleProviderTransportErrorV1(
      `${errorPrefix} response exceeds ${maxBytes} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new OpenAICompatibleProviderTransportErrorV1(
      `${errorPrefix} returned invalid JSON`,
    );
  }
  assertPactJsonComplexityV1(parsed, `${errorPrefix} response`);
  return parsed;
}

export async function cancelOpenAICompatibleProviderResponseBodyV1(
  response: Response,
): Promise<void> {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void Promise.resolve(cancellation).catch(() => {});
  } catch {
    // Discard cancellation details so provider data cannot replace the bounded
    // transport error owned by the caller.
  }
}

function cancelProviderReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): void {
  if (!reader) return;
  try {
    void Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // A pending or hostile stream must not delay the bounded transport error.
  }
}

function releaseProviderReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): void {
  if (!reader) return;
  try {
    reader.releaseLock();
  } catch {
    // A pending read can keep the lock; deadline settlement remains bounded.
  }
}

function firstSafeProviderHeader<
  K extends keyof OpenAICompatibleProviderResponseHeadersV1,
>(
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
