import type {
  ApprovedEvaluator,
  EvaluatorReference,
} from './types.js';
import {
  assertEvaluatorReference,
  assertValidIdentifier,
  assertSemanticVersion,
} from './validation.js';

type AnyApprovedEvaluator = ApprovedEvaluator<any, any>;

/** An explicit allow-list of evaluator implementations; it never loads code. */
export class EvaluatorRegistry {
  readonly #evaluators = new Map<string, AnyApprovedEvaluator>();

  register<TInput, TDetails>(
    evaluator: ApprovedEvaluator<TInput, TDetails>,
  ): ApprovedEvaluator<TInput, TDetails> {
    if (!evaluator || typeof evaluator !== 'object' || typeof evaluator.evaluate !== 'function') {
      throw new TypeError('approved evaluator must provide an evaluate function');
    }
    assertValidIdentifier(evaluator.id, 'evaluator id');
    assertSemanticVersion(evaluator.version, 'evaluator version');
    const key = evaluatorKey(evaluator);
    if (this.#evaluators.has(key)) {
      throw new Error(`evaluator ${evaluator.id}@${evaluator.version} is already registered`);
    }
    this.#evaluators.set(key, evaluator as AnyApprovedEvaluator);
    return evaluator;
  }

  has(reference: EvaluatorReference): boolean {
    assertEvaluatorReference(reference);
    return this.#evaluators.has(evaluatorKey(reference));
  }

  get<TInput = unknown, TDetails = unknown>(
    reference: EvaluatorReference,
  ): ApprovedEvaluator<TInput, TDetails> | undefined {
    assertEvaluatorReference(reference);
    return this.#evaluators.get(evaluatorKey(reference)) as
      | ApprovedEvaluator<TInput, TDetails>
      | undefined;
  }

  require<TInput = unknown, TDetails = unknown>(
    reference: EvaluatorReference,
  ): ApprovedEvaluator<TInput, TDetails> {
    const evaluator = this.get<TInput, TDetails>(reference);
    if (!evaluator) {
      throw new Error(
        `evaluator ${reference.id}@${reference.version} is not in the approved registry`,
      );
    }
    return evaluator;
  }

  list(): readonly EvaluatorReference[] {
    return [...this.#evaluators.values()]
      .map(({ id, version }) => ({ id, version }))
      .sort((left, right) => evaluatorKey(left).localeCompare(evaluatorKey(right)));
  }
}

export const approvedEvaluatorRegistry = new EvaluatorRegistry();

export function registerApprovedEvaluator<TInput, TDetails>(
  evaluator: ApprovedEvaluator<TInput, TDetails>,
): ApprovedEvaluator<TInput, TDetails> {
  return approvedEvaluatorRegistry.register(evaluator);
}

export function getApprovedEvaluator<TInput = unknown, TDetails = unknown>(
  reference: EvaluatorReference,
): ApprovedEvaluator<TInput, TDetails> | undefined {
  return approvedEvaluatorRegistry.get<TInput, TDetails>(reference);
}

export function evaluatorKey(reference: EvaluatorReference): string {
  return `${reference.id}\0${reference.version}`;
}
