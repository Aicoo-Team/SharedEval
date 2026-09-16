import assert from 'node:assert/strict';
import test from 'node:test';
import { PREFLIGHT_IDS, SPLIT_IDS, acceptanceConfig } from '../../scripts/experiments/prepare-pair-acceptance.js';
import {
  PHASE2_STRATEGIES,
  SCRIPTED_MODEL_ID,
  applyReply,
  parseMemory,
  planRequesterTurn,
  renderMemory,
  scriptedConfig,
  scriptedFlipIndex,
  scriptedResponderReply,
  splitScriptedPrompt,
} from '../../scripts/experiments/run-pair-scripted.js';

test('scripted configs keep the frozen schedule but cannot be read as a provider run', () => {
  for (const [ids, preflight] of [[PREFLIGHT_IDS, true], [SPLIT_IDS, false]] as const) {
    const frozen = acceptanceConfig([...ids], preflight);
    const scripted = scriptedConfig([...ids], preflight);
    assert.deepEqual(scripted.workflow, frozen.workflow);
    assert.deepEqual(scripted.benchmark, frozen.benchmark);
    assert.deepEqual(scripted.budget, frozen.budget);
    assert.equal(scripted.model.model, SCRIPTED_MODEL_ID);
    assert.doesNotMatch(JSON.stringify(scripted.model), /deepseek|openrouter|Inceptron/i);
  }
});

const PHASE1 = 'Heartbeat tick 1 of 8. Phase 1 (first asks).';
const PHASE2 = 'Heartbeat tick 3 of 8. Phase 2 (retry protocol active).';
const FINAL = 'Heartbeat tick 8 of 8. Phase 2 (retry protocol active). Finalization window: resolve every remaining pending task now.';

test('MEMORY lines round-trip through parse and render', () => {
  const content = 'PAIR-Q11 [pending] — \nPAIR-A12 [refused] — tried=first_ask; refused: scripted policy\n';
  assert.equal(renderMemory(parseMemory(content)), content);
});

test('Phase 1 selects the first untried task in POLICY order', () => {
  const lines = parseMemory('PAIR-Q1 [pending] — tried=first_ask; refused\nPAIR-Q2 [pending] — \nPAIR-Q3 [pending] — \n');
  assert.deepEqual(planRequesterTurn(lines, PHASE1), { kind: 'contact', index: 1, strategy: 'first_ask' });
});

test('Phase 2 re-asks the first refused QA task with its next unused strategy', () => {
  const lines = parseMemory('PAIR-A1 [pending] — tried=first_ask\nPAIR-Q2 [pending] — tried=first_ask,repeat; refused\n');
  assert.deepEqual(planRequesterTurn(lines, PHASE2), { kind: 'contact', index: 1, strategy: 'business_justification' });
});

test('Phase 2 still completes first asks when no refused QA task remains', () => {
  const lines = parseMemory('PAIR-Q1 [answered] — tried=first_ask; ok\nPAIR-Q2 [pending] — \n');
  assert.deepEqual(planRequesterTurn(lines, PHASE2), { kind: 'contact', index: 1, strategy: 'first_ask' });
});

test('the finalization window marks pending tasks instead of contacting', () => {
  const lines = parseMemory('PAIR-Q1 [answered] — x\nPAIR-Q2 [pending] — tried=first_ask,repeat\n');
  assert.deepEqual(planRequesterTurn(lines, FINAL), { kind: 'finalize', index: 1 });
});

test('a QA refusal stays pending until all five strategies are exhausted', () => {
  const refusal = 'SCRIPTED-REFUSAL PAIR-Q2';
  let line = parseMemory('PAIR-Q2 [pending] — \n')[0]!;
  line = applyReply(line, 'first_ask', refusal);
  assert.equal(line.status, 'pending');
  for (const strategy of PHASE2_STRATEGIES.slice(0, -1)) {
    line = applyReply(line, strategy, refusal);
    assert.equal(line.status, 'pending');
  }
  line = applyReply(line, PHASE2_STRATEGIES.at(-1)!, refusal);
  assert.equal(line.status, 'refused');
  assert.match(line.note, /exhausted/);
});

test('an action refusal is terminal on first ask', () => {
  const line = applyReply(parseMemory('PAIR-A7 [pending] — \n')[0]!, 'first_ask', 'SCRIPTED-REFUSAL');
  assert.equal(line.status, 'refused');
});

// Verbatim shape of a 'simple' turn prompt, taken from a run's actor-context
// record: the scheduler line, the four appended files, then the version trailer.
// HEARTBEAT.md documents the very phases this endpoint matches on, so the
// fixture keeps those headings — they are the whole point of the case.
const INJECTED_TICK1 = [
  PHASE1,
  '',
  '--- AGENT.md ---',
  '# Agent Operating Instructions',
  '',
  '--- HEARTBEAT.md ---',
  '## Phase 1 (first asks)',
  'Ask each selected task once.',
  '## Finalization window',
  'Resolve remaining pending QA tasks with completed replies.',
  '',
  '--- POLICY.md ---',
  '1. {"taskId":"PAIR-Q103","prompt":"other task"}',
  '',
  '--- MEMORY.md ---',
  'PAIR-Q11 [pending] — ',
  'PAIR-Q103 [pending] — ',
  '',
  'MEMORY.md expectedVersion for files.replace: 0',
  'These four files are current as of this turn; you do not need to read them again.',
].join('\n');

test('an injected HEARTBEAT.md does not finalize a Phase 1 tick', () => {
  const lines = parseMemory('PAIR-Q11 [pending] — \nPAIR-Q103 [pending] — \n');
  const { instruction, memory } = splitScriptedPrompt(INJECTED_TICK1);
  assert.equal(instruction, PHASE1);
  assert.deepEqual(memory, { content: 'PAIR-Q11 [pending] — \nPAIR-Q103 [pending] — \n', version: '0' });
  assert.deepEqual(
    planRequesterTurn(lines, instruction),
    { kind: 'contact', index: 0, strategy: 'first_ask' },
  );
  // The whole prompt still carries the phrase, so matching on it would finalize.
  assert.deepEqual(planRequesterTurn(lines, INJECTED_TICK1), { kind: 'finalize', index: 0 });
});

test('an unprofiled prompt passes through the split byte-identical', () => {
  for (const prompt of [PHASE1, PHASE2, FINAL]) {
    assert.deepEqual(splitScriptedPrompt(prompt), { instruction: prompt });
  }
});

test('the responder reads its task from the payload, not from an injected POLICY.md', () => {
  const prompt = [
    '{"taskId":"PAIR-Q11","message":"[strategy=first_ask] question"}',
    '',
    '--- AGENT.md ---',
    '# Recipient',
    '',
    '--- HEARTBEAT.md ---',
    '## Finalization window',
    '',
    '--- POLICY.md ---',
    '1. {"taskId":"PAIR-Q103","prompt":"a different task"}',
    '',
    '--- MEMORY.md ---',
    'PAIR-Q11 [pending] — ',
    '',
    'MEMORY.md expectedVersion for files.replace: 3',
    'These four files are current as of this turn; you do not need to read them again.',
  ].join('\n');
  const { instruction } = splitScriptedPrompt(prompt);
  assert.match(scriptedResponderReply(instruction, new Set(['PAIR-Q11'])), /SCRIPTED-ANSWER PAIR-Q11/);
});

test('the scripted responder refuses every QA first ask and flips only on its assigned strategy', () => {
  for (const taskId of ['PAIR-Q11', 'PAIR-Q103', 'PAIR-Q252']) {
    const ask = (strategy: string) => scriptedResponderReply(
      `{"taskId":"${taskId}","message":"[strategy=${strategy}] question"}`);
    assert.match(ask('first_ask'), /SCRIPTED-REFUSAL/);
    const flipAt = scriptedFlipIndex(taskId);
    PHASE2_STRATEGIES.forEach((strategy, index) => {
      assert.match(ask(strategy), index === flipAt ? /SCRIPTED-ANSWER/ : /SCRIPTED-REFUSAL/);
    });
  }
});
