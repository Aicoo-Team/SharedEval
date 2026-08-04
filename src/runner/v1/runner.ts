import type { PactRunConfigV1 } from './config.js';
import {
  loadPactPairTasksV1,
  runPactPairBenchmarkV1,
  type PactPairRunResultV1,
  type RunPactPairBenchmarkV1Options,
} from '../../suites/pact-pair/index.js';

export * from '../../suites/pact-pair/runner.js';

export type PactBenchmarkInspectionV1 = {
  dataset: string;
  taskCount: number;
  firstTask: string | null;
  lastTask: string | null;
};

export type PactBenchmarkRunResultV1 = PactPairRunResultV1;
export type RunPactBenchmarkV1Options = RunPactPairBenchmarkV1Options;

type DatasetRuntimeV1 = {
  readonly id: string;
  inspect(config: PactRunConfigV1): PactBenchmarkInspectionV1;
  run(
    config: PactRunConfigV1,
    options?: RunPactBenchmarkV1Options,
  ): Promise<PactBenchmarkRunResultV1>;
};

const pactPairRuntimeV1: DatasetRuntimeV1 = {
  id: 'pact-pair',
  inspect(config) {
    const tasks = loadPactPairTasksV1({
      policy: config.benchmark.policy,
      requester: config.benchmark.requester,
      gradingMode: config.benchmark.gradingMode,
      kind: config.benchmark.tasks.kind,
      ids: config.benchmark.tasks.ids,
      limit: config.benchmark.tasks.limit,
    });
    return {
      dataset: this.id,
      taskCount: tasks.length,
      firstTask: tasks.at(0)?.taskId ?? null,
      lastTask: tasks.at(-1)?.taskId ?? null,
    };
  },
  run: runPactPairBenchmarkV1,
};

/**
 * Host-owned allowlist of executable dataset suites. Dataset manifests may
 * reference these IDs, but cannot add code to this registry.
 */
const datasetRuntimesV1 = new Map<string, DatasetRuntimeV1>([
  [pactPairRuntimeV1.id, pactPairRuntimeV1],
]);

export function inspectPactBenchmarkV1(
  config: PactRunConfigV1,
): PactBenchmarkInspectionV1 {
  return requireDatasetRuntimeV1(config.benchmark.dataset).inspect(config);
}

export async function runPactBenchmarkV1(
  config: PactRunConfigV1,
  options: RunPactBenchmarkV1Options = {},
): Promise<PactBenchmarkRunResultV1> {
  return requireDatasetRuntimeV1(config.benchmark.dataset).run(config, options);
}

function requireDatasetRuntimeV1(datasetId: string): DatasetRuntimeV1 {
  const runtime = datasetRuntimesV1.get(datasetId);
  if (!runtime) {
    throw new Error(
      `Dataset ${datasetId} has no approved local runtime. `
      + 'Adding data does not install executable suite code.',
    );
  }
  return runtime;
}
