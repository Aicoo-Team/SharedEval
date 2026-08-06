/**
 * Execution-adapter boundary between PACT and SharedOS (v1).
 *
 * Shape-compatible with the pulse experiment-platform `ExecutionAdapter`
 * (initCell/runTask) so the two hosts stay conceptually aligned: one
 * fail-closed world init, one bounded turn per scheduled tick, results
 * returned as an array so a misbehaving runtime can surface duplicate
 * emissions to the collection gate instead of hiding them.
 *
 * `EmbeddedSharedOsAdapterV1` binds this contract to the production kernel;
 * `MockSharedOsAdapterV1` remains available for deterministic fault and
 * collection-gate tests.
 */
import type {
  SharedOsTurnRequestV1,
  SharedOsTurnResultV1,
  SharedOsWorldHandleV1,
  SharedOsWorldInitV1,
} from './contracts.js';

/** Injected clock/id generators keep tests deterministic. */
export type SharedOsClockV1 = { nowMs(): number };
export type SharedOsIdGenV1 = { next(prefix: string): string };

/** Thrown when world init fails closed; no turn may run afterwards. */
export class SharedOsWorldGateErrorV1 extends Error {
  constructor(
    readonly worldId: string,
    readonly reason:
      | 'digest_mismatch'
      | 'empty_world'
      | 'unknown_world'
      | 'duplicate_world'
      | 'stale_handle'
      | 'tool_surface_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'SharedOsWorldGateErrorV1';
  }
}

export interface SharedOsExecutionAdapterV1 {
  /**
   * Materialize one fresh world and verify it against the host-measured
   * digest. Throws `SharedOsWorldGateErrorV1` before any turn runs if
   * anything is off.
   */
  initWorld(init: SharedOsWorldInitV1): Promise<SharedOsWorldHandleV1>;
  /**
   * Execute exactly one bounded turn. Cadence, retries, and budgets stay
   * on the PACT side; the adapter never loops. Returns an array so
   * duplicate emissions surface to the collection gate.
   */
  runTurn(
    handle: SharedOsWorldHandleV1,
    request: SharedOsTurnRequestV1,
  ): Promise<SharedOsTurnResultV1[]>;
  /** Release world resources; safe to omit for stateless adapters. */
  closeWorld?(handle: SharedOsWorldHandleV1): Promise<void>;
}
