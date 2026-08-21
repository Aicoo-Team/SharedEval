/**
 * Integration tests for the runner wiring of the `sharedos-embedded`
 * execution adapter: `benchmark.execution.adapter: sharedos-embedded`
 * routes every PACT-Pair trial through the REAL SharedOS kernel while the
 * PACT protocol lifecycle, budgets, and evaluation stay host-owned.
 *
 * Requires a locally built SharedOS checkout (PACT_SHAREDOS_DIR); skipped
 * with an explicit reason otherwise, and a hard failure under
 * PACT_REQUIRE_SHAREDOS=1 (the pinned conformance CI job).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PactAdapterV1,
  PactBoundaryPlanV1,
  PactDecisionV1,
  PactFinalizeReportV1,
  PactObservationV1,
  PactRunInitV1,
  PactTaskIntroV1,
} from '../../src/protocol/v1/index.js';
import {
  pactRunConfigV1Schema,
  selectedPactExecutionAdapterV1,
} from '../../src/runner/v1/config.js';
import { pactTaskResultV1Schema } from '../../src/runner/v1/artifacts.js';
import { loadSharedOsModulesV1 } from '../../src/execution/sharedos/v1/index.js';
import { runSinglePactPairTaskV1 } from '../../src/suites/pact-pair/environment.js';
import {
  expectedVisibleSharedOsToolsV1,
  grantedSharedOsActionsV1,
} from '../../src/suites/pact-pair/sharedos-execution.js';
import { loadPactPairTasksV1 } from '../../src/suites/pact-pair/task-loader.js';
import { loadCanonicalPactPairStoreV1 } from '../../src/suites/pact-pair/workspace.js';

const loaded = await loadSharedOsModulesV1();
const skip = loaded.ok ? false : loaded.reason;
if (!loaded.ok) {
  if (process.env.PACT_REQUIRE_SHAREDOS) {
    throw new Error(
      `PACT_REQUIRE_SHAREDOS is set but SharedOS could not be loaded: ${loaded.reason}`,
    );
  }
  console.log(`[sharedos-runner-wiring] skipping integration tests: ${loaded.reason}`);
}

const FULL_PLAN: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: true },
    todos: { read: true, write: true },
    memory: { read: 'none', write: false },
  },
};

const NOTES_ONLY_PLAN: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: false },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
};

function sharedOsConfig(
  ids: string[],
  overrides: {
    saveTraces?: boolean;
    maxToolCalls?: number;
    maxRuntimeMs?: number;
  } = {},
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
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids },
      execution: { adapter: 'sharedos-embedded' },
    },
    budget: {
      maxTurns: 4,
      maxToolCalls: overrides.maxToolCalls ?? 2,
      maxRuntimeMs: overrides.maxRuntimeMs ?? 10_000,
    },
    output: { directory: 'runs', saveTraces: overrides.saveTraces ?? true },
  });
}

function taskFor(id: string) {
  const tasks = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'all',
    ids: [id],
  });
  assert.equal(tasks.length, 1);
  return tasks[0];
}

async function runTask(options: {
  ids: string;
  adapter: PactAdapterV1;
  config?: ReturnType<typeof sharedOsConfig>;
}) {
  return runSinglePactPairTaskV1({
    config: options.config ?? sharedOsConfig([options.ids]),
    task: taskFor(options.ids),
    seed: loadCanonicalPactPairStoreV1(),
    runId: `sharedos-wiring-${options.ids}`,
    now: () => new Date(),
    harnessFactory: () => options.adapter,
    environment: {},
  });
}

test('a QA trial runs through the real kernel with adapter identity on the result', { skip }, async () => {
  const adapter = new ScriptedAdapter(observation => {
    if (observation.type === 'task') {
      return {
        type: 'tool_call',
        toolName: 'search_notes',
        input: { query: 'Project Alpha launch date' },
      };
    }
    assert.equal(observation.isError, false);
    assert.match(JSON.stringify(observation.output), /March 15, 2026/);
    return { type: 'answer', content: 'Project Alpha launches on March 15, 2026.' };
  });

  const run = await runTask({ ids: 'Q1', adapter });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.adapterId, 'sharedos-embedded');
  assert.equal(run.result.sharedOs?.protocolVersion, '1');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.deepEqual(run.result.toolCalls, [
    { id: `${run.result.taskId}:tool:1`, name: 'search_notes', isError: false },
  ]);
  assert.equal(run.result.budgetUsed.turns, 2);
  assert.equal(run.result.budgetUsed.toolCalls, 1);
  assert.deepEqual(run.result.violations, []);
  assert.equal(run.result.evaluation?.correct, true);
  // The public artifact row must stay schema-valid with the identity block.
  pactTaskResultV1Schema.parse(run.result);

  // Kernel runtime + audit events land in the (private) trace, sufficient
  // to reconstruct the authorization decisions of the turn.
  const turnEvents = run.trace.filter(event => event.event === 'sharedos_turn');
  assert.equal(turnEvents.length, 1);
  const turn = turnEvents[0].data as {
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
  const adapter = new ScriptedAdapter(observation => observation.type === 'task'
    ? {
        type: 'tool_call',
        toolName: 'create_note',
        input: {
          folder: 'Shared',
          title: 'Product sync summary',
          content: 'Calendar integration was approved; launch target is April.',
        },
      }
    : { type: 'answer', content: 'Done.' });

  const run = await runTask({ ids: 'A1', adapter });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.equal(run.result.toolCalls[0]?.isError, false);
  assert.equal(run.evaluation.kind, 'action');
  assert.equal(run.result.evaluation?.correct, true);
});

test('a call outside the granted surface is kernel-filtered to tool_unavailable', { skip }, async () => {
  const adapter = new ScriptedAdapter(
    observation => {
      if (observation.type === 'task') {
        return {
          type: 'tool_call',
          toolName: 'search_todos',
          input: { query: 'anything' },
        };
      }
      assert.equal(observation.isError, true);
      // The kernel's public code is tool_not_available; the adapter's public
      // toolCalls vocabulary folds it into tool_unavailable. Either way the
      // public surface must not express grant state.
      assert.match(
        JSON.stringify(observation.output),
        /tool_(not_)?available/,
      );
      assert.doesNotMatch(JSON.stringify(observation.output), /grant|denied/i);
      return { type: 'refuse', reason: 'Todo access is not available.' };
    },
    NOTES_ONLY_PLAN,
  );

  const run = await runTask({ ids: 'Q1', adapter });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.deepEqual(run.result.toolCalls, [
    { id: `${run.result.taskId}:tool:1`, name: 'search_todos', isError: true },
  ]);
  assert.deepEqual(run.result.violations, []);
  assert.equal(run.result.finalDecision.type, 'refuse');
});

test('the tool-call budget stays host-owned inside the kernel turn', { skip }, async () => {
  const adapter = new ScriptedAdapter(() => ({
    type: 'tool_call',
    toolName: 'search_notes',
    input: { query: 'more' },
  }));

  const run = await runTask({
    ids: 'Q1',
    adapter,
    config: sharedOsConfig(['Q1'], { maxToolCalls: 2 }),
  });

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.sharedOs?.status, 'succeeded');
  assert.deepEqual(run.result.violations, ['max_tool_calls_exceeded']);
  assert.equal(run.result.finalDecision.type, 'escalate');
  assert.equal(run.result.budgetUsed.toolCalls, 2);
});

test('a hanging harness maps to the public runner timeout shape', { skip }, async () => {
  const adapter = new ScriptedAdapter(async observation => {
    if (observation.type === 'task') {
      return {
        type: 'tool_call',
        toolName: 'search_notes',
        input: { query: 'first call succeeds' },
      };
    }
    await new Promise(() => undefined);
    throw new Error('unreachable');
  });

  const run = await runTask({
    ids: 'Q1',
    adapter,
    config: sharedOsConfig(['Q1'], { maxRuntimeMs: 500 }),
  });

  assert.equal(run.result.status, 'infrastructure_error');
  assert.ok(
    run.result.violations.includes('max_runtime_ms_exceeded'),
    `violations: ${run.result.violations.join(',')}`,
  );
  assert.equal(run.result.evaluation, null);
});

test('capability mapping and expected visibility derive from one boundary plan', () => {
  assert.deepEqual(grantedSharedOsActionsV1(FULL_PLAN), {
    notes: ['search', 'read', 'create', 'edit'],
    todos: ['search', 'read', 'create', 'edit', 'complete'],
  });
  assert.deepEqual(grantedSharedOsActionsV1(NOTES_ONLY_PLAN), {
    notes: ['search', 'read'],
    todos: [],
  });
  assert.deepEqual(
    expectedVisibleSharedOsToolsV1(NOTES_ONLY_PLAN),
    ['search_notes', 'get_note'],
  );
  assert.deepEqual(expectedVisibleSharedOsToolsV1(FULL_PLAN), [
    'search_notes',
    'get_note',
    'create_note',
    'edit_note',
    'search_todos',
    'get_todo',
    'create_todo',
    'edit_todo',
    'complete_todo',
  ]);
});

test('the adapter switch is config-owned and defaults to the public runner', () => {
  const withoutExecution = pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'test-model',
    },
  });
  assert.equal(selectedPactExecutionAdapterV1(withoutExecution), 'pact-public-runner');
  // Absence must stay absent in the parsed representation so existing
  // configurations keep their byte-identical reproducibility digest.
  assert.equal('execution' in withoutExecution.benchmark, false);
  assert.equal(
    selectedPactExecutionAdapterV1(sharedOsConfig(['Q1'])),
    'sharedos-embedded',
  );
});

class ScriptedAdapter implements PactAdapterV1 {
  constructor(
    private readonly decide: (
      observation: PactObservationV1,
    ) => PactDecisionV1 | Promise<PactDecisionV1>,
    private readonly plan: PactBoundaryPlanV1 = FULL_PLAN,
  ) {}

  async initialize(init: PactRunInitV1): Promise<void> {
    assert.equal(init.tools.length, 9);
  }

  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return this.plan;
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    return this.decide(observation);
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'completed' };
  }
}

test('the full requester grid runs actions through the kernel with an invariant grant envelope', { skip }, async () => {
  // Requester → grants decision (documented in docs/pact-pair-requester-grid.md):
  // the kernel grant envelope is requester-INVARIANT — the requester axis
  // conditions gold expectations, never capability. Grants stay subject-bound
  // to the per-requester sender address, so audit events attribute every
  // authorization to the requester principal, but each cohort can physically
  // attempt the same surface; refusals must come from the agent's judgment,
  // not from a kernel gate that would make the measurement circular.
  const requesters = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
  const grantEnvelopes = new Set<string>();
  for (const requester of requesters) {
    const config = pactRunConfigV1Schema.parse({
      apiVersion: 'pact-run/v1',
      kind: 'RunConfig',
      model: {
        provider: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        apiKeyEnv: 'PACT_MODEL_API_KEY',
        model: 'test-model',
      },
      benchmark: {
        dataset: 'pact-pair',
        policy: 'D2',
        requester,
        tasks: { kind: 'action', ids: ['A1'] },
        execution: { adapter: 'sharedos-embedded' },
      },
      budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
      output: { directory: 'runs', saveTraces: true },
    });
    const tasks = loadPactPairTasksV1({
      policy: 'D2',
      requester,
      gradingMode: 'category',
      kind: 'action',
      ids: ['A1'],
    });
    assert.equal(tasks.length, 1);
    const adapter = new ScriptedAdapter(observation => observation.type === 'task'
      ? {
          type: 'tool_call',
          toolName: 'create_note',
          input: {
            folder: 'Shared',
            title: 'Product sync summary',
            content: 'Calendar integration was approved; launch target is April.',
          },
        }
      : { type: 'answer', content: 'Done.' });
    const run = await runSinglePactPairTaskV1({
      config,
      task: tasks[0]!,
      seed: loadCanonicalPactPairStoreV1(),
      runId: `sharedos-grid-${requester}`,
      now: () => new Date(),
      harnessFactory: () => adapter,
      environment: {},
    });

    assert.equal(run.result.status, 'ok', `grid cell A1×${requester} must execute`);
    assert.equal(run.result.sharedOs?.adapterId, 'sharedos-embedded');
    assert.equal(run.result.sharedOs?.status, 'succeeded');
    assert.equal(run.result.publicTask.requester.id, requester);
    assert.equal(run.result.evaluation?.correct, true);
    grantEnvelopes.add(JSON.stringify(run.result.grantedAccess));
  }
  assert.equal(
    grantEnvelopes.size,
    1,
    'the kernel grant envelope must not vary with the requester cohort',
  );
});
