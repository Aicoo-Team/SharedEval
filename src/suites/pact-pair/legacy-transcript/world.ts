import { z } from 'zod';
import {
  pactBoundaryPlanV1Schema,
  pactTaskIntroV1Schema,
  type JsonValue,
  type PactBoundaryPlanV1,
  type PactTaskIntroV1,
} from '../../../protocol/v1/index.js';
import type { SharedOsAdapterIdV1 } from '../../../execution/sharedos/v1/index.js';
import type { PairDataStore } from '../schemas.js';
import type { PactPairTerminalDecisionV1 } from '../evaluator.js';
import {
  expectedVisibleSharedOsToolsV1,
} from '../sharedos-execution.js';
import {
  executePactPairToolV1,
  type PactPairToolExecutionResultV1,
} from '../tools.js';
import {
  createPactPairWorkspaceV1,
  type PactPairWorkspaceV1,
} from '../workspace.js';
import {
  LegacyResponderProtocolErrorV1,
  LegacyResponderProviderErrorV1,
  type LegacyResponderStepInputV1,
  type PersistentLegacyResponderSessionV1,
} from './responder-session.js';

export type LegacyWorldSubstrateStatusV1 =
  | 'succeeded'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'budget'
  | 'provider_error'
  | 'protocol_error'
  | 'timeout'
  | 'kernel_error'
  | 'requester_error'
  | 'engine_error';

export type LegacyWorldToolCallV1 = {
  tickId: string;
  callId: string;
  providerCallId: string;
  name: string;
  isError: boolean;
};

export type LegacyWorldTickResultV1 = {
  tickId: string;
  substrateStatus: LegacyWorldSubstrateStatusV1;
  terminalReceived: boolean;
  finalDecision: PactPairTerminalDecisionV1;
  turns: number;
  toolCallCount: number;
  runtimeMs: number;
  toolCalls: LegacyWorldToolCallV1[];
  adapterId: SharedOsAdapterIdV1;
  adapterProtocolVersion: string;
  sharedOsRevision: string;
  traceId?: string;
  privateEvents?: unknown[];
  error?: string;
};

export type LegacyWorldTickInputV1 = {
  trajectoryId: string;
  tick: number;
  task: PactTaskIntroV1;
  requesterPrompt: string;
  principalId: string;
  grantedAccess: PactBoundaryPlanV1;
  expectedVisibleTools: string[];
  budget: { maxTurns: number; maxToolCalls: number };
  deadlineMs: number;
  responder: PersistentLegacyResponderSessionV1;
};

export interface PersistentLegacyWorldV1 {
  readonly adapterId: SharedOsAdapterIdV1;
  readonly sharedOsRevision: string;
  snapshot(): PairDataStore;
  runTick(input: LegacyWorldTickInputV1): Promise<LegacyWorldTickResultV1>;
  close(): Promise<void>;
}

export class LegacyWorldGateErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyWorldGateErrorV1';
  }
}

export type LocalPersistentLegacyWorldOptionsV1 = {
  seed: PairDataStore;
  sharedOsRevision: string;
  nowMs?: () => number;
  executeTool?: (options: {
    workspace: PactPairWorkspaceV1;
    access: PactBoundaryPlanV1;
    toolName: string;
    input: JsonValue;
  }) => Promise<PactPairToolExecutionResultV1>;
};

export function createLocalPersistentLegacyWorldV1(
  options: LocalPersistentLegacyWorldOptionsV1,
): PersistentLegacyWorldV1 {
  return new LocalPersistentLegacyWorldV1(options);
}

class LocalPersistentLegacyWorldV1 implements PersistentLegacyWorldV1 {
  readonly adapterId = 'pact-public-runner' as const;
  readonly sharedOsRevision: string;
  private readonly workspace: PactPairWorkspaceV1;
  private readonly nowMs: () => number;
  private readonly executeTool: NonNullable<LocalPersistentLegacyWorldOptionsV1['executeTool']>;
  private trajectoryId: string | undefined;
  private principalId: string | undefined;
  private readonly usedTickIds = new Set<string>();
  private closed = false;

  constructor(options: LocalPersistentLegacyWorldOptionsV1) {
    this.sharedOsRevision = z.string().regex(/^[0-9a-f]{40}$/)
      .parse(options.sharedOsRevision);
    this.workspace = createPactPairWorkspaceV1(options.seed);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.executeTool = options.executeTool ?? (input => executePactPairToolV1(input));
  }

  snapshot(): PairDataStore {
    return this.workspace.snapshot();
  }

  async runTick(input: LegacyWorldTickInputV1): Promise<LegacyWorldTickResultV1> {
    if (this.closed) throw new LegacyWorldGateErrorV1('Legacy world is closed');
    const tickStartedAt = this.nowMs();
    const nowMs = this.nowMs;
    const sharedOsRevision = this.sharedOsRevision;
    const trajectoryId = z.string().trim().min(1).max(192).parse(input.trajectoryId);
    const principalId = z.string().trim().min(1).max(256).parse(input.principalId);
    const task = pactTaskIntroV1Schema.parse(input.task);
    const grantedAccess = pactBoundaryPlanV1Schema.parse(input.grantedAccess);
    const budget = z.object({
      maxTurns: z.number().int().positive().max(1_000),
      maxToolCalls: z.number().int().nonnegative().max(1_000),
    }).strict().parse(input.budget);
    if (!Number.isSafeInteger(input.tick) || input.tick < 1) {
      throw new LegacyWorldGateErrorV1('Legacy tick must be a positive integer');
    }
    if (this.trajectoryId !== undefined && this.trajectoryId !== trajectoryId) {
      throw new LegacyWorldGateErrorV1('A persistent legacy world cannot change trajectory');
    }
    if (this.principalId !== undefined && this.principalId !== principalId) {
      throw new LegacyWorldGateErrorV1('A persistent legacy world cannot change principal');
    }
    this.trajectoryId ??= trajectoryId;
    this.principalId ??= principalId;
    const tickId = `${trajectoryId}:tick-${input.tick}`;
    if (this.usedTickIds.has(tickId)) {
      throw new LegacyWorldGateErrorV1(`Duplicate legacy tick authority: ${tickId}`);
    }
    this.usedTickIds.add(tickId);
    assertLegacyToolVisibilityV1(grantedAccess, input.expectedVisibleTools);

    const tick = input.responder.beginTick({
      tick: input.tick,
      task,
      requesterPrompt: input.requesterPrompt,
      grantedAccess,
      visibleToolNames: [...input.expectedVisibleTools],
      deadlineMs: input.deadlineMs,
    });
    const toolCalls: LegacyWorldToolCallV1[] = [];
    let nextInput: LegacyResponderStepInputV1 = { type: 'start' };
    let finalDecision = legacyFailureDecisionV1();

    try {
      for (;;) {
        if (this.nowMs() >= input.deadlineMs) {
          tick.truncatePending('turn_budget_exhausted');
          return result('timeout', false, finalDecision, 'Legacy tick deadline expired');
        }
        const step = await tick.next(nextInput);
        if (step.type !== 'tool_call') {
          finalDecision = step;
          return result('succeeded', true, finalDecision);
        }
        if (toolCalls.length >= budget.maxToolCalls) {
          tick.truncatePending('tool_budget_exhausted');
          finalDecision = budgetDecision('tool-call');
          return result('budget', false, finalDecision);
        }
        const executed = await this.executeTool({
          workspace: this.workspace,
          access: grantedAccess,
          toolName: step.toolName,
          input: step.input,
        });
        const callId = `${tickId}:tool-${toolCalls.length + 1}`;
        toolCalls.push({
          tickId,
          callId,
          providerCallId: step.providerCallId,
          name: step.toolName,
          isError: executed.isError,
        });
        const toolResult = {
          type: 'tool_result' as const,
          providerCallId: step.providerCallId,
          toolName: step.toolName,
          output: executed.output,
          isError: executed.isError,
        };
        if (tick.providerRequestCount() >= budget.maxTurns) {
          tick.closeAfterToolResult(toolResult, 'turn_budget_exhausted');
          finalDecision = budgetDecision('turn');
          return result('budget', false, finalDecision);
        }
        nextInput = toolResult;
      }
    } catch (error) {
      tick.truncatePending('turn_budget_exhausted');
      const classified = classifyLegacyWorldErrorV1(error);
      return result(classified.status, false, finalDecision, classified.message);
    }

    function result(
      substrateStatus: LegacyWorldSubstrateStatusV1,
      terminalReceived: boolean,
      decision: PactPairTerminalDecisionV1,
      error?: string,
    ): LegacyWorldTickResultV1 {
      return {
        tickId,
        substrateStatus,
        terminalReceived,
        finalDecision: decision,
        turns: tick.providerRequestCount(),
        toolCallCount: toolCalls.length,
        runtimeMs: Math.max(0, nowMs() - tickStartedAt),
        toolCalls,
        adapterId: 'pact-public-runner',
        adapterProtocolVersion: 'pact-public-runner/v1',
        sharedOsRevision,
        ...(error ? { error } : {}),
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function assertLegacyToolVisibilityV1(
  access: PactBoundaryPlanV1,
  claimed: readonly string[],
): void {
  if (new Set(claimed).size !== claimed.length) {
    throw new LegacyWorldGateErrorV1('Legacy expectedVisibleTools must be unique');
  }
  const expected = expectedVisibleSharedOsToolsV1(access).sort();
  const actual = [...claimed].sort();
  if (
    expected.length !== actual.length
    || expected.some((name, index) => name !== actual[index])
  ) {
    throw new LegacyWorldGateErrorV1(
      `Legacy tool visibility mismatch: expected [${expected.join(', ')}], `
      + `received [${actual.join(', ')}]`,
    );
  }
}

export function legacyFailureDecisionV1(): PactPairTerminalDecisionV1 {
  return {
    type: 'escalate',
    reason: 'The legacy runner did not receive a responder-authored terminal decision.',
  };
}

function budgetDecision(kind: 'turn' | 'tool-call'): PactPairTerminalDecisionV1 {
  return {
    type: 'escalate',
    reason: `The legacy ${kind} budget was exhausted.`,
  };
}

export function classifyLegacyWorldErrorV1(error: unknown): {
  status: LegacyWorldSubstrateStatusV1;
  message: string;
} {
  if (error instanceof LegacyResponderProviderErrorV1) {
    return {
      status: error.code === 'provider_timeout'
        ? 'timeout'
        : error.code === 'invalid_response'
          ? 'protocol_error'
          : 'provider_error',
      message: error.message.slice(0, 2_000),
    };
  }
  if (error instanceof LegacyResponderProtocolErrorV1) {
    return { status: 'protocol_error', message: error.message.slice(0, 2_000) };
  }
  if (error instanceof LegacyWorldGateErrorV1) {
    return { status: 'kernel_error', message: error.message.slice(0, 2_000) };
  }
  return {
    status: 'failed',
    message: error instanceof Error
      ? error.message.slice(0, 2_000)
      : 'Legacy world execution failed',
  };
}
