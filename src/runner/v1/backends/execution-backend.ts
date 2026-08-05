import type { PairDataStore } from '../../../schemas.js';
import type { PactRunConfigV1 } from '../config.js';
import type {
  PactHarnessFactoryV1,
  PactPairSingleTaskRunV1,
} from '../../../suites/pact-pair/environment.js';
import type { LoadedPactPairTaskV1 } from '../../../suites/pact-pair/task-loader.js';

export type PactExecutionBackendRunContextV1 = {
  config: PactRunConfigV1;
  tasks: LoadedPactPairTaskV1[];
  seed: PairDataStore;
  runId: string;
  now: () => Date;
  harnessFactory: PactHarnessFactoryV1;
  environment: Record<string, string | undefined>;
  /**
   * Invoked once per completed trial, in task order. The host uses this for
   * incremental checkpointing; backends must await it before continuing.
   */
  onTaskRun?: (taskRun: PactPairSingleTaskRunV1) => Promise<void>;
};

export type PactExecutionBackendRunResultV1 = {
  aborted?: {
    afterTaskId: string;
    reason: 'provider_configuration_error';
  };
};

export type PactExecutionTaskRunV1 = PactPairSingleTaskRunV1;

/** Orchestrates trials without owning any benchmark semantics. */
export interface ExecutionBackendV1 {
  readonly kind: 'local' | 'harbor';
  run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1>;
}
