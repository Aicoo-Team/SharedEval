import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TURN_TIMEOUT_MS_V1,
  MAX_TURN_STEPS_V1,
  MAX_TURN_TIMEOUT_MS_V1,
  digestObjectV1,
  sharedOsTurnMessageV1Schema,
  sharedOsTurnRequestV1Schema,
  sharedOsTurnResultV1Schema,
  sharedOsWorldInitV1Schema,
} from '../../src/execution/sharedos/v1/index.js';

const WORLD_DIGEST = 'a'.repeat(64);

test('a message carries intent, purpose, and payload but a grant-shaped key is a parse error', () => {
  const clean = sharedOsTurnMessageV1Schema.safeParse({
    intent: 'answer the pending question',
    purpose: 'benchmark-task qa:127',
    payload: { taskId: 'qa:127' },
  });
  assert.equal(clean.success, true);

  for (const key of ['grants', 'capabilities', 'tools', 'authority', 'context']) {
    const poisoned = sharedOsTurnMessageV1Schema.safeParse({
      intent: 'answer the pending question',
      purpose: 'benchmark-task qa:127',
      [key]: [{ capability: 'sharedos.execution', action: 'invoke' }],
    });
    assert.equal(poisoned.success, false, `key "${key}" must be rejected`);
  }
});

test('purpose is required: it is one of the kernel authorization dimensions', () => {
  const missing = sharedOsTurnMessageV1Schema.safeParse({ intent: 'go' });
  assert.equal(missing.success, false);
});

test('turn options default to the SharedOS 120s timeout and reject above-maximum values', () => {
  const defaulted = sharedOsTurnRequestV1Schema.parse({
    turnId: 'turn-1',
    message: { intent: 'go', purpose: 'benchmark' },
  });
  assert.equal(defaulted.options.timeoutMs, DEFAULT_TURN_TIMEOUT_MS_V1);
  assert.equal(DEFAULT_TURN_TIMEOUT_MS_V1, 120_000);

  const overMax = sharedOsTurnRequestV1Schema.safeParse({
    turnId: 'turn-1',
    message: { intent: 'go', purpose: 'benchmark' },
    options: { timeoutMs: MAX_TURN_TIMEOUT_MS_V1 + 1 },
  });
  assert.equal(overMax.success, false);

  const overSteps = sharedOsTurnRequestV1Schema.safeParse({
    turnId: 'turn-1',
    message: { intent: 'go', purpose: 'benchmark' },
    options: { maxSteps: MAX_TURN_STEPS_V1 + 1 },
  });
  assert.equal(overSteps.success, false);
});

test('a persistent world may bind a unique expected tool surface per turn', () => {
  const parsed = sharedOsTurnRequestV1Schema.parse({
    turnId: 'trajectory-1:tick-2',
    message: { intent: 'go', purpose: 'benchmark' },
    expectedVisibleTools: ['search_notes', 'get_note'],
  });
  assert.deepEqual(parsed.expectedVisibleTools, ['search_notes', 'get_note']);

  assert.equal(sharedOsTurnRequestV1Schema.safeParse({
    turnId: 'trajectory-1:tick-2',
    message: { intent: 'go', purpose: 'benchmark' },
    expectedVisibleTools: ['search_notes', 'search_notes'],
  }).success, false);
});

test('world init requires a fresh namespace and a host-measured sha256 digest', () => {
  const base = {
    worldId: 'world-1',
    taskId: 'qa:127',
    namespaceId: 'run-0001',
    recipient: { kind: 'agent', agentId: 'responder' },
    expectedVisibleTools: ['memory.search'],
  };
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({ ...base, workspaceDigest: WORLD_DIGEST }).success,
    true,
  );
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({ ...base, workspaceDigest: 'not-a-digest' }).success,
    false,
  );
  const { namespaceId: _omitted, ...withoutNamespace } = base;
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({ ...withoutNamespace, workspaceDigest: WORLD_DIGEST })
      .success,
    false,
  );
});

test('addresses are discriminated by kind, mirroring SharedOS', () => {
  const agent = sharedOsWorldInitV1Schema.shape.recipient.safeParse({
    kind: 'agent',
    agentId: 'responder',
  });
  assert.equal(agent.success, true);
  const legacyShape = sharedOsWorldInitV1Schema.shape.recipient.safeParse({
    namespace: 'pact',
    agentId: 'responder',
  });
  assert.equal(legacyShape.success, false);
});

test('the execution recipient must be an agent: SharedOS ExecutionRequest.agent is agent-only', () => {
  const base = {
    worldId: 'world-1',
    taskId: 'qa:127',
    namespaceId: 'run-0001',
    workspaceDigest: WORLD_DIGEST,
    expectedVisibleTools: ['memory.search'],
  };
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({
      ...base,
      recipient: { kind: 'agent', agentId: 'responder' },
    }).success,
    true,
  );
  // A human recipient parsed fine on the PACT side pre-fix but the
  // SharedOS runtime rejects it; the mirror must reject it too.
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({
      ...base,
      recipient: { kind: 'human', userId: 'owner-1' },
    }).success,
    false,
  );
});

test('identifiers mirror SharedOS IdentifierSchema: trimmed, non-empty, max 256 chars', () => {
  const base = {
    worldId: 'world-1',
    taskId: 'qa:127',
    namespaceId: 'run-0001',
    recipient: { kind: 'agent', agentId: 'responder' },
    workspaceDigest: WORLD_DIGEST,
    expectedVisibleTools: [],
  };
  // Whitespace-only agent id trims to empty and must be rejected.
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({
      ...base,
      recipient: { kind: 'agent', agentId: '   ' },
    }).success,
    false,
  );
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({ ...base, namespaceId: '  \t ' }).success,
    false,
  );
  // Over-long identifiers must be rejected, exactly at the 256 boundary.
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({ ...base, worldId: 'w'.repeat(256) }).success,
    true,
  );
  assert.equal(
    sharedOsWorldInitV1Schema.safeParse({ ...base, worldId: 'w'.repeat(257) }).success,
    false,
  );
  // Surrounding whitespace is trimmed, matching SharedOS normalization.
  const padded = sharedOsWorldInitV1Schema.safeParse({ ...base, worldId: '  world-1  ' });
  assert.equal(padded.success, true);
  assert.equal(padded.success && padded.data.worldId, 'world-1');
});

test('turn payload must be JSON-safe, mirroring SharedOS JsonValueSchema', () => {
  const message = { intent: 'go', purpose: 'benchmark' };
  assert.equal(
    sharedOsTurnMessageV1Schema.safeParse({
      ...message,
      payload: { taskId: 'qa:127', nested: [1, 'two', null, { ok: true }] },
    }).success,
    true,
  );
  // bigint does not round-trip through JSON; SharedOS rejects it at the
  // kernel boundary, so the PACT mirror rejects it at parse time.
  for (const payload of [1n, { budget: 1n }, Number.NaN, Infinity, new Date()]) {
    assert.equal(
      sharedOsTurnMessageV1Schema.safeParse({ ...message, payload }).success,
      false,
      `payload ${String(payload)} must be rejected as non-JSON-safe`,
    );
  }
});

test('turn results carry adapter identity, protocol version, trace, and events', () => {
  const parsed = sharedOsTurnResultV1Schema.safeParse({
    turnId: 'turn-1',
    worldId: 'world-1',
    adapterId: 'mock-sharedos',
    protocolVersion: '1',
    traceId: 'trace-1',
    status: 'succeeded',
    output: 'done',
    toolCalls: [],
    events: [{ sequence: 0, type: 'turn_opened', data: {}, occurredAt: '1970-01-01T00:00:00.000Z' }],
    provenance: { requestedId: 'm', resolvedId: 'm-v1', servedId: 'm-v1' },
    usage: null,
    latencyMs: 10,
  });
  assert.equal(parsed.success, true);

  const unknownAdapter = sharedOsTurnResultV1Schema.safeParse({
    ...(parsed.success ? parsed.data : {}),
    adapterId: 'my-custom-runner',
  });
  assert.equal(unknownAdapter.success, false);
});

test('turn status vocabulary is exactly the SharedOS ExecutionResult discriminants', () => {
  const base = {
    turnId: 'turn-1',
    worldId: 'world-1',
    adapterId: 'mock-sharedos',
    protocolVersion: '1',
    traceId: 'trace-1',
    output: null,
    toolCalls: [],
    events: [],
    provenance: { requestedId: 'm', resolvedId: 'm-v1', servedId: 'm-v1' },
    usage: null,
    latencyMs: 10,
  };
  for (const status of ['succeeded', 'denied', 'failed', 'cancelled']) {
    assert.equal(
      sharedOsTurnResultV1Schema.safeParse({ ...base, status }).success,
      true,
      `status "${status}" must parse`,
    );
  }
  for (const status of ['timeout', 'no_response', 'completed', 'infrastructure_error']) {
    assert.equal(
      sharedOsTurnResultV1Schema.safeParse({ ...base, status }).success,
      false,
      `status "${status}" must be rejected`,
    );
  }
});

test('public tool status vocabulary cannot express grant state', () => {
  const result = sharedOsTurnResultV1Schema.safeParse({
    turnId: 'turn-1',
    worldId: 'world-1',
    adapterId: 'mock-sharedos',
    protocolVersion: '1',
    traceId: 'trace-1',
    status: 'succeeded',
    output: 'done',
    toolCalls: [{ callId: 'call-1', name: 'memory.search', publicStatus: 'grant_exhausted' }],
    events: [],
    provenance: { requestedId: 'm', resolvedId: 'm-v1', servedId: 'm-v1' },
    usage: null,
    latencyMs: 10,
  });
  assert.equal(result.success, false);
});

test('digestObjectV1 is key-order independent and undefined-stripping', () => {
  const a = digestObjectV1({ x: 1, y: [1, 2], z: undefined });
  const b = digestObjectV1({ y: [1, 2], x: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
