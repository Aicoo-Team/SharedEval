import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PactTaskIntroV1 } from '../../../src/protocol/v1/index.js';
import { freezeLegacyAssetV1 } from '../../../src/suites/pact-pair/legacy-transcript/assets.js';
import {
  createScriptedLegacyRequesterDriverV1,
  isLegacyRetryEligibleV1,
} from '../../../src/suites/pact-pair/legacy-transcript/requester-driver.js';

function publicTask(taskId: string): PactTaskIntroV1 {
  return {
    taskId,
    kind: 'qa',
    surface: 'notes',
    prompt: `Prompt ${taskId}`,
    requester: { id: 'R4', displayName: 'Dana Reeves', relationship: 'investor' },
    target: { id: 'ALEX', displayName: 'Alex Chen', relationship: 'owner' },
  };
}

async function driver() {
  const script = await freezeLegacyAssetV1(
    process.cwd(),
    'dataset/pact-pair/legacy-transcript/scripted_driver_v1.json',
    'script',
  );
  const created = createScriptedLegacyRequesterDriverV1({
    script,
    principalId: 'requester:R4',
  });
  await created.initialize({
    trajectoryId: 'trajectory-1',
    items: [publicTask('Q1'), publicTask('Q2')],
    phase2StartTick: 3,
    maxTicks: 7,
  });
  return created;
}

test('scripted requester asks the frozen public checklist once in exact order', async () => {
  const requester = await driver();
  assert.deepEqual(await requester.nextTick({ tick: 1, phase: 1 }), {
    type: 'ask',
    taskId: 'Q1',
    prompt: 'Prompt Q1',
    phase: 1,
    strategy: 'first_ask',
    principalId: 'requester:R4',
  });
  await requester.observe({
    tick: 1,
    taskId: 'Q1',
    terminalReceived: true,
    decision: { type: 'answer', content: 'answer' },
    substrateStatus: 'succeeded',
    sideEffectBeforeFailure: false,
    stateChanged: false,
  });
  const second = await requester.nextTick({ tick: 2, phase: 1 });
  assert.equal(second.type, 'ask');
  if (second.type !== 'ask') assert.fail('expected second checklist ask');
  assert.equal(second.taskId, 'Q2');
});

test('retry eligibility is exactly responder-authored terminal refuse or escalate', () => {
  const cases = [
    [{ terminalReceived: true, decision: { type: 'refuse', reason: 'no' }, substrateStatus: 'succeeded', sideEffectBeforeFailure: false, stateChanged: false }, true],
    [{ terminalReceived: true, decision: { type: 'escalate', reason: 'review' }, substrateStatus: 'succeeded', sideEffectBeforeFailure: false, stateChanged: false }, true],
    [{ terminalReceived: true, decision: { type: 'refuse', reason: 'mutated' }, substrateStatus: 'succeeded', sideEffectBeforeFailure: false, stateChanged: true }, false],
    [{ terminalReceived: true, decision: { type: 'escalate', reason: 'mutated' }, substrateStatus: 'succeeded', sideEffectBeforeFailure: false, stateChanged: true }, false],
    [{ terminalReceived: true, decision: { type: 'answer', content: 'yes' }, substrateStatus: 'succeeded', sideEffectBeforeFailure: false, stateChanged: false }, false],
    [{ terminalReceived: false, decision: { type: 'refuse', reason: 'synthetic' }, substrateStatus: 'budget', sideEffectBeforeFailure: false, stateChanged: false }, false],
    [{ terminalReceived: false, decision: { type: 'escalate', reason: 'denied' }, substrateStatus: 'denied', sideEffectBeforeFailure: false, stateChanged: false }, false],
    [{ terminalReceived: false, decision: { type: 'escalate', reason: 'failed' }, substrateStatus: 'failed', sideEffectBeforeFailure: false, stateChanged: false }, false],
    [{ terminalReceived: false, decision: { type: 'refuse', reason: 'no' }, substrateStatus: 'failed', sideEffectBeforeFailure: true, stateChanged: true }, false],
  ] as const;
  for (const [input, expected] of cases) {
    assert.equal(isLegacyRetryEligibleV1(input), expected);
  }
});

test('phase 2 retries only eligible items and never revives a failed item', async () => {
  const requester = await driver();
  await requester.nextTick({ tick: 1, phase: 1 });
  await requester.observe({
    tick: 1,
    taskId: 'Q1',
    terminalReceived: false,
    decision: { type: 'escalate', reason: 'provider failure' },
    substrateStatus: 'failed',
    sideEffectBeforeFailure: false,
    stateChanged: false,
  });
  await requester.nextTick({ tick: 2, phase: 1 });
  await requester.observe({
    tick: 2,
    taskId: 'Q2',
    terminalReceived: true,
    decision: { type: 'refuse', reason: 'private' },
    substrateStatus: 'succeeded',
    sideEffectBeforeFailure: false,
    stateChanged: false,
  });
  const retry = await requester.nextTick({ tick: 3, phase: 2 });
  assert.deepEqual(retry, {
    type: 'ask',
    taskId: 'Q2',
    prompt: "I'm asking again: Prompt Q2",
    phase: 2,
    strategy: 'repeat',
    retryOfTick: 2,
    principalId: 'requester:R4',
  });
  await requester.observe({
    tick: 3,
    taskId: 'Q2',
    terminalReceived: true,
    decision: { type: 'answer', content: 'now answered' },
    substrateStatus: 'succeeded',
    sideEffectBeforeFailure: false,
    stateChanged: false,
  });
  assert.deepEqual(await requester.nextTick({ tick: 4, phase: 2 }), {
    type: 'stop',
    reason: 'no retry-eligible checklist items remain',
  });
});
