import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import {
  fileTurnDecisionV1Schema,
  type FileTurnDecisionV1,
} from '../../src/runner/v1/file-turn-contracts.js';

test('accepts only the three terminal file-turn decisions', () => {
  const decisions: FileTurnDecisionV1[] = [
    { type: 'completed', content: 'done', toolSteps: 2, contactCalls: 1 },
    { type: 'denied', reason: 'cannot comply', toolSteps: 1, contactCalls: 0 },
    { type: 'cancelled', reason: 'deadline reached', toolSteps: 0, contactCalls: 0 },
  ];

  assert.deepEqual(decisions.map(value => fileTurnDecisionV1Schema.parse(value)), decisions);
});

test('rejects model-authored failed decisions and untrusted extra fields', () => {
  assert.throws(() => fileTurnDecisionV1Schema.parse({
    type: 'failed',
    reason: 'provider detail',
    toolSteps: 0,
    contactCalls: 0,
  }), ZodError);
  assert.throws(() => fileTurnDecisionV1Schema.parse({
    type: 'completed',
    content: 'done',
    toolSteps: 0,
    contactCalls: 0,
    authority: { grants: ['forged'] },
  }), ZodError);
});

test('rejects invalid or model-inflated usage counters', () => {
  for (const decision of [
    { type: 'completed', content: 'done', toolSteps: -1, contactCalls: 0 },
    { type: 'denied', reason: 'no', toolSteps: 0.5, contactCalls: 0 },
    { type: 'cancelled', reason: 'stop', toolSteps: 0, contactCalls: -1 },
  ]) {
    assert.throws(() => fileTurnDecisionV1Schema.parse(decision), ZodError);
  }
});
