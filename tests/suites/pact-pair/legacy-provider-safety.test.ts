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

function responder(fetch: typeof globalThis.fetch, attempts: number[] = []) {
  return new PersistentLegacyResponderSessionV1({
    model: {
      provider: 'openai-compatible', baseUrl: 'https://example.test/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY', model: 'requested', maxOutputTokens: 100,
    },
    credential: 's3cr3t', requesterId: 'R4',
    persona: { coo: 'coo', policy: 'policy', memory: 'memory' },
    tools: [], fetch,
    retryWait: async delay => { attempts.push(delay); },
    maxProviderAttempts: 3,
  });
}

async function firstStep(
  instance: PersistentLegacyResponderSessionV1,
  deadlineMs = Date.now() + 500,
) {
  await instance.initialize({ sessionId: 's1', publicChecklist: [task] });
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
  const started = Date.now();
  await assert.rejects(() => firstStep(instance, Date.now() + 30), /timed out/i);
  assert.ok(Date.now() - started < 250);
});
