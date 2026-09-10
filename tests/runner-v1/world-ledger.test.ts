import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256JsonV1, type JsonValue } from '../../src/contracts/json.js';
import { buildFileWorkflowHeartbeatPayloadV1 } from '../../src/runner/v1/file-workflow-heartbeat.js';
import { openFileWorkflowLedgerV1 } from '../../src/runner/v1/file-workflow-ledger.js';
import { projectFileWorkflowSharedOsEvidenceV1 } from '../../src/runner/v1/file-workflow-sharedos-evidence.js';
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
    first.worldContext = { before, after: before };
    await assert.rejects(store.commitHeartbeat(first), /requester context/i);
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

test('world requester admission denial commits unchanged history and rejects fabricated observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'world-denied-admission-'));
  const base = binding('files-multi', 'world-denied', ['PAIR-Q-1']);
  const runBinding = { ...base, scheduler: { ...base.scheduler,
    world: { protocol: 'actor-context/v1' as const, maxContextBytes: 4096 } } };
  const fixture = heartbeatPayloadFor(runBinding, 1, [], { requesterExecutionStatus: 'denied' });
  const [resolution, admission] = fixture.privateEvidence.sourceEvidence.auditEvents;
  admission.outcome = 'denied';
  admission.reason = 'grant_not_found';
  delete admission.grantId;
  const auditEvents = [resolution, admission];
  const native = projectFileWorkflowSharedOsEvidenceV1({
    binding: runBinding,
    event: fixture.event,
    turn: {
      executionId: fixture.sharedOsAuthority.requesterExecutionId,
      traceId: fixture.event.traceId,
      executionStatus: 'denied',
      decision: null,
      requesterReads: [],
      providerUsage: {
        requestedModel: runBinding.actors.requester.model.requestedModel,
        resolvedModel: runBinding.actors.requester.model.resolvedModel,
        requests: [],
        totals: { requests: 0 },
      },
      provenance: structuredClone(runBinding.sharedOs),
      sourceEvidence: {
        requesterFileOperations: [], responderFileOperations: [], acceptedMessages: [], auditEvents,
      },
      audit: {
        firstSequence: 0, lastSequence: auditEvents.length - 1,
        sha256: sha256JsonV1(auditEvents as JsonValue),
      },
    },
  });
  const before = [base.actors.requester.actorId, base.actors.responder.actorId].sort()
    .map(actorId => ({ actorId, sequence: 0, hash: 'a'.repeat(64) }));
  const payload = buildFileWorkflowHeartbeatPayloadV1({
    binding: runBinding,
    sessionId: fixture.event.sessionId,
    heartbeat: { ...fixture.event, inputDigest: fixture.inputDigest },
    native,
    history: { terminalTaskIds: [], contacts: [] },
    terminalOutcomes: [{ taskId: 'PAIR-Q-1', status: 'error',
      errorCode: 'FILE_TURN_FAILED', fullEvaluation: null }],
    sessionStopReason: 'fatal_error',
    worldContext: { before, after: before },
  });
  let store = await openFileWorkflowLedgerV1({ runDirectory: root, binding: runBinding, retainPrivate: true });
  try {
    await store.beginHeartbeat({ event: payload.event, inputDigest: payload.inputDigest });
    const fabricated = structuredClone(payload);
    const requester = fabricated.worldContext!.after.find(value => value.actorId === base.actors.requester.actorId)!;
    requester.sequence = 3;
    requester.hash = 'b'.repeat(64);
    await assert.rejects(store.commitHeartbeat(fabricated), /denied.*context|context.*denied/i);
    const committed = await store.commitHeartbeat(payload);
    assert.equal(committed.outcome, 'committed');
    assert.equal(committed.record.payload.sessionStopReason, 'fatal_error');
    assert.ok('worldContext' in committed.record.payload);
    assert.deepEqual(committed.record.payload.worldContext, { before, after: before });
    await store.close();
    store = await openFileWorkflowLedgerV1({ runDirectory: root, binding: runBinding, retainPrivate: true });
    assert.deepEqual(await store.readRecords(), [committed.record]);
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
