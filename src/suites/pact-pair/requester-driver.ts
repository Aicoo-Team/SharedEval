/**
 * Requester driver seam for the PACT-Pair multi-turn trajectory lane
 * (docs/pact-pair-multi-turn-lane.md §4).
 *
 * The driver decides, per tick, what the requester asks next and how it
 * frames the ask. It NEVER sees gold facts or labels — it is initialized
 * from `publicTask` views only, the same isolation rule the responder harness
 * lives under. Two implementations share this interface: the deterministic
 * `scripted` driver (this file; used for tests, goldens, and the cheap smoke
 * lane) and the adaptive `model` driver (requester-driver-model.ts; the
 * report's checklist-maintaining adversary).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PactTaskIntroV1 } from '../../protocol/v1/index.js';
import type { PactPairTerminalDecisionV1 } from './evaluator.js';

/**
 * Phase-2 retry framing taxonomy. Part of the frozen protocol — the report
 * measures flip rates by strategy, so every retry record carries its tag and
 * the aggregation is deterministic rather than a post-hoc labeling pass
 * (docs/pact-pair-multi-turn-lane.md §3.3).
 */
export const PACT_PAIR_RETRY_STRATEGIES_V1 = [
  'repeat',
  'business_justification',
  'urgency',
  'social_appeal',
  'decomposition',
] as const;
export type PactPairRetryStrategyV1 =
  (typeof PACT_PAIR_RETRY_STRATEGIES_V1)[number];

/** The opening ask of a checklist item carries this sentinel strategy. */
export const PACT_PAIR_FIRST_ASK_STRATEGY_V1 = 'first_ask' as const;
export type PactPairAskStrategyV1 =
  | typeof PACT_PAIR_FIRST_ASK_STRATEGY_V1
  | PactPairRetryStrategyV1;

/** A single checklist item, built from the public task view (no gold). */
export type PactPairChecklistItemV1 = {
  taskId: string;
  /** The requester's own public prompt for this item. */
  prompt: string;
  publicTask: PactTaskIntroV1;
};

export type PactPairRequesterInitV1 = {
  trajectoryId: string;
  /** Public checklist, in the driver's seeded walk order. */
  items: PactPairChecklistItemV1[];
  /** First tick of the retry phase; undefined = no phase 2. */
  phase2StartTick?: number;
  maxTicks: number;
};

/** Per-item status the driver tracks across ticks. */
export type PactPairChecklistItemStatusV1 =
  | 'pending'
  | 'answered'
  | 'refused'
  | 'failed';

/** What the driver observes after a tick, to update checklist state. */
export type PactPairRequesterOutcomeV1 = {
  tick: number;
  taskId: string;
  /** Terminal decision the responder made this tick. */
  decision: PactPairTerminalDecisionV1;
  /** True when the decision came from the responder (not runner-synthesized). */
  terminalReceived: boolean;
};

/** The driver's decision for a tick: ask something, or end the trajectory. */
export type PactPairRequesterTickV1 = {
  type: 'ask';
  taskId: string;
  /** The message the requester sends the responder this tick. */
  prompt: string;
  /** Phase (1 = plain probing, 2 = retry protocol). */
  phase: 1 | 2;
  /** Framing tag; `first_ask` for a plain probe, a retry strategy otherwise. */
  strategy: PactPairAskStrategyV1;
  /** Present when this is a retry: which prior tick's ask this re-frames. */
  retryOfTick?: number;
};

export type PactPairRequesterStopV1 = { type: 'stop'; reason: string };

/**
 * Observation handed to `nextTick`: the current tick number and the checklist
 * state the driver has accumulated. The scripted driver holds its own state,
 * so this is advisory; the model driver reads it into its prompt.
 */
export type PactPairRequesterObservationV1 = {
  tick: number;
  phase: 1 | 2;
};

export interface PactPairRequesterDriverV1 {
  /** Called once with the split's public items. */
  initialize(init: PactPairRequesterInitV1): Promise<void>;
  /** Decide the next tick's message, or end the trajectory. */
  nextTick(
    observation: PactPairRequesterObservationV1,
  ): Promise<PactPairRequesterTickV1 | PactPairRequesterStopV1>;
  /** Observe the responder's reply to update checklist state. */
  observe(outcome: PactPairRequesterOutcomeV1): Promise<void>;
  /** Final checklist state for the trajectory record. */
  finalChecklist(): Array<{
    taskId: string;
    status: PactPairChecklistItemStatusV1;
    asks: number;
  }>;
  /** Provenance recorded in run.json (trajectoryProtocol). */
  provenance(): PactPairRequesterDriverProvenanceV1;
}

export type PactPairRequesterDriverProvenanceV1 =
  | {
      kind: 'scripted';
      id: string;
      version: number;
      file: string;
      sha256: string;
      strategyTaxonomyVersion: number;
    }
  | {
      kind: 'model';
      model: string;
      servedModel: string | null;
      promptSha256: string;
      strategyTaxonomyVersion: number;
    };

/** Bumped whenever PACT_PAIR_RETRY_STRATEGIES_V1 changes. */
export const PACT_PAIR_STRATEGY_TAXONOMY_VERSION_V1 = 1;

// ---------------------------------------------------------------------------
// Scripted driver
// ---------------------------------------------------------------------------

const scriptedTemplateSchemaKeys = PACT_PAIR_RETRY_STRATEGIES_V1;

type ScriptedDriverScriptV1 = {
  id: string;
  version: number;
  description: string;
  /** One framing template per retry strategy; `{{prompt}}` expands to the item's prompt. */
  strategyTemplates: Record<PactPairRetryStrategyV1, string>;
  /** Order retry strategies are applied to a refused item across its retries. */
  strategyRotation: PactPairRetryStrategyV1[];
};

const MAX_SCRIPTED_MESSAGE_CHARS_V1 = 32_768;

export const PACT_PAIR_SCRIPTED_DRIVER_FILE_V1 =
  'dataset/pact-pair/trajectories/scripted_driver_v1.json' as const;

function loadScriptedDriverScriptV1(scriptPath?: string): {
  script: ScriptedDriverScriptV1;
  sha256: string;
  file: string;
} {
  const filePath = scriptPath
    ?? fileURLToPath(
      new URL(`../../../${PACT_PAIR_SCRIPTED_DRIVER_FILE_V1}`, import.meta.url),
    );
  const raw = readFileSync(filePath, 'utf8');
  const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  const parsed = JSON.parse(raw) as ScriptedDriverScriptV1;
  // Fail-closed: every strategy must have a template, and the rotation must
  // draw only from the frozen taxonomy. A missing template silently repeating
  // an ask would corrupt flip-rate-by-strategy aggregation.
  for (const strategy of scriptedTemplateSchemaKeys) {
    const template = parsed.strategyTemplates?.[strategy];
    if (typeof template !== 'string' || !template.includes('{{prompt}}')) {
      throw new Error(
        `Scripted driver script is missing a {{prompt}} template for strategy ${strategy}`,
      );
    }
  }
  if (
    !Array.isArray(parsed.strategyRotation)
    || parsed.strategyRotation.length === 0
    || parsed.strategyRotation.some(
      strategy => !scriptedTemplateSchemaKeys.includes(strategy),
    )
  ) {
    throw new Error('Scripted driver script has an invalid strategyRotation');
  }
  return {
    script: parsed,
    sha256,
    file: scriptPath ?? PACT_PAIR_SCRIPTED_DRIVER_FILE_V1,
  };
}

// The built-in script is loaded and hashed once, mirroring the
// policy-provenance pattern in prompt.ts: the digest is cheap, deterministic,
// and byte-attested. A config-provided override is loaded per driver instance.
let cachedBuiltinScript:
  | { script: ScriptedDriverScriptV1; sha256: string; file: string }
  | undefined;
function scriptedDriverScriptV1(scriptPath?: string): {
  script: ScriptedDriverScriptV1;
  sha256: string;
  file: string;
} {
  if (scriptPath) return loadScriptedDriverScriptV1(scriptPath);
  cachedBuiltinScript ??= loadScriptedDriverScriptV1();
  return cachedBuiltinScript;
}

type ScriptedItemState = {
  item: PactPairChecklistItemV1;
  status: PactPairChecklistItemStatusV1;
  asks: number;
  /** Index into strategyRotation for the next retry. */
  retryCursor: number;
  lastAskTick: number;
};

/**
 * Deterministic requester driver. Phase 1 walks the checklist once in seeded
 * order, asking each item's own prompt. Phase 2 revisits every item the
 * responder refused/escalated, applying the next strategy in the rotation each
 * time. No randomness: given the same checklist and the same responder
 * decisions, the tick sequence is identical.
 */
export class ScriptedPactPairRequesterDriverV1
  implements PactPairRequesterDriverV1
{
  private states: ScriptedItemState[] = [];
  private phase2StartTick: number | undefined;
  private maxTicks = 0;
  private phase1Cursor = 0;

  constructor(private readonly scriptPath?: string) {}

  async initialize(init: PactPairRequesterInitV1): Promise<void> {
    this.states = init.items.map(item => ({
      item,
      status: 'pending',
      asks: 0,
      retryCursor: 0,
      lastAskTick: 0,
    }));
    this.phase2StartTick = init.phase2StartTick;
    this.maxTicks = init.maxTicks;
    this.phase1Cursor = 0;
  }

  async nextTick(
    observation: PactPairRequesterObservationV1,
  ): Promise<PactPairRequesterTickV1 | PactPairRequesterStopV1> {
    const inPhase2 =
      this.phase2StartTick !== undefined
      && observation.tick >= this.phase2StartTick;

    // Phase 1: first pass over unspoken items.
    if (!inPhase2) {
      if (this.phase1Cursor < this.states.length) {
        const state = this.states[this.phase1Cursor];
        this.phase1Cursor += 1;
        state.asks += 1;
        state.lastAskTick = observation.tick;
        return {
          type: 'ask',
          taskId: state.item.taskId,
          prompt: state.item.prompt.slice(0, MAX_SCRIPTED_MESSAGE_CHARS_V1),
          phase: 1,
          strategy: PACT_PAIR_FIRST_ASK_STRATEGY_V1,
        };
      }
      // Ran out of first-pass items before phase 2 begins. If a retry phase is
      // configured, idle-advance to it by re-asking nothing; otherwise stop.
      if (this.phase2StartTick === undefined) {
        return { type: 'stop', reason: 'checklist exhausted (phase 1 only)' };
      }
    }

    // Phase 2: retry the first still-withheld item with its next strategy.
    const { script } = scriptedDriverScriptV1(this.scriptPath);
    const target = this.states.find(
      state =>
        (state.status === 'refused' || state.status === 'failed')
        && state.retryCursor < script.strategyRotation.length,
    );
    if (!target) {
      return { type: 'stop', reason: 'no retriable checklist items remain' };
    }
    const strategy = script.strategyRotation[target.retryCursor];
    target.retryCursor += 1;
    target.asks += 1;
    const retryOfTick = target.lastAskTick;
    target.lastAskTick = observation.tick;
    const prompt = script.strategyTemplates[strategy]
      .split('{{prompt}}')
      .join(target.item.prompt)
      .slice(0, MAX_SCRIPTED_MESSAGE_CHARS_V1);
    return {
      type: 'ask',
      taskId: target.item.taskId,
      prompt,
      phase: 2,
      strategy,
      retryOfTick,
    };
  }

  async observe(outcome: PactPairRequesterOutcomeV1): Promise<void> {
    const state = this.states.find(entry => entry.item.taskId === outcome.taskId);
    if (!state) return;
    if (!outcome.terminalReceived) {
      state.status = 'failed';
      return;
    }
    state.status =
      outcome.decision.type === 'answer'
        ? 'answered'
        : outcome.decision.type === 'refuse'
          ? 'refused'
          : 'failed';
  }

  finalChecklist(): Array<{
    taskId: string;
    status: PactPairChecklistItemStatusV1;
    asks: number;
  }> {
    return this.states.map(state => ({
      taskId: state.item.taskId,
      status: state.status,
      asks: state.asks,
    }));
  }

  provenance(): PactPairRequesterDriverProvenanceV1 {
    const { script, sha256, file } = scriptedDriverScriptV1(this.scriptPath);
    return {
      kind: 'scripted',
      id: script.id,
      version: script.version,
      file,
      sha256,
      strategyTaxonomyVersion: PACT_PAIR_STRATEGY_TAXONOMY_VERSION_V1,
    };
  }
}

export function createScriptedPactPairRequesterDriverV1(
  scriptPath?: string,
): PactPairRequesterDriverV1 {
  return new ScriptedPactPairRequesterDriverV1(scriptPath);
}
