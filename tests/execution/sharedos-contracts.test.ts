import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TURN_TIMEOUT_MS_V1,
  MAX_TURN_TIMEOUT_MS_V1,
  digestObjectV1,
  sharedOsTurnMessageV1Schema,
  sharedOsTurnRequestV1Schema,
  sharedOsTurnResultV1Schema,
  sharedOsWorldInitV1Schema,
} from '../../src/execution/sharedos/v1/index.js';

const WORLD_DIGEST = 'a'.repeat(64);

test('a message carries intent and context but a grant-shaped key is a parse error', () => {
  const clean = sharedOsTurnMessageV1Schema.safeParse({
    intent: 'answer the pending question',
    context: { taskId: 'qa:127' },
  });
  assert.equal(clean.success, true);

  for (const key of ['grants', 'capabilities', 'tools', 'authority']) {
    const poisoned = sharedOsTurnMessageV1Schema.safeParse({
      intent: 'answer the pending question',
      [key]: [{ capability: 'sharedos.execution', action: 'invoke' }],
    });
    assert.equal(poisoned.success, false, `key "${key}" must be rejected`);
  }
});

test('turn timeout defaults, and above-maximum requests are rejected, not clamped', () => {
  const defaulted = sharedOsTurnRequestV1Schema.parse({
    turnId: 'turn-1',
    message: { intent: 'go' },
  });
  assert.equal(defaulted.timeoutMs, DEFAULT_TURN_TIMEOUT_MS_V1);

  const overMax = sharedOsTurnRequestV1Schema.safeParse({
    turnId: 'turn-1',
    message: { intent: 'go' },
    timeoutMs: MAX_TURN_TIMEOUT_MS_V1 + 1,
  });
  assert.equal(overMax.success, false);
});

test('world init requires a host-measured sha256 digest', () => {
  const base = {
    worldId: 'world-1',
    taskId: 'qa:127',
    recipient: { namespace: 'pact', agentId: 'responder' },
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
});

test('public tool status vocabulary cannot express grant state', () => {
  const result = sharedOsTurnResultV1Schema.safeParse({
    turnId: 'turn-1',
    worldId: 'world-1',
    outcome: 'completed',
    output: 'done',
    toolCalls: [{ callId: 'call-1', name: 'memory.search', publicStatus: 'grant_exhausted' }],
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
