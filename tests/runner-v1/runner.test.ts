import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { pactRunConfigV1Schema } from '../../src/runner/v1/config.js';
import {
  pactRunMetadataV1Schema,
  pactRunSummaryV1Schema,
  pactTaskResultV1Schema,
  pactTraceEventV1Schema,
} from '../../src/runner/v1/artifacts.js';
import { PactProviderRequestErrorV1 } from '../../src/runner/v1/model-adapter.js';
import { runPactPairBenchmarkV1 } from '../../src/runner/v1/runner.js';
import { loadCanonicalPactPairStoreV1 } from '../../src/runner/v1/workspace.js';

test('runs the protocol lifecycle through a QA lookup and deterministic score', async () => {
  const adapter = new ScriptedAdapter(observation => {
    if (observation.type === 'task') {
      assert.doesNotMatch(
        JSON.stringify(observation.task),
        /gold_key_facts|minimum_correct|source_notes|category/,
      );
      return {
        type: 'tool_call',
        toolName: 'search_notes',
        input: { query: 'Project Alpha launch date' },
      };
    }
    assert.equal(observation.toolName, 'search_notes');
    assert.equal(observation.isError, false);
    assert.match(JSON.stringify(observation.output), /March 15, 2026/);
    return { type: 'answer', content: 'Project Alpha launches on March 15, 2026.' };
  });

  const result = await runPactPairBenchmarkV1(configFor(['Q1']), {
    harnessFactory: context => {
      assert.deepEqual(Object.keys(context).sort(), ['config', 'publicTask']);
      assert.doesNotMatch(JSON.stringify(context.publicTask), /gold_key_facts|minimum_correct/);
      return adapter;
    },
    runId: 'qa-integration',
    writeOutputs: false,
  });

  assert.equal(adapter.initialized, true);
  assert.equal(adapter.finalized, true);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.correct, 1);
  assert.equal(result.summary.qa.correctAnswers, 1);
  assert.deepEqual(result.summary.metrics.informationUtility, {
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  assert.equal(result.summary.metrics.actionUtility.value, null);
  assert.equal(result.tasks[0]?.budgetUsed.turns, 2);
  assert.equal(result.tasks[0]?.budgetUsed.toolCalls, 1);
  assert.deepEqual(Object.keys(result.tasks[0]?.toolCalls[0] ?? {}).sort(), [
    'id',
    'isError',
    'name',
  ]);
  assert.deepEqual(result.tasks[0]?.violations, []);
  assert.doesNotMatch(
    JSON.stringify(result.tasks[0]?.evaluation),
    /expectedBehavior|matchedFacts|missedFacts|leakedFacts|minimumCorrect|goldCheck/,
  );
});

test('executes and scores one exact action without mutating the canonical seed', async () => {
  const seed = loadCanonicalPactPairStoreV1();
  const originalNoteCount = seed.notes.length;
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

  const result = await runPactPairBenchmarkV1(configFor(['A1']), {
    adapterFactory: () => adapter,
    seed,
    runId: 'action-integration',
    writeOutputs: false,
  });

  assert.equal(result.summary.actions.correctExecutions, 1);
  assert.equal(result.summary.metrics.actionUtility.value, 1);
  assert.equal(result.tasks[0]?.evaluation.kind, 'action');
  assert.equal(result.tasks[0]?.evaluation.correct, true);
  assert.equal(seed.notes.length, originalNoteCount);
  assert.equal(seed.notes.some(note => note.title === 'Product sync summary'), false);
});

test('intersects adapter requests with the runner maximum before tool execution', async () => {
  const adapter = new ScriptedAdapter(
    observation => observation.type === 'task'
      ? {
          type: 'tool_call',
          toolName: 'create_note',
          input: { folder: 'Shared', title: 'Not allowed', content: 'No.' },
        }
      : { type: 'refuse', reason: 'The write was denied.' },
    {
      access: {
        notes: { read: { scope: 'all' }, write: true },
        todos: { read: true, write: true },
        memory: { read: 'all', write: true },
      },
    },
  );

  const result = await runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => adapter,
    runId: 'boundary-integration',
    writeOutputs: false,
  });
  const task = result.tasks[0];
  assert.ok(task);
  assert.equal(task.grantedAccess.access.notes.write, false);
  assert.equal(task.grantedAccess.access.todos.write, false);
  assert.equal(task.grantedAccess.access.memory.read, 'none');
  assert.equal(task.toolCalls[0]?.isError, true);
});

test('adapter-side mutation cannot change runner task, config, or access state', async () => {
  const config = configFor(['Q1']);
  const result = await runPactPairBenchmarkV1(config, {
    adapterFactory: context => {
      context.config.budget.maxTurns = 64;
      const publicTask = context.publicTask as unknown as {
        kind: string;
        surface: string;
      };
      publicTask.kind = 'action';
      publicTask.surface = 'notes';
      return new MutatingAdapter();
    },
    runId: 'mutation-isolation',
    writeOutputs: false,
  });

  assert.equal(config.budget.maxTurns, 4);
  assert.equal(result.budget.maxTurns, 4);
  assert.equal(result.tasks[0]?.publicTask.kind, 'qa');
  assert.equal(result.tasks[0]?.grantedAccess.access.notes.write, false);
  assert.equal(result.tasks[0]?.toolCalls[0]?.isError, true);
});

test('redacts provider secrets and writes the documented output files', async t => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-runner-output-'));
  t.after(() => rmSync(workingDirectory, { recursive: true, force: true }));
  const secret = 'sk-test-must-not-appear';
  const config = configFor(['Q1'], true);

  const result = await runPactPairBenchmarkV1(config, {
    adapterFactory: () => new ThrowingAdapter(`provider rejected ${secret}`),
    environment: { PACT_MODEL_API_KEY: secret },
    runId: 'redaction-integration',
    workingDirectory,
  });

  assert.equal(result.summary.errors, 1);
  assert.ok(result.outputDirectory);
  const run = readFileSync(join(result.outputDirectory, 'run.json'), 'utf8');
  const summary = readFileSync(join(result.outputDirectory, 'summary.json'), 'utf8');
  const results = readFileSync(join(result.outputDirectory, 'results.jsonl'), 'utf8');
  const trace = readFileSync(join(result.outputDirectory, 'trace.jsonl'), 'utf8');
  const combined = `${run}${summary}${results}${trace}`;
  pactRunMetadataV1Schema.parse(JSON.parse(run));
  pactRunSummaryV1Schema.parse(JSON.parse(summary));
  for (const line of results.trim().split('\n')) {
    pactTaskResultV1Schema.parse(JSON.parse(line));
  }
  for (const line of trace.trim().split('\n')) {
    pactTraceEventV1Schema.parse(JSON.parse(line));
  }
  assert.doesNotMatch(combined, new RegExp(secret));
  assert.match(results, /\[REDACTED\]/);
  assert.doesNotMatch(
    `${results}${trace}`,
    /expectedBehavior|matchedFacts|missedFacts|leakedFacts|minimumCorrect|goldCheck/,
  );
});

test('emits azure-openai run metadata for a local azure config', async () => {
  const azureConfig = pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    backend: { kind: 'local' },
    model: {
      provider: 'azure-openai',
      endpoint: 'https://contoso.openai.azure.com',
      deployment: 'gpt-4o-eval',
      apiVersion: '2024-10-21',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
    },
    benchmark: { policy: 'D2', requester: 'R1', tasks: { kind: 'all', ids: ['Q1'] } },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
    output: { directory: 'runs', saveTraces: false },
  });

  // The scripted adapter makes no model call, so this exercises the runner's
  // azure metadata branch (and its schema validation) without a live endpoint.
  const result = await runPactPairBenchmarkV1(azureConfig, {
    harnessFactory: () => new ScriptedAdapter(() => ({
      type: 'refuse',
      reason: 'Refused for the azure metadata test.',
    })),
    environment: {},
    runId: 'azure-metadata',
    writeOutputs: false,
  });

  assert.ok(result.model.provider === 'azure-openai');
  assert.equal(result.model.endpoint, 'https://contoso.openai.azure.com');
  assert.equal(result.model.deployment, 'gpt-4o-eval');
  assert.equal(result.model.apiVersion, '2024-10-21');
  assert.equal('baseUrl' in result.model, false);
  assert.doesNotMatch(JSON.stringify(result.model), /PACT_MODEL_API_KEY|api-key/);
});

test('redacts a credential echoed in a terminal model decision', async () => {
  const secret = 'sk-echoed-provider-secret';
  const adapter = new ScriptedAdapter(() => ({
    type: 'answer',
    content: `Project Alpha launches on March 15, 2026. ${secret}`,
  }));
  const result = await runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => adapter,
    environment: { PACT_MODEL_API_KEY: secret },
    runId: 'decision-redaction',
    writeOutputs: false,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.match(JSON.stringify(result.tasks[0]?.finalDecision), /\[REDACTED\]/);
});

test('config digest excludes machine-local resolved path metadata', async () => {
  const config = configFor(['Q1']);
  const createAdapter = () => new ScriptedAdapter(() => ({
    type: 'answer',
    content: 'Project Alpha launches on March 15, 2026.',
  }));
  const plain = await runPactPairBenchmarkV1(config, {
    adapterFactory: createAdapter,
    runId: 'digest-plain',
    writeOutputs: false,
  });
  const resolvedLike = await runPactPairBenchmarkV1({
    ...config,
    sourcePath: '/machine-a/pact-run.yaml',
    rootDir: '/machine-a',
  } as typeof config, {
    adapterFactory: createAdapter,
    runId: 'digest-resolved',
    writeOutputs: false,
  });
  assert.equal(plain.configDigest, resolvedLike.configDigest);
});

test('rejects adapter calls to tools outside the advertised protocol', async () => {
  const adapter = new ScriptedAdapter(() => ({
    type: 'tool_call',
    toolName: 'drop_database',
    input: {},
  }));
  const result = await runPactPairBenchmarkV1(configFor(['Q1']), {
    adapterFactory: () => adapter,
    runId: 'unknown-tool',
    writeOutputs: false,
  });

  const task = result.tasks[0];
  assert.ok(task);
  assert.deepEqual(task.violations, ['adapter_protocol_error']);
  assert.match(task.error ?? '', /unavailable tool drop_database/);
  assert.deepEqual(task.toolCalls, []);
  assert.equal(task.finalDecision.type, 'escalate');
});

test('stops a multi-task run after a permanent provider configuration error', async () => {
  let adaptersCreated = 0;
  const result = await runPactPairBenchmarkV1(configFor(['Q1', 'Q2']), {
    adapterFactory: () => {
      adaptersCreated += 1;
      return new ThrowingAdapter(new PactProviderRequestErrorV1(
        'OpenAI-compatible provider request failed with HTTP 401',
        { status: 401 },
      ));
    },
    runId: 'provider-fail-fast',
    writeOutputs: false,
  });

  assert.equal(adaptersCreated, 1);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.summary.errors, 1);
  assert.deepEqual(result.aborted, {
    afterTaskId: 'PAIR-Q1',
    reason: 'provider_configuration_error',
  });
});

class ScriptedAdapter implements PactAdapterV1 {
  initialized = false;
  finalized = false;

  constructor(
    private readonly decide: (observation: PactObservationV1) => PactDecisionV1,
    private readonly plan: PactBoundaryPlanV1 = {
      access: {
        notes: { read: { scope: 'all' }, write: true },
        todos: { read: true, write: true },
        memory: { read: 'none', write: false },
      },
    },
  ) {}

  async initialize(init: PactRunInitV1): Promise<void> {
    assert.equal(init.tools.length, 9);
    this.initialized = true;
  }

  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return this.plan;
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    return this.decide(observation);
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    this.finalized = true;
    return { status: 'completed' };
  }
}

class ThrowingAdapter implements PactAdapterV1 {
  constructor(private readonly failure: string | Error) {}

  async initialize(): Promise<void> {
    throw typeof this.failure === 'string' ? new Error(this.failure) : this.failure;
  }

  async planBoundary(): Promise<PactBoundaryPlanV1> {
    throw new Error('unreachable');
  }

  async step(): Promise<PactDecisionV1> {
    throw new Error('unreachable');
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'failed' };
  }
}

class MutatingAdapter implements PactAdapterV1 {
  private turn = 0;

  async initialize(init: PactRunInitV1): Promise<void> {
    init.budget.maxTurns = 64;
    init.tools.splice(0, init.tools.length);
  }

  async planBoundary(task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    const mutable = task as unknown as { kind: string; surface: string };
    mutable.kind = 'action';
    mutable.surface = 'notes';
    return {
      access: {
        notes: { read: { scope: 'all' }, write: true },
        todos: { read: true, write: true },
        memory: { read: 'all', write: true },
      },
    };
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    if (observation.type === 'task') {
      const mutable = observation.task as unknown as { kind: string; surface: string };
      mutable.kind = 'action';
      mutable.surface = 'notes';
    }
    this.turn += 1;
    return this.turn === 1
      ? {
          type: 'tool_call',
          toolName: 'create_note',
          input: { folder: 'Shared', title: 'Mutation probe', content: 'blocked' },
        }
      : { type: 'refuse', reason: 'The write was denied.' };
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'completed' };
  }
}

function configFor(ids: string[], saveTraces = false) {
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
      policy: 'D2',
      requester: 'R1',
      tasks: { kind: 'all', ids },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
    output: { directory: 'runs', saveTraces },
  });
}
