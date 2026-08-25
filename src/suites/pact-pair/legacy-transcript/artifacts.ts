import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { SharedOsAdapterIdV1 } from '../../../execution/sharedos/v1/index.js';
import type {
  FrozenLegacyMultiAssetsV1,
  LegacyAssetProvenanceV1,
} from './assets.js';
import {
  LEGACY_MULTI_METRIC_FAMILY_ID_V1,
  LEGACY_MULTI_PROTOCOL_ID_V1,
  LEGACY_MULTI_WORKFLOW_ID_V1,
} from './config.js';
import type {
  LegacyPublicTickV1,
  LegacyTrajectoryPublicV1,
  LegacyTrajectoryRunV1,
} from './engine.js';
import {
  LEGACY_RETRY_STRATEGIES_V1,
  type LegacyRetryStrategyV1,
} from './requester-driver.js';
import type { LegacyWorldSubstrateStatusV1 } from './world.js';

export const LEGACY_SOURCE_PR_HEADS_V1 = {
  pr20: 'b313a3940ebb400ba4866d2967f7587564a1a7a2',
  pr27: 'ea0508133cb2633b6a1e7656eb48844e844a12c1',
  pr35: '226e47f6e3a01317a7046649bf5870f8b0533c1d',
} as const;

type PublicAgentAssetsV1 = {
  persona: FrozenLegacyMultiAssetsV1['responder']['persona'];
  coo: LegacyAssetProvenanceV1;
  policy: LegacyAssetProvenanceV1;
  memory: LegacyAssetProvenanceV1;
};

export type LegacyPublicRunManifestV1 = {
  schemaVersion: 1;
  workflowId: typeof LEGACY_MULTI_WORKFLOW_ID_V1;
  protocolId: typeof LEGACY_MULTI_PROTOCOL_ID_V1;
  metricFamilyId: typeof LEGACY_MULTI_METRIC_FAMILY_ID_V1;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'completed_with_errors';
  effectiveConfigDigest: string;
  taskSetDigest: string;
  sourceRevision: string;
  selectedTaskIds: string[];
  sourcePrHeads: typeof LEGACY_SOURCE_PR_HEADS_V1;
  execution: {
    backend: 'local';
    adapterId: Extract<SharedOsAdapterIdV1, 'pact-public-runner' | 'sharedos-embedded'>;
    sharedOsRevision: string;
    sharedOsRuntimeDigest?: string;
  };
  assets: {
    responder: PublicAgentAssetsV1;
    requester:
      | { kind: 'scripted'; script: LegacyAssetProvenanceV1 }
      | { kind: 'model'; agent: PublicAgentAssetsV1 };
  };
};

export type LegacyUsageSummaryV1 = {
  requests: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  servedModels: string[];
};

export type LegacyPublishedRunManifestV1 = LegacyPublicRunManifestV1 & {
  providers: {
    requester:
      | {
          kind: 'scripted';
          scripts: Array<{
            id: string;
            version: number;
            path: string;
            rawSha256: string;
            bytes: number;
          }>;
        }
      | {
          kind: 'model';
          requestedModels: string[];
          servedModels: string[];
          promptRawSha256s: string[];
        };
    responder: {
      requestedModels: string[];
      servedModels: string[];
      promptRawSha256s: string[];
    };
  };
  usage: {
    requester: LegacyUsageSummaryV1;
    responder: LegacyUsageSummaryV1;
  };
};

export type LegacyRateV1 = {
  numerator: number;
  denominator: number;
  value: number | null;
};

export type LegacyTrajectoryMetricSummaryV1 = {
  metricFamilyId: typeof LEGACY_MULTI_METRIC_FAMILY_ID_V1;
  trajectories: LegacyRateV1;
  ticks: LegacyRateV1;
  infrastructureTrajectories: LegacyRateV1;
  infrastructureTicks: LegacyRateV1;
  experimentalTicks: LegacyRateV1;
  nonSuccessfulTicks: LegacyRateV1;
  sideEffectBeforeFailureTicks: LegacyRateV1;
  everAnsweredItems: LegacyRateV1;
  everLeakedItems: LegacyRateV1;
  finalAnsweredItems: LegacyRateV1;
  finalRefusedItems: LegacyRateV1;
  finalErroredItems: LegacyRateV1;
  finalPendingItems: LegacyRateV1;
  substrateStatusCounts: Record<LegacyWorldSubstrateStatusV1, number>;
  endReasonCounts: Record<string, number>;
  retry: {
    opportunities: number;
    attempts: number;
    flips: number;
    holds: number;
    errors: number;
    attemptRate: LegacyRateV1;
    byStrategy: Record<LegacyRetryStrategyV1, {
      attempts: number;
      flips: number;
      holds: number;
      errors: number;
    }>;
  };
};

const infrastructureStatuses = new Set<LegacyWorldSubstrateStatusV1>([
  'cancelled', 'failed', 'provider_error', 'protocol_error', 'timeout', 'kernel_error',
  'requester_error', 'engine_error',
]);

export function summarizeLegacyTrajectoriesV1(
  trajectories: readonly LegacyTrajectoryPublicV1[],
): LegacyTrajectoryMetricSummaryV1 {
  const allTicks = trajectories.flatMap(trajectory => trajectory.ticks);
  const itemSlots = trajectories.reduce((sum, trajectory) =>
    sum + trajectory.checklist.length, 0);
  const statusCounts = emptyStatusCounts();
  const endReasonCounts: Record<string, number> = {};
  const byStrategy = Object.fromEntries(
    LEGACY_RETRY_STRATEGIES_V1.map(strategy => [strategy, {
      attempts: 0, flips: 0, holds: 0, errors: 0,
    }]),
  ) as LegacyTrajectoryMetricSummaryV1['retry']['byStrategy'];
  let everAnswered = 0;
  let everLeaked = 0;
  let finalAnswered = 0;
  let finalRefused = 0;
  let finalErrored = 0;
  let finalPending = 0;
  let retryAttempts = 0;
  let retryOpportunities = 0;
  let retryFlips = 0;
  let retryHolds = 0;
  let retryErrors = 0;

  for (const trajectory of trajectories) {
    endReasonCounts[trajectory.endReason] = (endReasonCounts[trajectory.endReason] ?? 0) + 1;
    const checklistIds = trajectory.checklist.map(item => item.taskId);
    if (new Set(checklistIds).size !== checklistIds.length) {
      throw new Error(`Legacy trajectory ${trajectory.trajectoryId} has duplicate checklist items`);
    }
    for (const item of trajectory.checklist) {
      const itemTicks = trajectory.ticks.filter(tick => tick.taskId === item.taskId);
      if (itemTicks.some(tick => tick.terminalReceived && tick.decisionType === 'answer')) {
        everAnswered += 1;
      }
      if (itemTicks.some(tick => tick.evaluation?.kind === 'qa' && tick.evaluation.leaked)) {
        everLeaked += 1;
      }
      if (item.status === 'answered') finalAnswered += 1;
      else if (item.status === 'refused') finalRefused += 1;
      else if (item.status === 'error') finalErrored += 1;
      else finalPending += 1;
    }
    const ticksByNumber = new Map(trajectory.ticks.map(tick => [tick.tick, tick]));
    for (const tick of trajectory.ticks) {
      statusCounts[tick.substrateStatus] += 1;
      if (tick.retryEligible) {
        retryOpportunities += 1;
      }
      if (tick.retryOfTick === undefined) continue;
      if (tick.requesterStrategy === null || tick.requesterStrategy === 'first_ask') {
        throw new Error('Legacy retry tick cannot use first_ask');
      }
      const prior = ticksByNumber.get(tick.retryOfTick);
      if (!prior || tick.taskId === null || prior.taskId !== tick.taskId) {
        throw new Error('Legacy retry metric row has invalid tick authority');
      }
      const strategy = tick.requesterStrategy;
      retryAttempts += 1;
      byStrategy[strategy].attempts += 1;
      if (tick.terminalReceived && tick.decisionType === 'answer') {
        retryFlips += 1;
        byStrategy[strategy].flips += 1;
      } else if (
        tick.terminalReceived
        && (tick.decisionType === 'refuse' || tick.decisionType === 'escalate')
      ) {
        retryHolds += 1;
        byStrategy[strategy].holds += 1;
      } else {
        retryErrors += 1;
        byStrategy[strategy].errors += 1;
      }
    }
  }

  const infrastructureTickCount = allTicks.filter(tick =>
    infrastructureStatuses.has(tick.substrateStatus)).length;
  return {
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    trajectories: rate(trajectories.length, trajectories.length),
    ticks: rate(allTicks.length, allTicks.length),
    infrastructureTrajectories: rate(
      trajectories.filter(trajectory => trajectory.hasInfrastructureError).length,
      trajectories.length,
    ),
    infrastructureTicks: rate(infrastructureTickCount, allTicks.length),
    experimentalTicks: rate(
      allTicks.filter(tick =>
        tick.substrateStatus === 'denied' || tick.substrateStatus === 'budget').length,
      allTicks.length,
    ),
    nonSuccessfulTicks: rate(
      allTicks.filter(tick => tick.substrateStatus !== 'succeeded').length,
      allTicks.length,
    ),
    sideEffectBeforeFailureTicks: rate(
      allTicks.filter(tick => tick.sideEffectBeforeFailure).length,
      allTicks.length,
    ),
    everAnsweredItems: rate(everAnswered, itemSlots),
    everLeakedItems: rate(everLeaked, itemSlots),
    finalAnsweredItems: rate(finalAnswered, itemSlots),
    finalRefusedItems: rate(finalRefused, itemSlots),
    finalErroredItems: rate(finalErrored, itemSlots),
    finalPendingItems: rate(finalPending, itemSlots),
    substrateStatusCounts: statusCounts,
    endReasonCounts,
    retry: {
      opportunities: retryOpportunities,
      attempts: retryAttempts,
      flips: retryFlips,
      holds: retryHolds,
      errors: retryErrors,
      attemptRate: rate(retryAttempts, retryOpportunities),
      byStrategy,
    },
  };
}

export type WriteLegacyMultiArtifactsOptionsV1 = {
  outputRoot: string;
  manifest: LegacyPublicRunManifestV1;
  trajectories: LegacyTrajectoryRunV1[];
  savePrivate: boolean;
  hooks?: { beforePublish?: () => void | Promise<void> };
};

export async function writeLegacyMultiArtifactsV1(
  options: WriteLegacyMultiArtifactsOptionsV1,
): Promise<string> {
  validateManifest(options.manifest);
  validateTrajectoryAuthority(options.manifest, options.trajectories);
  const publicTrajectories = options.trajectories.map(result => result.public);
  const publishedManifest: LegacyPublishedRunManifestV1 = {
    ...structuredClone(options.manifest),
    providers: summarizeProviderProvenance(options.trajectories),
    usage: summarizeUsage(options.trajectories),
  };
  const metrics = summarizeLegacyTrajectoriesV1(publicTrajectories);
  const publicTicks = publicTrajectories.flatMap(trajectory => trajectory.ticks);
  const trajectoryRows = publicTrajectories.map(({ ticks: _ticks, ...trajectory }) => trajectory);
  assertNoPrivatePublicKeys(publishedManifest);
  assertNoPrivatePublicKeys(publicTicks);
  assertNoPrivatePublicKeys(trajectoryRows);
  assertNoPrivatePublicKeys(metrics);

  await mkdir(options.outputRoot, { recursive: true });
  const rootStats = await lstat(options.outputRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Legacy artifact root must be a real directory');
  }
  const root = await realpath(options.outputRoot);
  const finalDirectory = path.join(root, options.manifest.runId);
  const stagingDirectory = path.join(
    root,
    `.${options.manifest.runId}.${randomUUID()}.tmp`,
  );
  const lockPath = path.join(root, `.${options.manifest.runId}.publish.lock`);
  const lock = await open(lockPath, 'wx');
  let published = false;
  try {
    if (await lstat(finalDirectory).catch(() => undefined)) {
      throw new Error(`Legacy run directory already exists: ${options.manifest.runId}`);
    }
    await mkdir(stagingDirectory, { recursive: false });
    if (options.savePrivate) {
      await mkdir(path.join(stagingDirectory, 'private'), { recursive: false });
    }
    await writeExclusive(
      path.join(stagingDirectory, 'run.json'),
      `${JSON.stringify(publishedManifest, null, 2)}\n`,
    );
    await writeExclusive(
      path.join(stagingDirectory, 'ticks.jsonl'),
      toJsonLines(publicTicks),
    );
    await writeExclusive(
      path.join(stagingDirectory, 'trajectories.jsonl'),
      toJsonLines(trajectoryRows),
    );
    await writeExclusive(
      path.join(stagingDirectory, 'trajectory-summary.json'),
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
    if (options.savePrivate) {
      await writeExclusive(
        path.join(stagingDirectory, 'private', 'trajectories.jsonl'),
        toJsonLines(options.trajectories.map(result => result.private)),
      );
    }
    await options.hooks?.beforePublish?.();
    await rename(stagingDirectory, finalDirectory);
    published = true;
    return finalDirectory;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    if (!published) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function validateManifest(manifest: LegacyPublicRunManifestV1): void {
  if (
    manifest.workflowId !== LEGACY_MULTI_WORKFLOW_ID_V1
    || manifest.protocolId !== LEGACY_MULTI_PROTOCOL_ID_V1
    || manifest.metricFamilyId !== LEGACY_MULTI_METRIC_FAMILY_ID_V1
  ) {
    throw new Error('Legacy run manifest uses another workflow or metric lane');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(manifest.runId)) {
    throw new Error('Legacy run id is not a safe artifact directory name');
  }
  for (const [label, digest] of [
    ['effective config', manifest.effectiveConfigDigest],
    ['task set', manifest.taskSetDigest],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Invalid ${label} digest`);
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceRevision)) {
    throw new Error('Legacy source revision must be a full Git commit');
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.execution.sharedOsRevision)) {
    throw new Error('Legacy SharedOS revision must be a full Git commit');
  }
  if (
    manifest.selectedTaskIds.length === 0
    || new Set(manifest.selectedTaskIds).size !== manifest.selectedTaskIds.length
  ) {
    throw new Error('Legacy manifest selected task ids must be non-empty and unique');
  }
  if (JSON.stringify(manifest.sourcePrHeads) !== JSON.stringify(LEGACY_SOURCE_PR_HEADS_V1)) {
    throw new Error('Legacy source PR-head provenance does not match the reviewed heads');
  }
  for (const asset of manifestAssets(manifest)) validateAsset(asset);
}

function manifestAssets(manifest: LegacyPublicRunManifestV1): LegacyAssetProvenanceV1[] {
  const responder = manifest.assets.responder;
  return [
    responder.coo,
    responder.policy,
    responder.memory,
    ...(manifest.assets.requester.kind === 'scripted'
      ? [manifest.assets.requester.script]
      : [
          manifest.assets.requester.agent.coo,
          manifest.assets.requester.agent.policy,
          manifest.assets.requester.agent.memory,
        ]),
  ];
}

function validateAsset(asset: LegacyAssetProvenanceV1): void {
  if (
    asset.status !== 'legacy'
    || !/^[0-9a-f]{64}$/.test(asset.rawSha256)
    || !Number.isSafeInteger(asset.bytes)
    || asset.bytes < 1
    || path.isAbsolute(asset.path)
    || asset.path.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('Legacy public asset provenance is invalid');
  }
}

function validateTrajectoryAuthority(
  manifest: LegacyPublicRunManifestV1,
  trajectories: readonly LegacyTrajectoryRunV1[],
): void {
  if (trajectories.length === 0) throw new Error('Legacy run has no trajectories');
  const ids = new Set<string>();
  const ticks = new Set<string>();
  let requesterKind: 'scripted' | 'model' | undefined;
  for (const result of trajectories) {
    const publicResult = result.public;
    if (
      publicResult.runId !== manifest.runId
      || result.private.runId !== manifest.runId
      || publicResult.trajectoryId !== result.private.trajectoryId
      || ids.has(publicResult.trajectoryId)
    ) {
      throw new Error('Legacy trajectory authority is duplicate or mismatched');
    }
    ids.add(publicResult.trajectoryId);
    requesterKind ??= publicResult.requesterDriver.kind;
    if (publicResult.requesterDriver.kind !== requesterKind) {
      throw new Error('Legacy run cannot mix requester protocols');
    }
    if (publicResult.tickCount !== publicResult.ticks.length) {
      throw new Error('Legacy trajectory tick cardinality is inconsistent');
    }
    if (publicResult.phase1Ticks + publicResult.phase2Ticks !== publicResult.tickCount) {
      throw new Error('Legacy trajectory phase cardinality is inconsistent');
    }
    const checklistIds = publicResult.checklist.map(item => item.taskId);
    if (
      new Set(checklistIds).size !== checklistIds.length
      || checklistIds.length !== manifest.selectedTaskIds.length
      || checklistIds.some((taskId, index) => taskId !== manifest.selectedTaskIds[index])
    ) {
      throw new Error('Legacy trajectory checklist does not match the selected task authority');
    }
    const expectedRequesterKind = manifest.assets.requester.kind;
    if (publicResult.requesterDriver.kind !== expectedRequesterKind) {
      throw new Error('Legacy trajectory requester protocol does not match the manifest');
    }
    if (publicResult.requesterDriver.kind === 'scripted') {
      const script = manifest.assets.requester.kind === 'scripted'
        ? manifest.assets.requester.script
        : undefined;
      if (
        !script
        || publicResult.requesterDriver.scriptPath !== script.path
        || publicResult.requesterDriver.scriptRawSha256 !== script.rawSha256
        || publicResult.requesterDriver.scriptBytes !== script.bytes
      ) {
        throw new Error('Legacy scripted requester provenance drifted from its frozen asset');
      }
    }
    for (const tick of publicResult.ticks) {
      if (
        tick.trajectoryId !== publicResult.trajectoryId
        || tick.tickId !== `${publicResult.trajectoryId}:tick-${tick.tick}`
        || ticks.has(tick.tickId)
      ) {
        throw new Error('Legacy public tick authority is duplicate or mismatched');
      }
      if (
        tick.workflowId !== manifest.workflowId
        || tick.protocolId !== manifest.protocolId
        || tick.metricFamilyId !== manifest.metricFamilyId
        || (tick.taskId !== null && !checklistIds.includes(tick.taskId))
        || tick.execution.adapterId !== manifest.execution.adapterId
        || tick.execution.sharedOsRevision !== manifest.execution.sharedOsRevision
        || tick.budgetUsed.toolCalls !== tick.toolCalls.length
      ) {
        throw new Error('Legacy public tick provenance or cardinality is inconsistent');
      }
      const isErrorTick = tick.substrateStatus === 'requester_error'
        || tick.substrateStatus === 'engine_error';
      if (
        (!isErrorTick && (
          tick.taskId === null
          || tick.kind === null
          || tick.requesterStrategy === null
          || tick.grantedAccessDigest === null
        ))
        || (tick.taskId === null && tick.evaluation !== null)
        || (tick.evaluation?.kind === 'action'
          && tick.evaluation.stateChanged !== tick.stateChanged)
        || (tick.evaluation?.kind === 'qa' && tick.stateChanged)
        || tick.sideEffectBeforeFailure
          !== (tick.stateChanged && tick.substrateStatus !== 'succeeded')
      ) {
        throw new Error('Legacy public tick state or failure authority is inconsistent');
      }
      const expectedRetryEligible = tick.substrateStatus === 'succeeded'
        && !tick.stateChanged
        && tick.terminalReceived
        && (tick.decisionType === 'refuse' || tick.decisionType === 'escalate');
      if (tick.retryEligible !== expectedRetryEligible) {
        throw new Error('Legacy public tick retry authority is inconsistent');
      }
      ticks.add(tick.tickId);
    }
    for (const item of publicResult.checklist) {
      const asks = publicResult.ticks.filter(tick => tick.taskId === item.taskId).length;
      if (item.asks !== asks) {
        throw new Error('Legacy checklist ask cardinality is inconsistent');
      }
    }
  }
}

function summarizeProviderProvenance(
  trajectories: readonly LegacyTrajectoryRunV1[],
): LegacyPublishedRunManifestV1['providers'] {
  const requesterDrivers = trajectories.map(result => result.public.requesterDriver);
  const firstRequester = requesterDrivers[0];
  if (!firstRequester) throw new Error('Legacy run has no requester provenance');
  const requester: LegacyPublishedRunManifestV1['providers']['requester'] =
    firstRequester.kind === 'scripted'
      ? {
          kind: 'scripted',
          scripts: uniqueJson(requesterDrivers.flatMap(driver =>
            driver.kind === 'scripted' ? [{
              id: driver.id,
              version: driver.version,
              path: driver.scriptPath,
              rawSha256: driver.scriptRawSha256,
              bytes: driver.scriptBytes,
            }] : [])),
        }
      : {
          kind: 'model',
          requestedModels: uniqueStrings(requesterDrivers.flatMap(driver =>
            driver.kind === 'model' ? [driver.requestedModel] : [])),
          servedModels: uniqueStrings(requesterDrivers.flatMap(driver =>
            driver.kind === 'model' ? driver.servedModels : [])),
          promptRawSha256s: uniqueStrings(requesterDrivers.flatMap(driver =>
            driver.kind === 'model' ? [driver.promptRawSha256] : [])),
        };
  return {
    requester,
    responder: {
      requestedModels: uniqueStrings(trajectories.map(result =>
        result.public.responderProvider.requestedModel)),
      servedModels: uniqueStrings(trajectories.flatMap(result =>
        result.public.responderProvider.servedModels)),
      promptRawSha256s: uniqueStrings(trajectories.map(result =>
        result.public.responderProvider.promptRawSha256)),
    },
  };
}

function summarizeUsage(trajectories: readonly LegacyTrajectoryRunV1[]): {
  requester: LegacyUsageSummaryV1;
  responder: LegacyUsageSummaryV1;
} {
  const responderRecords = trajectories.flatMap(result =>
    result.public.responderProvider.requests.map(record => ({
      ...record.usage,
      servedModel: record.servedModel,
    })));
  const requesterRecords = trajectories.flatMap(result =>
    (result.private.requesterUsage ?? []).flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      return [{
        promptTokens: finiteNumber(record.promptTokens),
        completionTokens: finiteNumber(record.completionTokens),
        totalTokens: finiteNumber(record.totalTokens),
        costUsd: finiteNumber(record.costUsd),
        servedModel: typeof record.servedModel === 'string' ? record.servedModel : undefined,
      }];
    }));
  return {
    requester: aggregateUsage(requesterRecords),
    responder: aggregateUsage(responderRecords),
  };
}

function aggregateUsage(records: Array<{
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  servedModel?: string;
}>): LegacyUsageSummaryV1 {
  const sum = (key: 'promptTokens' | 'completionTokens' | 'totalTokens' | 'costUsd') => {
    const values = records.flatMap(record => record[key] === undefined ? [] : [record[key]]);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  return {
    requests: records.length,
    ...(sum('promptTokens') === undefined ? {} : { promptTokens: sum('promptTokens') }),
    ...(sum('completionTokens') === undefined ? {} : { completionTokens: sum('completionTokens') }),
    ...(sum('totalTokens') === undefined ? {} : { totalTokens: sum('totalTokens') }),
    ...(sum('costUsd') === undefined ? {} : { costUsd: sum('costUsd') }),
    servedModels: [...new Set(records.flatMap(record =>
      record.servedModel ? [record.servedModel] : []))].sort(),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueJson<T>(values: readonly T[]): T[] {
  const byJson = new Map(values.map(value => [JSON.stringify(value), value]));
  return [...byJson.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function emptyStatusCounts(): Record<LegacyWorldSubstrateStatusV1, number> {
  return {
    succeeded: 0,
    denied: 0,
    cancelled: 0,
    failed: 0,
    budget: 0,
    provider_error: 0,
    protocol_error: 0,
    timeout: 0,
    kernel_error: 0,
    requester_error: 0,
    engine_error: 0,
  };
}

function rate(numerator: number, denominator: number): LegacyRateV1 {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

function assertNoPrivatePublicKeys(value: unknown, location = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivatePublicKeys(entry, `${location}[${index}]`));
    return;
  }
  const forbidden = new Set([
    'task',
    'requesterPrompt',
    'finalDecision',
    'before',
    'after',
    'privateEvents',
    'responderTranscript',
    'requesterTranscript',
    'credential',
    'apiKey',
    'apiKeyEnv',
    'gold',
    'question',
    'action',
  ]);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) {
      throw new Error(`Private field ${location}.${key} cannot enter legacy public artifacts`);
    }
    assertNoPrivatePublicKeys(entry, `${location}.${key}`);
  }
}

async function writeExclusive(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function toJsonLines(values: readonly unknown[]): string {
  return values.map(value => JSON.stringify(value)).join('\n')
    + (values.length > 0 ? '\n' : '');
}
