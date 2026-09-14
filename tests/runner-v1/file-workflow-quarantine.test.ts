import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  openFileWorkflowLedgerV1,
} from '../../src/runner/v1/file-workflow-ledger.js';
import {
  binding,
  finalFilesFor,
  heartbeatPayloadFor,
} from './file-workflow-test-fixtures.js';
import { pairStore } from './file-workflow-test-fixtures.js';

test('quarantine seals the dangling heartbeat as a typed terminal error and finalizes', async t => {
  const root = await temporaryRoot(t, 'quarantine-seal');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-single', 'quarantine-seal', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: true,
  });
  const payload = heartbeatPayloadFor(runBinding, 1, []);
  const begin = await store.beginHeartbeat({
    event: structuredClone(payload.event),
    inputDigest: payload.inputDigest,
  });
  assert.equal(begin.kind, 'execute');

  const sealed = await store.commitQuarantine();
  assert.equal(sealed.outcome, 'committed');
  assert.equal(sealed.record.sequence, 0);
  const sealedPayload = sealed.record.payload as Record<string, any>;
  assert.deepEqual(sealedPayload.quarantine, {
    errorCode: 'INDETERMINATE_EXTERNAL_OPERATION',
  });
  assert.equal(sealedPayload.sessionStopReason, 'fatal_error');
  assert.deepEqual(sealedPayload.event, payload.event);

  const results = await jsonLines(join(runDirectory, 'results.jsonl'));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.taskId, 'PAIR-Q-1');
  assert.equal(results[0]!.status, 'error');
  assert.equal(results[0]!.errorCode, 'INDETERMINATE_EXTERNAL_OPERATION');
  assert.equal(results[0]!.publicEvaluation, null);
  const summary = await json(join(runDirectory, 'summary.json'));
  assert.equal(summary.statuses.error, 1);
  assert.equal(summary.usage.modelCalls, 0);
  assert.equal(summary.usage.costUsd, 0);

  await store.finalize({
    stopReason: 'fatal_error',
    finalFiles: finalFilesFor(runBinding, 0),
  });
  const checkpoint = await json(join(runDirectory, 'checkpoint.json'));
  assert.equal(checkpoint.status, 'completed');
  await assert.rejects(
    () => store.beginHeartbeat({
      event: { ...structuredClone(payload.event), eventId: 'event-2', traceId: 'trace-2', tick: 2 },
      inputDigest: payload.inputDigest,
    }),
    /Completed file-workflow ledger cannot begin another heartbeat/,
  );
  await store.close();

  // The quarantined history reopens clean, replays the same record authority,
  // and never exposes another executable heartbeat.
  const reopened = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: true,
  });
  assert.deepEqual(await reopened.inspectRecovery(), { kind: 'clear' });
  const records = await reopened.readRecords();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], sealed.record);
  await reopened.close();
});

test('quarantine requires exactly one unresolved heartbeat start marker', async t => {
  const root = await temporaryRoot(t, 'quarantine-marker-required');
  const runBinding = binding('files-single', 'quarantine-marker-required', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  await assert.rejects(
    () => store.commitQuarantine(),
    /Quarantine requires exactly one unresolved heartbeat start marker/,
  );
  await store.close();
});

test('quarantine refuses stopped run authority and never commits twice', async t => {
  const root = await temporaryRoot(t, 'quarantine-once');
  const runBinding = binding('files-single', 'quarantine-once', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  const payload = heartbeatPayloadFor(runBinding, 1, []);
  await store.beginHeartbeat({
    event: structuredClone(payload.event),
    inputDigest: payload.inputDigest,
  });
  await store.commitQuarantine();
  await assert.rejects(
    () => store.commitQuarantine(),
    /Stopped file-workflow ledger cannot quarantine a heartbeat/,
  );
  await store.close();
});

test('quarantine keeps committed prior terminal authority and seals only the rest', async t => {
  const root = await temporaryRoot(t, 'quarantine-partial');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'quarantine-partial', ['PAIR-Q-1', 'PAIR-Q-2']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: true,
  });
  // Tick 1 commits with no terminal transitions; both tasks stay pending.
  const first = heartbeatPayloadFor(runBinding, 1, []);
  await store.beginHeartbeat({
    event: structuredClone(first.event),
    inputDigest: first.inputDigest,
  });
  await store.commitHeartbeat(first);
  const second = heartbeatPayloadFor(runBinding, 2, []);
  await store.beginHeartbeat({
    event: structuredClone(second.event),
    inputDigest: second.inputDigest,
  });
  const sealed = await store.commitQuarantine();
  assert.equal(sealed.record.sequence, 1);
  const results = await jsonLines(join(runDirectory, 'results.jsonl'));
  assert.deepEqual(
    results.map(row => [row.taskId, row.status, row.errorCode, row.terminalTick]),
    [
      ['PAIR-Q-1', 'error', 'INDETERMINATE_EXTERNAL_OPERATION', 2],
      ['PAIR-Q-2', 'error', 'INDETERMINATE_EXTERNAL_OPERATION', 2],
    ],
  );
  await store.close();
});

test('quarantine refuses to relabel committed changed-action contact authority', async t => {
  const root = await temporaryRoot(t, 'quarantine-changed-action');
  const runBinding = binding(
    'files-multi',
    'quarantine-changed-action',
    ['PAIR-A-1', 'PAIR-Q-2'],
  );
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  // Tick 1 commits a completed changed-action contact whose task is not yet
  // terminal: the proven side effect must never be sealed as a plain error.
  const before = pairStore('PRIVATE_QUARANTINE_BEFORE');
  const first = heartbeatPayloadFor(runBinding, 1, [], {
    omitSessionStopReason: true,
    contact: {
      taskId: 'PAIR-A-1',
      message: 'PRIVATE_QUARANTINE_CONTACT',
      requestMessageId: 'quarantine-contact',
      status: 'completed' as const,
      response: 'done',
    },
    actionSnapshots: [{
      taskId: 'PAIR-A-1',
      contactId: 'quarantine-contact',
      actorId: 'responder',
      eventId: 'event-1',
      before,
      after: pairStore('PRIVATE_QUARANTINE_AFTER'),
    }],
    tickDecisions: [],
    fullEvaluations: [],
  });
  await store.beginHeartbeat({
    event: structuredClone(first.event),
    inputDigest: first.inputDigest,
  });
  await store.commitHeartbeat(first);
  const second = heartbeatPayloadFor(runBinding, 2, []);
  await store.beginHeartbeat({
    event: structuredClone(second.event),
    inputDigest: second.inputDigest,
  });
  await assert.rejects(
    () => store.commitQuarantine(),
    /Quarantine cannot seal a task with committed changed-action contact authority/,
  );
  await store.close();
});

async function temporaryRoot(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), `sharedeval-ledger-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

async function jsonLines(path: string): Promise<Record<string, any>[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}
