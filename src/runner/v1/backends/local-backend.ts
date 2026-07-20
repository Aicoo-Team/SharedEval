import {
  PactEnvironmentV1,
  type PactEnvironmentParticipantsV1,
} from '../environment.js';
import type {
  ExecutionBackendV1,
  PactExecutionBackendRunContextV1,
  PactExecutionBackendRunResultV1,
} from './execution-backend.js';

/** The existing serial, in-process execution path behind an explicit seam. */
export class LocalBackendV1 implements ExecutionBackendV1 {
  readonly kind = 'local' as const;

  constructor(
    private readonly pactEnvironment = new PactEnvironmentV1(),
  ) {}

  async run(
    context: PactExecutionBackendRunContextV1,
  ): Promise<PactExecutionBackendRunResultV1> {
    const taskRuns: PactExecutionBackendRunResultV1['taskRuns'] = [];

    for (const task of context.tasks) {
      const participants: PactEnvironmentParticipantsV1 = {
        requester: task.publicTask.requester,
        target: task.publicTask.target,
      };
      const taskRun = await this.pactEnvironment.runTask({
        config: context.config,
        task,
        participants,
        seed: context.seed,
        runId: context.runId,
        now: context.now,
        harnessFactory: context.harnessFactory,
        environment: context.environment,
      });
      taskRuns.push(taskRun);
      if (taskRun.result.violations.includes('provider_configuration_error')) {
        return {
          taskRuns,
          aborted: {
            afterTaskId: taskRun.result.taskId,
            reason: 'provider_configuration_error',
          },
        };
      }
    }

    return { taskRuns };
  }
}
