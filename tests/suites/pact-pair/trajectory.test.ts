/**
 * End-to-end integration for the multi-turn trajectory lane over the REAL
 * SharedOS kernel: one persistent world driven across ticks, per-tick re-based
 * grading, Phase-2 retries flipping a refusal to an answer, and the trajectory
 * artifact shape. Requires a built SharedOS checkout (PACT_SHAREDOS_DIR);
 * skipped with a reason otherwise (hard failure under PACT_REQUIRE_SHAREDOS).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PactBoundaryPlanV1,
  PactDecisionV1,
  PactFinalizeReportV1,
  PactHarnessV1,
  PactObservationV1,
  PactRunInitV1,
  PactTaskIntroV1,
} from '../../../src/protocol/v1/index.js';
import { pactRunConfigV1Schema } from '../../../src/runner/v1/config.js';
import { loadSharedOsModulesV1 } from '../../../src/execution/sharedos/v1/index.js';
import { loadPactPairTasksV1 } from '../../../src/suites/pact-pair/task-loader.js';
import { loadCanonicalPactPairStoreV1 } from '../../../src/suites/pact-pair/workspace.js';
import { runPactPairTrajectoryV1 } from '../../../src/suites/pact-pair/trajectory.js';
import { runPactPairTrajectoryBenchmarkV1 } from '../../../src/suites/pact-pair/trajectory-runner.js';
import { createScriptedPactPairRequesterDriverV1 } from '../../../src/suites/pact-pair/requester-driver.js';

const loaded = await loadSharedOsModulesV1();
const skip = loaded.ok ? false : loaded.reason;
if (!loaded.ok) {
  if (process.env.PACT_REQUIRE_SHAREDOS) {
    throw new Error(
      `PACT_REQUIRE_SHAREDOS is set but SharedOS could not be loaded: ${loaded.reason}`,
    );
  }
  console.log(`[trajectory] skipping integration tests: ${loaded.reason}`);
}

const NOTES_QA_PLAN: PactBoundaryPlanV1 = {
  access: {
    notes: { read: { scope: 'all' }, write: false },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
};

/**
 * A stateful scripted responder for one trajectory: refuses the first
 * `refusalsBeforeFlip` asks, then searches notes and answers. Tracks
 * initialize calls (must be exactly one — the world persists) and the number
 * of asks it saw (proving the transcript accumulates across ticks).
 */
class FlipResponder implements PactHarnessV1 {
  initializeCount = 0;
  askCount = 0;
  constructor(private readonly refusalsBeforeFlip: number) {}
  async initialize(_init: PactRunInitV1): Promise<void> {
    this.initializeCount += 1;
  }
  async planBoundary(_task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    return NOTES_QA_PLAN;
  }
  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    if (observation.type === 'task' || observation.type === 'requester_message') {
      this.askCount += 1;
      if (this.askCount <= this.refusalsBeforeFlip) {
        return { type: 'refuse', reason: 'That information is private.' };
      }
      return { type: 'tool_call', toolName: 'search_notes', input: { query: 'Project Alpha launch date' } };
    }
    return { type: 'answer', content: 'Project Alpha launches on March 15, 2026.' };
  }
  async finalize(): Promise<PactFinalizeReportV1> {
    return { status: 'completed' };
  }
}

function trajectoryConfig(ids: string[], overrides: { maxTicks?: number; phase2StartTick?: number } = {}) {
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
      trajectory: {
        maxTicks: overrides.maxTicks ?? 5,
        ...(overrides.phase2StartTick !== undefined
          ? { phase2StartTick: overrides.phase2StartTick }
          : {}),
        requesterDriver: { kind: 'scripted' },
      },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
    output: { directory: 'runs', saveTraces: true },
  });
}

test('a trajectory persists one world across ticks and Phase 2 flips a refusal to an answer', { skip }, async () => {
  const config = trajectoryConfig(['Q1'], { maxTicks: 5, phase2StartTick: 2 });
  const tasks = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'all',
    ids: ['Q1'],
  });
  const responder = new FlipResponder(2); // refuse tick 1 & 2, answer tick 3

  const result = await runPactPairTrajectoryV1({
    config,
    tasks,
    seed: loadCanonicalPactPairStoreV1(),
    runId: 'traj-test-1',
    trajectoryId: 'traj-test-1:traj-1',
    maxTicks: 5,
    phase2StartTick: 2,
    trajectoryRuntimeMs: 60_000,
    now: () => new Date(),
    harnessFactory: () => responder,
    driver: createScriptedPactPairRequesterDriverV1(),
    environment: {},
  });

  // World persistence: the responder was initialized exactly once and saw one
  // ask per tick on a growing transcript.
  assert.equal(responder.initializeCount, 1);
  assert.equal(result.tickCount, 3);
  assert.equal(responder.askCount, 3);

  // Tick 1 (phase 1) refused; ticks 2-3 (phase 2) retried; tick 3 flipped.
  assert.equal(result.ticks[0].phase, 1);
  assert.equal(result.ticks[0].finalDecision.type, 'refuse');
  assert.equal(result.ticks[1].phase, 2);
  assert.equal(result.ticks[1].finalDecision.type, 'refuse');
  assert.equal(result.ticks[2].phase, 2);
  assert.equal(result.ticks[2].finalDecision.type, 'answer');
  assert.equal(result.ticks[2].retryOfTick, 2);

  // Each tick carries a distinct SharedOS turn id + succeeded status.
  for (const tick of result.ticks) {
    assert.equal(tick.sharedOs?.status, 'succeeded');
    assert.equal(tick.terminalReceived, true);
  }

  // The flip tick's answer is graded correct against Q1 gold (per-tick re-based).
  assert.equal(result.ticks[2].evaluation?.correct, true);
  assert.equal(result.endReason, 'driver_stop');
  const q1 = result.checklist.find(item => item.taskId === 'PAIR-Q1');
  assert.equal(q1?.status, 'answered');
  assert.equal(q1?.asks, 3);
});

test('runPactPairTrajectoryBenchmarkV1 emits the trajectory artifact shape', { skip }, async () => {
  const config = trajectoryConfig(['Q1'], { maxTicks: 3, phase2StartTick: 2 });
  const result = await runPactPairTrajectoryBenchmarkV1(config, {
    harnessFactory: () => new FlipResponder(1), // refuse tick 1, answer tick 2
    writeOutputs: false,
    runId: 'traj-bench-1',
    environment: {},
  });

  assert.ok(result.trajectoryProtocol);
  assert.equal(result.trajectoryProtocol?.schemaVersion, 1);
  assert.equal(result.trajectoryProtocol?.requesterDriver.kind, 'scripted');
  assert.equal(result.trajectories?.length, 1);
  assert.ok(result.trajectorySummary);
  assert.equal(result.trajectorySummary?.itemsAnswered, 1);
  // One flip: the phase-2 retry (strategy[0] = repeat) turned the refusal into
  // an answer.
  assert.equal(result.trajectorySummary?.flipsByStrategy.repeat, 1);
  // The synthetic per-tick trials populate the frozen summary too.
  assert.equal(result.tasks.length, result.trajectorySummary?.totalTicks);
});
