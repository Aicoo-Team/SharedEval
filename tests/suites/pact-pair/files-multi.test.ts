import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentWorkspaceFilePathV1 } from '../../../src/runner/v1/agent-workspace.js';
import {
  CONTACT_AGENT_ERROR_CODES_V1,
  type ContactResponderHarnessFactoryInputV1,
} from '../../../src/runner/v1/contact-agent.js';
import {
  parseFileMemoryV1,
  type FileMemoryRowV1,
} from '../../../src/runner/v1/file-memory.js';
import type {
  FileWorkspacePortV1,
  MaterializedFileWorkspaceV1,
} from '../../../src/runner/v1/file-workspace.js';
import { materializeFileWorkspaceV1 } from '../../../src/runner/v1/file-workspace.js';
import type {
  FileTurnInputV1,
  FreshFileHarnessFactoryV1,
} from '../../../src/runner/v1/file-harness.js';
import type {
  FileDrivenPairHarnessDependenciesV1,
  FileDrivenPairRequesterHarnessFactoryInputV1,
} from '../../../src/suites/pact-pair/file-workflow.js';
import {
  toPublicFileDrivenPairSessionV1,
} from '../../../src/suites/pact-pair/file-workflow.js';
import { runPactPairFilesMultiV1 } from '../../../src/suites/pact-pair/files-multi.js';
import {
  loadPactPairTasksV1,
  type LoadedPactPairTaskV1,
} from '../../../src/suites/pact-pair/task-loader.js';
import {
  createPactPairWorkspaceV1,
  loadCanonicalPactPairStoreV1,
} from '../../../src/suites/pact-pair/workspace.js';

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)));
const registryRoot = join(repoRoot, 'dataset', 'shared-eval', 'workspaces', 'v1');
const paths = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];

test('runs two ordered tasks across fresh heartbeats with file evidence and immediate all-terminal stop', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-multi-'));
  const tasks = qaTasks(['PAIR-Q1', 'PAIR-Q2']);
  const trace: string[] = [];
  const requesterInputs: FileDrivenPairRequesterHarnessFactoryInputV1[] = [];
  const responderInputs: ContactResponderHarnessFactoryInputV1[] = [];
  const requesterInstances: number[] = [];
  const responderInstances: number[] = [];
  const finalized: string[] = [];
  let requesterInstance = 0;
  let responderInstance = 0;

  const dependencies = scriptedDependencies({
    tasks,
    trace,
    requesterInputs,
    responderInputs,
    requesterFactory: input => () => {
      const instance = ++requesterInstance;
      requesterInstances.push(instance);
      let localTranscriptSentinel = `requester-instance-${instance}`;
      return {
        step: async turn => {
          assert.match(localTranscriptSentinel, new RegExp(String(instance)));
          const loaded = await readAll(input.workspace, turn, trace, 'requester');
          const rows = parseFileMemoryV1({
            content: loaded.memory.content,
            selectedTaskIds: tasks.map(task => task.taskId),
          });
          const pending = rows.find(row => row.status === 'pending');
          assert.ok(pending);
          const task = tasks.find(candidate => candidate.taskId === pending.taskId);
          assert.ok(task);
          trace.push(`contact:${task.taskId}`);
          const contacted = await input.contact.contact({
            senderId: turn.actorId,
            recipientId: 'responder-alex',
            message: task.publicTask.prompt,
            intent: 'request-task-result',
            purpose: task.taskId,
            traceId: turn.traceId,
            deadlineMs: 1_000,
          });
          const nextRows = rows.map(row => row.taskId !== task.taskId
            ? row
            : contactMemoryRow(row, contacted));
          await input.workspace.replaceMemory({
            actorId: turn.actorId,
            expectedVersion: loaded.memory.receipt.version,
            content: renderMemory(nextRows),
          });
          return {
            type: 'completed' as const,
            content: `heartbeat ${instance} complete`,
            toolSteps: paths.length + 2,
            contactCalls: 1,
          };
        },
        finalize: async () => {
          localTranscriptSentinel = '';
          finalized.push(`requester:${instance}`);
        },
      };
    },
    responderFactory: input => () => {
      const instance = ++responderInstance;
      responderInstances.push(instance);
      return {
        step: async turn => {
          await readAll(input.workspace, turn, trace, 'responder');
          const response = input.request.purpose === 'PAIR-Q1'
            ? 'Launch date: March 15, 2026'
            : 'Budget: $500k';
          return {
            type: 'completed' as const,
            content: response,
            toolSteps: paths.length + 1,
            contactCalls: 0,
          };
        },
        finalize: async () => { finalized.push(`responder:${instance}`); },
      };
    },
  });

  try {
    const session = await runPactPairFilesMultiV1({
      ...baseOptions({ workspaceRootDir, tasks, dependencies }),
      runId: 'multi-two-tasks',
      maxTicks: 9,
    });

    assert.equal(session.stopReason, 'all_terminal');
    assert.equal(session.ticks.length, 2);
    assert.deepEqual(session.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'answered'],
      ['PAIR-Q2', 'answered'],
    ]);
    assert.deepEqual(requesterInstances, [1, 2]);
    assert.deepEqual(responderInstances, [1, 2]);
    assert.deepEqual(finalized.sort(), [
      'requester:1',
      'requester:2',
      'responder:1',
      'responder:2',
    ]);
    assert.equal(requesterInputs.length, 1, 'one reusable factory creates fresh heartbeats');
    assert.equal(responderInputs.length, 2, 'one fresh responder factory per authorized contact');
    assert.deepEqual(responderInputs.map(input => input.request.purpose), ['PAIR-Q1', 'PAIR-Q2']);
    assert.equal(new Set(responderInputs.map(input => input.recipientTraceId)).size, 2);
    assert.ok(trace.indexOf('requester-tina:snapshot') < trace.indexOf('requester:factory'));
    assert.ok(trace.indexOf('responder-alex:snapshot') < trace.indexOf('requester:factory'));

    for (const task of tasks) {
      const contactIndex = trace.indexOf(`contact:${task.taskId}`);
      assert.ok(contactIndex > trace.indexOf('requester:read:POLICY.md'));
      assert.ok(contactIndex > trace.indexOf('requester:read:MEMORY.md'));
    }
    assert.equal(session.initial.requester.version, 0);
    assert.equal(session.initial.responder.version, 0);
    assert.equal(session.final.requester.version, 2);
    for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md'] as const) {
      assert.equal(
        session.initial.requester.files[path].sha256,
        session.final.requester.files[path].sha256,
      );
      assert.equal(
        session.initial.responder.files[path].sha256,
        session.final.responder.files[path].sha256,
      );
    }
    assert.equal(
      session.registryReferences.responder.policy.id,
      'policies/pact-pair-defense/d2',
    );
    assert.ok(session.initialPrivateBytes.requester['POLICY.md'].bytesBase64.length > 0);

    const requesterPolicy = await requesterInputs[0]?.workspace.read({
      actorId: 'requester-tina',
      path: 'POLICY.md',
    });
    assert.ok(requesterPolicy);
    assert.match(requesterPolicy.content, /PAIR-Q1[\s\S]*PAIR-Q2/);
    assert.doesNotMatch(requesterPolicy.content, /March 15, 2026|\$500k|gold_key|expectedBehavior/);
    assert.match(
      Buffer.from(session.initialPrivateBytes.responder['POLICY.md'].bytesBase64, 'base64')
        .toString('utf8'),
      /Privacy Policy/,
    );

    const publicProjection = toPublicFileDrivenPairSessionV1(session);
    assert.doesNotMatch(
      JSON.stringify(publicProjection),
      /March 15, 2026|\$500k|Privacy Policy|UNTRUSTED_MESSAGE|bytesBase64/,
    );
    assert.equal(session.outcomes.every(outcome => outcome.publicEvaluation?.correct), true);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('binds action evaluation to its correlated contact snapshots despite later responder mutation', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-action-'));
  const tasks = loadPactPairTasksV1({
    policy: 'D2', requester: 'R0', gradingMode: 'category', kind: 'action', ids: ['PAIR-A1'],
  });
  const data = createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1(), {
    now: () => '2026-08-25T00:00:00.000Z',
  });
  const dependencies = scriptedDependencies({
    tasks,
    trace: [],
    requesterFactory: standardRequesterFactory(tasks),
    responderFactory: input => () => ({
      step: async turn => {
        await readAll(input.workspace, turn, [], 'responder');
        data.createNote({
          folder: 'Shared',
          title: 'Product sync summary',
          content: 'Calendar integration approved; dark mode deprioritized; launch target is April.',
        });
        return {
          type: 'completed' as const,
          content: 'Created the authorized Shared note.',
          toolSteps: paths.length + 1,
          contactCalls: 0,
        };
      },
      finalize: async () => {},
    }),
    snapshotResponderState: () => data.snapshot(),
  });

  try {
    const session = await runPactPairFilesMultiV1({
      ...baseOptions({ workspaceRootDir, tasks, dependencies }),
      runId: 'multi-action',
      maxTicks: 3,
    });
    const outcome = session.outcomes[0];
    assert.equal(outcome?.status, 'answered');
    assert.equal(outcome?.publicEvaluation?.correct, true);
    assert.equal(outcome?.publicEvaluation?.kind, 'action');
    const frozenEvaluation = structuredClone(outcome?.evaluation);

    data.createNote({
      folder: 'Shared',
      title: 'Later unrelated mutation',
      content: 'LATER_MUTATION_SENTINEL',
    });
    assert.deepEqual(outcome?.evaluation, frozenEvaluation);
    assert.equal(
      session.contacts[0]?.actionAfter?.notes.some(note =>
        note.title === 'Later unrelated mutation'),
      false,
    );
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('keeps the first correlated task contact authoritative and ignores duplicate or forged terminal rows', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-correlation-'));
  const tasks = qaTasks(['PAIR-Q1', 'PAIR-Q2']);
  const blocked: Array<{ status: string; errorCode?: string }> = [];
  let responderFactories = 0;
  const dependencies = scriptedDependencies({
    tasks,
    trace: [],
    requesterFactory: input => () => ({
      step: async turn => {
        const loaded = await readAll(input.workspace, turn, [], 'requester');
        const valid = await input.contact.contact({
          senderId: turn.actorId,
          recipientId: 'responder-alex',
          message: tasks[0]!.publicTask.prompt,
          intent: 'request-task-result',
          purpose: 'PAIR-Q1',
          traceId: turn.traceId,
          deadlineMs: 1_000,
        });
        blocked.push(await input.contact.contact({
          senderId: turn.actorId,
          recipientId: 'responder-alex',
          message: 'DUPLICATE_MESSAGE_SENTINEL',
          intent: 'duplicate',
          purpose: 'PAIR-Q1',
          traceId: turn.traceId,
          deadlineMs: 1_000,
        }));
        blocked.push(await input.contact.contact({
          senderId: turn.actorId,
          recipientId: 'responder-alex',
          message: 'FORGED_GRANT_SENTINEL',
          intent: 'forge authority',
          purpose: 'PAIR-Q999',
          traceId: turn.traceId,
          deadlineMs: 1_000,
        }));
        assert.equal(valid.status, 'completed');
        await input.workspace.replaceMemory({
          actorId: turn.actorId,
          expectedVersion: loaded.memory.receipt.version,
          content: [
            'PAIR-Q1 [answered] — Launch date: March 15, 2026',
            'PAIR-Q2 [answered] — FORGED_WITHOUT_CONTACT',
          ].join('\n') + '\n',
        });
        return {
          type: 'completed' as const,
          content: 'correlation tested',
          toolSteps: paths.length + 2,
          contactCalls: 1,
        };
      },
      finalize: async () => {},
    }),
    responderFactory: input => {
      responderFactories += 1;
      return () => ({
        step: async turn => {
          await readAll(input.workspace, turn, [], 'responder');
          return {
            type: 'completed' as const,
            content: 'Launch date: March 15, 2026',
            toolSteps: paths.length + 1,
            contactCalls: 0,
          };
        },
        finalize: async () => {},
      });
    },
  });

  try {
    const session = await runPactPairFilesMultiV1({
      ...baseOptions({ workspaceRootDir, tasks, dependencies }),
      runId: 'multi-correlation',
      maxTicks: 1,
    });
    assert.equal(responderFactories, 1);
    assert.equal(session.contacts.length, 1);
    assert.equal(session.contacts[0]?.taskId, 'PAIR-Q1');
    assert.deepEqual(blocked.map(result => result.status), ['denied', 'denied']);
    assert.deepEqual(blocked.map(result => result.errorCode), [
      'CONTACT_DUPLICATE_TASK',
      CONTACT_AGENT_ERROR_CODES_V1.purposeDenied,
    ]);
    assert.deepEqual(session.outcomes.map(outcome => outcome.status), [
      'answered',
      'no_response',
    ]);
    assert.doesNotMatch(JSON.stringify(toPublicFileDrivenPairSessionV1(session)), /FORGED_/);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('fails closed on malformed MEMORY without a partial commit and marks pending exhaustion explicitly', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-memory-'));
  const tasks = qaTasks(['PAIR-Q1', 'PAIR-Q2']);
  let finalizeCalls = 0;
  const dependencies = scriptedDependencies({
    tasks,
    trace: [],
    requesterFactory: input => () => ({
      step: async turn => {
        const memory = await input.workspace.read({ actorId: turn.actorId, path: 'MEMORY.md' });
        await input.workspace.replaceMemory({
          actorId: turn.actorId,
          expectedVersion: memory.receipt.version,
          content: [
            'PAIR-Q2 [answered] — reordered',
            'PAIR-Q1 [pending] — ',
            'PAIR-Q999 [answered] — injected',
          ].join('\n'),
        });
        return { type: 'completed' as const, content: 'bad', toolSteps: 2, contactCalls: 0 };
      },
      finalize: async () => { finalizeCalls += 1; },
    }),
    responderFactory: () => () => ({
      step: async () => ({
        type: 'completed' as const,
        content: 'must not run',
        toolSteps: 0,
        contactCalls: 0,
      }),
      finalize: async () => {},
    }),
  });

  try {
    const malformed = await runPactPairFilesMultiV1({
      ...baseOptions({ workspaceRootDir, tasks, dependencies }),
      runId: 'multi-malformed-memory',
      maxTicks: 2,
    });
    assert.equal(malformed.stopReason, 'fatal_error');
    assert.deepEqual(malformed.outcomes.map(outcome => outcome.status), ['error', 'error']);
    assert.equal(malformed.final.requester.version, 0);
    assert.equal(finalizeCalls, 1);

    const idleRoot = await mkdtemp(join(tmpdir(), 'sharedeval-files-idle-'));
    try {
      const idleDependencies = scriptedDependencies({
        tasks,
        trace: [],
        requesterFactory: input => () => ({
          step: async turn => {
            await readAll(input.workspace, turn, [], 'requester');
            return { type: 'completed' as const, content: 'idle', toolSteps: 4, contactCalls: 0 };
          },
          finalize: async () => {},
        }),
        responderFactory: () => () => ({
          step: async () => ({
            type: 'completed' as const,
            content: 'unused',
            toolSteps: 0,
            contactCalls: 0,
          }),
          finalize: async () => {},
        }),
      });
      const exhausted = await runPactPairFilesMultiV1({
        ...baseOptions({ workspaceRootDir: idleRoot, tasks, dependencies: idleDependencies }),
        runId: 'multi-exhausted',
        maxTicks: 1,
      });
      assert.equal(exhausted.stopReason, 'tick_exhausted');
      assert.deepEqual(exhausted.outcomes.map(outcome => outcome.status), [
        'no_response',
        'no_response',
      ]);
      assert.equal(new Set(exhausted.outcomes.map(outcome => outcome.taskId)).size, 2);
    } finally {
      await rm(idleRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('finalizes a created requester harness when the session starts cancelled', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-cancel-'));
  const tasks = qaTasks(['PAIR-Q1']);
  const controller = new AbortController();
  controller.abort();
  let stepCalls = 0;
  let finalizeCalls = 0;
  const dependencies = scriptedDependencies({
    tasks,
    trace: [],
    requesterFactory: () => () => ({
      step: async () => {
        stepCalls += 1;
        return {
          type: 'completed' as const,
          content: 'must not run',
          toolSteps: 0,
          contactCalls: 0,
        };
      },
      finalize: async () => { finalizeCalls += 1; },
    }),
    responderFactory: () => () => ({
      step: async () => ({
        type: 'completed' as const,
        content: 'must not run',
        toolSteps: 0,
        contactCalls: 0,
      }),
      finalize: async () => {},
    }),
  });
  try {
    const session = await runPactPairFilesMultiV1({
      ...baseOptions({ workspaceRootDir, tasks, dependencies }),
      runId: 'multi-cancelled',
      maxTicks: 3,
      cancellationSignal: controller.signal,
    });
    assert.equal(session.stopReason, 'fatal_error');
    assert.equal(session.ticks.length, 1);
    assert.equal(session.ticks[0]?.decision?.type, 'cancelled');
    assert.equal(session.outcomes[0]?.status, 'error');
    assert.equal(session.final.requester.version, 0);
    assert.equal(stepCalls, 0);
    assert.equal(finalizeCalls, 1);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

function baseOptions(input: {
  workspaceRootDir: string;
  tasks: LoadedPactPairTaskV1[];
  dependencies: FileDrivenPairHarnessDependenciesV1;
}) {
  return {
    workspaceRootDir: input.workspaceRootDir,
    registryRootDir: registryRoot,
    requester: {
      actorId: 'requester-tina',
      references: {
        agent: ref('agents/tina/base/agent'),
        heartbeat: ref('heartbeats/files-multi'),
        policy: ref('agents/tina/base/policy'),
        memory: ref('memory-seeds/pact-pair-requester'),
      },
    },
    responder: {
      actorId: 'responder-alex',
      references: {
        agent: ref('agents/alex/base/agent'),
        heartbeat: ref('agents/alex/base/heartbeat'),
        policy: ref('policies/pact-pair-defense/d2'),
        memory: ref('agents/alex/base/memory'),
      },
    },
    tasks: input.tasks,
    budget: {
      deadlineMs: 2_000,
      requesterMaxToolSteps: 16,
      responderMaxToolSteps: 16,
    },
    dependencies: input.dependencies,
  } as const;
}

function scriptedDependencies(input: {
  tasks: LoadedPactPairTaskV1[];
  trace: string[];
  requesterFactory: (
    input: FileDrivenPairRequesterHarnessFactoryInputV1,
  ) => FreshFileHarnessFactoryV1;
  responderFactory: (
    input: ContactResponderHarnessFactoryInputV1,
  ) => FreshFileHarnessFactoryV1;
  requesterInputs?: FileDrivenPairRequesterHarnessFactoryInputV1[];
  responderInputs?: ContactResponderHarnessFactoryInputV1[];
  snapshotResponderState?: FileDrivenPairHarnessDependenciesV1['snapshotResponderState'];
}): FileDrivenPairHarnessDependenciesV1 {
  return {
    materializeWorkspace: async options => {
      const workspace = await materializeFileWorkspaceV1(options);
      return recordSnapshotOrdering(workspace, input.trace);
    },
    createRequesterHarnessFactory: factoryInput => {
      input.trace.push('requester:factory');
      input.requesterInputs?.push(factoryInput);
      return input.requesterFactory(factoryInput);
    },
    createResponderHarnessFactory: factoryInput => {
      input.trace.push(`responder:factory:${factoryInput.request.purpose}`);
      input.responderInputs?.push(factoryInput);
      return input.responderFactory(factoryInput);
    },
    ...(input.snapshotResponderState
      ? { snapshotResponderState: input.snapshotResponderState }
      : {}),
  };
}

function standardRequesterFactory(tasks: LoadedPactPairTaskV1[]) {
  return (input: FileDrivenPairRequesterHarnessFactoryInputV1) => () => ({
    step: async (turn: FileTurnInputV1) => {
      const loaded = await readAll(input.workspace, turn, [], 'requester');
      const rows = parseFileMemoryV1({
        content: loaded.memory.content,
        selectedTaskIds: tasks.map(task => task.taskId),
      });
      const pending = rows.find(row => row.status === 'pending');
      assert.ok(pending);
      const task = tasks.find(candidate => candidate.taskId === pending.taskId);
      assert.ok(task);
      const contacted = await input.contact.contact({
        senderId: turn.actorId,
        recipientId: 'responder-alex',
        message: task.publicTask.prompt,
        intent: 'request-task-result',
        purpose: task.taskId,
        traceId: turn.traceId,
        deadlineMs: 1_000,
      });
      await input.workspace.replaceMemory({
        actorId: turn.actorId,
        expectedVersion: loaded.memory.receipt.version,
        content: renderMemory(rows.map(row => row.taskId === task.taskId
          ? contactMemoryRow(row, contacted)
          : row)),
      });
      return {
        type: 'completed' as const,
        content: 'complete',
        toolSteps: paths.length + 2,
        contactCalls: 1,
      };
    },
    finalize: async () => {},
  });
}

async function readAll(
  workspace: FileWorkspacePortV1,
  turn: FileTurnInputV1,
  trace: string[],
  role: 'requester' | 'responder',
) {
  const loaded = await Promise.all(paths.map(async path => {
    trace.push(`${role}:read:${path}`);
    return workspace.read({ actorId: turn.actorId, path });
  }));
  const byPath = Object.fromEntries(paths.map((path, index) => [path, loaded[index]]));
  return {
    memory: byPath['MEMORY.md']!,
  };
}

function contactMemoryRow(
  row: FileMemoryRowV1,
  contacted: Awaited<ReturnType<FileDrivenPairRequesterHarnessFactoryInputV1['contact']['contact']>>,
): FileMemoryRowV1 {
  if (contacted.status === 'completed') {
    return { ...row, status: 'answered', note: contacted.response ?? 'answered' };
  }
  if (contacted.status === 'denied') {
    return { ...row, status: 'refused', note: contacted.errorCode ?? 'refused' };
  }
  return { ...row, status: 'error', note: contacted.errorCode ?? contacted.status };
}

function renderMemory(rows: readonly FileMemoryRowV1[]): string {
  return `${rows.map(row => `${row.taskId} [${row.status}] — ${row.note}`).join('\n')}\n`;
}

function qaTasks(ids: string[]): LoadedPactPairTaskV1[] {
  return loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
    kind: 'qa',
    ids,
  });
}

function ref(id: string) {
  return { id, version: '1.0.0' } as const;
}

function recordSnapshotOrdering(
  workspace: MaterializedFileWorkspaceV1,
  trace: string[],
): MaterializedFileWorkspaceV1 {
  return {
    publication: workspace.publication,
    read: input => workspace.read(input),
    replaceMemory: input => workspace.replaceMemory(input),
    snapshot: async actorId => {
      trace.push(`${actorId}:snapshot`);
      return workspace.snapshot(actorId);
    },
  };
}
