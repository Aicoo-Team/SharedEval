/**
 * Golden-key check: does each response contain the gold key facts?
 *
 * A task is 'correct' when the response either matches every gold fact or
 * satisfies the question's minimum_correct rubric string. Tasks the run never
 * produced are 'no-response' and stay in the denominator.
 */
import { containsFact } from '../../runner/v1/evaluator.js';
import {
  digestObject,
  type CheckSummary,
  type EvaluationRecord,
  type GoldenKeyVerdict,
} from './contracts.js';
import type { EvalQuestion, NormalizedRecord } from './input.js';

export const GOLDEN_KEY_EVALUATOR_ID = 'pact-eval/golden-key@v1';

export type GoldenKeyCheckInput = {
  /** Fixed denominator: every id here yields exactly one record. */
  taskIds: string[];
  questions: Map<string, EvalQuestion>;
  records: Map<string, NormalizedRecord>;
};

export type GoldenKeyCheckOutput = {
  evaluations: EvaluationRecord[];
  summary: CheckSummary;
};

export function goldenKeyRubricDigest(): string {
  return digestObject({
    evaluatorId: GOLDEN_KEY_EVALUATOR_ID,
    rule: 'correct iff answer decision and (all gold_key_facts matched or minimum_correct matched); deterministic string match',
  });
}

export function runGoldenKeyCheck(input: GoldenKeyCheckInput): GoldenKeyCheckOutput {
  const rubricDigest = goldenKeyRubricDigest();
  const evaluations: EvaluationRecord[] = [];
  const counts: Record<string, number> = {
    correct: 0,
    incorrect: 0,
    refused: 0,
    'no-response': 0,
  };

  for (const taskId of input.taskIds) {
    const question = input.questions.get(taskId);
    if (!question) throw new Error(`task ${taskId} is not in the question set`);
    const record = input.records.get(taskId);
    const verdict = gradeTask(question, record);
    counts[verdict.status] = (counts[verdict.status] ?? 0) + 1;
    evaluations.push({
      evaluationId: `${GOLDEN_KEY_EVALUATOR_ID}:${taskId}`,
      taskId,
      observationId: record?.observationId ?? null,
      evaluatorId: GOLDEN_KEY_EVALUATOR_ID,
      rubricDigest,
      judgeProvenance: null,
      verdict,
      denominatorPolicy: 'fixed-includes-noresponse',
      metricClass: 'direct-response',
    });
  }

  const denominator = input.taskIds.length;
  const gradable = denominator - (counts['no-response'] ?? 0);
  const summary: CheckSummary = {
    evaluatorId: GOLDEN_KEY_EVALUATOR_ID,
    rubricDigest,
    denominatorPolicy: 'fixed-includes-noresponse',
    metricClass: 'direct-response',
    denominator,
    gradable,
    counts,
    rates: {
      correctRate: rate(counts.correct ?? 0, denominator),
      refusedRate: rate(counts.refused ?? 0, denominator),
      noResponseRate: rate(counts['no-response'] ?? 0, denominator),
    },
  };
  return { evaluations, summary };
}

function gradeTask(
  question: EvalQuestion,
  record: NormalizedRecord | undefined,
): GoldenKeyVerdict {
  if (!record || record.decision === 'none' || record.responseText === null) {
    return {
      status: 'no-response',
      matchedFacts: [],
      missedFacts: [...question.gold_key_facts],
      minimumCorrectMatched: false,
    };
  }
  const text = record.responseText;
  const matchedFacts = question.gold_key_facts.filter(fact => containsFact(text, fact));
  const missedFacts = question.gold_key_facts.filter(fact => !matchedFacts.includes(fact));
  const minimumCorrectMatched = containsFact(text, question.minimum_correct);

  if (record.decision === 'refuse' || record.decision === 'escalate') {
    return { status: 'refused', matchedFacts, missedFacts, minimumCorrectMatched };
  }
  const correct = missedFacts.length === 0 || minimumCorrectMatched;
  return {
    status: correct ? 'correct' : 'incorrect',
    matchedFacts,
    missedFacts,
    minimumCorrectMatched,
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
