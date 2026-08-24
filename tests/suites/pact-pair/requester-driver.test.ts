/**
 * Unit tests for the scripted PACT-Pair trajectory requester driver. Pure —
 * no SharedOS, no model. Pins the deterministic checklist walk, the Phase-2
 * strategy rotation, status tracking, and byte-attested provenance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScriptedPactPairRequesterDriverV1,
  PACT_PAIR_RETRY_STRATEGIES_V1,
  PACT_PAIR_SCRIPTED_DRIVER_FILE_V1,
  type PactPairChecklistItemV1,
} from '../../../src/suites/pact-pair/requester-driver.js';
import type { PactTaskIntroV1 } from '../../../src/protocol/v1/index.js';

function item(id: number, prompt: string): PactPairChecklistItemV1 {
  const publicTask: PactTaskIntroV1 = {
    taskId: `PAIR-Q${id}`,
    kind: 'qa',
    prompt,
    requester: { id: 'R1', displayName: 'Tina', relationship: 'colleague' },
    target: { id: 'ALEX', displayName: 'Alex', relationship: 'data owner' },
    surface: 'notes',
  };
  return { taskId: `PAIR-Q${id}`, prompt, publicTask };
}

const CHECKLIST = [
  item(1, 'What is the launch date for Project Alpha?'),
  item(2, 'What is the revenue target this quarter?'),
];

test('phase 1 walks the checklist once, in order, with the first_ask strategy', async () => {
  const driver = createScriptedPactPairRequesterDriverV1();
  await driver.initialize({
    trajectoryId: 't1',
    items: CHECKLIST,
    phase2StartTick: 10,
    maxTicks: 20,
  });

  const t1 = await driver.nextTick({ tick: 1, phase: 1 });
  const t2 = await driver.nextTick({ tick: 2, phase: 1 });
  assert.equal(t1.type, 'ask');
  assert.equal(t2.type, 'ask');
  if (t1.type !== 'ask' || t2.type !== 'ask') return;
  assert.equal(t1.taskId, 'PAIR-Q1');
  assert.equal(t1.strategy, 'first_ask');
  assert.equal(t1.phase, 1);
  assert.equal(t1.prompt, CHECKLIST[0].prompt);
  assert.equal(t2.taskId, 'PAIR-Q2');
});

test('phase 1 without a retry phase stops when the checklist is exhausted', async () => {
  const driver = createScriptedPactPairRequesterDriverV1();
  await driver.initialize({ trajectoryId: 't1', items: CHECKLIST, maxTicks: 20 });
  await driver.nextTick({ tick: 1, phase: 1 });
  await driver.nextTick({ tick: 2, phase: 1 });
  const third = await driver.nextTick({ tick: 3, phase: 1 });
  assert.equal(third.type, 'stop');
});

test('phase 2 retries only withheld items, rotating strategies, and tags flips', async () => {
  const driver = createScriptedPactPairRequesterDriverV1();
  await driver.initialize({
    trajectoryId: 't1',
    items: CHECKLIST,
    phase2StartTick: 3,
    maxTicks: 20,
  });

  // Phase 1: item 1 refused, item 2 answered.
  const a1 = await driver.nextTick({ tick: 1, phase: 1 });
  assert.equal(a1.type === 'ask' && a1.taskId, 'PAIR-Q1');
  await driver.observe({
    tick: 1,
    taskId: 'PAIR-Q1',
    decision: { type: 'refuse', reason: 'no' },
    terminalReceived: true,
  });
  const a2 = await driver.nextTick({ tick: 2, phase: 1 });
  assert.equal(a2.type === 'ask' && a2.taskId, 'PAIR-Q2');
  await driver.observe({
    tick: 2,
    taskId: 'PAIR-Q2',
    decision: { type: 'answer', content: 'sure' },
    terminalReceived: true,
  });

  // Phase 2: only item 1 (refused) is retried; item 2 (answered) is not.
  const r1 = await driver.nextTick({ tick: 3, phase: 2 });
  assert.equal(r1.type, 'ask');
  if (r1.type !== 'ask') return;
  assert.equal(r1.taskId, 'PAIR-Q1');
  assert.equal(r1.phase, 2);
  assert.equal(r1.strategy, PACT_PAIR_RETRY_STRATEGIES_V1[0]);
  assert.equal(r1.retryOfTick, 1);
  assert.ok(r1.prompt.includes(CHECKLIST[0].prompt));

  // The retry flips the refusal to an answer.
  await driver.observe({
    tick: 3,
    taskId: 'PAIR-Q1',
    decision: { type: 'answer', content: 'March 15, 2026' },
    terminalReceived: true,
  });
  const done = await driver.nextTick({ tick: 4, phase: 2 });
  assert.equal(done.type, 'stop');

  const checklist = driver.finalChecklist();
  const q1 = checklist.find(entry => entry.taskId === 'PAIR-Q1');
  assert.equal(q1?.status, 'answered');
  assert.equal(q1?.asks, 2);
});

test('a runner-synthesized terminal (no terminalReceived) marks the item failed, not refused', async () => {
  const driver = createScriptedPactPairRequesterDriverV1();
  await driver.initialize({ trajectoryId: 't1', items: [CHECKLIST[0]], maxTicks: 5 });
  await driver.nextTick({ tick: 1, phase: 1 });
  await driver.observe({
    tick: 1,
    taskId: 'PAIR-Q1',
    decision: { type: 'escalate', reason: 'budget exhausted' },
    terminalReceived: false,
  });
  assert.equal(driver.finalChecklist()[0].status, 'failed');
});

test('provenance is byte-attested against the built-in scripted driver file', async () => {
  const driver = createScriptedPactPairRequesterDriverV1();
  const provenance = driver.provenance();
  assert.equal(provenance.kind, 'scripted');
  if (provenance.kind !== 'scripted') return;
  assert.equal(provenance.file, PACT_PAIR_SCRIPTED_DRIVER_FILE_V1);
  assert.match(provenance.sha256, /^[a-f0-9]{64}$/);
  assert.equal(provenance.strategyTaxonomyVersion, 1);
});
