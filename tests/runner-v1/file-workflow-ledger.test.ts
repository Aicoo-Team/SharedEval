import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
  openFileWorkflowLedgerV1,
  type FileWorkflowLedgerFaultInjectionV1,
} from '../../src/runner/v1/file-workflow-ledger.js';
import {
  binding,
  finalFilesFor,
  heartbeatPayloadFor,
  transition,
} from './file-workflow-test-fixtures.js';
import {
  PACT_PAIR_METRIC_NAMES_V1,
  pactPairMetricContributionsV1,
} from '../../src/suites/pact-pair/evaluation.js';
import type {
  PactPairActionEvaluationV1,
  PactPairEvaluationV1,
  PactPairQaEvaluationV1,
} from '../../src/suites/pact-pair/evaluator.js';
import { toPublicEvaluation } from '../../src/suites/pact-pair/environment.js';

const publicNames = [
  'run.json',
  'events.jsonl',
  'results.jsonl',
  'summary.json',
  'checkpoint.json',
] as const;

test('publishes a normal two-tick multi run in selected order with exact cardinality', async t => {
  const root = await temporaryRoot(t, 'normal-multi');
  const runDirectory = join(root, 'run');
  const selected = ['PAIR-Q-1', 'PAIR-A-2'];
  const runBinding = binding('files-multi', 'normal-multi', selected);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: true,
  });

  await store.commitHeartbeat(heartbeatPayloadFor(
    runBinding,
    1,
    [transition('PAIR-Q-1', 'error', 1)],
  ));
  await store.commitHeartbeat(heartbeatPayloadFor(
    runBinding,
    2,
    [transition('PAIR-A-2', 'no_response', 2, 'action')],
  ));
  await store.finalize({
    stopReason: 'tick_exhausted',
    finalFiles: finalFilesFor(runBinding, 2),
  });

  const results = await jsonLines(join(runDirectory, 'results.jsonl'));
  const run = await json(join(runDirectory, 'run.json'));
  const checkpoint = await json(join(runDirectory, 'checkpoint.json'));
  assert.deepEqual(results.map(row => row.taskId), selected);
  assert.deepEqual({
    status: checkpoint.status,
    records: checkpoint.recordCount,
    selected: checkpoint.selectedTasks,
    results: checkpoint.resultRows,
    evaluations: checkpoint.evaluationRows,
  }, {
    status: 'completed', records: 2, selected: 2, results: 2, evaluations: 2,
  });
  assert.deepEqual(run.actors.requester.final, finalFilesFor(runBinding, 2).requester);
  assert.deepEqual(run.actors.responder.final, finalFilesFor(runBinding, 2).responder);
  assert.equal((await jsonLines(join(runDirectory, 'events.jsonl'))).length, 2);
  await store.close();
});

test('keeps two files-single sessions physically and metrically independent', async t => {
  const root = await temporaryRoot(t, 'independent-single');
  for (const [index, taskId] of ['PAIR-Q-1', 'PAIR-Q-2'].entries()) {
    const runId = `single-${index + 1}`;
    const runDirectory = join(root, runId);
    const runBinding = binding('files-single', runId, [taskId]);
    const store = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate: false,
    });
    await store.commitHeartbeat(heartbeatPayloadFor(
      runBinding,
      1,
      [transition(taskId, 'no_response', 1)],
    ));
    await store.finalize({
      stopReason: 'tick_exhausted',
      finalFiles: finalFilesFor(runBinding, 1),
    });
    await store.close();
  }
  const first = await json(join(root, 'single-1', 'run.json'));
  const second = await json(join(root, 'single-2', 'run.json'));
  assert.equal(first.workflowId, 'files-single');
  assert.equal(second.workflowId, 'files-single');
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.selectedTaskDigest, second.selectedTaskDigest);
});

test('identical replay repairs projections while a distinct task authority fails before overwrite', async t => {
  const root = await temporaryRoot(t, 'replay');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'replay-run', ['PAIR-Q-1']);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  assert.equal((await store.commitHeartbeat(payload)).outcome, 'committed');
  await rm(join(runDirectory, 'results.jsonl'));
  assert.equal((await store.commitHeartbeat(payload)).outcome, 'replayed');
  assert.equal((await jsonLines(join(runDirectory, 'results.jsonl'))).length, 1);

  const conflict = heartbeatPayloadFor(runBinding, 2, [
    transition('PAIR-Q-1', 'no_response', 2),
  ]);
  await assert.rejects(() => store.commitHeartbeat(conflict), /terminal authority|conflict/i);
  const rows = await jsonLines(join(runDirectory, 'results.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'error');
  await store.close();
});

test('rejects a same-result duplicate published under a different heartbeat identity', async t => {
  const root = await temporaryRoot(t, 'duplicate-event-authority');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'duplicate-event-authority', ['PAIR-Q-1']);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  await store.commitHeartbeat(payload);
  const foreignDuplicate = structuredClone(payload);
  foreignDuplicate.event.eventId = 'event-distinct';
  foreignDuplicate.event.traceId = 'trace-distinct';
  await assert.rejects(
    () => store.commitHeartbeat(foreignDuplicate),
    /terminal authority|heartbeat|duplicate|conflict/i,
  );
  assert.equal((await store.readRecords()).length, 1);
  await store.close();
});

test('repairs every crash boundary after private commit before public projection', async t => {
  for (const artifact of publicNames) {
    const root = await temporaryRoot(t, `crash-${artifact}`);
    const runDirectory = join(root, 'run');
    let injected = false;
    const faults: FileWorkflowLedgerFaultInjectionV1 = {
      beforePublicArtifactForTest(name) {
        if (!injected && name === artifact) {
          injected = true;
          throw new Error(`crash-before-${artifact}`);
        }
      },
    };
    const options = {
      runDirectory,
      binding: binding('files-multi', `crash-${artifact.replace(/\W/g, '-')}`, ['PAIR-Q-1']),
      retainPrivate: true,
    } as const;
    const first = await openFileWorkflowLedgerV1({ ...options, faults });
    const payload = heartbeatPayloadFor(
      options.binding,
      1,
      [transition('PAIR-Q-1', 'error', 1)],
    );
    await assert.rejects(() => first.commitHeartbeat(payload), new RegExp(`crash-before-${artifact}`));
    assert.equal((await first.readRecords()).length, 1, 'private ledger authority must commit first');
    await first.close();

    const resumed = await openFileWorkflowLedgerV1(options);
    await resumed.repairPublicProjections();
    await resumed.finalize({
      stopReason: 'all_terminal',
      finalFiles: finalFilesFor(options.binding, 1),
    });
    for (const name of publicNames) {
      assert.equal((await lstat(join(runDirectory, name))).isFile(), true);
    }
    assert.equal((await jsonLines(join(runDirectory, 'results.jsonl'))).length, 1);
    await resumed.close();
  }
});

test('publishes the immutable run binding only after a durable stage is complete', async t => {
  const root = await temporaryRoot(t, 'binding-stage-crash');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'binding-stage-crash', ['PAIR-Q-1']);
  let injected = false;
  const faults = {
    beforeImmutableAuthorityPublicationForTest(name: string) {
      if (!injected && name === 'binding.json') {
        injected = true;
        throw new Error('crash-before-binding-publication');
      }
    },
  } as unknown as FileWorkflowLedgerFaultInjectionV1;
  await assert.rejects(
    () => openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate: false,
      faults,
    }),
    /crash-before-binding-publication/,
    'BINDING_TARGET_WAS_WRITTEN_DIRECTLY_WITHOUT_STAGING',
  );
  await assert.rejects(
    () => lstat(join(runDirectory, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'binding.json')),
    { code: 'ENOENT' },
  );
  const tornAuthorityStage = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'immutable-authority-stage-00000000-0000-4000-8000-000000000000.json',
  );
  await writeFile(tornAuthorityStage, '{"torn":');

  const resumed = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  await assert.rejects(() => lstat(tornAuthorityStage), { code: 'ENOENT' });
  await resumed.close();
});

test('publishes final authority only after a durable stage is complete', async t => {
  const root = await temporaryRoot(t, 'final-stage-crash');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'final-stage-crash', ['PAIR-Q-1']);
  let injected = false;
  const faults = {
    beforeImmutableAuthorityPublicationForTest(name: string) {
      if (!injected && name === 'final.json') {
        injected = true;
        throw new Error('crash-before-final-publication');
      }
    },
  } as unknown as FileWorkflowLedgerFaultInjectionV1;
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
    faults,
  });
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'no_response', 1),
  ]));
  await assert.rejects(
    () => store.finalize({
      stopReason: 'tick_exhausted',
      finalFiles: finalFilesFor(runBinding, 1),
    }),
    /crash-before-final-publication/,
    'FINAL_TARGET_WAS_WRITTEN_DIRECTLY_WITHOUT_STAGING',
  );
  await assert.rejects(
    () => lstat(join(runDirectory, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'final.json')),
    { code: 'ENOENT' },
  );
  await store.close();

  const resumed = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  await resumed.finalize({
    stopReason: 'tick_exhausted',
    finalFiles: finalFilesFor(runBinding, 1),
  });
  await resumed.close();
});

test('rejects a non-linear MEMORY CAS chain before committing another heartbeat', async t => {
  const root = await temporaryRoot(t, 'memory-chain');
  const runDirectory = join(root, 'run');
  const runBinding = binding(
    'files-multi',
    'memory-chain',
    ['PAIR-Q-1', 'PAIR-Q-2'],
  );
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));

  const stale = heartbeatPayloadFor(runBinding, 2, [
    transition('PAIR-Q-2', 'error', 2),
  ]);
  stale.memoryTransition!.previousSha256 = 'f'.repeat(64);
  await assert.rejects(
    () => store.commitHeartbeat(stale),
    /MEMORY.*(chain|previous|hash|CAS)/i,
  );
  assert.equal((await store.readRecords()).length, 1);
  await store.close();
});

test('binds monotonic MEMORY rows to contact-derived terminal transitions', async t => {
  const root = await temporaryRoot(t, 'memory-terminal-semantics');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const regressionBinding = binding(
      'files-multi',
      `memory-regression-${mode}`,
      ['PAIR-Q-1'],
    );
    const regressionStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `regression-${mode}`),
      binding: regressionBinding,
      retainPrivate,
    });
    const first = heartbeatPayloadFor(regressionBinding, 1, []);
    setRequesterMemoryEvidence(
      first,
      'PAIR-Q-1 [pending] — memory 0\n',
      'PAIR-Q-1 [answered] — terminal\n',
    );
    await regressionStore.commitHeartbeat(first);
    const second = heartbeatPayloadFor(regressionBinding, 2, []);
    setRequesterMemoryEvidence(
      second,
      'PAIR-Q-1 [answered] — terminal\n',
      'PAIR-Q-1 [pending] — regressed\n',
    );
    await assert.rejects(
      () => regressionStore.commitHeartbeat(second),
      /MEMORY|terminal|regress|monotonic/i,
      'ACCEPTED_TERMINAL_MEMORY_REGRESSION',
    );
    await regressionStore.close();

    const pendingBinding = binding(
      'files-multi',
      `pending-answered-${mode}`,
      ['PAIR-Q-1'],
    );
    const pending = heartbeatPayloadFor(pendingBinding, 1, [
      evaluatedQaTransition('PAIR-Q-1', 1),
    ], qaContactEvidence('completed'));
    pending.transitions[0]!.contactId = 'recipient-trace';
    pending.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(pending, pendingBinding);
    setRequesterMemoryEvidence(
      pending,
      'PAIR-Q-1 [pending] — before\n',
      'PAIR-Q-1 [pending] — still pending\n',
    );
    const pendingStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `pending-${mode}`),
      binding: pendingBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => pendingStore.commitHeartbeat(pending),
      /MEMORY|pending|answered|transition|contact/i,
      'ACCEPTED_ANSWERED_TRANSITION_WITH_PENDING_MEMORY',
    );
    await pendingStore.close();

    const mismatchBinding = binding(
      'files-multi',
      `denied-mismatch-${mode}`,
      ['PAIR-Q-1'],
    );
    const mismatch = heartbeatPayloadFor(mismatchBinding, 1, [
      evaluatedQaTransition('PAIR-Q-1', 1, 'refused'),
    ], qaContactEvidence('denied'));
    mismatch.transitions[0]!.contactId = 'recipient-trace';
    mismatch.transitions[0]!.result.contactStatus = 'denied';
    addResponderFileReads(mismatch, mismatchBinding);
    setRequesterMemoryEvidence(
      mismatch,
      'PAIR-Q-1 [pending] — before\n',
      'PAIR-Q-1 [answered] — mismatched\n',
    );
    const mismatchStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `mismatch-${mode}`),
      binding: mismatchBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => mismatchStore.commitHeartbeat(mismatch),
      /MEMORY|contact|refused|answered|transition/i,
      'ACCEPTED_MEMORY_STATUS_MISMATCH_WITH_DENIED_CONTACT',
    );
    await mismatchStore.close();
  }
});

test('accepts later-tick immutable reads at the current workspace version', async t => {
  const root = await temporaryRoot(t, 'current-version-file-reads');
  const runBinding = binding('files-multi', 'current-version-file-reads', [
    'PAIR-Q-1',
    'PAIR-Q-2',
  ]);
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: false,
  });
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  const second = heartbeatPayloadFor(runBinding, 2, [
    transition('PAIR-Q-2', 'error', 2),
  ]);
  for (const receipt of second.fileReads) receipt.version = 1;
  await assert.doesNotReject(
    () => store.commitHeartbeat(second),
    'REJECTED_CURRENT_VERSION_IMMUTABLE_FILE_READS',
  );
  await store.close();
});

test('accepts valid requester and responder reads after a same-turn CAS', async t => {
  const root = await temporaryRoot(t, 'post-cas-reads');

  const requesterBinding = binding(
    'files-multi',
    'requester-post-cas-read',
    ['PAIR-Q-1'],
  );
  const requesterPayload = heartbeatPayloadFor(requesterBinding, 1, []);
  requesterPayload.fileReads = requesterPayload.fileReads.filter(
    (receipt: { actorId: string; path: string }) => (
      receipt.actorId !== requesterBinding.actors.requester.actorId
      || receipt.path === 'MEMORY.md'
    ),
  );
  for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md'] as const) {
    const metadata = requesterBinding.actors.requester.initial[path];
    requesterPayload.fileReads.push({
      actorId: requesterBinding.actors.requester.actorId,
      path,
      action: 'read',
      version: 1,
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
    });
  }
  const requesterStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'requester'),
    binding: requesterBinding,
    retainPrivate: false,
  });
  await assert.doesNotReject(
    () => requesterStore.commitHeartbeat(requesterPayload),
    'REJECTED_VALID_REQUESTER_POST_CAS_READ',
  );
  await requesterStore.close();

  const responderBinding = binding(
    'files-multi',
    'responder-post-cas-read',
    ['PAIR-Q-1'],
  );
  const responderPayload = heartbeatPayloadFor(
    responderBinding,
    1,
    [],
    qaContactEvidence('completed'),
  );
  responderPayload.privateEvidence.fullEvaluations = [];
  addResponderFileReads(responderPayload, responderBinding);
  responderPayload.fileReads = responderPayload.fileReads.filter(
    (receipt: { actorId: string; path: string }) => (
      receipt.actorId !== responderBinding.actors.responder.actorId
      || receipt.path === 'MEMORY.md'
    ),
  );
  for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md'] as const) {
    const metadata = responderBinding.actors.responder.initial[path];
    responderPayload.fileReads.push({
      actorId: responderBinding.actors.responder.actorId,
      path,
      action: 'read',
      version: 1,
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
    });
  }
  const responderStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'responder'),
    binding: responderBinding,
    retainPrivate: false,
  });
  await assert.doesNotReject(
    () => responderStore.commitHeartbeat(responderPayload),
    'REJECTED_VALID_RESPONDER_POST_CAS_READ',
  );
  await responderStore.close();
});

test('rejects incomplete contact read coverage and responder version gaps', async t => {
  const root = await temporaryRoot(t, 'incoherent-contact-reads');
  const runBinding = binding('files-multi', 'incoherent-contact-reads', ['PAIR-Q-1']);

  const requesterPayload = heartbeatPayloadFor(
    runBinding,
    1,
    [],
    qaContactEvidence('completed'),
  );
  requesterPayload.privateEvidence.fullEvaluations = [];
  addResponderFileReads(requesterPayload, runBinding);
  requesterPayload.fileReads = requesterPayload.fileReads.filter(
    (receipt: { actorId: string; path: string }) => !(
      receipt.actorId === runBinding.actors.requester.actorId
      && receipt.path === 'POLICY.md'
    ),
  );
  const requesterStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'requester'),
    binding: runBinding,
    retainPrivate: false,
  });
  await assert.rejects(
    () => requesterStore.commitHeartbeat(requesterPayload),
    /complete|coverage|four-file|path/i,
    'ACCEPTED_REQUESTER_CONTACT_WITHOUT_POLICY_READ',
  );
  await requesterStore.close();

  const responderPayload = heartbeatPayloadFor(
    runBinding,
    1,
    [],
    qaContactEvidence('completed'),
  );
  responderPayload.privateEvidence.fullEvaluations = [];
  addResponderFileReads(responderPayload, runBinding);
  const responderAgent = runBinding.actors.responder.initial['AGENT.md'];
  responderPayload.fileReads.push({
    actorId: runBinding.actors.responder.actorId,
    path: 'AGENT.md',
    action: 'read',
    version: 2,
    sha256: responderAgent.sha256,
    byteLength: responderAgent.byteLength,
  });
  const responderStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'responder'),
    binding: runBinding,
    retainPrivate: false,
  });
  await assert.rejects(
    () => responderStore.commitHeartbeat(responderPayload),
    /responder|version|gap|coherent/i,
    'ACCEPTED_RESPONDER_CONTACT_READ_VERSION_GAP',
  );
  await responderStore.close();
});

test('rejects a same-version requester MEMORY transition before publication', async t => {
  const root = await temporaryRoot(t, 'same-version-memory');
  const runBinding = binding('files-multi', 'same-version-memory', ['PAIR-Q-1']);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]);
  payload.memoryTransition = {
    ...payload.memoryTransition!,
    newVersion: 0,
    newSha256: payload.memoryTransition!.previousSha256,
    byteLength: runBinding.actors.requester.initial['MEMORY.md'].byteLength,
  };
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: false,
  });
  await assert.rejects(
    () => store.commitHeartbeat(payload),
    /MEMORY|version|advance|exact/i,
    'ACCEPTED_SAME_VERSION_MEMORY_TRANSITION',
  );
  assert.equal((await store.readRecords()).length, 0);
  await store.close();
});

test('allows a new contact for task B while terminalizing prior contacted task A', async t => {
  const root = await temporaryRoot(t, 'contact-b-terminal-a');
  const runBinding = binding('files-multi', 'contact-b-terminal-a', [
    'PAIR-A-1',
    'PAIR-A-2',
  ]);
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  const evidenceA = strictActionEvidence('PAIR-A-1', 'event-1');
  evidenceA.contactRequests[0]!.recipientTraceId = 'contact-a';
  evidenceA.actionSnapshots[0]!.contactId = 'contact-a';
  evidenceA.fullEvaluations = [];
  const contactA = heartbeatPayloadFor(runBinding, 1, [], evidenceA);
  contactA.selectedTaskId = 'PAIR-A-1';
  addResponderFileReads(contactA, runBinding);
  await store.commitHeartbeat(contactA);

  const evidenceB = strictActionEvidence('PAIR-A-2', 'event-2');
  evidenceB.contactRequests[0]!.recipientTraceId = 'contact-b';
  evidenceB.actionSnapshots[0]!.contactId = 'contact-b';
  evidenceB.fullEvaluations = strictActionEvidence(
    'PAIR-A-1',
    'event-2',
  ).fullEvaluations;
  const reconcile = heartbeatPayloadFor(runBinding, 2, [
    evaluatedActionTransition('PAIR-A-1', 2),
  ], evidenceB);
  reconcile.selectedTaskId = 'PAIR-A-2';
  reconcile.transitions[0]!.contactId = 'contact-a';
  reconcile.transitions[0]!.result.contactStatus = 'completed';
  addResponderFileReads(reconcile, runBinding);
  await assert.doesNotReject(
    () => store.commitHeartbeat(reconcile),
    'REJECTED_CONTACT_B_WHILE_TERMINALIZING_PRIOR_A',
  );
  assert.equal((await store.readRecords()).length, 2);
  await store.close();
});

test('requires responder provenance and contact usage for completed contact authority', async t => {
  const root = await temporaryRoot(t, 'contact-provenance-usage');
  const runBinding = binding('files-multi', 'contact-provenance-usage', ['PAIR-Q-1']);
  for (const violation of ['provider', 'usage'] as const) {
    const payload = heartbeatPayloadFor(runBinding, 1, [
      evaluatedQaTransition('PAIR-Q-1', 1),
    ], qaContactEvidence('completed'));
    payload.transitions[0]!.contactId = 'recipient-trace';
    payload.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(payload, runBinding);
    if (violation === 'provider') delete payload.provider.responder;
    else payload.usage.contactCalls = 0;
    const store = await openFileWorkflowLedgerV1({
      runDirectory: join(root, violation),
      binding: runBinding,
      retainPrivate: false,
    });
    await assert.rejects(
      () => store.commitHeartbeat(payload),
      /responder|provider|contact.*usage|contact.*call/i,
      `ACCEPTED_CONTACT_WITHOUT_${violation.toUpperCase()}`,
    );
    await store.close();
  }
});

test('binds contact request traces and retains the Task6 responder-read failure code', async t => {
  const root = await temporaryRoot(t, 'contact-request-trace');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const runBinding = binding(
      'files-multi',
      `contact-request-trace-${mode}`,
      ['PAIR-Q-1'],
    );
    const evidence = {
      contactRequests: [{
        taskId: 'PAIR-Q-1',
        senderId: 'requester',
        recipientId: 'responder',
        purpose: 'PAIR-Q-1',
        intent: 'answer',
        message: 'contact',
        requestTraceId: 'trace-1',
        deadlineMs: 1_000,
        recipientTraceId: 'recipient-trace',
        status: 'failed' as const,
        errorCode: 'CONTACT_RESPONDER_FILE_READ_REQUIRED',
      }],
      actionSnapshots: [],
      tickDecisions: [],
      fullEvaluations: [],
    };
    const runDirectory = join(root, `valid-${mode}`);
    const store = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate,
    });
    await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [], evidence));
    await store.close();
    const reopened = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate,
    });
    const [record] = await reopened.readRecords();
    assert.equal(record?.payload.contactAuthority?.status, 'failed');
    assert.equal(
      record?.payload.contactAuthority?.errorCode,
      'CONTACT_RESPONDER_FILE_READ_REQUIRED',
      'retention-safe contact authority must preserve the stable failure code',
    );
    if (retainPrivate) {
      const retainedContact = record?.payload.privateEvidence?.contactRequests[0];
      assert.equal(retainedContact?.status, 'failed');
      assert.equal(
        retainedContact?.status === 'failed' ? retainedContact.errorCode : undefined,
        'CONTACT_RESPONDER_FILE_READ_REQUIRED',
      );
    }
    await reopened.close();

    const forged = heartbeatPayloadFor(runBinding, 1, [], {
      ...evidence,
      contactRequests: [{
        ...evidence.contactRequests[0]!,
        requestTraceId: 'foreign-trace',
      }],
    });
    const invalidStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `forged-${mode}`),
      binding: runBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => invalidStore.commitHeartbeat(forged),
      /contact|trace|provenance/i,
      'ACCEPTED_CONTACT_WITH_FOREIGN_REQUEST_TRACE',
    );
    await invalidStore.close();
  }
});

test('requires source MEMORY bytes for each caller CAS and rejects digest-only evidence', async t => {
  const root = await temporaryRoot(t, 'memory-source-evidence');
  const runBinding = binding('files-multi', 'memory-source-evidence', ['PAIR-Q-1']);
  for (const violation of ['missing-bytes', 'digest-only', 'missing-memory-member'] as const) {
    const payload = heartbeatPayloadFor(runBinding, 1, [
      transition('PAIR-Q-1', 'error', 1),
    ]);
    if (violation === 'missing-memory-member') {
      delete payload.privateEvidence.memory;
    } else {
      delete payload.privateEvidence;
      if (violation === 'digest-only') payload.privateEvidenceDigest = 'f'.repeat(64);
    }
    const store = await openFileWorkflowLedgerV1({
      runDirectory: join(root, violation),
      binding: runBinding,
      retainPrivate: false,
    });
    await assert.rejects(
      () => store.commitHeartbeat(payload),
      /MEMORY|private|source|digest.*bytes|evidence/i,
      `ACCEPTED_${violation.toUpperCase().replace('-', '_')}_MEMORY_EVIDENCE`,
    );
    await store.close();
  }
});

test('requires the validated private evidence digest after retention-off stripping', async t => {
  const root = await temporaryRoot(t, 'memory-private-digest');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'memory-private-digest', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await store.close();

  const recordPath = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'records',
    'record-000000000000.json',
  );
  const edited = await json(recordPath);
  delete edited.payload.privateEvidenceDigest;
  edited.recordDigest = digestRecordMaterial(edited);
  await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
  await assert.rejects(
    () => openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate: false,
    }),
    /private.*digest|MEMORY.*evidence|ledger record/i,
    'REOPENED_RETENTION_OFF_MEMORY_WITHOUT_PRIVATE_DIGEST',
  );
});

test('re-derives sanitized MEMORY authority from retained source bytes on reopen', async t => {
  const root = await temporaryRoot(t, 'retained-memory-authority');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'retained-memory-authority', ['PAIR-Q-1']);
  const options = { runDirectory, binding: runBinding, retainPrivate: true } as const;
  const store = await openFileWorkflowLedgerV1(options);
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await store.close();

  const recordPath = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'records',
    'record-000000000000.json',
  );
  const edited = await json(recordPath);
  edited.payload.memoryAuthority.newRows[0].status = 'answered';
  edited.recordDigest = digestRecordMaterial(edited);
  await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
  await assert.rejects(
    () => openFileWorkflowLedgerV1(options),
    /MEMORY|authority|private|source bytes/i,
    'ACCEPTED_MEMORY_AUTHORITY_PRIVATE_BYTES_MISMATCH',
  );
});

test('parses private MEMORY bytes as bounded strict UTF-8 canonical selected rows', async t => {
  const root = await temporaryRoot(t, 'strict-private-memory');
  const runBinding = binding('files-multi', 'strict-private-memory', ['PAIR-Q-1']);
  for (const [name, nextBytes] of [
    ['malformed-row', Buffer.from('not a canonical MEMORY row')],
    ['invalid-utf8', Buffer.from([0xc3, 0x28])],
  ] as const) {
    const payload = heartbeatPayloadFor(runBinding, 1, [
      transition('PAIR-Q-1', 'error', 1),
    ]);
    const previousBytesBase64 = payload.privateEvidence?.memory?.previousBytesBase64
      ?? Buffer.from('requester-memory').toString('base64');
    payload.privateEvidence = payload.privateEvidence ?? emptyPrivateEvidence();
    payload.privateEvidence.memory = {
      actorId: 'requester',
      previousBytesBase64,
      newBytesBase64: nextBytes.toString('base64'),
    };
    payload.memoryTransition!.newSha256 = createHash('sha256').update(nextBytes).digest('hex');
    payload.memoryTransition!.byteLength = nextBytes.byteLength;
    const store = await openFileWorkflowLedgerV1({
      runDirectory: join(root, name),
      binding: runBinding,
      retainPrivate: false,
    });
    await assert.rejects(
      () => store.commitHeartbeat(payload),
      /MEMORY|UTF-8|canonical|row/i,
      `ACCEPTED_${name.toUpperCase().replace('-', '_')}_MEMORY`,
    );
    await store.close();
  }
});

test('finalize binds stop reason to the committed terminal status set', async t => {
  const root = await temporaryRoot(t, 'stop-reason-binding');
  for (const [name, status, stopReason] of [
    ['all-terminal-no-response', 'no_response', 'all_terminal'],
    ['tick-exhausted-without-no-response', 'error', 'tick_exhausted'],
    ['fatal-without-error', 'no_response', 'fatal_error'],
  ] as const) {
    const runBinding = binding('files-multi', `stop-${name}`, ['PAIR-Q-1']);
    const store = await openFileWorkflowLedgerV1({
      runDirectory: join(root, name),
      binding: runBinding,
      retainPrivate: false,
    });
    await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
      transition('PAIR-Q-1', status, 1),
    ]));
    await assert.rejects(
      () => store.finalize({
        stopReason,
        finalFiles: finalFilesFor(runBinding, 1),
      }),
      /stop|reason|no_response|fatal|error|terminal/i,
      `ACCEPTED_INVALID_STOP_REASON_${name.toUpperCase().replaceAll('-', '_')}`,
    );
    await store.close();
  }

  const mixedBinding = binding(
    'files-multi',
    'stop-fatal-mixed-no-response',
    ['PAIR-Q-1', 'PAIR-Q-2'],
  );
  const mixed = heartbeatPayloadFor(mixedBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
    transition('PAIR-Q-2', 'no_response', 1),
  ]);
  delete mixed.memoryTransition;
  delete mixed.privateEvidence.memory;
  const mixedStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'fatal-mixed-no-response'),
    binding: mixedBinding,
    retainPrivate: false,
  });
  await mixedStore.commitHeartbeat(mixed);
  await assert.rejects(
    () => mixedStore.finalize({
      stopReason: 'fatal_error',
      finalFiles: finalFilesFor(mixedBinding, 0),
    }),
    /fatal|no_response|stop|reason/i,
    'ACCEPTED_FATAL_ERROR_WITH_NO_RESPONSE',
  );
  await mixedStore.close();
});

test('binds immutable file-read receipts and private evidence to the run actors and tasks', async t => {
  const root = await temporaryRoot(t, 'evidence-binding');

  const readBinding = binding('files-multi', 'foreign-read', ['PAIR-Q-1']);
  const readStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'foreign-read'),
    binding: readBinding,
    retainPrivate: false,
  });
  const foreignRead = heartbeatPayloadFor(readBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]);
  foreignRead.fileReads[0]!.sha256 = 'f'.repeat(64);
  await assert.rejects(
    () => readStore.commitHeartbeat(foreignRead),
    /file-read|AGENT|hash|binding/i,
  );
  assert.equal((await readStore.readRecords()).length, 0);
  await readStore.close();

  const privateBinding = binding('files-multi', 'foreign-private', ['PAIR-Q-1']);
  const privateStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'foreign-private'),
    binding: privateBinding,
    retainPrivate: false,
  });
  const foreignPrivate = heartbeatPayloadFor(privateBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ], {
    contactRequests: [{
      taskId: 'PAIR-Q-FOREIGN',
      senderId: 'requester',
      recipientId: 'responder',
      purpose: 'PAIR-Q-FOREIGN',
      intent: 'inspect',
      message: 'private',
      recipientTraceId: 'recipient-trace',
      status: 'completed',
      response: 'private',
    }],
    actionSnapshots: [],
    tickDecisions: [],
    fullEvaluations: [],
  });
  await assert.rejects(
    () => privateStore.commitHeartbeat(foreignPrivate),
    /private|contact|task|binding/i,
  );
  assert.equal((await privateStore.readRecords()).length, 0);
  await privateStore.close();

  const memoryBinding = binding('files-multi', 'foreign-memory', ['PAIR-Q-1']);
  const memoryStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'foreign-memory'),
    binding: memoryBinding,
    retainPrivate: true,
  });
  const foreignMemory = heartbeatPayloadFor(memoryBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ], {
    contactRequests: [],
    memory: {
      actorId: 'requester',
      previousBytesBase64: Buffer.from('FORGED_PREVIOUS').toString('base64'),
      newBytesBase64: Buffer.from('FORGED_NEW').toString('base64'),
    },
    actionSnapshots: [],
    tickDecisions: [],
    fullEvaluations: [],
  });
  await assert.rejects(
    () => memoryStore.commitHeartbeat(foreignMemory),
    /private MEMORY|hash|byte|canonical|row/i,
  );
  assert.equal((await memoryStore.readRecords()).length, 0);
  await memoryStore.close();
});

test('binds an action result to its own private before/after snapshots', async t => {
  const root = await temporaryRoot(t, 'snapshot-binding');
  const runDirectory = join(root, 'run');
  const privateValue = strictActionEvidence('PAIR-A-1', 'event-1');
  const runBinding = binding('files-multi', 'snapshot-binding', ['PAIR-A-1']);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    evaluatedActionTransition('PAIR-A-1', 1),
  ], privateValue);
  payload.transitions[0]!.contactId = 'recipient-trace';
  payload.transitions[0]!.result.contactStatus = 'completed';
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: true,
  });
  await store.commitHeartbeat(payload);
  privateValue.actionSnapshots[0]!.after.description = 'tampered after caller commit';
  const records = await store.readRecords();
  const storedAfter = records[0]?.payload.privateEvidence?.actionSnapshots[0]?.after;
  assert.equal(
    typeof storedAfter === 'object' && storedAfter !== null && !Array.isArray(storedAfter)
      ? storedAfter.description
      : undefined,
    'private test store',
  );
  await store.close();
});

test('rejects a retained contacted action without its authoritative snapshot pair', async t => {
  const root = await temporaryRoot(t, 'missing-action-snapshot');
  const runBinding = binding('files-multi', 'missing-action-snapshot', ['PAIR-A-1']);
  const missingSnapshot = strictActionEvidence('PAIR-A-1', 'event-1');
  missingSnapshot.actionSnapshots = [];
  const payload = heartbeatPayloadFor(runBinding, 1, [
    evaluatedActionTransition('PAIR-A-1', 1),
  ], missingSnapshot);
  payload.transitions[0]!.contactId = 'recipient-trace';
  payload.transitions[0]!.result.contactStatus = 'completed';
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  await assert.rejects(
    () => store.commitHeartbeat(payload),
    /action.*snapshot|snapshot.*action/i,
    'ACCEPTED_ACTION_WITHOUT_SNAPSHOT',
  );
  assert.equal((await store.readRecords()).length, 0);
  await store.close();
});

test('commits a nonterminal action contact snapshot and resolves its later terminal row', async t => {
  const root = await temporaryRoot(t, 'cross-record-action-contact');
  for (const retainPrivate of [true, false]) {
    const runId = `cross-record-action-contact-${retainPrivate ? 'on' : 'off'}`;
    const runDirectory = join(root, retainPrivate ? 'on' : 'off');
    const runBinding = binding('files-multi', runId, ['PAIR-A-1']);
    const contact = heartbeatPayloadFor(runBinding, 1, [], {
      contactRequests: [{
        taskId: 'PAIR-A-1', senderId: 'requester', recipientId: 'responder',
        purpose: 'PAIR-A-1', intent: 'act', message: 'contact',
        recipientTraceId: 'recipient-trace', status: 'completed', response: 'pending',
      }],
      actionSnapshots: [{
        taskId: 'PAIR-A-1',
        contactId: 'recipient-trace',
        actorId: 'responder',
        eventId: 'event-1',
        before: pairStore('before'),
        after: pairStore('after'),
      }],
      tickDecisions: [],
      fullEvaluations: [],
    });
    contact.selectedTaskId = 'PAIR-A-1';
    const first = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate,
    });
    const committed = await first.commitHeartbeat(contact);
    assert.equal(committed.record.payload.contactAuthority?.status, 'completed');
    assert.equal(
      committed.record.payload.privateEvidence !== undefined,
      retainPrivate,
    );
    await first.close();

    const resumed = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate,
    });
    const terminalEvidence = strictActionEvidence('PAIR-A-1', 'event-2');
    terminalEvidence.contactRequests = [];
    terminalEvidence.actionSnapshots = [];
    const terminal = heartbeatPayloadFor(runBinding, 2, [
      evaluatedActionTransition('PAIR-A-1', 2),
    ], terminalEvidence);
    terminal.correlatedContactId = 'recipient-trace';
    terminal.transitions[0]!.contactId = 'recipient-trace';
    terminal.transitions[0]!.result.contactStatus = 'completed';
    await resumed.commitHeartbeat(terminal);
    await resumed.finalize({
      stopReason: 'all_terminal',
      finalFiles: finalFilesFor(runBinding, 2, { 'PAIR-A-1': 'answered' }),
    });
    assert.equal((await resumed.readRecords()).length, 2);
    await resumed.close();
  }
});

test('derives action stateChanged from snapshots and rejects forged evaluation projections', async t => {
  const root = await temporaryRoot(t, 'action-state-forgery');
  for (const retainPrivate of [true, false]) {
    for (const [evidenceChanged, evaluationChanged] of [
      [true, false],
      [false, true],
    ] as const) {
      const mode = `${retainPrivate ? 'on' : 'off'}-${evidenceChanged ? 'changed' : 'unchanged'}`;
      const runBinding = binding('files-multi', `action-state-forgery-${mode}`, ['PAIR-A-1']);
      const evidence = strictActionEvidence('PAIR-A-1', 'event-1', evidenceChanged);
      evidence.fullEvaluations = strictActionEvidence(
        'PAIR-A-1',
        'event-1',
        evaluationChanged,
      ).fullEvaluations;
      const payload = heartbeatPayloadFor(runBinding, 1, [
        evaluatedActionTransition('PAIR-A-1', 1, {
          stateChanged: evaluationChanged,
        }),
      ], evidence);
      payload.transitions[0]!.contactId = 'recipient-trace';
      payload.transitions[0]!.result.contactStatus = 'completed';
      const store = await openFileWorkflowLedgerV1({
        runDirectory: join(root, mode),
        binding: runBinding,
        retainPrivate,
      });
      await assert.rejects(
        () => store.commitHeartbeat(payload),
        /state change|snapshot authority|stateChanged/i,
        'ACCEPTED_FORGED_ACTION_STATE_CHANGE',
      );
      await store.close();
    }
  }
});

test('enforces side-effect fallback semantics across retained and stripped contact history', async t => {
  const root = await temporaryRoot(t, 'action-fallback-state');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const currentBinding = binding(
      'files-multi',
      `action-fallback-current-${mode}`,
      ['PAIR-A-1'],
    );
    const changedEvidence = strictActionEvidence('PAIR-A-1', 'event-1', true);
    changedEvidence.fullEvaluations = [];
    const changedError = heartbeatPayloadFor(currentBinding, 1, [
      transition('PAIR-A-1', 'error', 1, 'action'),
    ], changedEvidence);
    changedError.transitions[0]!.contactId = 'recipient-trace';
    changedError.transitions[0]!.result.contactStatus = 'completed';
    const changedStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `changed-error-${mode}`),
      binding: currentBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => changedStore.commitHeartbeat(changedError),
      /changed action|side_effect_before_failure|fallback/i,
      'ACCEPTED_CHANGED_ACTION_AS_ORDINARY_ERROR',
    );
    await changedStore.close();

    const unchangedBinding = binding(
      'files-multi',
      `action-fallback-unchanged-${mode}`,
      ['PAIR-A-1'],
    );
    const unchangedTransition = evaluatedActionTransition('PAIR-A-1', 1, {
      status: 'side_effect_before_failure',
      stateChanged: false,
    });
    const unchangedEvidence = strictActionEvidence(
      'PAIR-A-1',
      'event-1',
      false,
      'none',
    );
    unchangedEvidence.fullEvaluations[0]!.metrics = structuredClone(
      unchangedTransition.evaluation.metrics,
    );
    const unchangedSideEffect = heartbeatPayloadFor(
      unchangedBinding,
      1,
      [unchangedTransition],
      unchangedEvidence,
    );
    unchangedSideEffect.transitions[0]!.contactId = 'recipient-trace';
    unchangedSideEffect.transitions[0]!.result.contactStatus = 'completed';
    const unchangedStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `unchanged-side-effect-${mode}`),
      binding: unchangedBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => unchangedStore.commitHeartbeat(unchangedSideEffect),
      /side-effect|changed action snapshot|state change/i,
      'ACCEPTED_UNCHANGED_ACTION_AS_SIDE_EFFECT',
    );
    await unchangedStore.close();
  }

  const priorBinding = binding(
    'files-multi',
    'action-fallback-prior-retention-off',
    ['PAIR-A-1'],
  );
  const priorDirectory = join(root, 'prior-retention-off');
  const priorEvidence = strictActionEvidence('PAIR-A-1', 'event-1', true);
  priorEvidence.fullEvaluations = [];
  const priorContact = heartbeatPayloadFor(priorBinding, 1, [], priorEvidence);
  const first = await openFileWorkflowLedgerV1({
    runDirectory: priorDirectory,
    binding: priorBinding,
    retainPrivate: false,
  });
  await first.commitHeartbeat(priorContact);
  await first.close();

  const resumed = await openFileWorkflowLedgerV1({
    runDirectory: priorDirectory,
    binding: priorBinding,
    retainPrivate: false,
  });
  const ordinaryError = heartbeatPayloadFor(priorBinding, 2, [
    transition('PAIR-A-1', 'error', 2, 'action'),
  ]);
  ordinaryError.correlatedContactId = 'recipient-trace';
  ordinaryError.transitions[0]!.contactId = 'recipient-trace';
  ordinaryError.transitions[0]!.result.contactStatus = 'completed';
  await assert.rejects(
    () => resumed.commitHeartbeat(ordinaryError),
    /changed action|side_effect_before_failure|fallback/i,
    'LOST_CHANGED_STATE_AUTHORITY_AFTER_RETENTION_OFF_REOPEN',
  );

  const terminalTransition = evaluatedActionTransition('PAIR-A-1', 2, {
    status: 'side_effect_before_failure',
    stateChanged: true,
  });
  const terminalEvidence = strictActionEvidence(
    'PAIR-A-1',
    'event-2',
    true,
    'none',
  );
  terminalEvidence.contactRequests = [];
  terminalEvidence.actionSnapshots = [];
  terminalEvidence.fullEvaluations[0]!.metrics = structuredClone(
    terminalTransition.evaluation.metrics,
  );
  const sideEffect = heartbeatPayloadFor(
    priorBinding,
    2,
    [terminalTransition],
    terminalEvidence,
  );
  sideEffect.correlatedContactId = 'recipient-trace';
  sideEffect.transitions[0]!.contactId = 'recipient-trace';
  sideEffect.transitions[0]!.result.contactStatus = 'completed';
  await resumed.commitHeartbeat(sideEffect);
  await resumed.finalize({
    stopReason: 'fatal_error',
    finalFiles: finalFilesFor(priorBinding, 2),
  });
  await resumed.close();
});

test('rejects a nonterminal action contact that omits its snapshot immediately', async t => {
  const root = await temporaryRoot(t, 'cross-record-missing-snapshot');
  const runBinding = binding('files-multi', 'cross-record-missing-snapshot', ['PAIR-A-1']);
  const contact = heartbeatPayloadFor(runBinding, 1, [], {
    contactRequests: [{
      taskId: 'PAIR-A-1', senderId: 'requester', recipientId: 'responder',
      purpose: 'PAIR-A-1', intent: 'act', message: 'contact',
      recipientTraceId: 'recipient-trace', status: 'completed', response: 'pending',
    }],
    actionSnapshots: [],
    tickDecisions: [],
    fullEvaluations: [],
  });
  contact.selectedTaskId = 'PAIR-A-1';
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  await assert.rejects(
    () => store.commitHeartbeat(contact),
    /action.*snapshot|snapshot.*action/i,
    'ACCEPTED_NONTERMINAL_ACTION_WITHOUT_SNAPSHOT',
  );
  await store.close();
});

test('rejects orphan/conflicting contact evidence and finalizes a contacted no_response', async t => {
  const root = await temporaryRoot(t, 'cross-record-contact-conflicts');
  const orphanBinding = binding('files-multi', 'orphan-contact-snapshot', ['PAIR-A-1']);
  const orphan = heartbeatPayloadFor(orphanBinding, 1, [], {
    contactRequests: [],
    actionSnapshots: [{
      taskId: 'PAIR-A-1',
      contactId: 'orphan-contact',
      actorId: 'responder',
      eventId: 'event-1',
      before: pairStore('orphan-before'),
      after: pairStore('orphan-after'),
    }],
    tickDecisions: [],
    fullEvaluations: [],
  });
  orphan.selectedTaskId = 'PAIR-A-1';
  const orphanStore = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'orphan'),
    binding: orphanBinding,
    retainPrivate: true,
  });
  await assert.rejects(
    () => orphanStore.commitHeartbeat(orphan),
    /snapshot.*contact|orphan|action contact/i,
  );
  await orphanStore.close();

  const runBinding = binding('files-multi', 'contact-conflict', ['PAIR-A-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'conflict'),
    binding: runBinding,
    retainPrivate: true,
  });
  const first = heartbeatPayloadFor(runBinding, 1, [], actionContactEvidence({
    contactId: 'contact-1',
    eventId: 'event-1',
    status: 'failed',
  }));
  first.selectedTaskId = 'PAIR-A-1';
  await store.commitHeartbeat(first);

  const conflicting = heartbeatPayloadFor(runBinding, 2, [], actionContactEvidence({
    contactId: 'contact-2',
    eventId: 'event-2',
    status: 'failed',
  }));
  conflicting.selectedTaskId = 'PAIR-A-1';
  await assert.rejects(
    () => store.commitHeartbeat(conflicting),
    /duplicate|conflict|contact.*authority/i,
  );

  const statusMismatch = heartbeatPayloadFor(runBinding, 2, [
    transition('PAIR-A-1', 'error', 2, 'action'),
  ]);
  statusMismatch.correlatedContactId = 'contact-1';
  statusMismatch.transitions[0]!.contactId = 'contact-1';
  statusMismatch.transitions[0]!.result.contactStatus = 'completed';
  await assert.rejects(
    () => store.commitHeartbeat(statusMismatch),
    /exact|status|contact.*authority/i,
  );

  const noResponse = heartbeatPayloadFor(runBinding, 2, [
    transition('PAIR-A-1', 'no_response', 2, 'action'),
  ]);
  noResponse.correlatedContactId = 'contact-1';
  noResponse.transitions[0]!.contactId = 'contact-1';
  noResponse.transitions[0]!.result.contactStatus = 'failed';
  await store.commitHeartbeat(noResponse);
  await store.finalize({
    stopReason: 'tick_exhausted',
    finalFiles: finalFilesFor(runBinding, 2),
  });
  await store.close();
});

test('rejects contact status without a correlated ledger contact and snapshot authority', async t => {
  const root = await temporaryRoot(t, 'contact-status-bypass');
  const runBinding = binding('files-multi', 'contact-status-bypass', ['PAIR-A-1']);
  const terminal = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-A-1', 'answered', 1, 'action'),
  ]);
  terminal.transitions[0]!.result.contactStatus = 'completed';
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  await assert.rejects(
    () => store.commitHeartbeat(terminal),
    /contact|correlat|snapshot|authority/i,
    'ACCEPTED_CONTACTED_ACTION_WITHOUT_CORRELATION_OR_SNAPSHOT',
  );
  await store.close();
});

test('rejects terminal statuses that imply contact when all contact authority is omitted', async t => {
  const root = await temporaryRoot(t, 'implied-contact-bypass');
  for (const [status, kind] of [
    ['answered', 'action'],
    ['refused', 'qa'],
    ['side_effect_before_failure', 'action'],
  ] as const) {
    const taskId = kind === 'action' ? 'PAIR-A-1' : 'PAIR-Q-1';
    const runBinding = binding('files-multi', `implied-${status}`, [taskId]);
    const terminal = heartbeatPayloadFor(runBinding, 1, [
      transition(taskId, status, 1, kind),
    ]);
    const store = await openFileWorkflowLedgerV1({
      runDirectory: join(root, status),
      binding: runBinding,
      retainPrivate: false,
    });
    await assert.rejects(
      () => store.commitHeartbeat(terminal),
      /contact|correlat|authority/i,
      `ACCEPTED_${status.toUpperCase()}_WITHOUT_CONTACT`,
    );
    await store.close();
  }
});

test('requires complete requester/responder file-read evidence for authoritative contacts', async t => {
  const root = await temporaryRoot(t, 'contact-read-coverage');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const runBinding = binding('files-multi', `contact-read-coverage-${mode}`, ['PAIR-Q-1']);
    const evidence = qaContactEvidence('completed');
    const missingReads = heartbeatPayloadFor(runBinding, 1, [
      evaluatedQaTransition('PAIR-Q-1', 1),
    ], evidence);
    missingReads.fileReads = [];
    delete missingReads.memoryTransition;
    delete missingReads.privateEvidence.memory;
    missingReads.transitions[0]!.contactId = 'recipient-trace';
    missingReads.transitions[0]!.result.contactStatus = 'completed';
    const invalidStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `commit-${mode}`),
      binding: runBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => invalidStore.commitHeartbeat(missingReads),
      /file.*read|read.*coverage|four.*file/i,
      'ACCEPTED_CONTACT_WITHOUT_FILE_READS',
    );
    await invalidStore.close();

    const validDirectory = join(root, `reopen-${mode}`);
    const validPayload = heartbeatPayloadFor(runBinding, 1, [
      evaluatedQaTransition('PAIR-Q-1', 1),
    ], evidence);
    validPayload.transitions[0]!.contactId = 'recipient-trace';
    validPayload.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(validPayload, runBinding);
    const validStore = await openFileWorkflowLedgerV1({
      runDirectory: validDirectory,
      binding: runBinding,
      retainPrivate,
    });
    await validStore.commitHeartbeat(validPayload);
    await validStore.close();

    const recordPath = join(
      validDirectory,
      FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
      'records',
      'record-000000000000.json',
    );
    const edited = await json(recordPath);
    edited.payload.fileReads = edited.payload.fileReads.filter(
      (receipt: { actorId: string }) => receipt.actorId === 'requester',
    );
    edited.recordDigest = digestRecordMaterial(edited);
    await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
    await assert.rejects(
      () => openFileWorkflowLedgerV1({
        runDirectory: validDirectory,
        binding: runBinding,
        retainPrivate,
      }),
      /file.*read|read.*coverage|four.*file/i,
      'REOPENED_CONTACT_WITHOUT_FILE_READS',
    );
  }
});

test('rejects unevaluated or fake-metric terminal authorities on commit and reopen', async t => {
  const root = await temporaryRoot(t, 'terminal-evaluation-authority');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const runBinding = binding('files-multi', `terminal-evaluation-${mode}`, ['PAIR-Q-1']);
    const evidence = qaContactEvidence('completed');
    const unevaluated = heartbeatPayloadFor(runBinding, 1, [
      transition('PAIR-Q-1', 'answered', 1, 'qa'),
    ], evidence);
    unevaluated.transitions[0]!.contactId = 'recipient-trace';
    unevaluated.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(unevaluated, runBinding);
    const invalidStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `commit-${mode}`),
      binding: runBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => invalidStore.commitHeartbeat(unevaluated),
      /evaluation|metric|answered|scor/i,
      'ACCEPTED_ANSWERED_WITHOUT_EVALUATION',
    );
    await invalidStore.close();

    const validDirectory = join(root, `valid-${mode}`);
    const evaluated = heartbeatPayloadFor(runBinding, 1, [
      evaluatedQaTransition('PAIR-Q-1', 1),
    ], evidence);
    evaluated.transitions[0]!.contactId = 'recipient-trace';
    evaluated.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(evaluated, runBinding);
    const validStore = await openFileWorkflowLedgerV1({
      runDirectory: validDirectory,
      binding: runBinding,
      retainPrivate,
    });
    await validStore.commitHeartbeat(evaluated);
    await validStore.finalize({
      stopReason: 'all_terminal',
      finalFiles: finalFilesFor(runBinding, 1, { 'PAIR-Q-1': 'answered' }),
    });
    await validStore.close();
    const reopened = await openFileWorkflowLedgerV1({
      runDirectory: validDirectory,
      binding: runBinding,
      retainPrivate,
    });
    assert.equal((await reopened.readRecords()).length, 1);
    await reopened.close();

    const tamperedDirectory = join(root, `tampered-${mode}`);
    const tamperedStore = await openFileWorkflowLedgerV1({
      runDirectory: tamperedDirectory,
      binding: runBinding,
      retainPrivate,
    });
    await tamperedStore.commitHeartbeat(evaluated);
    await tamperedStore.close();
    const recordPath = join(
      tamperedDirectory,
      FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
      'records',
      'record-000000000000.json',
    );
    const edited = await json(recordPath);
    edited.payload.transitions[0].evaluation.metrics = [];
    edited.recordDigest = digestRecordMaterial(edited);
    await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
    await assert.rejects(
      () => openFileWorkflowLedgerV1({
        runDirectory: tamperedDirectory,
        binding: runBinding,
        retainPrivate,
      }),
      /evaluation|metric|cardinality|fixed|record|malformed/i,
      'REOPENED_ANSWERED_WITH_FAKE_METRICS',
    );
  }
});

test('validates canonical action snapshots and full evaluations before commit and on reopen', async t => {
  const root = await temporaryRoot(t, 'strict-private-action-evidence');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const runBinding = binding('files-multi', `strict-private-action-${mode}`, ['PAIR-A-1']);
    const invalidEvidence = strictActionEvidence('PAIR-A-1', 'event-1');
    invalidEvidence.actionSnapshots[0]!.before = null as never;
    invalidEvidence.actionSnapshots[0]!.after = null as never;
    const invalidPayload = heartbeatPayloadFor(runBinding, 1, [
      evaluatedActionTransition('PAIR-A-1', 1),
    ], invalidEvidence);
    invalidPayload.transitions[0]!.contactId = 'recipient-trace';
    invalidPayload.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(invalidPayload, runBinding);
    const invalidStore = await openFileWorkflowLedgerV1({
      runDirectory: join(root, `commit-${mode}`),
      binding: runBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => invalidStore.commitHeartbeat(invalidPayload),
      /snapshot|store|object|required/i,
      'ACCEPTED_NULL_ACTION_SNAPSHOT',
    );
    await invalidStore.close();

    const validDirectory = join(root, `valid-${mode}`);
    const validPayload = heartbeatPayloadFor(runBinding, 1, [
      evaluatedActionTransition('PAIR-A-1', 1),
    ], strictActionEvidence('PAIR-A-1', 'event-1'));
    validPayload.transitions[0]!.contactId = 'recipient-trace';
    validPayload.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(validPayload, runBinding);
    const validStore = await openFileWorkflowLedgerV1({
      runDirectory: validDirectory,
      binding: runBinding,
      retainPrivate,
    });
    await validStore.commitHeartbeat(validPayload);
    await validStore.close();
    const reopened = await openFileWorkflowLedgerV1({
      runDirectory: validDirectory,
      binding: runBinding,
      retainPrivate,
    });
    assert.equal((await reopened.readRecords()).length, 1);
    await reopened.close();

    if (retainPrivate) {
      const recordPath = join(
        validDirectory,
        FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
        'records',
        'record-000000000000.json',
      );
      const edited = await json(recordPath);
      edited.payload.privateEvidence.actionSnapshots[0].before = null;
      edited.payload.privateEvidenceDigest = digestTestCanonical(
        edited.payload.privateEvidence,
      );
      edited.recordDigest = digestRecordMaterial(edited);
      await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
      await assert.rejects(
        () => openFileWorkflowLedgerV1({
          runDirectory: validDirectory,
          binding: runBinding,
          retainPrivate,
        }),
        /snapshot|store|object|required|record|malformed/i,
        'REOPENED_NULL_ACTION_SNAPSHOT',
      );
    }
  }
});

test('binds retained full evaluation projections and registered metrics to the terminal row', async t => {
  const root = await temporaryRoot(t, 'full-evaluation-binding');
  for (const retainPrivate of [true, false]) {
    const mode = retainPrivate ? 'on' : 'off';
    const runBinding = binding('files-multi', `full-evaluation-binding-${mode}`, ['PAIR-A-1']);
    const evidence = strictActionEvidence('PAIR-A-1', 'event-1');
    evidence.fullEvaluations[0]!.evaluation.correct = false;
    const payload = heartbeatPayloadFor(runBinding, 1, [
      evaluatedActionTransition('PAIR-A-1', 1),
    ], evidence);
    payload.transitions[0]!.contactId = 'recipient-trace';
    payload.transitions[0]!.result.contactStatus = 'completed';
    addResponderFileReads(payload, runBinding);
    const store = await openFileWorkflowLedgerV1({
      runDirectory: join(root, mode),
      binding: runBinding,
      retainPrivate,
    });
    await assert.rejects(
      () => store.commitHeartbeat(payload),
      /full evaluation|public evaluation|projection|metric/i,
      'ACCEPTED_MISMATCHED_FULL_EVALUATION_PROJECTION',
    );
    await store.close();
  }
});

test('uses a host-neutral Unicode key order for private evidence digests', async t => {
  const root = await temporaryRoot(t, 'unicode-digest-order');
  const runBinding = binding('files-multi', 'unicode-digest-order', ['PAIR-Q-1']);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ], {
    contactRequests: [],
    actionSnapshots: [],
    tickDecisions: [{
      type: 'completed',
      content: 'z ä Ω 😀',
      toolSteps: 0,
      contactCalls: 0,
    }],
    fullEvaluations: [],
  });
  const store = await openFileWorkflowLedgerV1({
    runDirectory: join(root, 'run'),
    binding: runBinding,
    retainPrivate: true,
  });
  const committed = await store.commitHeartbeat(payload);
  assert.equal(
    committed.record.payload.privateEvidenceDigest,
    '02c6573f00c6751c70173c3c2e0cd4731a9f668dbcc10d97c07ad2bd162fc32a',
  );
  await store.close();
});

test('retention on/off has equal public metrics and hashes and leaks no private sentinel', async t => {
  const root = await temporaryRoot(t, 'retention');
  const sentinels = [
    'PRIVATE_MEMORY_SENTINEL',
    'PRIVATE_CONTACT_SENTINEL',
    'PRIVATE_GOLD_SENTINEL',
    'sk-secret-credential',
    '/Users/private/host/path',
  ];
  const publicByMode: string[][] = [];
  for (const retainPrivate of [true, false]) {
    const runId = 'retention-equal';
    const runDirectory = join(root, retainPrivate ? 'on' : 'off');
    const runBinding = binding('files-multi', runId, ['PAIR-Q-1']);
    const finalMemory = Buffer.from(`PAIR-Q-1 [error] — ${sentinels[0]}\n`);
    const finalFiles = finalFilesFor(runBinding, 1);
    finalFiles.requester['MEMORY.md'] = {
      path: 'MEMORY.md',
      sha256: createHash('sha256').update(finalMemory).digest('hex'),
      byteLength: finalMemory.byteLength,
    };
    const store = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate,
    });
    const privateEvidence = {
      contactRequests: [{
        taskId: 'PAIR-Q-1', senderId: 'requester', recipientId: 'responder',
        purpose: 'PAIR-Q-1', intent: sentinels[4]!, message: sentinels[1]!,
        recipientTraceId: 'recipient', status: 'completed' as const, response: 'sk-secret-credential',
      }],
      memory: {
        actorId: 'requester',
        previousBytesBase64: Buffer.from('PAIR-Q-1 [pending] — memory 0\n').toString('base64'),
        newBytesBase64: finalMemory.toString('base64'),
      },
      actionSnapshots: [],
      tickDecisions: [{
        type: 'completed' as const,
        content: sentinels[2]!,
        toolSteps: 0,
        contactCalls: 1,
      }],
      fullEvaluations: [],
    };
    const payload = heartbeatPayloadFor(runBinding, 1, [
      transition('PAIR-Q-1', 'error', 1),
    ], privateEvidence);
    payload.transitions[0]!.contactId = 'recipient';
    payload.transitions[0]!.result.contactStatus = 'completed';
    payload.memoryTransition!.newSha256 = finalFiles.requester['MEMORY.md'].sha256;
    payload.memoryTransition!.byteLength = finalMemory.byteLength;
    await store.commitHeartbeat(payload);
    await store.finalize({ stopReason: 'all_terminal', finalFiles });
    const bytes = await Promise.all(publicNames.map(name => readFile(join(runDirectory, name), 'utf8')));
    for (const source of bytes) for (const sentinel of sentinels) {
      assert.equal(source.includes(sentinel), false, `${sentinel} leaked with retention=${retainPrivate}`);
    }
    publicByMode.push(bytes);
    const internalRecords = await store.readRecords();
    assert.equal(
      internalRecords[0]?.payload.privateEvidence !== undefined,
      retainPrivate,
    );
    assert.ok(
      internalRecords[0]?.payload.memoryAuthority,
      'sanitized MEMORY authority must survive both retention modes',
    );
    await store.close();

    const reopened = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate,
    });
    const reopenedRecords = await reopened.readRecords();
    assert.equal(reopenedRecords.length, 1);
    assert.equal(
      reopenedRecords[0]?.payload.privateEvidence !== undefined,
      retainPrivate,
    );
    assert.ok(reopenedRecords[0]?.payload.memoryAuthority);
    await reopened.close();
  }
  assert.deepEqual(publicByMode[0], publicByMode[1]);
});

test('rejects committed truncation, gaps, digest edits, foreign binding, and unknown duplicates', async t => {
  const mutations: Array<[string, (recordPath: string, recordsDir: string) => Promise<void>]> = [
    ['truncation', async path => truncate(path, 8)],
    ['gap', async (path, dir) => rename(path, join(dir, 'record-000000000001.json'))],
    ['digest edit', async path => {
      const value = await json(path);
      value.recordDigest = '0'.repeat(64);
      await writeFile(path, `${JSON.stringify(value)}\n`);
    }],
    ['foreign binding', async path => {
      const value = await json(path);
      value.bindingDigest = 'f'.repeat(64);
      await writeFile(path, `${JSON.stringify(value)}\n`);
    }],
    ['duplicate', async (path, dir) => writeFile(join(dir, 'copy.json'), await readFile(path))],
  ];
  for (const [name, mutate] of mutations) {
    const root = await temporaryRoot(t, `tamper-${name}`);
    const runDirectory = join(root, 'run');
    const options = {
      runDirectory,
      binding: binding('files-multi', `tamper-${name.replace(/\s/g, '-')}`, ['PAIR-Q-1']),
      retainPrivate: false,
    } as const;
    const store = await openFileWorkflowLedgerV1(options);
    await store.commitHeartbeat(heartbeatPayloadFor(options.binding, 1, [
      transition('PAIR-Q-1', 'error', 1),
    ]));
    await store.close();
    const recordsDir = join(runDirectory, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'records');
    const recordPath = join(recordsDir, 'record-000000000000.json');
    await mutate(recordPath, recordsDir);
    await assert.rejects(() => openFileWorkflowLedgerV1(options), /record|ledger|digest|binding|contiguous|unexpected/i);
  }
});

test('rejects an edit to retained private bytes even when the public record digest is unchanged', async t => {
  const root = await temporaryRoot(t, 'private-digest-edit');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'private-digest-edit', ['PAIR-Q-1']);
  const options = { runDirectory, binding: runBinding, retainPrivate: true } as const;
  const store = await openFileWorkflowLedgerV1(options);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ], {
    contactRequests: [{
      taskId: 'PAIR-Q-1',
      senderId: 'requester',
      recipientId: 'responder',
      purpose: 'PAIR-Q-1',
      intent: 'inspect',
      message: 'ORIGINAL_PRIVATE_MESSAGE',
      recipientTraceId: 'recipient-trace',
      status: 'completed',
      response: 'private',
    }],
    actionSnapshots: [],
    tickDecisions: [],
    fullEvaluations: [],
  });
  payload.transitions[0]!.contactId = 'recipient-trace';
  payload.transitions[0]!.result.contactStatus = 'completed';
  await store.commitHeartbeat(payload);
  await store.close();

  const recordPath = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'records',
    'record-000000000000.json',
  );
  const edited = await json(recordPath);
  edited.payload.privateEvidence.contactRequests[0].message = 'TAMPERED_PRIVATE_MESSAGE';
  await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
  await assert.rejects(
    () => openFileWorkflowLedgerV1(options),
    /private evidence|digest|committed bytes/i,
  );
});

test('rejects private bytes injected into a retention-off committed row', async t => {
  const root = await temporaryRoot(t, 'retention-off-injection');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'retention-off-injection', ['PAIR-Q-1']);
  const privateEvidence = {
    contactRequests: [],
    actionSnapshots: [],
    tickDecisions: [{
      type: 'completed' as const,
      content: 'PRIVATE_INJECTION',
      toolSteps: 0,
      contactCalls: 0,
    }],
    fullEvaluations: [],
  };
  const options = { runDirectory, binding: runBinding, retainPrivate: false } as const;
  const store = await openFileWorkflowLedgerV1(options);
  const payload = heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ], privateEvidence);
  const injectedPrivateEvidence = structuredClone(payload.privateEvidence);
  await store.commitHeartbeat(payload);
  await store.close();

  const recordPath = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'records',
    'record-000000000000.json',
  );
  const edited = await json(recordPath);
  edited.payload.privateEvidence = injectedPrivateEvidence;
  await writeFile(recordPath, `${JSON.stringify(edited)}\n`);
  await assert.rejects(
    () => openFileWorkflowLedgerV1(options),
    /private evidence|retention.*disabled/i,
  );
});

test('rejects a schema-valid public run manifest with foreign workflow identity', async t => {
  const root = await temporaryRoot(t, 'foreign-public-run');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'foreign-public-run', ['PAIR-Q-1']);
  const options = { runDirectory, binding: runBinding, retainPrivate: false } as const;
  const store = await openFileWorkflowLedgerV1(options);
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await store.close();

  const runPath = join(runDirectory, 'run.json');
  const manifest = await json(runPath);
  manifest.workflowId = 'files-single';
  manifest.runId = 'foreign-run-id';
  await writeFile(runPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    () => openFileWorkflowLedgerV1(options),
    /foreign|workflow|run binding/i,
  );
});

test('ignores an uncommitted torn UUID stage but rejects symlink and non-regular lane paths', async t => {
  const root = await temporaryRoot(t, 'unsafe-paths');
  const runDirectory = join(root, 'run');
  const options = {
    runDirectory,
    binding: binding('files-multi', 'unsafe-paths', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  const first = await openFileWorkflowLedgerV1(options);
  await first.close();
  const stage = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'staging',
    'stage-00000000-0000-4000-8000-000000000000.json',
  );
  await writeFile(stage, '{torn');
  const resumed = await openFileWorkflowLedgerV1(options);
  assert.equal((await readdir(join(runDirectory, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'staging'))).length, 0);
  await resumed.close();

  const outside = join(root, 'outside');
  await writeFile(outside, 'secret');
  await symlink(outside, join(runDirectory, 'run.json'));
  await assert.rejects(() => openFileWorkflowLedgerV1(options), /symlink|regular file|unsafe/i);
  await rm(join(runDirectory, 'run.json'));
  await mkdir(join(runDirectory, 'summary.json'));
  await assert.rejects(() => openFileWorkflowLedgerV1(options), /regular file|directory|unsafe/i);
});

test('rejects an oversized record, hostile IDs, legacy artifacts, and a second writer before spend', async t => {
  const root = await temporaryRoot(t, 'boundary-rejections');
  const runDirectory = join(root, 'run');
  const options = {
    runDirectory,
    binding: binding('files-multi', 'boundary-rejections', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  const first = await openFileWorkflowLedgerV1(options);
  let spend = 0;
  await assert.rejects(async () => {
    const second = await openFileWorkflowLedgerV1(options);
    spend += 1;
    await second.close();
  }, /writer|lock/i);
  assert.equal(spend, 0);
  await first.close();

  await assert.rejects(() => openFileWorkflowLedgerV1({
    runDirectory: join(root, 'hostile'),
    binding: { ...options.binding, runId: '../escape' },
    retainPrivate: false,
  }), /opaque|invalid/i);

  const legacyDirectory = join(root, 'legacy');
  await mkdir(legacyDirectory);
  await writeFile(join(legacyDirectory, 'run.json'), '{"apiVersion":"pact-run/v1"}\n');
  await assert.rejects(() => openFileWorkflowLedgerV1({
    runDirectory: legacyDirectory,
    binding: binding('files-multi', 'legacy-reject', ['PAIR-Q-1']),
    retainPrivate: false,
  }), /legacy|foreign|file-workflow lane/i);

  const oversizedDirectory = join(root, 'oversized');
  const oversizedOptions = {
    runDirectory: oversizedDirectory,
    binding: binding('files-multi', 'oversized', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  const store = await openFileWorkflowLedgerV1(oversizedOptions);
  await store.close();
  await writeFile(
    join(oversizedDirectory, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'records', 'record-000000000000.json'),
    'x'.repeat(4 * 1024 * 1024 + 1),
  );
  await assert.rejects(() => openFileWorkflowLedgerV1(oversizedOptions), /exceeds|oversized|bytes/i);
});

test('reclaims a writer lock whose recorded process is no longer alive', async t => {
  const root = await temporaryRoot(t, 'dead-writer');
  const runDirectory = join(root, 'run');
  const options = {
    runDirectory,
    binding: binding('files-multi', 'dead-writer', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  const first = await openFileWorkflowLedgerV1(options);
  await first.close();
  const crashed = spawnLockProcess({ options, mode: 'crash', id: -1 });
  assert.match(await crashed.done, /CRASHED_WITH_LOCK/);

  const resumed = await openFileWorkflowLedgerV1(options);
  await resumed.close();
});

test('elects one writer under simultaneous multi-process dead-owner recovery', async t => {
  const root = await temporaryRoot(t, 'writer-contention');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'writer-contention', ['PAIR-Q-1']);
  const options = { runDirectory, binding: runBinding, retainPrivate: false } as const;
  const initialized = await openFileWorkflowLedgerV1(options);
  await initialized.close();

  const crashed = spawnLockProcess({ options, mode: 'crash', id: -1 });
  const crashOutput = await crashed.done;
  assert.match(crashOutput, /CRASHED_WITH_LOCK/);

  const contenders = Array.from({ length: 8 }, (_, id) => (
    spawnLockProcess({ options, mode: 'contend', id })
  ));
  await Promise.all(contenders.map(contender => contender.ready));
  for (const contender of contenders) contender.start();
  const outputs = await Promise.all(contenders.map(contender => contender.done));
  const acquired = outputs.filter(output => /ACQUIRED-/.test(output));
  assert.equal(
    acquired.length,
    1,
    `expected one writer, got ${acquired.length}:\n${outputs.join('\n')}`,
  );
  assert.equal(outputs.filter(output => /REJECTED-/.test(output)).length, 7);
});

test('recovers a published writer release after its post-publication durability fault', async t => {
  const root = await temporaryRoot(t, 'writer-release-fault');
  const runDirectory = join(root, 'run');
  const options = {
    runDirectory,
    binding: binding('files-multi', 'writer-release-fault', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  const first = await openFileWorkflowLedgerV1({
    ...options,
    faults: {
      afterWriterClaimPublicationForTest(kind) {
        if (kind === 'release') throw new Error('release-after-publication-fault');
      },
    },
  });
  await assert.rejects(() => first.close(), /release-after-publication-fault/);

  const resumed = await openFileWorkflowLedgerV1(options);
  await resumed.close();
  const claimsDirectory = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'writer-claims',
  );
  assert.deepEqual((await readdir(claimsDirectory)).sort(), [
    'claim-000000000000.json',
    'claim-000000000001.json',
    'claim-000000000002.json',
    'claim-000000000003.json',
  ]);
});

test('keeps close retryable when writer release fails before publication', async t => {
  const root = await temporaryRoot(t, 'writer-release-retry');
  const runDirectory = join(root, 'run');
  const options = {
    runDirectory,
    binding: binding('files-multi', 'writer-release-retry', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  let failRelease = true;
  const faults: FileWorkflowLedgerFaultInjectionV1 = {
    beforeWriterClaimPublicationForTest(kind: 'acquire' | 'release') {
      if (kind === 'release' && failRelease) {
        failRelease = false;
        throw new Error('release-before-publication-fault');
      }
    },
  };
  const first = await openFileWorkflowLedgerV1({ ...options, faults });
  await assert.rejects(() => first.close(), /release-before-publication-fault/);
  const claimsDirectory = join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'writer-claims',
  );
  assert.deepEqual(await readdir(claimsDirectory), ['claim-000000000000.json']);
  await first.close();

  const resumed = await openFileWorkflowLedgerV1(options);
  await resumed.close();
});

test('close fences an in-flight staged projection before a new writer can publish', async t => {
  const root = await temporaryRoot(t, 'staged-public-fencing');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'staged-public-fencing', [
    'PAIR-Q-1',
    'PAIR-Q-2',
  ]);
  let releaseStage!: () => void;
  const stageReleased = new Promise<void>(resolve => { releaseStage = resolve; });
  let reportStaged!: () => void;
  const staged = new Promise<void>(resolve => { reportStaged = resolve; });
  let paused = false;
  const old = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
    faults: {
      async afterPublicArtifactStageForTest(name) {
        if (name === 'run.json' && !paused) {
          paused = true;
          reportStaged();
          await stageReleased;
        }
      },
    },
  });
  const oldCommit = old.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await staged;
  const close = old.close();
  const closeState = await settlesWithin(close, 150);

  let newer: Awaited<ReturnType<typeof openFileWorkflowLedgerV1>> | undefined;
  if (closeState === 'settled') {
    newer = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate: false,
    });
    await newer.commitHeartbeat(heartbeatPayloadFor(runBinding, 2, [
      transition('PAIR-Q-2', 'error', 2),
    ]));
  } else {
    await assert.rejects(
      () => openFileWorkflowLedgerV1({
        runDirectory,
        binding: runBinding,
        retainPrivate: false,
      }),
      /writer|lock/i,
    );
  }
  releaseStage();
  const oldOutcome = await Promise.allSettled([oldCommit, close]);
  if (!newer) {
    assert.equal(oldOutcome[0]?.status, 'fulfilled');
    assert.equal(oldOutcome[1]?.status, 'fulfilled');
    newer = await openFileWorkflowLedgerV1({
      runDirectory,
      binding: runBinding,
      retainPrivate: false,
    });
    await newer.commitHeartbeat(heartbeatPayloadFor(runBinding, 2, [
      transition('PAIR-Q-2', 'error', 2),
    ]));
  }
  await newer.close();

  const run = await json(join(runDirectory, 'run.json'));
  const checkpoint = await json(join(runDirectory, 'checkpoint.json'));
  assert.deepEqual(
    { run: run.recordCount, checkpoint: checkpoint.recordCount },
    { run: 2, checkpoint: 2 },
    'STALE_WRITER_OVERWROTE_NEW_PUBLIC_PROJECTION',
  );
});

test('serializes commit, repair, read, finalize, and close as one writer operation queue', async t => {
  const root = await temporaryRoot(t, 'writer-operation-queue');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'writer-operation-queue', ['PAIR-Q-1']);
  let releaseStage!: () => void;
  const stageReleased = new Promise<void>(resolve => { releaseStage = resolve; });
  let reportStaged!: () => void;
  const staged = new Promise<void>(resolve => { reportStaged = resolve; });
  let paused = false;
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
    faults: {
      async afterPublicArtifactStageForTest(name) {
        if (name === 'run.json' && !paused) {
          paused = true;
          reportStaged();
          await stageReleased;
        }
      },
    },
  });
  const commit = store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await staged;
  const repair = store.repairPublicProjections();
  const queuedRead = store.readRecords();
  const finalize = store.finalize({
    stopReason: 'all_terminal',
    finalFiles: finalFilesFor(runBinding, 1),
  });
  const close = store.close();
  assert.equal(await settlesWithin(close, 100), 'pending');
  await Promise.all([
    assert.rejects(
      () => store.commitHeartbeat(heartbeatPayloadFor(runBinding, 2, [])),
      /closed/i,
    ),
    assert.rejects(() => store.repairPublicProjections(), /closed/i),
    assert.rejects(() => store.readRecords(), /closed/i),
    assert.rejects(
      () => store.finalize({
        stopReason: 'all_terminal',
        finalFiles: finalFilesFor(runBinding, 1),
      }),
      /closed/i,
    ),
  ]);
  releaseStage();
  const [commitResult, , records] = await Promise.all([
    commit,
    repair,
    queuedRead,
    finalize,
    close,
  ]);
  assert.equal(commitResult.outcome, 'committed');
  assert.equal(records.length, 1);
  const [run, checkpoint, results, summary] = await Promise.all([
    json(join(runDirectory, 'run.json')),
    json(join(runDirectory, 'checkpoint.json')),
    jsonLines(join(runDirectory, 'results.jsonl')),
    json(join(runDirectory, 'summary.json')),
  ]);
  assert.deepEqual(
    {
      runStatus: run.status,
      runRecords: run.recordCount,
      runResults: run.resultRows,
      checkpointStatus: checkpoint.status,
      checkpointRecords: checkpoint.recordCount,
      checkpointResults: checkpoint.resultRows,
      resultRows: results.length,
      evaluationRows: summary.evaluationRows,
    },
    {
      runStatus: 'completed',
      runRecords: 1,
      runResults: 1,
      checkpointStatus: 'completed',
      checkpointRecords: 1,
      checkpointResults: 1,
      resultRows: 1,
      evaluationRows: 1,
    },
  );
});

test('rejects a gap or identity edit in append-only writer claim history', async t => {
  for (const mutation of ['gap', 'identity'] as const) {
    const root = await temporaryRoot(t, `writer-claim-${mutation}`);
    const runDirectory = join(root, 'run');
    const options = {
      runDirectory,
      binding: binding('files-multi', `writer-claim-${mutation}`, ['PAIR-Q-1']),
      retainPrivate: false,
    } as const;
    const store = await openFileWorkflowLedgerV1(options);
    await store.close();
    const claimsDirectory = join(
      runDirectory,
      FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
      'writer-claims',
    );
    const releasePath = join(claimsDirectory, 'claim-000000000001.json');
    if (mutation === 'gap') {
      await rename(releasePath, join(claimsDirectory, 'claim-000000000002.json'));
    } else {
      const claim = await json(releasePath);
      claim.token = '00000000-0000-4000-8000-000000000000';
      await writeFile(releasePath, `${JSON.stringify(claim)}\n`);
    }
    await assert.rejects(
      () => openFileWorkflowLedgerV1(options),
      /writer claim|digest|owner|contiguous/i,
    );
  }
});

test('rejects invalid UTF-8 in a committed record before JSON decoding', async t => {
  const root = await temporaryRoot(t, 'invalid-record-utf8');
  const runDirectory = join(root, 'run');
  const options = {
    runDirectory,
    binding: binding('files-multi', 'invalid-record-utf8', ['PAIR-Q-1']),
    retainPrivate: false,
  } as const;
  const store = await openFileWorkflowLedgerV1(options);
  await store.commitHeartbeat(heartbeatPayloadFor(options.binding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await store.close();
  await writeFile(join(
    runDirectory,
    FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
    'records',
    'record-000000000000.json',
  ), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(
    () => openFileWorkflowLedgerV1(options),
    /UTF-8/i,
  );
});

test('fails finalization before a completed checkpoint when a selected task is missing', async t => {
  const root = await temporaryRoot(t, 'cardinality-final');
  const runDirectory = join(root, 'run');
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: binding('files-multi', 'cardinality-final', ['PAIR-Q-1', 'PAIR-Q-2']),
    retainPrivate: false,
  });
  const runBinding = binding('files-multi', 'cardinality-final', ['PAIR-Q-1', 'PAIR-Q-2']);
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  await assert.rejects(() => store.finalize({
    stopReason: 'all_terminal',
    finalFiles: finalFilesFor(runBinding, 1),
  }), /cardinality|task-ID set/i);
  const checkpoint = await json(join(runDirectory, 'checkpoint.json'));
  assert.equal(checkpoint.status, 'running');
  await store.close();
});

test('fails finalization when the declared final MEMORY hash is not ledger-derived', async t => {
  const root = await temporaryRoot(t, 'final-memory-binding');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'final-memory-binding', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
  });
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  const declaredFinal = finalFilesFor(runBinding, 1);
  declaredFinal.requester['AGENT.md'].sha256 = 'f'.repeat(64);
  await assert.rejects(
    () => store.finalize({
      stopReason: 'all_terminal',
      finalFiles: declaredFinal,
    }),
    /AGENT|read-only|final file/i,
  );
  declaredFinal.requester['AGENT.md'] = structuredClone(
    runBinding.actors.requester.initial['AGENT.md'],
  );
  declaredFinal.requester['MEMORY.md'].sha256 = 'f'.repeat(64);
  await assert.rejects(
    () => store.finalize({
      stopReason: 'all_terminal',
      finalFiles: declaredFinal,
    }),
    /final MEMORY|hash|binding/i,
  );
  const checkpoint = await json(join(runDirectory, 'checkpoint.json'));
  assert.equal(checkpoint.status, 'running');
  await store.close();
});

test('makes final authority immutable and rejects an edited completion marker', async t => {
  const root = await temporaryRoot(t, 'final-authority');
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'final-authority', ['PAIR-Q-1']);
  const options = { runDirectory, binding: runBinding, retainPrivate: false } as const;
  const store = await openFileWorkflowLedgerV1(options);
  await store.commitHeartbeat(heartbeatPayloadFor(runBinding, 1, [
    transition('PAIR-Q-1', 'error', 1),
  ]));
  const finalFiles = finalFilesFor(runBinding, 1);
  await store.finalize({ stopReason: 'all_terminal', finalFiles });
  await assert.rejects(
    () => store.finalize({ stopReason: 'fatal_error', finalFiles }),
    /final authority|immutable|conflict/i,
  );
  await store.close();

  const finalPath = join(runDirectory, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'final.json');
  const edited = await json(finalPath);
  edited.stopReason = 'fatal_error';
  await writeFile(finalPath, `${JSON.stringify(edited)}\n`);
  await assert.rejects(
    () => openFileWorkflowLedgerV1(options),
    /final authority|digest|edited|malformed/i,
  );
});

test('rejects symlinked private and ledger components before reading their targets', async t => {
  const root = await temporaryRoot(t, 'component-links');
  const targetDirectory = join(root, 'target');
  await mkdir(targetDirectory);

  const privateRun = join(root, 'private-run');
  await mkdir(privateRun);
  await symlink(targetDirectory, join(privateRun, 'private'));
  await assert.rejects(() => openFileWorkflowLedgerV1({
    runDirectory: privateRun,
    binding: binding('files-multi', 'private-link', ['PAIR-Q-1']),
    retainPrivate: true,
  }), /private|symlink|unsafe/i);

  const ledgerRun = join(root, 'ledger-run');
  const ledgerBinding = binding('files-multi', 'ledger-link', ['PAIR-Q-1']);
  const options = { runDirectory: ledgerRun, binding: ledgerBinding, retainPrivate: false } as const;
  const store = await openFileWorkflowLedgerV1(options);
  await store.close();
  const records = join(ledgerRun, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'records');
  await rmdir(records);
  await symlink(targetDirectory, records);
  await assert.rejects(() => openFileWorkflowLedgerV1(options), /records|directory|real|symlink/i);
});

async function temporaryRoot(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), `sharedeval-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

async function jsonLines(path: string): Promise<Record<string, any>[]> {
  const source = await readFile(path, 'utf8');
  return source.trim() === '' ? [] : source.trimEnd().split('\n').map(line => JSON.parse(line));
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), timeoutMs)),
  ]);
}

function actionContactEvidence(input: {
  contactId: string;
  eventId: string;
  status: 'completed' | 'denied' | 'failed' | 'cancelled';
}) {
  return {
    contactRequests: [{
      taskId: 'PAIR-A-1',
      senderId: 'requester',
      recipientId: 'responder',
      purpose: 'PAIR-A-1',
      intent: 'act',
      message: 'contact',
      requestTraceId: input.eventId.replace('event-', 'trace-'),
      deadlineMs: 1_000,
      recipientTraceId: input.contactId,
      status: input.status,
      ...(input.status === 'completed'
        ? { response: 'completed' }
        : { errorCode: input.status === 'denied'
            ? 'CONTACT_RESPONDER_DENIED'
            : input.status === 'failed'
              ? 'CONTACT_RESPONDER_FAILED'
              : 'CONTACT_CANCELLED' }),
    }],
    actionSnapshots: [{
      taskId: 'PAIR-A-1',
      contactId: input.contactId,
      actorId: 'responder',
      eventId: input.eventId,
      before: pairStore('before'),
      after: pairStore(input.status === 'completed' ? 'after' : 'before'),
    }],
    tickDecisions: [],
    fullEvaluations: [],
  };
}

function qaContactEvidence(status: 'completed' | 'denied' | 'failed' | 'cancelled') {
  const evaluation = fullQaEvaluation(
    'PAIR-Q-1',
    status === 'denied' ? 'refuse' : 'answer',
  );
  return {
    contactRequests: [{
      taskId: 'PAIR-Q-1',
      senderId: 'requester',
      recipientId: 'responder',
      purpose: 'PAIR-Q-1',
      intent: 'answer',
      message: 'contact',
      requestTraceId: 'trace-1',
      deadlineMs: 1_000,
      recipientTraceId: 'recipient-trace',
      status,
      ...(status === 'completed'
        ? { response: 'completed' }
        : { errorCode: status === 'denied'
            ? 'CONTACT_RESPONDER_DENIED'
            : status === 'failed'
              ? 'CONTACT_RESPONDER_FAILED'
              : 'CONTACT_CANCELLED' }),
    }],
    actionSnapshots: [],
    tickDecisions: [],
    fullEvaluations: [{
      taskId: 'PAIR-Q-1',
      evaluation,
      metrics: metricRowsFor(evaluation),
    }],
  };
}

function emptyPrivateEvidence() {
  return {
    contactRequests: [],
    actionSnapshots: [],
    tickDecisions: [],
    fullEvaluations: [],
  };
}

function evaluatedQaTransition(
  taskId: string,
  terminalTick: number,
  status: 'answered' | 'refused' = 'answered',
) {
  const row = transition(taskId, status, terminalTick, 'qa');
  const fullEvaluation = fullQaEvaluation(
    taskId,
    status === 'refused' ? 'refuse' : 'answer',
  );
  const publicEvaluation = toPublicEvaluation(fullEvaluation);
  row.result.publicEvaluation = publicEvaluation;
  row.evaluation.publicEvaluation = publicEvaluation;
  row.evaluation.metrics = metricRowsFor(fullEvaluation);
  return row;
}

function evaluatedActionTransition(
  taskId: string,
  terminalTick: number,
  options: {
    status?: 'answered' | 'refused' | 'side_effect_before_failure';
    stateChanged?: boolean;
  } = {},
) {
  const status = options.status ?? 'answered';
  const fullEvaluation = fullActionEvaluation(
    taskId,
    options.stateChanged ?? true,
    status === 'side_effect_before_failure' ? 'none' : 'answer',
  );
  const row = transition(taskId, status, terminalTick, 'action');
  const publicEvaluation = toPublicEvaluation(fullEvaluation);
  row.result.publicEvaluation = publicEvaluation;
  row.evaluation.publicEvaluation = publicEvaluation;
  row.evaluation.metrics = metricRowsFor(fullEvaluation).map(metric => (
    status === 'side_effect_before_failure' && metric.metric !== 'actionSafety'
      ? { ...metric, numerator: 0, denominator: 0 }
      : metric
  ));
  return row;
}

function fixedPactPairMetricRows() {
  return PACT_PAIR_METRIC_NAMES_V1.map(metric => ({
    metric,
    numerator: 0,
    denominator: 0,
  }));
}

function strictActionEvidence(
  taskId: string,
  eventId: string,
  stateChanged = true,
  actualDecision: 'answer' | 'none' = 'answer',
) {
  const evaluation = fullActionEvaluation(taskId, stateChanged, actualDecision);
  const before = pairStore('PRIVATE_ACTION_BEFORE_SENTINEL');
  return {
    contactRequests: [{
      taskId,
      senderId: 'requester',
      recipientId: 'responder',
      purpose: taskId,
      intent: 'act',
      message: 'PRIVATE_CONTACT_SENTINEL',
      requestTraceId: eventId.replace('event-', 'trace-'),
      deadlineMs: 1_000,
      recipientTraceId: 'recipient-trace',
      status: 'completed' as const,
      response: 'done',
    }],
    actionSnapshots: [{
      taskId,
      contactId: 'recipient-trace',
      actorId: 'responder',
      eventId,
      before,
      after: stateChanged
        ? pairStore('PRIVATE_ACTION_AFTER_SENTINEL')
        : structuredClone(before),
    }],
    tickDecisions: [],
    fullEvaluations: [{
      taskId,
      evaluation,
      metrics: metricRowsFor(evaluation),
    }],
  };
}

function fullActionEvaluation(
  taskId: string,
  stateChanged = true,
  actualDecision: 'answer' | 'none' = 'answer',
): PactPairActionEvaluationV1 {
  return {
    taskId,
    kind: 'action' as const,
    actualDecision,
    scorable: true,
    decisionCorrect: actualDecision === 'answer',
    correct: actualDecision === 'answer' && stateChanged,
    reasons: ['PRIVATE_FULL_EVALUATION_SENTINEL'],
    expectedBehavior: 'execute' as const,
    stateChanged,
    stateCorrect: stateChanged,
    noUnexpectedMutations: true,
    goldCheckType: 'note_created',
    mutations: emptyMutationSummary(),
  };
}

function fullQaEvaluation(
  taskId: string,
  actualDecision: 'answer' | 'refuse' = 'answer',
): PactPairQaEvaluationV1 {
  const answered = actualDecision === 'answer';
  return {
    taskId,
    kind: 'qa' as const,
    actualDecision,
    scorable: true,
    decisionCorrect: true,
    correct: true,
    reasons: ['PRIVATE_FULL_QA_EVALUATION_SENTINEL'],
    expectedBehavior: actualDecision,
    benchmarkExpectedBehavior: actualDecision,
    factMatch: answered,
    minimumCorrectMatched: answered,
    matchedFacts: answered ? ['fact'] : [],
    missedFacts: answered ? [] : ['fact'],
    leakedFacts: [],
    leaked: false,
    noLeak: true,
    benchmarkLeaked: false,
    benchmarkNoLeak: true,
  };
}

function metricRowsFor(evaluation: PactPairEvaluationV1) {
  const derived = pactPairMetricContributionsV1(evaluation);
  return PACT_PAIR_METRIC_NAMES_V1.map((metric, index) => ({
    metric,
    numerator: derived[index]!.numerator,
    denominator: derived[index]!.denominator,
  }));
}

function emptyMutationSummary() {
  return {
    metadataChanged: false,
    noteFoldersChanged: false,
    todoFoldersChanged: false,
    notes: { created: [], updated: [], removed: [] },
    todos: { created: [], updated: [], removed: [] },
  };
}

function pairStore(sentinel: string) {
  return {
    version: '1',
    description: 'private test store',
    owner: {
      name: 'Owner',
      role: 'Engineer',
      company: 'Example',
      background: 'Test fixture',
    },
    note_folders: [{
      id: 1,
      name: 'General',
      parentId: null,
      sensitivity: 'work_public',
    }],
    todo_folders: [{ id: 1, name: 'General', sensitivity: 'work_public' }],
    notes: [{ id: 1, folderId: 1, title: 'Evidence', content: sentinel }],
    todos: [{
      id: 1,
      title: 'Verify evidence',
      description: sentinel,
      folderId: 1,
      priority: 0,
      category: 'work_public' as const,
      completed: false as const,
      dueDate: '2026-08-25',
    }],
  };
}

function addResponderFileReads(
  payload: ReturnType<typeof heartbeatPayloadFor>,
  runBinding: ReturnType<typeof binding>,
): void {
  for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const) {
    const metadata = runBinding.actors.responder.initial[path];
    payload.fileReads.push({
      actorId: runBinding.actors.responder.actorId,
      path,
      action: 'read',
      version: 0,
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
    });
  }
}

function setRequesterMemoryEvidence(
  payload: ReturnType<typeof heartbeatPayloadFor>,
  previousContent: string,
  newContent: string,
): void {
  const transition = payload.memoryTransition;
  assert.ok(transition);
  payload.privateEvidence.memory = {
    actorId: transition.actorId,
    previousBytesBase64: Buffer.from(previousContent).toString('base64'),
    newBytesBase64: Buffer.from(newContent).toString('base64'),
  };
  transition.previousSha256 = createHash('sha256').update(previousContent).digest('hex');
  transition.newSha256 = createHash('sha256').update(newContent).digest('hex');
  transition.byteLength = Buffer.byteLength(newContent);
  for (const receipt of payload.fileReads) {
    if (receipt.actorId !== transition.actorId || receipt.path !== 'MEMORY.md') continue;
    const content = receipt.version === transition.newVersion
      ? newContent
      : previousContent;
    receipt.sha256 = createHash('sha256').update(content).digest('hex');
    receipt.byteLength = Buffer.byteLength(content);
  }
}

function digestRecordMaterial(record: Record<string, any>): string {
  const material = structuredClone(record);
  delete material.recordDigest;
  delete material.payload.privateEvidence;
  return createHash('sha256').update(canonicalTestJson(material)).digest('hex');
}

function canonicalTestJson(value: unknown): string {
  return JSON.stringify(sortTestJson(value));
}

function digestTestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalTestJson(value)).digest('hex');
}

function sortTestJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortTestJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortTestJson(nested)]));
  }
  return value;
}

function spawnLockProcess(input: {
  options: {
    runDirectory: string;
    binding: ReturnType<typeof binding>;
    retainPrivate: boolean;
  };
  mode: 'crash' | 'contend';
  id: number;
}) {
  const moduleUrl = new URL(
    '../../src/runner/v1/file-workflow-ledger.ts',
    import.meta.url,
  ).href;
  const source = `
    const { openFileWorkflowLedgerV1 } = await import(${JSON.stringify(moduleUrl)});
    const options = ${JSON.stringify(input.options)};
    if (${JSON.stringify(input.mode)} === 'crash') {
      await openFileWorkflowLedgerV1(options);
      process.stdout.write('CRASHED_WITH_LOCK\\n');
      process.exit(0);
    }
    process.stdout.write('READY\\n');
    process.stdin.once('data', async () => {
      try {
        const store = await openFileWorkflowLedgerV1(options);
        process.stdout.write('ACQUIRED-${input.id}\\n');
        await new Promise(resolve => setTimeout(resolve, 750));
        await store.close();
        process.stdout.write('RELEASED-${input.id}\\n');
      } catch (error) {
        process.stdout.write('REJECTED-${input.id}\\n');
      }
    });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  let readyResolved = input.mode === 'crash';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    if (readyResolved) resolve();
  });
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (!readyResolved && output.includes('READY')) {
      readyResolved = true;
      resolveReady();
    }
  });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      if (!readyResolved) rejectReady(new Error(`lock child exited before ready: ${output}`));
      if (code === 0) resolve(output);
      else reject(new Error(`lock child exited ${code}: ${output}`));
    });
  });
  return {
    ready,
    start: () => child.stdin.end('go\n'),
    done,
  };
}
