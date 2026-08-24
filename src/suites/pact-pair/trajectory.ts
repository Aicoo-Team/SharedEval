/**
 * PACT-Pair multi-turn trajectory engine (docs/pact-pair-multi-turn-lane.md).
 *
 * A trajectory is one persistent SharedOS world driven for up to `maxTicks`
 * ticks. Each tick is exactly one bounded kernel turn (`runTurn`, one
 * `turnId`); within a tick the responder harness takes up to `budget.maxTurns`
 * steps. The world (workspace, kernel, responder transcript) persists across
 * ticks — `initWorld` once, `runTurn` per tick, `closeWorld` at the end — so
 * the responder must remember what it already disclosed. The requester driver
 * decides each tick's ask from public views only (no gold).
 *
 * Grant discipline (option (i), §9.4): the granted boundary is recomputed for
 * every tick (each tick is a different task with its own host ceiling), fed
 * through a mutable holder the world's grant closure and tool handlers read,
 * and enforced per turn via a per-turn `expectedVisibleTools` override — so a
 * trajectory never widens standing grants beyond what the single-turn lane
 * would grant for the same task. The transcript is never reset after tick 1;
 * `planBoundary` is pure and safe to re-call per tick.
 *
 * Grading (§3.4): the DB-diff baseline is re-based per tick (snapshot before
 * and after each tick) so gold checks keep their exact-shape semantics even
 * as the world accumulates state; the trajectory-initial snapshot is kept so a
 * whole-trajectory diff is also recordable. A mutation that lands at tick k
 * and later errors stays scored (the side-effect-before-failure discipline
 * inherited from the single-turn lane).
 */
import {
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  PACT_ADAPTER_PROTOCOL_VERSION_V1,
  type PactBoundaryPlanV1,
  type PactHarnessV1,
  type PactObservationV1,
} from '../../protocol/v1/index.js';
import { evaluateWithRegisteredEvaluator } from '../../evaluation/index.js';
import { pactModelIdentifierV1, type PactRunConfigV1 } from '../../runner/v1/config.js';
import { readPactProviderTelemetryV1 } from '../../runner/v1/model-adapter.js';
import {
  EmbeddedSharedOsAdapterV1,
  digestObjectV1,
  MAX_TURN_TIMEOUT_MS_V1,
  SharedOsWorldGateErrorV1,
  type EmbeddedWorldV1,
  type SoAddress,
  type SoToolResult,
  type SoTurnDecision,
  type SoTurnDriver,
} from '../../execution/sharedos/v1/index.js';
import {
  classifyRunnerFailure,
  deniedBoundary,
  intersectBoundaryPlans,
  maximumBoundaryForTask,
  redactDecisionCredential,
  remainingBudget,
  sanitizeError,
  toPublicEvaluation,
  withinDeadline,
  type PactPairPublicEvaluationV1,
  type PactPairSingleTaskRunV1,
  type PactPairTaskResultV1,
  type PactPairTraceEventV1,
} from './environment.js';
import type { PactProviderTelemetryV1 } from '../../runner/v1/model-adapter.js';
import {
  createPactPairSharedOsToolHandlersV1,
  expectedVisibleSharedOsToolsV1,
  grantedSharedOsActionsV1,
  requireSharedOsModulesV1,
  PACT_PAIR_SHAREDOS_INTENT_V1,
  PACT_PAIR_SHAREDOS_OWNER_V1,
  PACT_PAIR_SHAREDOS_PURPOSE_V1,
  PACT_PAIR_SHAREDOS_RESPONDER_V1,
  PACT_PAIR_SHAREDOS_TOOL_NAMESPACE_V1,
} from './sharedos-execution.js';
import { PACT_PAIR_TOOL_SPECS_V1 } from './tools.js';
import { createPactPairWorkspaceV1 } from './workspace.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import type { PairDataStore } from './schemas.js';
import type { PactPairTerminalDecisionV1 } from './evaluator.js';
import { PACT_PAIR_EVALUATION_TARGET_V1 } from './evaluation.js';
import type {
  PactPairRequesterDriverV1,
  PactPairChecklistItemV1,
  PactPairAskStrategyV1,
} from './requester-driver.js';

const availableToolNames = new Set(PACT_PAIR_TOOL_SPECS_V1.map(tool => tool.name));

/** Public per-tick artifact row (ticks.jsonl); never carries gold. */
export type PactPairTrajectoryTickRecordV1 = {
  trajectoryId: string;
  tick: number;
  phase: 1 | 2;
  taskId: string;
  kind: LoadedPactPairTaskV1['kind'];
  requesterStrategy: PactPairAskStrategyV1;
  retryOfTick?: number;
  finalDecision: PactPairTerminalDecisionV1;
  terminalReceived: boolean;
  evaluation: PactPairPublicEvaluationV1 | null;
  budgetUsed: { turns: number; toolCalls: number; runtimeMs: number };
  toolCalls: Array<{ id: string; name: string; isError: boolean }>;
  violations: string[];
  sharedOs?: {
    adapterId: string;
    protocolVersion: string;
    status: 'succeeded' | 'denied' | 'failed' | 'cancelled';
    traceId: string;
    latencyMs: number;
  };
  error?: string;
};

export type PactPairTrajectoryEndReasonV1 =
  | 'driver_stop'
  | 'max_ticks'
  | 'trajectory_runtime'
  | 'infrastructure_error';

/** One completed trajectory: public row + private (gold-bearing) detail. */
export type PactPairTrajectoryResultV1 = {
  trajectoryId: string;
  requesterId: PactRunConfigV1['benchmark']['requester'];
  tickCount: number;
  endReason: PactPairTrajectoryEndReasonV1;
  phase1Ticks: number;
  phase2Ticks: number;
  checklist: Array<{ taskId: string; status: string; asks: number }>;
  ticks: PactPairTrajectoryTickRecordV1[];
  /**
   * One synthetic single-task run per tick — the tick's direct-channel grade
   * (§3.4) modeled as an independent trial, so the run-level summary can reuse
   * the frozen metric aggregation. Carries no provider telemetry (that is
   * trajectory-level, below) to avoid multiply-counting usage.
   */
  tickRuns: PactPairSingleTaskRunV1[];
  /** Trajectory-level provider usage/cost (one harness for the whole trajectory). */
  providerTelemetry?: PactProviderTelemetryV1;
  /** Private trace events across all ticks (gold-bearing); saved under private/. */
  trace: PactPairTraceEventV1[];
  /** Per-tick full (private) evaluation for the offline rescorer. */
  privateEvaluations: Array<{ tick: number; taskId: string; evaluation: unknown }>;
  error?: string;
};

export type RunPactPairTrajectoryV1Options = {
  config: PactRunConfigV1;
  /** Checklist tasks in the driver's walk order (full loaded tasks, with gold). */
  tasks: LoadedPactPairTaskV1[];
  seed: PairDataStore;
  runId: string;
  trajectoryId: string;
  maxTicks: number;
  phase2StartTick?: number;
  /** Trajectory-level wall clock; bounds the whole trajectory. */
  trajectoryRuntimeMs: number;
  now: () => Date;
  harnessFactory: (context: {
    config: PactRunConfigV1;
    publicTask: LoadedPactPairTaskV1['publicTask'];
  }) => PactHarnessV1 | Promise<PactHarnessV1>;
  driver: PactPairRequesterDriverV1;
  environment: Record<string, string | undefined>;
};

/** Mutable holder the world's grant closure and tool handlers read per tick. */
type TickBoundaryHolderV1 = { current: PactBoundaryPlanV1 };

/** Per-tick plan the driver bridge reads on each `runTurn`. */
type TickPlanV1 = {
  tickNumber: number;
  isFirstTick: boolean;
  publicTask: LoadedPactPairTaskV1['publicTask'];
  grantedAccess: PactBoundaryPlanV1;
  requesterPrompt: string;
};

/** Per-tick mutable driver state (reset each tick — budgets are per-tick). */
type TickDriverStateV1 = {
  plan: TickPlanV1;
  turns: number;
  toolCallCount: number;
  deadline: number;
  finalDecision: PactPairTerminalDecisionV1;
  terminalReceived: boolean;
  violations: string[];
  error?: unknown;
};

export async function runPactPairTrajectoryV1(
  options: RunPactPairTrajectoryV1Options,
): Promise<PactPairTrajectoryResultV1> {
  const modules = await requireSharedOsModulesV1();
  const secret = options.environment[options.config.model.apiKeyEnv];
  const trajectoryStartedAt = Date.now();
  const trajectoryDeadline = trajectoryStartedAt + options.trajectoryRuntimeMs;
  const trace: PactPairTraceEventV1[] = [];
  const record = (event: string, data: unknown) => {
    if (!options.config.output.saveTraces) return;
    trace.push({
      at: options.now().toISOString(),
      runId: options.runId,
      taskId: options.trajectoryId,
      event,
      data,
    });
  };

  const tasksById = new Map(options.tasks.map(task => [task.taskId, task]));
  const checklistItems: PactPairChecklistItemV1[] = options.tasks.map(task => ({
    taskId: task.taskId,
    prompt: task.publicTask.prompt,
    publicTask: structuredClone(task.publicTask),
  }));

  const workspace = createPactPairWorkspaceV1(options.seed);
  // Kept so a whole-trajectory diff is recordable alongside the per-tick
  // re-based diffs (§3.4). Gold-bearing, so it only enters the private trace.
  const trajectoryInitialSnapshot = workspace.snapshot();

  const boundaryHolder: TickBoundaryHolderV1 = { current: deniedBoundary() };
  // The driver bridge reads this holder on every runTurn; the loop sets it
  // before each tick. A single stateful bridge (not one per tick) is required
  // because the adapter is constructed once with a fixed driver.
  const tickStateHolder: { current: TickDriverStateV1 | undefined } = {
    current: undefined,
  };

  const ticks: PactPairTrajectoryTickRecordV1[] = [];
  const tickRuns: PactPairSingleTaskRunV1[] = [];
  const privateEvaluations: PactPairTrajectoryResultV1['privateEvaluations'] = [];
  let harness: PactHarnessV1 | undefined;
  let endReason: PactPairTrajectoryEndReasonV1 = 'max_ticks';
  let trajectoryError: string | undefined;
  let phase1Ticks = 0;
  let phase2Ticks = 0;

  record('trajectory_started', {
    trajectoryId: options.trajectoryId,
    checklist: checklistItems.map(item => item.taskId),
    maxTicks: options.maxTicks,
    phase2StartTick: options.phase2StartTick,
    initialSnapshot: trajectoryInitialSnapshot,
  });

  const firstTask = options.tasks[0];
  if (!firstTask) throw new Error('PACT-Pair trajectory has an empty checklist');

  try {
    harness = await options.harnessFactory({
      config: structuredClone(options.config),
      publicTask: structuredClone(firstTask.publicTask),
    });
    const activeHarness = harness;
    const init = pactRunInitV1Schema.parse({
      protocolVersion: PACT_ADAPTER_PROTOCOL_VERSION_V1,
      // trajectoryId already embeds the runId and is unique; the protocol caps
      // sessionId at 128 chars, so don't concatenate the runId again.
      sessionId: options.trajectoryId,
      benchmark: {
        track: 'pact-pair',
        mode: 'pair-responder',
        version: `pair-v${firstTask.benchmarkVersion}`,
      },
      budget: options.config.budget,
      tools: PACT_PAIR_TOOL_SPECS_V1,
    });
    await activeHarness.initialize(structuredClone(init));

    await options.driver.initialize({
      trajectoryId: options.trajectoryId,
      items: checklistItems.map(item => structuredClone(item)),
      ...(options.phase2StartTick !== undefined
        ? { phase2StartTick: options.phase2StartTick }
        : {}),
      maxTicks: options.maxTicks,
    });

    const sender: SoAddress = {
      kind: 'agent',
      agentId: `pact-pair-requester-${options.config.benchmark.requester}`,
    };
    // Canonical world = the initial seed only (declarative task state); its
    // digest is measured once at init. `setup`/`senderGrants` are imperative
    // and read the mutable boundary holder, so grants recompute per tick.
    const canonicalWorld = {
      trajectoryId: options.trajectoryId,
      workspace: options.seed,
    };
    const world: EmbeddedWorldV1 = {
      owner: PACT_PAIR_SHAREDOS_OWNER_V1,
      sender,
      // Coarse host-selected tool family (constant across ticks); the
      // fine-grained per-tick gate is grants + expectedVisibleTools.
      enabledToolNamespaces: [PACT_PAIR_SHAREDOS_TOOL_NAMESPACE_V1],
      canonicalWorld,
      setup(kernel) {
        for (const handler of createPactPairSharedOsToolHandlersV1({
          workspace,
          access: () => boundaryHolder.current,
        })) {
          kernel.registerTool(handler);
        }
      },
      senderGrants: (m, namespaceId) => {
        const grantActions = grantedSharedOsActionsV1(boundaryHolder.current);
        return (['notes', 'todos'] as const)
          .filter(namespace => grantActions[namespace].length > 0)
          .map(namespace => m.testkit.createTestGrant({
            id: `grant-${namespace}`,
            namespaceId,
            subject: sender,
            issuer: PACT_PAIR_SHAREDOS_OWNER_V1,
            capabilities: [{
              resource: { namespace, path: [], owner: PACT_PAIR_SHAREDOS_OWNER_V1 },
              actions: grantActions[namespace],
              scope: 'descendants',
            }],
            purposes: [PACT_PAIR_SHAREDOS_PURPOSE_V1],
          }));
      },
    };

    const driverBridge = createTrajectoryTurnDriverV1({
      harness: activeHarness,
      config: options.config,
      secret,
      tickStateHolder,
      record,
    });

    const adapter = new EmbeddedSharedOsAdapterV1({
      modules,
      worldFactory: () => world,
      driver: driverBridge,
      provenance: {
        requestedId: pactModelIdentifierV1(options.config.model),
        resolvedId: pactModelIdentifierV1(options.config.model),
        servedId: null,
      },
    });

    const handle = await adapter.initWorld({
      worldId: `${options.runId}:${options.trajectoryId}`,
      taskId: options.trajectoryId,
      namespaceId: `${options.runId}:${options.trajectoryId}`,
      recipient: PACT_PAIR_SHAREDOS_RESPONDER_V1,
      workspaceDigest: digestObjectV1(canonicalWorld),
      // Per-tick expectedVisibleTools is supplied on each runTurn; the
      // init-time value is a harmless placeholder (never enforced because
      // every tick sends an override).
      expectedVisibleTools: [],
    });

    try {
      let firstTick = true;
      for (let tick = 1; tick <= options.maxTicks; tick += 1) {
        if (Date.now() >= trajectoryDeadline) {
          endReason = 'trajectory_runtime';
          break;
        }
        const phase: 1 | 2 =
          options.phase2StartTick !== undefined && tick >= options.phase2StartTick
            ? 2
            : 1;
        const decision = await options.driver.nextTick({ tick, phase });
        if (decision.type === 'stop') {
          endReason = 'driver_stop';
          record('trajectory_driver_stop', { tick, reason: decision.reason });
          break;
        }

        const task = tasksById.get(decision.taskId);
        if (!task) {
          throw new Error(
            `Requester driver asked for unknown checklist task ${decision.taskId}`,
          );
        }

        // Option (i): recompute the granted boundary for THIS tick. planBoundary
        // is pure (no transcript reset), so re-calling it per tick is safe.
        const requestedAccess = pactBoundaryPlanV1Schema.parse(
          await activeHarness.planBoundary(structuredClone(task.publicTask)),
        );
        const grantedAccess = intersectBoundaryPlans(
          requestedAccess,
          maximumBoundaryForTask(task.publicTask),
        );
        boundaryHolder.current = grantedAccess;

        const tickDeadline = Math.min(
          Date.now() + options.config.budget.maxRuntimeMs,
          trajectoryDeadline,
        );
        const tickState: TickDriverStateV1 = {
          plan: {
            tickNumber: tick,
            isFirstTick: firstTick,
            publicTask: task.publicTask,
            grantedAccess,
            requesterPrompt: decision.prompt,
          },
          turns: 0,
          toolCallCount: 0,
          deadline: tickDeadline,
          finalDecision: {
            type: 'escalate',
            reason: 'The runner did not receive a terminal decision.',
          },
          terminalReceived: false,
          violations: [],
        };
        tickStateHolder.current = tickState;

        const before = workspace.snapshot();
        record('tick_started', {
          tick,
          phase,
          taskId: task.taskId,
          strategy: decision.strategy,
          ...(decision.retryOfTick ? { retryOfTick: decision.retryOfTick } : {}),
          grantedAccess,
        });

        const timeoutMs = Math.max(
          1,
          Math.min(tickDeadline - Date.now(), MAX_TURN_TIMEOUT_MS_V1),
        );
        const expectedVisibleTools = expectedVisibleSharedOsToolsV1(grantedAccess);
        let tickError: string | undefined;
        let turnResult: Awaited<ReturnType<typeof adapter.runTurn>>[number] | undefined;
        try {
          const results = await adapter.runTurn(handle, {
            turnId: `${options.trajectoryId}:tick-${tick}`,
            message: {
              intent: PACT_PAIR_SHAREDOS_INTENT_V1,
              purpose: PACT_PAIR_SHAREDOS_PURPOSE_V1,
              payload: { trajectoryId: options.trajectoryId, tick, taskId: task.taskId },
            },
            options: { timeoutMs: Math.floor(timeoutMs) },
            expectedVisibleTools,
          });
          if (results.length !== 1) {
            tickState.violations.push('sharedos_duplicate_emission');
            throw new Error(`SharedOS returned ${results.length} results for one tick`);
          }
          turnResult = results[0];
          record('sharedos_turn', {
            tick,
            adapterId: turnResult.adapterId,
            status: turnResult.status,
            traceId: turnResult.traceId,
            latencyMs: turnResult.latencyMs,
            events: turnResult.events,
          });
          if (tickState.error !== undefined) throw tickState.error;
          applyTurnStatusV1(tickState, turnResult, secret, message => {
            tickError = message;
          });
        } catch (error) {
          tickError = sanitizeError(error, secret);
          tickState.violations.push(
            error instanceof SharedOsWorldGateErrorV1
              ? 'sharedos_world_gate_error'
              : classifyRunnerFailure(error),
          );
          tickState.finalDecision = {
            type: 'escalate',
            reason: 'The benchmark runner could not obtain a valid terminal decision.',
          };
          record('tick_error', { tick, message: tickError });
        }

        const after = workspace.snapshot();
        const evaluationResult = await evaluateWithRegisteredEvaluator(
          PACT_PAIR_EVALUATION_TARGET_V1,
          { task, decision: tickState.finalDecision, before, after },
        );
        const evaluation = evaluationResult.details;
        if (!evaluation) {
          throw new Error('PACT-Pair evaluator returned no evaluation details');
        }
        const infrastructureError = Boolean(tickError);
        // Side-effect-before-failure: a mutation that landed this tick stays
        // scored even if the tick later errored (parity with single-turn).
        const sideEffectBeforeFailure = infrastructureError
          && evaluation.kind === 'action'
          && evaluation.stateChanged;
        if (sideEffectBeforeFailure) {
          tickState.violations.push('side_effect_before_failure');
        }
        const publicEvaluation = infrastructureError && !sideEffectBeforeFailure
          ? null
          : toPublicEvaluation(evaluation);

        const tickRecord: PactPairTrajectoryTickRecordV1 = {
          trajectoryId: options.trajectoryId,
          tick,
          phase,
          taskId: task.taskId,
          kind: task.kind,
          requesterStrategy: decision.strategy,
          ...(decision.retryOfTick ? { retryOfTick: decision.retryOfTick } : {}),
          finalDecision: tickState.finalDecision,
          terminalReceived: tickState.terminalReceived,
          evaluation: publicEvaluation,
          budgetUsed: {
            turns: tickState.turns,
            toolCalls: tickState.toolCallCount,
            runtimeMs: Date.now() - (tickDeadline - options.config.budget.maxRuntimeMs),
          },
          toolCalls: (turnResult?.toolCalls ?? []).map(call => ({
            id: call.callId,
            name: call.name,
            isError: call.publicStatus !== 'ok',
          })),
          violations: tickState.violations,
          ...(turnResult
            ? {
                sharedOs: {
                  adapterId: turnResult.adapterId,
                  protocolVersion: turnResult.protocolVersion,
                  status: turnResult.status,
                  traceId: turnResult.traceId,
                  latencyMs: turnResult.latencyMs,
                },
              }
            : {}),
          ...(tickError ? { error: tickError } : {}),
        };
        ticks.push(tickRecord);
        // Synthetic per-tick trial: the direct-channel grade as an independent
        // trial so the run summary reuses the frozen metric aggregation. No
        // provider telemetry here — usage is trajectory-level, attached once.
        const tickResult: PactPairTaskResultV1 = {
          taskId: task.taskId,
          kind: task.kind,
          status: infrastructureError ? 'infrastructure_error' : 'ok',
          publicTask: task.publicTask,
          finalDecision: tickState.finalDecision,
          grantedAccess,
          evaluation: publicEvaluation,
          budgetUsed: tickRecord.budgetUsed,
          toolCalls: tickRecord.toolCalls,
          violations: tickState.violations,
          ...(tickError ? { error: tickError } : {}),
          ...(tickRecord.sharedOs ? { sharedOs: tickRecord.sharedOs } : {}),
        };
        tickRuns.push({ result: tickResult, trace: [], evaluation, evaluationResult });
        if (options.config.output.saveTraces) {
          privateEvaluations.push({ tick, taskId: task.taskId, evaluation });
        }
        if (phase === 1) phase1Ticks += 1;
        else phase2Ticks += 1;

        await options.driver.observe({
          tick,
          taskId: task.taskId,
          decision: tickState.finalDecision,
          terminalReceived: tickState.terminalReceived,
        });
        record('tick_completed', {
          tick,
          finalDecision: tickState.finalDecision,
          evaluation: publicEvaluation,
          budgetUsed: tickRecord.budgetUsed,
          violations: tickState.violations,
        });

        firstTick = false;

        // A tick that could not complete a turn at the substrate level ends the
        // trajectory: the in-memory world cannot be trusted after a gate error
        // or duplicate emission (resume granularity is the trajectory, §6).
        if (
          tickError
          && tickRecord.sharedOs === undefined
        ) {
          endReason = 'infrastructure_error';
          trajectoryError = tickError;
          break;
        }
      }
    } finally {
      await adapter.closeWorld(handle);
    }
  } catch (error) {
    trajectoryError = sanitizeError(error, secret);
    endReason = 'infrastructure_error';
    record('trajectory_error', { message: trajectoryError });
  } finally {
    if (harness) {
      try {
        await harness.finalize();
      } catch {
        // A finalize failure must not mask the trajectory's tick records.
      }
    }
  }

  const providerTelemetry = harness
    ? readPactProviderTelemetryV1(harness)
    : undefined;
  record('trajectory_completed', {
    endReason,
    tickCount: ticks.length,
    provider: providerTelemetry?.totals,
  });

  return {
    trajectoryId: options.trajectoryId,
    requesterId: options.config.benchmark.requester,
    tickCount: ticks.length,
    endReason,
    phase1Ticks,
    phase2Ticks,
    checklist: options.driver.finalChecklist(),
    ticks,
    tickRuns,
    ...(providerTelemetry ? { providerTelemetry } : {}),
    trace,
    privateEvaluations,
    ...(trajectoryError ? { error: trajectoryError } : {}),
  };
}

function applyTurnStatusV1(
  tickState: TickDriverStateV1,
  turnResult: {
    status: 'succeeded' | 'denied' | 'failed' | 'cancelled';
    errorDetail?: string;
  },
  secret: string | undefined,
  onError: (message: string) => void,
): void {
  switch (turnResult.status) {
    case 'succeeded':
      if (
        !tickState.terminalReceived
        && !tickState.violations.includes('max_turns_exceeded')
        && !tickState.violations.includes('max_tool_calls_exceeded')
      ) {
        onError(
          sanitizeError(
            new Error('SharedOS tick succeeded without a terminal decision'),
            secret,
          ),
        );
        tickState.violations.push('runner_error');
      }
      break;
    case 'denied':
      tickState.violations.push('sharedos_turn_denied');
      tickState.finalDecision = {
        type: 'escalate',
        reason: 'SharedOS denied the tick; no model turn was executed.',
      };
      break;
    case 'cancelled':
      tickState.violations.push('max_runtime_ms_exceeded');
      onError(
        sanitizeError(
          new Error(
            `SharedOS cancelled the tick: ${turnResult.errorDetail ?? 'turn timeout'}`,
          ),
          secret,
        ),
      );
      break;
    case 'failed':
      tickState.violations.push('runner_error');
      onError(
        sanitizeError(
          new Error(
            `SharedOS tick failed: ${turnResult.errorDetail ?? 'no output produced'}`,
          ),
          secret,
        ),
      );
      break;
  }
}

/**
 * Bridges the PACT harness into SharedOS's AgentTurnDriver for the trajectory
 * lane. On each `runTurn` (one tick) it reads the current tick plan from the
 * holder: tick 1 opens with a `task` observation (builds the responder's
 * system prompt + first user message); later ticks open with a
 * `requester_message` (appends to the SAME transcript — the responder must
 * remember prior ticks). Per-tick step/tool budgets are enforced here; the
 * kernel owns permission filtering and the bounded turn.
 */
function createTrajectoryTurnDriverV1(context: {
  harness: PactHarnessV1;
  config: PactRunConfigV1;
  secret: string | undefined;
  tickStateHolder: { current: TickDriverStateV1 | undefined };
  record: (event: string, data: unknown) => void;
}): SoTurnDriver {
  const { harness, config, secret, tickStateHolder, record } = context;
  return {
    async open(request) {
      const requestContext = request.context as { traceId: string; now: string };
      const complete = (decision: PactPairTerminalDecisionV1): SoTurnDecision => ({
        type: 'complete',
        output: JSON.stringify(decision),
      });
      return {
        next: async (input): Promise<SoTurnDecision> => {
          const state = tickStateHolder.current;
          if (!state) {
            return { type: 'fail', error: { code: 'pact_runner_error', message: 'no active tick' } };
          }
          try {
            let observation: PactObservationV1;
            if (input.type === 'start') {
              observation = state.plan.isFirstTick
                ? pactObservationV1Schema.parse({
                    type: 'task',
                    turn: 0,
                    task: state.plan.publicTask,
                    grantedAccess: state.plan.grantedAccess,
                    budgetRemaining: remainingBudget(
                      config,
                      state.turns,
                      state.toolCallCount,
                      state.deadline,
                    ),
                  })
                : pactObservationV1Schema.parse({
                    // Reused verbatim from the multi-exchange protocol (PR #27).
                    // turn/exchange are per-tick-local metadata; the trajectory
                    // position lives in ticks.jsonl. The transcript persists.
                    type: 'requester_message',
                    turn: 1,
                    exchange: 1,
                    prompt: state.plan.requesterPrompt,
                    budgetRemaining: remainingBudget(
                      config,
                      state.turns,
                      state.toolCallCount,
                      state.deadline,
                    ),
                  });
            } else {
              record('tool_result', {
                tick: state.plan.tickNumber,
                toolCallId: input.result.callId,
                toolName: input.result.tool,
                result: publicToolResultView(input.result),
              });
              observation = pactObservationV1Schema.parse({
                type: 'tool_result',
                turn: state.turns,
                toolCallId: input.result.callId,
                toolName: input.result.tool,
                output: toolResultOutput(input.result),
                isError: input.result.status !== 'succeeded',
                budgetRemaining: remainingBudget(
                  config,
                  state.turns,
                  state.toolCallCount,
                  state.deadline,
                ),
              });
            }

            if (state.turns >= config.budget.maxTurns) {
              state.violations.push('max_turns_exceeded');
              state.finalDecision = {
                type: 'escalate',
                reason: 'The turn budget was exhausted before a terminal decision.',
              };
              return complete(state.finalDecision);
            }

            const decision = redactDecisionCredential(
              pactDecisionV1Schema.parse(
                await withinDeadline(
                  harness.step(structuredClone(observation)),
                  state.deadline,
                  'adapter step',
                ),
              ),
              secret,
            );
            state.turns += 1;
            record('decision', { tick: state.plan.tickNumber, turn: state.turns, decision });

            if (decision.type !== 'tool_call') {
              state.finalDecision = decision;
              state.terminalReceived = true;
              return complete(decision);
            }

            if (!availableToolNames.has(decision.toolName)) {
              throw new Error(`Adapter requested unavailable tool ${decision.toolName}`);
            }

            if (state.toolCallCount >= config.budget.maxToolCalls) {
              state.violations.push('max_tool_calls_exceeded');
              state.finalDecision = {
                type: 'escalate',
                reason: 'The tool-call budget was exhausted.',
              };
              return complete(state.finalDecision);
            }

            state.toolCallCount += 1;
            return {
              type: 'tool_call',
              call: {
                id: `${state.plan.tickNumber}:tool:${state.toolCallCount}`,
                tool: decision.toolName,
                arguments: decision.input as Record<string, unknown>,
                traceId: requestContext.traceId,
                requestedAt: requestContext.now,
              },
            };
          } catch (error) {
            state.error = error;
            return {
              type: 'fail',
              error: { code: 'pact_runner_error', message: sanitizeError(error, secret) },
            };
          }
        },
      };
    },
  };
}

function toolResultOutput(result: SoToolResult): unknown {
  if (result.status === 'succeeded') {
    return result.output ?? null;
  }
  return {
    error: {
      code: result.error?.code ?? 'tool_error',
      ...(result.error?.message === undefined ? {} : { message: result.error.message }),
    },
  };
}

function publicToolResultView(result: SoToolResult): unknown {
  return {
    status: result.status,
    ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
  };
}
