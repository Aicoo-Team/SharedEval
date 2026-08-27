import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySharedevalOverridesV1,
  parseSharedevalRunConfigV1Yaml,
} from '../../src/runner/v1/sharedeval-config.js';
import { runSharedevalProductionV1 } from '../../src/runner/v1/sharedeval-production.js';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';
import { loadPactPairTasksV1 } from '../../src/suites/pact-pair/task-loader.js';

test('composes explicit multi and single runs through one preloaded SharedOS factory', async () => {
  for (const mode of ['multi', 'single'] as const) {
    const calls: string[] = [];
    let runnerInput: any;
    let driverInput: any;
    const sessionFactory = async () => { throw new Error('not invoked by dispatch test'); };
    const output = await runSharedevalProductionV1({
      config: effectiveConfig(mode),
      configRootDir: '/config-root',
      repositoryRoot: '/source-root',
      runId: `${mode}-run`,
      environment: {
        SHAREDEVAL_MODEL_API_KEY: '  frozen-secret  ',
        SHAREDEVAL_SHAREDOS_DIR: '/verified-sharedos',
      },
    }, {
      inspectSource: root => {
        calls.push(`source:${root}`);
        return { sourceRevision: 'a'.repeat(40) };
      },
      loadDatasetAuthority: input => {
        calls.push(`dataset:${input.gradingMode}`);
        return {
          dataset: {
            id: 'pact-pair',
            version: '7.0.0',
            manifestSha256: '1'.repeat(64),
            tasksSha256: '2'.repeat(64),
          },
          goldSet: { id: 'pact-pair-category-gold-v1', sha256: '3'.repeat(64) },
        };
      },
      loadTasks: options => {
        calls.push(`tasks:${options.requester}`);
        return loadPactPairTasksV1({
          policy: options.policy,
          requester: options.requester,
          gradingMode: options.gradingMode,
          kind: options.kind,
          ids: ['PAIR-Q1'],
        });
      },
      loadSharedOs: async directory => {
        calls.push(`sharedos:${directory}`);
        return {
          ok: true,
          dir: directory,
          revision: 'b'.repeat(40),
          runtimeDigest: '4'.repeat(64),
          modules: {},
        } as never;
      },
      createSessionFactory: () => {
        calls.push('session-factory');
        return sessionFactory as never;
      },
      createDriver: input => {
        calls.push(`driver:${input.requestedModel}`);
        driverInput = input;
        return {} as never;
      },
      prepareRunDirectories: async input => {
        calls.push(`directories:${input.runId}`);
        return {
          runRoot: `/runs/${input.runId}`,
          workspaceRootDir: `/runs/${input.runId}/workspaces`,
          multiStoreRoot: `/runs/${input.runId}/multi`,
          singleStoreRoot: `/runs/${input.runId}/single`,
        };
      },
      runFiles: async input => {
        calls.push(`run:${input.config.workflow.mode}`);
        runnerInput = input;
        input.createDriver({ actorId: 'requester-tina', role: 'requester' });
        return { workflowId: input.config.workflow.id } as never;
      },
    });

    assert.equal(output.workflowId, `files-${mode}`);
    assert.equal(output.sourceRevision, 'a'.repeat(40));
    assert.equal(runnerInput.runId, `${mode}-run`);
    assert.equal(runnerInput.createSharedOsSession, sessionFactory);
    assert.deepEqual(runnerInput.runProvenance, {
      dataset: {
        id: 'pact-pair',
        version: '7.0.0',
        manifestSha256: '1'.repeat(64),
        tasksSha256: '2'.repeat(64),
      },
      goldSet: { id: 'pact-pair-category-gold-v1', sha256: '3'.repeat(64) },
      models: {
        requester: {
          provider: 'openai-compatible',
          requestedModel: 'example-model',
          resolvedModel: 'example-model',
        },
        responder: {
          provider: 'openai-compatible',
          requestedModel: 'example-model',
          resolvedModel: 'example-model',
        },
      },
      backend: { adapterId: 'sharedos-runtime', executor: 'sharedos-executor' },
    });
    assert.deepEqual(runnerInput.requester.references, {
      agent: { id: 'agents/tina/base/agent', version: '1.1.0' },
      heartbeat: { id: `heartbeats/files-${mode}`, version: '1.1.0' },
      policy: { id: 'agents/tina/base/policy', version: '1.0.0' },
      memory: { id: 'memory-seeds/pact-pair-requester', version: '1.0.0' },
    });
    assert.equal(runnerInput.requester.actorId, 'requester');
    assert.equal(runnerInput.responder.actorId, 'responder');
    assert.equal(driverInput.environment.SHAREDEVAL_MODEL_API_KEY, 'frozen-secret');
    assert.equal(Object.isFrozen(driverInput.environment), true);
    assert.deepEqual(Object.keys(driverInput.environment), ['SHAREDEVAL_MODEL_API_KEY']);
    assert.deepEqual(calls, [
      'source:/source-root',
      'dataset:category',
      'tasks:R1',
      'sharedos:/verified-sharedos',
      'session-factory',
      `directories:${mode}-run`,
      `run:${mode}`,
      'driver:example-model',
    ]);
  }
});

test('resolves requester R0 to its workspace persona and proceeds', async () => {
  // R0 (Riley Novak, the stranger identity) has a registered requester
  // workspace, so identity resolution no longer rejects it: the run advances
  // to source inspection like any other requester.
  const calls: string[] = [];
  await assert.rejects(
    () => runSharedevalProductionV1({
      config: effectiveConfig('multi', 'R0'),
      configRootDir: '/config-root',
      repositoryRoot: '/source-root',
      runId: 'r0-run',
      environment: { SHAREDEVAL_MODEL_API_KEY: 'secret' },
    }, {
      inspectSource: () => { calls.push('source'); return { sourceRevision: 'a'.repeat(40) }; },
      loadSharedOs: async () => { calls.push('sharedos'); throw new Error('unreachable'); },
      createDriver: () => { calls.push('model'); return {} as never; },
      prepareRunDirectories: async () => { calls.push('directories'); throw new Error('unreachable'); },
      runFiles: async () => { calls.push('run'); throw new Error('unreachable'); },
    }),
  );
  assert.ok(calls.includes('source'), 'R0 must reach source inspection');
});

function effectiveConfig(mode: 'multi' | 'single', requester: 'R0' | 'R1' = 'R1') {
  return applySharedevalOverridesV1(parseSharedevalRunConfigV1Yaml(`
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
benchmark:
  requester: ${requester}
  tasks:
    ids: [PAIR-Q1]
`), resolveWorkflow([mode]));
}
