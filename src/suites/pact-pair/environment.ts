import {
  PACT_ADAPTER_PROTOCOL_VERSION_V1,
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  type PactAdapterV1,
  type PactBoundaryPlanV1,
  type PactBudgetRemainingV1,
  type PactDecisionV1,
  type PactHarnessV1,
  type JsonValue,
  type PactObservationV1,
  type PactTaskIntroV1,
} from '../../protocol/v1/index.js';
import {
  evaluateWithRegisteredEvaluator,
  type EvaluationResult,
} from '../../evaluation/index.js';
import type { PairDataStore } from './schemas.js';
import {
  selectedPactExecutionAdapterV1,
  type PactRunConfigV1,
} from '../../runner/v1/config.js';
import {
  PactProviderRequestErrorV1,
  readPactProviderTelemetryV1,
  type PactProviderTelemetryV1,
} from '../../runner/v1/model-adapter.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import {
  executePactPairToolV1,
  PACT_PAIR_TOOL_SPECS_V1,
} from './tools.js';
import { createPactPairWorkspaceV1 } from './workspace.js';
import {
  type PactPairEvaluationV1,
  type PactPairActionEvaluationV1,
  type PactPairQaEvaluationV1,
  type PactPairTerminalDecisionV1,
} from './evaluator.js';
import { PACT_PAIR_EVALUATION_TARGET_V1 } from './evaluation.js';

const availableToolNames = new Set(PACT_PAIR_TOOL_SPECS_V1.map(tool => tool.name));

/**
 * Factory for the harness under evaluation. Execution backends call this once
 * per task; the harness only ever receives the public lifecycle contract.
 */
export type PactHarnessFactoryV1 = (context: {
  config: PactRunConfigV1;
  publicTask: PactTaskIntroV1;
}) => PactHarnessV1 | Promise<PactHarnessV1>;

/** @deprecated Use PactHarnessFactoryV1. */
export type PactAdapterFactoryV1 = PactHarnessFactoryV1;

export type PactPairToolCallRecordV1 = {
  id: string;
  name: string;
  isError: boolean;
};

export type PactPairPublicQaEvaluationV1 = Pick<
  PactPairQaEvaluationV1,
  | 'taskId'
  | 'kind'
  | 'actualDecision'
  | 'scorable'
  | 'correct'
  | 'factMatch'
  | 'leaked'
  | 'noLeak'
  | 'benchmarkLeaked'
  | 'benchmarkNoLeak'
>;

export type PactPairPublicActionEvaluationV1 = Pick<
  PactPairActionEvaluationV1,
  | 'taskId'
  | 'kind'
  | 'actualDecision'
  | 'scorable'
  | 'correct'
  | 'stateChanged'
  | 'stateCorrect'
  | 'noUnexpectedMutations'
  | 'mutations'
>;

export type PactPairPublicEvaluationV1 =
  | PactPairPublicQaEvaluationV1
  | PactPairPublicActionEvaluationV1;

/**
 * One requester message and the terminal decision it drew.
 *
 * A single-exchange task produces exactly one record whose decision equals
 * `finalDecision`; multi-exchange tasks produce one per requester message, in
 * order. Keeping the per-exchange decision is what makes "the target refused
 * at exchange 0 and complied at exchange 1" expressible — a task-level verdict
 * alone cannot distinguish that from a target that complied immediately.
 */
export type PactPairExchangeRecordV1 = {
  /** 0 is the opening prompt; 1+ are follow-ups, in dataset order. */
  exchange: number;
  prompt: string;
  decision: PactPairTerminalDecisionV1;
  /** 1-based adapter step on which this exchange began. */
  firstTurn: number;
  turnsUsed: number;
};

export type PactPairTaskResultV1 = {
  taskId: string;
  kind: LoadedPactPairTaskV1['kind'];
  status: 'ok' | 'infrastructure_error';
  publicTask: PactTaskIntroV1;
  finalDecision: PactPairTerminalDecisionV1;
  /** Present for every completed run; length 1 unless the task declares `exchanges`. */
  exchanges?: PactPairExchangeRecordV1[];
  grantedAccess: PactBoundaryPlanV1;
  evaluation: PactPairPublicEvaluationV1 | null;
  budgetUsed: {
    turns: number;
    toolCalls: number;
    runtimeMs: number;
  };
  toolCalls: PactPairToolCallRecordV1[];
  providerTelemetry?: PactProviderTelemetryV1;
  violations: string[];
  error?: string;
  finalizeError?: string;
  /**
   * Execution-substrate identity when the trial ran through a SharedOS
   * adapter (`benchmark.execution.adapter: sharedos-embedded`). Absent on
   * the public-runner path. Kernel runtime/audit events are private and go
   * to trace.jsonl, never to this public row. Absolute outcome rates from
   * different adapterIds must not be combined unless equivalence has been
   * demonstrated.
   */
  sharedOs?: {
    adapterId: string;
    protocolVersion: string;
    status: 'succeeded' | 'denied' | 'failed' | 'cancelled';
    traceId: string;
    latencyMs: number;
  };
};

export type PactPairTraceEventV1 = {
  at: string;
  runId: string;
  taskId?: string;
  event: string;
  data: unknown;
};

/**
 * One completed trial: the public result plus the full (private) evaluation
 * and its registered-evaluator metric contributions, which the run-level
 * summary aggregates.
 */
export type PactPairSingleTaskRunV1 = {
  result: PactPairTaskResultV1;
  trace: PactPairTraceEventV1[];
  evaluation: PactPairEvaluationV1;
  evaluationResult: EvaluationResult<PactPairEvaluationV1>;
};

export type RunSinglePactPairTaskV1Options = {
  config: PactRunConfigV1;
  task: LoadedPactPairTaskV1;
  seed: PairDataStore;
  runId: string;
  now: () => Date;
  harnessFactory: PactHarnessFactoryV1;
  environment: Record<string, string | undefined>;
};

/**
 * Pact-owned single-trial engine: protocol lifecycle, boundary intersection,
 * budget enforcement, tool execution, credential redaction, and evaluation via
 * the registered PACT-Pair evaluator. Execution backends orchestrate this
 * function; it owns every benchmark semantic for one trial.
 */
export async function runSinglePactPairTaskV1(
  options: RunSinglePactPairTaskV1Options,
): Promise<PactPairSingleTaskRunV1> {
  // The sharedos-embedded engine lives in its own module and is loaded only
  // when a config opts in, so the default public-runner path never touches
  // the SharedOS loader. Both execution backends (local and harbor) call
  // this function, so the adapter switch applies to both automatically.
  if (selectedPactExecutionAdapterV1(options.config) === 'sharedos-embedded') {
    const { runSinglePactPairTaskViaSharedOsV1 } = await import('./sharedos-execution.js');
    return runSinglePactPairTaskViaSharedOsV1(options);
  }
  const startedAt = Date.now();
  const deadline = startedAt + options.config.budget.maxRuntimeMs;
  const trace: PactPairTraceEventV1[] = [];
  const violations: string[] = [];
  const toolCalls: PactPairToolCallRecordV1[] = [];
  const workspace = createPactPairWorkspaceV1(options.seed);
  const before = workspace.snapshot();
  let turns = 0;
  let toolCallCount = 0;
  let adapter: PactAdapterV1 | undefined;
  let finalDecision: PactPairTerminalDecisionV1 = {
    type: 'escalate',
    reason: 'The runner did not receive a terminal decision.',
  };
  let grantedAccess = deniedBoundary();
  let errorMessage: string | undefined;
  let finalizeError: string | undefined;
  let providerTelemetry: PactProviderTelemetryV1 | undefined;
  let terminalReceived = false;
  /**
   * One entry per requester message, in order. Single-exchange tasks end with
   * exactly one entry whose decision is `finalDecision`, so every existing
   * consumer keeps working unchanged.
   */
  const exchanges: PactPairExchangeRecordV1[] = [];
  const multiExchange = (options.task.publicTask.exchanges?.length ?? 0) > 0;

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

  try {
    const activeAdapter = await withinDeadline(
      Promise.resolve().then(() => options.harnessFactory({
        config: structuredClone(options.config),
        publicTask: structuredClone(options.task.publicTask),
      })),
      deadline,
      'adapter creation',
    );
    adapter = activeAdapter;
    const init = pactRunInitV1Schema.parse({
      protocolVersion: PACT_ADAPTER_PROTOCOL_VERSION_V1,
      sessionId: `${options.runId}:${options.task.taskId}`,
      benchmark: {
        track: 'pact-pair',
        mode: 'pair-responder',
        version: `pair-v${options.task.benchmarkVersion}`,
      },
      budget: options.config.budget,
      tools: PACT_PAIR_TOOL_SPECS_V1,
    });
    await withinDeadline(
      activeAdapter.initialize(structuredClone(init)),
      deadline,
      'adapter initialization',
    );

    const requestedAccess = pactBoundaryPlanV1Schema.parse(
      await withinDeadline(
        activeAdapter.planBoundary(structuredClone(options.task.publicTask)),
        deadline,
        'boundary planning',
      ),
    );
    grantedAccess = intersectBoundaryPlans(
      requestedAccess,
      maximumBoundaryForTask(options.task.publicTask),
    );
    record('boundary_granted', { requestedAccess, grantedAccess });

    const followUps = options.task.publicTask.exchanges ?? [];
    let exchangeIndex = 0;
    let exchangeStartTurn = 0;

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
          activeAdapter.step(structuredClone(observation)),
          deadline,
          'adapter step',
        ),
      ), options.environment[options.config.model.apiKeyEnv]);
      turns += 1;
      record('decision', { turn: turns, decision });

      if (decision.type !== 'tool_call') {
        finalDecision = decision;
        terminalReceived = true;
        exchanges.push({
          exchange: exchangeIndex,
          prompt: exchangeIndex === 0
            ? options.task.publicTask.prompt
            : followUps[exchangeIndex - 1].prompt,
          decision,
          firstTurn: exchangeStartTurn + 1,
          turnsUsed: turns - exchangeStartTurn,
        });

        // A terminal decision ends the EXCHANGE. It ends the TASK only when the
        // requester has nothing further to say — otherwise the same target,
        // workspace and adapter session are pressed again, which is the whole
        // point of a graduated probe.
        const next = followUps[exchangeIndex];
        const applies =
          next && (!next.whenTargetDecision || next.whenTargetDecision.includes(decision.type));
        if (!applies) break;

        exchangeIndex += 1;
        exchangeStartTurn = turns;
        terminalReceived = false;
        record('requester_message', {
          turn: turns,
          exchange: exchangeIndex,
          prompt: next.prompt,
        });
        observation = pactObservationV1Schema.parse({
          type: 'requester_message',
          turn: turns,
          exchange: exchangeIndex,
          prompt: next.prompt,
          budgetRemaining: remainingBudget(options.config, turns, toolCallCount, deadline),
        });
        continue;
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
    errorMessage = sanitizeError(error, options.environment[options.config.model.apiKeyEnv]);
    violations.push(classifyRunnerFailure(error));
    finalDecision = {
      type: 'escalate',
      reason: 'The benchmark runner could not obtain a valid terminal decision.',
    };
    record('runner_error', { message: errorMessage });
  } finally {
    if (adapter) {
      try {
        await withinDeadline(adapter.finalize(), deadline, 'adapter finalization');
      } catch (error) {
        finalizeError = sanitizeError(
          error,
          options.environment[options.config.model.apiKeyEnv],
        );
        record('finalize_error', { message: finalizeError });
      }
      providerTelemetry = readPactProviderTelemetryV1(adapter);
    }
  }

  const after = workspace.snapshot();
  const evaluationResult = await evaluateWithRegisteredEvaluator(
    PACT_PAIR_EVALUATION_TARGET_V1,
    {
      task: options.task,
      decision: finalDecision,
      before,
      after,
    },
  );
  const evaluation = evaluationResult.details;
  if (!evaluation) {
    throw new Error('PACT-Pair evaluator returned no evaluation details');
  }
  const infrastructureError = Boolean(errorMessage || finalizeError);
  const publicEvaluation = infrastructureError ? null : toPublicEvaluation(evaluation);
  const result: PactPairTaskResultV1 = {
    taskId: options.task.taskId,
    kind: options.task.kind,
    status: infrastructureError ? 'infrastructure_error' : 'ok',
    publicTask: options.task.publicTask,
    finalDecision,
    // Emitted only for tasks that actually declare follow-ups. A
    // single-exchange task would carry one record duplicating `finalDecision`,
    // and adding a field to every published artifact would change results this
    // benchmark exists to keep reproducible. Absent therefore means
    // single-exchange, which is well defined for every consumer.
    ...(multiExchange ? { exchanges } : {}),
    grantedAccess,
    evaluation: publicEvaluation,
    budgetUsed: {
      turns,
      toolCalls: toolCallCount,
      runtimeMs: Date.now() - startedAt,
    },
    toolCalls,
    ...(providerTelemetry ? { providerTelemetry } : {}),
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
  return { result, trace, evaluation, evaluationResult };
}

/**
 * Builds a canonical infrastructure-error trial for a task an execution
 * backend could not run at all (for example a failed container launch). The
 * evaluation still flows through the registered evaluator so metric
 * denominators stay consistent with in-process failures.
 */
export async function buildPactPairBackendErrorRunV1(options: {
  config: PactRunConfigV1;
  task: LoadedPactPairTaskV1;
  seed: PairDataStore;
  runId: string;
  now: () => Date;
  message: string;
}): Promise<PactPairSingleTaskRunV1> {
  const message = options.message.slice(-2_000) || 'Unknown execution backend error';
  const workspace = createPactPairWorkspaceV1(options.seed);
  const before = workspace.snapshot();
  const after = workspace.snapshot();
  const finalDecision: PactPairTerminalDecisionV1 = {
    type: 'escalate',
    reason: 'The execution backend could not complete this trial.',
  };
  const evaluationResult = await evaluateWithRegisteredEvaluator(
    PACT_PAIR_EVALUATION_TARGET_V1,
    {
      task: options.task,
      decision: finalDecision,
      before,
      after,
    },
  );
  const evaluation = evaluationResult.details;
  if (!evaluation) {
    throw new Error('PACT-Pair evaluator returned no evaluation details');
  }
  const result: PactPairTaskResultV1 = {
    taskId: options.task.taskId,
    kind: options.task.kind,
    status: 'infrastructure_error',
    publicTask: options.task.publicTask,
    finalDecision,
    grantedAccess: deniedBoundary(),
    evaluation: null,
    budgetUsed: { turns: 0, toolCalls: 0, runtimeMs: 0 },
    toolCalls: [],
    violations: ['backend_error'],
    error: message,
  };
  const trace: PactPairTraceEventV1[] = options.config.output.saveTraces
    ? [{
        at: options.now().toISOString(),
        runId: options.runId,
        taskId: options.task.taskId,
        event: 'backend_error',
        data: { message },
      }]
    : [];
  return { result, trace, evaluation, evaluationResult };
}

export function toPublicEvaluation(
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
      benchmarkLeaked: evaluation.benchmarkLeaked,
      benchmarkNoLeak: evaluation.benchmarkNoLeak,
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

export function maximumBoundaryForTask(task: PactTaskIntroV1): PactBoundaryPlanV1 {
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

export function deniedBoundary(): PactBoundaryPlanV1 {
  return {
    access: {
      notes: { read: { scope: 'none' }, write: false },
      todos: { read: false, write: false },
      memory: { read: 'none', write: false },
    },
  };
}

export function remainingBudget(
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

export async function withinDeadline<T>(
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

export class PactRunnerTimeoutError extends Error {
  constructor(label: string) {
    super(`Timed out during ${label}`);
    this.name = 'PactRunnerTimeoutError';
  }
}

export class PactRunnerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PactRunnerProtocolError';
  }
}

export function classifyRunnerFailure(error: unknown): string {
  if (error instanceof PactRunnerTimeoutError) return 'max_runtime_ms_exceeded';
  if (error instanceof PactRunnerProtocolError) return 'adapter_protocol_error';
  if (error instanceof PactProviderRequestErrorV1 && error.fatalConfiguration) {
    return 'provider_configuration_error';
  }
  return 'runner_error';
}

export function sanitizeError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const normalizedSecret = secret?.trim();
  if (normalizedSecret) {
    message = message.split(normalizedSecret).join('[REDACTED]');
  }
  return message.slice(0, 2_000) || 'Unknown runner error';
}

export function redactDecisionCredential(
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
