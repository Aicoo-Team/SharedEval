import { approvedEvaluatorRegistry, type EvaluatorRegistry } from './registry.js';
import type {
  EvaluationResult,
  EvaluationTarget,
} from './types.js';
import {
  assertEvaluationSpec,
  normalizeEvaluationResult,
} from './validation.js';

/** Evaluates a dataset input using only an implementation in the allow-list. */
export async function evaluateWithRegisteredEvaluator<TInput, TDetails>(
  definition: EvaluationTarget<TInput, TDetails>,
  input: TInput,
  registry: EvaluatorRegistry = approvedEvaluatorRegistry,
): Promise<EvaluationResult<TDetails>> {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('dataset definition must contain an evaluation spec');
  }
  assertEvaluationSpec(definition.evaluation);
  const evaluator = registry.require<TInput, TDetails>(
    definition.evaluation.evaluator,
  );
  const result = await evaluator.evaluate(input, definition.evaluation);
  return normalizeEvaluationResult(result, definition.evaluation);
}
