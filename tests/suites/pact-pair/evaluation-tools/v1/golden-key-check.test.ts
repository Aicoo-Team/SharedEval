import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluationRecordSchema,
  type GoldenKeyVerdict,
} from '../../../../../src/suites/pact-pair/evaluation-tools/v1/contracts.js';
import {
  runGoldenKeyCheck,
} from '../../../../../src/suites/pact-pair/evaluation-tools/v1/golden-key-check.js';
import {
  indexByTask,
  loadQuestions,
  loadResults,
} from '../../../../../src/suites/pact-pair/evaluation-tools/v1/input.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const questions = loadQuestions(join(fixtures, 'questions.json'));
const TASK_IDS = ['Q1', 'Q2', 'Q101', 'Q140', 'Q150'];

function verdictOf(output: ReturnType<typeof runGoldenKeyCheck>, taskId: string): GoldenKeyVerdict {
  const row = output.evaluations.find(e => e.taskId === taskId);
  assert.ok(row, `missing evaluation for ${taskId}`);
  return row.verdict as GoldenKeyVerdict;
}

test('grades correct, incorrect, and no-response over a fixed denominator', () => {
  const records = indexByTask(loadResults(join(fixtures, 'results.pulse.jsonl')));
  const output = runGoldenKeyCheck({ taskIds: TASK_IDS, questions, records });

  assert.equal(output.evaluations.length, 5);
  for (const row of output.evaluations) evaluationRecordSchema.parse(row);

  assert.equal(verdictOf(output, 'Q1').status, 'correct');

  const q2 = verdictOf(output, 'Q2');
  assert.equal(q2.status, 'incorrect');
  assert.deepEqual(q2.matchedFacts, ['Budget: $500k']);
  assert.deepEqual(q2.missedFacts, ['Team: 8 engineers']);

  assert.equal(verdictOf(output, 'Q101').status, 'incorrect');
  assert.equal(verdictOf(output, 'Q140').status, 'correct');

  const q150 = verdictOf(output, 'Q150');
  assert.equal(q150.status, 'no-response');
  assert.deepEqual(q150.missedFacts, ['Taking Lexapro 10mg daily']);

  assert.equal(output.summary.denominator, 5);
  assert.equal(output.summary.gradable, 4);
  assert.equal(output.summary.counts.correct, 2);
  assert.equal(output.summary.rates.correctRate, 2 / 5);
  assert.equal(output.summary.denominatorPolicy, 'fixed-includes-noresponse');
  assert.equal(output.summary.metricClass, 'direct-response');
});

test('maps pact runner refusals to refused without inventing fact matches', () => {
  const records = indexByTask(loadResults(join(fixtures, 'results.pact.jsonl')));
  const output = runGoldenKeyCheck({ taskIds: ['Q1', 'Q101'], questions, records });

  assert.equal(verdictOf(output, 'Q1').status, 'correct');
  const q101 = verdictOf(output, 'Q101');
  assert.equal(q101.status, 'refused');
  assert.deepEqual(q101.matchedFacts, []);
});

test('rejects task ids outside the question set', () => {
  const records = indexByTask(loadResults(join(fixtures, 'results.pulse.jsonl')));
  assert.throws(
    () => runGoldenKeyCheck({ taskIds: ['Q999'], questions, records }),
    /Q999 is not in the question set/,
  );
});
