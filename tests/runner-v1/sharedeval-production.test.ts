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

function effectiveConfig(
  mode: 'multi' | 'single',
  requester: 'R0' | 'R1' = 'R1',
  requesterModelOverride = false,
) {
  const actors = requesterModelOverride
    ? `
actors:
  requester:
    model:
      provider: openai-compatible
      baseUrl: https://api.example.com/v1
      apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
      model: z-ai/glm-5.3-flash`
    : '';
  return applySharedevalOverridesV1(parseSharedevalRunConfigV1Yaml(`
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: example-model${actors}
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

test('cross-model pairing drives the requester with its own model and ledger', async () => {
  const drivers: Array<{ role: string; input: any }> = [];
  let runnerInput: any;
  const run = async (override: boolean) => {
    drivers.length = 0;
    await runSharedevalProductionV1({
      config: effectiveConfig('single', 'R1', override),
      configRootDir: '/config-root',
      repositoryRoot: '/source-root',
      runId: 'cross-model-run',
      environment: { SHAREDEVAL_MODEL_API_KEY: 'secret' },
    }, {
      inspectSource: () => ({ sourceRevision: 'a'.repeat(40) }),
      loadDatasetAuthority: () => ({
        dataset: {
          id: 'pact-pair', version: '7.0.0',
          manifestSha256: '1'.repeat(64), tasksSha256: '2'.repeat(64),
        },
        goldSet: { id: 'pact-pair-category-gold-v1', sha256: '3'.repeat(64) },
      }),
      loadTasks: options => loadPactPairTasksV1({
        policy: options.policy,
        requester: options.requester,
        gradingMode: options.gradingMode,
        kind: options.kind,
        ids: ['PAIR-Q1'],
      }),
      loadSharedOs: async directory => ({
        ok: true, dir: directory, revision: 'b'.repeat(40), runtimeDigest: '4'.repeat(64), modules: {},
      }) as never,
      createSessionFactory: () => (async () => { throw new Error('unused'); }) as never,
      createDriver: input => { drivers.at(-1)!.input = input; return {} as never; },
      prepareRunDirectories: async input => ({
        runRoot: `/runs/${input.runId}`,
        workspaceRootDir: `/runs/${input.runId}/workspaces`,
        multiStoreRoot: `/runs/${input.runId}/multi`,
        singleStoreRoot: `/runs/${input.runId}/single`,
      }),
      runFiles: async input => {
        runnerInput = input;
        for (const role of ['requester', 'responder'] as const) {
          drivers.push({ role, input: undefined });
          input.createDriver({ actorId: role, role });
        }
        return { workflowId: input.config.workflow.id } as never;
      },
    });
  };

  await run(true);
  const [requester, responder] = drivers.map(driver => driver.input);
  assert.equal(requester.model.model, 'z-ai/glm-5.3-flash');
  assert.equal(requester.requestedModel, 'z-ai/glm-5.3-flash');
  assert.equal(responder.model.model, 'example-model');
  assert.equal(responder.requestedModel, 'example-model');
  assert.notEqual(requester.servedModelLedger, responder.servedModelLedger);
  assert.equal(requester.rateLimitGate, responder.rateLimitGate);
  assert.deepEqual(runnerInput.runProvenance.models, {
    requester: {
      provider: 'openai-compatible',
      requestedModel: 'z-ai/glm-5.3-flash',
      resolvedModel: 'z-ai/glm-5.3-flash',
    },
    responder: {
      provider: 'openai-compatible',
      requestedModel: 'example-model',
      resolvedModel: 'example-model',
    },
  });

  await run(false);
  const [plainRequester, plainResponder] = drivers.map(driver => driver.input);
  assert.equal(plainRequester.model, plainResponder.model);
  assert.equal(plainRequester.servedModelLedger, plainResponder.servedModelLedger);
  assert.deepEqual(
    runnerInput.runProvenance.models.requester,
    runnerInput.runProvenance.models.responder,
  );
});

test('the codex harness drives only the responder and records it in provenance', async () => {
  const config = applySharedevalOverridesV1(parseSharedevalRunConfigV1Yaml(`
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://openrouter.ai/api/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: deepseek/deepseek-chat
workflow:
  mode: single
  protocol: files
  maxTicks: 2
  stopWhen: all-terminal
benchmark:
  tasks:
    ids: [PAIR-Q1]
harness:
  responder: codex
  codex:
    command: /opt/codex/bin/codex
`), resolveWorkflow(['single']));
  const driverCalls: string[] = [];
  let codexInput: any;
  let runnerInput: any;
  await runSharedevalProductionV1({
    config,
    configRootDir: '/config-root',
    repositoryRoot: '/source-root',
    runId: 'codex-run',
    environment: {
      SHAREDEVAL_MODEL_API_KEY: 'frozen-secret',
      SHAREDEVAL_SHAREDOS_DIR: '/verified-sharedos',
    },
  }, {
    inspectSource: () => ({ sourceRevision: 'a'.repeat(40) }),
    loadDatasetAuthority: () => ({
      dataset: {
        id: 'pact-pair',
        version: '7.0.0',
        manifestSha256: '1'.repeat(64),
        tasksSha256: '2'.repeat(64),
      },
      goldSet: { id: 'pact-pair-category-gold-v1', sha256: '3'.repeat(64) },
    }),
    loadTasks: options => loadPactPairTasksV1({
      policy: options.policy,
      requester: options.requester,
      gradingMode: options.gradingMode,
      kind: options.kind,
      ids: ['PAIR-Q1'],
    }),
    loadSharedOs: async directory => ({
      ok: true,
      dir: directory,
      revision: 'b'.repeat(40),
      runtimeDigest: '4'.repeat(64),
      modules: {},
    } as never),
    createSessionFactory: () => (async () => { throw new Error('unused'); }) as never,
    createDriver: () => {
      driverCalls.push('standard');
      return {} as never;
    },
    createCodexDriver: input => {
      driverCalls.push('codex');
      codexInput = input;
      return {} as never;
    },
    prepareRunDirectories: async input => ({
      runRoot: `/runs/${input.runId}`,
      workspaceRootDir: `/runs/${input.runId}/workspaces`,
      multiStoreRoot: `/runs/${input.runId}/multi`,
      singleStoreRoot: `/runs/${input.runId}/single`,
    }),
    runFiles: async input => {
      runnerInput = input;
      input.createDriver({ actorId: 'requester', role: 'requester' });
      input.createDriver({ actorId: 'responder', role: 'responder' });
      return { workflowId: input.config.workflow.id } as never;
    },
  });

  assert.deepEqual(driverCalls, ['standard', 'codex']);
  assert.deepEqual(codexInput.harness, {
    command: '/opt/codex/bin/codex',
    providerId: 'sharedeval',
    wireApi: 'chat',
  });
  assert.equal(codexInput.model.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(codexInput.requestedModel, 'deepseek/deepseek-chat');
  assert.deepEqual(Object.keys(codexInput.environment), ['SHAREDEVAL_MODEL_API_KEY']);
  assert.deepEqual(runnerInput.runProvenance.models, {
    requester: {
      provider: 'openai-compatible',
      requestedModel: 'deepseek/deepseek-chat',
      resolvedModel: 'deepseek/deepseek-chat',
    },
    responder: {
      provider: 'codex',
      requestedModel: 'deepseek/deepseek-chat',
      resolvedModel: 'deepseek/deepseek-chat',
    },
  });
  assert.deepEqual(runnerInput.runProvenance.backend, {
    adapterId: 'sharedos-runtime',
    executor: 'sharedos-executor',
  });
});

test('a requester model override and the codex harness compose per role', async () => {
  const config = applySharedevalOverridesV1(parseSharedevalRunConfigV1Yaml(`
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://openrouter.ai/api/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: deepseek/deepseek-chat
actors:
  requester:
    model:
      provider: openai-compatible
      baseUrl: https://openrouter.ai/api/v1
      apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
      model: z-ai/glm-5.3-flash
workflow:
  mode: single
  protocol: files
  maxTicks: 2
  stopWhen: all-terminal
benchmark:
  tasks:
    ids: [PAIR-Q1]
harness:
  responder: codex
  codex:
    command: /opt/codex/bin/codex
`), resolveWorkflow(['single']));
  const driverCalls: Array<{ kind: string; input: any }> = [];
  let runnerInput: any;
  await runSharedevalProductionV1({
    config,
    configRootDir: '/config-root',
    repositoryRoot: '/source-root',
    runId: 'combined-run',
    environment: { SHAREDEVAL_MODEL_API_KEY: 'secret' },
  }, {
    inspectSource: () => ({ sourceRevision: 'a'.repeat(40) }),
    loadDatasetAuthority: () => ({
      dataset: {
        id: 'pact-pair', version: '7.0.0',
        manifestSha256: '1'.repeat(64), tasksSha256: '2'.repeat(64),
      },
      goldSet: { id: 'pact-pair-category-gold-v1', sha256: '3'.repeat(64) },
    }),
    loadTasks: options => loadPactPairTasksV1({
      policy: options.policy,
      requester: options.requester,
      gradingMode: options.gradingMode,
      kind: options.kind,
      ids: ['PAIR-Q1'],
    }),
    loadSharedOs: async directory => ({
      ok: true, dir: directory, revision: 'b'.repeat(40), runtimeDigest: '4'.repeat(64), modules: {},
    }) as never,
    createSessionFactory: () => (async () => { throw new Error('unused'); }) as never,
    createDriver: input => { driverCalls.push({ kind: 'standard', input }); return {} as never; },
    createCodexDriver: input => { driverCalls.push({ kind: 'codex', input }); return {} as never; },
    prepareRunDirectories: async input => ({
      runRoot: `/runs/${input.runId}`,
      workspaceRootDir: `/runs/${input.runId}/workspaces`,
      multiStoreRoot: `/runs/${input.runId}/multi`,
      singleStoreRoot: `/runs/${input.runId}/single`,
    }),
    runFiles: async input => {
      runnerInput = input;
      input.createDriver({ actorId: 'requester', role: 'requester' });
      input.createDriver({ actorId: 'responder', role: 'responder' });
      return { workflowId: input.config.workflow.id } as never;
    },
  });

  assert.deepEqual(driverCalls.map(call => call.kind), ['standard', 'codex']);
  const [requester, responder] = driverCalls.map(call => call.input);
  assert.equal(requester.model.model, 'z-ai/glm-5.3-flash');
  assert.equal(requester.requestedModel, 'z-ai/glm-5.3-flash');
  assert.equal(responder.model.model, 'deepseek/deepseek-chat');
  assert.equal(responder.requestedModel, 'deepseek/deepseek-chat');
  assert.equal(responder.harness.command, '/opt/codex/bin/codex');
  assert.deepEqual(runnerInput.runProvenance.models, {
    requester: {
      provider: 'openai-compatible',
      requestedModel: 'z-ai/glm-5.3-flash',
      resolvedModel: 'z-ai/glm-5.3-flash',
    },
    responder: {
      provider: 'codex',
      requestedModel: 'deepseek/deepseek-chat',
      resolvedModel: 'deepseek/deepseek-chat',
    },
  });
});
