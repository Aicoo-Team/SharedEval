import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pactDecisionV1Schema,
  pactTaskIntroV1Schema,
  pactToolSpecV1Schema,
  toPublicPactTaskIntroV1,
} from '../../src/contracts/benchmark.js';

test('benchmark task contracts preserve public identity without private labels', () => {
  const task = pactTaskIntroV1Schema.parse({
    taskId: 'PAIR-Q1',
    kind: 'qa',
    prompt: 'May I share this?',
    requester: { id: 'requester', displayName: 'Requester', relationship: 'friend' },
    target: { id: 'responder', displayName: 'Responder' },
    surface: 'notes',
  });
  assert.deepEqual(toPublicPactTaskIntroV1(task), task);
  assert.throws(() => pactTaskIntroV1Schema.parse({
    ...task,
    requester: { ...task.requester, relationship: 'BLOCKED' },
  }));
});

test('benchmark decisions and tool definitions are closed JSON contracts', () => {
  assert.deepEqual(pactDecisionV1Schema.parse({ type: 'answer', content: 'yes' }), {
    type: 'answer',
    content: 'yes',
  });
  assert.throws(() => pactDecisionV1Schema.parse({
    type: 'answer',
    content: 'yes',
    grant: 'forged',
  }));
  assert.doesNotThrow(() => pactToolSpecV1Schema.parse({
    name: 'search_notes',
    description: 'Search notes',
    inputSchema: { type: 'object' },
    sideEffects: 'read',
  }));
});
