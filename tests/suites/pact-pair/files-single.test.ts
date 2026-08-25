import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentWorkspaceFilePathV1 } from '../../../src/runner/v1/agent-workspace.js';
import type { ContactResponderHarnessFactoryInputV1 } from '../../../src/runner/v1/contact-agent.js';
import {
  parseFileMemoryV1,
  type FileMemoryRowV1,
} from '../../../src/runner/v1/file-memory.js';
import type { FileTurnInputV1 } from '../../../src/runner/v1/file-harness.js';
import type {
  FileDrivenPairHarnessDependenciesV1,
  FileDrivenPairRequesterHarnessFactoryInputV1,
} from '../../../src/suites/pact-pair/file-workflow.js';
import { runPactPairFilesSingleV1 } from '../../../src/suites/pact-pair/files-single.js';
import {
  loadPactPairTasksV1,
  type LoadedPactPairTaskV1,
} from '../../../src/suites/pact-pair/task-loader.js';

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)));
const registryRoot = join(repoRoot, 'dataset', 'shared-eval', 'workspaces', 'v1');
const paths = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];

test('isolates every selected task into independent roots, memory lineages, traces, and factories', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-single-'));
  const tasks = qaTasks(['PAIR-Q1', 'PAIR-Q2']);
  const requesterFactoryCalls: string[] = [];
  const responderFactoryCalls: string[] = [];
  const requesterInstances: string[] = [];
  const responderInstances: string[] = [];
  const observedInitialMemories: string[] = [];
  const observedTraceIds: string[] = [];

  try {
    const batch = await runPactPairFilesSingleV1({
      ...baseOptions({ workspaceRootDir, tasks }),
      runId: 'single-two-tasks',
      dependenciesForTask: task => {
        const dependencies = successfulDependencies({
          task,
          onRequesterFactory: () => requesterFactoryCalls.push(task.taskId),
          onResponderFactory: () => responderFactoryCalls.push(task.taskId),
          onRequesterInstance: () => requesterInstances.push(task.taskId),
          onResponderInstance: () => responderInstances.push(task.taskId),
          onInitialMemory: memory => observedInitialMemories.push(memory),
          onTrace: traceId => observedTraceIds.push(traceId),
        });
        return dependencies;
      },
    });

    assert.equal(batch.workflowId, 'files-single');
    assert.equal(batch.sessions.length, 2);
    assert.deepEqual(batch.outcomes.map(outcome => [outcome.taskId, outcome.status]), [
      ['PAIR-Q1', 'answered'],
      ['PAIR-Q2', 'answered'],
    ]);
    assert.deepEqual(requesterFactoryCalls, ['PAIR-Q1', 'PAIR-Q2']);
    assert.deepEqual(responderFactoryCalls, ['PAIR-Q1', 'PAIR-Q2']);
    assert.deepEqual(requesterInstances, ['PAIR-Q1', 'PAIR-Q2']);
    assert.deepEqual(responderInstances, ['PAIR-Q1', 'PAIR-Q2']);
    assert.equal(new Set(batch.sessions.map(session => session.runId)).size, 2);
    assert.equal(new Set(observedTraceIds).size, 2);
    assert.deepEqual(observedInitialMemories, [
      'PAIR-Q1 [pending] — \n',
      'PAIR-Q2 [pending] — \n',
    ]);
    assert.deepEqual(batch.sessions.map(session => session.initial.requester.version), [0, 0]);
    assert.deepEqual(batch.sessions.map(session => session.final.requester.version), [1, 1]);
    for (const [index, session] of batch.sessions.entries()) {
      const task = tasks[index];
      assert.ok(task);
      const other = tasks[1 - index];
      assert.ok(other);
      const policy = Buffer.from(
        session.initialPrivateBytes.requester['POLICY.md'].bytesBase64,
        'base64',
      ).toString('utf8');
      assert.match(policy, new RegExp(task.taskId));
      assert.doesNotMatch(policy, new RegExp(other.taskId));
      assert.deepEqual(session.selectedTaskIds, [task.taskId]);
      assert.equal(session.ticks.length, 1, 'single defaults to one heartbeat');
    }
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('contains one task failure and still runs the next isolated task', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-single-failure-'));
  const tasks = qaTasks(['PAIR-Q1', 'PAIR-Q2']);
  let failedFinalizeCalls = 0;
  let secondRequesterCalls = 0;

  try {
    const batch = await runPactPairFilesSingleV1({
      ...baseOptions({ workspaceRootDir, tasks }),
      runId: 'single-contained-failure',
      maxTicks: 2,
      dependenciesForTask: task => task.taskId === 'PAIR-Q1'
        ? {
          createRequesterHarnessFactory: () => () => ({
            step: async () => { throw new Error('PRIVATE_FAILURE_SENTINEL'); },
            finalize: async () => { failedFinalizeCalls += 1; },
          }),
          createResponderHarnessFactory: () => () => ({
            step: async () => ({
              type: 'completed' as const,
              content: 'unused',
              toolSteps: 0,
              contactCalls: 0,
            }),
            finalize: async () => {},
          }),
        }
        : successfulDependencies({
          task,
          onRequesterInstance: () => { secondRequesterCalls += 1; },
        }),
    });

    assert.equal(batch.sessions.length, 2);
    assert.equal(batch.sessions[0]?.stopReason, 'fatal_error');
    assert.equal(batch.sessions[0]?.ticks.length, 1);
    assert.equal(batch.sessions[0]?.ticks[0]?.status, 'failed');
    assert.equal(batch.outcomes[0]?.status, 'error');
    assert.equal(batch.outcomes[0]?.evaluation, null);
    assert.equal(batch.outcomes[0]?.evaluationResult, null);
    assert.equal(batch.outcomes[0]?.publicEvaluation, null);
    assert.equal(batch.sessions[1]?.stopReason, 'all_terminal');
    assert.equal(batch.outcomes[1]?.status, 'answered');
    assert.equal(failedFinalizeCalls, 1);
    assert.equal(secondRequesterCalls, 1);
    assert.doesNotMatch(JSON.stringify(batch.publicProjection), /PRIVATE_FAILURE_SENTINEL/);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('bounds explicit retry ticks and emits exactly one no-response per isolated task', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-files-single-idle-'));
  const tasks = qaTasks(['PAIR-Q1', 'PAIR-Q2']);
  const ticksByTask = new Map<string, number>();
  try {
    const batch = await runPactPairFilesSingleV1({
      ...baseOptions({ workspaceRootDir, tasks }),
      runId: 'single-exhausted',
      maxTicks: 2,
      dependenciesForTask: task => ({
        createRequesterHarnessFactory: input => () => ({
          step: async turn => {
            ticksByTask.set(task.taskId, (ticksByTask.get(task.taskId) ?? 0) + 1);
            await readAll(input.workspace, turn);
            return {
              type: 'completed' as const,
              content: 'no contact',
              toolSteps: paths.length,
              contactCalls: 0,
            };
          },
          finalize: async () => {},
        }),
        createResponderHarnessFactory: () => () => ({
          step: async () => ({
            type: 'completed' as const,
            content: 'unused',
            toolSteps: 0,
            contactCalls: 0,
          }),
          finalize: async () => {},
        }),
      }),
    });

    assert.deepEqual([...ticksByTask.entries()], [['PAIR-Q1', 2], ['PAIR-Q2', 2]]);
    assert.deepEqual(batch.outcomes.map(outcome => outcome.status), [
      'no_response',
      'no_response',
    ]);
    assert.equal(batch.outcomes.every(outcome => outcome.evaluation === null), true);
    assert.equal(batch.outcomes.every(outcome => outcome.evaluationResult === null), true);
    assert.equal(batch.outcomes.every(outcome => outcome.publicEvaluation === null), true);
    assert.equal(new Set(batch.outcomes.map(outcome => outcome.taskId)).size, 2);
    await assert.rejects(
      () => runPactPairFilesSingleV1({
        ...baseOptions({ workspaceRootDir, tasks }),
        runId: 'single-invalid-zero',
        maxTicks: 0,
        dependenciesForTask: task => successfulDependencies({ task }),
      }),
      /maxTicks must be a positive safe integer/,
    );
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

function successfulDependencies(input: {
  task: LoadedPactPairTaskV1;
  onRequesterFactory?: () => void;
  onResponderFactory?: () => void;
  onRequesterInstance?: () => void;
  onResponderInstance?: () => void;
  onInitialMemory?: (memory: string) => void;
  onTrace?: (traceId: string) => void;
}): FileDrivenPairHarnessDependenciesV1 {
  return {
    createRequesterHarnessFactory: factoryInput => {
      input.onRequesterFactory?.();
      return requesterFactory(factoryInput, input);
    },
    createResponderHarnessFactory: factoryInput => {
      input.onResponderFactory?.();
      return responderFactory(factoryInput, input);
    },
  };
}

function requesterFactory(
  factoryInput: FileDrivenPairRequesterHarnessFactoryInputV1,
  options: Parameters<typeof successfulDependencies>[0],
) {
  return () => {
    options.onRequesterInstance?.();
    return {
      step: async (turn: FileTurnInputV1) => {
        options.onTrace?.(turn.traceId);
        const memory = await readAll(factoryInput.workspace, turn);
        options.onInitialMemory?.(memory.content);
        const rows = parseFileMemoryV1({
          content: memory.content,
          selectedTaskIds: [options.task.taskId],
        });
        const contacted = await factoryInput.contact.contact({
          senderId: turn.actorId,
          recipientId: 'responder-alex',
          message: options.task.publicTask.prompt,
          intent: 'request-task-result',
          purpose: options.task.taskId,
          traceId: turn.traceId,
          deadlineMs: 1_000,
        });
        const next: FileMemoryRowV1[] = rows.map(row => ({
          ...row,
          status: contacted.status === 'completed'
            ? 'answered'
            : contacted.status === 'denied' ? 'refused' : 'error',
          note: contacted.response ?? contacted.errorCode ?? contacted.status,
        }));
        await factoryInput.workspace.replaceMemory({
          actorId: turn.actorId,
          expectedVersion: memory.receipt.version,
          content: renderMemory(next),
        });
        return {
          type: 'completed' as const,
          content: 'single complete',
          toolSteps: paths.length + 2,
          contactCalls: 1,
        };
      },
      finalize: async () => {},
    };
  };
}

function responderFactory(
  factoryInput: ContactResponderHarnessFactoryInputV1,
  options: Parameters<typeof successfulDependencies>[0],
) {
  return () => {
    options.onResponderInstance?.();
    return {
      step: async (turn: FileTurnInputV1) => {
        await readAll(factoryInput.workspace, turn);
        return {
          type: 'completed' as const,
          content: factoryInput.request.purpose === 'PAIR-Q1'
            ? 'Launch date: March 15, 2026'
            : 'Budget: $500k',
          toolSteps: paths.length + 1,
          contactCalls: 0,
        };
      },
      finalize: async () => {},
    };
  };
}

async function readAll(
  workspace: FileDrivenPairRequesterHarnessFactoryInputV1['workspace'],
  turn: FileTurnInputV1,
) {
  let memory: Awaited<ReturnType<typeof workspace.read>> | undefined;
  for (const path of paths) {
    const loaded = await workspace.read({ actorId: turn.actorId, path });
    if (path === 'MEMORY.md') memory = loaded;
  }
  assert.ok(memory);
  return memory;
}

function baseOptions(input: {
  workspaceRootDir: string;
  tasks: LoadedPactPairTaskV1[];
}) {
  return {
    workspaceRootDir: input.workspaceRootDir,
    registryRootDir: registryRoot,
    requester: {
      actorId: 'requester-tina',
      references: {
        agent: ref('agents/tina/base/agent'),
        heartbeat: ref('heartbeats/files-single'),
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
  } as const;
}

function qaTasks(ids: string[]): LoadedPactPairTaskV1[] {
  return loadPactPairTasksV1({
    policy: 'D2', requester: 'R0', gradingMode: 'category', kind: 'qa', ids,
  });
}

function renderMemory(rows: readonly FileMemoryRowV1[]): string {
  return `${rows.map(row => `${row.taskId} [${row.status}] — ${row.note}`).join('\n')}\n`;
}

function ref(id: string) {
  return { id, version: '1.0.0' } as const;
}
