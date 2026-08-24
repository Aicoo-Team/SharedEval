/**
 * PACT-Pair single-trial engine over the real SharedOS kernel
 * (`benchmark.execution.adapter: sharedos-embedded`).
 *
 * The PACT protocol lifecycle is unchanged — harness creation, initialize,
 * planBoundary, boundary intersection, credential redaction, evaluation —
 * but the decision loop of a trial executes as exactly one bounded SharedOS
 * turn: the model harness is bridged into SharedOS's `AgentTurnDriver` port
 * and every tool call flows through the kernel's filtered registry and
 * invocation gate instead of PACT's own tool loop.
 *
 * Semantic decisions (deliberate, tested below and in
 * tests/suites/pact-pair/sharedos-execution.test.ts):
 *
 * - **Grant construction.** The granted boundary plan maps to kernel
 *   capabilities at surface granularity: notes read → notes search/read,
 *   notes write → notes create/edit, todos read → todos search/read, todos
 *   write → todos create/edit/complete. Grants are host-constructed per
 *   trial, subject = the requester (sender), and travel through the
 *   AccessContext — never through the message. Folder-level note scoping
 *   stays PACT-side inside `executePactPairToolV1`, which every handler
 *   delegates to; the kernel gates the surface, the suite enforces the
 *   fine-grained scope. `expectedVisibleTools` is derived from the same
 *   mapping, so the adapter's enforced visibility check fails closed on any
 *   drift between the two layers.
 * - **Tool surface.** The harness is initialized with the full public tool
 *   list (the benchmark's declared surface, identical to the public-runner
 *   path); the kernel remains the execution authority — a call outside the
 *   granted surface returns the public `tool_unavailable` status instead of
 *   the public runner's `access_denied` tool error. Denial-distribution
 *   differences between the two paths are an experimental observation, not
 *   a bug (and never trigger a retry).
 * - **Result mapping.** `succeeded` carries the harness's terminal decision;
 *   `denied` (kernel refused the turn admission) is an experimental outcome
 *   recorded as an escalation with a `sharedos_turn_denied` violation, not
 *   an infrastructure error; `cancelled` (kernel turn timeout) maps to the
 *   public runner's timeout shape — `max_runtime_ms_exceeded` plus
 *   infrastructure_error; `failed` is an infrastructure error. Kernel
 *   runtime and audit events go to the private trace artifact; the public
 *   result row carries only the adapter identity block.
 */
import {
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  PACT_ADAPTER_PROTOCOL_VERSION_V1,
  pactBoundaryPlanV1Schema,
  type JsonValue,
  type PactBoundaryPlanV1,
  type PactHarnessV1,
  type PactObservationV1,
} from '../../protocol/v1/index.js';
import { evaluateWithRegisteredEvaluator } from '../../evaluation/index.js';
import {
  pactModelIdentifierV1,
} from '../../runner/v1/config.js';
import { readPactProviderTelemetryV1 } from '../../runner/v1/model-adapter.js';
import {
  EmbeddedSharedOsAdapterV1,
  digestObjectV1,
  loadSharedOsModulesV1,
  MAX_TURN_TIMEOUT_MS_V1,
  SharedOsWorldGateErrorV1,
  type EmbeddedWorldV1,
  type SharedOsModulesV1,
  type SharedOsTurnResultV1,
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
  type PactPairSingleTaskRunV1,
  type PactPairTaskResultV1,
  type PactPairTraceEventV1,
  type RunSinglePactPairTaskV1Options,
} from './environment.js';
import {
  executePactPairToolV1,
  PACT_PAIR_TOOL_SPECS_V1,
  type PactPairToolNameV1,
} from './tools.js';
import { createPactPairWorkspaceV1, type PactPairWorkspaceV1 } from './workspace.js';
import type { PactPairTerminalDecisionV1 } from './evaluator.js';
import { PACT_PAIR_EVALUATION_TARGET_V1 } from './evaluation.js';

export const PACT_PAIR_SHAREDOS_PURPOSE_V1 = 'pact-pair-benchmark' as const;
export const PACT_PAIR_SHAREDOS_INTENT_V1 = 'pact-pair:respond' as const;

const OWNER: SoAddress = { kind: 'human', userId: 'pact-pair-owner' };
const RESPONDER = { kind: 'agent', agentId: 'pact-pair-responder' } as const;

/**
 * Surface-granularity capability behind each PACT-Pair tool. The kernel's
 * filtered registry and invocation gate operate on these; folder-level note
 * scoping remains inside `executePactPairToolV1`.
 */
export const PACT_PAIR_SHAREDOS_TOOL_CAPABILITIES_V1: Record<
  PactPairToolNameV1,
  { namespace: 'notes' | 'todos'; action: string; readOnly: boolean }
> = {
  search_notes: { namespace: 'notes', action: 'search', readOnly: true },
  get_note: { namespace: 'notes', action: 'read', readOnly: true },
  create_note: { namespace: 'notes', action: 'create', readOnly: false },
  edit_note: { namespace: 'notes', action: 'edit', readOnly: false },
  search_todos: { namespace: 'todos', action: 'search', readOnly: true },
  get_todo: { namespace: 'todos', action: 'read', readOnly: true },
  create_todo: { namespace: 'todos', action: 'create', readOnly: false },
  edit_todo: { namespace: 'todos', action: 'edit', readOnly: false },
  complete_todo: { namespace: 'todos', action: 'complete', readOnly: false },
};

/** Kernel actions the granted boundary plan authorizes, per namespace. */
export function grantedSharedOsActionsV1(
  access: PactBoundaryPlanV1,
): { notes: string[]; todos: string[] } {
  const notes: string[] = [];
  if (access.access.notes.read.scope !== 'none') notes.push('search', 'read');
  if (access.access.notes.write) notes.push('create', 'edit');
  const todos: string[] = [];
  if (access.access.todos.read) todos.push('search', 'read');
  if (access.access.todos.write) todos.push('create', 'edit', 'complete');
  return { notes, todos };
}

/**
 * The tool names the kernel must make visible under the grants derived from
 * the same boundary plan. `expectedVisibleTools` is enforced by the adapter,
 * so this mapping and `grantedSharedOsActionsV1` failing to agree can never
 * silently run a turn.
 */
export function expectedVisibleSharedOsToolsV1(access: PactBoundaryPlanV1): string[] {
  const actions = grantedSharedOsActionsV1(access);
  return PACT_PAIR_TOOL_SPECS_V1
    .map(spec => spec.name)
    .filter(name => {
      const capability =
        PACT_PAIR_SHAREDOS_TOOL_CAPABILITIES_V1[name as PactPairToolNameV1];
      return actions[capability.namespace].includes(capability.action);
    });
}

/**
 * Registers the nine deterministic PACT-Pair tools as SharedOS host tools.
 * Argument validation stays inside `executePactPairToolV1` so malformed
 * arguments surface as a tool-error result (parity with the public runner),
 * never as a turn failure.
 */
export function createPactPairSharedOsToolHandlersV1(options: {
  workspace: PactPairWorkspaceV1;
  access: PactBoundaryPlanV1;
}): unknown[] {
  return PACT_PAIR_TOOL_SPECS_V1.map(spec => {
    const capability =
      PACT_PAIR_SHAREDOS_TOOL_CAPABILITIES_V1[spec.name as PactPairToolNameV1];
    return {
      definition: {
        name: spec.name,
        description: spec.description ?? `PACT-Pair tool ${spec.name}`,
        inputSchema: structuredClone(spec.inputSchema),
        requiredCapability: {
          resource: { namespace: capability.namespace, path: [] },
          action: capability.action,
        },
        annotations: { readOnly: capability.readOnly },
      },
      parseArguments: (rawArguments: unknown) => rawArguments,
      invoke: async (
        context: { now: string },
        call: { id: string; tool: string; arguments: Record<string, unknown> },
      ) => {
        const executed = await executePactPairToolV1({
          workspace: options.workspace,
          access: options.access,
          toolName: call.tool,
          input: call.arguments,
        });
        if (!executed.isError) {
          return {
            callId: call.id,
            tool: call.tool,
            status: 'succeeded',
            output: executed.output,
            completedAt: context.now,
          };
        }
        return {
          callId: call.id,
          tool: call.tool,
          status: 'failed',
          error: pactToolProtocolErrorV1(executed.output),
          completedAt: context.now,
        };
      },
    };
  });
}

function pactToolProtocolErrorV1(output: JsonValue): { code: string; message?: string } {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const error = (output as { error?: JsonValue }).error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const { code, message } = error as { code?: JsonValue; message?: JsonValue };
      return {
        code: typeof code === 'string' && code.length > 0 ? code : 'tool_error',
        ...(typeof message === 'string' ? { message } : {}),
      };
    }
  }
  return { code: 'tool_error' };
}

const availableToolNames = new Set(PACT_PAIR_TOOL_SPECS_V1.map(tool => tool.name));

class PactSharedOsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PactRunnerProtocolError';
  }
}

type DriverState = {
  turns: number;
  toolCallCount: number;
  finalDecision: PactPairTerminalDecisionV1;
  terminalReceived: boolean;
  violations: string[];
  /** Host-side error captured inside the driver; rethrown after the turn. */
  error?: unknown;
};

let cachedModules: Promise<SharedOsModulesV1> | undefined;

async function requireSharedOsModulesV1(): Promise<SharedOsModulesV1> {
  cachedModules ??= loadSharedOsModulesV1().then(loaded => {
    if (!loaded.ok) {
      // Fail the whole run loudly: the config explicitly opted into the
      // sharedos-embedded adapter, so an unavailable SharedOS build must
      // never degrade into 600 infrastructure_error rows.
      throw new Error(
        `benchmark.execution.adapter is sharedos-embedded but SharedOS could not be loaded: ${loaded.reason}`,
      );
    }
    return loaded.modules;
  });
  return cachedModules;
}

export async function runSinglePactPairTaskViaSharedOsV1(
  options: RunSinglePactPairTaskV1Options,
): Promise<PactPairSingleTaskRunV1> {
  const modules = await requireSharedOsModulesV1();
  const startedAt = Date.now();
  const deadline = startedAt + options.config.budget.maxRuntimeMs;
  const secret = options.environment[options.config.model.apiKeyEnv];
  const trace: PactPairTraceEventV1[] = [];
  const violations: string[] = [];
  const workspace = createPactPairWorkspaceV1(options.seed);
  const before = workspace.snapshot();
  let harness: PactHarnessV1 | undefined;
  let grantedAccess = deniedBoundary();
  let errorMessage: string | undefined;
  let finalizeError: string | undefined;
  let providerTelemetry: PactPairSingleTaskRunV1['result']['providerTelemetry'];
  let turnResult: SharedOsTurnResultV1 | undefined;
  const state: DriverState = {
    turns: 0,
    toolCallCount: 0,
    finalDecision: {
      type: 'escalate',
      reason: 'The runner did not receive a terminal decision.',
    },
    terminalReceived: false,
    violations,
  };

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
        track: 'pact-pair',
        mode: 'pair-responder',
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

    const sender: SoAddress = {
      kind: 'agent',
      agentId: `pact-pair-requester-${options.config.benchmark.requester}`,
    };
    // The digest attests the declarative task state only (seed workspace and
    // task identity); tool registration and grant wiring are code, versioned
    // with this suite — see the digest-scope note in the adapter docs.
    const canonicalWorld = { taskId: options.task.taskId, workspace: options.seed };
    const expectedVisibleTools = expectedVisibleSharedOsToolsV1(grantedAccess);
    const grantActions = grantedSharedOsActionsV1(grantedAccess);

    const world: EmbeddedWorldV1 = {
      owner: OWNER,
      sender,
      canonicalWorld,
      setup(kernel) {
        for (const handler of createPactPairSharedOsToolHandlersV1({
          workspace,
          access: grantedAccess,
        })) {
          kernel.registerTool(handler);
        }
      },
      senderGrants: (m, namespaceId) =>
        (['notes', 'todos'] as const)
          .filter(namespace => grantActions[namespace].length > 0)
          .map(namespace => m.testkit.createTestGrant({
            id: `grant-${namespace}`,
            namespaceId,
            subject: sender,
            issuer: OWNER,
            capabilities: [{
              resource: { namespace, path: [], owner: OWNER },
              actions: grantActions[namespace],
              scope: 'descendants',
            }],
            purposes: [PACT_PAIR_SHAREDOS_PURPOSE_V1],
          })),
    };

    const driver = createPactPairTurnDriverV1({
      harness: activeHarness,
      options,
      state,
      grantedAccess,
      deadline,
      secret,
      record,
    });

    const adapter = new EmbeddedSharedOsAdapterV1({
      modules,
      worldFactory: () => world,
      driver,
      provenance: {
        requestedId: pactModelIdentifierV1(options.config.model),
        resolvedId: pactModelIdentifierV1(options.config.model),
        servedId: null,
      },
    });

    const handle = await adapter.initWorld({
      worldId: `${options.runId}:${options.task.taskId}`,
      taskId: options.task.taskId,
      namespaceId: options.runId,
      recipient: RESPONDER,
      workspaceDigest: digestObjectV1(canonicalWorld),
      expectedVisibleTools,
    });

    const timeoutMs = Math.max(
      1,
      Math.min(deadline - Date.now(), MAX_TURN_TIMEOUT_MS_V1),
    );
    const results = await adapter.runTurn(handle, {
      turnId: `${options.task.taskId}:turn-1`,
      message: {
        intent: PACT_PAIR_SHAREDOS_INTENT_V1,
        purpose: PACT_PAIR_SHAREDOS_PURPOSE_V1,
        payload: { taskId: options.task.taskId },
      },
      options: { timeoutMs: Math.floor(timeoutMs) },
    });
    await adapter.closeWorld(handle);

    if (results.length !== 1) {
      // The adapter returns an array precisely so duplicate emissions reach
      // this collection gate instead of being hidden.
      violations.push('sharedos_duplicate_emission');
      throw new PactSharedOsProtocolError(
        `SharedOS returned ${results.length} results for one turn`,
      );
    }
    turnResult = results[0];
    record('sharedos_turn', {
      adapterId: turnResult.adapterId,
      protocolVersion: turnResult.protocolVersion,
      status: turnResult.status,
      traceId: turnResult.traceId,
      worldId: turnResult.worldId,
      namespaceId: handle.namespaceId,
      latencyMs: turnResult.latencyMs,
      // Kernel runtime + audit events; private trace artifact only.
      events: turnResult.events,
    });

    // A host-side error captured inside the driver (harness failure,
    // protocol violation, deadline) takes precedence over the kernel's
    // 'failed' wrapper so classification matches the public runner.
    if (state.error !== undefined) throw state.error;

    switch (turnResult.status) {
      case 'succeeded':
        if (!state.terminalReceived && !hasBudgetViolation(violations)) {
          throw new PactSharedOsProtocolError(
            'SharedOS turn succeeded without a terminal decision',
          );
        }
        break;
      case 'denied':
        // Kernel-refused admission is an experimental outcome — never an
        // infrastructure retry, never a wider re-grant.
        violations.push('sharedos_turn_denied');
        state.finalDecision = {
          type: 'escalate',
          reason: 'SharedOS denied the turn; no model turn was executed.',
        };
        break;
      case 'cancelled':
        // Kernel turn timeout maps to the public runner's timeout shape.
        violations.push('max_runtime_ms_exceeded');
        errorMessage = sanitizeError(
          new Error(
            `SharedOS cancelled the turn: ${turnResult.errorDetail ?? 'turn timeout'}`,
          ),
          secret,
        );
        break;
      case 'failed':
        violations.push('runner_error');
        errorMessage = sanitizeError(
          new Error(
            `SharedOS turn failed: ${turnResult.errorDetail ?? 'no output produced'}`,
          ),
          secret,
        );
        break;
    }
  } catch (error) {
    errorMessage = sanitizeError(error, secret);
    violations.push(
      error instanceof SharedOsWorldGateErrorV1
        ? 'sharedos_world_gate_error'
        : classifyRunnerFailure(error),
    );
    state.finalDecision = {
      type: 'escalate',
      reason: 'The benchmark runner could not obtain a valid terminal decision.',
    };
    record('runner_error', { message: errorMessage });
  } finally {
    if (harness) {
      try {
        await withinDeadline(harness.finalize(), deadline, 'adapter finalization');
      } catch (error) {
        finalizeError = sanitizeError(error, secret);
        record('finalize_error', { message: finalizeError });
      }
      providerTelemetry = readPactProviderTelemetryV1(harness);
    }
  }

  const after = workspace.snapshot();
  const evaluationResult = await evaluateWithRegisteredEvaluator(
    PACT_PAIR_EVALUATION_TARGET_V1,
    {
      task: options.task,
      decision: state.finalDecision,
      before,
      after,
    },
  );
  const evaluation = evaluationResult.details;
  if (!evaluation) {
    throw new Error('PACT-Pair evaluator returned no evaluation details');
  }
  const infrastructureError = Boolean(errorMessage || finalizeError);
  // Mirrors the public-runner path: a trial that mutated the workspace before
  // failing must stay publicly scorable so the side effect cannot vanish from
  // the action-safety denominators behind the infrastructure error.
  const sideEffectBeforeFailure = infrastructureError
    && evaluation.kind === 'action'
    && evaluation.stateChanged;
  if (sideEffectBeforeFailure) violations.push('side_effect_before_failure');
  const result: PactPairTaskResultV1 = {
    taskId: options.task.taskId,
    kind: options.task.kind,
    status: infrastructureError ? 'infrastructure_error' : 'ok',
    publicTask: options.task.publicTask,
    finalDecision: state.finalDecision,
    grantedAccess,
    evaluation: infrastructureError && !sideEffectBeforeFailure
      ? null
      : toPublicEvaluation(evaluation),
    budgetUsed: {
      turns: state.turns,
      toolCalls: state.toolCallCount,
      runtimeMs: Date.now() - startedAt,
    },
    toolCalls: (turnResult?.toolCalls ?? []).map(call => ({
      id: call.callId,
      name: call.name,
      isError: call.publicStatus !== 'ok',
    })),
    ...(providerTelemetry ? { providerTelemetry } : {}),
    violations,
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(finalizeError ? { finalizeError } : {}),
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
  };
  record('task_completed', {
    finalDecision: state.finalDecision,
    evaluation: result.evaluation,
    budgetUsed: result.budgetUsed,
    violations,
  });
  return { result, trace, evaluation, evaluationResult };
}

function hasBudgetViolation(violations: string[]): boolean {
  return violations.includes('max_turns_exceeded')
    || violations.includes('max_tool_calls_exceeded');
}

/**
 * Bridges the PACT harness into SharedOS's AgentTurnDriver port. PACT keeps
 * owning cadence and budgets (turns, tool calls, runtime deadline); the
 * kernel owns permission filtering, the invocation gate, and the bounded
 * turn. The driver never sees grants — SharedOS sanitizes the model-facing
 * request itself.
 */
function createPactPairTurnDriverV1(context: {
  harness: PactHarnessV1;
  options: RunSinglePactPairTaskV1Options;
  state: DriverState;
  grantedAccess: PactBoundaryPlanV1;
  deadline: number;
  secret: string | undefined;
  record: (event: string, data: unknown) => void;
}): SoTurnDriver {
  const { harness, options, state, grantedAccess, deadline, secret, record } = context;
  const config = options.config;
  const task = options.task;
  return {
    async open(request) {
      const requestContext = request.context as { traceId: string; now: string };
      const complete = (
        decision: PactPairTerminalDecisionV1,
      ): SoTurnDecision => ({
        type: 'complete',
        output: JSON.stringify(decision),
      });
      return {
        next: async (input): Promise<SoTurnDecision> => {
          try {
            let observation: PactObservationV1;
            if (input.type === 'start') {
              observation = pactObservationV1Schema.parse({
                type: 'task',
                turn: 0,
                task: task.publicTask,
                grantedAccess,
                budgetRemaining: remainingBudget(
                  config,
                  state.turns,
                  state.toolCallCount,
                  deadline,
                ),
              });
            } else {
              record('tool_result', {
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
                  deadline,
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
                  deadline,
                  'adapter step',
                ),
              ),
              secret,
            );
            state.turns += 1;
            record('decision', { turn: state.turns, decision });

            if (decision.type !== 'tool_call') {
              state.finalDecision = decision;
              state.terminalReceived = true;
              return complete(decision);
            }

            if (!availableToolNames.has(decision.toolName)) {
              throw new PactSharedOsProtocolError(
                `Adapter requested unavailable tool ${decision.toolName}`,
              );
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
                id: `${task.taskId}:tool:${state.toolCallCount}`,
                tool: decision.toolName,
                arguments: decision.input as Record<string, unknown>,
                traceId: requestContext.traceId,
                requestedAt: requestContext.now,
              },
            };
          } catch (error) {
            // Surface the host-side error after the turn: the kernel wraps
            // driver failures as status 'failed', and the engine rethrows
            // this original error for public-runner-identical classification.
            state.error = error;
            return {
              type: 'fail',
              error: {
                code: 'pact_runner_error',
                message: sanitizeError(error, secret),
              },
            };
          }
        },
      };
    },
  };
}

/** Maps a kernel tool result onto the observation payload the harness sees. */
function toolResultOutput(result: SoToolResult): JsonValue {
  if (result.status === 'succeeded') {
    return (result.output ?? null) as JsonValue;
  }
  return {
    error: {
      code: result.error?.code ?? 'tool_error',
      ...(result.error?.message === undefined ? {} : { message: result.error.message }),
    },
  };
}

function publicToolResultView(result: SoToolResult): JsonValue {
  return {
    status: result.status,
    ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
  };
}
