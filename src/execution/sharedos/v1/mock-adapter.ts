/**
 * In-memory SharedOS mock (v1), adapter id `mock-sharedos`.
 *
 * Deterministic stand-in for the real SharedOS runtime, reproducing the
 * incident classes the pulse experiment-platform mock encodes so that
 * PACT-side gates can be acceptance-tested against them:
 *
 *   - timeout                → status `cancelled` at the bounded limit
 *                              (the runtime aborts with "turn timeout")
 *   - no-response            → status `failed`, null output
 *   - denied                 → status `denied`; an experimental outcome,
 *                              deterministic across repeated attempts
 *   - duplicate-emission     → two result rows for one turn
 *   - served-model-drift     → provenance.servedId differs from resolvedId
 *   - transient-then-success → first attempt `failed`, retry (a new
 *                              turnId, host policy) succeeds
 *   - empty-world            → init fails closed before any turn
 *
 * Every entry point parses its arguments with the strict contracts first;
 * authorization and execution over unvalidated input is exactly the class
 * of bug the real kernel guards against, so the mock refuses it too.
 */
import {
  sharedOsTurnRequestV1Schema,
  sharedOsWorldInitV1Schema,
  SHAREDOS_PROTOCOL_VERSION_V1,
  type SharedOsModelProvenanceV1,
  type SharedOsToolCallRecordV1,
  type SharedOsTurnEventV1,
  type SharedOsTurnRequestV1,
  type SharedOsTurnResultV1,
  type SharedOsWorldHandleV1,
  type SharedOsWorldInitV1,
} from './contracts.js';
import {
  SharedOsWorldGateErrorV1,
  type SharedOsClockV1,
  type SharedOsExecutionAdapterV1,
  type SharedOsIdGenV1,
} from './adapter.js';

export type MockFaultV1 =
  | 'timeout'
  | 'no-response'
  | 'denied'
  | 'duplicate-emission'
  | 'served-model-drift'
  | 'transient-then-success'
  | 'empty-world';

export type MockWorldSpecV1 = {
  /** Digest the mock "materializes"; init fails closed unless it matches. */
  workspaceDigest: string;
  /** Tools the world exposes after permission filtering. */
  visibleTools?: readonly string[];
};

export type MockTurnScriptV1 = {
  /** Fault to inject for this turnId; omit for a clean success. */
  fault?: MockFaultV1;
  /** Output text for succeeded turns. */
  output?: string;
  /** Tool names the scripted turn attempts, in order. */
  toolCallNames?: readonly string[];
};

export type MockSharedOsAdapterOptionsV1 = {
  worlds: Record<string, MockWorldSpecV1>;
  /** Per-turnId scripts; an unscripted turn succeeds with a stub output. */
  turns?: Record<string, MockTurnScriptV1>;
  provenance?: SharedOsModelProvenanceV1;
  clock?: SharedOsClockV1;
  idGen?: SharedOsIdGenV1;
};

const DEFAULT_PROVENANCE_V1: SharedOsModelProvenanceV1 = {
  requestedId: 'mock-model',
  resolvedId: 'mock-model-v1',
  servedId: 'mock-model-v1',
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

export class MockSharedOsAdapterV1 implements SharedOsExecutionAdapterV1 {
  private readonly worlds: Record<string, MockWorldSpecV1>;
  private readonly turns: Record<string, MockTurnScriptV1>;
  private readonly provenance: SharedOsModelProvenanceV1;
  private readonly clock: SharedOsClockV1;
  private readonly idGen: SharedOsIdGenV1;
  private readonly attemptsByTurnId = new Map<string, number>();
  private readonly openWorlds = new Set<string>();

  constructor(options: MockSharedOsAdapterOptionsV1) {
    this.worlds = options.worlds;
    this.turns = options.turns ?? {};
    this.provenance = options.provenance ?? DEFAULT_PROVENANCE_V1;
    this.clock = options.clock ?? { nowMs: () => 0 };
    this.idGen = options.idGen ?? defaultIdGen();
  }

  async initWorld(init: SharedOsWorldInitV1): Promise<SharedOsWorldHandleV1> {
    const parsed = sharedOsWorldInitV1Schema.parse(init);
    const world = this.worlds[parsed.worldId];
    if (!world) {
      throw new SharedOsWorldGateErrorV1(
        parsed.worldId,
        'unknown_world',
        `World ${parsed.worldId} is not materialized in this mock.`,
      );
    }
    if (this.faultForWorld(parsed.worldId) === 'empty-world') {
      throw new SharedOsWorldGateErrorV1(
        parsed.worldId,
        'empty_world',
        `World ${parsed.worldId} materialized empty; refusing to run turns.`,
      );
    }
    if (world.workspaceDigest !== parsed.workspaceDigest) {
      throw new SharedOsWorldGateErrorV1(
        parsed.worldId,
        'digest_mismatch',
        `World ${parsed.worldId} digest mismatch: host measured `
        + `${parsed.workspaceDigest}, runtime materialized ${world.workspaceDigest}.`,
      );
    }
    this.openWorlds.add(parsed.worldId);
    return {
      worldId: parsed.worldId,
      namespaceId: parsed.namespaceId,
      worldDigestAtInit: world.workspaceDigest,
    };
  }

  async runTurn(
    handle: SharedOsWorldHandleV1,
    request: SharedOsTurnRequestV1,
  ): Promise<SharedOsTurnResultV1[]> {
    const parsed = sharedOsTurnRequestV1Schema.parse(request);
    if (!this.openWorlds.has(handle.worldId)) {
      throw new SharedOsWorldGateErrorV1(
        handle.worldId,
        'unknown_world',
        `World ${handle.worldId} was never initialized or is closed.`,
      );
    }
    const script = this.turns[parsed.turnId] ?? {};
    const attempt = (this.attemptsByTurnId.get(parsed.turnId) ?? 0) + 1;
    this.attemptsByTurnId.set(parsed.turnId, attempt);

    const traceId = this.idGen.next('trace');
    const base = {
      turnId: parsed.turnId,
      worldId: handle.worldId,
      adapterId: 'mock-sharedos' as const,
      protocolVersion: SHAREDOS_PROTOCOL_VERSION_V1,
      traceId,
      toolCalls: this.scriptedToolCalls(handle.worldId, script),
      events: this.turnEvents(parsed.turnId, traceId),
      provenance: this.provenance,
      usage: { inputTokens: 128, outputTokens: 64 },
    };

    switch (script.fault) {
      case 'timeout':
        return [{
          ...base,
          status: 'cancelled',
          output: null,
          usage: null,
          latencyMs: parsed.options.timeoutMs,
          errorDetail: 'turn timeout',
        }];
      case 'no-response':
        return [{
          ...base,
          status: 'failed',
          output: null,
          usage: null,
          latencyMs: 5,
          errorDetail: 'The turn produced no output.',
        }];
      case 'denied':
        return [{
          ...base,
          status: 'denied',
          output: null,
          usage: null,
          latencyMs: 5,
          errorDetail:
            'Execution grant did not authorize this turn. Experimental '
            + 'outcome: do not retry with a wider principal.',
        }];
      case 'duplicate-emission': {
        const succeeded = this.succeededResult(base, script);
        return [succeeded, { ...succeeded }];
      }
      case 'served-model-drift':
        return [{
          ...this.succeededResult(base, script),
          provenance: { ...this.provenance, servedId: `${this.provenance.resolvedId}-drifted` },
        }];
      case 'transient-then-success':
        if (attempt === 1) {
          return [{
            ...base,
            status: 'failed',
            output: null,
            usage: null,
            latencyMs: 5,
            errorDetail: 'Transient provider failure; retry with a new turnId.',
          }];
        }
        return [this.succeededResult(base, script)];
      case 'empty-world':
        throw new SharedOsWorldGateErrorV1(
          handle.worldId,
          'empty_world',
          'empty-world is an init-time fault; it cannot occur during a turn.',
        );
      default:
        return [this.succeededResult(base, script)];
    }
  }

  async closeWorld(handle: SharedOsWorldHandleV1): Promise<void> {
    this.openWorlds.delete(handle.worldId);
  }

  private succeededResult(
    base: Omit<SharedOsTurnResultV1, 'status' | 'output' | 'latencyMs'>,
    script: MockTurnScriptV1,
  ): SharedOsTurnResultV1 {
    return {
      ...base,
      status: 'succeeded',
      output: script.output ?? `mock output for ${base.turnId}`,
      latencyMs: Math.max(1, this.clock.nowMs() % 1000),
    };
  }

  /** Minimal append-only event trail; the real runtime emits far more. */
  private turnEvents(turnId: string, traceId: string): SharedOsTurnEventV1[] {
    return [
      {
        sequence: 0,
        type: 'turn_opened',
        data: { turnId, traceId },
        occurredAt: new Date(this.clock.nowMs()).toISOString(),
      },
      {
        sequence: 1,
        type: 'turn_closed',
        data: { turnId },
        occurredAt: new Date(this.clock.nowMs()).toISOString(),
      },
    ];
  }

  /**
   * A scripted call to a tool the world does not expose returns the same
   * public `tool_unavailable` as an exhausted or absent tool — the mock
   * must not leak whether the tool exists.
   */
  private scriptedToolCalls(
    worldId: string,
    script: MockTurnScriptV1,
  ): SharedOsToolCallRecordV1[] {
    const visible = new Set(this.worlds[worldId]?.visibleTools ?? []);
    return (script.toolCallNames ?? []).map(name => ({
      callId: this.idGen.next('call'),
      name,
      publicStatus: visible.has(name) ? 'ok' : 'tool_unavailable',
    }));
  }

  private faultForWorld(worldId: string): MockFaultV1 | undefined {
    return Object.entries(this.turns).find(
      ([turnId, script]) =>
        script.fault === 'empty-world' && turnId === `world:${worldId}`,
    )?.[1].fault;
  }
}
