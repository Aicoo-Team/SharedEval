import type { AgentWorkspaceFilePathV1 } from './agent-workspace.js';

/**
 * One contract: an actor may act on a workspace file only on evidence that the
 * actor observed that file in this turn.
 *
 * It is enforced at eleven points across four layers — the file provider
 * (live turn state), the message router (live receipts), the SharedOS evidence
 * projector (projected operations) and the ledger (persisted payload). Those
 * layers hold four different shapes, so each adapts what it holds into
 * `TurnObservationV1` and asks the one predicate below. Nothing here knows
 * about roles, protocols or error codes: it answers what is unmet, and every
 * call site keeps its own wording so a rejection still says who refused.
 *
 * Adding a twelfth enforcement point means writing an adapter, not editing
 * this file.
 */

/**
 * The files every actor turn observes. The provider, the router, the projector
 * and the ledger each had their own copy of this list; a contract whose subject
 * is copy-pasted drifts exactly the way its judgement does.
 */
export const OBSERVED_TURN_FILES_V1 = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];

/** One actor's observation of one file at one workspace version. */
export type TurnObservationV1 = Readonly<{
  actorId: string;
  path: AgentWorkspaceFilePathV1;
  version: number;
  sha256: string;
  byteLength: number;
}>;

/**
 * What a call site demands the actor have observed. Every field is the call
 * site's own declaration: the predicate adds nothing a caller did not ask for,
 * so two layers that demand different things say so in one visible line
 * instead of in two near-identical forty-line helpers.
 */
export type TurnObservationRequirementV1 = Readonly<{
  actorId: string;
  /** Files that must appear among the observations. */
  paths?: readonly AgentWorkspaceFilePathV1[];
  /**
   * One observation that must match exactly. Only the fields named here are
   * compared, because the provider knows the version it expects before it
   * knows the bytes behind it.
   */
  at?: Readonly<{
    path: AgentWorkspaceFilePathV1;
    version: number;
    sha256?: string;
    byteLength?: number;
  }>;
  /**
   * Reject observations spread over more than two versions, or over two that
   * are not adjacent. A turn may straddle at most its own CAS boundary.
   */
  contiguousVersions?: boolean;
}>;

/** Why the observations do not satisfy the requirement. */
export type UnmetTurnObservationV1 = Readonly<
  | { reason: 'incomplete_coverage'; path: AgentWorkspaceFilePathV1 }
  | { reason: 'conflicting_observations'; path: AgentWorkspaceFilePathV1; version: number }
  | { reason: 'version_gap'; versions: readonly number[] }
  | { reason: 'unobserved_state'; path: AgentWorkspaceFilePathV1; version: number }
>;

/**
 * Which evidence a layer holds, and therefore what its silence means.
 *
 * `turn-state` is the provider's own record of the turn: it holds both what the
 * model read and what the host delivered into the prompt.
 * `model-read-receipts` is what every downstream layer holds: receipts for the
 * model's own `files.read` calls, and nothing else.
 */
export type TurnObservationEvidenceV1 = 'turn-state' | 'model-read-receipts';

export type PairProfileV1 = 'strict' | 'simple';

/**
 * The single fact behind every waiver of this contract.
 *
 * Turn state sees every observation the turn produced, so it can answer under
 * any profile. Read receipts see only the model's own reads. Under 'simple' the
 * host delivers the four files in the turn prompt and no receipt is synthesized
 * for that delivery — waived, never faked — so a receipt-only view is missing
 * observations that really happened and cannot answer the question at all. It
 * must not answer 'no'.
 *
 * Under 'strict' nothing is delivered, so receipts are complete and every layer
 * enforces. This is the only reason any enforcement point of this contract is
 * ever skipped; there is no second one, and there is no other place to write it.
 */
export function turnObservationEvidenceIsCompleteV1(
  evidence: TurnObservationEvidenceV1,
  pairProfile: PairProfileV1 | undefined,
): boolean {
  return evidence === 'turn-state' || pairProfile !== 'simple';
}

function unmetObservation(
  observed: readonly TurnObservationV1[],
  required: TurnObservationRequirementV1,
): UnmetTurnObservationV1 | undefined {
  const mine = observed.filter(observation => observation.actorId === required.actorId);

  // Coverage before consistency: "you never observed POLICY.md" is a more
  // useful answer than "two of your observations disagree", and it is the
  // question the caller asked first.
  for (const path of required.paths ?? []) {
    if (!mine.some(observation => observation.path === path)) {
      return { reason: 'incomplete_coverage', path };
    }
  }

  const byPathVersion = new Map<string, TurnObservationV1>();
  for (const observation of mine) {
    const key = `${observation.version}:${observation.path}`;
    const seen = byPathVersion.get(key);
    if (seen && (seen.sha256 !== observation.sha256 || seen.byteLength !== observation.byteLength)) {
      return {
        reason: 'conflicting_observations',
        path: observation.path,
        version: observation.version,
      };
    }
    byPathVersion.set(key, observation);
  }

  const at = required.at;
  if (at && !mine.some(observation => (
    observation.path === at.path
    && observation.version === at.version
    && (at.sha256 === undefined || observation.sha256 === at.sha256)
    && (at.byteLength === undefined || observation.byteLength === at.byteLength)
  ))) {
    return { reason: 'unobserved_state', path: at.path, version: at.version };
  }

  if (required.contiguousVersions) {
    const versions = [...new Set(mine.map(observation => observation.version))]
      .sort((left, right) => left - right);
    if (versions.length > 2 || (versions.length === 2 && versions[1] !== versions[0]! + 1)) {
      return { reason: 'version_gap', versions };
    }
  }

  return undefined;
}

/**
 * The predicate. Returns what is unmet, or `undefined` when the requirement is
 * satisfied — or when the evidence this layer holds cannot answer at all.
 *
 * `pairProfile` is required rather than optional on purpose: a new enforcement
 * point has to say which profile it is judging, so it cannot inherit the waiver
 * by forgetting to mention it.
 */
export function unmetTurnObservationV1(input: Readonly<{
  evidence: TurnObservationEvidenceV1;
  pairProfile: PairProfileV1 | undefined;
  observed: readonly TurnObservationV1[];
  required: TurnObservationRequirementV1;
}>): UnmetTurnObservationV1 | undefined {
  if (!turnObservationEvidenceIsCompleteV1(input.evidence, input.pairProfile)) return undefined;
  return unmetObservation(input.observed, input.required);
}

/**
 * Adapts anything already shaped like a read receipt. The four layers differ in
 * what else they carry — an outcome, previous-version columns, a trace — but
 * every one of them names the actor, the path and the version cursor it read.
 *
 * The `action: 'read'` field is load-bearing: a replacement receipt also names
 * an actor, a path and a version, and counting one as an observation would let
 * a write attest itself. Callers narrow their own rows, so a layer that forgets
 * to filter does not compile.
 */
export function toTurnObservationsV1(
  rows: readonly Readonly<{
    actorId: string;
    action: 'read';
    path: AgentWorkspaceFilePathV1;
    version: number;
    sha256: string;
    byteLength: number;
  }>[],
): readonly TurnObservationV1[] {
  return rows.map(row => ({
    actorId: row.actorId,
    path: row.path,
    version: row.version,
    sha256: row.sha256,
    byteLength: row.byteLength,
  }));
}
