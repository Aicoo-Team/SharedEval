import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MockSharedOsAdapterV1,
  SharedOsWorldGateErrorV1,
  type SharedOsTurnRequestV1,
  type SharedOsWorldInitV1,
} from '../../src/execution/sharedos/v1/index.js';

const DIGEST = 'b'.repeat(64);

function worldInit(overrides: Partial<SharedOsWorldInitV1> = {}): SharedOsWorldInitV1 {
  return {
    worldId: 'world-1',
    taskId: 'qa:127',
    namespaceId: 'run-0001',
    recipient: { kind: 'agent', agentId: 'responder' },
    workspaceDigest: DIGEST,
    expectedVisibleTools: ['memory.search'],
    ...overrides,
  };
}

function turnRequest(
  turnId: string,
  overrides: Partial<SharedOsTurnRequestV1> = {},
): SharedOsTurnRequestV1 {
  return {
    turnId,
    message: { intent: 'go', purpose: 'benchmark-task qa:127' },
    options: { timeoutMs: 1000 },
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

test('a clean turn succeeds exactly once with adapter identity and events', async () => {
  const adapter = makeAdapter({ 'turn-1': { output: 'the answer', toolCallNames: ['memory.search'] } });
  const handle = await adapter.initWorld(worldInit());
  assert.equal(handle.namespaceId, 'run-0001');
  const results = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'succeeded');
  assert.equal(results[0].output, 'the answer');
  assert.equal(results[0].adapterId, 'mock-sharedos');
  assert.equal(results[0].protocolVersion, '1');
  assert.equal(results[0].provenance.servedId, results[0].provenance.resolvedId);
  assert.deepEqual(results[0].toolCalls.map(c => c.publicStatus), ['ok']);
  assert.deepEqual(results[0].events.map(e => e.type), ['turn_opened', 'turn_closed']);
});

test('running a turn against a never-initialized world fails closed', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.runTurn(
      { worldId: 'world-1', namespaceId: 'run-0001', worldDigestAtInit: DIGEST },
      turnRequest('turn-1'),
    ),
    (error: unknown) => error instanceof SharedOsWorldGateErrorV1,
  );
});

test('timeout fault surfaces as cancelled at the bounded limit, per the runtime abort', async () => {
  const adapter = makeAdapter({ 'turn-t': { fault: 'timeout' } });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(
    handle,
    turnRequest('turn-t', { options: { timeoutMs: 2500 } }),
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.output, null);
  assert.equal(result.latencyMs, 2500);
  assert.equal(result.errorDetail, 'turn timeout');
});

test('denied is a deterministic experimental outcome, not a transient failure', async () => {
  const adapter = makeAdapter({ 'turn-p': { fault: 'denied' } });
  const handle = await adapter.initWorld(worldInit());
  const [first] = await adapter.runTurn(handle, turnRequest('turn-p'));
  assert.equal(first.status, 'denied');
  const [second] = await adapter.runTurn(handle, turnRequest('turn-p'));
  assert.equal(second.status, 'denied', 'a retry must not flip a denial');
});

test('duplicate emission surfaces both rows instead of hiding one', async () => {
  const adapter = makeAdapter({ 'turn-d': { fault: 'duplicate-emission' } });
  const handle = await adapter.initWorld(worldInit());
  const results = await adapter.runTurn(handle, turnRequest('turn-d'));
  assert.equal(results.length, 2);
  assert.equal(results[0].turnId, results[1].turnId);
});

test('served-model drift is visible in provenance for downstream gates', async () => {
  const adapter = makeAdapter({ 'turn-m': { fault: 'served-model-drift' } });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-m'));
  assert.equal(result.status, 'succeeded');
  assert.notEqual(result.provenance.servedId, result.provenance.resolvedId);
});

test('transient fault fails the first attempt and succeeds on retry', async () => {
  const adapter = makeAdapter({ 'turn-r': { fault: 'transient-then-success' } });
  const handle = await adapter.initWorld(worldInit());
  const [first] = await adapter.runTurn(handle, turnRequest('turn-r'));
  assert.equal(first.status, 'failed');
  const [second] = await adapter.runTurn(handle, turnRequest('turn-r'));
  assert.equal(second.status, 'succeeded');
});

test('absent and undiscoverable tools return the same public tool_unavailable', async () => {
  const adapter = makeAdapter({
    'turn-u': { toolCallNames: ['memory.search', 'billing.charge', 'no-such-tool'] },
  });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-u'));
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
        purpose: 'benchmark',
        grants: [{ capability: 'sharedos.execution' }],
      },
      options: { timeoutMs: 1000 },
    } as never),
  );
});

test('a handle with a foreign namespace or digest fails closed', async () => {
  const adapter = makeAdapter();
  const handle = await adapter.initWorld(worldInit());
  await assert.rejects(
    () => adapter.runTurn({ ...handle, namespaceId: 'run-other' }, turnRequest('turn-1')),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'handle_mismatch',
  );
  await assert.rejects(
    () => adapter.runTurn({ ...handle, worldDigestAtInit: 'e'.repeat(64) }, turnRequest('turn-1')),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'handle_mismatch',
  );
  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(result.status, 'succeeded');
});

test('expectedVisibleTools is enforced against the world tool set before any turn', async () => {
  const adapter = makeAdapter();
  const handle = await adapter.initWorld(
    worldInit({ expectedVisibleTools: ['memory.search', 'memory.write'] }),
  );
  await assert.rejects(
    () => adapter.runTurn(handle, turnRequest('turn-1')),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1
      && error.reason === 'visible_tools_mismatch',
  );
});

test('closeWorld releases the world; later turns fail closed', async () => {
  const adapter = makeAdapter();
  const handle = await adapter.initWorld(worldInit());
  await adapter.closeWorld(handle);
  await assert.rejects(
    () => adapter.runTurn(handle, turnRequest('turn-z')),
    (error: unknown) => error instanceof SharedOsWorldGateErrorV1,
  );
});
