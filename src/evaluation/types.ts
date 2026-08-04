/** A declarative reference to evaluator code approved by the host application. */
export type EvaluatorReference = {
  readonly id: string;
  readonly version: string;
};

declare const evaluationSpecTypes: unique symbol;

/**
 * The evaluation contract published by a dataset.
 *
 * `TInput` and `TDetails` are compile-time-only. Dataset manifests contain no
 * executable module, path, or source-code field.
 */
export type EvaluationSpec<TInput = unknown, TDetails = unknown> = {
  readonly evaluator: EvaluatorReference;
  readonly metrics: readonly string[];
  readonly [evaluationSpecTypes]?: {
    readonly input: (value: TInput) => void;
    readonly details: TDetails;
  };
};

export type MetricContribution = {
  readonly metric: string;
  readonly numerator: number;
  readonly denominator: number;
};

export type AggregatedMetric = {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
};

export type MetricAggregates = Record<string, AggregatedMetric>;

export type EvaluationResult<TDetails = unknown> = {
  readonly metrics: readonly MetricContribution[];
  readonly details?: TDetails;
};

export type EvaluationTarget<TInput = unknown, TDetails = unknown> = {
  readonly evaluation: EvaluationSpec<TInput, TDetails>;
};

export type ApprovedEvaluator<TInput = unknown, TDetails = unknown> = {
  readonly id: string;
  readonly version: string;
  readonly evaluate: (
    input: TInput,
    spec: EvaluationSpec<TInput, TDetails>,
  ) => EvaluationResult<TDetails> | Promise<EvaluationResult<TDetails>>;
};
