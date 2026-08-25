import { z } from 'zod';
import {
  pactTaskIntroV1Schema,
  type PactTaskIntroV1,
} from '../../../protocol/v1/index.js';
import type { PactPairTerminalDecisionV1 } from '../evaluator.js';
import type { FrozenLegacyAssetV1 } from './assets.js';

export const LEGACY_RETRY_STRATEGIES_V1 = [
  'repeat',
  'business_justification',
  'urgency',
  'social_appeal',
  'decomposition',
] as const;
export type LegacyRetryStrategyV1 = typeof LEGACY_RETRY_STRATEGIES_V1[number];
export type LegacyAskStrategyV1 = 'first_ask' | LegacyRetryStrategyV1;

export type LegacyRequesterSubstrateStatusV1 =
  | 'succeeded'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'budget'
  | 'provider_error'
  | 'protocol_error'
  | 'kernel_error'
  | 'timeout'
  | 'requester_error'
  | 'engine_error';

export type LegacyRequesterOutcomeV1 = {
  tick: number;
  taskId: string;
  decision: PactPairTerminalDecisionV1;
  terminalReceived: boolean;
  substrateStatus: LegacyRequesterSubstrateStatusV1;
  sideEffectBeforeFailure: boolean;
  stateChanged: boolean;
};

export type LegacyRequesterTickV1 = {
  type: 'ask';
  taskId: string;
  prompt: string;
  phase: 1 | 2;
  strategy: LegacyAskStrategyV1;
  retryOfTick?: number;
  principalId: string;
};

export type LegacyRequesterStopV1 = {
  type: 'stop';
  reason: string;
};

export type LegacyRequesterInitV1 = {
  trajectoryId: string;
  items: PactTaskIntroV1[];
  phase2StartTick?: number;
  maxTicks: number;
};

export interface LegacyRequesterDriverV1 {
  readonly kind: 'scripted' | 'model';
  readonly principalId: string;
  initialize(input: LegacyRequesterInitV1): Promise<void>;
  nextTick(input: {
    tick: number;
    phase: 1 | 2;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<LegacyRequesterTickV1 | LegacyRequesterStopV1>;
  observe(outcome: LegacyRequesterOutcomeV1): Promise<void>;
  finalChecklist(): Array<{
    taskId: string;
    status: 'pending' | 'answered' | 'refused' | 'error';
    asks: number;
  }>;
  provenance(): LegacyRequesterProvenanceV1;
}

export type LegacyRequesterProvenanceV1 =
  | {
      kind: 'scripted';
      id: string;
      version: number;
      scriptPath: string;
      scriptRawSha256: string;
      scriptBytes: number;
      strategyTaxonomyVersion: 1;
    }
  | {
      kind: 'model';
      requestedModel: string;
      servedModels: string[];
      promptRawSha256: string;
      strategyTaxonomyVersion: 1;
    };

const scriptSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    description: z.string().min(1).max(4_096),
    strategyTemplates: z.object({
      repeat: templateSchema(),
      business_justification: templateSchema(),
      urgency: templateSchema(),
      social_appeal: templateSchema(),
      decomposition: templateSchema(),
    }).strict(),
    strategyRotation: z.array(z.enum(LEGACY_RETRY_STRATEGIES_V1)).min(1).max(32),
  })
  .strict();

function templateSchema(): z.ZodType<string> {
  return z.string().min(1).max(32_768).refine(
    value => value.includes('{{prompt}}'),
    'strategy template must include {{prompt}}',
  );
}

type ScriptState = {
  task: PactTaskIntroV1;
  status: 'pending' | 'answered' | 'refused' | 'error';
  asks: number;
  lastAskTick?: number;
  retryEligible: boolean;
  retryCursor: number;
};

export function isLegacyRetryEligibleV1(
  outcome: Pick<
    LegacyRequesterOutcomeV1,
    'terminalReceived' | 'decision' | 'stateChanged' | 'substrateStatus'
  >,
): boolean {
  return outcome.substrateStatus === 'succeeded'
    && !outcome.stateChanged
    && outcome.terminalReceived
    && (outcome.decision.type === 'refuse' || outcome.decision.type === 'escalate');
}

export class ScriptedLegacyRequesterDriverV1 implements LegacyRequesterDriverV1 {
  readonly kind = 'scripted' as const;
  readonly principalId: string;
  private readonly script: z.infer<typeof scriptSchema>;
  private states: ScriptState[] = [];
  private phase1Cursor = 0;
  private phase2StartTick: number | undefined;
  private maxTicks = 0;
  private lastAsk: { tick: number; taskId: string } | undefined;

  constructor(private readonly options: {
    script: FrozenLegacyAssetV1;
    principalId: string;
  }) {
    this.principalId = z.string().trim().min(1).max(256).parse(options.principalId);
    this.script = scriptSchema.parse(JSON.parse(options.script.content) as unknown);
  }

  async initialize(input: LegacyRequesterInitV1): Promise<void> {
    if (input.items.length === 0) throw new Error('Legacy requester checklist is empty');
    const items = input.items.map(item => pactTaskIntroV1Schema.parse(item));
    if (new Set(items.map(item => item.taskId)).size !== items.length) {
      throw new Error('Legacy requester checklist task ids must be unique');
    }
    if (
      input.phase2StartTick !== undefined
      && input.phase2StartTick !== items.length + 1
    ) {
      throw new Error('Legacy requester phase 2 must start after the first checklist pass');
    }
    this.states = items.map(task => ({
      task,
      status: 'pending',
      asks: 0,
      retryEligible: false,
      retryCursor: 0,
    }));
    this.phase1Cursor = 0;
    this.phase2StartTick = input.phase2StartTick;
    this.maxTicks = input.maxTicks;
    this.lastAsk = undefined;
  }

  async nextTick(input: {
    tick: number;
    phase: 1 | 2;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<LegacyRequesterTickV1 | LegacyRequesterStopV1> {
    if (input.tick < 1 || input.tick > this.maxTicks) {
      throw new Error('Legacy requester tick is outside the initialized budget');
    }
    const expectedPhase = this.phase2StartTick !== undefined
      && input.tick >= this.phase2StartTick ? 2 : 1;
    if (input.phase !== expectedPhase) {
      throw new Error('Legacy requester phase does not match the frozen boundary');
    }
    if (input.phase === 1) {
      const state = this.states[this.phase1Cursor];
      if (!state) return { type: 'stop', reason: 'public checklist exhausted' };
      this.phase1Cursor += 1;
      state.asks += 1;
      state.lastAskTick = input.tick;
      this.lastAsk = { tick: input.tick, taskId: state.task.taskId };
      return {
        type: 'ask',
        taskId: state.task.taskId,
        prompt: state.task.prompt,
        phase: 1,
        strategy: 'first_ask',
        principalId: this.principalId,
      };
    }

    const target = this.states.find(state =>
      state.retryEligible && state.retryCursor < this.script.strategyRotation.length);
    if (!target || target.lastAskTick === undefined) {
      return { type: 'stop', reason: 'no retry-eligible checklist items remain' };
    }
    const strategy = this.script.strategyRotation[target.retryCursor];
    target.retryCursor += 1;
    target.retryEligible = false;
    target.asks += 1;
    const retryOfTick = target.lastAskTick;
    target.lastAskTick = input.tick;
    this.lastAsk = { tick: input.tick, taskId: target.task.taskId };
    return {
      type: 'ask',
      taskId: target.task.taskId,
      prompt: this.script.strategyTemplates[strategy]
        .split('{{prompt}}')
        .join(target.task.prompt)
        .slice(0, 32_768),
      phase: 2,
      strategy,
      retryOfTick,
      principalId: this.principalId,
    };
  }

  async observe(outcome: LegacyRequesterOutcomeV1): Promise<void> {
    if (
      !this.lastAsk
      || this.lastAsk.tick !== outcome.tick
      || this.lastAsk.taskId !== outcome.taskId
    ) {
      throw new Error('Legacy requester outcome does not match its last ask');
    }
    const state = this.states.find(entry => entry.task.taskId === outcome.taskId);
    if (!state) throw new Error('Legacy requester outcome names an off-list task');
    state.retryEligible = isLegacyRetryEligibleV1(outcome);
    if (outcome.decision.type === 'answer' && outcome.terminalReceived) {
      state.status = 'answered';
    } else if (state.retryEligible) {
      state.status = 'refused';
    } else {
      state.status = 'error';
    }
    this.lastAsk = undefined;
  }

  finalChecklist(): ReturnType<LegacyRequesterDriverV1['finalChecklist']> {
    return this.states.map(state => ({
      taskId: state.task.taskId,
      status: state.status,
      asks: state.asks,
    }));
  }

  provenance(): LegacyRequesterProvenanceV1 {
    return {
      kind: 'scripted',
      id: this.script.id,
      version: this.script.version,
      scriptPath: this.options.script.provenance.path,
      scriptRawSha256: this.options.script.provenance.rawSha256,
      scriptBytes: this.options.script.provenance.bytes,
      strategyTaxonomyVersion: 1,
    };
  }
}

export function createScriptedLegacyRequesterDriverV1(options: {
  script: FrozenLegacyAssetV1;
  principalId: string;
}): ScriptedLegacyRequesterDriverV1 {
  return new ScriptedLegacyRequesterDriverV1(options);
}
