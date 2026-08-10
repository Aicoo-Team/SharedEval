/**
 * PACT-Net `sharedos-embedded` execution tests.
 *
 * The first group runs against the REAL SharedOS kernel from a locally built
 * checkout (PACT_SHAREDOS_DIR); skipped with an explicit reason otherwise
 * and a hard failure under PACT_REQUIRE_SHAREDOS=1 (Pair precedent). The
 * second group injects a scripted SharedOS module surface to exercise
 * incident classes the real kernel cannot be asked to produce on demand
 * (denied turn admission, kernel turn failure) — no network, no model API.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pactRunConfigV1Schema } from '../../../src/runner/v1/config.js';
import {
  loadSharedOsModulesV1,
  type SharedOsModulesV1,
  type SoExecutionResult,
} from '../../../src/execution/sharedos/v1/index.js';
import {
  createScriptedPactNetHarnessV1,
  loadPactNetAgentStoresV1,
  loadPactNetTasksV1,
  runSinglePactNetTaskV1,
  type LoadedPactNetTaskV1,
  type PactNetHarnessFactoryV1,
} from '../../../src/suites/pact-net/index.js';
import {
  expectedVisiblePactNetSharedOsToolsV1,
  grantedPactNetSharedOsActionsV1,
  runSinglePactNetTaskViaSharedOsV1,
} from '../../../src/suites/pact-net/sharedos-execution.js';

const loaded = await loadSharedOsModulesV1();
const skip = loaded.ok ? false : loaded.reason;
if (!loaded.ok) {
  if (process.env.PACT_REQUIRE_SHAREDOS) {
    throw new Error(
      `PACT_REQUIRE_SHAREDOS is set but SharedOS could not be loaded: ${loaded.reason}`,
    );
  }
  console.log(`[pact-net-sharedos] skipping integration tests: ${loaded.reason}`);
}

const stores = loadPactNetAgentStoresV1();

function sharedOsConfig(
  ids: string[],
  overrides: { maxToolCalls?: number; maxRuntimeMs?: number } = {},
) {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'test-model',
    },
    benchmark: {
      dataset: 'pact-net',
      policy: 'D2',
      tasks: { kind: 'all', ids },
      execution: { adapter: 'sharedos-embedded' },
    },
    budget: {
      maxTurns: 4,
      maxToolCalls: overrides.maxToolCalls ?? 2,
      maxRuntimeMs: overrides.maxRuntimeMs ?? 10_000,
    },
    output: { directory: 'runs', saveTraces: true },
  });
}

function taskFor(id: string): LoadedPactNetTaskV1 {
  const tasks = loadPactNetTasksV1({ policy: 'D2', kind: 'all', ids: [id] });
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.ok(task);
  return task;
}

function seedFor(task: LoadedPactNetTaskV1) {
  const seed = stores.get(task.targetAgent);
  assert.ok(seed, `no seed store for ${task.targetAgent}`);
  return seed;
}

async function runTask(options: {
  id: string;
  harnessFactory?: PactNetHarnessFactoryV1;
  config?: ReturnType<typeof sharedOsConfig>;
}) {
  const task = taskFor(options.id);
  // Through the environment dispatch, so the adapter switch itself is under
  // test, not only the sharedos engine.
  return runSinglePactNetTaskV1({
    config: options.config ?? sharedOsConfig([options.id]),
    task,
    seed: seedFor(task),
    runId: `net-sharedos-${options.id}`,
    now: () => new Date(),
    harnessFactory: options.harnessFactory ?? createScriptedPactNetHarnessV1,
    environment: {},
  });
}

test('a QA trial runs through the real kernel with adapter identity on the result', { skip }, async () => {
  const run = await runTask({ id: 'NET-Q-0001' });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.adapterId, 'sharedos-embedded');
  assert.equal(run.result.sharedOs?.protocolVersion, '1');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.deepEqual(run.result.toolCalls, [
    { id: 'NET-Q-0001:tool:1', name: 'get_note', isError: false },
  ]);
  assert.equal(run.result.budgetUsed.turns, 2);
  assert.equal(run.result.budgetUsed.toolCalls, 1);
  assert.deepEqual(run.result.violations, []);
  assert.equal(run.result.finalDecision.type, 'answer');
  assert.equal(run.evaluation.kind, 'qa');

  // Kernel runtime + audit events land in the (private) trace, sufficient
  // to reconstruct the authorization decisions of the turn.
  const turnEvents = run.trace.filter(event => event.event === 'sharedos_turn');
  assert.equal(turnEvents.length, 1);
  const turn = turnEvents[0]?.data as {
    adapterId: string;
    events: Array<{ type: string }>;
  };
  assert.equal(turn.adapterId, 'sharedos-embedded');
  const eventTypes = turn.events.map(event => event.type);
  assert.ok(eventTypes.includes('turn.started'));
  assert.ok(eventTypes.includes('tool.completed'));
  assert.ok(eventTypes.includes('turn.completed'));
  assert.ok(
    eventTypes.includes('audit.authorization.checked'),
    `audit events must reach the run transcript, got: ${eventTypes.join(',')}`,
  );
});

test('an action trial mutates the world through the kernel and scores exactly', { skip }, async () => {
  const run = await runTask({ id: 'NET-A-0001' });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.equal(run.result.toolCalls[0]?.name, 'create_note');
  assert.equal(run.result.toolCalls[0]?.isError, false);
  assert.equal(run.evaluation.kind, 'action');
  assert.equal(run.result.evaluation?.correct, true);
});

test('the tool-call budget stays host-owned inside the kernel turn', { skip }, async () => {
  const run = await runTask({
    id: 'NET-Q-0001',
    config: sharedOsConfig(['NET-Q-0001'], { maxToolCalls: 0 }),
  });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.deepEqual(run.result.violations, ['max_tool_calls_exceeded']);
  assert.equal(run.result.finalDecision.type, 'escalate');
  assert.equal(run.result.budgetUsed.toolCalls, 0);
});

test('a routing-blocked dyad never reaches the kernel or the harness', async () => {
  // Ungated: routing enforcement happens before SharedOS is ever loaded, so
  // this must hold even without a local SharedOS build.
  const run = await runTask({
    id: 'NET-Q-0021',
    harnessFactory: () => {
      throw new Error('harness must not be created for a blocked dyad');
    },
  });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.finalDecision.type, 'routing_blocked');
  assert.equal(run.result.sharedOs, undefined);
  assert.deepEqual(run.result.toolCalls, []);
  assert.equal(run.result.budgetUsed.turns, 0);
  assert.equal(run.evaluation.routingBlocked, true);
});

test('capability mapping and expected visibility derive from one tool surface', () => {
  assert.deepEqual(grantedPactNetSharedOsActionsV1(), {
    notes: ['search', 'read', 'create', 'edit'],
    todos: ['search', 'read', 'create', 'complete'],
  });
  assert.deepEqual(expectedVisiblePactNetSharedOsToolsV1(), [
    'search_notes',
    'get_note',
    'create_note',
    'edit_note',
    'search_todos',
    'get_todo',
    'create_todo',
    'complete_todo',
  ]);
});

test('a denied kernel turn is an experimental outcome and is never retried', async () => {
  const counters = { executions: 0, harnessSteps: 0 };
  const task = taskFor('NET-Q-0001');
  const run = await runSinglePactNetTaskViaSharedOsV1(
    {
      config: sharedOsConfig(['NET-Q-0001']),
      task,
      seed: seedFor(task),
      runId: 'net-sharedos-denied',
      now: () => new Date(),
      harnessFactory: () => ({
        step: () => {
          counters.harnessSteps += 1;
          throw new Error('the driver must not run in a denied turn');
        },
      }),
      environment: {},
    },
    { modules: scriptedModules('denied', counters) },
  );

  // Denied admission: exactly one kernel execution, zero model turns, an
  // escalation outcome — an observation, not an infrastructure error.
  assert.equal(counters.executions, 1);
  assert.equal(counters.harnessSteps, 0);
  assert.equal(run.result.status, 'ok');
  assert.deepEqual(run.result.violations, ['sharedos_turn_denied']);
  assert.equal(run.result.finalDecision.type, 'escalate');
  assert.equal(run.result.sharedOs?.status, 'denied');
  assert.equal(run.result.budgetUsed.turns, 0);
});

test('a failed kernel turn maps to an infrastructure error', async () => {
  const counters = { executions: 0, harnessSteps: 0 };
  const task = taskFor('NET-Q-0001');
  const run = await runSinglePactNetTaskViaSharedOsV1(
    {
      config: sharedOsConfig(['NET-Q-0001']),
      task,
      seed: seedFor(task),
      runId: 'net-sharedos-failed',
      now: () => new Date(),
      harnessFactory: createScriptedPactNetHarnessV1,
      environment: {},
    },
    { modules: scriptedModules('failed', counters) },
  );

  assert.equal(counters.executions, 1);
  assert.equal(run.result.status, 'infrastructure_error');
  assert.deepEqual(run.result.violations, ['runner_error']);
  assert.match(String(run.result.error), /SharedOS turn failed/);
  assert.equal(run.result.evaluation, null);
  assert.equal(run.result.sharedOs?.status, 'failed');
});

/**
 * Scripted SharedOS module surface: registers tools like the real testkit so
 * the adapter's enforced-visibility gate passes, then returns the configured
 * turn status without ever invoking the driver — exactly how a kernel-level
 * admission denial behaves.
 */
function scriptedModules(
  status: 'denied' | 'failed',
  counters: { executions: number },
): SharedOsModulesV1 {
  const fake = {
    core: {
      agentExecutionCapability: () => ({}),
    },
    runtime: {
      TurnExecutor: class {
        async execute(request: { executionId: string }): Promise<SoExecutionResult> {
          counters.executions += 1;
          const at = new Date().toISOString();
          return {
            status,
            executionId: request.executionId,
            traceId: 'trace-scripted-1',
            events: [],
            startedAt: at,
            completedAt: at,
            error: status === 'denied'
              ? { code: 'execution_denied' }
              : { code: 'driver_failed', message: 'no output produced' },
          };
        }
      },
    },
    os: { createMemoryTools: () => [] },
    testkit: {
      createTestKernel: () => {
        const registered: string[] = [];
        return {
          kernel: {
            registerTool: (handler: unknown) => {
              registered.push(
                (handler as { definition: { name: string } }).definition.name,
              );
            },
            listTools: async () => registered.map(name => ({ name })),
          },
          audit: { events: [] },
          messages: null,
        };
      },
      createTestGrant: (options: Record<string, unknown>) => options,
      InMemoryResourceProvider: class {},
    },
  };
  return fake as unknown as SharedOsModulesV1;
}
