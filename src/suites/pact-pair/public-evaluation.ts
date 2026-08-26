import { z } from 'zod';
import type { PairAction } from './schemas.js';
import type {
  PactPairActionExpectationV1,
  PactPairQaExpectationV1,
} from './task-loader.js';

export type PactPairActualDecisionV1 =
  | 'answer'
  | 'refuse'
  | 'escalate'
  | 'none';

export type PactPairRecordDiffV1 = {
  created: number[];
  updated: number[];
  removed: number[];
};

export type PactPairMutationSummaryV1 = {
  metadataChanged: boolean;
  noteFoldersChanged: boolean;
  todoFoldersChanged: boolean;
  notes: PactPairRecordDiffV1;
  todos: PactPairRecordDiffV1;
};

type PactPairEvaluationBaseV1 = {
  taskId: string;
  expectedBehavior: PactPairQaExpectationV1 | PactPairActionExpectationV1;
  actualDecision: PactPairActualDecisionV1;
  scorable: boolean;
  decisionCorrect: boolean;
  correct: boolean;
  reasons: string[];
};

export type PactPairQaEvaluationV1 = PactPairEvaluationBaseV1 & {
  kind: 'qa';
  expectedBehavior: PactPairQaExpectationV1;
  benchmarkExpectedBehavior: Exclude<PactPairQaExpectationV1, 'either'>;
  factMatch: boolean;
  minimumCorrectMatched: boolean;
  matchedFacts: string[];
  missedFacts: string[];
  leakedFacts: string[];
  leaked: boolean;
  noLeak: boolean;
  benchmarkLeaked: boolean;
  benchmarkNoLeak: boolean;
};

export type PactPairActionEvaluationV1 = PactPairEvaluationBaseV1 & {
  kind: 'action';
  expectedBehavior: PactPairActionExpectationV1;
  benchmarkExpectedBehavior: PactPairActionExpectationV1;
  stateChanged: boolean;
  /** State correctness under the active (possibly requester-conditioned) contract. */
  stateCorrect: boolean;
  /** State correctness under the fixed canonical benchmark contract. */
  benchmarkStateCorrect: boolean;
  noUnexpectedMutations: boolean;
  /** Gold check used by the active contract. */
  goldCheckType: PairAction['gold_check']['type'];
  mutations: PactPairMutationSummaryV1;
};

export type PactPairEvaluationV1 =
  | PactPairQaEvaluationV1
  | PactPairActionEvaluationV1;

export type PactPairPublicQaEvaluationV1 = Pick<
  PactPairQaEvaluationV1,
  | 'taskId'
  | 'kind'
  | 'actualDecision'
  | 'scorable'
  | 'correct'
  | 'factMatch'
  | 'leaked'
  | 'noLeak'
  | 'benchmarkLeaked'
  | 'benchmarkNoLeak'
>;

export type PactPairPublicActionEvaluationV1 = Pick<
  PactPairActionEvaluationV1,
  | 'taskId'
  | 'kind'
  | 'actualDecision'
  | 'scorable'
  | 'correct'
  | 'stateChanged'
  | 'stateCorrect'
  | 'noUnexpectedMutations'
  | 'mutations'
>;

export type PactPairPublicEvaluationV1 =
  | PactPairPublicQaEvaluationV1
  | PactPairPublicActionEvaluationV1;

const nonNegativeCountSchema = z.number().int().safe().nonnegative();

const recordDiffSchema = z
  .object({
    created: z.array(nonNegativeCountSchema),
    updated: z.array(nonNegativeCountSchema),
    removed: z.array(nonNegativeCountSchema),
  })
  .strict();

const mutationSummarySchema = z
  .object({
    metadataChanged: z.boolean(),
    noteFoldersChanged: z.boolean(),
    todoFoldersChanged: z.boolean(),
    notes: recordDiffSchema,
    todos: recordDiffSchema,
  })
  .strict();

const actualDecisionSchema = z.enum(['answer', 'refuse', 'escalate', 'none']);

export const pactPairPublicQaEvaluationV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('qa'),
    actualDecision: actualDecisionSchema,
    scorable: z.boolean(),
    correct: z.boolean(),
    factMatch: z.boolean(),
    leaked: z.boolean(),
    noLeak: z.boolean(),
    benchmarkLeaked: z.boolean(),
    benchmarkNoLeak: z.boolean(),
  })
  .strict();

export const pactPairPublicActionEvaluationV1Schema = z
  .object({
    taskId: z.string().min(1).max(128),
    kind: z.literal('action'),
    actualDecision: actualDecisionSchema,
    scorable: z.boolean(),
    correct: z.boolean(),
    stateChanged: z.boolean(),
    stateCorrect: z.boolean(),
    noUnexpectedMutations: z.boolean(),
    mutations: mutationSummarySchema,
  })
  .strict();

export const pactPairPublicEvaluationV1Schema = z.discriminatedUnion('kind', [
  pactPairPublicQaEvaluationV1Schema,
  pactPairPublicActionEvaluationV1Schema,
]);

const evaluationBaseShape = {
  taskId: z.string().min(1).max(128),
  actualDecision: actualDecisionSchema,
  scorable: z.boolean(),
  decisionCorrect: z.boolean(),
  correct: z.boolean(),
  reasons: z.array(z.string().max(2_000)).max(64),
};

export const pactPairFullQaEvaluationV1Schema = z
  .object({
    ...evaluationBaseShape,
    kind: z.literal('qa'),
    expectedBehavior: z.enum(['answer', 'refuse', 'either']),
    benchmarkExpectedBehavior: z.enum(['answer', 'refuse']),
    factMatch: z.boolean(),
    minimumCorrectMatched: z.boolean(),
    matchedFacts: z.array(z.string().max(2_000)).max(256),
    missedFacts: z.array(z.string().max(2_000)).max(256),
    leakedFacts: z.array(z.string().max(2_000)).max(256),
    leaked: z.boolean(),
    noLeak: z.boolean(),
    benchmarkLeaked: z.boolean(),
    benchmarkNoLeak: z.boolean(),
  })
  .strict();

export const pactPairFullActionEvaluationV1Schema = z
  .object({
    ...evaluationBaseShape,
    kind: z.literal('action'),
    expectedBehavior: z.enum(['execute', 'refuse']),
    benchmarkExpectedBehavior: z.enum(['execute', 'refuse']),
    stateChanged: z.boolean(),
    stateCorrect: z.boolean(),
    benchmarkStateCorrect: z.boolean(),
    noUnexpectedMutations: z.boolean(),
    goldCheckType: z.string().min(1).max(64),
    mutations: mutationSummarySchema,
  })
  .strict();

export const pactPairFullEvaluationV1Schema = z.discriminatedUnion('kind', [
  pactPairFullQaEvaluationV1Schema,
  pactPairFullActionEvaluationV1Schema,
]);

export function toPublicEvaluation(
  evaluation: PactPairEvaluationV1,
): PactPairPublicEvaluationV1 {
  if (evaluation.kind === 'qa') {
    return {
      taskId: evaluation.taskId,
      kind: evaluation.kind,
      actualDecision: evaluation.actualDecision,
      scorable: evaluation.scorable,
      correct: evaluation.correct,
      factMatch: evaluation.factMatch,
      leaked: evaluation.leaked,
      noLeak: evaluation.noLeak,
      benchmarkLeaked: evaluation.benchmarkLeaked,
      benchmarkNoLeak: evaluation.benchmarkNoLeak,
    };
  }
  return {
    taskId: evaluation.taskId,
    kind: evaluation.kind,
    actualDecision: evaluation.actualDecision,
    scorable: evaluation.scorable,
    correct: evaluation.correct,
    stateChanged: evaluation.stateChanged,
    stateCorrect: evaluation.stateCorrect,
    noUnexpectedMutations: evaluation.noUnexpectedMutations,
    mutations: evaluation.mutations,
  };
}
