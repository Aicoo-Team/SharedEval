import { z } from 'zod';
import {
  pactBoundaryPlanV1Schema,
  pactTaskIntroV1Schema,
  type JsonValue,
  type PactBoundaryPlanV1,
} from '../../../protocol/v1/index.js';
import {
  digestObjectV1,
  EmbeddedSharedOsAdapterV1,
  MAX_TURN_TIMEOUT_MS_V1,
  sharedOsJsonValueV1Schema,
  SharedOsWorldGateErrorV1,
  type EmbeddedWorldV1,
  type SharedOsModulesV1,
  type SharedOsTurnResultV1,
  type SoAddress,
  type SoToolResult,
  type SoTurnDecision,
  type SoTurnDriver,
} from '../../../execution/sharedos/v1/index.js';
import type { PairDataStore } from '../schemas.js';
import type { PactPairTerminalDecisionV1 } from '../evaluator.js';
import {
  createPactPairSharedOsToolHandlersV1,
  grantedSharedOsActionsV1,
  PACT_PAIR_SHAREDOS_INTENT_V1,
  PACT_PAIR_SHAREDOS_OWNER_V1,
  PACT_PAIR_SHAREDOS_PURPOSE_V1,
  PACT_PAIR_SHAREDOS_RESPONDER_V1,
  PACT_PAIR_SHAREDOS_TOOL_NAMESPACE_V1,
} from '../sharedos-execution.js';
import { createPactPairWorkspaceV1 } from '../workspace.js';
import {
  type LegacyResponderStepInputV1,
  type LegacyResponderTickSessionV1,
  type PersistentLegacyResponderSessionV1,
} from './responder-session.js';
import {
  assertLegacyToolVisibilityV1,
  classifyLegacyWorldErrorV1,
  legacyFailureDecisionV1,
  LegacyWorldGateErrorV1,
  type LegacyWorldSubstrateStatusV1,
  type LegacyWorldTickInputV1,
  type LegacyWorldTickResultV1,
  type PersistentLegacyWorldV1,
} from './world.js';

export type EmbeddedPersistentLegacyWorldOptionsV1 = {
  modules: SharedOsModulesV1;
  seed: PairDataStore;
  trajectoryId: string;
  worldId: string;
  namespaceId: string;
  principalId: string;
  responder: PersistentLegacyResponderSessionV1;
  requestedModel: string;
  sharedOsRevision: string;
  clock?: { nowMs(): number };
};

type EmbeddedActiveTickV1 = {
  input: LegacyWorldTickInputV1;
  session?: LegacyResponderTickSessionV1;
  terminalReceived: boolean;
  finalDecision: PactPairTerminalDecisionV1;
  substrateStatus: LegacyWorldSubstrateStatusV1;
  toolCallCount: number;
  hostToProviderCall: Map<string, string>;
  error?: unknown;
};

export async function createEmbeddedPersistentLegacyWorldV1(
  options: EmbeddedPersistentLegacyWorldOptionsV1,
): Promise<PersistentLegacyWorldV1> {
  const trajectoryId = z.string().trim().min(1).max(192).parse(options.trajectoryId);
  const worldId = z.string().trim().min(1).max(256).parse(options.worldId);
  const namespaceId = z.string().trim().min(1).max(256).parse(options.namespaceId);
  const principalId = z.string().trim().min(1).max(256).parse(options.principalId);
  const sharedOsRevision = z.string().regex(/^[0-9a-f]{40}$/)
    .parse(options.sharedOsRevision);
  const workspace = createPactPairWorkspaceV1(options.seed);
  const boundaryHolder = { current: deniedBoundary() };
  const activeHolder: { current?: EmbeddedActiveTickV1 } = {};
  const sender: SoAddress = { kind: 'agent', agentId: principalId };
  const canonicalWorld = {
    workflow: 'legacy-multi-transcript',
    trajectoryId,
    workspace: workspace.snapshot(),
  };

  const world: EmbeddedWorldV1 = {
    owner: PACT_PAIR_SHAREDOS_OWNER_V1,
    sender,
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
    senderGrants: (modules, currentNamespaceId) => {
      const actions = grantedSharedOsActionsV1(boundaryHolder.current);
      return (['notes', 'todos'] as const)
        .filter(namespace => actions[namespace].length > 0)
        .map(namespace => modules.testkit.createTestGrant({
          id: `legacy-${namespace}-grant`,
          namespaceId: currentNamespaceId,
          subject: sender,
          issuer: PACT_PAIR_SHAREDOS_OWNER_V1,
          capabilities: [{
            resource: {
              namespace,
              path: [],
              owner: PACT_PAIR_SHAREDOS_OWNER_V1,
            },
            actions: actions[namespace],
            scope: 'descendants',
          }],
          purposes: [PACT_PAIR_SHAREDOS_PURPOSE_V1],
        }));
    },
  };

  const driver = createEmbeddedLegacyDriverV1({
    responder: options.responder,
    activeHolder,
  });
  const adapter = new EmbeddedSharedOsAdapterV1({
    modules: options.modules,
    worldFactory: () => world,
    driver,
    provenance: {
      requestedId: options.requestedModel,
      resolvedId: options.requestedModel,
      servedId: null,
    },
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const handle = await adapter.initWorld({
    worldId,
    taskId: trajectoryId,
    namespaceId,
    recipient: PACT_PAIR_SHAREDOS_RESPONDER_V1,
    workspaceDigest: digestObjectV1(canonicalWorld),
    expectedVisibleTools: [],
  });
  const usedTickIds = new Set<string>();
  let closed = false;

  return {
    adapterId: 'sharedos-embedded',
    sharedOsRevision,
    snapshot: () => workspace.snapshot(),
    async runTick(input): Promise<LegacyWorldTickResultV1> {
      if (closed) throw new LegacyWorldGateErrorV1('Legacy SharedOS world is closed');
      if (input.trajectoryId !== trajectoryId) {
        throw new LegacyWorldGateErrorV1('Legacy SharedOS world cannot change trajectory');
      }
      if (input.principalId !== principalId) {
        throw new LegacyWorldGateErrorV1('Legacy SharedOS world cannot change principal');
      }
      if (input.responder !== options.responder) {
        throw new LegacyWorldGateErrorV1('Legacy SharedOS world cannot change responder session');
      }
      const task = pactTaskIntroV1Schema.parse(input.task);
      const grantedAccess = pactBoundaryPlanV1Schema.parse(input.grantedAccess);
      assertLegacyToolVisibilityV1(grantedAccess, input.expectedVisibleTools);
      const tickId = `${trajectoryId}:tick-${input.tick}`;
      if (usedTickIds.has(tickId)) {
        throw new LegacyWorldGateErrorV1(`Duplicate legacy tick authority: ${tickId}`);
      }
      usedTickIds.add(tickId);
      boundaryHolder.current = grantedAccess;
      const active: EmbeddedActiveTickV1 = {
        input: { ...input, task, grantedAccess },
        terminalReceived: false,
        finalDecision: legacyFailureDecisionV1(),
        substrateStatus: 'failed',
        toolCallCount: 0,
        hostToProviderCall: new Map(),
      };
      activeHolder.current = active;
      let turnResult: SharedOsTurnResultV1 | undefined;
      try {
        const timeoutMs = Math.max(
          1,
          Math.min(input.deadlineMs - Date.now(), MAX_TURN_TIMEOUT_MS_V1),
        );
        const results = await adapter.runTurn(handle, {
          turnId: tickId,
          message: {
            intent: PACT_PAIR_SHAREDOS_INTENT_V1,
            purpose: PACT_PAIR_SHAREDOS_PURPOSE_V1,
            payload: { trajectoryId, tick: input.tick, taskId: task.taskId },
          },
          options: {
            timeoutMs: Math.floor(timeoutMs),
            maxSteps: Math.min(1_000, input.budget.maxTurns + input.budget.maxToolCalls + 1),
          },
          expectedVisibleTools: [...input.expectedVisibleTools],
        });
        if (results.length !== 1) {
          throw new LegacyWorldGateErrorV1(
            `SharedOS emitted ${results.length} results for one legacy tick`,
          );
        }
        turnResult = results[0];
        if (active.error !== undefined) throw active.error;
        applyEmbeddedTurnStatus(active, turnResult);
        return buildResult(active, turnResult);
      } catch (error) {
        active.session?.truncatePending('turn_budget_exhausted');
        const classified = error instanceof SharedOsWorldGateErrorV1
          ? { status: 'kernel_error' as const, message: error.message.slice(0, 2_000) }
          : classifyLegacyWorldErrorV1(error);
        active.substrateStatus = classified.status;
        active.finalDecision = legacyFailureDecisionV1();
        return buildResult(active, turnResult, classified.message);
      } finally {
        activeHolder.current = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await adapter.closeWorld(handle);
    },
  };

  function buildResult(
    active: EmbeddedActiveTickV1,
    turnResult?: SharedOsTurnResultV1,
    error?: string,
  ): LegacyWorldTickResultV1 {
    const tickId = `${trajectoryId}:tick-${active.input.tick}`;
    return {
      tickId,
      substrateStatus: active.substrateStatus,
      terminalReceived: active.terminalReceived,
      finalDecision: active.finalDecision,
      turns: active.session?.providerRequestCount() ?? 0,
      toolCallCount: active.toolCallCount,
      runtimeMs: turnResult?.latencyMs ?? 0,
      toolCalls: (turnResult?.toolCalls ?? []).map(call => ({
        tickId,
        callId: call.callId,
        providerCallId: active.hostToProviderCall.get(call.callId) ?? 'unknown-provider-call',
        name: call.name,
        isError: call.publicStatus !== 'ok',
      })),
      adapterId: 'sharedos-embedded',
      adapterProtocolVersion: turnResult?.protocolVersion ?? '1',
      sharedOsRevision,
      ...(turnResult?.traceId ? { traceId: turnResult.traceId } : {}),
      ...(turnResult ? { privateEvents: turnResult.events } : {}),
      ...(error || turnResult?.errorDetail
        ? { error: (error ?? turnResult?.errorDetail ?? '').slice(0, 2_000) }
        : {}),
    };
  }
}

function createEmbeddedLegacyDriverV1(options: {
  responder: PersistentLegacyResponderSessionV1;
  activeHolder: { current?: EmbeddedActiveTickV1 };
}): SoTurnDriver {
  return {
    async open(_request, signal) {
      const active = options.activeHolder.current;
      if (!active) throw new LegacyWorldGateErrorV1('SharedOS opened without an active legacy tick');
      try {
        active.session = options.responder.beginTick({
          tick: active.input.tick,
          task: active.input.task,
          requesterPrompt: active.input.requesterPrompt,
          grantedAccess: active.input.grantedAccess,
          visibleToolNames: [...active.input.expectedVisibleTools],
          deadlineMs: active.input.deadlineMs,
          signal,
        });
      } catch (error) {
        active.error = error;
        throw error;
      }
      return {
        async next(input): Promise<SoTurnDecision> {
          const session = active.session;
          if (!session) return fail(active, new Error('Legacy responder tick was not opened'));
          try {
            let stepInput: LegacyResponderStepInputV1;
            if (input.type === 'start') {
              stepInput = { type: 'start' };
            } else {
              const providerCallId = active.hostToProviderCall.get(input.result.callId);
              if (!providerCallId) {
                throw new LegacyWorldGateErrorV1(
                  'SharedOS returned an unknown legacy tool-call identifier',
                );
              }
              stepInput = {
                type: 'tool_result',
                providerCallId,
                toolName: input.result.tool,
                output: publicSharedOsToolOutput(input.result),
                isError: input.result.status !== 'succeeded',
              };
              if (session.providerRequestCount() >= active.input.budget.maxTurns) {
                session.closeAfterToolResult(stepInput, 'turn_budget_exhausted');
                active.substrateStatus = 'budget';
                active.finalDecision = budgetDecision();
                return complete(active.finalDecision);
              }
            }
            const step = await session.next(stepInput);
            if (step.type !== 'tool_call') {
              active.terminalReceived = true;
              active.finalDecision = step;
              active.substrateStatus = 'succeeded';
              return complete(step);
            }
            if (active.toolCallCount >= active.input.budget.maxToolCalls) {
              session.truncatePending('tool_budget_exhausted');
              active.substrateStatus = 'budget';
              active.finalDecision = budgetDecision();
              return complete(active.finalDecision);
            }
            active.toolCallCount += 1;
            const callId = `${active.input.trajectoryId}:t${active.input.tick}:c${active.toolCallCount}`;
            active.hostToProviderCall.set(callId, step.providerCallId);
            const context = _request.context as { traceId?: string; now?: string };
            return {
              type: 'tool_call',
              call: {
                id: callId,
                tool: step.toolName,
                arguments: step.input as Record<string, unknown>,
                traceId: context.traceId ?? `${callId}:trace`,
                requestedAt: context.now ?? new Date().toISOString(),
              },
            };
          } catch (error) {
            session.truncatePending('turn_budget_exhausted');
            return fail(active, error);
          }
        },
        async close() {
          active.session?.truncatePending('turn_budget_exhausted');
        },
      };
    },
  };
}

function applyEmbeddedTurnStatus(
  active: EmbeddedActiveTickV1,
  result: SharedOsTurnResultV1,
): void {
  if (active.substrateStatus === 'budget') return;
  switch (result.status) {
    case 'succeeded':
      if (!active.terminalReceived) {
        active.substrateStatus = 'failed';
        active.finalDecision = legacyFailureDecisionV1();
      }
      return;
    case 'denied':
      active.substrateStatus = 'denied';
      active.terminalReceived = false;
      active.finalDecision = legacyFailureDecisionV1();
      return;
    case 'cancelled':
      active.substrateStatus = 'cancelled';
      active.terminalReceived = false;
      active.finalDecision = legacyFailureDecisionV1();
      return;
    case 'failed':
      active.substrateStatus = 'failed';
      active.terminalReceived = false;
      active.finalDecision = legacyFailureDecisionV1();
  }
}

function publicSharedOsToolOutput(result: SoToolResult): JsonValue {
  if (result.status === 'succeeded') {
    const parsed = sharedOsJsonValueV1Schema.safeParse(result.output ?? null);
    return parsed.success ? parsed.data as JsonValue : {
      error: { code: 'invalid_tool_result' },
    };
  }
  return {
    error: {
      code: result.error?.code ?? 'tool_error',
      ...(result.error?.message ? { message: result.error.message.slice(0, 2_000) } : {}),
    },
  };
}

function complete(decision: PactPairTerminalDecisionV1): SoTurnDecision {
  return { type: 'complete', output: JSON.stringify(decision) };
}

function fail(active: EmbeddedActiveTickV1, error: unknown): SoTurnDecision {
  active.error = error;
  return {
    type: 'fail',
    error: {
      code: 'legacy_runner_error',
      message: error instanceof Error
        ? error.message.slice(0, 2_000)
        : 'Legacy SharedOS driver failed',
    },
  };
}

function deniedBoundary(): PactBoundaryPlanV1 {
  return {
    access: {
      notes: { read: { scope: 'none' }, write: false },
      todos: { read: false, write: false },
      memory: { read: 'none', write: false },
    },
  };
}

function budgetDecision(): PactPairTerminalDecisionV1 {
  return {
    type: 'escalate',
    reason: 'The legacy per-tick budget was exhausted.',
  };
}
