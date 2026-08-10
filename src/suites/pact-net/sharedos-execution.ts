/**
 * PACT-Net single-trial engine over the real SharedOS kernel
 * (`benchmark.execution.adapter: sharedos-embedded`).
 *
 * The Net trial semantics are unchanged — routing enforcement before
 * delivery, harness step loop, budgets, credential redaction, snapshot-diff
 * evaluation — but the decision loop executes as exactly one bounded
 * SharedOS turn: the suite harness is bridged into SharedOS's
 * `AgentTurnDriver` port and every tool call flows through the kernel's
 * filtered registry and invocation gate instead of PACT's own tool loop.
 *
 * Semantic decisions (deliberate; the Pair engine in
 * ../pact-pair/sharedos-execution.ts is the precedent):
 *
 * - **World per trial.** Each trial materializes a fresh ephemeral kernel:
 *   `canonicalWorld` is the task id plus the target agent's seed store,
 *   `initWorld` builds the kernel, one `runTurn` executes the dyad, and
 *   `closeWorld` discards it. Sender is the task's source agent, recipient
 *   is the target agent, owner is the target agent's human principal.
 * - **Grant construction.** PACT-Net has no requester-facing boundary plan:
 *   the target agent's assistant operates on its own store with the full
 *   benchmark tool surface (see tools.ts). Grants are therefore
 *   host-constructed per trial at surface granularity for the whole
 *   surface — notes search/read/create/edit, todos search/read/create/
 *   complete — subject = the sender, and travel through the AccessContext,
 *   never through the message. `expectedVisibleTools` is derived from the
 *   same mapping, so the adapter's enforced visibility check fails closed
 *   on any drift.
 * - **Routing.** A routing-blocked dyad never reaches SharedOS: the message
 *   is undeliverable, so no kernel, no harness, no tools — identical to the
 *   in-process engine.
 * - **Result mapping.** `succeeded` carries the harness's terminal decision;
 *   `denied` (kernel refused the turn admission) is an experimental outcome
 *   recorded as an escalation with a `sharedos_turn_denied` violation — never
 *   an infrastructure retry; `cancelled` (kernel turn timeout) maps to the
 *   in-process timeout shape (`max_runtime_ms_exceeded` + infrastructure
 *   error); `failed` is an infrastructure error. Kernel runtime and audit
 *   events go to the private trace artifact; the public result row carries
 *   only the adapter identity block.
 */
import {
  pactDecisionV1Schema,
  type JsonValue,
} from '../../protocol/v1/index.js';
import { pactModelIdentifierV1 } from '../../runner/v1/config.js';
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
  redactDecisionCredential,
  sanitizeError,
  withinDeadline,
} from '../pact-pair/environment.js';
import {
  finishPactNetTaskV1,
  readPactNetProviderTelemetryV1,
  remainingPactNetBudgetV1,
  type PactNetHarnessV1,
  type PactNetObservationV1,
  type PactNetSingleTaskRunV1,
  type PactNetToolCallRecordV1,
  type PactNetTraceEventV1,
  type RunSinglePactNetTaskV1Options,
} from './environment.js';
import { executePactNetToolV1, PACT_NET_TOOL_SPECS_V1 } from './tools.js';
import { PactNetWorkspaceV1 } from './workspace.js';
import type { PactNetTerminalDecisionV1 } from './evaluator.js';

export const PACT_NET_SHAREDOS_PURPOSE_V1 = 'pact-net-benchmark' as const;
export const PACT_NET_SHAREDOS_INTENT_V1 = 'pact-net:respond' as const;

export type PactNetToolNameV1 = typeof PACT_NET_TOOL_SPECS_V1[number]['name'];

/**
 * Surface-granularity capability behind each PACT-Net tool. The kernel's
 * filtered registry and invocation gate operate on these; argument
 * validation and workspace semantics remain inside `executePactNetToolV1`.
 */
export const PACT_NET_SHAREDOS_TOOL_CAPABILITIES_V1: Record<
  string,
  { namespace: 'notes' | 'todos'; action: string; readOnly: boolean }
> = {
  search_notes: { namespace: 'notes', action: 'search', readOnly: true },
  get_note: { namespace: 'notes', action: 'read', readOnly: true },
  create_note: { namespace: 'notes', action: 'create', readOnly: false },
  edit_note: { namespace: 'notes', action: 'edit', readOnly: false },
  search_todos: { namespace: 'todos', action: 'search', readOnly: true },
  get_todo: { namespace: 'todos', action: 'read', readOnly: true },
  create_todo: { namespace: 'todos', action: 'create', readOnly: false },
  complete_todo: { namespace: 'todos', action: 'complete', readOnly: false },
};

/**
 * Kernel actions granted per namespace. PACT-Net grants the full benchmark
 * surface (the assistant owns its principal's store); the function exists so
 * grants and `expectedVisibleTools` always derive from the one mapping.
 */
export function grantedPactNetSharedOsActionsV1(): { notes: string[]; todos: string[] } {
  const notes: string[] = [];
  const todos: string[] = [];
  for (const spec of PACT_NET_TOOL_SPECS_V1) {
    const capability = PACT_NET_SHAREDOS_TOOL_CAPABILITIES_V1[spec.name];
    if (!capability) {
      throw new Error(`PACT-Net tool ${spec.name} has no SharedOS capability mapping`);
    }
    const bucket = capability.namespace === 'notes' ? notes : todos;
    if (!bucket.includes(capability.action)) bucket.push(capability.action);
  }
  return { notes, todos };
}

/** The tool names the kernel must make visible under the grants above. */
export function expectedVisiblePactNetSharedOsToolsV1(): string[] {
  const actions = grantedPactNetSharedOsActionsV1();
  return PACT_NET_TOOL_SPECS_V1
    .map(spec => spec.name)
    .filter(name => {
      const capability = PACT_NET_SHAREDOS_TOOL_CAPABILITIES_V1[name];
      return capability !== undefined
        && actions[capability.namespace].includes(capability.action);
    });
}

/**
 * Registers the eight deterministic PACT-Net tools as SharedOS host tools.
 * Argument validation stays inside `executePactNetToolV1` so malformed
 * arguments surface as a tool-error result (parity with the in-process
 * engine), never as a turn failure.
 */
export function createPactNetSharedOsToolHandlersV1(options: {
  workspace: PactNetWorkspaceV1;
}): unknown[] {
  return PACT_NET_TOOL_SPECS_V1.map(spec => {
    const capability = PACT_NET_SHAREDOS_TOOL_CAPABILITIES_V1[spec.name];
    if (!capability) {
      throw new Error(`PACT-Net tool ${spec.name} has no SharedOS capability mapping`);
    }
    return {
      definition: {
        name: spec.name,
        description: spec.description ?? `PACT-Net tool ${spec.name}`,
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
        const executed = await executePactNetToolV1({
          workspace: options.workspace,
          toolName: call.tool,
          input: call.arguments as JsonValue,
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
          error: pactNetToolProtocolErrorV1(executed.output),
          completedAt: context.now,
        };
      },
    };
  });
}

function pactNetToolProtocolErrorV1(output: JsonValue): { code: string; message?: string } {
  // PACT-Net tool errors are `{ error: <message string> }` (tools.ts); carry
  // the message through the kernel's protocol-error shape.
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const error = (output as { error?: JsonValue }).error;
    if (typeof error === 'string' && error.length > 0) {
      return { code: 'tool_error', message: error };
    }
  }
  return { code: 'tool_error' };
}

const availableToolNames = new Set(PACT_NET_TOOL_SPECS_V1.map(tool => tool.name));

class PactNetSharedOsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    // Reuse the runner protocol-error name so classifyRunnerFailure buckets
    // this as adapter_protocol_error, identical to the in-process engine.
    this.name = 'PactRunnerProtocolError';
  }
}

type DriverState = {
  turns: number;
  toolCallCount: number;
  finalDecision: PactNetTerminalDecisionV1;
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
      // never degrade into hundreds of infrastructure_error rows.
      throw new Error(
        `benchmark.execution.adapter is sharedos-embedded but SharedOS could not be loaded: ${loaded.reason}`,
      );
    }
    return loaded.modules;
  });
  return cachedModules;
}

/**
 * Test-only injection point: lets suite tests substitute a scripted
 * SharedOS module surface (for incident classes the real kernel cannot be
 * asked to produce on demand, e.g. a denied turn admission). The runner
 * dispatch never passes it, so benchmark runs always load the real build.
 */
export type PactNetSharedOsInternalsV1 = {
  modules?: SharedOsModulesV1;
};

export async function runSinglePactNetTaskViaSharedOsV1(
  options: RunSinglePactNetTaskV1Options,
  internals: PactNetSharedOsInternalsV1 = {},
): Promise<PactNetSingleTaskRunV1> {
  const startedAt = Date.now();
  const deadline = startedAt + options.config.budget.maxRuntimeMs;
  const secret = options.environment[options.config.model.apiKeyEnv];
  const trace: PactNetTraceEventV1[] = [];
  const violations: string[] = [];
  const workspace = new PactNetWorkspaceV1(options.seed);
  const before = workspace.snapshot();
  let harness: PactNetHarnessV1 | undefined;
  let errorMessage: string | undefined;
  let finalizeError: string | undefined;
  let providerTelemetry: PactNetSingleTaskRunV1['result']['providerTelemetry'];
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

  if (!options.task.routingAllowed) {
    // Routing-level enforcement: the message is never delivered, so neither
    // the kernel nor the harness is ever instantiated.
    state.finalDecision = {
      type: 'routing_blocked',
      reason: `${options.task.targetAgent} is not in ${options.task.sourceAgent}'s contact list`,
    };
    record('routing_blocked', { finalDecision: state.finalDecision });
    return finishPactNetTaskV1({
      options,
      workspace,
      before,
      finalDecision: state.finalDecision,
      trace,
      violations,
      toolCalls: [],
      turns: 0,
      toolCallCount: 0,
      startedAt,
      record,
    });
  }

  try {
    const modules = internals.modules ?? await requireSharedOsModulesV1();
    const activeHarness = await withinDeadline(
      Promise.resolve().then(() => options.harnessFactory({
        config: structuredClone(options.config),
        publicTask: structuredClone(options.task.publicTask),
      })),
      deadline,
      'harness creation',
    );
    harness = activeHarness;

    const owner: SoAddress = {
      kind: 'human',
      userId: `pact-net-owner-${options.task.targetAgent}`,
    };
    const sender: SoAddress = { kind: 'agent', agentId: options.task.sourceAgent };
    const recipient = { kind: 'agent', agentId: options.task.targetAgent } as const;
    // The digest attests the declarative task state only (seed store and
    // task identity); tool registration and grant wiring are code, versioned
    // with this suite — see the digest-scope note in the adapter docs.
    const canonicalWorld = { taskId: options.task.taskId, workspace: options.seed };
    const grantActions = grantedPactNetSharedOsActionsV1();
    const expectedVisibleTools = expectedVisiblePactNetSharedOsToolsV1();

    const world: EmbeddedWorldV1 = {
      owner,
      sender,
      canonicalWorld,
      setup(kernel) {
        for (const handler of createPactNetSharedOsToolHandlersV1({ workspace })) {
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
            issuer: owner,
            capabilities: [{
              resource: { namespace, path: [], owner },
              actions: grantActions[namespace],
              scope: 'descendants',
            }],
            purposes: [PACT_NET_SHAREDOS_PURPOSE_V1],
          })),
    };

    const driver = createPactNetTurnDriverV1({
      harness: activeHarness,
      options,
      state,
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
      recipient,
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
        intent: PACT_NET_SHAREDOS_INTENT_V1,
        purpose: PACT_NET_SHAREDOS_PURPOSE_V1,
        payload: { taskId: options.task.taskId },
      },
      options: { timeoutMs: Math.floor(timeoutMs) },
    });
    await adapter.closeWorld(handle);

    if (results.length !== 1) {
      // The adapter returns an array precisely so duplicate emissions reach
      // this collection gate instead of being hidden.
      violations.push('sharedos_duplicate_emission');
      throw new PactNetSharedOsProtocolError(
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
    // 'failed' wrapper so classification matches the in-process engine.
    if (state.error !== undefined) throw state.error;

    switch (turnResult.status) {
      case 'succeeded':
        if (!state.terminalReceived && !hasBudgetViolation(violations)) {
          throw new PactNetSharedOsProtocolError(
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
        // Kernel turn timeout maps to the in-process timeout shape.
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
    if (harness?.finalize) {
      try {
        await withinDeadline(
          Promise.resolve(harness.finalize()),
          deadline,
          'harness finalization',
        );
      } catch (error) {
        finalizeError = sanitizeError(error, secret);
        record('finalize_error', { message: finalizeError });
      }
    }
    if (harness) {
      providerTelemetry = readPactNetProviderTelemetryV1(harness);
    }
  }

  const toolCalls: PactNetToolCallRecordV1[] = (turnResult?.toolCalls ?? []).map(call => ({
    id: call.callId,
    name: call.name,
    isError: call.publicStatus !== 'ok',
  }));

  return finishPactNetTaskV1({
    options,
    workspace,
    before,
    finalDecision: state.finalDecision,
    trace,
    violations,
    toolCalls,
    turns: state.turns,
    toolCallCount: state.toolCallCount,
    startedAt,
    record,
    ...(providerTelemetry === undefined ? {} : { providerTelemetry }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(finalizeError === undefined ? {} : { finalizeError }),
    ...(turnResult === undefined
      ? {}
      : {
          sharedOs: {
            adapterId: turnResult.adapterId,
            protocolVersion: turnResult.protocolVersion,
            status: turnResult.status,
            traceId: turnResult.traceId,
            latencyMs: turnResult.latencyMs,
          },
        }),
  });
}

function hasBudgetViolation(violations: string[]): boolean {
  return violations.includes('max_turns_exceeded')
    || violations.includes('max_tool_calls_exceeded');
}

/**
 * Bridges the PACT-Net harness into SharedOS's AgentTurnDriver port. PACT
 * keeps owning cadence and budgets (turns, tool calls, runtime deadline);
 * the kernel owns permission filtering, the invocation gate, and the
 * bounded turn. The driver never sees grants — SharedOS sanitizes the
 * model-facing request itself.
 */
function createPactNetTurnDriverV1(context: {
  harness: PactNetHarnessV1;
  options: RunSinglePactNetTaskV1Options;
  state: DriverState;
  deadline: number;
  secret: string | undefined;
  record: (event: string, data: unknown) => void;
}): SoTurnDriver {
  const { harness, options, state, deadline, secret, record } = context;
  const config = options.config;
  const task = options.task;
  return {
    async open(request) {
      const requestContext = request.context as { traceId: string; now: string };
      const complete = (
        decision: PactNetTerminalDecisionV1,
      ): SoTurnDecision => ({
        type: 'complete',
        output: JSON.stringify(decision),
      });
      return {
        next: async (input): Promise<SoTurnDecision> => {
          try {
            let observation: PactNetObservationV1;
            if (input.type === 'start') {
              observation = {
                type: 'task',
                turn: 0,
                task: structuredClone(task.publicTask),
                budgetRemaining: remainingPactNetBudgetV1(
                  config,
                  state.turns,
                  state.toolCallCount,
                  deadline,
                ),
              };
            } else {
              record('tool_result', {
                toolCallId: input.result.callId,
                toolName: input.result.tool,
                result: publicToolResultView(input.result),
              });
              observation = {
                type: 'tool_result',
                turn: state.turns,
                toolCallId: input.result.callId,
                toolName: input.result.tool,
                output: toolResultOutput(input.result),
                isError: input.result.status !== 'succeeded',
                budgetRemaining: remainingPactNetBudgetV1(
                  config,
                  state.turns,
                  state.toolCallCount,
                  deadline,
                ),
              };
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
                  Promise.resolve(harness.step(structuredClone(observation))),
                  deadline,
                  'harness step',
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
              throw new PactNetSharedOsProtocolError(
                `Harness requested unavailable tool ${decision.toolName}`,
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
            // this original error for in-process-identical classification.
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

/**
 * Maps a kernel tool result onto the observation payload the harness sees.
 * Success carries the tool output; failure reconstructs the in-process
 * `{ error: <message> }` shape (tools.ts) so both execution paths present
 * tool errors identically. Kernel-level unavailability keeps its public
 * code — the public vocabulary cannot express grant state.
 */
function toolResultOutput(result: SoToolResult): JsonValue {
  if (result.status === 'succeeded') {
    return (result.output ?? null) as JsonValue;
  }
  if (result.error?.code === 'tool_error' && typeof result.error.message === 'string') {
    return { error: result.error.message };
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
