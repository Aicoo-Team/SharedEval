import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PactBoundaryPlanV1, PactTaskIntroV1 } from '../../../src/protocol/v1/index.js';
import { PersistentLegacyResponderSessionV1 } from '../../../src/suites/pact-pair/legacy-transcript/responder-session.js';

const task: PactTaskIntroV1 = {
  taskId: 'Q1', kind: 'qa', surface: 'notes', prompt: 'Prompt',
  requester: { id: 'R4', relationship: 'investor' },
  target: { id: 'ALEX', relationship: 'owner' },
};
const access: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'none' }, write: false },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
};

function responder(
  fetch: typeof globalThis.fetch,
  attempts: number[] = [],
  retryWait?: () => Promise<void>,
) {
  return new PersistentLegacyResponderSessionV1({
    model: {
      provider: 'openai-compatible', baseUrl: 'https://example.test/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'requested', maxOutputTokens: 100,
    },
    credential: 's3cr3t', requesterId: 'R4',
    persona: { coo: 'coo', policy: 'policy', memory: 'memory' },
    tools: [], fetch,
    retryWait: retryWait ?? (async delay => { attempts.push(delay); }),
    maxProviderAttempts: 3,
  });
}

async function rejectedWithin(
  operation: Promise<unknown>,
  guardMs = 250,
): Promise<unknown> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const settled = operation.then(
    () => ({ kind: 'resolved' as const }),
    error => ({ kind: 'rejected' as const, error }),
  );
  const guarded = new Promise<{ kind: 'guard' }>(resolve => {
    guard = setTimeout(() => resolve({ kind: 'guard' }), guardMs);
  });
  try {
    const result = await Promise.race([settled, guarded]);
    assert.notEqual(result.kind, 'guard', 'operation exceeded its absolute deadline');
    assert.notEqual(result.kind, 'resolved', 'operation unexpectedly resolved');
    return 'error' in result ? result.error : undefined;
  } finally {
    if (guard) clearTimeout(guard);
  }
}

async function waitForLateSettlement(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40));
}

async function firstStep(
  instance: PersistentLegacyResponderSessionV1,
  deadlineAfterMs = 5_000,
) {
  await instance.initialize({ sessionId: 's1', publicChecklist: [task] });
  const deadlineMs = Date.now() + deadlineAfterMs;
  return instance.beginTick({
    tick: 1, task, requesterPrompt: 'Prompt', grantedAccess: access,
    visibleToolNames: [], deadlineMs,
  }).next({ type: 'start' });
}

test('redirects never resend the credential and expose no Location body', async () => {
  let calls = 0;
  const instance = responder(async () => {
    calls += 1;
    return new Response('s3cr3t redirect body', {
      status: 302,
      headers: { location: 'https://attacker.invalid/' },
    });
  });
  await assert.rejects(() => firstStep(instance), error => {
    assert.match(String(error), /redirect/i);
    assert.doesNotMatch(String(error), /s3cr3t/);
    return true;
  });
  assert.equal(calls, 1);
  const [request] = instance.telemetry().requests;
  assert.ok(request);
  assert.equal(request.requestedModel, 'requested');
  assert.equal(request.httpStatus, 302);
  assert.equal(request.attempts, 1);
  assert.equal(request.outcome, 'provider_error');
  assert.ok(request.latencyMs >= 0);
});

test('only retryable statuses retry and Retry-After is bounded', async () => {
  let calls = 0;
  const waits: number[] = [];
  const instance = responder(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('busy', { status: 429, headers: { 'retry-after': '999' } });
    }
    return new Response(JSON.stringify({
      model: 'served',
      choices: [{ message: { role: 'assistant', content: 'answer' } }],
    }), { status: 200 });
  }, waits);
  assert.equal((await firstStep(instance)).type, 'answer');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [30_000]);
});

test('oversized, malformed, and structurally hostile JSON fail with stable redacted errors', async () => {
  const responses = [
    new Response('', { status: 200, headers: { 'content-length': String(2_097_153) } }),
    new Response('{not json', { status: 200 }),
    new Response(JSON.stringify({ nested: Array.from({ length: 80 }).reduce<object>(value => ({ value }), {}) }), { status: 200 }),
  ];
  for (const response of responses) {
    const instance = responder(async () => response);
    await assert.rejects(() => firstStep(instance), error => {
      assert.doesNotMatch(String(error), /s3cr3t/);
      assert.match(String(error), /response|JSON|complex/i);
      return true;
    });
  }
});

test('one deadline aborts a stalled body and late completion cannot resume the session', async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  });
  const instance = responder(async () => new Response(stream, { status: 200 }));
  const error = await rejectedWithin(firstStep(instance, 100), 2_000);
  assert.match(String(error), /timed out/i);
});

test('the responder deadline bounds fetch acquisition even when fetch ignores AbortSignal', async () => {
  let signal: AbortSignal | undefined;
  const instance = responder((_url, init) => {
    signal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>(() => {});
  });
  const error = await rejectedWithin(firstStep(instance, 100), 2_000);
  assert.match(String(error), /timed out/i);
  assert.equal(signal?.aborted, true);
  const transcript = instance.privateTranscript();
  const telemetry = instance.telemetry();
  await waitForLateSettlement();
  assert.deepEqual(instance.privateTranscript(), transcript);
  assert.deepEqual(instance.telemetry(), telemetry);
  assert.equal(telemetry.requests.length, 1);
});

test('late responder fetch resolution or rejection is observed without post-timeout mutation', async () => {
  for (const mode of ['resolve', 'reject'] as const) {
    let resolveFetch: ((response: Response) => void) | undefined;
    let rejectFetch: ((error: Error) => void) | undefined;
    let bodyCancelled = false;
    const instance = responder(() => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve;
      rejectFetch = reject;
    }));
    const error = await rejectedWithin(firstStep(instance, 100), 2_000);
    assert.match(String(error), /timed out/i);
    const transcript = instance.privateTranscript();
    const telemetry = instance.telemetry();
    if (mode === 'resolve') {
      const body = new ReadableStream<Uint8Array>({
        cancel() { bodyCancelled = true; },
      });
      resolveFetch?.(new Response(body, { status: 200 }));
    } else {
      rejectFetch?.(new Error('late provider rejection'));
    }
    await waitForLateSettlement();
    assert.deepEqual(instance.privateTranscript(), transcript, mode);
    assert.deepEqual(instance.telemetry(), telemetry, mode);
    if (mode === 'resolve') assert.equal(bodyCancelled, true);
  }
});

test('the responder absolute deadline also bounds a signal-ignoring retry wait', async () => {
  const instance = responder(
    async () => new Response('{}', { status: 503 }),
    [],
    () => new Promise<void>(() => {}),
  );
  const error = await rejectedWithin(firstStep(instance, 100), 2_000);
  assert.match(String(error), /timed out/i);
  assert.equal(instance.telemetry().requests.length, 1);
});
