import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MockSharedOsAdapterV1,
  SharedOsWorldGateErrorV1,
  type SharedOsWorldInitV1,
} from '../../src/execution/sharedos/v1/index.js';

const DIGEST = 'b'.repeat(64);

function worldInit(overrides: Partial<SharedOsWorldInitV1> = {}): SharedOsWorldInitV1 {
  return {
    worldId: 'world-1',
    taskId: 'qa:127',
    recipient: { namespace: 'pact', agentId: 'responder' },
    workspaceDigest: DIGEST,
    expectedVisibleTools: ['memory.search'],
    ...overrides,
  };
}

function makeAdapter(
  turns: ConstructorParameters<typeof MockSharedOsAdapterV1>[0]['turns'] = {},
) {
  return new MockSharedOsAdapterV1({
    worlds: {
      'world-1': { workspaceDigest: DIGEST, visibleTools: ['memory.search'] },
    },
    turns,
  });
}

test('init fails closed on digest mismatch, unknown world, and empty world', async () => {
  const adapter = makeAdapter({ 'world:world-1': { fault: 'empty-world' } });

  await assert.rejects(
    () => makeAdapter().initWorld(worldInit({ workspaceDigest: 'c'.repeat(64) })),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'digest_mismatch',
  );
  await assert.rejects(
    () => makeAdapter().initWorld(worldInit({ worldId: 'world-9' })),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'unknown_world',
  );
  await assert.rejects(
    () => adapter.initWorld(worldInit()),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'empty_world',
  );
});

test('a clean turn completes exactly once with valid provenance', async () => {
  const adapter = makeAdapter({ 'turn-1': { output: 'the answer', toolCallNames: ['memory.search'] } });
  const handle = await adapter.initWorld(worldInit());
  const results = await adapter.runTurn(handle, {
    turnId: 'turn-1',
    message: { intent: 'answer' },
    timeoutMs: 1000,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'completed');
  assert.equal(results[0].output, 'the answer');
  assert.equal(results[0].provenance.servedId, results[0].provenance.resolvedId);
  assert.deepEqual(results[0].toolCalls.map(c => c.publicStatus), ['ok']);
});

test('running a turn against a never-initialized world fails closed', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.runTurn(
      { worldId: 'world-1', worldDigestAtInit: DIGEST },
      { turnId: 'turn-1', message: { intent: 'go' }, timeoutMs: 1000 },
    ),
    (error: unknown) => error instanceof SharedOsWorldGateErrorV1,
  );
});

test('timeout fault reports the bounded limit and produces no output', async () => {
  const adapter = makeAdapter({ 'turn-t': { fault: 'timeout' } });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, {
    turnId: 'turn-t',
    message: { intent: 'go' },
    timeoutMs: 2500,
  });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.output, null);
  assert.equal(result.latencyMs, 2500);
});

test('duplicate emission surfaces both rows instead of hiding one', async () => {
  const adapter = makeAdapter({ 'turn-d': { fault: 'duplicate-emission' } });
  const handle = await adapter.initWorld(worldInit());
  const results = await adapter.runTurn(handle, {
    turnId: 'turn-d',
    message: { intent: 'go' },
    timeoutMs: 1000,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].turnId, results[1].turnId);
});

test('served-model drift is visible in provenance for downstream gates', async () => {
  const adapter = makeAdapter({ 'turn-m': { fault: 'served-model-drift' } });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, {
    turnId: 'turn-m',
    message: { intent: 'go' },
    timeoutMs: 1000,
  });
  assert.equal(result.outcome, 'completed');
  assert.notEqual(result.provenance.servedId, result.provenance.resolvedId);
});

test('transient fault fails the first attempt and completes the retry', async () => {
  const adapter = makeAdapter({ 'turn-r': { fault: 'transient-then-success' } });
  const handle = await adapter.initWorld(worldInit());
  const request = { turnId: 'turn-r', message: { intent: 'go' }, timeoutMs: 1000 };
  const [first] = await adapter.runTurn(handle, request);
  assert.equal(first.outcome, 'infrastructure_error');
  const [second] = await adapter.runTurn(handle, request);
  assert.equal(second.outcome, 'completed');
});

test('absent and undiscoverable tools return the same public tool_unavailable', async () => {
  const adapter = makeAdapter({
    'turn-u': { toolCallNames: ['memory.search', 'billing.charge', 'no-such-tool'] },
  });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, {
    turnId: 'turn-u',
    message: { intent: 'go' },
    timeoutMs: 1000,
  });
  assert.deepEqual(
    result.toolCalls.map(call => call.publicStatus),
    ['ok', 'tool_unavailable', 'tool_unavailable'],
  );
});

test('malformed turn requests are rejected before execution', async () => {
  const adapter = makeAdapter();
  const handle = await adapter.initWorld(worldInit());
  await assert.rejects(() =>
    adapter.runTurn(handle, {
      turnId: 'turn-x',
      message: {
        intent: 'go',
        grants: [{ capability: 'sharedos.execution' }],
      },
      timeoutMs: 1000,
    } as never),
  );
});

test('closeWorld releases the world; later turns fail closed', async () => {
  const adapter = makeAdapter();
  const handle = await adapter.initWorld(worldInit());
  await adapter.closeWorld(handle);
  await assert.rejects(
    () => adapter.runTurn(handle, {
      turnId: 'turn-z',
      message: { intent: 'go' },
      timeoutMs: 1000,
    }),
    (error: unknown) => error instanceof SharedOsWorldGateErrorV1,
  );
});
