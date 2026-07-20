import {
  PACT_ADAPTER_PROTOCOL_VERSION_V1,
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  type JsonValue,
  type PactBoundaryPlanV1,
  type PactBudgetRemainingV1,
  type PactDecisionV1,
  type PactHarnessV1,
  type PactIdentityV1,
  type PactObservationV1,
  type PactTaskIntroV1,
} from '../../protocol/v1/index.js';
import type { PairDataStore } from '../../schemas.js';
import type {
  PactPairPublicEvaluationV1,
  PactTaskResultV1,
  PactTraceEventV1,
} from './artifacts.js';
import type { PactRunConfigV1 } from './config.js';
import {
  evaluatePactPairTaskV1,
  type PactPairActionEvaluationV1,
  type PactPairEvaluationV1,
  type PactPairQaEvaluationV1,
  type PactPairTerminalDecisionV1,
} from './evaluator.js';
import { PactProviderRequestErrorV1 } from './model-adapter.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import {
  executePactPairToolV1,
  PACT_PAIR_TOOL_SPECS_V1,
} from './tools.js';
import { createPactPairWorkspaceV1 } from './workspace.js';

const availableToolNames = new Set(PACT_PAIR_TOOL_SPECS_V1.map(tool => tool.name));

export const PACT_PAIR_BENCHMARK_CONTRACT_V1 = {
  track: 'pact-pair',
  mode: 'pair-responder',
} as const;

export type PactHarnessFactoryV1 = (context: {
  config: PactRunConfigV1;
  publicTask: PactTaskIntroV1;
}) => PactHarnessV1 | Promise<PactHarnessV1>;

/** @deprecated Use PactHarnessFactoryV1. */
export type PactAdapterFactoryV1 = PactHarnessFactoryV1;

export type PactEnvironmentParticipantsV1 = Readonly<
  Record<string, PactIdentityV1>
>;

export type PactEnvironmentTaskRunV1 = {
  result: PactTaskResultV1;
  trace: PactTraceEventV1[];
  evaluation: PactPairEvaluationV1;
};

export type RunPactEnvironmentTaskV1Options = {
  config: PactRunConfigV1;
  task: LoadedPactPairTaskV1;
  participants: PactEnvironmentParticipantsV1;
  seed: PairDataStore;
  runId: string;
  now: () => Date;
  harnessFactory: PactHarnessFactoryV1;
  environment: Record<string, string | undefined>;
};

/**
 * Pact-owned single-trial engine. Execution backends orchestrate this class;
 * the harness under evaluation only receives the public lifecycle contract.
 */
export class PactEnvironmentV1 {
  constructor(
    private readonly benchmark: {
      track: 'pact-pair';
      mode: 'pair-responder';
    } = PACT_PAIR_BENCHMARK_CONTRACT_V1,
  ) {}

  async runTask(
    options: RunPactEnvironmentTaskV1Options,
  ): Promise<PactEnvironmentTaskRunV1> {
    assertPactPairParticipants(options.task.publicTask, options.participants);

    const startedAt = Date.now();
    const deadline = startedAt + options.config.budget.maxRuntimeMs;
    const trace: PactTraceEventV1[] = [];
    const violations: string[] = [];
    const toolCalls: PactTaskResultV1['toolCalls'] = [];
    const workspace = createPactPairWorkspaceV1(options.seed);
    const before = workspace.snapshot();
    let turns = 0;
    let toolCallCount = 0;
    let harness: PactHarnessV1 | undefined;
    let finalDecision: PactPairTerminalDecisionV1 = {
      type: 'escalate',
      reason: 'The runner did not receive a terminal decision.',
    };
    let grantedAccess = deniedBoundary();
    let errorMessage: string | undefined;
    let finalizeError: string | undefined;
    let terminalReceived = false;

    const record = (event: string, data: JsonValue) => {
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

    try {
      const activeHarness = await withinDeadline(
        Promise.resolve().then(() => options.harnessFactory({
          config: structuredClone(options.config),
          publicTask: structuredClone(options.task.publicTask),
        })),
        deadline,
        'adapter creation',
      );
      harness = activeHarness;
      const init = pactRunInitV1Schema.parse({
        protocolVersion: PACT_ADAPTER_PROTOCOL_VERSION_V1,
        sessionId: `${options.runId}:${options.task.taskId}`,
        benchmark: {
          track: this.benchmark.track,
          mode: this.benchmark.mode,
          version: `pair-v${options.task.benchmarkVersion}`,
        },
        budget: options.config.budget,
        tools: PACT_PAIR_TOOL_SPECS_V1,
      });
      await withinDeadline(
        activeHarness.initialize(structuredClone(init)),
        deadline,
        'adapter initialization',
      );

      const requestedAccess = pactBoundaryPlanV1Schema.parse(
        await withinDeadline(
          activeHarness.planBoundary(structuredClone(options.task.publicTask)),
          deadline,
          'boundary planning',
        ),
      );
      grantedAccess = intersectBoundaryPlans(
        requestedAccess,
        maximumBoundaryForTask(options.task.publicTask),
      );
      record('boundary_granted', { requestedAccess, grantedAccess });

      let observation: PactObservationV1 = pactObservationV1Schema.parse({
        type: 'task',
        turn: 0,
        task: options.task.publicTask,
        grantedAccess,
        budgetRemaining: remainingBudget(options.config, turns, toolCallCount, deadline),
      });

      while (turns < options.config.budget.maxTurns) {
        const decision = redactDecisionCredential(pactDecisionV1Schema.parse(
          await withinDeadline(
            activeHarness.step(structuredClone(observation)),
            deadline,
            'adapter step',
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
            `Adapter requested unavailable tool ${decision.toolName}`,
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
          executePactPairToolV1({
            workspace,
            access: grantedAccess,
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

        observation = pactObservationV1Schema.parse({
          type: 'tool_result',
          turn: turns,
          toolCallId,
          toolName: decision.toolName,
          output: executed.output,
          isError: executed.isError,
          budgetRemaining: remainingBudget(
            options.config,
            turns,
            toolCallCount,
            deadline,
          ),
        });
      }

      if (!terminalReceived && turns >= options.config.budget.maxTurns) {
        violations.push('max_turns_exceeded');
        finalDecision = {
          type: 'escalate',
          reason: 'The turn budget was exhausted before a terminal decision.',
        };
      }
    } catch (error) {
      errorMessage = sanitizeError(
        error,
        options.environment[options.config.model.apiKeyEnv],
      );
      violations.push(classifyRunnerFailure(error));
      finalDecision = {
        type: 'escalate',
        reason: 'The benchmark runner could not obtain a valid terminal decision.',
      };
      record('runner_error', { message: errorMessage });
    } finally {
      if (harness) {
        try {
          await withinDeadline(harness.finalize(), deadline, 'adapter finalization');
        } catch (error) {
          finalizeError = sanitizeError(
            error,
            options.environment[options.config.model.apiKeyEnv],
          );
          record('finalize_error', { message: finalizeError });
        }
      }
    }

    const after = workspace.snapshot();
    const evaluation = evaluatePactPairTaskV1({
      task: options.task,
      decision: finalDecision,
      before,
      after,
    });
    const publicEvaluation = toPublicPactPairEvaluationV1(evaluation);
    const result: PactTaskResultV1 = {
      taskId: options.task.taskId,
      kind: options.task.kind,
      publicTask: options.task.publicTask,
      finalDecision,
      grantedAccess,
      evaluation: publicEvaluation,
      budgetUsed: {
        turns,
        toolCalls: toolCallCount,
        runtimeMs: Date.now() - startedAt,
      },
      toolCalls,
      violations,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(finalizeError ? { finalizeError } : {}),
    };
    record('task_completed', {
      finalDecision,
      evaluation: publicEvaluation,
      budgetUsed: result.budgetUsed,
      violations,
    });
    return { result, trace, evaluation };
  }
}

function assertPactPairParticipants(
  task: PactTaskIntroV1,
  participants: PactEnvironmentParticipantsV1,
): void {
  if (
    participants.requester?.id !== task.requester.id
    || participants.target?.id !== task.target.id
  ) {
    throw new Error('PACT-Pair participants must match the public task identities');
  }
}

export function toPublicPactPairEvaluationV1(
  evaluation: PactPairEvaluationV1,
): PactPairPublicEvaluationV1 {
  if (evaluation.kind === 'qa') {
    return {
      taskId: evaluation.taskId,
      kind: evaluation.kind,
      actualDecision: evaluation.actualDecision,
      scorable: evaluation.scorable,
      correct: evaluation.correct,
      factMatch: evaluation.factMatch,
      leaked: evaluation.leaked,
      noLeak: evaluation.noLeak,
    };
  }
  return {
    taskId: evaluation.taskId,
    kind: evaluation.kind,
    actualDecision: evaluation.actualDecision,
    scorable: evaluation.scorable,
    correct: evaluation.correct,
    stateChanged: evaluation.stateChanged,
    stateCorrect: evaluation.stateCorrect,
    noUnexpectedMutations: evaluation.noUnexpectedMutations,
    mutations: evaluation.mutations,
  };
}

function maximumBoundaryForTask(task: PactTaskIntroV1): PactBoundaryPlanV1 {
  if (task.kind === 'qa') {
    return {
      access: {
        notes: { read: { scope: 'all' }, write: false },
        todos: { read: true, write: false },
        memory: { read: 'none', write: false },
      },
    };
  }
  const notes = task.surface === 'notes';
  const todos = task.surface === 'todos';
  return {
    access: {
      notes: {
        read: notes ? { scope: 'all' } : { scope: 'none' },
        write: notes,
      },
      todos: { read: todos, write: todos },
      memory: { read: 'none', write: false },
    },
  };
}

export function intersectBoundaryPlans(
  requested: PactBoundaryPlanV1,
  maximum: PactBoundaryPlanV1,
): PactBoundaryPlanV1 {
  const noteRead = intersectNoteRead(
    requested.access.notes.read,
    maximum.access.notes.read,
  );
  const todoRead = requested.access.todos.read && maximum.access.todos.read;
  const memoryRead = intersectMemoryRead(
    requested.access.memory.read,
    maximum.access.memory.read,
  );
  return pactBoundaryPlanV1Schema.parse({
    access: {
      notes: {
        read: noteRead,
        write: requested.access.notes.write
          && maximum.access.notes.write
          && noteRead.scope !== 'none',
      },
      todos: {
        read: todoRead,
        write: requested.access.todos.write && maximum.access.todos.write && todoRead,
      },
      memory: {
        read: memoryRead,
        write: requested.access.memory.write
          && maximum.access.memory.write
          && memoryRead !== 'none',
      },
    },
  });
}

function intersectNoteRead(
  requested: PactBoundaryPlanV1['access']['notes']['read'],
  maximum: PactBoundaryPlanV1['access']['notes']['read'],
): PactBoundaryPlanV1['access']['notes']['read'] {
  if (requested.scope === 'none' || maximum.scope === 'none') return { scope: 'none' };
  if (requested.scope === 'all') return maximum;
  if (maximum.scope === 'all') return requested;
  const allowed = new Set(maximum.folderIds);
  const folderIds = requested.folderIds.filter(id => allowed.has(id));
  return folderIds.length > 0 ? { scope: 'folders', folderIds } : { scope: 'none' };
}

function intersectMemoryRead(
  requested: PactBoundaryPlanV1['access']['memory']['read'],
  maximum: PactBoundaryPlanV1['access']['memory']['read'],
): PactBoundaryPlanV1['access']['memory']['read'] {
  const rank = { none: 0, relationship: 1, all: 2 } as const;
  return rank[requested] <= rank[maximum] ? requested : maximum;
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

function remainingBudget(
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

async function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  label: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new PactRunnerTimeoutError(label);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new PactRunnerTimeoutError(label)), remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class PactRunnerTimeoutError extends Error {
  constructor(label: string) {
    super(`Timed out during ${label}`);
    this.name = 'PactRunnerTimeoutError';
  }
}

class PactRunnerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PactRunnerProtocolError';
  }
}

function classifyRunnerFailure(error: unknown): string {
  if (error instanceof PactRunnerTimeoutError) return 'max_runtime_ms_exceeded';
  if (error instanceof PactRunnerProtocolError) return 'adapter_protocol_error';
  if (error instanceof PactProviderRequestErrorV1 && error.fatalConfiguration) {
    return 'provider_configuration_error';
  }
  return 'runner_error';
}

function sanitizeError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const normalizedSecret = secret?.trim();
  if (normalizedSecret) {
    message = message.split(normalizedSecret).join('[REDACTED]');
  }
  return message.slice(0, 2_000) || 'Unknown runner error';
}

function redactDecisionCredential(
  decision: PactDecisionV1,
  rawSecret?: string,
): PactDecisionV1 {
  const secret = rawSecret?.trim();
  if (!secret) return decision;
  if (decision.type === 'answer') {
    return { ...decision, content: redactString(decision.content, secret) };
  }
  if (decision.type === 'refuse' || decision.type === 'escalate') {
    return { ...decision, reason: redactString(decision.reason, secret) };
  }
  if (decision.toolName.includes(secret)) {
    throw new Error('Adapter decision contained the configured model credential');
  }
  return {
    ...decision,
    input: redactJsonValue(decision.input, secret) as typeof decision.input,
  };
}

function redactJsonValue(value: JsonValue, secret: string): JsonValue {
  if (typeof value === 'string') return redactString(value, secret);
  if (Array.isArray(value)) return value.map(item => redactJsonValue(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactString(key, secret),
        redactJsonValue(item, secret),
      ]),
    );
  }
  return value;
}

function redactString(value: string, secret: string): string {
  return value.includes(secret) ? value.split(secret).join('[REDACTED]') : value;
}
