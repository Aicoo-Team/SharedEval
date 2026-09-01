import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFakeSharedOsFileSessionFactoryV1,
  fileSessionActionTasksV1,
  fileSessionActorsV1,
  fileSessionQaTasksV1,
  fileSessionRegistryRootV1,
  fileWorkflowHostRunProvenanceFixtureV1,
  type FakeSharedOsFileSessionTraceV1,
  unreachableFileTurnDriverV1,
} from '../../runner-v1/file-workflow-test-fixtures.js';
import { runPactPairFilesMultiV1 } from '../../../src/suites/pact-pair/files-multi.js';
import {
  FILE_WORKFLOW_INTERNAL_DIRECTORY_V1,
  openFileWorkflowLedgerV1,
} from '../../../src/runner/v1/file-workflow-ledger.js';
import { openFileWorkspaceV1 } from '../../../src/runner/v1/file-workspace.js';
import { loadWorkspaceRegistryV1 } from '../../../src/runner/v1/workspace-registry.js';
import { createPactPairWorkspaceV1 } from '../../../src/suites/pact-pair/workspace.js';

test('committed records replay the exact session without another SharedOS turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-replay-'));
  const workspaceRootDir = join(root, 'workspaces');
  const storeRoot = join(root, 'store');
  const tasks = fileSessionQaTasksV1(['PAIR-Q1']);
  const firstTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspaceRootDir));
    const common = {
      runId: 'durable-replay',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      storeRoot,
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks,
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      createDriver: unreachableFileTurnDriverV1,
    } as const;
    const first = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: firstTrace }),
    });
    await access(join(storeRoot, 'run.json'));

    const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const replay = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
    });

    assert.deepEqual(replay, first);
    assert.equal(replayTrace.creates.length, 1);
    assert.equal(replayTrace.turns.length, 0);
    assert.deepEqual(replayTrace.closes, [0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fatal fallback terminalizes every remaining task in its committed record and replays zero-turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-fatal-replay-'));
  const workspaceRootDir = join(root, 'workspaces');
  const common = {
    runId: 'fatal-replay',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot: join(root, 'store'),
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks: fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']),
    maxTicks: 3,
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await mkdir(workspaceRootDir);
    const firstTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const first = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace: firstTrace,
        requesterExecutionStatus: 'failed',
      }),
    });
    assert.equal(first.stopReason, 'fatal_error');
    assert.equal(first.ticks.length, 1);
    assert.deepEqual(first.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'error'],
      ['PAIR-Q2', 'error'],
    ]);

    const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const replay = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
    });
    assert.deepEqual(replay, first);
    assert.equal(replayTrace.turns.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tick exhaustion commits every pending task as no_response in the last heartbeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-tick-exhausted-'));
  const workspaceRootDir = join(root, 'workspaces');

  try {
    await mkdir(workspaceRootDir);
    const result = await runPactPairFilesMultiV1({
      runId: 'tick-exhausted',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      storeRoot: join(root, 'store'),
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks: fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']),
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      pactWorkspace: createPactPairWorkspaceV1(),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace: { creates: [], turns: [], closes: [] },
        leaveTaskPending: true,
      }),
    });

    assert.equal(result.stopReason, 'tick_exhausted');
    assert.equal(result.ticks.length, 1);
    assert.deepEqual(result.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'no_response'],
      ['PAIR-Q2', 'no_response'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a start-only heartbeat is typed indeterminate and is never retried or finalized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-start-only-'));
  const workspaceRootDir = join(root, 'workspaces');
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const pactWorkspace = createPactPairWorkspaceV1();

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspaceRootDir));
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'start-only',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        storeRoot: join(root, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks: fileSessionQaTasksV1(['PAIR-Q1']),
        maxTicks: 1,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        pactWorkspace,
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          failTurnForSessionIndexes: new Set([0]),
        }),
      }),
      error => error instanceof Error
        && error.name === 'FileDrivenPairIndeterminateExternalOperationErrorV1'
        && 'errorCode' in error
        && error.errorCode === 'indeterminate_external_operation',
    );
    assert.equal(trace.turns.length, 1);
    assert.deepEqual(trace.closes, [0]);
    await assert.rejects(() => access(finalAuthorityPath(join(root, 'store'))));

    const requesterWorkspace = await openFileWorkspaceV1({
      rootDir: workspaceRootDir,
      runId: 'start-only',
      actorId: fileSessionActorsV1.requester.actorId,
      selectedTaskIds: ['PAIR-Q1'],
    });
    const pendingMemory = await requesterWorkspace.read({
      actorId: fileSessionActorsV1.requester.actorId,
      path: 'MEMORY.md',
    });
    const mutation = await requesterWorkspace.replaceMemory({
      actorId: fileSessionActorsV1.requester.actorId,
      expectedVersion: pendingMemory.receipt.version,
      content: pendingMemory.content.replace('[pending] — ', '[refused] — interrupted turn'),
    });
    assert.equal(mutation.outcome, 'committed');
    pactWorkspace.createNote({
      folder: 'Work',
      title: 'Interrupted action mutation',
      content: 'must remain indeterminate until the pending start is resolved',
    });

    const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'start-only',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        storeRoot: join(root, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks: fileSessionQaTasksV1(['PAIR-Q1']),
        maxTicks: 1,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        pactWorkspace,
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
      }),
      error => error instanceof Error
        && error.name === 'FileDrivenPairIndeterminateExternalOperationErrorV1',
    );
    assert.equal(replayTrace.turns.length, 0);
    assert.deepEqual(replayTrace.closes, [0]);
    await assert.rejects(() => access(finalAuthorityPath(join(root, 'store'))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('action state is restored only from committed retained evidence on replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-action-replay-'));
  const workspaceRootDir = join(root, 'workspaces');
  const storeRoot = join(root, 'store');
  const tasks = fileSessionActionTasksV1(['PAIR-A1']);
  const firstTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspaceRootDir));
    const firstWorkspace = createPactPairWorkspaceV1();
    const common = {
      runId: 'action-replay',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      storeRoot,
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks,
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      createDriver: unreachableFileTurnDriverV1,
    } as const;
    const first = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: firstWorkspace,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace: firstTrace,
        contactStatus: 'failed',
        mutatePactWorkspaceForTask: workspace => {
          workspace.createNote({
            folder: 'Work',
            title: 'Committed recovery sentinel',
            content: 'durable action state',
          });
        },
      }),
    });
    const committedState = firstWorkspace.snapshot();
    assert.equal(first.outcomes[0]?.status, 'side_effect_before_failure');

    const replayWorkspace = createPactPairWorkspaceV1();
    const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const replay = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: replayWorkspace,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
    });

    assert.deepEqual(replay, first);
    assert.deepEqual(replayWorkspace.snapshot(), committedState);
    assert.equal(replayTrace.turns.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preparation opens one present workspace and materializes only the absent actor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-partial-'));
  const workspaceRootDir = join(root, 'workspaces');
  const tasks = fileSessionQaTasksV1(['PAIR-Q1']);
  const failedTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const common = {
    runId: 'partial-workspace',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot: join(root, 'store'),
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks,
    maxTicks: 1,
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    pactWorkspace: createPactPairWorkspaceV1(),
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspaceRootDir));
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        ...common,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: failedTrace,
          failCreateForSessionIndexes: new Set([0]),
        }),
      }),
      error => error instanceof Error
        && error.name === 'FileDrivenPairSessionPreparationErrorV1',
    );
    const requesterWorkspace = failedTrace.creates[0]!.requester.workspace;
    await rm(join(
      workspaceRootDir,
      'runs',
      common.runId,
      'workspaces',
      fileSessionActorsV1.responder.actorId,
    ), { recursive: true });

    const resumedTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const result = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: resumedTrace }),
    });

    assert.equal(result.stopReason, 'all_terminal');
    assert.notEqual(resumedTrace.creates[0]!.requester.workspace, requesterWorkspace);
    assert.equal((await resumedTrace.creates[0]!.requester.workspace.snapshot(
      fileSessionActorsV1.requester.actorId,
    )).initial.version, 0);
    assert.equal(resumedTrace.turns.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('caller-supplied session identity cannot change the scheduler-owned session ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-session-identity-'));
  const workspaceRootDir = join(root, 'workspaces');

  try {
    await mkdir(workspaceRootDir);
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'session-identity',
        sessionId: 'caller-controlled-session',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        storeRoot: join(root, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks: fileSessionQaTasksV1(['PAIR-Q1']),
        maxTicks: 1,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        pactWorkspace: createPactPairWorkspaceV1(),
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: { creates: [], turns: [], closes: [] },
        }),
      }),
      /session.*scheduler|session.*identity|derived/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery rejects changed scheduler tick and budget authority for the same store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-config-binding-'));
  const workspaceRootDir = join(root, 'workspaces');
  const common = {
    runId: 'config-binding',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot: join(root, 'store'),
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks: fileSessionQaTasksV1(['PAIR-Q1']),
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await mkdir(workspaceRootDir);
    await runPactPairFilesMultiV1({
      ...common,
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace: { creates: [], turns: [], closes: [] },
      }),
    });
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        ...common,
        maxTicks: 2,
        budget: { deadlineMs: 3_000, maxToolCalls: 9 },
        pactWorkspace: createPactPairWorkspaceV1(),
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: { creates: [], turns: [], closes: [] },
        }),
      }),
      /binding|scheduler|budget|maxTicks/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery rejects a different initial PACT state even when no action was contacted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-action-initial-'));
  const workspaceRootDir = join(root, 'workspaces');
  const common = {
    runId: 'action-initial-binding',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot: join(root, 'store'),
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks: fileSessionQaTasksV1(['PAIR-Q1']),
    maxTicks: 1,
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await mkdir(workspaceRootDir);
    await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace: { creates: [], turns: [], closes: [] },
      }),
    });
    const foreignWorkspace = createPactPairWorkspaceV1();
    foreignWorkspace.createNote({
      folder: 'Work',
      title: 'Foreign initial state',
      content: 'must not replay under an existing binding',
    });
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        ...common,
        pactWorkspace: foreignWorkspace,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: { creates: [], turns: [], closes: [] },
        }),
      }),
      /binding|PACT|action|initial/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('present workspaces must exactly match every newly resolved template file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-template-drift-'));
  const workspaceRootDir = join(root, 'workspaces');
  const common = {
    runId: 'template-drift',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot: join(root, 'store'),
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks: fileSessionQaTasksV1(['PAIR-Q1']),
    maxTicks: 1,
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await mkdir(workspaceRootDir);
    await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace: { creates: [], turns: [], closes: [] },
      }),
    });
    const registry = structuredClone(await loadWorkspaceRegistryV1({
      rootDir: fileSessionRegistryRootV1,
    }));
    const target = registry.assets.find(asset => asset.id === 'agents/tina/base/agent');
    const replacement = registry.assets.find(asset => asset.id === 'agents/dana/base/agent');
    assert.ok(target && replacement);
    Object.assign(target, {
      sourcePath: replacement.sourcePath,
      byteLength: replacement.byteLength,
      sha256: replacement.sha256,
      provenance: structuredClone(replacement.provenance),
    });
    const driftTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

    await assert.rejects(
      () => runPactPairFilesMultiV1({
        ...common,
        registry,
        pactWorkspace: createPactPairWorkspaceV1(),
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: driftTrace,
        }),
      }),
      /resolved template|initial workspace|AGENT\.md/i,
    );
    assert.equal(driftTrace.creates.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery rejects workspaces both ahead of and behind committed MEMORY authority', async () => {
  for (const mismatch of ['ahead', 'behind'] as const) {
    const root = await mkdtemp(join(tmpdir(), `sharedeval-workflow-${mismatch}-`));
    const workspaceRootDir = join(root, 'workspaces');
    const runId = `workspace-${mismatch}`;
    const tasks = fileSessionQaTasksV1(['PAIR-Q1']);
    const common = {
      runId,
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      storeRoot: join(root, 'store'),
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks,
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      createDriver: unreachableFileTurnDriverV1,
    } as const;

    try {
      await mkdir(workspaceRootDir);
      await runPactPairFilesMultiV1({
        ...common,
        pactWorkspace: createPactPairWorkspaceV1(),
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: { creates: [], turns: [], closes: [] },
        }),
      });
      if (mismatch === 'ahead') {
        const workspace = await openFileWorkspaceV1({
          rootDir: workspaceRootDir,
          runId,
          actorId: fileSessionActorsV1.requester.actorId,
          selectedTaskIds: tasks.map(task => task.taskId),
        });
        const current = await workspace.read({
          actorId: fileSessionActorsV1.requester.actorId,
          path: 'MEMORY.md',
        });
        const replacement = await workspace.replaceMemory({
          actorId: fileSessionActorsV1.requester.actorId,
          expectedVersion: current.receipt.version,
          content: current.content.replace('fake SharedOS reply', 'out-of-band mutation'),
        });
        assert.equal(replacement.outcome, 'committed');
      } else {
        await rm(join(
          workspaceRootDir,
          'runs',
          runId,
          'workspaces',
          fileSessionActorsV1.requester.actorId,
          'commits',
          'commit-1.json',
        ));
      }

      const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
      await assert.rejects(
        () => runPactPairFilesMultiV1({
          ...common,
          pactWorkspace: createPactPairWorkspaceV1(),
          createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
        }),
        /workspace is ahead of or behind ledger authority/,
      );
      assert.equal(replayTrace.turns.length, 0);
      assert.deepEqual(replayTrace.closes, [0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('lifecycle closes SharedOS before finalizing the ledger and then closes the ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-lifecycle-'));
  const workspaceRootDir = join(root, 'workspaces');
  const lifecycle: string[] = [];
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [], lifecycle };

  try {
    await mkdir(workspaceRootDir);
    await runPactPairFilesMultiV1({
      runId: 'ordered-lifecycle',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      storeRoot: join(root, 'store'),
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks: fileSessionQaTasksV1(['PAIR-Q1']),
      maxTicks: 1,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      pactWorkspace: createPactPairWorkspaceV1(),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace }),
      openLedger: lifecycleLedgerFactory(lifecycle),
    });

    assert.deepEqual(lifecycle, [
      'turn:0:1',
      'session.close:0',
      'ledger.finalize',
      'ledger.close',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('close failure skips finalization and restart finalizes the committed record with zero turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-close-recovery-'));
  const workspaceRootDir = join(root, 'workspaces');
  const storeRoot = join(root, 'store');
  const lifecycle: string[] = [];
  const common = {
    runId: 'close-recovery',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot,
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks: fileSessionQaTasksV1(['PAIR-Q1']),
    maxTicks: 1,
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await mkdir(workspaceRootDir);
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        ...common,
        pactWorkspace: createPactPairWorkspaceV1(),
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: { creates: [], turns: [], closes: [], lifecycle },
          failCloseForSessionIndexes: new Set([0]),
        }),
        openLedger: lifecycleLedgerFactory(lifecycle),
      }),
      /PRIVATE_FAKE_SESSION_CLOSE_FAILURE/,
    );
    assert.deepEqual(lifecycle, ['turn:0:1', 'session.close:0', 'ledger.close']);
    await assert.rejects(() => access(finalAuthorityPath(storeRoot)));

    const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const result = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
    });
    assert.equal(result.stopReason, 'all_terminal');
    assert.equal(replayTrace.turns.length, 0);
    await access(finalAuthorityPath(storeRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finalize failure is restartable from the committed terminal record with zero turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-finalize-recovery-'));
  const workspaceRootDir = join(root, 'workspaces');
  const storeRoot = join(root, 'store');
  const lifecycle: string[] = [];
  const common = {
    runId: 'finalize-recovery',
    workspaceRootDir,
    registryRootDir: fileSessionRegistryRootV1,
    storeRoot,
    requester: fileSessionActorsV1.requester,
    responder: fileSessionActorsV1.responder,
    tasks: fileSessionQaTasksV1(['PAIR-Q1']),
    maxTicks: 1,
    budget: { deadlineMs: 2_000, maxToolCalls: 8 },
    runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
    createDriver: unreachableFileTurnDriverV1,
  } as const;

  try {
    await mkdir(workspaceRootDir);
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        ...common,
        pactWorkspace: createPactPairWorkspaceV1(),
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace: { creates: [], turns: [], closes: [], lifecycle },
        }),
        openLedger: lifecycleLedgerFactory(lifecycle, { failFinalize: true }),
      }),
      /PRIVATE_FAKE_LEDGER_FINALIZE_FAILURE/,
    );
    assert.deepEqual(lifecycle, [
      'turn:0:1',
      'session.close:0',
      'ledger.finalize',
      'ledger.close',
    ]);
    await assert.rejects(() => access(finalAuthorityPath(storeRoot)));

    const replayTrace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const result = await runPactPairFilesMultiV1({
      ...common,
      pactWorkspace: createPactPairWorkspaceV1(),
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace: replayTrace }),
    });
    assert.equal(result.stopReason, 'all_terminal');
    assert.equal(replayTrace.turns.length, 0);
    await access(finalAuthorityPath(storeRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lifecycle preserves an indeterminate primary error together with close cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-error-aggregate-'));
  const workspaceRootDir = join(root, 'workspaces');
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await mkdir(workspaceRootDir);
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'error-aggregate',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        storeRoot: join(root, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks: fileSessionQaTasksV1(['PAIR-Q1']),
        maxTicks: 1,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        pactWorkspace: createPactPairWorkspaceV1(),
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          failTurnForSessionIndexes: new Set([0]),
          failCloseForSessionIndexes: new Set([0]),
        }),
      }),
      error => error instanceof AggregateError
        && error.errors.length === 2
        && error.errors[0] instanceof Error
        && error.errors[0].name === 'FileDrivenPairIndeterminateExternalOperationErrorV1'
        && String(error.errors[1]).includes('PRIVATE_FAKE_SESSION_CLOSE_FAILURE'),
    );
    assert.equal(trace.turns.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ledger-open failure preserves the SharedOS close cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-workflow-open-aggregate-'));
  const workspaceRootDir = join(root, 'workspaces');
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await mkdir(workspaceRootDir);
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'open-error-aggregate',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        storeRoot: join(root, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks: fileSessionQaTasksV1(['PAIR-Q1']),
        maxTicks: 1,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        pactWorkspace: createPactPairWorkspaceV1(),
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          failCloseForSessionIndexes: new Set([0]),
        }),
        openLedger: async () => {
          throw new Error('PRIVATE_FAKE_LEDGER_OPEN_FAILURE');
        },
      }),
      error => error instanceof AggregateError
        && error.errors.length === 2
        && String(error.errors[0]).includes('PRIVATE_FAKE_LEDGER_OPEN_FAILURE')
        && String(error.errors[1]).includes('PRIVATE_FAKE_SESSION_CLOSE_FAILURE'),
    );
    assert.equal(trace.turns.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function lifecycleLedgerFactory(
  lifecycle: string[],
  faults: { failFinalize?: boolean } = {},
): typeof openFileWorkflowLedgerV1 {
  return async options => {
    const ledger = await openFileWorkflowLedgerV1(options);
    return {
      inspectRecovery: () => ledger.inspectRecovery(),
      beginHeartbeat: start => ledger.beginHeartbeat(start),
      commitHeartbeat: payload => ledger.commitHeartbeat(payload),
      commitQuarantine: () => ledger.commitQuarantine(),
      readRecords: () => ledger.readRecords(),
      repairPublicProjections: () => ledger.repairPublicProjections(),
      finalize: async final => {
        lifecycle.push('ledger.finalize');
        if (faults.failFinalize) throw new Error('PRIVATE_FAKE_LEDGER_FINALIZE_FAILURE');
        await ledger.finalize(final);
      },
      close: async () => {
        lifecycle.push('ledger.close');
        await ledger.close();
      },
    };
  };
}

function finalAuthorityPath(storeRoot: string): string {
  return join(storeRoot, FILE_WORKFLOW_INTERNAL_DIRECTORY_V1, 'final.json');
}
