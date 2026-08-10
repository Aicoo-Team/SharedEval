import {
  pactDecisionV1Schema,
  type JsonValue,
  type PactBudgetRemainingV1,
  type PactDecisionV1,
  type PactTaskIntroV1,
} from '../../protocol/v1/index.js';
import {
  evaluateWithRegisteredEvaluator,
  type EvaluationResult,
} from '../../evaluation/index.js';
import {
  selectedPactExecutionAdapterV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import type { PactProviderTelemetryV1 } from '../../runner/v1/model-adapter.js';
import {
  classifyRunnerFailure,
  PactRunnerProtocolError,
  redactDecisionCredential,
  sanitizeError,
  withinDeadline,
} from '../pact-pair/environment.js';
import type { PactNetAgentStoreV1 } from './schemas.js';
import type { LoadedPactNetTaskV1 } from './task-loader.js';
import { executePactNetToolV1, PACT_NET_TOOL_SPECS_V1 } from './tools.js';
import { PactNetWorkspaceV1 } from './workspace.js';
import type {
  PactNetEvaluationV1,
  PactNetTerminalDecisionV1,
} from './evaluator.js';
import { PACT_NET_EVALUATION_TARGET_V1 } from './evaluation.js';

const availableToolNames = new Set(PACT_NET_TOOL_SPECS_V1.map(tool => tool.name));

/**
 * Suite-private harness contract for PACT-Net trials.
 *
 * PACT-Net deliberately does not reuse the public `PactHarnessV1` lifecycle:
 * that contract's RunInit carries the submission-protocol track enum, which is
 * intentionally PACT-Pair-only today (extending it is a protocol change owned
 * by the lead). The Net harness is therefore a minimal in-process step
 * interface, backed either by the scripted harness, an injected test harness,
 * or the OpenAI-compatible model harness (model-harness.ts). Trials execute
 * through the in-process tool loop below or — when the config selects
 * `benchmark.execution.adapter: sharedos-embedded` — through the real
 * SharedOS kernel (sharedos-execution.ts). Wiring PACT-Net into the public
 * adapter protocol remains an explicit follow-up.
 */
export type PactNetObservationV1 =
  | {
      type: 'task';
      turn: 0;
      task: PactTaskIntroV1;
      budgetRemaining: PactBudgetRemainingV1;
    }
  | {
      type: 'tool_result';
      turn: number;
      toolCallId: string;
      toolName: string;
      output: JsonValue;
      isError: boolean;
      budgetRemaining: PactBudgetRemainingV1;
    };

export type PactNetHarnessV1 = {
  step(observation: PactNetObservationV1): PactDecisionV1 | Promise<PactDecisionV1>;
  finalize?(): void | Promise<void>;
};

export type PactNetHarnessFactoryV1 = (context: {
  config: PactRunConfigV1;
  publicTask: PactTaskIntroV1;
}) => PactNetHarnessV1 | Promise<PactNetHarnessV1>;

export type PactNetToolCallRecordV1 = {
  id: string;
  name: string;
  isError: boolean;
};

export type PactNetPublicQaEvaluationV1 = {
  taskId: string;
  kind: 'qa';
  actualDecision: PactNetEvaluationV1['actualDecision'];
  routingBlocked: boolean;
  scorable: boolean;
  correct: boolean;
  judgePending: boolean;
  leakScorable: boolean;
  leaked: boolean;
  noLeak: boolean;
};

export type PactNetPublicMutationCountsV1 = {
  notes: { created: number; updated: number; removed: number };
  todos: { created: number; updated: number; removed: number };
};

export type PactNetPublicActionEvaluationV1 = {
  taskId: string;
  kind: 'action';
  actualDecision: PactNetEvaluationV1['actualDecision'];
  routingBlocked: boolean;
  scorable: boolean;
  correct: boolean;
  stateChanged: boolean;
  stateCorrect: boolean;
  mutations: PactNetPublicMutationCountsV1;
};

export type PactNetPublicEvaluationV1 =
  | PactNetPublicQaEvaluationV1
  | PactNetPublicActionEvaluationV1;

export type PactNetSharedOsResultIdentityV1 = {
  adapterId: string;
  protocolVersion: string;
  status: 'succeeded' | 'denied' | 'failed' | 'cancelled';
  traceId: string;
  latencyMs: number;
};

export type PactNetTaskResultV1 = {
  taskId: string;
  kind: LoadedPactNetTaskV1['kind'];
  status: 'ok' | 'infrastructure_error';
  publicTask: PactTaskIntroV1;
  routing: {
    allowed: boolean;
    rule: 'source-contact-list';
  };
  finalDecision: PactNetTerminalDecisionV1;
  evaluation: PactNetPublicEvaluationV1 | null;
  budgetUsed: {
    turns: number;
    toolCalls: number;
    runtimeMs: number;
  };
  toolCalls: PactNetToolCallRecordV1[];
  /** Present only for model-executed trials (Pair precedent). */
  providerTelemetry?: PactProviderTelemetryV1;
  violations: string[];
  error?: string;
  finalizeError?: string;
  /**
   * Execution-adapter identity block, present only when the trial ran
   * through the sharedos-embedded adapter (Pair precedent).
   */
  sharedOs?: PactNetSharedOsResultIdentityV1;
};

export type PactNetTraceEventV1 = {
  at: string;
  runId: string;
  taskId?: string;
  event: string;
  data: unknown;
};

export type PactNetSingleTaskRunV1 = {
  result: PactNetTaskResultV1;
  trace: PactNetTraceEventV1[];
  evaluation: PactNetEvaluationV1;
  evaluationResult: EvaluationResult<PactNetEvaluationV1>;
};

export type RunSinglePactNetTaskV1Options = {
  config: PactRunConfigV1;
  task: LoadedPactNetTaskV1;
  /** Seed store of the task's target agent; cloned per trial, never mutated. */
  seed: PactNetAgentStoreV1;
  runId: string;
  now: () => Date;
  harnessFactory: PactNetHarnessFactoryV1;
  environment: Record<string, string | undefined>;
};

/**
 * PACT-Net single-trial engine (benchmark main mode): one dyadic
 * source_agent → target_agent exchange, executed in-process against a fresh
 * clone of the target agent's seed store. Routing is enforced before the
 * harness ever runs; blocked trials synthesize a `routing_blocked` terminal
 * decision. Mutations are evaluated by snapshot diff and discarded with the
 * per-trial workspace (rollback by construction).
 */
export async function runSinglePactNetTaskV1(
  options: RunSinglePactNetTaskV1Options,
): Promise<PactNetSingleTaskRunV1> {
  if (selectedPactExecutionAdapterV1(options.config) === 'sharedos-embedded') {
    // Lazy import so the SharedOS loader machinery is touched only when the
    // config explicitly opts into the embedded adapter (Pair precedent).
    const { runSinglePactNetTaskViaSharedOsV1 } = await import('./sharedos-execution.js');
    return runSinglePactNetTaskViaSharedOsV1(options);
  }
  const startedAt = Date.now();
  const deadline = startedAt + options.config.budget.maxRuntimeMs;
  const trace: PactNetTraceEventV1[] = [];
  const violations: string[] = [];
  const toolCalls: PactNetToolCallRecordV1[] = [];
  const workspace = new PactNetWorkspaceV1(options.seed);
  const before = workspace.snapshot();
  let turns = 0;
  let toolCallCount = 0;
  let harness: PactNetHarnessV1 | undefined;
  let finalDecision: PactNetTerminalDecisionV1 = {
    type: 'escalate',
    reason: 'The runner did not receive a terminal decision.',
  };
  let errorMessage: string | undefined;
  let finalizeError: string | undefined;
  let providerTelemetry: PactProviderTelemetryV1 | undefined;
  let terminalReceived = false;

  const record = (event: string, data: unknown) => {
    if (!options.config.output.saveTraces) return;
    trace.push({
      at: options.now().toISOString(),
      runId: options.runId,
      taskId: options.task.taskId,
      event,
      data,
    });
  };

  record('task_started', { task: options.task.publicTask });

  if (!options.task.routingAllowed) {
    // Routing-level enforcement: the message is never delivered, so the
    // harness is never instantiated and no tool can run.
    finalDecision = {
      type: 'routing_blocked',
      reason: `${options.task.targetAgent} is not in ${options.task.sourceAgent}'s contact list`,
    };
    record('routing_blocked', { finalDecision });
    return finishPactNetTaskV1({
      options,
      workspace,
      before,
      finalDecision,
      trace,
      violations,
      toolCalls,
      turns,
      toolCallCount,
      startedAt,
      record,
    });
  }

  try {
    const activeHarness = await withinDeadline(
      Promise.resolve().then(() => options.harnessFactory({
        config: structuredClone(options.config),
        publicTask: structuredClone(options.task.publicTask),
      })),
      deadline,
      'harness creation',
    );
    harness = activeHarness;

    let observation: PactNetObservationV1 = {
      type: 'task',
      turn: 0,
      task: structuredClone(options.task.publicTask),
      budgetRemaining: remainingPactNetBudgetV1(options.config, turns, toolCallCount, deadline),
    };

    while (turns < options.config.budget.maxTurns) {
      const decision = redactDecisionCredential(pactDecisionV1Schema.parse(
        await withinDeadline(
          Promise.resolve(activeHarness.step(structuredClone(observation))),
          deadline,
          'harness step',
        ),
      ), options.environment[options.config.model.apiKeyEnv]);
      turns += 1;
      record('decision', { turn: turns, decision });

      if (decision.type !== 'tool_call') {
        finalDecision = decision;
        terminalReceived = true;
        break;
      }

      if (!availableToolNames.has(decision.toolName)) {
        throw new PactRunnerProtocolError(
          `Harness requested unavailable tool ${decision.toolName}`,
        );
      }

      if (toolCallCount >= options.config.budget.maxToolCalls) {
        violations.push('max_tool_calls_exceeded');
        finalDecision = {
          type: 'escalate',
          reason: 'The tool-call budget was exhausted.',
        };
        break;
      }

      toolCallCount += 1;
      const toolCallId = `${options.task.taskId}:tool:${toolCallCount}`;
      const executed = await withinDeadline(
        executePactNetToolV1({
          workspace,
          toolName: decision.toolName,
          input: decision.input,
        }),
        deadline,
        `tool ${decision.toolName}`,
      );
      toolCalls.push({
        id: toolCallId,
        name: decision.toolName,
        isError: executed.isError,
      });
      record('tool_result', {
        toolCallId,
        toolName: decision.toolName,
        input: decision.input,
        result: executed,
      });

      observation = {
        type: 'tool_result',
        turn: turns,
        toolCallId,
        toolName: decision.toolName,
        output: executed.output,
        isError: executed.isError,
        budgetRemaining: remainingPactNetBudgetV1(options.config, turns, toolCallCount, deadline),
      };
    }

    if (!terminalReceived && turns >= options.config.budget.maxTurns) {
      violations.push('max_turns_exceeded');
      finalDecision = {
        type: 'escalate',
        reason: 'The turn budget was exhausted before a terminal decision.',
      };
    }
  } catch (error) {
    errorMessage = sanitizeError(error, options.environment[options.config.model.apiKeyEnv]);
    violations.push(classifyRunnerFailure(error));
    finalDecision = {
      type: 'escalate',
      reason: 'The benchmark runner could not obtain a valid terminal decision.',
    };
    record('runner_error', { message: errorMessage });
  } finally {
    if (harness?.finalize) {
      try {
        await withinDeadline(
          Promise.resolve(harness.finalize()),
          deadline,
          'harness finalization',
        );
      } catch (error) {
        finalizeError = sanitizeError(
          error,
          options.environment[options.config.model.apiKeyEnv],
        );
        record('finalize_error', { message: finalizeError });
      }
    }
    if (harness) {
      providerTelemetry = readPactNetProviderTelemetryV1(harness);
    }
  }

  return finishPactNetTaskV1({
    options,
    workspace,
    before,
    finalDecision,
    trace,
    violations,
    toolCalls,
    turns,
    toolCallCount,
    startedAt,
    record,
    ...(providerTelemetry === undefined ? {} : { providerTelemetry }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(finalizeError === undefined ? {} : { finalizeError }),
  });
}

type PactNetProviderTelemetrySourceV1 = {
  getProviderTelemetryV1(): PactProviderTelemetryV1;
};

/**
 * Reads provider telemetry from a harness that exposes it (the model
 * harness). Structural, so scripted and test harnesses need no stub —
 * mirrors `readPactProviderTelemetryV1` in the Pair model adapter.
 */
export function readPactNetProviderTelemetryV1(
  harness: PactNetHarnessV1,
): PactProviderTelemetryV1 | undefined {
  const candidate = harness as PactNetHarnessV1 & Partial<PactNetProviderTelemetrySourceV1>;
  if (typeof candidate.getProviderTelemetryV1 !== 'function') return undefined;
  return candidate.getProviderTelemetryV1();
}

/**
 * Shared trial epilogue: snapshot diff, registered evaluation, public
 * projection, result assembly, and the completion trace event. Used by the
 * in-process loop above and by the sharedos-embedded execution path
 * (sharedos-execution.ts), so both adapters score and persist identically.
 */
export async function finishPactNetTaskV1(input: {
  options: RunSinglePactNetTaskV1Options;
  workspace: PactNetWorkspaceV1;
  before: PactNetAgentStoreV1;
  finalDecision: PactNetTerminalDecisionV1;
  trace: PactNetTraceEventV1[];
  violations: string[];
  toolCalls: PactNetToolCallRecordV1[];
  turns: number;
  toolCallCount: number;
  startedAt: number;
  record: (event: string, data: unknown) => void;
  providerTelemetry?: PactProviderTelemetryV1;
  errorMessage?: string;
  finalizeError?: string;
  sharedOs?: PactNetSharedOsResultIdentityV1;
}): Promise<PactNetSingleTaskRunV1> {
  const { options } = input;
  const after = input.workspace.snapshot();
  const evaluationResult = await evaluateWithRegisteredEvaluator(
    PACT_NET_EVALUATION_TARGET_V1,
    {
      task: options.task,
      decision: input.finalDecision,
      before: input.before,
      after,
    },
  );
  const evaluation = evaluationResult.details;
  if (!evaluation) {
    throw new Error('PACT-Net evaluator returned no evaluation details');
  }
  const infrastructureError = Boolean(input.errorMessage || input.finalizeError);
  const publicEvaluation = infrastructureError
    ? null
    : toPublicPactNetEvaluationV1(evaluation);
  const result: PactNetTaskResultV1 = {
    taskId: options.task.taskId,
    kind: options.task.kind,
    status: infrastructureError ? 'infrastructure_error' : 'ok',
    publicTask: options.task.publicTask,
    routing: {
      allowed: options.task.routingAllowed,
      rule: 'source-contact-list',
    },
    finalDecision: input.finalDecision,
    evaluation: publicEvaluation,
    budgetUsed: {
      turns: input.turns,
      toolCalls: input.toolCallCount,
      runtimeMs: Date.now() - input.startedAt,
    },
    toolCalls: input.toolCalls,
    ...(input.providerTelemetry ? { providerTelemetry: input.providerTelemetry } : {}),
    violations: input.violations,
    ...(input.errorMessage ? { error: input.errorMessage } : {}),
    ...(input.finalizeError ? { finalizeError: input.finalizeError } : {}),
    ...(input.sharedOs ? { sharedOs: input.sharedOs } : {}),
  };
  input.record('task_completed', {
    finalDecision: input.finalDecision,
    evaluation: publicEvaluation,
    budgetUsed: result.budgetUsed,
    violations: input.violations,
  });
  return { result, trace: input.trace, evaluation, evaluationResult };
}

/**
 * Public projection of an evaluation row. Never includes expected behaviors,
 * categories, relational labels, gold facts, matched-fact texts, or
 * title-bearing mutation keys — the public mutation view is counts only.
 */
export function toPublicPactNetEvaluationV1(
  evaluation: PactNetEvaluationV1,
): PactNetPublicEvaluationV1 {
  if (evaluation.kind === 'qa') {
    return {
      taskId: evaluation.taskId,
      kind: 'qa',
      actualDecision: evaluation.actualDecision,
      routingBlocked: evaluation.routingBlocked,
      scorable: evaluation.scorable,
      correct: evaluation.correct,
      judgePending: evaluation.judgePending,
      leakScorable: evaluation.leakScorable,
      leaked: evaluation.leaked,
      noLeak: evaluation.noLeak,
    };
  }
  return {
    taskId: evaluation.taskId,
    kind: 'action',
    actualDecision: evaluation.actualDecision,
    routingBlocked: evaluation.routingBlocked,
    scorable: evaluation.scorable,
    correct: evaluation.correct,
    stateChanged: evaluation.stateChanged,
    stateCorrect: evaluation.stateCorrect,
    mutations: {
      notes: {
        created: evaluation.mutations.notes.created.length,
        updated: evaluation.mutations.notes.updated.length,
        removed: evaluation.mutations.notes.removed.length,
      },
      todos: {
        created: evaluation.mutations.todos.created.length,
        updated: evaluation.mutations.todos.updated.length,
        removed: evaluation.mutations.todos.removed.length,
      },
    },
  };
}

export function remainingPactNetBudgetV1(
  config: PactRunConfigV1,
  turns: number,
  toolCalls: number,
  deadline: number,
): PactBudgetRemainingV1 {
  return {
    turns: Math.max(0, config.budget.maxTurns - turns),
    toolCalls: Math.max(0, config.budget.maxToolCalls - toolCalls),
    runtimeMs: Math.max(0, deadline - Date.now()),
  };
}
