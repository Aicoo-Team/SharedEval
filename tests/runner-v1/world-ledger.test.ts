import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openFileWorkflowLedgerV1 } from '../../src/runner/v1/file-workflow-ledger.js';
import { binding, heartbeatPayloadFor, transition } from './file-workflow-test-fixtures.js';

test('world commits require actor frontiers and reject dropped or broken context history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'world-ledger-'));
  const base = binding('files-multi', 'world-history', ['PAIR-Q-1', 'PAIR-Q-2']);
  const runBinding = { ...base, scheduler: { ...base.scheduler,
    world: { protocol: 'actor-context/v1' as const, maxContextBytes: 4096 } } };
  const store = await openFileWorkflowLedgerV1({ runDirectory: root, binding: runBinding, retainPrivate: true });
  const actors = [base.actors.requester.actorId, base.actors.responder.actorId].sort();
  const frontier = (sequence: number, hash: string) => actors.map(actorId => ({ actorId, sequence, hash: hash.repeat(64) }));
  try {
    const first = heartbeatPayloadFor(runBinding, 1, [transition('PAIR-Q-1', 'error', 1)]);
    await store.beginHeartbeat({ event: first.event, inputDigest: first.inputDigest });
    await assert.rejects(store.commitHeartbeat(first), /context/i);
    const before = frontier(0, 'a');
    const after = frontier(3, 'b');
    first.worldContext = { before, after };
    await store.commitHeartbeat(first);
    const second = heartbeatPayloadFor(runBinding, 2, [transition('PAIR-Q-2', 'error', 2)]);
    await store.beginHeartbeat({ event: second.event, inputDigest: second.inputDigest });
    second.worldContext = { before, after: frontier(6, 'c') };
    await assert.rejects(store.commitHeartbeat(second), /context/i);
    second.worldContext = { before: after, after: frontier(6, 'c') };
    await store.commitHeartbeat(second);
    assert.equal((await store.readRecords()).length, 2);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy reset-context bindings cannot acquire history fields under an unchanged identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-world-ledger-'));
  const runBinding = binding('files-multi', 'legacy-history', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({ runDirectory: root, binding: runBinding, retainPrivate: true });
  try {
    const first = heartbeatPayloadFor(runBinding, 1, [transition('PAIR-Q-1', 'error', 1)]);
    const before = [runBinding.actors.requester.actorId, runBinding.actors.responder.actorId].sort()
      .map(actorId => ({ actorId, sequence: 0, hash: 'a'.repeat(64) }));
    first.worldContext = { before, after: before };
    await store.beginHeartbeat({ event: first.event, inputDigest: first.inputDigest });
    await assert.rejects(store.commitHeartbeat(first), /context/i);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('world binding refuses a changed effective model or run configuration on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'world-config-binding-'));
  const base = binding('files-multi', 'world-config', ['PAIR-Q-1']);
  const runBinding = { ...base, scheduler: { ...base.scheduler,
    world: { protocol: 'actor-context/v1' as const, maxContextBytes: 4096 },
    configurationDigest: 'a'.repeat(64) } };
  try {
    const store = await openFileWorkflowLedgerV1({ runDirectory: root, binding: runBinding, retainPrivate: true });
    await store.close();
    await assert.rejects(openFileWorkflowLedgerV1({ runDirectory: root, retainPrivate: true,
      binding: { ...runBinding, scheduler: { ...runBinding.scheduler, configurationDigest: 'b'.repeat(64) } },
    }), /binding/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
