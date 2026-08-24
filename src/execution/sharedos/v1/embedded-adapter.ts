/**
 * `sharedos-embedded` — the real SharedOS binding (v1).
 *
 * Implements `SharedOsExecutionAdapterV1` over a locally built SharedOS
 * workspace: one fresh kernel per world, one bounded `TurnExecutor` run
 * per tick. The production permission kernel is exercised, not
 * reimplemented — grants, deny-by-default authorization, tool filtering,
 * and audit all run inside SharedOS.
 *
 * Boundary responsibilities, per the SharedOS PACT integration guide:
 *   - PACT (this adapter's caller) supplies the world: providers, tools,
 *     sender grants, and the canonical world bytes. Gold labels and
 *     evaluator state must never enter the world factory's output.
 *   - Each tick issues an explicit recipient-scoped execution grant
 *     unless the experiment condition deliberately withholds it
 *     (`executionGrant: 'withheld'` — permission denial is then the
 *     expected experimental outcome).
 *   - The model-facing request is sanitized by SharedOS itself; the
 *     driver never sees grants or issuing authority.
 */
import {
  digestObjectV1,
  sharedOsTurnRequestV1Schema,
  sharedOsWorldHandleV1Schema,
  sharedOsWorldInitV1Schema,
  SHAREDOS_PROTOCOL_VERSION_V1,
  type SharedOsModelProvenanceV1,
  type SharedOsToolCallRecordV1,
  type SharedOsTurnRequestV1,
  type SharedOsTurnResultV1,
  type SharedOsWorldHandleV1,
  type SharedOsWorldInitV1,
} from './contracts.js';
import {
  SharedOsWorldGateErrorV1,
  type SharedOsExecutionAdapterV1,
  type SharedOsIdGenV1,
} from './adapter.js';
import type {
  SharedOsModulesV1,
  SoAddress,
  SoKernel,
  SoTestKernel,
  SoToolResult,
  SoTurnDriver,
} from './embedded-types.js';

/**
 * What one PACT world looks like to the embedded adapter. Produced per
 * `initWorld` by a suite-owned factory; must contain public task state
 * only — never gold labels, evaluator channels, or another run's state.
 */
export type EmbeddedWorldV1 = {
  owner: SoAddress;
  /** The agent whose turn-opening grant is issued (the requester). */
  sender: SoAddress;
  /** Explicit host-selected tool families. Empty means all tools are off. */
  enabledToolNamespaces: readonly string[];
  /**
   * Canonical world value; its digest must equal the host-measured one.
   * Digest scope (deliberately narrow): the digest attests THIS value —
   * the declarative task state — and nothing else. `setup()` and
   * `senderGrants()` are imperative code and can materialize kernel
   * state the digest does not cover; they are versioned with the suite
   * in this repository, so executable-world reproducibility is
   * digest + suite code version, never the digest alone.
   */
  canonicalWorld: unknown;
  /**
   * Register resource providers and tool handlers on the fresh kernel.
   * Not covered by the world digest — see `canonicalWorld`.
   */
  setup(kernel: SoKernel, modules: SharedOsModulesV1): void | Promise<void>;
  /**
   * Grants for the sender beyond the per-tick execution grant.
   * Not covered by the world digest — see `canonicalWorld`.
   */
  senderGrants(modules: SharedOsModulesV1, namespaceId: string): unknown[];
  /**
   * `granted` (default) issues the per-tick recipient-scoped execution
   * grant; `withheld` omits it so the turn is denied — an experimental
   * condition, not an error.
   */
  executionGrant?: 'granted' | 'withheld';
};

export type EmbeddedWorldFactoryV1 = (
  init: SharedOsWorldInitV1,
  modules: SharedOsModulesV1,
) => EmbeddedWorldV1 | Promise<EmbeddedWorldV1>;

export type EmbeddedSharedOsAdapterOptionsV1 = {
  modules: SharedOsModulesV1;
  worldFactory: EmbeddedWorldFactoryV1;
  /** The agent-under-test driver (SharedOS AgentTurnDriver port). */
  driver: SoTurnDriver;
  provenance: SharedOsModelProvenanceV1;
  clock?: { nowMs(): number };
  idGen?: SharedOsIdGenV1;
};

type WorldState = {
  world: EmbeddedWorldV1;
  test: SoTestKernel;
  recipient: SoAddress;
  namespaceId: string;
  /** Digest recorded at init; caller-provided handles must match it. */
  worldDigestAtInit: string;
  /** Expectation from init; verified against the kernel before each turn. */
  expectedVisibleTools: readonly string[];
};

function defaultIdGen(): SharedOsIdGenV1 {
  let counter = 0;
  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}-${String(counter).padStart(4, '0')}`;
    },
  };
}

const PUBLIC_UNAVAILABLE_CODES = new Set(['tool_unavailable', 'tool_not_available']);

function publicToolStatus(result: SoToolResult): SharedOsToolCallRecordV1['publicStatus'] {
  if (result.status === 'succeeded') return 'ok';
  if (result.error && PUBLIC_UNAVAILABLE_CODES.has(result.error.code)) {
    return 'tool_unavailable';
  }
  return 'error';
}

export class EmbeddedSharedOsAdapterV1 implements SharedOsExecutionAdapterV1 {
  private readonly options: EmbeddedSharedOsAdapterOptionsV1;
  private readonly clock: { nowMs(): number };
  private readonly idGen: SharedOsIdGenV1;
  private readonly worlds = new Map<string, WorldState>();

  constructor(options: EmbeddedSharedOsAdapterOptionsV1) {
    this.options = options;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.idGen = options.idGen ?? defaultIdGen();
  }

  async initWorld(init: SharedOsWorldInitV1): Promise<SharedOsWorldHandleV1> {
    const parsed = sharedOsWorldInitV1Schema.parse(init);
    const world = await this.options.worldFactory(parsed, this.options.modules);
    if (world.canonicalWorld === null || world.canonicalWorld === undefined) {
      throw new SharedOsWorldGateErrorV1(
        parsed.worldId,
        'empty_world',
        `World ${parsed.worldId} materialized empty; refusing to run turns.`,
      );
    }
    const materializedDigest = digestObjectV1(world.canonicalWorld);
    if (materializedDigest !== parsed.workspaceDigest) {
      throw new SharedOsWorldGateErrorV1(
        parsed.worldId,
        'digest_mismatch',
        `World ${parsed.worldId} digest mismatch: host measured `
        + `${parsed.workspaceDigest}, factory materialized ${materializedDigest}.`,
      );
    }
    const test = this.options.modules.testkit.createTestKernel();
    await world.setup(test.kernel, this.options.modules);
    this.worlds.set(parsed.worldId, {
      world,
      test,
      recipient: parsed.recipient as SoAddress,
      namespaceId: parsed.namespaceId,
      worldDigestAtInit: materializedDigest,
      expectedVisibleTools: [...parsed.expectedVisibleTools],
    });
    return {
      worldId: parsed.worldId,
      namespaceId: parsed.namespaceId,
      worldDigestAtInit: materializedDigest,
    };
  }

  async runTurn(
    handle: SharedOsWorldHandleV1,
    request: SharedOsTurnRequestV1,
  ): Promise<SharedOsTurnResultV1[]> {
    const parsed = sharedOsTurnRequestV1Schema.parse(request);
    const parsedHandle = sharedOsWorldHandleV1Schema.parse(handle);
    const state = this.worlds.get(parsedHandle.worldId);
    if (!state) {
      throw new SharedOsWorldGateErrorV1(
        parsedHandle.worldId,
        'unknown_world',
        `World ${parsedHandle.worldId} was never initialized or is closed.`,
      );
    }
    // A handle is a claim, not a lookup key: its namespace and digest
    // must match what init recorded, or the turn must not run.
    if (
      parsedHandle.namespaceId !== state.namespaceId
      || parsedHandle.worldDigestAtInit !== state.worldDigestAtInit
    ) {
      throw new SharedOsWorldGateErrorV1(
        parsedHandle.worldId,
        'handle_mismatch',
        `Handle for world ${parsedHandle.worldId} does not match init: `
        + `namespace ${parsedHandle.namespaceId} vs ${state.namespaceId}, `
        + `digest ${parsedHandle.worldDigestAtInit} vs ${state.worldDigestAtInit}.`,
      );
    }
    const { modules } = this.options;
    const { world, test, recipient, namespaceId } = state;

    const startedAtMs = this.clock.nowMs();
    const nowIso = () => new Date(this.clock.nowMs()).toISOString();
    const traceId = this.idGen.next('trace');

    const grants = [...world.senderGrants(modules, namespaceId)];
    if ((world.executionGrant ?? 'granted') === 'granted') {
      grants.push(
        modules.testkit.createTestGrant({
          id: this.idGen.next('grant-exec'),
          namespaceId,
          subject: world.sender,
          issuer: world.owner,
          capabilities: [modules.core.agentExecutionCapability(recipient, world.owner)],
          purposes: [parsed.message.purpose],
        }),
      );
    }

    const context = {
      namespaceId,
      actor: world.sender,
      authority: world.owner,
      owner: world.owner,
      purpose: parsed.message.purpose,
      traceId,
      enabledToolNamespaces: [...world.enabledToolNamespaces],
      grants,
      now: nowIso(),
    };

    const tools = await test.kernel.listTools(context);
    // expectedVisibleTools is enforced, not advisory: if SharedOS's
    // permission filtering yields a different effective tool set than
    // the host declared at init, refuse to run the turn.
    const effectiveTools = [...new Set(tools.map(tool => tool.name))].sort();
    const expectedTools = [...new Set(state.expectedVisibleTools)].sort();
    if (
      effectiveTools.length !== expectedTools.length
      || effectiveTools.some((name, index) => name !== expectedTools[index])
    ) {
      throw new SharedOsWorldGateErrorV1(
        parsedHandle.worldId,
        'visible_tools_mismatch',
        `World ${parsedHandle.worldId} effective tool set `
        + `[${effectiveTools.join(', ')}] does not match expectedVisibleTools `
        + `[${expectedTools.join(', ')}]; refusing to run the turn.`,
      );
    }
    const toolCalls: SharedOsToolCallRecordV1[] = [];
    const executor = new modules.runtime.TurnExecutor(
      test.kernel,
      this.recordingDriver(toolCalls),
      { clock: nowIso, createId: () => this.idGen.next('event') },
    );

    const result = await executor.execute({
      version: SHAREDOS_PROTOCOL_VERSION_V1,
      executionId: parsed.turnId,
      agent: recipient,
      context,
      message: {
        version: SHAREDOS_PROTOCOL_VERSION_V1,
        id: this.idGen.next('message'),
        sender: world.sender,
        receiver: recipient,
        intent: parsed.message.intent,
        purpose: parsed.message.purpose,
        payload: (parsed.message.payload ?? null) as never,
        traceId,
        createdAt: nowIso(),
      },
      tools: [...tools],
      options: {
        timeoutMs: parsed.options.timeoutMs,
        ...(parsed.options.maxSteps === undefined
          ? {}
          : { maxSteps: parsed.options.maxSteps }),
      },
    });

    const output =
      result.status === 'succeeded' && result.output !== undefined
        ? typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output)
        : null;

    const runtimeEvents = result.events.map(event => ({
      sequence: event.sequence,
      type: event.type,
      data: event.data,
      occurredAt: event.occurredAt,
    }));
    // Kernel-level audit records (authorization.checked, tool.invoked, …)
    // are what make authorization decisions reconstructable from the run
    // transcript; append this turn's slice after the runtime events.
    const auditEvents = state.test.audit.events
      .filter(event => event.traceId === traceId)
      .map((event, index) => ({
        sequence: runtimeEvents.length + index,
        type: `audit.${event.type}`,
        data: event as unknown,
        occurredAt: event.at,
      }));

    return [{
      turnId: parsed.turnId,
      worldId: parsedHandle.worldId,
      adapterId: 'sharedos-embedded',
      protocolVersion: SHAREDOS_PROTOCOL_VERSION_V1,
      traceId: result.traceId,
      status: result.status,
      output,
      toolCalls,
      events: [...runtimeEvents, ...auditEvents],
      provenance: this.options.provenance,
      usage: null,
      latencyMs: Math.max(0, this.clock.nowMs() - startedAtMs),
      ...(result.error === undefined
        ? {}
        : { errorDetail: `${result.error.code}${result.error.message ? `: ${result.error.message}` : ''}` }),
    }];
  }

  async closeWorld(handle: SharedOsWorldHandleV1): Promise<void> {
    this.worlds.delete(handle.worldId);
  }

  /**
   * Wraps the configured driver so every tool result flowing back through
   * the session is recorded with its public status. The wrapper adds no
   * authority and cannot alter decisions.
   */
  private recordingDriver(toolCalls: SharedOsToolCallRecordV1[]): SoTurnDriver {
    const inner = this.options.driver;
    return {
      async open(request, signal) {
        const session = await inner.open(request, signal);
        return {
          async next(input, nextSignal) {
            if (input.type === 'tool_result') {
              toolCalls.push({
                callId: input.result.callId,
                name: input.result.tool,
                publicStatus: publicToolStatus(input.result),
              });
            }
            return session.next(input, nextSignal);
          },
          ...(session.close ? { close: session.close.bind(session) } : {}),
        };
      },
    };
  }
}
