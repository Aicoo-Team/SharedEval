import type { PactRunConfigV1 } from './config.js';
import {
  loadPactPairTasksV1,
  runPactPairBenchmarkV1,
  type PactPairRunResultV1,
  type RunPactPairBenchmarkV1Options,
} from '../../suites/pact-pair/index.js';
import {
  loadPactNetTasksV1,
  requirePactNetPolicyV1,
  runPactNetBenchmarkV1,
  type PactNetRunResultV1,
  type RunPactNetBenchmarkV1Options,
} from '../../suites/pact-net/index.js';

export * from '../../suites/pact-pair/runner.js';

export type PactBenchmarkInspectionV1 = {
  dataset: string;
  taskCount: number;
  firstTask: string | null;
  lastTask: string | null;
};

/**
 * Dispatch-level result and option types are the union of the registered
 * suites. The CLI consumes only the shared shape (runId, outputDirectory,
 * aborted, summary.errors); anything suite-specific requires calling the
 * suite runner directly.
 */
export type PactBenchmarkRunResultV1 = PactPairRunResultV1 | PactNetRunResultV1;
export type RunPactBenchmarkV1Options =
  | RunPactPairBenchmarkV1Options
  | RunPactNetBenchmarkV1Options;

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
  // The dispatch options union narrows per suite; each runtime forwards the
  // options shape its own runner declares.
  run: (config, options) =>
    runPactPairBenchmarkV1(config, options as RunPactPairBenchmarkV1Options),
};

const pactNetRuntimeV1: DatasetRuntimeV1 = {
  id: 'pact-net',
  inspect(config) {
    const tasks = loadPactNetTasksV1({
      policy: requirePactNetPolicyV1(config.benchmark.policy),
      kind: config.benchmark.tasks.kind,
      ...(config.benchmark.tasks.ids ? { ids: config.benchmark.tasks.ids } : {}),
      ...(config.benchmark.tasks.limit === undefined
        ? {}
        : { limit: config.benchmark.tasks.limit }),
    });
    return {
      dataset: this.id,
      taskCount: tasks.length,
      firstTask: tasks.at(0)?.taskId ?? null,
      lastTask: tasks.at(-1)?.taskId ?? null,
    };
  },
  run: (config, options) =>
    runPactNetBenchmarkV1(config, options as RunPactNetBenchmarkV1Options),
};

/**
 * Host-owned allowlist of executable dataset suites. Dataset manifests may
 * reference these IDs, but cannot add code to this registry.
 */
const datasetRuntimesV1 = new Map<string, DatasetRuntimeV1>([
  [pactPairRuntimeV1.id, pactPairRuntimeV1],
  [pactNetRuntimeV1.id, pactNetRuntimeV1],
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
