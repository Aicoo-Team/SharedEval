import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PactTaskIntroV1 } from '../../../src/protocol/v1/index.js';
import { createModelLegacyRequesterDriverV1 } from '../../../src/suites/pact-pair/legacy-transcript/model-requester.js';

function task(taskId: string): PactTaskIntroV1 {
  return {
    taskId, kind: 'qa', surface: 'notes', prompt: `Prompt ${taskId}`,
    requester: { id: 'R4', relationship: 'investor' },
    target: { id: 'ALEX', relationship: 'owner' },
  };
}

function response(decision: unknown, model = 'served-requester'): Response {
  return new Response(JSON.stringify({
    model,
    choices: [{ message: { role: 'assistant', content: JSON.stringify(decision) } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }), { status: 200 });
}

function create(
  fetch: typeof globalThis.fetch,
  retryWait?: () => Promise<void>,
) {
  return createModelLegacyRequesterDriverV1({
    model: {
      provider: 'openai-compatible', baseUrl: 'https://example.test/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'requested-requester',
      maxOutputTokens: 256,
    },
    credential: 'requester-secret',
    principalId: 'requester:R4',
    persona: { coo: 'coo', policy: 'policy', memory: 'memory' },
    fetch,
    retryWait: retryWait ?? (async () => {}),
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

async function initializedRequester(fetch: typeof globalThis.fetch) {
  const requester = create(fetch);
  await requester.initialize({
    trajectoryId: 'deadline-trajectory', items: [task('Q1')], maxTicks: 1,
  });
  return requester;
}

async function waitForLateSettlement(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40));
}

test('model requester maintains a public checklist and records model provenance separately', async () => {
  const requester = create(async () => response({
    action: 'ask', taskId: 'Q1', prompt: 'Natural ask', strategy: 'first_ask',
  }));
  await requester.initialize({
    trajectoryId: 'trajectory-1', items: [task('Q1'), task('Q2')],
    phase2StartTick: 3, maxTicks: 7,
  });
  assert.deepEqual(await requester.nextTick({ tick: 1, phase: 1 }), {
    type: 'ask', taskId: 'Q1', prompt: 'Natural ask', phase: 1,
    strategy: 'first_ask', principalId: 'requester:R4',
  });
  const provenance = requester.provenance();
  assert.equal(provenance.kind, 'model');
  if (provenance.kind !== 'model') assert.fail('expected model provenance');
  assert.equal(provenance.requestedModel, 'requested-requester');
  assert.deepEqual(provenance.servedModels, ['served-requester']);
  assert.match(provenance.promptRawSha256, /^[0-9a-f]{64}$/);
  const [usage] = requester.usageRecords();
  assert.deepEqual(usage, {
    tick: 1, attempts: 1, outcome: 'success',
    latencyMs: usage?.latencyMs,
    promptTokens: 5, completionTokens: 2, totalTokens: 7,
    servedModel: 'served-requester',
  });
  assert.equal(typeof usage?.latencyMs, 'number');
});

test('model requester rejects malformed and off-list decisions without scripted fallback', async () => {
  const decisions: Array<{ response: Response; outcome: 'invalid_response' | 'success' }> = [
    { response: new Response(JSON.stringify({
      model: 'served', choices: [{ message: { role: 'assistant', content: '{bad' } }],
    }), { status: 200 }), outcome: 'invalid_response' },
    {
      response: response({
        action: 'ask', taskId: 'Q999', prompt: 'off list', strategy: 'first_ask',
      }),
      outcome: 'success',
    },
  ];
  for (const decision of decisions) {
    let calls = 0;
    const requester = create(async () => {
      calls += 1;
      return decision.response;
    });
    await requester.initialize({
      trajectoryId: 'trajectory-1', items: [task('Q1')], maxTicks: 1,
    });
    await assert.rejects(() => requester.nextTick({ tick: 1, phase: 1 }), /invalid|off-list/i);
    assert.equal(calls, 1);
    assert.deepEqual(requester.finalChecklist(), [{ taskId: 'Q1', status: 'pending', asks: 0 }]);
    assert.equal(requester.usageRecords()[0]?.outcome, decision.outcome);
  }
});

test('model requester accounts for a failed logical provider request once', async () => {
  let calls = 0;
  const requester = create(async () => {
    calls += 1;
    return new Response('{}', { status: 503 });
  });
  await requester.initialize({
    trajectoryId: 'trajectory-1', items: [task('Q1')], maxTicks: 1,
  });
  await assert.rejects(
    () => requester.nextTick({ tick: 1, phase: 1 }),
    /HTTP 503/i,
  );
  assert.equal(calls, 4);
  const [usage] = requester.usageRecords();
  assert.equal(usage?.attempts, 4);
  assert.equal(usage?.outcome, 'provider_error');
});

test('model requester phase 2 can select only a retry-eligible refusal with a retry strategy', async () => {
  let calls = 0;
  const requester = create(async () => {
    calls += 1;
    return calls === 1
      ? response({ action: 'ask', taskId: 'Q1', prompt: 'first', strategy: 'first_ask' })
      : response({ action: 'ask', taskId: 'Q1', prompt: 'again', strategy: 'urgency' });
  });
  await requester.initialize({
    trajectoryId: 'trajectory-1', items: [task('Q1')],
    phase2StartTick: 2, maxTicks: 2,
  });
  await requester.nextTick({ tick: 1, phase: 1 });
  await requester.observe({
    tick: 1, taskId: 'Q1', terminalReceived: true,
    decision: { type: 'refuse', reason: 'private' },
    substrateStatus: 'succeeded', sideEffectBeforeFailure: false, stateChanged: false,
  });
  assert.deepEqual(await requester.nextTick({ tick: 2, phase: 2 }), {
    type: 'ask', taskId: 'Q1', prompt: 'again', phase: 2,
    strategy: 'urgency', retryOfTick: 1, principalId: 'requester:R4',
  });
});

test('model requester never retries a provider failure even when the model asks again', async () => {
  let calls = 0;
  const requester = create(async () => {
    calls += 1;
    return response({ action: 'ask', taskId: 'Q1', prompt: 'ask', strategy: calls === 1 ? 'first_ask' : 'repeat' });
  });
  await requester.initialize({
    trajectoryId: 'trajectory-1', items: [task('Q1')],
    phase2StartTick: 2, maxTicks: 2,
  });
  await requester.nextTick({ tick: 1, phase: 1 });
  await requester.observe({
    tick: 1, taskId: 'Q1', terminalReceived: false,
    decision: { type: 'escalate', reason: 'provider failed' },
    substrateStatus: 'provider_error', sideEffectBeforeFailure: false, stateChanged: false,
  });
  assert.deepEqual(await requester.nextTick({ tick: 2, phase: 2 }), {
    type: 'stop', reason: 'no retry-eligible checklist items remain',
  });
  assert.equal(calls, 1);
});

test('the model requester deadline bounds fetch acquisition even when fetch ignores AbortSignal', async () => {
  let signal: AbortSignal | undefined;
  const requester = await initializedRequester((_url, init) => {
    signal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>(() => {});
  });
  const error = await rejectedWithin(requester.nextTick({
    tick: 1, phase: 1, deadlineMs: Date.now() + 20,
  }));
  assert.match(String(error), /timed out/i);
  assert.equal(signal?.aborted, true);
  const transcript = requester.privateTranscript();
  const provenance = requester.provenance();
  const usage = requester.usageRecords();
  await waitForLateSettlement();
  assert.deepEqual(requester.privateTranscript(), transcript);
  assert.deepEqual(requester.provenance(), provenance);
  assert.deepEqual(requester.usageRecords(), usage);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.outcome, 'timeout');
});

test('late requester fetch resolution or rejection is observed without post-timeout mutation', async () => {
  for (const mode of ['resolve', 'reject'] as const) {
    let resolveFetch: ((response: Response) => void) | undefined;
    let rejectFetch: ((error: Error) => void) | undefined;
    let bodyCancelled = false;
    const requester = await initializedRequester(() =>
      new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
      }));
    const error = await rejectedWithin(requester.nextTick({
      tick: 1, phase: 1, deadlineMs: Date.now() + 20,
    }));
    assert.match(String(error), /timed out/i);
    const transcript = requester.privateTranscript();
    const provenance = requester.provenance();
    const usage = requester.usageRecords();
    if (mode === 'resolve') {
      const body = new ReadableStream<Uint8Array>({
        cancel() { bodyCancelled = true; },
      });
      resolveFetch?.(new Response(body, { status: 200 }));
    } else {
      rejectFetch?.(new Error('late requester rejection'));
    }
    await waitForLateSettlement();
    assert.deepEqual(requester.privateTranscript(), transcript, mode);
    assert.deepEqual(requester.provenance(), provenance, mode);
    assert.deepEqual(requester.usageRecords(), usage, mode);
    if (mode === 'resolve') assert.equal(bodyCancelled, true);
  }
});

test('the model requester absolute deadline also bounds a signal-ignoring retry wait', async () => {
  const requester = create(
    async () => new Response('{}', { status: 503 }),
    () => new Promise<void>(() => {}),
  );
  await requester.initialize({
    trajectoryId: 'retry-wait-deadline', items: [task('Q1')], maxTicks: 1,
  });
  const error = await rejectedWithin(requester.nextTick({
    tick: 1, phase: 1, deadlineMs: Date.now() + 20,
  }));
  assert.match(String(error), /timed out/i);
  assert.equal(requester.usageRecords().length, 1);
  assert.equal(requester.usageRecords()[0]?.outcome, 'timeout');
});
