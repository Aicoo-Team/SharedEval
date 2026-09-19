import type {
  AgentWorkspaceRegistryReferencesV1,
  WorkspaceRegistryV1,
} from './workspace-registry.js';
import type { EffectiveSharedevalRunConfigV1 } from './sharedeval-config.js';
import type {
  CreateSharedOsFileSessionV1Options,
  SharedOsFileSessionFactoryV1,
} from './sharedos-file-session-contracts.js';
import {
  runPactPairFilesMultiV1,
  type RunPactPairFilesMultiV1Options,
} from '../../suites/pact-pair/files-multi.js';
import {
  runPactPairFilesSingleV1,
  type PactPairFilesSingleBatchV1,
} from '../../suites/pact-pair/files-single.js';
import type {
  FileDrivenPairSessionV1,
} from '../../suites/pact-pair/file-workflow.js';
import type { LoadedPactPairTaskV1 } from '../../suites/pact-pair/task-loader.js';
import type { PactPairWorkspaceV1 } from '../../suites/pact-pair/workspace.js';
import {
  fileWorkflowHostRunProvenanceV1Schema,
  type FileWorkflowHostRunProvenanceV1,
} from './file-workflow-artifacts.js';

export type SharedevalFileSessionResourcesV1 = Readonly<{
  pactWorkspace: PactPairWorkspaceV1;
  storeRoot: string;
}>;

export type CreateSharedevalFileSessionResourcesV1 = (
  input: Readonly<{
    workflowId: 'files-multi' | 'files-single';
    tasks: readonly LoadedPactPairTaskV1[];
    sessionIndex: number;
  }>,
) => SharedevalFileSessionResourcesV1;

export type RunSharedevalPactPairFilesV1Options = Readonly<{
  config: EffectiveSharedevalRunConfigV1;
  runProvenance: FileWorkflowHostRunProvenanceV1;
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
  createDriver: CreateSharedOsFileSessionV1Options['createDriver'];
  createSharedOsSession: SharedOsFileSessionFactoryV1;
  createSessionResources: CreateSharedevalFileSessionResourcesV1;
  cancellationSignal?: AbortSignal;
}>;

export type SharedevalPactPairFilesRunV1 =
  | FileDrivenPairSessionV1
  | PactPairFilesSingleBatchV1;

/** Routes an already-validated explicit mode to the one SharedOS session seam. */
export function runSharedevalPactPairFilesV1(
  options: RunSharedevalPactPairFilesV1Options,
): Promise<SharedevalPactPairFilesRunV1> {
  const runProvenance = validateRuntimeBoundary(options);
  const common = {
    runProvenance,
    runId: options.runId,
    workspaceRootDir: options.workspaceRootDir,
    registryRootDir: options.registryRootDir,
    ...(options.registry ? { registry: options.registry } : {}),
    requester: actor(options.requester),
    responder: actor(options.responder),
    tasks: options.tasks,
    maxTicks: options.config.workflow.maxTicks,
    budget: {
      deadlineMs: options.config.budget.maxRuntimeMs,
      maxToolCalls: options.config.budget.maxToolCalls,
    },
    createDriver: options.createDriver,
    createSharedOsSession: options.createSharedOsSession,
    ...(options.cancellationSignal
      ? { cancellationSignal: options.cancellationSignal }
      : {}),
  } satisfies Omit<
    RunPactPairFilesMultiV1Options,
    'pactWorkspace' | 'storeRoot'
  >;

  if (options.config.workflow.id === 'files-multi') {
    const resources = createResources(options, {
      workflowId: 'files-multi',
      tasks: options.tasks,
      sessionIndex: 0,
    });
    return runPactPairFilesMultiV1({
      ...common,
      ...(options.config.workflow.multiTurn
        ? { multiTurn: structuredClone(options.config.workflow.multiTurn) }
        : {}),
      ...resources,
    });
  }

  const resourcesByIndex = new Map<number, SharedevalFileSessionResourcesV1>();
  const resourcesForTask = (task: LoadedPactPairTaskV1, sessionIndex: number) => {
    const existing = resourcesByIndex.get(sessionIndex);
    if (existing) return existing;
    const resources = createResources(options, {
      workflowId: 'files-single',
      tasks: [task],
      sessionIndex,
    });
    resourcesByIndex.set(sessionIndex, resources);
    return resources;
  };
  return runPactPairFilesSingleV1({
    ...common,
    ...(options.config.workflow.taskConcurrency === undefined
      ? {}
      : { taskConcurrency: options.config.workflow.taskConcurrency }),
    pactWorkspaceForTask: (task, index) => resourcesForTask(task, index).pactWorkspace,
    storeRootForTask: (task, index) => resourcesForTask(task, index).storeRoot,
  });
}

function validateRuntimeBoundary(
  options: RunSharedevalPactPairFilesV1Options,
): FileWorkflowHostRunProvenanceV1 {
  const workflow = options.config.workflow;
  const validWorkflow = (
    workflow.protocol === 'files'
    && (
      (workflow.mode === 'multi' && workflow.id === 'files-multi')
      || (workflow.mode === 'single' && workflow.id === 'files-single')
    )
  );
  if (!validWorkflow || options.config.benchmark.dataset !== 'pact-pair') {
    throw new Error('Sharedeval runner requires an explicit PACT-Pair file workflow');
  }
  if (
    typeof options.createDriver !== 'function'
    || typeof options.createSharedOsSession !== 'function'
    || typeof options.createSessionResources !== 'function'
  ) {
    throw new Error('Sharedeval runner requires the SharedOS session boundary');
  }
  try {
    return deepFreeze(fileWorkflowHostRunProvenanceV1Schema.parse(
      structuredClone(options.runProvenance),
    ));
  } catch {
    throw new Error('Sharedeval runner requires valid benchmark run provenance');
  }
}

function createResources(
  options: RunSharedevalPactPairFilesV1Options,
  input: Parameters<CreateSharedevalFileSessionResourcesV1>[0],
): SharedevalFileSessionResourcesV1 {
  let resources: SharedevalFileSessionResourcesV1;
  try {
    resources = options.createSessionResources(input);
  } catch {
    throw new Error('Sharedeval session resources are unavailable');
  }
  if (
    !resources
    || typeof resources.pactWorkspace !== 'object'
    || resources.pactWorkspace === null
    || typeof resources.storeRoot !== 'string'
    || resources.storeRoot.length === 0
  ) {
    throw new Error('Sharedeval session resources are invalid');
  }
  return resources;
}

function actor(input: Readonly<{
  actorId: string;
  references: AgentWorkspaceRegistryReferencesV1;
}>) {
  return {
    actorId: input.actorId,
    references: structuredClone(input.references),
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
