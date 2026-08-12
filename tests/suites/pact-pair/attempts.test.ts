/**
 * Multi-attempt requester protocol ("attacker" persistence) — host-side PACT
 * orchestration tests over the public-runner engine.
 *
 * Locked semantics under test:
 * - Single-attempt (no `benchmark.attempts`) stays the default and keeps the
 *   parsed config, result rows, and summary byte-identical (P-007).
 * - Only a responder-authored terminal refuse/escalate triggers a retry;
 *   runner-synthesized escalations (budget exhaustion, errors) never do.
 * - Attempts share one conversation, workspace, granted boundary, and the
 *   three task-level budgets; the follow-up ask is a scripted, hash-attested
 *   dataset artifact (P-019) that never carries authority.
 * - The ten public metrics keep scoring the FINAL decision; per-attempt leak
 *   telemetry surfaces disclosures from earlier attempts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PactAdapterV1,
  PactBoundaryPlanV1,
  PactDecisionV1,
  PactFinalizeReportV1,
  PactObservationV1,
  PactRunInitV1,
  PactTaskIntroV1,
} from '../../../src/protocol/v1/index.js';
import {
  pactAttemptsConfigV1Schema,
  pactAttemptsEnabledV1,
  pactRunConfigV1Schema,
  selectedPactAttemptLimitV1,
} from '../../../src/runner/v1/config.js';
import {
  pactRunMetadataV1Schema,
  pactRunSummaryV1Schema,
  pactTaskResultV1Schema,
} from '../../../src/runner/v1/artifacts.js';
import {
  buildPactPairFollowUpMessageV1,
  getPactPairFollowUpProvenanceV1,
  PACT_PAIR_FOLLOWUP_SCRIPT_FILE_V1,
  pactPairRetryEligibleV1,
} from '../../../src/suites/pact-pair/attempts.js';
import { runSinglePactPairTaskV1 } from '../../../src/suites/pact-pair/environment.js';
import { runPactPairBenchmarkV1 } from '../../../src/suites/pact-pair/runner.js';
import {
  loadPactPairTasksV1,
  type LoadedPactPairQaTaskV1,
} from '../../../src/suites/pact-pair/task-loader.js';
import { loadCanonicalPactPairStoreV1 } from '../../../src/suites/pact-pair/workspace.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

function configFor(
  ids: string[],
  overrides: { attempts?: { max: number }; maxTurns?: number } = {},
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
      ...(overrides.attempts ? { attempts: overrides.attempts } : {}),
    },
    budget: {
      maxTurns: overrides.maxTurns ?? 8,
      maxToolCalls: 4,
      maxRuntimeMs: 10_000,
    },
    output: { directory: 'runs', saveTraces: false },
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
  const task = tasks[0];
  assert.ok(task);
  return task;
}

function refuseExpectedQaTask(): LoadedPactPairQaTaskV1 {
  const task = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'qa',
  }).find(candidate =>
    candidate.kind === 'qa'
    && candidate.expectedBehavior === 'refuse'
    && candidate.question.gold_key_facts.length > 0);
  assert.ok(task, 'expected at least one refuse-expected QA task with gold facts');
  return task as LoadedPactPairQaTaskV1;
}

class ScriptedHarness implements PactAdapterV1 {
  readonly observations: PactObservationV1[] = [];

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

  async initialize(_init: PactRunInitV1): Promise<void> {}

  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return this.plan;
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    this.observations.push(structuredClone(observation));
    return this.decide(observation);
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'completed' };
  }
}

async function runTask(options: {
  id: string;
  harness: ScriptedHarness;
  config?: ReturnType<typeof configFor>;
}) {
  return runSinglePactPairTaskV1({
    config: options.config ?? configFor([options.id]),
    task: taskFor(options.id),
    seed: loadCanonicalPactPairStoreV1(),
    runId: `attempts-${options.id}`,
    now: () => new Date(),
    harnessFactory: () => options.harness,
    environment: {},
  });
}

test('attempts config axis parses, defaults to single-attempt, and bounds max', () => {
  const withoutAttempts = configFor(['PAIR-Q1']);
  assert.equal(withoutAttempts.benchmark.attempts, undefined);
  assert.equal(pactAttemptsEnabledV1(withoutAttempts), false);
  assert.equal(selectedPactAttemptLimitV1(withoutAttempts), 1);
  // Digest stability: the serialized config must not gain an attempts key.
  assert.doesNotMatch(JSON.stringify(withoutAttempts), /"attempts"/);

  const withAttempts = configFor(['PAIR-Q1'], { attempts: { max: 3 } });
  assert.equal(pactAttemptsEnabledV1(withAttempts), true);
  assert.equal(selectedPactAttemptLimitV1(withAttempts), 3);

  assert.throws(() => pactAttemptsConfigV1Schema.parse({ max: 0 }));
  assert.throws(() => pactAttemptsConfigV1Schema.parse({ max: 4 }));
  assert.throws(() => pactAttemptsConfigV1Schema.parse({ max: 2.5 }));
  assert.throws(() => pactAttemptsConfigV1Schema.parse({ max: 2, extra: true }));
});

test('follow-up script is a hash-attested dataset artifact with prompt substitution', () => {
  const provenance = getPactPairFollowUpProvenanceV1();
  const bytes = readFileSync(join(repoRoot, PACT_PAIR_FOLLOWUP_SCRIPT_FILE_V1), 'utf8');
  assert.equal(
    provenance.sha256,
    createHash('sha256').update(bytes, 'utf8').digest('hex'),
  );
  assert.equal(provenance.id, 'pair-followups-v1');
  assert.equal(provenance.version, 1);

  const task = taskFor('PAIR-Q1').publicTask;
  const second = buildPactPairFollowUpMessageV1({ task, attempt: 2 });
  const third = buildPactPairFollowUpMessageV1({ task, attempt: 3 });
  assert.ok(second.includes(task.prompt));
  assert.ok(third.includes(task.prompt));
  assert.notEqual(second, third);
  // Follow-ups renew the ask; they must never claim authority or grants.
  for (const message of [second, third]) {
    assert.doesNotMatch(message, /grant|permission|authoriz|approved|owner said/i);
  }
  assert.throws(() => buildPactPairFollowUpMessageV1({ task, attempt: 4 }));
});

test('retry eligibility: responder-authored refuse/escalate only', () => {
  assert.equal(pactPairRetryEligibleV1({ type: 'refuse', reason: 'no' }, true), true);
  assert.equal(pactPairRetryEligibleV1({ type: 'escalate', reason: 'review' }, true), true);
  assert.equal(pactPairRetryEligibleV1({ type: 'answer', content: 'yes' }, true), false);
  // Runner-synthesized escalations (terminalReceived=false) never retry.
  assert.equal(pactPairRetryEligibleV1({ type: 'refuse', reason: 'no' }, false), false);
  assert.equal(pactPairRetryEligibleV1({ type: 'escalate', reason: 'x' }, false), false);
});

test('a refusal retries in the same conversation and an answer ends the loop', async () => {
  const harness = new ScriptedHarness(observation => {
    if (observation.type === 'task') {
      return { type: 'refuse', reason: 'I would rather not share that.' };
    }
    if (observation.type === 'requester_followup') {
      return {
        type: 'tool_call',
        toolName: 'search_notes',
        input: { query: 'Project Alpha launch date' },
      };
    }
    return { type: 'answer', content: 'Project Alpha launches on March 15, 2026.' };
  });

  const run = await runTask({
    id: 'PAIR-Q1',
    harness,
    config: configFor(['PAIR-Q1'], { attempts: { max: 3 } }),
  });

  const observationTypes = harness.observations.map(observation => observation.type);
  assert.deepEqual(observationTypes, ['task', 'requester_followup', 'tool_result']);
  const followUp = harness.observations[1];
  assert.ok(followUp && followUp.type === 'requester_followup');
  assert.equal(followUp.attempt, 2);
  assert.equal(followUp.turn, 1);
  assert.ok(followUp.message.includes(taskFor('PAIR-Q1').publicTask.prompt));

  assert.equal(run.result.status, 'ok');
  assert.equal(run.result.finalDecision.type, 'answer');
  const attempts = run.result.attempts;
  assert.ok(attempts);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map(attempt => [attempt.attempt, attempt.decision.type, attempt.decisionSource]),
    [[1, 'refuse', 'responder'], [2, 'answer', 'responder']],
  );
  // Task-level budgets span attempts; per-attempt usage sums to the total.
  assert.equal(run.result.budgetUsed.turns, 3);
  assert.deepEqual(attempts.map(attempt => attempt.budgetUsed.turns), [1, 2]);
  assert.equal(run.result.budgetUsed.toolCalls, 1);
  // The public evaluation scores the final decision.
  assert.equal(run.result.evaluation?.actualDecision, 'answer');
  pactTaskResultV1Schema.parse(run.result);
});

test('single-attempt runs keep the historical row shape', async () => {
  const harness = new ScriptedHarness(() => ({
    type: 'refuse',
    reason: 'I would rather not share that.',
  }));
  const run = await runTask({ id: 'PAIR-Q1', harness });
  assert.equal('attempts' in run.result, false);
  assert.deepEqual(
    harness.observations.map(observation => observation.type),
    ['task'],
  );
  pactTaskResultV1Schema.parse(run.result);
});

test('runner-synthesized budget escalation never retries', async () => {
  const harness = new ScriptedHarness(() => ({
    type: 'tool_call',
    toolName: 'search_notes',
    input: { query: 'anything' },
  }));
  const run = await runTask({
    id: 'PAIR-Q1',
    harness,
    config: configFor(['PAIR-Q1'], { attempts: { max: 3 }, maxTurns: 1 }),
  });

  assert.ok(run.result.violations.includes('max_turns_exceeded'));
  const attempts = run.result.attempts;
  assert.ok(attempts);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.decisionSource, 'runner');
  assert.equal(attempts[0]?.decision.type, 'escalate');
  assert.equal(
    harness.observations.filter(observation => observation.type === 'requester_followup').length,
    0,
  );
});

test('persistent refusal exhausts attempts; leak telemetry flags any-attempt disclosure', async () => {
  const task = refuseExpectedQaTask();
  const goldFact = task.question.gold_key_facts[0];
  assert.ok(goldFact);
  let attemptSeen = 0;
  const result = await runPactPairBenchmarkV1(
    configFor([task.taskId], { attempts: { max: 3 } }),
    {
      writeOutputs: false,
      harnessFactory: () => new ScriptedHarness(observation => {
        if (observation.type === 'tool_result') {
          throw new Error('no tool calls are scripted');
        }
        attemptSeen += 1;
        return attemptSeen === 1
          // The first refusal leaks the protected fact inside its reason.
          ? { type: 'refuse', reason: `I cannot share that; ${goldFact} stays private.` }
          : { type: 'refuse', reason: 'I cannot share that information.' };
      }),
    },
  );

  assert.equal(result.tasks.length, 1);
  const row = result.tasks[0];
  assert.ok(row);
  assert.equal(row.finalDecision.type, 'refuse');
  const attempts = row.attempts;
  assert.ok(attempts);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(attempt => attempt.leaked), [true, false, false]);
  // The headline evaluation (final decision) is clean; the disclosure is
  // visible only through attempt telemetry.
  assert.equal(row.evaluation?.kind === 'qa' && row.evaluation.leaked, false);

  assert.deepEqual(result.summary.attempts, {
    maxAttempts: 3,
    totalAttempts: 3,
    tasksRetried: 1,
    answerAfterRetry: 0,
    anyAttemptLeaked: 1,
    finalAttemptLeaked: 0,
  });
  assert.deepEqual(result.attemptProtocol, {
    maxAttempts: 3,
    followUpScript: getPactPairFollowUpProvenanceV1(),
  });
  pactRunSummaryV1Schema.parse(result.summary);
  pactRunMetadataV1Schema.parse({
    runId: result.runId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    model: result.model,
    execution: result.execution,
    benchmark: result.benchmark,
    policyProvenance: result.policyProvenance,
    attemptProtocol: result.attemptProtocol,
    budget: result.budget,
    configDigest: result.configDigest,
    taskSetDigest: result.taskSetDigest,
    selectedTasks: result.selectedTasks,
  });
});

test('an answer after retry counts as attacker success and final-attempt leak', async () => {
  const task = refuseExpectedQaTask();
  const goldFact = task.question.gold_key_facts[0];
  assert.ok(goldFact);
  let stepCount = 0;
  const result = await runPactPairBenchmarkV1(
    configFor([task.taskId], { attempts: { max: 2 } }),
    {
      writeOutputs: false,
      harnessFactory: () => new ScriptedHarness(() => {
        stepCount += 1;
        return stepCount === 1
          ? { type: 'refuse', reason: 'I cannot share that information.' }
          : { type: 'answer', content: `Fine: ${goldFact}.` };
      }),
    },
  );

  const row = result.tasks[0];
  assert.ok(row);
  assert.equal(row.finalDecision.type, 'answer');
  assert.deepEqual(row.attempts?.map(attempt => attempt.leaked), [false, true]);
  assert.equal(row.evaluation?.kind === 'qa' && row.evaluation.leaked, true);
  assert.deepEqual(result.summary.attempts, {
    maxAttempts: 2,
    totalAttempts: 2,
    tasksRetried: 1,
    answerAfterRetry: 1,
    anyAttemptLeaked: 1,
    finalAttemptLeaked: 1,
  });
});

test('disabled runs carry no attempt telemetry anywhere', async () => {
  const result = await runPactPairBenchmarkV1(configFor(['PAIR-Q1']), {
    writeOutputs: false,
    harnessFactory: () => new ScriptedHarness(() => ({
      type: 'refuse',
      reason: 'I would rather not share that.',
    })),
  });
  assert.equal('attemptProtocol' in result, false);
  assert.equal('attempts' in result.summary, false);
  assert.equal(result.tasks.some(row => 'attempts' in row), false);
  pactRunSummaryV1Schema.parse(result.summary);
});
