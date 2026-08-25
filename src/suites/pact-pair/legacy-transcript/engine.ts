import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { digestObjectV1 } from '../../../execution/sharedos/v1/index.js';
import { evaluateWithRegisteredEvaluator } from '../../../evaluation/index.js';
import {
  pactBoundaryPlanV1Schema,
  type PactBoundaryPlanV1,
} from '../../../protocol/v1/index.js';
import {
  intersectBoundaryPlans,
  maximumBoundaryForTask,
  toPublicEvaluation,
  type PactPairPublicEvaluationV1,
} from '../environment.js';
import { PACT_PAIR_EVALUATION_TARGET_V1 } from '../evaluation.js';
import type { PactPairEvaluationV1, PactPairTerminalDecisionV1 } from '../evaluator.js';
import { expectedVisibleSharedOsToolsV1 } from '../sharedos-execution.js';
import type { LoadedPactPairTaskV1 } from '../task-loader.js';
import {
  LEGACY_MULTI_METRIC_FAMILY_ID_V1,
  LEGACY_MULTI_PROTOCOL_ID_V1,
  LEGACY_MULTI_WORKFLOW_ID_V1,
} from './config.js';
import type {
  LegacyAskStrategyV1,
  LegacyRequesterDriverV1,
  LegacyRequesterProvenanceV1,
  LegacyRequesterTickV1,
} from './requester-driver.js';
import type {
  LegacyProviderMessageV1,
  LegacyProviderRequestTelemetryV1,
  PersistentLegacyResponderSessionV1,
} from './responder-session.js';
import {
  classifyLegacyWorldErrorV1,
  legacyFailureDecisionV1,
  type LegacyWorldSubstrateStatusV1,
  type LegacyWorldTickResultV1,
  type PersistentLegacyWorldV1,
} from './world.js';
import type { PairDataStore } from '../schemas.js';

export type LegacyTrajectoryEndReasonV1 =
  | 'driver_stop'
  | 'max_ticks'
  | 'trajectory_timeout'
  | 'infrastructure_error'
  | 'action_state_changed'
  | 'side_effect_before_failure'
  | 'requester_error'
  | 'engine_error';

export type LegacyTickFailureStageV1 =
  | 'requester'
  | 'authority'
  | 'boundary'
  | 'snapshot_before'
  | 'world'
  | 'snapshot_after'
  | 'evaluation'
  | 'requester_observe';

export type LegacyPublicTickV1 = {
  workflowId: typeof LEGACY_MULTI_WORKFLOW_ID_V1;
  protocolId: typeof LEGACY_MULTI_PROTOCOL_ID_V1;
  metricFamilyId: typeof LEGACY_MULTI_METRIC_FAMILY_ID_V1;
  trajectoryId: string;
  tickId: string;
  tick: number;
  phase: 1 | 2;
  taskId: string | null;
  kind: LoadedPactPairTaskV1['kind'] | null;
  requesterStrategy: LegacyAskStrategyV1 | null;
  retryOfTick?: number;
  decisionType: PactPairTerminalDecisionV1['type'];
  terminalReceived: boolean;
  retryEligible: boolean;
  substrateStatus: LegacyWorldSubstrateStatusV1;
  evaluation: PactPairPublicEvaluationV1 | null;
  sideEffectBeforeFailure: boolean;
  stateChanged: boolean;
  grantedAccessDigest: string | null;
  failureStage?: LegacyTickFailureStageV1;
  budgetUsed: { turns: number; toolCalls: number; runtimeMs: number };
  toolCalls: Array<{ callId: string; name: string; isError: boolean }>;
  execution: {
    adapterId: string;
    adapterProtocolVersion: string;
    sharedOsRevision: string;
    traceId?: string;
  };
};

export type LegacyPrivateTickV1 = {
  trajectoryId: string;
  tickId: string;
  tick: number;
  task?: LoadedPactPairTaskV1;
  requesterPrompt?: string;
  finalDecision: PactPairTerminalDecisionV1;
  grantedAccess?: PactBoundaryPlanV1;
  before?: PairDataStore;
  after?: PairDataStore;
  evaluation?: PactPairEvaluationV1;
  privateEvents: unknown[];
  failureStage?: LegacyTickFailureStageV1;
  error?: string;
};

export type LegacyTrajectoryPublicV1 = {
  workflowId: typeof LEGACY_MULTI_WORKFLOW_ID_V1;
  protocolId: typeof LEGACY_MULTI_PROTOCOL_ID_V1;
  metricFamilyId: typeof LEGACY_MULTI_METRIC_FAMILY_ID_V1;
  runId: string;
  trajectoryId: string;
  requesterDriver: LegacyRequesterProvenanceV1;
  responderProvider: {
    requestedModel: string;
    servedModels: string[];
    promptRawSha256: string;
    requests: LegacyProviderRequestTelemetryV1[];
  };
  tickCount: number;
  phase1Ticks: number;
  phase2Ticks: number;
  endReason: LegacyTrajectoryEndReasonV1;
  hasInfrastructureError: boolean;
  checklist: ReturnType<LegacyRequesterDriverV1['finalChecklist']>;
  ticks: LegacyPublicTickV1[];
};

export type LegacyTrajectoryPrivateV1 = {
  runId: string;
  trajectoryId: string;
  initialSnapshot: PairDataStore;
  finalSnapshot: PairDataStore;
  ticks: LegacyPrivateTickV1[];
  responderTranscript: LegacyProviderMessageV1[];
  requesterTranscript?: unknown[];
  requesterUsage?: unknown[];
  error?: string;
};

export type LegacyTrajectoryRunV1 = {
  public: LegacyTrajectoryPublicV1;
  private: LegacyTrajectoryPrivateV1;
};

export type RunLegacyMultiTrajectoryOptionsV1 = {
  runId: string;
  trajectoryId: string;
  tasks: LoadedPactPairTaskV1[];
  maxTicks: number;
  phase2StartTick?: number;
  trajectoryRuntimeMs: number;
  tickBudget: { maxTurns: number; maxToolCalls: number; maxRuntimeMs: number };
  requester: LegacyRequesterDriverV1;
  responder: PersistentLegacyResponderSessionV1;
  world: PersistentLegacyWorldV1;
  boundaryPlanner?: (input: {
    tick: number;
    phase: 1 | 2;
    task: LoadedPactPairTaskV1['publicTask'];
    previousGrant?: PactBoundaryPlanV1;
  }) => PactBoundaryPlanV1 | Promise<PactBoundaryPlanV1>;
  evaluateTick?: (input: {
    task: LoadedPactPairTaskV1;
    decision: PactPairTerminalDecisionV1;
    before: PairDataStore;
    after: PairDataStore;
  }) => PactPairEvaluationV1 | Promise<PactPairEvaluationV1>;
  nowMs?: () => number;
};

const infrastructureStatuses = new Set<LegacyWorldSubstrateStatusV1>([
  'cancelled',
  'failed',
  'provider_error',
  'protocol_error',
  'timeout',
  'kernel_error',
  'requester_error',
  'engine_error',
]);

export async function runLegacyMultiTrajectoryV1(
  options: RunLegacyMultiTrajectoryOptionsV1,
): Promise<LegacyTrajectoryRunV1> {
  const runId = z.string().trim().min(1).max(192).parse(options.runId);
  const trajectoryId = z.string().trim().min(1).max(192).parse(options.trajectoryId);
  const maxTicks = z.number().int().positive().max(240).parse(options.maxTicks);
  const trajectoryRuntimeMs = z.number().int().positive().max(21_600_000)
    .parse(options.trajectoryRuntimeMs);
  const tickBudget = z.object({
    maxTurns: z.number().int().positive().max(1_000),
    maxToolCalls: z.number().int().nonnegative().max(1_000),
    maxRuntimeMs: z.number().int().positive().max(3_600_000),
  }).strict().parse(options.tickBudget);
  const tasks = options.tasks.map(task => structuredClone(task));
  if (tasks.length === 0 || new Set(tasks.map(task => task.taskId)).size !== tasks.length) {
    throw new Error('Legacy trajectory tasks must be non-empty and unique');
  }
  if (
    options.phase2StartTick !== undefined
    && options.phase2StartTick !== tasks.length + 1
  ) {
    throw new Error('Legacy trajectory phase 2 must start after the selected checklist');
  }
  const nowMs = options.nowMs ?? (() => Date.now());
  const trajectoryDeadline = nowMs() + trajectoryRuntimeMs;
  const tasksById = new Map(tasks.map(task => [task.taskId, task]));
  const grantsByTask = new Map<string, PactBoundaryPlanV1>();
  const firstAskedTasks = new Set<string>();
  const publicTicks: LegacyPublicTickV1[] = [];
  const privateTicks: LegacyPrivateTickV1[] = [];
  const tickIds = new Set<string>();
  const publishedTickIds = new Set<string>();
  const initialSnapshot = options.world.snapshot();
  let endReason: LegacyTrajectoryEndReasonV1 = 'max_ticks';
  let privateError: string | undefined;
  let phase1Ticks = 0;
  let phase2Ticks = 0;
  let hasInfrastructureError = false;

  const publishFailedTick = (input: {
    tick: number;
    phase: 1 | 2;
    startedAtMs: number;
    stage: LegacyTickFailureStageV1;
    error: unknown;
    ask?: LegacyRequesterTickV1;
    task?: LoadedPactPairTaskV1;
    grantedAccess?: PactBoundaryPlanV1;
    before?: PairDataStore;
    worldResult?: LegacyWorldTickResultV1;
    after?: PairDataStore;
    evaluation?: PactPairEvaluationV1;
  }): void => {
    const tickId = `${trajectoryId}:tick-${input.tick}`;
    if (publishedTickIds.has(tickId)) {
      throw new Error('Legacy engine attempted to publish one tick twice');
    }
    const stateChanged = input.evaluation?.kind === 'action'
      ? input.evaluation.stateChanged
      : input.task?.kind === 'action' && input.before !== undefined && input.after !== undefined
        ? !isDeepStrictEqual(input.before, input.after)
        : false;
    const decision = input.worldResult?.finalDecision ?? legacyFailureDecisionV1();
    const substrateStatus: LegacyWorldSubstrateStatusV1 = input.stage === 'requester'
      ? 'requester_error'
      : 'engine_error';
    const sanitized = sanitizeEngineError(
      input.error,
      options.responder.options.credential,
    );
    const world = input.worldResult;
    if (!tickIds.has(tickId)) tickIds.add(tickId);
    publishedTickIds.add(tickId);
    publicTicks.push({
      workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
      protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
      metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
      trajectoryId,
      tickId,
      tick: input.tick,
      phase: input.phase,
      taskId: input.task?.taskId ?? null,
      kind: input.task?.kind ?? null,
      requesterStrategy: input.ask?.strategy ?? null,
      ...(input.ask?.retryOfTick === undefined
        ? {}
        : { retryOfTick: input.ask.retryOfTick }),
      decisionType: decision.type,
      terminalReceived: world?.terminalReceived ?? false,
      retryEligible: false,
      substrateStatus,
      evaluation: input.evaluation ? toPublicEvaluation(input.evaluation) : null,
      sideEffectBeforeFailure: stateChanged,
      stateChanged,
      grantedAccessDigest: input.grantedAccess
        ? digestObjectV1(input.grantedAccess)
        : null,
      failureStage: input.stage,
      budgetUsed: {
        turns: world?.turns ?? 0,
        toolCalls: world?.toolCallCount ?? 0,
        runtimeMs: world?.runtimeMs ?? Math.max(0, nowMs() - input.startedAtMs),
      },
      toolCalls: (world?.toolCalls ?? []).map(call => ({
        callId: call.callId,
        name: call.name,
        isError: call.isError,
      })),
      execution: {
        adapterId: world?.adapterId ?? options.world.adapterId,
        adapterProtocolVersion: world?.adapterProtocolVersion ?? 'not-started',
        sharedOsRevision: world?.sharedOsRevision ?? options.world.sharedOsRevision,
        ...(world?.traceId ? { traceId: world.traceId } : {}),
      },
    });
    privateTicks.push({
      trajectoryId,
      tickId,
      tick: input.tick,
      ...(input.task ? { task: input.task } : {}),
      ...(input.ask ? { requesterPrompt: input.ask.prompt } : {}),
      finalDecision: decision,
      ...(input.grantedAccess ? { grantedAccess: input.grantedAccess } : {}),
      ...(input.before ? { before: input.before } : {}),
      ...(input.after ? { after: input.after } : {}),
      ...(input.evaluation ? { evaluation: input.evaluation } : {}),
      privateEvents: world?.privateEvents ?? [],
      failureStage: input.stage,
      error: sanitized,
    });
    if (input.phase === 1) phase1Ticks += 1;
    else phase2Ticks += 1;
    hasInfrastructureError = true;
  };

  const markPublishedTickFailed = (
    tickId: string,
    stage: LegacyTickFailureStageV1,
    error: unknown,
  ): void => {
    const publicTick = publicTicks.find(entry => entry.tickId === tickId);
    const privateTick = privateTicks.find(entry => entry.tickId === tickId);
    if (!publicTick || !privateTick) {
      throw new Error('Legacy engine lost an already-published tick');
    }
    publicTick.substrateStatus = 'engine_error';
    publicTick.retryEligible = false;
    publicTick.failureStage = stage;
    publicTick.sideEffectBeforeFailure = publicTick.stateChanged;
    privateTick.failureStage = stage;
    privateTick.error = sanitizeEngineError(error, options.responder.options.credential);
    hasInfrastructureError = true;
  };

  try {
    await options.responder.initialize({
      sessionId: trajectoryId,
      publicChecklist: tasks.map(task => task.publicTask),
    });
    await options.requester.initialize({
      trajectoryId,
      items: tasks.map(task => task.publicTask),
      ...(options.phase2StartTick === undefined
        ? {}
        : { phase2StartTick: options.phase2StartTick }),
      maxTicks,
    });

    for (let tick = 1; tick <= maxTicks; tick += 1) {
      if (nowMs() >= trajectoryDeadline) {
        endReason = 'trajectory_timeout';
        break;
      }
      const phase: 1 | 2 = options.phase2StartTick !== undefined
        && tick >= options.phase2StartTick ? 2 : 1;
      const tickStartedAt = nowMs();
      const deadlineMs = Math.min(
        trajectoryDeadline,
        nowMs() + tickBudget.maxRuntimeMs,
      );
      const tickId = `${trajectoryId}:tick-${tick}`;
      let failureStage: LegacyTickFailureStageV1 = 'authority';
      let ask: LegacyRequesterTickV1 | undefined;
      let task: LoadedPactPairTaskV1 | undefined;
      let grantedAccess: PactBoundaryPlanV1 | undefined;
      let before: PairDataStore | undefined;
      let worldResult: LegacyWorldTickResultV1 | undefined;
      let after: PairDataStore | undefined;
      let evaluation: PactPairEvaluationV1 | undefined;
      try {
        if (phase === 2 && firstAskedTasks.size !== tasks.length) {
          throw new Error('Legacy phase 2 began before every checklist item was asked once');
        }
        failureStage = 'requester';
        const next = await options.requester.nextTick({ tick, phase, deadlineMs });
        if (next.type === 'stop') {
          endReason = 'driver_stop';
          break;
        }
        ask = next;
        failureStage = 'authority';
        if (ask.phase !== phase) throw new Error('Legacy requester changed the host-owned phase');
        if (ask.principalId !== options.requester.principalId) {
          throw new Error('Legacy requester changed principal inside a trajectory');
        }
        task = tasksById.get(ask.taskId);
        if (!task) throw new Error('Legacy requester selected an off-list task');
        assertRequesterTickAuthority({ ask, phase, publicTicks, firstAskedTasks, taskId: task.taskId });

        failureStage = 'boundary';
        const previousGrant = grantsByTask.get(task.taskId);
        const requested = pactBoundaryPlanV1Schema.parse(
          await (options.boundaryPlanner
            ? options.boundaryPlanner({
                tick,
                phase,
                task: structuredClone(task.publicTask),
                ...(previousGrant ? { previousGrant: structuredClone(previousGrant) } : {}),
              })
            : maximumBoundaryForTask(task.publicTask)),
        );
        const withinTaskMaximum = intersectBoundaryPlans(
          requested,
          maximumBoundaryForTask(task.publicTask),
        );
        grantedAccess = withinTaskMaximum;
        if (previousGrant) {
          const narrowed = intersectBoundaryPlans(withinTaskMaximum, previousGrant);
          if (!isDeepStrictEqual(narrowed, withinTaskMaximum)) {
            throw new Error('Legacy retry boundary replanning attempted to widen the prior grant');
          }
          grantedAccess = narrowed;
        }
        grantsByTask.set(task.taskId, grantedAccess);
        if (phase === 1) firstAskedTasks.add(task.taskId);

        failureStage = 'snapshot_before';
        before = options.world.snapshot();
        failureStage = 'world';
        try {
          worldResult = await options.world.runTick({
            trajectoryId,
            tick,
            task: task.publicTask,
            requesterPrompt: ask.prompt,
            principalId: ask.principalId,
            grantedAccess,
            expectedVisibleTools: expectedVisibleSharedOsToolsV1(grantedAccess),
            budget: {
              maxTurns: tickBudget.maxTurns,
              maxToolCalls: tickBudget.maxToolCalls,
            },
            deadlineMs,
            responder: options.responder,
          });
          assertWorldResultAuthority(worldResult, options.world, trajectoryId, tick, tickIds);
        } catch (error) {
          const classified = classifyLegacyWorldErrorV1(error);
          worldResult = {
            tickId,
            substrateStatus: classified.status,
            terminalReceived: false,
            finalDecision: legacyFailureDecisionV1(),
            turns: 0,
            toolCallCount: 0,
            runtimeMs: Math.max(0, nowMs() - tickStartedAt),
            toolCalls: [],
            adapterId: options.world.adapterId,
            adapterProtocolVersion: 'unknown',
            sharedOsRevision: options.world.sharedOsRevision,
            error: classified.message,
          };
          tickIds.add(tickId);
        }
        failureStage = 'snapshot_after';
        after = options.world.snapshot();
        failureStage = 'evaluation';
        if (options.evaluateTick) {
          evaluation = await options.evaluateTick({
            task,
            decision: worldResult.finalDecision,
            before,
            after,
          });
        } else {
          const evaluationResult = await evaluateWithRegisteredEvaluator(
            PACT_PAIR_EVALUATION_TARGET_V1,
            { task, decision: worldResult.finalDecision, before, after },
          );
          evaluation = evaluationResult.details;
          if (!evaluation) throw new Error('Legacy tick evaluator returned no details');
        }
        const failed = worldResult.substrateStatus !== 'succeeded';
        const stateChanged = evaluation.kind === 'action' && evaluation.stateChanged;
        const sideEffectBeforeFailure = failed && stateChanged;
        const retryEligible = worldResult.substrateStatus === 'succeeded'
          && !stateChanged
          && worldResult.terminalReceived
          && (
            worldResult.finalDecision.type === 'refuse'
            || worldResult.finalDecision.type === 'escalate'
          );
        const infrastructureError = infrastructureStatuses.has(worldResult.substrateStatus);
        hasInfrastructureError ||= infrastructureError;
        const publicEvaluation = infrastructureError && !sideEffectBeforeFailure
          ? null
          : toPublicEvaluation(evaluation);
        publicTicks.push({
          workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
          protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
          metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
          trajectoryId,
          tickId: worldResult.tickId,
          tick,
          phase,
          taskId: task.taskId,
          kind: task.kind,
          requesterStrategy: ask.strategy,
          ...(ask.retryOfTick === undefined ? {} : { retryOfTick: ask.retryOfTick }),
          decisionType: worldResult.finalDecision.type,
          terminalReceived: worldResult.terminalReceived,
          retryEligible,
          substrateStatus: worldResult.substrateStatus,
          evaluation: publicEvaluation,
          sideEffectBeforeFailure,
          stateChanged,
          grantedAccessDigest: digestObjectV1(grantedAccess),
          budgetUsed: {
            turns: worldResult.turns,
            toolCalls: worldResult.toolCallCount,
            runtimeMs: worldResult.runtimeMs,
          },
          toolCalls: worldResult.toolCalls.map(call => ({
            callId: call.callId,
            name: call.name,
            isError: call.isError,
          })),
          execution: {
            adapterId: worldResult.adapterId,
            adapterProtocolVersion: worldResult.adapterProtocolVersion,
            sharedOsRevision: worldResult.sharedOsRevision,
            ...(worldResult.traceId ? { traceId: worldResult.traceId } : {}),
          },
        });
        publishedTickIds.add(worldResult.tickId);
        privateTicks.push({
          trajectoryId,
          tickId: worldResult.tickId,
          tick,
          task,
          requesterPrompt: ask.prompt,
          finalDecision: worldResult.finalDecision,
          grantedAccess,
          before,
          after,
          evaluation,
          privateEvents: worldResult.privateEvents ?? [],
          ...(worldResult.error
            ? { error: sanitizeEngineError(worldResult.error, options.responder.options.credential) }
            : {}),
        });
        if (phase === 1) phase1Ticks += 1;
        else phase2Ticks += 1;

        failureStage = 'requester_observe';
        await options.requester.observe({
          tick,
          taskId: task.taskId,
          decision: worldResult.finalDecision,
          terminalReceived: worldResult.terminalReceived,
          substrateStatus: worldResult.substrateStatus,
          sideEffectBeforeFailure,
          stateChanged,
        });
        if (stateChanged) {
          endReason = sideEffectBeforeFailure
            ? 'side_effect_before_failure'
            : 'action_state_changed';
          break;
        }
        if (infrastructureError) {
          endReason = 'infrastructure_error';
          privateError ??= worldResult.error
            ? sanitizeEngineError(worldResult.error, options.responder.options.credential)
            : undefined;
          break;
        }
      } catch (error) {
        if (publishedTickIds.has(tickId)) {
          markPublishedTickFailed(tickId, failureStage, error);
        } else {
          publishFailedTick({
            tick,
            phase,
            startedAtMs: tickStartedAt,
            stage: failureStage,
            error,
            ...(ask ? { ask } : {}),
            ...(task ? { task } : {}),
            ...(grantedAccess ? { grantedAccess } : {}),
            ...(before ? { before } : {}),
            ...(worldResult ? { worldResult } : {}),
            ...(after ? { after } : {}),
            ...(evaluation ? { evaluation } : {}),
          });
        }
        endReason = failureStage === 'requester' ? 'requester_error' : 'engine_error';
        privateError = sanitizeEngineError(error, options.responder.options.credential);
        break;
      }
    }
  } catch (error) {
    endReason = 'engine_error';
    privateError = sanitizeEngineError(error, options.responder.options.credential);
  } finally {
    try {
      await options.world.close();
    } catch (error) {
      endReason = 'engine_error';
      privateError ??= sanitizeEngineError(error, options.responder.options.credential);
    }
  }

  const requesterTranscript = readOptionalArray(options.requester, 'privateTranscript');
  const requesterUsage = readOptionalArray(options.requester, 'usageRecords');
  if (
    endReason === 'trajectory_timeout'
    || endReason === 'infrastructure_error'
    || endReason === 'requester_error'
    || endReason === 'engine_error'
  ) {
    hasInfrastructureError = true;
  }
  const checklist = projectLegacyChecklist(tasks, publicTicks);
  return {
    public: {
      workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
      protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
      metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
      runId,
      trajectoryId,
      requesterDriver: options.requester.provenance(),
      responderProvider: options.responder.telemetry(),
      tickCount: publicTicks.length,
      phase1Ticks,
      phase2Ticks,
      endReason,
      hasInfrastructureError,
      checklist,
      ticks: publicTicks,
    },
    private: {
      runId,
      trajectoryId,
      initialSnapshot,
      finalSnapshot: options.world.snapshot(),
      ticks: privateTicks,
      responderTranscript: options.responder.privateTranscript(),
      ...(requesterTranscript ? { requesterTranscript } : {}),
      ...(requesterUsage ? { requesterUsage } : {}),
      ...(privateError ? { error: privateError } : {}),
    },
  };
}

function projectLegacyChecklist(
  tasks: readonly LoadedPactPairTaskV1[],
  ticks: readonly LegacyPublicTickV1[],
): ReturnType<LegacyRequesterDriverV1['finalChecklist']> {
  return tasks.map(task => {
    const itemTicks = ticks.filter(tick => tick.taskId === task.taskId);
    const latest = itemTicks[itemTicks.length - 1];
    const status = !latest
      ? 'pending' as const
      : latest.substrateStatus !== 'succeeded' || !latest.terminalReceived
        ? 'error' as const
        : latest.decisionType === 'answer'
          ? 'answered' as const
          : 'refused' as const;
    return { taskId: task.taskId, status, asks: itemTicks.length };
  });
}

function assertRequesterTickAuthority(input: {
  ask: {
    taskId: string;
    strategy: LegacyAskStrategyV1;
    retryOfTick?: number;
  };
  phase: 1 | 2;
  publicTicks: readonly LegacyPublicTickV1[];
  firstAskedTasks: ReadonlySet<string>;
  taskId: string;
}): void {
  if (input.phase === 1) {
    if (input.ask.strategy !== 'first_ask' || input.ask.retryOfTick !== undefined) {
      throw new Error('Legacy phase-1 ask violated the first-ask authority');
    }
    if (input.firstAskedTasks.has(input.taskId)) {
      throw new Error('Legacy phase-1 requester repeated a checklist item');
    }
    return;
  }
  if (input.ask.strategy === 'first_ask' || input.ask.retryOfTick === undefined) {
    throw new Error('Legacy phase-2 ask is missing retry authority');
  }
  const prior = input.publicTicks.find(tick => tick.tick === input.ask.retryOfTick);
  const itemTicks = input.publicTicks.filter(tick => tick.taskId === input.taskId);
  const latestForTask = itemTicks[itemTicks.length - 1];
  if (
    !prior
    || latestForTask !== prior
    || prior.taskId !== input.taskId
    || !prior.terminalReceived
    || !prior.retryEligible
  ) {
    throw new Error('Legacy phase-2 ask does not reference a retry-eligible outcome');
  }
}

function assertWorldResultAuthority(
  result: LegacyWorldTickResultV1,
  world: PersistentLegacyWorldV1,
  trajectoryId: string,
  tick: number,
  tickIds: Set<string>,
): void {
  const expectedTickId = `${trajectoryId}:tick-${tick}`;
  if (result.tickId !== expectedTickId || tickIds.has(result.tickId)) {
    throw new Error('Legacy world returned duplicate or mismatched tick authority');
  }
  if (
    result.adapterId !== world.adapterId
    || result.sharedOsRevision !== world.sharedOsRevision
  ) {
    throw new Error('Legacy world execution provenance drifted within a trajectory');
  }
  if (new Set(result.toolCalls.map(call => call.callId)).size !== result.toolCalls.length) {
    throw new Error('Legacy world returned duplicate tool-call authority');
  }
  if (result.toolCallCount !== result.toolCalls.length) {
    throw new Error('Legacy world returned inconsistent tool-call cardinality');
  }
  if (
    !Number.isSafeInteger(result.turns)
    || result.turns < 0
    || !Number.isSafeInteger(result.toolCallCount)
    || result.toolCallCount < 0
    || !Number.isFinite(result.runtimeMs)
    || result.runtimeMs < 0
  ) {
    throw new Error('Legacy world returned invalid budget cardinality');
  }
  if (result.toolCalls.some(call => call.tickId !== result.tickId)) {
    throw new Error('Legacy world returned a tool call bound to another tick');
  }
  if (result.terminalReceived && result.substrateStatus !== 'succeeded') {
    throw new Error('Legacy world marked a failed substrate as responder-authored terminal');
  }
  tickIds.add(result.tickId);
}

function readOptionalArray(
  value: object,
  method: 'privateTranscript' | 'usageRecords',
): unknown[] | undefined {
  const candidate = (value as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') return undefined;
  const result = candidate.call(value) as unknown;
  return Array.isArray(result) ? structuredClone(result) : undefined;
}

function sanitizeEngineError(error: unknown, credential: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(credential).join('[REDACTED]').slice(0, 2_000)
    || 'Legacy trajectory engine failed';
}
