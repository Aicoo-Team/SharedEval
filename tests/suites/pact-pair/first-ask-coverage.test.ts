import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sharedevalMultiTurnV1Schema } from '../../../src/runner/v1/sharedeval-config.js';
import { heartbeatInstructionText } from '../../../src/runner/v1/sharedos-file-session.js';
import { deriveFileMultiTurnProgress, type FileFirstAskProgressV2 } from '../../../src/runner/v1/file-multi-turn.js';
import { openFileWorkflowLedgerV1 } from '../../../src/runner/v1/file-workflow-ledger.js';
import { loadWorkspaceRegistryV1, resolveWorkspaceRegistryAssetV1 } from '../../../src/runner/v1/workspace-registry.js';
import { FileDrivenPairIndeterminateExternalOperationErrorV1 } from '../../../src/suites/pact-pair/file-workflow.js';
import { runPactPairFilesMultiV1 } from '../../../src/suites/pact-pair/files-multi.js';
import { createPactPairWorkspaceV1, loadCanonicalPactPairStoreV1 } from '../../../src/suites/pact-pair/workspace.js';
import {
  createFakeSharedOsFileSessionFactoryV1,
  fileSessionActorsV1,
  fileSessionQaTasksV1,
  fileSessionActionTasksV1,
  fileSessionRegistryRootV1,
  fileWorkflowHostRunProvenanceFixtureV1,
  type FakeSharedOsFileSessionTraceV1,
  unreachableFileTurnDriverV1,
  binding,
  heartbeatPayloadFor,
} from '../../runner-v1/file-workflow-test-fixtures.js';

test('coverage protocol is explicit and leaves legacy multiTurn bytes unchanged', () => {
  const legacy = { phase2StartTick: 61, finalizeTick: 261 };
  assert.equal(JSON.stringify(sharedevalMultiTurnV1Schema.parse(legacy)), JSON.stringify(legacy));
  const coverage = { protocol: 'first-ask-coverage/v2', finalizeTick: 261 };
  assert.deepEqual(sharedevalMultiTurnV1Schema.parse(coverage), coverage);
  assert.equal(sharedevalMultiTurnV1Schema.safeParse({ ...coverage, phase2StartTick: 61 }).success, false);
});

test('coverage rejects disabled evidence retention before creating any ledger files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pair-coverage-retention-'));
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'coverage-retention', ['PAIR-Q1']);
  runBinding.scheduler.multiTurn = { protocol: 'first-ask-coverage/v2', finalizeTick: 3 };
  try {
    await assert.rejects(async () => {
      const ledger = await openFileWorkflowLedgerV1({ runDirectory, binding: runBinding, retainPrivate: false });
      await ledger.close();
    }, /First-ask coverage requires private evidence retention/);
    await assert.rejects(lstat(runDirectory), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy ledgers still support disabled private evidence retention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pair-legacy-retention-'));
  try {
    for (const fixedPhase of [false, true]) {
      const runBinding = binding('files-multi', `legacy-retention-${fixedPhase}`, ['PAIR-Q1']);
      if (fixedPhase) runBinding.scheduler.multiTurn = { phase2StartTick: 2, finalizeTick: 3 };
      const ledger = await openFileWorkflowLedgerV1({
        runDirectory: join(root, String(fixedPhase)), binding: runBinding, retainPrivate: false,
      });
      try {
        const payload = heartbeatPayloadFor(runBinding, 1, [], { omitSessionStopReason: true });
        await ledger.beginHeartbeat({ event: payload.event, inputDigest: payload.inputDigest });
        await ledger.commitHeartbeat(payload);
        const records = await ledger.readRecords();
        assert.equal(records.length, 1);
        assert.equal(records[0].payload.privateEvidence, undefined);
        assert.match(records[0].payload.privateEvidenceDigest!, /^[a-f0-9]{64}$/);
      } finally { await ledger.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('distinct delivered coverage, not lost or repair ticks, gates phase and finalization', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'pair-coverage-v2-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const observed: Array<{ tick: number; multiTurnProgress?: FileFirstAskProgressV2 }> = [];
  const multiTurn = sharedevalMultiTurnV1Schema.parse({
    protocol: 'first-ask-coverage/v2', finalizeTick: 5,
  });
  const factory = createFakeSharedOsFileSessionFactoryV1({ trace, tickScript: [
    { taskId: 'PAIR-Q1', contactStatus: 'denied', omitContact: true },
    { taskId: 'PAIR-Q1', contactStatus: 'completed', executionStatus: 'failed', contactBeforeFailure: true },
    { taskId: 'PAIR-Q1', contactStatus: 'completed', memoryStatus: 'answered', omitContact: true },
    { taskId: 'PAIR-Q2', contactStatus: 'denied', executionStatus: 'failed' },
    { taskId: 'PAIR-Q2', contactStatus: 'completed' },
    { taskId: 'PAIR-Q2', contactStatus: 'completed' },
    { taskId: 'PAIR-Q3', contactStatus: 'completed', memoryStatus: 'answered' },
    { taskId: 'PAIR-Q2', contactStatus: 'completed', memoryStatus: 'answered', omitContact: true },
  ] });
  try {
    const result = await runPactPairFilesMultiV1({
      runId: 'coverage-delayed-memory', workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      storeRoot: join(workspaceRootDir, 'store'),
      requester: fileSessionActorsV1.requester, responder: fileSessionActorsV1.responder,
      tasks: fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2', 'PAIR-Q3']), maxTicks: 8, multiTurn,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: async options => {
        const session = await factory(options);
        return { ...session, runRequesterTurn: async input => {
          observed.push(structuredClone(input));
          return session.runRequesterTurn(input);
        } };
      },
    });
    assert.equal(result.stopReason, 'all_terminal');
    assert.deepEqual(observed.map(row => row.multiTurnProgress?.coveredTaskIds.length), [0, 0, 1, 1, 1, 2, 2, 3]);
    assert.deepEqual(observed[6]?.multiTurnProgress?.uncoveredTaskIds, ['PAIR-Q3']);
    assert.deepEqual(observed.map(row => row.multiTurnProgress?.phase), [1, 1, 1, 1, 1, 1, 1, 2]);
    assert.deepEqual(observed.map(row => row.multiTurnProgress?.finalization), [false, false, false, false, false, false, false, true]);
    assert.deepEqual(result.outcomes.map(row => [row.taskId, row.status, row.terminalTick]), [
      ['PAIR-Q1', 'answered', 3], ['PAIR-Q2', 'answered', 8], ['PAIR-Q3', 'answered', 7],
    ]);
    const publicTicks = (await readFile(join(workspaceRootDir, 'store', 'ticks.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(publicTicks.map(row => [row.phase, row.finalization]),
      observed.map(row => [row.multiTurnProgress?.phase, row.multiTurnProgress?.finalization]));
    assert.match(heartbeatInstructionText(7, { maxTicks: 8, multiTurn }, observed[6]?.multiTurnProgress), /Phase 1/);
    assert.doesNotMatch(heartbeatInstructionText(7, { maxTicks: 8, multiTurn }, observed[6]?.multiTurnProgress), /Finalization window/);
    assert.match(heartbeatInstructionText(8, { maxTicks: 8, multiTurn }, observed[7]?.multiTurnProgress), /Phase 2.*Finalization window/);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('accepted action without a reply counts once, remains incomplete, and is not re-issued as a first ask', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'pair-coverage-action-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const observed: Array<FileFirstAskProgressV2 | undefined> = [];
  const multiTurn = sharedevalMultiTurnV1Schema.parse({ protocol: 'first-ask-coverage/v2', finalizeTick: 2 });
  const factory = createFakeSharedOsFileSessionFactoryV1({ trace, tickScript: [
    { taskId: 'PAIR-A1', contactStatus: 'failed' },
    { taskId: 'PAIR-Q1', contactStatus: 'completed', memoryStatus: 'answered' },
    { taskId: 'PAIR-A1', contactStatus: 'failed', omitContact: true },
  ] });
  try {
    const result = await runPactPairFilesMultiV1({
      runId: 'coverage-incomplete-action', workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1, runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      storeRoot: join(workspaceRootDir, 'store'),
      requester: fileSessionActorsV1.requester, responder: fileSessionActorsV1.responder,
      tasks: [...fileSessionActionTasksV1(['PAIR-A1']), ...fileSessionQaTasksV1(['PAIR-Q1'])],
      maxTicks: 3, multiTurn, budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: async options => {
        const session = await factory(options);
        return { ...session, runRequesterTurn: async input => {
          observed.push(input.multiTurnProgress);
          return session.runRequesterTurn(input);
        } };
      },
    });
    assert.equal(result.stopReason, 'tick_exhausted');
    assert.deepEqual(observed[1]?.coveredTaskIds, ['PAIR-A1']);
    assert.deepEqual(observed[1]?.uncoveredTaskIds, ['PAIR-Q1']);
    assert.deepEqual(observed[1]?.incompleteReplyTaskIds, ['PAIR-A1']);
    assert.equal(observed[2]?.phase, 2);
    assert.equal(result.contacts.filter(row => row.taskId === 'PAIR-A1').length, 1);
    assert.equal(result.outcomes.find(row => row.taskId === 'PAIR-A1')?.status, 'no_response');
    assert.equal(result.outcomes.find(row => row.taskId === 'PAIR-A1')?.publicEvaluation, null);
  } finally { await rm(workspaceRootDir, { recursive: true, force: true }); }
});

test('coverage refuses authority-only claims and excludes the current uncommitted frontier', () => {
  const runBinding = binding('files-multi', 'coverage-evidence', ['PAIR-Q1']);
  const multiTurn = sharedevalMultiTurnV1Schema.parse({ protocol: 'first-ask-coverage/v2', finalizeTick: 2 });
  const payload = heartbeatPayloadFor(runBinding, 1, [], {
    omitSessionStopReason: true, omitRequesterMemoryReplace: true,
    contact: { taskId: 'PAIR-Q1', requestMessageId: 'request-one', message: 'Question', status: 'denied', errorCode: 'CONTACT_RESPONDER_DENIED' },
  });
  const project = (tick: number) => deriveFileMultiTurnProgress({ binding: runBinding, multiTurn, tick, records: [{ payload }] }) as FileFirstAskProgressV2;
  assert.deepEqual(project(1).coveredTaskIds, []);
  assert.deepEqual(project(2).coveredTaskIds, ['PAIR-Q1']);
  assert.deepEqual(project(2).incompleteReplyTaskIds, []);
  delete payload.privateEvidence;
  assert.throws(() => project(2), /accepted-request evidence/);
});

test('coverage v2 never resumes an indeterminate accepted-request turn', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'pair-coverage-indeterminate-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const factory = createFakeSharedOsFileSessionFactoryV1({ trace, tickScript: [
    { taskId: 'PAIR-Q1', contactStatus: 'completed' },
  ] });
  const options = {
    runId: 'coverage-indeterminate', workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1, runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    storeRoot: join(workspaceRootDir, 'store'), requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder, tasks: fileSessionQaTasksV1(['PAIR-Q1']), maxTicks: 3,
    multiTurn: sharedevalMultiTurnV1Schema.parse({ protocol: 'first-ask-coverage/v2', finalizeTick: 3 }),
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
    createDriver: unreachableFileTurnDriverV1,
    createSharedOsSession: async (input: Parameters<typeof factory>[0]) => {
      const session = await factory(input);
      return { ...session, runRequesterTurn: async (turn: Parameters<typeof session.runRequesterTurn>[0]) => {
        await session.runRequesterTurn(turn);
        throw new Error('Unsettled external effect after accepted request');
      } };
    },
  };
  try {
    await assert.rejects(() => runPactPairFilesMultiV1(options), FileDrivenPairIndeterminateExternalOperationErrorV1);
    await assert.rejects(() => runPactPairFilesMultiV1(options), FileDrivenPairIndeterminateExternalOperationErrorV1);
    assert.equal(trace.turns.length, 1);
  } finally { await rm(workspaceRootDir, { recursive: true, force: true }); }
});

test('coverage heartbeat is a separately versioned immutable registry asset', async () => {
  const registry = await loadWorkspaceRegistryV1({ rootDir: fileSessionRegistryRootV1 });
  const asset = await resolveWorkspaceRegistryAssetV1({
    rootDir: fileSessionRegistryRootV1, registry, id: 'heartbeats/files-multi-coverage', version: '2.0.0',
    actorRole: 'requester', datasetId: 'pact-pair', workflowId: 'files-multi',
  });
  assert.ok(asset);
  assert.equal(registry.assets.find(row => row.id === 'heartbeats/files-multi-probe')?.sha256,
    'e8e66db64f0718833cb5d8e42a0f22eb982d0c1cb65b632c4420293a37c8bb02');
});
