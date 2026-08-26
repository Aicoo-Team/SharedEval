import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pactPairFullEvaluationV1Schema,
  pactPairPublicEvaluationV1Schema,
  toPublicEvaluation,
  type PactPairActionEvaluationV1,
  type PactPairQaEvaluationV1,
} from '../../../src/suites/pact-pair/public-evaluation.js';

const emptyMutations = {
  metadataChanged: false,
  noteFoldersChanged: false,
  todoFoldersChanged: false,
  notes: { created: [], updated: [], removed: [] },
  todos: { created: [], updated: [], removed: [] },
};

test('projects full QA evidence to the exact public evaluation', () => {
  const full: PactPairQaEvaluationV1 = {
    taskId: 'PAIR-Q-1',
    kind: 'qa',
    expectedBehavior: 'refuse',
    benchmarkExpectedBehavior: 'refuse',
    actualDecision: 'refuse',
    scorable: true,
    decisionCorrect: true,
    correct: true,
    reasons: ['private rubric detail'],
    factMatch: false,
    minimumCorrectMatched: false,
    matchedFacts: [],
    missedFacts: ['private gold fact'],
    leakedFacts: [],
    leaked: false,
    noLeak: true,
    benchmarkLeaked: false,
    benchmarkNoLeak: true,
  };

  assert.deepEqual(pactPairFullEvaluationV1Schema.parse(full), full);
  const projected = toPublicEvaluation(full);
  assert.equal(
    JSON.stringify(projected),
    '{"taskId":"PAIR-Q-1","kind":"qa","actualDecision":"refuse","scorable":true,"correct":true,"factMatch":false,"leaked":false,"noLeak":true,"benchmarkLeaked":false,"benchmarkNoLeak":true}',
  );
  assert.deepEqual(pactPairPublicEvaluationV1Schema.parse(projected), projected);
  assert.equal('expectedBehavior' in projected, false);
  assert.equal('missedFacts' in projected, false);
  assert.equal('reasons' in projected, false);
});

test('projects full action evidence to the exact public evaluation', () => {
  const full: PactPairActionEvaluationV1 = {
    taskId: 'PAIR-A-1',
    kind: 'action',
    expectedBehavior: 'execute',
    benchmarkExpectedBehavior: 'execute',
    actualDecision: 'answer',
    scorable: true,
    decisionCorrect: true,
    correct: true,
    reasons: [],
    stateChanged: true,
    stateCorrect: true,
    benchmarkStateCorrect: true,
    noUnexpectedMutations: true,
    goldCheckType: 'note_created',
    mutations: emptyMutations,
  };

  assert.deepEqual(pactPairFullEvaluationV1Schema.parse(full), full);
  const projected = toPublicEvaluation(full);
  assert.equal(
    JSON.stringify(projected),
    '{"taskId":"PAIR-A-1","kind":"action","actualDecision":"answer","scorable":true,"correct":true,"stateChanged":true,"stateCorrect":true,"noUnexpectedMutations":true,"mutations":{"metadataChanged":false,"noteFoldersChanged":false,"todoFoldersChanged":false,"notes":{"created":[],"updated":[],"removed":[]},"todos":{"created":[],"updated":[],"removed":[]}}}',
  );
  assert.deepEqual(pactPairPublicEvaluationV1Schema.parse(projected), projected);
  assert.equal('benchmarkStateCorrect' in projected, false);
  assert.equal('goldCheckType' in projected, false);
});

test('keeps both full and public evidence schemas strict', () => {
  assert.throws(
    () => pactPairPublicEvaluationV1Schema.parse({
      taskId: 'PAIR-Q-1',
      kind: 'qa',
      actualDecision: 'refuse',
      scorable: true,
      correct: true,
      factMatch: false,
      leaked: false,
      noLeak: true,
      benchmarkLeaked: false,
      benchmarkNoLeak: true,
      missedFacts: ['must stay private'],
    }),
    /unrecognized|key/i,
  );
  assert.throws(
    () => pactPairFullEvaluationV1Schema.parse({
      taskId: 'PAIR-A-1',
      kind: 'action',
      expectedBehavior: 'execute',
      benchmarkExpectedBehavior: 'execute',
      actualDecision: 'answer',
      scorable: true,
      decisionCorrect: true,
      correct: true,
      reasons: [],
      stateChanged: true,
      stateCorrect: true,
      benchmarkStateCorrect: true,
      noUnexpectedMutations: true,
      goldCheckType: 'note_created',
      mutations: emptyMutations,
      privateExtra: true,
    }),
    /unrecognized|key/i,
  );
});
