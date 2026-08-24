import type { PactHarborDatasetRuntimeV1 } from '../../runner/v1/backends/harbor-task-package.js';

/**
 * PACT-Pair's Harbor dataset runtime: the dataset-identity parameters the
 * shared task packager and container entrypoint consume. Everything
 * dataset-specific about a Harbor task package — the task-id gate, the
 * task-template assets, and the entrypoint argument tokens — comes from this
 * one descriptor; the packager itself carries no per-dataset branches.
 *
 * Byte-compatibility contract: the replacement tokens below are exactly the
 * POLICY/REQUESTER/GRADING_MODE tokens the packager used to inline before the
 * dataset-runtime parameterization, so pair task packages (task.toml,
 * solve.sh, per-task image tags) are byte-identical to the pre-parameterized
 * output. tests/runner-v1/harbor-net-package.test.ts pins that with full-file
 * equality assertions.
 */
export const PACT_PAIR_HARBOR_DATASET_RUNTIME_V1: PactHarborDatasetRuntimeV1 = {
  datasetId: 'pact-pair',
  // Canonical PAIR ids only — the same gate the container entrypoint enforces
  // before it will run a trial.
  taskIdPattern: /^PAIR-[QA][1-9][0-9]*$/,
  templateSegments: ['harbor', 'task-template'],
  replacements: ({ config }) => ({
    POLICY: config.benchmark.policy,
    REQUESTER: config.benchmark.requester,
    GRADING_MODE: config.benchmark.gradingMode,
  }),
};
