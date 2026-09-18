import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBSERVED_TURN_FILES_V1,
  toTurnObservationsV1,
  turnObservationEvidenceIsCompleteV1,
  unmetTurnObservationV1,
  type TurnObservationV1,
} from '../../src/runner/v1/file-turn-observation.js';

const ACTOR = 'requester';
const sha = (seed: string) => seed.padEnd(64, '0');

function observed(
  path: typeof OBSERVED_TURN_FILES_V1[number],
  overrides: Partial<TurnObservationV1> = {},
): TurnObservationV1 {
  return {
    actorId: ACTOR,
    path,
    version: 3,
    sha256: sha(path.toLowerCase().replace(/[^a-f0-9]/g, '')),
    byteLength: 12,
    ...overrides,
  };
}

const fourFiles = OBSERVED_TURN_FILES_V1.map(path => observed(path));

test('the waiver is one fact: only a receipt-only view under simple cannot answer', () => {
  // Turn state records the host delivery as well as the model's own reads, so
  // it answers under every profile. If this ever returns false the provider
  // stops enforcing the contract that nothing downstream can enforce for it.
  assert.equal(turnObservationEvidenceIsCompleteV1('turn-state', 'simple'), true);
  assert.equal(turnObservationEvidenceIsCompleteV1('turn-state', 'strict'), true);
  assert.equal(turnObservationEvidenceIsCompleteV1('turn-state', undefined), true);

  // Read receipts are complete exactly when the host delivered nothing.
  assert.equal(turnObservationEvidenceIsCompleteV1('model-read-receipts', 'strict'), true);
  // A run that names no profile is not a 'simple' run and must still enforce:
  // the waiver has to be asked for, never inherited by omission.
  assert.equal(turnObservationEvidenceIsCompleteV1('model-read-receipts', undefined), true);
  assert.equal(turnObservationEvidenceIsCompleteV1('model-read-receipts', 'simple'), false);
});

test('strict rejects an incomplete read set and simple waives the same one', () => {
  const withoutPolicy = fourFiles.filter(row => row.path !== 'POLICY.md');
  const required = { actorId: ACTOR, paths: OBSERVED_TURN_FILES_V1 } as const;

  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: withoutPolicy,
      required,
    }),
    { reason: 'incomplete_coverage', path: 'POLICY.md' },
    'STRICT_ACCEPTED_AN_INCOMPLETE_READ_SET',
  );
  assert.equal(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'simple',
      observed: withoutPolicy,
      required,
    }),
    undefined,
    'SIMPLE_REFUSED_A_HOST_DELIVERED_READ_SET',
  );
  // The provider holds the host delivery itself, so its evidence is complete
  // and 'simple' buys it nothing.
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'turn-state',
      pairProfile: 'simple',
      observed: withoutPolicy,
      required,
    }),
    { reason: 'incomplete_coverage', path: 'POLICY.md' },
    'TURN_STATE_WAIVED_ITSELF_UNDER_SIMPLE',
  );
});

test('another actor\'s observation is not this actor\'s observation', () => {
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: fourFiles.map(row => ({ ...row, actorId: 'responder' })),
      required: { actorId: ACTOR, paths: OBSERVED_TURN_FILES_V1 },
    }),
    { reason: 'incomplete_coverage', path: 'AGENT.md' },
  );
});

test('two observations of one path at one version may not disagree', () => {
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: [...fourFiles, observed('MEMORY.md', { sha256: sha('ff') })],
      required: { actorId: ACTOR, paths: OBSERVED_TURN_FILES_V1 },
    }),
    { reason: 'conflicting_observations', path: 'MEMORY.md', version: 3 },
  );
  // Byte length is checked as well as the digest, so a receipt cannot keep its
  // hash and change its size.
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: [...fourFiles, observed('AGENT.md', { byteLength: 13 })],
      required: { actorId: ACTOR, paths: OBSERVED_TURN_FILES_V1 },
    }),
    { reason: 'conflicting_observations', path: 'AGENT.md', version: 3 },
  );
});

test('coverage answers before consistency when one set breaks both', () => {
  // The projector and the ledger each had their own copy of this rule and had
  // already drifted into opposite orders, so a set breaking both got a
  // different message from each layer. Nothing pinned the order, because no
  // payload in the suite broke both. This is the set that does.
  const breaksBoth = [
    ...fourFiles.filter(row => row.path !== 'POLICY.md'),
    observed('MEMORY.md', { sha256: sha('ff') }),
  ];
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: breaksBoth,
      required: { actorId: ACTOR, paths: OBSERVED_TURN_FILES_V1 },
    }),
    { reason: 'incomplete_coverage', path: 'POLICY.md' },
    'THE_ORDER_OF_THE_TWO_CHECKS_CHANGED',
  );
});

test('an exact state requirement compares only the fields it names', () => {
  const at = { path: 'MEMORY.md', version: 3 } as const;
  const memory = observed('MEMORY.md');

  assert.equal(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: [memory],
      required: { actorId: ACTOR, at },
    }),
    undefined,
    'A_VERSION_ONLY_REQUIREMENT_MUST_NOT_DEMAND_A_DIGEST',
  );
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: [memory],
      required: { actorId: ACTOR, at: { ...at, version: 4 } },
    }),
    { reason: 'unobserved_state', path: 'MEMORY.md', version: 4 },
    'A_WRITE_WAS_ALLOWED_AGAINST_A_VERSION_THE_TURN_NEVER_OBSERVED',
  );
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: [memory],
      required: { actorId: ACTOR, at: { ...at, sha256: sha('ab') } },
    }),
    { reason: 'unobserved_state', path: 'MEMORY.md', version: 3 },
  );
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'model-read-receipts',
      pairProfile: 'strict',
      observed: [memory],
      required: { actorId: ACTOR, at: { ...at, byteLength: 99 } },
    }),
    { reason: 'unobserved_state', path: 'MEMORY.md', version: 3 },
  );
  // Nothing observed cannot satisfy anything, which is what lets the provider
  // treat "no observation" and "wrong version" as one denial.
  assert.deepEqual(
    unmetTurnObservationV1({
      evidence: 'turn-state',
      pairProfile: undefined,
      observed: [],
      required: { actorId: ACTOR, at },
    }),
    { reason: 'unobserved_state', path: 'MEMORY.md', version: 3 },
  );
});

test('the predicate never demands version contiguity of its own accord', () => {
  // Straddling a CAS boundary and skipping versions entirely both satisfy a
  // coverage requirement. Whether either is acceptable is the ledger's
  // question about the responder, and it asks it itself.
  const straddling = [
    ...fourFiles,
    observed('MEMORY.md', { version: 4, sha256: sha('cd') }),
  ];
  const gapped = [...fourFiles, observed('MEMORY.md', { version: 6, sha256: sha('cd') })];

  for (const rows of [straddling, gapped]) {
    assert.equal(
      unmetTurnObservationV1({
        evidence: 'model-read-receipts',
        pairProfile: 'strict',
        observed: rows,
        required: { actorId: ACTOR, paths: OBSERVED_TURN_FILES_V1 },
      }),
      undefined,
      'A_REQUIREMENT_DEMANDED_SOMETHING_ITS_CALLER_DID_NOT_ASK_FOR',
    );
  }
});

test('the four files the contract is about are the four the workspace has', () => {
  assert.deepEqual(
    [...OBSERVED_TURN_FILES_V1],
    ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'],
  );
});

test('the adapter keeps the five fields the predicate compares and drops the rest', () => {
  assert.deepEqual(
    toTurnObservationsV1([{
      actorId: ACTOR,
      action: 'read',
      path: 'AGENT.md',
      version: 1,
      sha256: sha('a1'),
      byteLength: 7,
      // Layers carry their own extra columns; none of them may reach the
      // judgement.
      ...{ runId: 'run', traceId: 'trace', operationId: 'op', outcome: 'succeeded' },
    }]),
    [{ actorId: ACTOR, path: 'AGENT.md', version: 1, sha256: sha('a1'), byteLength: 7 }],
  );
});
