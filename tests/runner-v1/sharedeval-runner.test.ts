import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFakeSharedOsFileSessionFactoryV1,
  fileSessionActorsV1,
  fileSessionQaTasksV1,
  fileSessionRegistryRootV1,
  fileSessionSingleActorsV1,
  type FakeSharedOsFileSessionTraceV1,
  unreachableFileTurnDriverV1,
} from './file-workflow-test-fixtures.js';
import {
  applySharedevalOverridesV1,
  parseSharedevalRunConfigV1Yaml,
} from '../../src/runner/v1/sharedeval-config.js';
import {
  runSharedevalPactPairFilesV1,
  type RunSharedevalPactPairFilesV1Options,
} from '../../src/runner/v1/sharedeval-runner.js';
import type {
  CreateSharedOsFileSessionV1Options,
} from '../../src/runner/v1/sharedos-file-session-contracts.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';
import { createPactPairWorkspaceV1 } from '../../src/suites/pact-pair/workspace.js';

test('runner maps explicit multi to one SharedOS-backed scheduler session', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-runner-multi-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const resourceCalls: Array<{ workflowId: string; sessionIndex: number }> = [];
  const runProvenance = frozenRunProvenance();
  const originalRunProvenance = structuredClone(runProvenance);
  try {
    const result = await runSharedevalPactPairFilesV1({
      config: effectiveConfig('multi'),
      runProvenance,
      runId: 'runner-multi',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks: fileSessionQaTasksV1(['PAIR-Q1']),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace, runProvenance }),
      createSessionResources: input => {
        resourceCalls.push({ workflowId: input.workflowId, sessionIndex: input.sessionIndex });
        return {
          pactWorkspace: createPactPairWorkspaceV1(),
          storeRoot: join(workspaceRootDir, 'store'),
        };
      },
    });

    assert.equal(result.workflowId, 'files-multi');
    assert.deepEqual(resourceCalls, [{ workflowId: 'files-multi', sessionIndex: 0 }]);
    assert.equal(trace.creates[0]?.maxToolCalls, 8);
    assert.equal(trace.creates[0]?.deadlineMs, 60_000);
    assert.deepEqual(
      await durableRunProvenance(join(workspaceRootDir, 'store')),
      expectedDurableRunProvenance,
    );
    assert.deepEqual(runProvenance, originalRunProvenance);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('runner maps explicit single to isolated SharedOS-backed task sessions', async () => {
  const workspaceRootDir = await mkdtemp(join(tmpdir(), 'sharedeval-runner-single-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const resourceCalls: Array<{ taskId: string; sessionIndex: number }> = [];
  const runProvenance = frozenRunProvenance();
  const originalRunProvenance = structuredClone(runProvenance);
  try {
    const result = await runSharedevalPactPairFilesV1({
      config: effectiveConfig('single'),
      runProvenance,
      runId: 'runner-single',
      workspaceRootDir,
      registryRootDir: fileSessionRegistryRootV1,
      requester: fileSessionSingleActorsV1.requester,
      responder: fileSessionSingleActorsV1.responder,
      tasks: fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']),
      createDriver: unreachableFileTurnDriverV1,
      createSharedOsSession: createFakeSharedOsFileSessionFactoryV1({ trace, runProvenance }),
      createSessionResources: input => {
        resourceCalls.push({ taskId: input.tasks[0]?.taskId ?? '', sessionIndex: input.sessionIndex });
        return {
          pactWorkspace: createPactPairWorkspaceV1(),
          storeRoot: join(workspaceRootDir, `store-${input.sessionIndex}`),
        };
      },
    });

    assert.equal(result.workflowId, 'files-single');
    assert.deepEqual(resourceCalls, [
      { taskId: 'PAIR-Q1', sessionIndex: 0 },
      { taskId: 'PAIR-Q2', sessionIndex: 1 },
    ]);
    assert.deepEqual(trace.creates.map(entry => entry.sessionIndex), [0, 1]);
    assert.deepEqual(await Promise.all([0, 1].map(async sessionIndex => (
      durableRunProvenance(join(workspaceRootDir, `store-${sessionIndex}`))
    ))), [expectedDurableRunProvenance, expectedDurableRunProvenance]);
    assert.deepEqual(runProvenance, originalRunProvenance);
  } finally {
    await rm(workspaceRootDir, { recursive: true, force: true });
  }
});

test('runner rejects missing, extra, or malformed provenance before any execution spend', async () => {
  const invalidCases: ReadonlyArray<Readonly<{
    name: string;
    value: unknown;
  }>> = [
    { name: 'missing run provenance', value: undefined },
    { name: 'missing dataset', value: omitKey(hostRunProvenance, 'dataset') },
    { name: 'extra dataset field', value: replaceKey(hostRunProvenance, 'dataset', {
      ...hostRunProvenance.dataset,
      source: 'guessed',
    }) },
    { name: 'malformed dataset', value: replaceKey(hostRunProvenance, 'dataset', {
      ...hostRunProvenance.dataset,
      manifestSha256: 'not-a-sha256',
    }) },
    { name: 'missing gold set', value: omitKey(hostRunProvenance, 'goldSet') },
    { name: 'extra gold set field', value: replaceKey(hostRunProvenance, 'goldSet', {
      ...hostRunProvenance.goldSet,
      source: 'guessed',
    }) },
    { name: 'malformed gold set', value: replaceKey(hostRunProvenance, 'goldSet', {
      ...hostRunProvenance.goldSet,
      sha256: 'not-a-sha256',
    }) },
    { name: 'missing models', value: omitKey(hostRunProvenance, 'models') },
    { name: 'extra models field', value: replaceKey(hostRunProvenance, 'models', {
      ...hostRunProvenance.models,
      evaluator: hostRunProvenance.models.requester,
    }) },
    { name: 'malformed model', value: replaceKey(hostRunProvenance, 'models', {
      ...hostRunProvenance.models,
      requester: { ...hostRunProvenance.models.requester, provider: '' },
    }) },
    { name: 'missing backend', value: omitKey(hostRunProvenance, 'backend') },
    { name: 'extra backend field', value: replaceKey(hostRunProvenance, 'backend', {
      ...hostRunProvenance.backend,
      runtime: 'guessed',
    }) },
    { name: 'malformed backend', value: replaceKey(hostRunProvenance, 'backend', {
      ...hostRunProvenance.backend,
      executor: '',
    }) },
  ];

  for (const invalidCase of invalidCases) {
    const spend = { resources: 0, sharedOsSessions: 0, drivers: 0 };
    const candidate = structuredClone(invalidCase.value);
    const snapshot = structuredClone(candidate);
    const options = {
      config: effectiveConfig('multi'),
      runProvenance: candidate,
      runId: `invalid-${invalidCase.name.replaceAll(' ', '-')}`,
      workspaceRootDir: '/not-used-before-provenance-validation',
      registryRootDir: fileSessionRegistryRootV1,
      requester: fileSessionActorsV1.requester,
      responder: fileSessionActorsV1.responder,
      tasks: fileSessionQaTasksV1(['PAIR-Q1']),
      createDriver: () => {
        spend.drivers += 1;
        return unreachableFileTurnDriverV1();
      },
      createSharedOsSession: async (input: CreateSharedOsFileSessionV1Options) => {
        spend.sharedOsSessions += 1;
        input.createDriver({ actorId: input.requester.actorId, role: 'requester' });
        throw new Error('execution boundary was reached');
      },
      createSessionResources: () => {
        spend.resources += 1;
        return {
          pactWorkspace: createPactPairWorkspaceV1(),
          storeRoot: '/not-used-before-provenance-validation',
        };
      },
    } as unknown as RunSharedevalPactPairFilesV1Options;

    await assert.rejects(
      Promise.resolve().then(() => runSharedevalPactPairFilesV1(options)),
      /benchmark run provenance/i,
      invalidCase.name,
    );
    assert.deepEqual(spend, { resources: 0, sharedOsSessions: 0, drivers: 0 }, invalidCase.name);
    assert.deepEqual(candidate, snapshot, invalidCase.name);
  }
});

const hostRunProvenance = {
  dataset: {
    id: 'pact-pair',
    version: '7.3.1',
    manifestSha256: '1'.repeat(64),
    tasksSha256: '2'.repeat(64),
  },
  goldSet: {
    id: 'withheld-gold-v7',
    sha256: '3'.repeat(64),
  },
  models: {
    requester: {
      provider: 'requester-provider',
      requestedModel: 'requester-requested-v7',
      resolvedModel: 'requester-resolved-v7',
    },
    responder: {
      provider: 'responder-provider',
      requestedModel: 'responder-requested-v9',
      resolvedModel: 'responder-resolved-v9',
    },
  },
  backend: {
    adapterId: 'host-adapter-v3',
    executor: 'sharedos-executor-v5',
  },
} as const;

const expectedDurableRunProvenance = {
  dataset: {
    id: 'pact-pair',
    version: '7.3.1',
    manifestSha256: '1'.repeat(64),
    tasksSha256: '2'.repeat(64),
  },
  goldSet: {
    id: 'withheld-gold-v7',
    sha256: '3'.repeat(64),
  },
  models: {
    requester: {
      provider: 'requester-provider',
      requestedModel: 'requester-requested-v7',
      resolvedModel: 'requester-resolved-v7',
    },
    responder: {
      provider: 'responder-provider',
      requestedModel: 'responder-requested-v9',
      resolvedModel: 'responder-resolved-v9',
    },
  },
  backend: {
    adapterId: 'host-adapter-v3',
    executor: 'sharedos-executor-v5',
  },
} as const;

function frozenRunProvenance() {
  return deepFreeze(structuredClone(hostRunProvenance));
}

async function durableRunProvenance(runDirectory: string) {
  const manifest = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')) as {
    dataset: unknown;
    goldSet: unknown;
    actors: {
      requester: { model: unknown };
      responder: { model: unknown };
    };
    backend: unknown;
  };
  return {
    dataset: manifest.dataset,
    goldSet: manifest.goldSet,
    models: {
      requester: manifest.actors.requester.model,
      responder: manifest.actors.responder.model,
    },
    backend: manifest.backend,
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function omitKey(
  value: typeof hostRunProvenance,
  key: keyof typeof hostRunProvenance,
): Record<string, unknown> {
  const clone: Record<string, unknown> = structuredClone(value);
  delete clone[key];
  return clone;
}

function replaceKey(
  value: typeof hostRunProvenance,
  key: keyof typeof hostRunProvenance,
  replacement: unknown,
): Record<string, unknown> {
  return { ...structuredClone(value), [key]: replacement };
}

function effectiveConfig(mode: 'multi' | 'single') {
  const parsed = parseSharedevalRunConfigV1Yaml(`
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: example-model
workflow:
  mode: ${mode}
  protocol: files
  maxTicks: 2
  stopWhen: all-terminal
`);
  return applySharedevalOverridesV1(parsed, resolveWorkflow([mode]));
}
