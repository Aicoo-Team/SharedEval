import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFakeSharedOsFileSessionFactoryV1,
  fileSessionQaTasksV1,
  fileSessionRegistryRootV1,
  fileSessionSingleActorsV1,
  fileWorkflowHostRunProvenanceFixtureV1,
  type FakeSharedOsFileSessionTraceV1,
  unreachableFileTurnDriverV1,
} from '../../runner-v1/file-workflow-test-fixtures.js';
import { runPactPairFilesSingleV1 } from '../../../src/suites/pact-pair/files-single.js';
import { createPactPairWorkspaceV1 } from '../../../src/suites/pact-pair/workspace.js';

test('single opens and closes one isolated SharedOS session per selected task', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-single-session-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await mkdir(join(workspaceRootDir, 'store'));
    const batch = await runPactPairFilesSingleV1({
      runId: 'single-sharedos-only',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      requester: fileSessionSingleActorsV1.requester,
      responder: fileSessionSingleActorsV1.responder,
      tasks,
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace }),
      pactWorkspaceForTask: () => createPactPairWorkspaceV1(),
      storeRootForTask: (task, index) => join(
        workspaceRootDir,
        'store',
        `${index}-${task.taskId}`,
      ),
    });

    assert.equal(batch.preparationFailures.length, 0);
    assert.equal(batch.sessions.length, 2);
    assert.deepEqual(trace.creates.map(created => created.sessionIndex), [0, 1]);
    assert.deepEqual(trace.creates.map(created => created.tasks.map(task => task.taskId)), [
      ['PAIR-Q1'],
      ['PAIR-Q2'],
    ]);
    assert.equal(new Set(trace.creates.map(created => created.runId)).size, 2);
    assert.notEqual(
      trace.creates[0]?.requester.workspace,
      trace.creates[1]?.requester.workspace,
    );
    assert.notEqual(
      trace.creates[0]?.responder.workspace,
      trace.creates[1]?.responder.workspace,
    );
    assert.notEqual(trace.creates[0]?.pactWorkspace, trace.creates[1]?.pactWorkspace);
    assert.notEqual(trace.creates[0]?.storeRoot, trace.creates[1]?.storeRoot);
    assert.deepEqual(trace.turns.map(turn => [turn.sessionIndex, turn.tick]), [
      [0, 1],
      [1, 1],
    ]);
    assert.deepEqual(trace.closes, [0, 1]);
    assert.deepEqual(batch.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'refused'],
      ['PAIR-Q2', 'refused'],
    ]);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('single contains one session preparation failure and still schedules the next task', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-single-create-failure-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    const batch = await runPactPairFilesSingleV1({
      runId: 'single-contained-create-failure',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      requester: fileSessionSingleActorsV1.requester,
      responder: fileSessionSingleActorsV1.responder,
      tasks,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace,
        failCreateForSessionIndexes: new Set([0]),
      }),
      pactWorkspaceForTask: () => createPactPairWorkspaceV1(),
      storeRootForTask: (task, index) => join(workspaceRootDir, `${index}-${task.taskId}`),
    });

    assert.deepEqual(batch.preparationFailures, [{
      taskId: 'PAIR-Q1',
      errorCode: 'FILE_SESSION_PREPARATION_FAILED',
    }]);
    assert.equal(batch.sessions.length, 1);
    assert.deepEqual(batch.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'error'],
      ['PAIR-Q2', 'refused'],
    ]);
    assert.deepEqual(trace.turns.map(turn => turn.sessionIndex), [1]);
    assert.deepEqual(trace.closes, [1]);
    assert.doesNotMatch(JSON.stringify(batch.publicProjection), /PRIVATE_FAKE_SESSION_CREATE_FAILURE/);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('single fails loud when a created session cannot close its durable authority', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-single-close-failure-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await assert.rejects(
      () => runPactPairFilesSingleV1({
        runId: 'single-close-failure',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        requester: fileSessionSingleActorsV1.requester,
        responder: fileSessionSingleActorsV1.responder,
        tasks,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          failCloseForSessionIndexes: new Set([0]),
        }),
        pactWorkspaceForTask: () => createPactPairWorkspaceV1(),
        storeRootForTask: (task, index) => join(workspaceRootDir, `${index}-${task.taskId}`),
      }),
      /PRIVATE_FAKE_SESSION_CLOSE_FAILURE/,
    );
    assert.deepEqual(trace.turns.map(turn => turn.sessionIndex), [0]);
    assert.deepEqual(trace.creates.map(created => created.sessionIndex), [0]);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('single stops the batch on indeterminate external effects without scheduling another task', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-single-indeterminate-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await assert.rejects(
      () => runPactPairFilesSingleV1({
        runId: 'single-indeterminate',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        requester: fileSessionSingleActorsV1.requester,
        responder: fileSessionSingleActorsV1.responder,
        tasks,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          failTurnForSessionIndexes: new Set([0]),
        }),
        pactWorkspaceForTask: () => createPactPairWorkspaceV1(),
        storeRootForTask: (task, index) => join(workspaceRootDir, `${index}-${task.taskId}`),
      }),
      error => error instanceof Error
        && error.name === 'FileDrivenPairIndeterminateExternalOperationErrorV1'
        && 'errorCode' in error
        && error.errorCode === 'indeterminate_external_operation',
    );
    assert.deepEqual(trace.creates.map(created => created.sessionIndex), [0]);
    assert.deepEqual(trace.turns.map(turn => turn.sessionIndex), [0]);
    assert.deepEqual(trace.closes, [0]);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});
