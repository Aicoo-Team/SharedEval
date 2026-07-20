import type { PairDataStore } from '../../../schemas.js';
import type { PactRunConfigV1 } from '../config.js';
import type {
  PactHarnessFactoryV1,
} from '../environment.js';
import type {
  PactTaskResultV1,
  PactTraceEventV1,
} from '../artifacts.js';
import type { LoadedPactPairTaskV1 } from '../task-loader.js';

export type PactExecutionBackendRunContextV1 = {
  config: PactRunConfigV1;
  tasks: LoadedPactPairTaskV1[];
  seed: PairDataStore;
  runId: string;
  now: () => Date;
  harnessFactory: PactHarnessFactoryV1;
  environment: Record<string, string | undefined>;
};

export type PactExecutionBackendRunResultV1 = {
  taskRuns: PactExecutionTaskRunV1[];
  aborted?: {
    afterTaskId: string;
    reason: 'provider_configuration_error';
  };
};

export type PactExecutionTaskRunV1 = {
  result: PactTaskResultV1;
  trace: PactTraceEventV1[];
};

/** Orchestrates trials without owning any benchmark semantics. */
export interface ExecutionBackendV1 {
  readonly kind: 'local' | 'harbor';
  run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1>;
}
