import { runSinglePactPairTaskV1 } from '../../../suites/pact-pair/environment.js';
import type {
  ExecutionBackendV1,
  PactExecutionBackendRunContextV1,
  PactExecutionBackendRunResultV1,
} from './execution-backend.js';

/** The existing serial, in-process execution path behind an explicit seam. */
export class LocalBackendV1 implements ExecutionBackendV1 {
  readonly kind = 'local' as const;

  async run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1> {
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
    }
    return {};
  }
}
