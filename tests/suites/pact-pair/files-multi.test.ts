import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createFakeSharedOsFileSessionFactoryV1,
  fileSessionActorsV1,
  fileSessionQaTasksV1,
  fileSessionRegistryRootV1,
  fileWorkflowHostRunProvenanceFixtureV1,
  type FakeSharedOsFileSessionTraceV1,
  unreachableFileTurnDriverV1,
} from '../../runner-v1/file-workflow-test-fixtures.js';
import { runPactPairFilesMultiV1 } from '../../../src/suites/pact-pair/files-multi.js';
import { FileDrivenPairIndeterminateExternalOperationErrorV1 } from '../../../src/suites/pact-pair/file-workflow.js';
import {
  createPactPairWorkspaceV1,
  loadCanonicalPactPairStoreV1,
} from '../../../src/suites/pact-pair/workspace.js';
import type { SharedOsFileTurnResultV1 } from '../../../src/runner/v1/sharedos-file-session-contracts.js';

test('multi opens one SharedOS session and schedules every heartbeat through it', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-multi-session-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    const result = await runPactPairFilesMultiV1({
      runId: 'multi-sharedos-only',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      storeRoot: join(workspaceRootDir, 'store'),
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks,
      maxTicks: 2,
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace }),
    });

    assert.equal(trace.creates.length, 1);
    assert.equal(trace.creates[0]?.sessionIndex, 0);
    const namespaceId = (trace.creates[0] as { namespaceId?: string }).namespaceId;
    assert.equal(
      namespaceId,
      testStableId('namespace', ['namespace', 'multi-sharedos-only', 0]),
    );
    assert.equal(trace.creates[0]?.maxTicks, 2);
    assert.equal(trace.creates[0]?.maxToolCalls, 8);
    assert.deepEqual(trace.creates[0]?.tasks.map(task => task.taskId), [
      'PAIR-Q1',
      'PAIR-Q2',
    ]);
    assert.deepEqual(trace.turns.map(turn => turn.tick), [1, 2]);
    for (const turn of trace.turns) {
      assert.match(turn.inputDigest ?? '', /^[a-f0-9]{64}$/);
      assert.equal(
        turn.eventId,
        testStableId('heartbeat', [
          'heartbeat',
          namespaceId!,
          turn.tick,
          turn.inputDigest!,
        ]),
      );
      assert.equal(
        turn.traceId,
        testStableId('trace', ['trace', turn.eventId]),
      );
    }
    assert.deepEqual(trace.closes, [0]);
    assert.equal(result.stopReason, 'all_terminal');
    assert.deepEqual(result.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'refused'],
      ['PAIR-Q2', 'refused'],
    ]);
    assert.equal(result.contacts.length, 2);
    assert.ok(result.contacts.every(contact => /^message-[a-f0-9]{40}$/.test(
      contact.requestMessageId,
    )));
    assert.equal(result.final.requester.version, 2);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('multiTurn re-asks a refused-but-pending task and terminalizes it on the flip', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-multi-retry-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    const result = await runPactPairFilesMultiV1({
      runId: 'multi-retry-flip',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
      storeRoot: join(workspaceRootDir, 'store'),
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks,
      maxTicks: 3,
      multiTurn: { phase2StartTick: 2, finalizeTick: 3 },
      budget: { deadlineMs: 2_000, maxToolCalls: 8 },
      pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
        trace,
        // Tick 1: denied and kept pending; tick 2: the retry flips to answered.
        tickScript: [
          { taskId: 'PAIR-Q1', contactStatus: 'denied' },
          { taskId: 'PAIR-Q1', contactStatus: 'completed', memoryStatus: 'answered' },
        ],
      }),
    });

    assert.equal(result.stopReason, 'all_terminal');
    assert.deepEqual(trace.turns.map(turn => turn.tick), [1, 2]);
    assert.deepEqual(
      result.contacts.map(contact => [contact.tick, contact.taskId, contact.status]),
      [[1, 'PAIR-Q1', 'denied'], [2, 'PAIR-Q1', 'completed']],
    );
    assert.deepEqual(
      result.outcomes.map(outcome => [outcome.taskId, outcome.status, outcome.terminalTick]),
      [['PAIR-Q1', 'answered', 2]],
    );
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('an ungated files-multi run still refuses a repeated contact', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-multi-retry-ungated-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'multi-retry-ungated',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        storeRoot: join(workspaceRootDir, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks: fileSessionQaTasksV1(['PAIR-Q1']),
        maxTicks: 3,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          tickScript: [
            { taskId: 'PAIR-Q1', contactStatus: 'denied' },
            { taskId: 'PAIR-Q1', contactStatus: 'completed', memoryStatus: 'answered' },
          ],
        }),
      }),
      FileDrivenPairIndeterminateExternalOperationErrorV1,
    );
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

function testStableId(prefix: string, tuple: unknown[]): string {
  return `${prefix}-${createHash('sha256')
    .update(JSON.stringify(tuple))
    .digest('hex')
    .slice(0, 40)}`;
}

test('treats malformed, inconsistent, or reused post-start SharedOS evidence as indeterminate', async t => {
  const wrongMessageId = `message-${'0'.repeat(40)}`;
  const wrongExecutionId = `execution-${'0'.repeat(40)}`;
  const cases: Array<Readonly<{
    name: string;
    taskIds: readonly string[];
    mutate(
      result: SharedOsFileTurnResultV1,
      index: number,
      first: SharedOsFileTurnResultV1 | undefined,
    ): SharedOsFileTurnResultV1;
  }>> = [
    {
      name: 'empty request message ID',
      taskIds: ['PAIR-Q1'],
      mutate: result => withContact(result, { requestMessageId: '' }),
    },
    {
      name: 'reply not derived from request',
      taskIds: ['PAIR-Q1'],
      mutate: result => withContact(result, { replyMessageId: wrongMessageId }),
    },
    {
      name: 'responder execution not derived from request',
      taskIds: ['PAIR-Q1'],
      mutate: result => withContact(result, { responderExecutionId: wrongExecutionId }),
    },
    {
      name: 'failed contact carries a reply that cannot exist',
      taskIds: ['PAIR-Q1'],
      mutate: result => withContact(result, { status: 'failed' }),
    },
    {
      name: 'cancelled contact carries a reply that cannot exist',
      taskIds: ['PAIR-Q1'],
      mutate: result => withContact(result, { status: 'cancelled' }),
    },
    {
      name: 'requester execution not derived from heartbeat',
      taskIds: ['PAIR-Q1'],
      mutate: result => ({ ...result, executionId: wrongExecutionId }),
    },
    {
      name: 'contact IDs reused by a later task',
      taskIds: ['PAIR-Q1', 'PAIR-Q2'],
      mutate: (result, index, first) => index === 0 || !first?.contact
        ? result
        : withContact(result, {
          requestMessageId: first.contact.requestMessageId,
          replyMessageId: first.contact.replyMessageId,
          responderExecutionId: first.contact.responderExecutionId,
        }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-contact-causality-'));
      const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
      const baseFactory = createFakeSharedOsFileSessionFactoryV1({ trace });
      let index = 0;
      let first: SharedOsFileTurnResultV1 | undefined;
      try {
        await assert.rejects(
          () => runPactPairFilesMultiV1({
            runId: `contact-causality-${fixture.name.replaceAll(' ', '-')}`,
            workspaceRootDir,
            registryRootDir: fileSessionRegistryRootV1,
            runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
            storeRoot: join(workspaceRootDir, 'store'),
            requester: fileSessionActorsV1.requester,
            responder: fileSessionActorsV1.responder,
            tasks: fileSessionQaTasksV1(fixture.taskIds),
            maxTicks: fixture.taskIds.length,
            budget: { deadlineMs: 2_000, maxToolCalls: 8 },
            pactWorkspace: createPactPairWorkspaceV1(),
            createDriver: unreachableFileTurnDriverV1,
            createSharedOsSession: async options => {
              const session = await baseFactory(options);
              return {
                ...session,
                runRequesterTurn: async turn => {
                  const original = await session.runRequesterTurn(turn);
                  const mutated = fixture.mutate(original, index, first);
                  first ??= original;
                  index += 1;
                  return mutated;
                },
              };
            },
          }),
          FileDrivenPairIndeterminateExternalOperationErrorV1,
        );
      } finally {
        await rm(workspaceRootDir, { recursive: true, force: true });
      }
    });
  }
});

function withContact(
  result: SharedOsFileTurnResultV1,
  replacement: Partial<NonNullable<SharedOsFileTurnResultV1['contact']>>,
): SharedOsFileTurnResultV1 {
  assert.ok(result.contact);
  return { ...result, contact: { ...result.contact, ...replacement } };
}

test('the retained scheduler has no harness, contact-port, or local tool-loop dependency', async () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const source = await readFile(
    join(repoRoot, 'src', 'suites', 'pact-pair', 'file-workflow.ts'),
    'utf8',
  );

  assert.doesNotMatch(source, /contact-agent|file-harness/);
  assert.doesNotMatch(source, /createInProcessContactAgentPortV1|runFreshFileTurnV1/);
  assert.match(source, /SharedOsFileSessionFactoryV1/);
  assert.match(source, /runRequesterTurn/);
});

test('multi closes its SharedOS session and stops on an indeterminate failed turn', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-multi-failure-'));
  const tasks = fileSessionQaTasksV1(['PAIR-Q1']);
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };

  try {
    await assert.rejects(
      () => runPactPairFilesMultiV1({
        runId: 'multi-contained-failure',
        workspaceRootDir,
        registryRootDir: fileSessionRegistryRootV1,
        runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
        storeRoot: join(workspaceRootDir, 'store'),
        requester: fileSessionActorsV1.requester,
        responder: fileSessionActorsV1.responder,
        tasks,
        maxTicks: 3,
        budget: { deadlineMs: 2_000, maxToolCalls: 8 },
        pactWorkspace: createPactPairWorkspaceV1(),
        createDriver: unreachableFileTurnDriverV1,
        createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({
          trace,
          failTurnForSessionIndexes: new Set([0]),
        }),
      }),
      FileDrivenPairIndeterminateExternalOperationErrorV1,
    );
    assert.deepEqual(trace.turns.map(turn => turn.tick), [1]);
    assert.deepEqual(trace.closes, [0]);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});
