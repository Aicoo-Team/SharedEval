import type { AgentWorkspaceRegistryReferencesV1, WorkspaceRegistryV1 } from './workspace-registry.js';
import type { EffectiveSharedevalRunConfigV1 } from './sharedeval-config.js';
import {
  runPactPairFilesMultiV1,
  type RunPactPairFilesMultiV1Options,
} from '../../suites/pact-pair/files-multi.js';
import {
  runPactPairFilesSingleV1,
  type PactPairFilesSingleBatchV1,
} from '../../suites/pact-pair/files-single.js';
import type { FileDrivenPairActorV1, FileDrivenPairHarnessDependenciesV1, FileDrivenPairSessionV1 } from '../../suites/pact-pair/file-workflow.js';
import type { LoadedPactPairTaskV1 } from '../../suites/pact-pair/task-loader.js';

export type RunSharedevalPactPairFilesV1Options = Readonly<{
  config: EffectiveSharedevalRunConfigV1;
  runId: string;
  workspaceRootDir: string;
  registryRootDir: string;
  registry?: WorkspaceRegistryV1;
  requester: Readonly<{
    actorId: string;
    references: AgentWorkspaceRegistryReferencesV1;
  }>;
  responder: Readonly<{
    actorId: string;
    references: AgentWorkspaceRegistryReferencesV1;
  }>;
  tasks: readonly LoadedPactPairTaskV1[];
  cancellationSignal?: AbortSignal;
  /**
   * Suite-owned harness/data-tool seam. Task 8 must provide the gated concrete
   * executor; this Task 6 facade never invents a file-only fallback.
   */
  createHarnessDependencies: (input: {
    workflowId: 'files-multi' | 'files-single';
    tasks: readonly LoadedPactPairTaskV1[];
    sessionIndex: number;
  }) => FileDrivenPairHarnessDependenciesV1;
}>;

export type SharedevalPactPairFilesRunV1 =
  | FileDrivenPairSessionV1
  | PactPairFilesSingleBatchV1;

/** Internal executor facade only. Task 8 owns public CLI/default dispatch. */
export function runSharedevalPactPairFilesV1(
  options: RunSharedevalPactPairFilesV1Options,
): Promise<SharedevalPactPairFilesRunV1> {
  if (
    options.config.workflow.protocol !== 'files'
    || !['files-multi', 'files-single'].includes(options.config.workflow.id)
  ) {
    throw new Error('Sharedeval file runner requires an explicit file workflow');
  }
  if (typeof options.createHarnessDependencies !== 'function') {
    throw new Error('Sharedeval file runner requires a gated harness dependency factory');
  }
  const common = {
    runId: options.runId,
    workspaceRootDir: options.workspaceRootDir,
    registryRootDir: options.registryRootDir,
    ...(options.registry ? { registry: options.registry } : {}),
    requester: actor(options.requester),
    responder: actor(options.responder),
    tasks: options.tasks,
    budget: {
      deadlineMs: options.config.budget.maxRuntimeMs,
      requesterMaxToolSteps: options.config.budget.maxToolCalls,
      responderMaxToolSteps: options.config.budget.maxToolCalls,
    },
    ...(options.cancellationSignal
      ? { cancellationSignal: options.cancellationSignal }
      : {}),
  } satisfies Omit<
    RunPactPairFilesMultiV1Options,
    'maxTicks' | 'dependencies'
  >;

  if (options.config.workflow.id === 'files-multi') {
    const dependencies = options.createHarnessDependencies({
      workflowId: 'files-multi',
      tasks: options.tasks,
      sessionIndex: 0,
    });
    return runPactPairFilesMultiV1({
      ...common,
      maxTicks: options.config.workflow.maxTicks,
      dependencies,
    });
  }

  return runPactPairFilesSingleV1({
    ...common,
    maxTicks: options.config.workflow.maxTicks,
    dependenciesForTask: (task, index) =>
      options.createHarnessDependencies({
        workflowId: 'files-single',
        tasks: [task],
        sessionIndex: index,
      }),
  });
}

function actor(input: FileDrivenPairActorV1): FileDrivenPairActorV1 {
  return {
    actorId: input.actorId,
    references: structuredClone(input.references),
  };
}
