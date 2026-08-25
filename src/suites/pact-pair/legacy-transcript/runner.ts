import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  SHAREDOS_VERIFIED_REVISION_V1,
  SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
  loadSharedOsModulesV1,
  type LoadSharedOsResultV1,
  type SharedOsModulesV1,
} from '../../../execution/sharedos/v1/index.js';
import { pactModelIdentifierV1 } from '../../../runner/v1/config.js';
import {
  loadPactPairTaskSetV1,
  type LoadedPactPairTaskSetV1,
} from '../task-loader.js';
import {
  createPactPairSharedOsToolHandlersV1,
  expectedVisibleSharedOsToolsV1,
} from '../sharedos-execution.js';
import { maximumBoundaryForTask } from '../environment.js';
import { PACT_PAIR_TOOL_SPECS_V1 } from '../tools.js';
import {
  createPactPairWorkspaceV1,
  loadCanonicalPactPairStoreV1,
} from '../workspace.js';
import type { PairDataStore } from '../schemas.js';
import {
  CANONICAL_LEGACY_SCRIPT_SHA256_V1,
  freezeLegacyMultiAssetsV1,
  type FrozenLegacyMultiAssetsV1,
} from './assets.js';
import {
  applyLegacyMultiOverridesV1,
  digestLegacyConfigV1,
  LEGACY_MULTI_METRIC_FAMILY_ID_V1,
  LEGACY_MULTI_PROTOCOL_ID_V1,
  LEGACY_MULTI_WORKFLOW_ID_V1,
  type EffectiveLegacyMultiConfigV1,
  type LegacyMultiConfigV1,
  type LegacyMultiOverridesV1,
  validateLegacyPhaseBoundaryV1,
} from './config.js';
import {
  LEGACY_SOURCE_PR_HEADS_V1,
  summarizeLegacyTrajectoriesV1,
  writeLegacyMultiArtifactsV1,
  type LegacyPublicRunManifestV1,
  type LegacyTrajectoryMetricSummaryV1,
} from './artifacts.js';
import { createEmbeddedPersistentLegacyWorldV1 } from './embedded-world.js';
import {
  runLegacyMultiTrajectoryV1,
  type LegacyTrajectoryRunV1,
} from './engine.js';
import { createModelLegacyRequesterDriverV1 } from './model-requester.js';
import {
  createScriptedLegacyRequesterDriverV1,
  type LegacyRequesterDriverV1,
} from './requester-driver.js';
import { PersistentLegacyResponderSessionV1 } from './responder-session.js';
import {
  createLocalPersistentLegacyWorldV1,
  type PersistentLegacyWorldV1,
} from './world.js';

type FetchImplementation = typeof globalThis.fetch;

export type LegacyMultiPreflightReportV1 = {
  workflowId: typeof LEGACY_MULTI_WORKFLOW_ID_V1;
  protocolId: typeof LEGACY_MULTI_PROTOCOL_ID_V1;
  metricFamilyId: typeof LEGACY_MULTI_METRIC_FAMILY_ID_V1;
  effectiveConfigDigest: string;
  taskSetDigest: string;
  sourceRevision: string;
  selectedTaskIds: string[];
  sourcePrHeads: typeof LEGACY_SOURCE_PR_HEADS_V1;
  execution: {
    backend: 'local';
    adapterId: 'pact-public-runner' | 'sharedos-embedded';
    sharedOsRevision: string;
    sharedOsRuntimeDigest?: string;
  };
  assets: LegacyPublicRunManifestV1['assets'];
};

type PreparedLegacyMultiRunV1 = {
  report: LegacyMultiPreflightReportV1;
  config: EffectiveLegacyMultiConfigV1;
  taskSet: LoadedPactPairTaskSetV1;
  assets: FrozenLegacyMultiAssetsV1;
  seed: PairDataStore;
  responderCredential: string;
  requesterCredential?: string;
  sharedOsModules?: SharedOsModulesV1;
};

export type LegacyMultiFactoriesV1 = {
  createRequester(input: {
    prepared: PreparedLegacyMultiRunV1;
    principalId: string;
    fetch?: FetchImplementation;
  }): LegacyRequesterDriverV1;
  createResponder(input: {
    prepared: PreparedLegacyMultiRunV1;
    fetch?: FetchImplementation;
  }): PersistentLegacyResponderSessionV1;
  createWorld(input: {
    prepared: PreparedLegacyMultiRunV1;
    trajectoryId: string;
    principalId: string;
    responder: PersistentLegacyResponderSessionV1;
  }): PersistentLegacyWorldV1 | Promise<PersistentLegacyWorldV1>;
};

export type RunLegacyMultiTranscriptBenchmarkOptionsV1 = {
  config: LegacyMultiConfigV1;
  overrides?: LegacyMultiOverridesV1;
  rootDir: string;
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  runId?: string;
  check?: boolean;
  writeOutputs?: boolean;
  fetch?: FetchImplementation;
  factories?: Partial<LegacyMultiFactoriesV1>;
  dependencies?: {
    loadSharedOs?: () => Promise<LoadSharedOsResultV1>;
    sourceRevision?: () => string;
  };
  now?: () => Date;
};

export type LegacyMultiBenchmarkResultV1 =
  | { mode: 'check'; preflight: LegacyMultiPreflightReportV1 }
  | {
      mode: 'run';
      manifest: LegacyPublicRunManifestV1;
      metrics: LegacyTrajectoryMetricSummaryV1;
      trajectories: LegacyTrajectoryRunV1[];
      outputDirectory?: string;
    };

export async function runLegacyMultiTranscriptBenchmarkV1(
  options: RunLegacyMultiTranscriptBenchmarkOptionsV1,
): Promise<LegacyMultiBenchmarkResultV1> {
  const prepared = await preflightLegacyMultiTranscriptV1(options);
  if (options.check) return { mode: 'check', preflight: prepared.report };

  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = validateRunId(options.runId ?? defaultRunId(startedAt));
  const principalId = `pact-pair-requester-${prepared.config.benchmark.requester}`;
  const factories = defaultFactories(options.factories);
  const trajectories: LegacyTrajectoryRunV1[] = [];
  for (let index = 0; index < prepared.config.benchmark.trajectory.count; index += 1) {
    const trajectoryId = `${runId}:trajectory-${index + 1}`;
    const requester = factories.createRequester({
      prepared,
      principalId,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const responder = factories.createResponder({
      prepared,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const world = await factories.createWorld({
      prepared,
      trajectoryId,
      principalId,
      responder,
    });
    trajectories.push(await runLegacyMultiTrajectoryV1({
      runId,
      trajectoryId,
      tasks: prepared.taskSet.tasks,
      maxTicks: prepared.config.benchmark.trajectory.maxTicks,
      ...(prepared.config.benchmark.trajectory.phase2StartTick === undefined
        ? {}
        : { phase2StartTick: prepared.config.benchmark.trajectory.phase2StartTick }),
      trajectoryRuntimeMs: prepared.config.benchmark.trajectory.maxRuntimeMs,
      tickBudget: prepared.config.budget,
      requester,
      responder,
      world,
    }));
  }

  const completedAt = now();
  const hasErrors = trajectories.some(result =>
    result.public.hasInfrastructureError
    || [
      'trajectory_timeout',
      'side_effect_before_failure',
      'requester_error',
      'engine_error',
      'infrastructure_error',
    ].includes(result.public.endReason));
  const manifest: LegacyPublicRunManifestV1 = {
    schemaVersion: 1,
    workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
    protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    status: hasErrors ? 'completed_with_errors' : 'completed',
    effectiveConfigDigest: prepared.report.effectiveConfigDigest,
    taskSetDigest: prepared.report.taskSetDigest,
    sourceRevision: prepared.report.sourceRevision,
    selectedTaskIds: [...prepared.report.selectedTaskIds],
    sourcePrHeads: LEGACY_SOURCE_PR_HEADS_V1,
    execution: structuredClone(prepared.report.execution),
    assets: structuredClone(prepared.report.assets),
  };
  const metrics = summarizeLegacyTrajectoriesV1(
    trajectories.map(result => result.public),
  );
  let outputDirectory: string | undefined;
  if (options.writeOutputs !== false) {
    outputDirectory = await writeLegacyMultiArtifactsV1({
      outputRoot: path.resolve(
        options.workingDirectory ?? process.cwd(),
        prepared.config.output.directory,
      ),
      manifest,
      trajectories,
      savePrivate: prepared.config.output.saveTraces,
    });
  }
  return {
    mode: 'run',
    manifest,
    metrics,
    trajectories,
    ...(outputDirectory ? { outputDirectory } : {}),
  };
}

async function preflightLegacyMultiTranscriptV1(
  options: RunLegacyMultiTranscriptBenchmarkOptionsV1,
): Promise<PreparedLegacyMultiRunV1> {
  const config = applyLegacyMultiOverridesV1(options.config, options.overrides);
  const rootDir = path.resolve(options.rootDir);
  const taskSet = loadPactPairTaskSetV1({
    rootDir,
    policy: config.benchmark.policy,
    requester: config.benchmark.requester,
    gradingMode: config.benchmark.gradingMode,
    kind: config.benchmark.tasks.kind,
    ids: config.benchmark.tasks.ids,
    limit: config.benchmark.tasks.limit,
  });
  const selectedTaskIds = taskSet.tasks.map(task => task.taskId);
  if (
    options.overrides?.taskIds
    && (
      selectedTaskIds.length !== options.overrides.taskIds.length
      || selectedTaskIds.some((taskId, index) => taskId !== options.overrides?.taskIds?.[index])
    )
  ) {
    throw new Error('Legacy multi selected tasks do not match the exact command override');
  }
  validateLegacyPhaseBoundaryV1(config, selectedTaskIds);
  const assets = await freezeLegacyMultiAssetsV1(rootDir, config);
  if (
    assets.requester.kind === 'scripted'
    && assets.requester.script.provenance.rawSha256
      !== CANONICAL_LEGACY_SCRIPT_SHA256_V1
  ) {
    throw new Error('Legacy scripted requester asset does not match the reviewed v1 bytes');
  }
  const environment = options.environment ?? process.env;
  const responderCredential = requireCredential(
    environment,
    config.model.apiKeyEnv,
    'responder',
  );
  const requesterCredential = config.benchmark.trajectory.requesterDriver.kind === 'model'
    ? requireCredential(
        environment,
        config.benchmark.trajectory.requesterDriver.model.apiKeyEnv,
        'requester',
      )
    : undefined;
  const sourceRevision = (
    options.dependencies?.sourceRevision?.()
    ?? resolveSourceRevision(rootDir)
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error('Legacy multi source revision must be a full Git commit');
  }
  const seed = loadCanonicalPactPairStoreV1();
  assertToolParity(taskSet, seed);

  let sharedOsRevision = SHAREDOS_VERIFIED_REVISION_V1 as string;
  let sharedOsRuntimeDigest: string | undefined;
  let sharedOsModules: SharedOsModulesV1 | undefined;
  if (config.benchmark.execution.adapter === 'sharedos-embedded') {
    if (config.budget.maxRuntimeMs > 300_000) {
      throw new Error(
        'Legacy sharedos-embedded tick runtime exceeds the SharedOS 300000ms maximum',
      );
    }
    const loaded = await (
      options.dependencies?.loadSharedOs?.()
      ?? loadSharedOsModulesV1()
    );
    if (!loaded.ok) {
      throw new Error(
        `Legacy sharedos-embedded preflight failed: ${loaded.reason}`,
      );
    }
    if (
      loaded.revision !== SHAREDOS_VERIFIED_REVISION_V1
      || loaded.runtimeDigest !== SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1
    ) {
      throw new Error(
        'Legacy sharedos-embedded preflight rejected a mismatched SharedOS build',
      );
    }
    sharedOsRevision = loaded.revision;
    sharedOsRuntimeDigest = loaded.runtimeDigest;
    sharedOsModules = loaded.modules;
  }
  if (!/^[0-9a-f]{40}$/.test(sharedOsRevision)) {
    throw new Error('Legacy multi SharedOS revision is missing');
  }
  const taskSetDigest = digestLegacyConfigV1({
    tasks: taskSet.tasks,
    requesterIdentityProvenance: taskSet.requesterIdentityProvenance,
    relationshipLabelProvenance: taskSet.relationshipLabelProvenance,
  });
  const report: LegacyMultiPreflightReportV1 = {
    workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
    protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    effectiveConfigDigest: config.effectiveConfigDigest,
    taskSetDigest,
    sourceRevision,
    selectedTaskIds,
    sourcePrHeads: LEGACY_SOURCE_PR_HEADS_V1,
    execution: {
      backend: 'local',
      adapterId: config.benchmark.execution.adapter,
      sharedOsRevision,
      ...(sharedOsRuntimeDigest ? { sharedOsRuntimeDigest } : {}),
    },
    assets: publicAssets(assets),
  };
  return {
    report,
    config,
    taskSet,
    assets,
    seed,
    responderCredential,
    ...(requesterCredential ? { requesterCredential } : {}),
    ...(sharedOsModules ? { sharedOsModules } : {}),
  };
}

function defaultFactories(
  overrides: Partial<LegacyMultiFactoriesV1> | undefined,
): LegacyMultiFactoriesV1 {
  return {
    createRequester: overrides?.createRequester ?? (input => {
      const requester = input.prepared.assets.requester;
      if (requester.kind === 'scripted') {
        return createScriptedLegacyRequesterDriverV1({
          script: requester.script,
          principalId: input.principalId,
        });
      }
      const requesterConfig = input.prepared.config.benchmark.trajectory.requesterDriver;
      if (requesterConfig.kind !== 'model' || !input.prepared.requesterCredential) {
        throw new Error('Legacy model requester preflight was incomplete');
      }
      return createModelLegacyRequesterDriverV1({
        model: requesterConfig.model,
        credential: input.prepared.requesterCredential,
        principalId: input.principalId,
        persona: {
          coo: requester.agent.coo.content,
          policy: requester.agent.policy.content,
          memory: requester.agent.memory.content,
        },
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
    }),
    createResponder: overrides?.createResponder ?? (input =>
      new PersistentLegacyResponderSessionV1({
        model: input.prepared.config.model,
        credential: input.prepared.responderCredential,
        requesterId: input.prepared.config.benchmark.requester,
        persona: {
          coo: input.prepared.assets.responder.coo.content,
          policy: input.prepared.assets.responder.policy.content,
          memory: input.prepared.assets.responder.memory.content,
        },
        tools: PACT_PAIR_TOOL_SPECS_V1,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      })),
    createWorld: overrides?.createWorld ?? (async input => {
      if (input.prepared.config.benchmark.execution.adapter === 'pact-public-runner') {
        return createLocalPersistentLegacyWorldV1({
          seed: input.prepared.seed,
          sharedOsRevision: input.prepared.report.execution.sharedOsRevision,
        });
      }
      if (!input.prepared.sharedOsModules) {
        throw new Error('Legacy SharedOS modules were not frozen at preflight');
      }
      return createEmbeddedPersistentLegacyWorldV1({
        modules: input.prepared.sharedOsModules,
        seed: input.prepared.seed,
        trajectoryId: input.trajectoryId,
        worldId: `${input.trajectoryId}:world`,
        namespaceId: `${input.trajectoryId}:namespace`,
        principalId: input.principalId,
        responder: input.responder,
        requestedModel: pactModelIdentifierV1(input.prepared.config.model),
        sharedOsRevision: input.prepared.report.execution.sharedOsRevision,
      });
    }),
  };
}

function publicAssets(assets: FrozenLegacyMultiAssetsV1): LegacyPublicRunManifestV1['assets'] {
  const responder = {
    persona: assets.responder.persona,
    coo: assets.responder.coo.provenance,
    policy: assets.responder.policy.provenance,
    memory: assets.responder.memory.provenance,
  };
  return {
    responder,
    requester: assets.requester.kind === 'scripted'
      ? { kind: 'scripted', script: assets.requester.script.provenance }
      : {
          kind: 'model',
          agent: {
            persona: assets.requester.agent.persona,
            coo: assets.requester.agent.coo.provenance,
            policy: assets.requester.agent.policy.provenance,
            memory: assets.requester.agent.memory.provenance,
          },
        },
  };
}

function assertToolParity(taskSet: LoadedPactPairTaskSetV1, seed: PairDataStore): void {
  const specs = PACT_PAIR_TOOL_SPECS_V1.map(spec => spec.name);
  if (new Set(specs).size !== specs.length) {
    throw new Error('Legacy responder tool specifications are not unique');
  }
  const workspace = createPactPairWorkspaceV1(seed);
  for (const task of taskSet.tasks) {
    const access = maximumBoundaryForTask(task.publicTask);
    const handlers = createPactPairSharedOsToolHandlersV1({ workspace, access });
    const handlerNames = handlers.map(handler =>
      (handler as { definition?: { name?: unknown } }).definition?.name)
      .filter((name): name is string => typeof name === 'string');
    if (
      handlerNames.length !== specs.length
      || handlerNames.some((name, index) => name !== specs[index])
    ) {
      throw new Error('Legacy public and SharedOS tool registrations drifted');
    }
    for (const visible of expectedVisibleSharedOsToolsV1(access)) {
      if (!specs.includes(visible)) {
        throw new Error(`Legacy expected tool is not registered: ${visible}`);
      }
    }
  }
}

function requireCredential(
  environment: Record<string, string | undefined>,
  variable: string,
  role: string,
): string {
  const credential = environment[variable]?.trim();
  if (!credential) throw new Error(`Legacy ${role} model credential is missing`);
  return credential;
}

function resolveSourceRevision(rootDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('Legacy multi could not resolve the source Git revision');
  }
}

function defaultRunId(startedAt: Date): string {
  return `legacy-${startedAt.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 12)}`;
}

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new Error('Legacy run id must be a safe identifier');
  }
  return runId;
}
