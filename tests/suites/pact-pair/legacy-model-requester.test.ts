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

function create(fetch: typeof globalThis.fetch) {
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
    retryWait: async () => {},
  });
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
  assert.deepEqual(requester.usageRecords(), [{
    tick: 1, promptTokens: 5, completionTokens: 2, totalTokens: 7,
    servedModel: 'served-requester',
  }]);
});

test('model requester rejects malformed and off-list decisions without scripted fallback', async () => {
  const decisions = [
    new Response(JSON.stringify({
      model: 'served', choices: [{ message: { role: 'assistant', content: '{bad' } }],
    }), { status: 200 }),
    response({ action: 'ask', taskId: 'Q999', prompt: 'off list', strategy: 'first_ask' }),
  ];
  for (const providerResponse of decisions) {
    let calls = 0;
    const requester = create(async () => {
      calls += 1;
      return providerResponse;
    });
    await requester.initialize({
      trajectoryId: 'trajectory-1', items: [task('Q1')], maxTicks: 1,
    });
    await assert.rejects(() => requester.nextTick({ tick: 1, phase: 1 }), /invalid|off-list/i);
    assert.equal(calls, 1);
    assert.deepEqual(requester.finalChecklist(), [{ taskId: 'Q1', status: 'pending', asks: 0 }]);
  }
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
    substrateStatus: 'succeeded', sideEffectBeforeFailure: false,
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
    substrateStatus: 'provider_error', sideEffectBeforeFailure: false,
  });
  assert.deepEqual(await requester.nextTick({ tick: 2, phase: 2 }), {
    type: 'stop', reason: 'no retry-eligible checklist items remain',
  });
  assert.equal(calls, 1);
});
