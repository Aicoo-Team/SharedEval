import { z } from 'zod';
import {
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactTaskIntroV1Schema,
  type JsonObject,
  type JsonValue,
  type PactAdapterV1,
  type PactBoundaryPlanV1,
  type PactBudgetRemainingV1,
  type PactBudgetV1,
  type PactDecisionV1,
  type PactTaskIntroV1,
  type PactToolSpecV1,
} from '../../protocol/v1/index.js';
import type {
  EmbeddedWorldFactoryV1,
  EmbeddedWorldV1,
  SharedOsIdGenV1,
  SharedOsModulesV1,
  SoAddress,
  SoAgentTurnRequest,
  SoKernel,
  SoProtocolError,
  SoToolCall,
  SoToolResult,
  SoTurnDecision,
  SoTurnDriver,
  SoTurnInput,
  SoTurnSession,
} from '../../execution/sharedos/v1/index.js';
import type { PairDataStore } from './schemas.js';
import type { PactPairTerminalDecisionV1 } from './evaluator.js';
import {
  executePactPairToolV1,
  PACT_PAIR_TOOL_SPECS_V1,
} from './tools.js';
import {
  createPactPairWorkspaceV1,
  type PactPairWorkspaceV1,
} from './workspace.js';

/** Purpose constraint shared by the Pair grants and the host's turn request. */
export const PACT_PAIR_SHAREDOS_PURPOSE_V1 = 'pact-pair-task' as const;

export const PACT_PAIR_SHAREDOS_TERMINAL_PROTOCOL_V1 =
  'pact-pair-sharedos-terminal/v1' as const;

const terminalDecisionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('answer'),
    content: z.string().min(1).max(65_536),
  }).strict(),
  z.object({
    type: z.literal('refuse'),
    reason: z.string().min(1).max(4_096),
  }).strict(),
  z.object({
    type: z.literal('escalate'),
    reason: z.string().min(1).max(4_096),
  }).strict(),
]);

/** Strict, versioned output produced when a PACT decision ends a SharedOS turn. */
export const pactPairSharedOsTerminalEnvelopeV1Schema = z.object({
  protocolVersion: z.literal(PACT_PAIR_SHAREDOS_TERMINAL_PROTOCOL_V1),
  decision: terminalDecisionSchema,
}).strict();

export type PactPairSharedOsTerminalEnvelopeV1 = z.infer<
  typeof pactPairSharedOsTerminalEnvelopeV1Schema
>;

export function parsePactPairSharedOsTerminalOutputV1(
  output: unknown,
): PactPairTerminalDecisionV1 {
  const candidate = typeof output === 'string' ? JSON.parse(output) : output;
  return pactPairSharedOsTerminalEnvelopeV1Schema.parse(candidate).decision;
}

/**
 * Host-only extension required by the SharedOS path. SharedOS is authoritative
 * for discovery, so the participant must be narrowed to the exact
 * permission-filtered surface before its first step.
 */
export interface PactExecutionToolScopedAdapterV1 {
  setExecutionToolsV1(
    tools: readonly PactToolSpecV1[],
  ): void | Promise<void>;
}

export type PactAdapterSoTurnDriverOptionsV1 = {
  /** Already initialized adapter whose requested plan was intersected by PACT. */
  adapter: PactAdapterV1 & Partial<PactExecutionToolScopedAdapterV1>;
  /** Strictly public task projection; private task/gold fields are rejected. */
  task: PactTaskIntroV1;
  grantedAccess: PactBoundaryPlanV1;
  budget: PactBudgetV1;
  /** Host-owned credential/error redaction applied before data enters SharedOS. */
  sanitizeDecision: (decision: PactDecisionV1) => PactDecisionV1;
  clock?: { nowMs(): number };
  now?: () => string;
  idGen?: SharedOsIdGenV1;
};

export type PactAdapterSoTurnToolCallRecordV1 = {
  id: string;
  name: string;
  /** Null until SharedOS returns a result (for example, after cancellation). */
  isError: boolean | null;
};

export type PactAdapterSoTurnTerminationReasonV1 =
  | 'max_turns_exceeded'
  | 'max_tool_calls_exceeded';

export type PactAdapterSoTurnDriverStateV1 = {
  turns: number;
  toolCallCount: number;
  toolCalls: PactAdapterSoTurnToolCallRecordV1[];
  finalDecision: PactPairTerminalDecisionV1 | null;
  terminationReason?: PactAdapterSoTurnTerminationReasonV1;
};

export interface PactAdapterSoTurnDriverV1 extends SoTurnDriver {
  /** Snapshot of the most recently opened, session-local PACT loop. */
  getStateV1(): PactAdapterSoTurnDriverStateV1;
  /** Original adapter.step failure; deliberately excluded from serializable state. */
  getFailureV1(): unknown | undefined;
}

type MutableDriverState = PactAdapterSoTurnDriverStateV1;

type PendingToolCall = {
  id: string;
  name: string;
};

function defaultDriverIdGen(): SharedOsIdGenV1 {
  let counter = 0;
  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

/**
 * Adapts the untrusted PACT participant to SharedOS's model-facing driver.
 * It does not initialize/finalize the adapter or plan/intersect authority;
 * those lifecycle and policy operations remain host responsibilities.
 */
export function createPactAdapterSoTurnDriverV1(
  options: PactAdapterSoTurnDriverOptionsV1,
): PactAdapterSoTurnDriverV1 {
  const task = pactTaskIntroV1Schema.parse(structuredClone(options.task));
  const grantedAccess = pactBoundaryPlanV1Schema.parse(
    structuredClone(options.grantedAccess),
  );
  const budget = structuredClone(options.budget);
  const expectedTools = visiblePactPairSharedOsToolSpecsV1(grantedAccess);
  const expectedNames = expectedTools.map(tool => tool.name).sort();
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const now = options.now ?? (() => new Date(clock.nowMs()).toISOString());
  const idGen = options.idGen ?? defaultDriverIdGen();
  let latestState = emptyDriverState();
  let latestFailure: unknown | undefined;
  let openSession = false;

  return {
    async open(
      request: SoAgentTurnRequest,
      signal: AbortSignal,
    ): Promise<SoTurnSession> {
      signal.throwIfAborted();
      if (openSession) {
        throw new Error('The PACT adapter already has an open SharedOS session');
      }
      latestFailure = undefined;
      assertExactVisibleTools(request.tools, expectedNames);

      if (typeof options.adapter.setExecutionToolsV1 !== 'function') {
        throw new Error(
          'SharedOS execution requires an adapter that supports tool scoping',
        );
      }
      await options.adapter.setExecutionToolsV1(
        expectedTools.map(tool => structuredClone(tool)),
      );
      signal.throwIfAborted();

      openSession = true;
      const state = emptyDriverState();
      latestState = state;
      const openedAtMs = clock.nowMs();
      const traceId = requireContextString(request.context, 'traceId');
      let pending: PendingToolCall | null = null;
      let started = false;
      let terminal = false;

      const finish = (
        decision: PactPairTerminalDecisionV1,
      ): SoTurnDecision => {
        state.finalDecision = structuredClone(decision);
        terminal = true;
        const envelope: PactPairSharedOsTerminalEnvelopeV1 = {
          protocolVersion: PACT_PAIR_SHAREDOS_TERMINAL_PROTOCOL_V1,
          decision: structuredClone(decision),
        };
        return {
          type: 'complete',
          output: envelope,
          metadata: {
            pactTurns: state.turns,
            pactToolCalls: state.toolCallCount,
          },
        };
      };

      const fail = (code: string, message: string): SoTurnDecision => {
        terminal = true;
        return {
          type: 'fail',
          error: { code, message },
        };
      };

      const callAdapter = async (
        observation: Parameters<PactAdapterV1['step']>[0],
        nextSignal: AbortSignal,
      ): Promise<SoTurnDecision> => {
        if (state.turns >= budget.maxTurns) {
          state.terminationReason = 'max_turns_exceeded';
          return finish({
            type: 'escalate',
            reason: 'The turn budget was exhausted before a terminal decision.',
          });
        }

        let candidate: PactDecisionV1;
        try {
          const raw = await options.adapter.step(structuredClone(observation));
          nextSignal.throwIfAborted();
          const parsed = pactDecisionV1Schema.parse(raw);
          candidate = pactDecisionV1Schema.parse(
            options.sanitizeDecision(structuredClone(parsed)),
          );
        } catch (error) {
          if (nextSignal.aborted) {
            throw nextSignal.reason ?? error;
          }
          latestFailure = error;
          return fail(
            'pact_adapter_step_failed',
            'The PACT adapter did not return a valid decision.',
          );
        }

        state.turns += 1;
        if (candidate.type !== 'tool_call') return finish(candidate);

        if (!expectedNames.includes(candidate.toolName)) {
          return fail(
            'pact_tool_outside_grant',
            'The PACT adapter requested a tool outside the visible SharedOS surface.',
          );
        }
        if (state.toolCallCount >= budget.maxToolCalls) {
          state.terminationReason = 'max_tool_calls_exceeded';
          return finish({
            type: 'escalate',
            reason: 'The tool-call budget was exhausted.',
          });
        }

        const callId = idGen.next('pact-call');
        state.toolCallCount += 1;
        pending = { id: callId, name: candidate.toolName };
        state.toolCalls.push({
          id: callId,
          name: candidate.toolName,
          isError: null,
        });
        const call: SoToolCall = {
          id: callId,
          tool: candidate.toolName,
          arguments: structuredClone(candidate.input),
          traceId,
          requestedAt: now(),
        };
        return { type: 'tool_call', call };
      };

      return {
        async next(
          input: SoTurnInput,
          nextSignal: AbortSignal,
        ): Promise<SoTurnDecision> {
          nextSignal.throwIfAborted();
          if (terminal) {
            return fail(
              'pact_session_already_terminal',
              'The PACT adapter session has already ended.',
            );
          }

          if (input.type === 'start') {
            if (started) {
              return fail(
                'pact_duplicate_start',
                'The PACT adapter session was started more than once.',
              );
            }
            started = true;
            const observation = pactObservationV1Schema.parse({
              type: 'task',
              turn: 0,
              task,
              grantedAccess,
              budgetRemaining: remainingBudget(
                budget,
                state,
                openedAtMs,
                clock.nowMs(),
              ),
            });
            return callAdapter(observation, nextSignal);
          }

          if (!started || !pending) {
            return fail(
              'pact_unexpected_tool_result',
              'SharedOS returned a tool result with no pending PACT tool call.',
            );
          }
          if (
            input.result.callId !== pending.id
            || input.result.tool !== pending.name
          ) {
            return fail(
              'pact_tool_result_mismatch',
              'SharedOS returned a tool result for a different PACT tool call.',
            );
          }

          const result = input.result;
          const isError = result.status !== 'succeeded';
          const record = state.toolCalls.at(-1);
          if (record) record.isError = isError;
          const completed = pending;
          pending = null;
          const observation = pactObservationV1Schema.parse({
            type: 'tool_result',
            turn: state.turns,
            toolCallId: completed.id,
            toolName: completed.name,
            output: pactObservationOutput(result),
            isError,
            budgetRemaining: remainingBudget(
              budget,
              state,
              openedAtMs,
              clock.nowMs(),
            ),
          });
          return callAdapter(observation, nextSignal);
        },
        close: async (_outcome, closeSignal) => {
          closeSignal.throwIfAborted();
          openSession = false;
        },
      };
    },
    getStateV1(): PactAdapterSoTurnDriverStateV1 {
      return structuredClone(latestState);
    },
    getFailureV1(): unknown | undefined {
      return latestFailure;
    },
  };
}

function emptyDriverState(): MutableDriverState {
  return {
    turns: 0,
    toolCallCount: 0,
    toolCalls: [],
    finalDecision: null,
  };
}

function remainingBudget(
  budget: PactBudgetV1,
  state: MutableDriverState,
  openedAtMs: number,
  currentMs: number,
): PactBudgetRemainingV1 {
  return {
    turns: Math.max(0, budget.maxTurns - state.turns),
    toolCalls: Math.max(0, budget.maxToolCalls - state.toolCallCount),
    runtimeMs: Math.max(0, budget.maxRuntimeMs - (currentMs - openedAtMs)),
    ...(budget.maxTokens === undefined ? {} : { tokens: budget.maxTokens }),
    ...(budget.maxCostUsd === undefined ? {} : { costUsd: budget.maxCostUsd }),
  };
}

function pactObservationOutput(result: SoToolResult): JsonValue {
  if (result.status === 'succeeded') {
    return toJsonValue(result.output ?? null);
  }
  if (result.status === 'denied') {
    // Missing, undiscoverable, and ungranted tools intentionally collapse to
    // one public result. SharedOS's privileged audit retains the exact reason.
    return {
      error: {
        code: 'tool_unavailable',
        message: 'The requested tool is unavailable.',
      },
    };
  }
  return {
    error: {
      code: result.error?.code ?? 'tool_error',
      message: result.error?.message ?? 'PACT-Pair tool execution failed.',
    },
  };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function requireContextString(
  context: Record<string, unknown>,
  key: string,
): string {
  const value = context[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SharedOS driver request is missing context.${key}`);
  }
  return value;
}

function assertExactVisibleTools(
  tools: SoAgentTurnRequest['tools'],
  expectedNames: readonly string[],
): void {
  const actualNames = tools.map(tool => tool.name).sort();
  if (
    new Set(actualNames).size !== actualNames.length
    || actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `SharedOS visible tool mismatch: expected ${JSON.stringify(expectedNames)}, `
      + `received ${JSON.stringify(actualNames)}`,
    );
  }
}

const DEFAULT_PAIR_OWNER: SoAddress = {
  kind: 'human',
  userId: 'pact-pair-owner',
};
const DEFAULT_PAIR_SENDER: SoAddress = {
  kind: 'agent',
  agentId: 'pact-pair-requester',
};
const PACT_PAIR_RESOURCE_NAMESPACE_V1 = 'pact-pair';
const PACT_PAIR_TOOL_NAMESPACE_V1 = 'pact-pair';
const PACT_PAIR_TOOL_SOURCE_V1 = 'pact';

type PactPairSharedOsActionV1 = 'read' | 'write';
type PactPairSharedOsSurfaceV1 = 'notes' | 'todos';

export type PactPairSharedOsCapabilityV1 = {
  resource: {
    namespace: typeof PACT_PAIR_RESOURCE_NAMESPACE_V1;
    path: [PactPairSharedOsSurfaceV1];
    owner: SoAddress;
  };
  actions: PactPairSharedOsActionV1[];
  scope: 'exact';
};

/** Coarse kernel grants; note-folder filtering stays in the Pair executor. */
export function derivePactPairSharedOsCapabilitiesV1(
  accessInput: PactBoundaryPlanV1,
  ownerInput: SoAddress = DEFAULT_PAIR_OWNER,
): PactPairSharedOsCapabilityV1[] {
  const access = pactBoundaryPlanV1Schema.parse(structuredClone(accessInput));
  const owner = structuredClone(ownerInput);
  const capabilities: PactPairSharedOsCapabilityV1[] = [];

  if (access.access.notes.read.scope !== 'none') {
    capabilities.push(pairCapability(
      'notes',
      access.access.notes.write ? ['read', 'write'] : ['read'],
      owner,
    ));
  }
  if (access.access.todos.read) {
    capabilities.push(pairCapability(
      'todos',
      access.access.todos.write ? ['read', 'write'] : ['read'],
      owner,
    ));
  }
  return capabilities;
}

function pairCapability(
  surface: PactPairSharedOsSurfaceV1,
  actions: PactPairSharedOsActionV1[],
  owner: SoAddress,
): PactPairSharedOsCapabilityV1 {
  return {
    resource: {
      namespace: PACT_PAIR_RESOURCE_NAMESPACE_V1,
      path: [surface],
      owner: structuredClone(owner),
    },
    actions,
    scope: 'exact',
  };
}

export function visiblePactPairSharedOsToolSpecsV1(
  accessInput: PactBoundaryPlanV1,
): PactToolSpecV1[] {
  const access = pactBoundaryPlanV1Schema.parse(structuredClone(accessInput));
  return PACT_PAIR_TOOL_SPECS_V1
    .filter(spec => toolIsGranted(spec.name, spec.sideEffects, access))
    .map(spec => structuredClone(spec));
}

export function visiblePactPairSharedOsToolNamesV1(
  access: PactBoundaryPlanV1,
): string[] {
  return visiblePactPairSharedOsToolSpecsV1(access).map(tool => tool.name);
}

function toolIsGranted(
  name: string,
  sideEffects: PactToolSpecV1['sideEffects'],
  access: PactBoundaryPlanV1,
): boolean {
  const surface = surfaceForTool(name);
  if (surface === 'notes') {
    return sideEffects === 'read'
      ? access.access.notes.read.scope !== 'none'
      : access.access.notes.write;
  }
  return sideEffects === 'read'
    ? access.access.todos.read
    : access.access.todos.write;
}

function surfaceForTool(name: string): PactPairSharedOsSurfaceV1 {
  if (name.endsWith('_note') || name.endsWith('_notes')) return 'notes';
  if (name.endsWith('_todo') || name.endsWith('_todos')) return 'todos';
  throw new Error(`PACT-Pair tool has no SharedOS surface mapping: ${name}`);
}

export type CreatePactPairEmbeddedWorldOptionsV1 = {
  seed: PairDataStore;
  /** Must be the host-intersected plan, never the participant's raw request. */
  grantedAccess: PactBoundaryPlanV1;
  owner?: SoAddress;
  sender?: SoAddress;
  purpose?: string;
  now?: () => string;
  /** Optional deny-condition experiment; omission grants normal execution. */
  executionGrant?: 'granted' | 'withheld';
};

export type PactPairEmbeddedWorldBundleV1 = {
  world: EmbeddedWorldV1;
  workspace: PactPairWorkspaceV1;
  canonicalWorld: PactPairSharedOsCanonicalWorldV1;
  expectedVisibleTools: string[];
};

export type PactPairSharedOsCanonicalWorldV1 = {
  protocolVersion: 'pact-pair-sharedos-world/v1';
  workspace: PairDataStore;
  grantedAccess: PactBoundaryPlanV1;
  owner: SoAddress;
  sender: SoAddress;
  purpose: string;
  executionGrant: 'granted' | 'withheld';
  enabledToolNamespaces: string[];
  allTools: PactToolSpecV1[];
  visibleToolNames: string[];
};

/**
 * Materializes one task-local Pair world. The accepted inputs deliberately do
 * not include LoadedPactPairTaskV1, gold labels, or evaluator state.
 */
export function createPactPairEmbeddedWorldV1(
  options: CreatePactPairEmbeddedWorldOptionsV1,
): PactPairEmbeddedWorldBundleV1 {
  const access = pactBoundaryPlanV1Schema.parse(structuredClone(options.grantedAccess));
  const owner = structuredClone(options.owner ?? DEFAULT_PAIR_OWNER);
  const sender = structuredClone(options.sender ?? DEFAULT_PAIR_SENDER);
  const purpose = options.purpose ?? PACT_PAIR_SHAREDOS_PURPOSE_V1;
  const executionGrant = options.executionGrant ?? 'granted';
  if (purpose.trim().length === 0) {
    throw new Error('PACT-Pair SharedOS purpose must not be empty');
  }
  const workspace = createPactPairWorkspaceV1(options.seed, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const expectedVisibleTools = visiblePactPairSharedOsToolNamesV1(access);
  const canonicalWorld: PactPairSharedOsCanonicalWorldV1 = {
    protocolVersion: 'pact-pair-sharedos-world/v1',
    workspace: workspace.snapshot(),
    grantedAccess: structuredClone(access),
    owner: structuredClone(owner),
    sender: structuredClone(sender),
    purpose,
    executionGrant,
    enabledToolNamespaces: [PACT_PAIR_TOOL_NAMESPACE_V1],
    allTools: PACT_PAIR_TOOL_SPECS_V1.map(tool => structuredClone(tool)),
    visibleToolNames: [...expectedVisibleTools],
  };

  const world: EmbeddedWorldV1 = {
    owner,
    sender,
    enabledToolNamespaces: [PACT_PAIR_TOOL_NAMESPACE_V1],
    canonicalWorld,
    executionGrant,
    setup(kernel) {
      for (const spec of PACT_PAIR_TOOL_SPECS_V1) {
        kernel.registerTool(createPairToolHandler(spec, workspace, access, owner));
      }
    },
    senderGrants(modules, namespaceId) {
      const capabilities = derivePactPairSharedOsCapabilitiesV1(access, owner);
      if (capabilities.length === 0) return [];
      return [modules.testkit.createTestGrant({
        id: 'grant-pact-pair-tools',
        namespaceId,
        subject: sender,
        issuer: owner,
        capabilities,
        purposes: [purpose],
        issuedAt: '1970-01-01T00:00:00.000Z',
      })];
    },
  };

  return {
    world,
    workspace,
    canonicalWorld: structuredClone(canonicalWorld),
    expectedVisibleTools: [...expectedVisibleTools],
  };
}

export type PactPairEmbeddedWorldFactoryBundleV1 =
  PactPairEmbeddedWorldBundleV1 & {
    worldFactory: EmbeddedWorldFactoryV1;
  };

/** A single-use world factory plus the workspace handle needed for snapshots. */
export function createPactPairEmbeddedWorldFactoryV1(
  options: CreatePactPairEmbeddedWorldOptionsV1,
): PactPairEmbeddedWorldFactoryBundleV1 {
  const bundle = createPactPairEmbeddedWorldV1(options);
  let used = false;
  const worldFactory: EmbeddedWorldFactoryV1 = init => {
    if (used) {
      throw new Error('A PACT-Pair EmbeddedWorld factory can initialize only one world');
    }
    const expected = [...bundle.expectedVisibleTools].sort();
    const received = [...init.expectedVisibleTools].sort();
    if (
      received.length !== expected.length
      || received.some((name, index) => name !== expected[index])
    ) {
      throw new Error('PACT-Pair world init expectedVisibleTools does not match its grants');
    }
    used = true;
    return bundle.world;
  };
  return { ...bundle, worldFactory };
}

type PairToolHandlerV1 = {
  definition: {
    name: string;
    description: string;
    namespace: string;
    source: string;
    readWrite: 'read' | 'write';
    inputSchema: JsonObject;
    requiredCapability: {
      resource: {
        namespace: string;
        path: string[];
        owner: SoAddress;
      };
      action: PactPairSharedOsActionV1;
    };
    annotations: {
      readOnly: boolean;
      destructive: boolean;
    };
  };
  parseArguments(arguments_: JsonObject): JsonObject;
  invoke(
    context: Record<string, unknown>,
    call: SoToolCall,
    signal: AbortSignal,
  ): Promise<SoToolResult>;
};

function createPairToolHandler(
  spec: PactToolSpecV1,
  workspace: PactPairWorkspaceV1,
  access: PactBoundaryPlanV1,
  owner: SoAddress,
): PairToolHandlerV1 {
  const action: PactPairSharedOsActionV1 = spec.sideEffects;
  const surface = surfaceForTool(spec.name);
  return {
    definition: {
      name: spec.name,
      description: spec.description ?? `Execute PACT-Pair tool ${spec.name}.`,
      namespace: PACT_PAIR_TOOL_NAMESPACE_V1,
      source: PACT_PAIR_TOOL_SOURCE_V1,
      readWrite: action,
      inputSchema: structuredClone(spec.inputSchema),
      requiredCapability: {
        resource: {
          namespace: PACT_PAIR_RESOURCE_NAMESPACE_V1,
          path: [surface],
          owner: structuredClone(owner),
        },
        action,
      },
      annotations: {
        readOnly: action === 'read',
        destructive: action === 'write',
      },
    },
    parseArguments(arguments_) {
      return parsePairToolArguments(spec, arguments_);
    },
    async invoke(context, call, signal) {
      signal.throwIfAborted();
      const executed = await executePactPairToolV1({
        workspace,
        access,
        toolName: spec.name,
        input: call.arguments,
      });
      signal.throwIfAborted();
      const completedAt = contextNow(context);
      if (!executed.isError) {
        return {
          callId: call.id,
          tool: call.tool,
          status: 'succeeded',
          output: executed.output,
          completedAt,
        };
      }
      const error = pactToolError(executed.output);
      return {
        callId: call.id,
        tool: call.tool,
        status: error.code === 'access_denied' ? 'denied' : 'failed',
        error,
        completedAt,
      };
    },
  };
}

function parsePairToolArguments(
  spec: PactToolSpecV1,
  input: JsonObject,
): JsonObject {
  const schema = spec.inputSchema;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!(key in input)) throw new TypeError('missing required tool argument');
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) throw new TypeError('unknown tool argument');
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some(branch => {
      if (!isRecord(branch) || !Array.isArray(branch.required)) return false;
      return branch.required.every(key => typeof key === 'string' && key in input);
    });
    if (!matches) throw new TypeError('tool arguments do not match any allowed shape');
  }

  const parsed: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!isRecord(property)) {
      parsed[key] = structuredClone(value);
      continue;
    }
    parsed[key] = parseJsonSchemaScalar(property, value);
  }
  return parsed;
}

function parseJsonSchemaScalar(
  schema: Record<string, unknown>,
  value: JsonValue,
): JsonValue {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new TypeError('tool argument must be a string');
    const normalized = value.trim();
    if (
      typeof schema.minLength === 'number'
      && normalized.length < schema.minLength
    ) {
      throw new TypeError('tool string argument is too short');
    }
    if (
      typeof schema.maxLength === 'number'
      && normalized.length > schema.maxLength
    ) {
      throw new TypeError('tool string argument is too long');
    }
    return normalized;
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError('tool argument must be an integer');
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new TypeError('tool integer argument is below its minimum');
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new TypeError('tool integer argument is above its maximum');
    }
    return value;
  }
  return structuredClone(value);
}

function contextNow(context: Record<string, unknown>): string {
  const value = context.now;
  return typeof value === 'string' && value.length > 0
    ? value
    : new Date().toISOString();
}

function pactToolError(output: JsonValue): SoProtocolError {
  if (isRecord(output) && isRecord(output.error)) {
    const code = output.error.code;
    const message = output.error.message;
    if (typeof code === 'string' && typeof message === 'string') {
      return { code, message };
    }
  }
  return {
    code: 'pact_pair_tool_error',
    message: 'PACT-Pair tool execution failed.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
