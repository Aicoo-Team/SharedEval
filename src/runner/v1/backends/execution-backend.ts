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
   * Invoked exactly once per completed trial, as soon as the trial settles —
   * in task order for serial backends, in completion order for concurrent
   * ones (the host re-orders the aggregate result canonically). The host uses
   * this for incremental checkpointing; backends must await it before
   * continuing.
   */
  onTaskRun?: (taskRun: PactPairSingleTaskRunV1) => Promise<void>;
};

/**
 * What actually produced the decisions in this run. `executor` names the
 * effective decision source — the deterministic scripted parity harness, a
 * caller-injected harness, or the configured model adapter — so run artifacts
 * can never imply that a scripted trial exercised the caller-selected model.
 * Harbor runs additionally pin the orchestrator version and the immutable
 * local image identity (`docker image inspect .Id` content digest).
 */
export type PactRunExecutionMetadataV1 = {
  backend: 'local' | 'harbor';
  executor: 'model' | 'scripted-harness' | 'custom-harness';
  harbor?: {
    version: string;
    image: string;
    imageId?: string;
  };
};

export type PactExecutionBackendRunResultV1 = {
  aborted?: {
    afterTaskId: string;
    reason: 'provider_configuration_error';
  };
  /**
   * Backend-reported execution provenance. When absent the host derives it
   * from the configured backend and the harness source it was given.
   */
  execution?: PactRunExecutionMetadataV1;
};

export type PactExecutionTaskRunV1 = PactPairSingleTaskRunV1;

/** Orchestrates trials without owning any benchmark semantics. */
export interface ExecutionBackendV1 {
  readonly kind: 'local' | 'harbor';
  run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1>;
}
