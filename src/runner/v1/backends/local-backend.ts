import { runSinglePactPairTaskV1 } from '../../../suites/pact-pair/environment.js';
import type {
  ExecutionBackendV1,
  PactExecutionBackendRunContextV1,
  PactExecutionBackendRunResultV1,
} from './execution-backend.js';

/**
 * Circuit breaker for sustained outages. Each infrastructure-error trial
 * already burns the full retry ladder (8 attempts, ~85s), so this many in a
 * row means the provider or the network is down, not that tasks are flaky —
 * during the 2026-08-21 outage the runner kept failing every remaining task
 * for over two hours. Aborting preserves the checkpoint for a repair run.
 */
export const MAX_CONSECUTIVE_INFRA_ERRORS_V1 = 25;

/** The existing serial, in-process execution path behind an explicit seam. */
export class LocalBackendV1 implements ExecutionBackendV1 {
  readonly kind = 'local' as const;

  async run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1> {
    let consecutiveInfraErrors = 0;
    for (const task of context.tasks) {
      const taskRun = await runSinglePactPairTaskV1({
        config: context.config,
        task,
        seed: context.seed,
        runId: context.runId,
        now: context.now,
        harnessFactory: context.harnessFactory,
        environment: context.environment,
      });
      await context.onTaskRun?.(taskRun);
      if (taskRun.result.violations.includes('provider_configuration_error')) {
        return {
          aborted: {
            afterTaskId: taskRun.result.taskId,
            reason: 'provider_configuration_error',
          },
        };
      }
      consecutiveInfraErrors = taskRun.result.status === 'infrastructure_error'
        ? consecutiveInfraErrors + 1
        : 0;
      if (consecutiveInfraErrors >= MAX_CONSECUTIVE_INFRA_ERRORS_V1) {
        return {
          aborted: {
            afterTaskId: taskRun.result.taskId,
            reason: 'consecutive_infrastructure_errors',
          },
        };
      }
    }
    return {};
  }
}
