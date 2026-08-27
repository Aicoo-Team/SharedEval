import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveExperimentCellIdV1,
  deriveExperimentPlanDigestV1,
  experimentPlanV1Schema,
} from '../../src/experiments/v1/contracts.js';
import { deriveExperimentRunIdV1 } from '../../src/experiments/v1/plan.js';
import type { PublishedExperimentPlanV1 } from '../../src/experiments/v1/plan.js';
import {
  DEFAULT_EXPERIMENT_SCHEDULE_BACKOFF_V1,
  MAX_EXPERIMENT_SCHEDULE_CONCURRENCY_V1,
  compileExperimentPlanV1,
  experimentBackoffDelayMsV1,
  experimentCellCommandV1,
  runExperimentScheduleV1,
} from '../../src/experiments/v1/scheduler.js';
import type {
  ExperimentCellExecResultV1,
  ExperimentCellExitOutcomeV1,
  ExperimentCellManifestV1,
  ExperimentRunStartStatusV1,
  ExperimentScheduleClockV1,
  ExperimentScheduleOptionsV1,
} from '../../src/experiments/v1/scheduler.js';

const CONFIG_DIRECTORY = '/home/runner/experiments/exp-sched/configs';

function cellInputFixture(replicate: number): unknown {
  return {
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      model: 'example-model',
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      gradingMode: 'category',
      tasks: { kind: 'all' },
    },
    workflow: { mode: 'multi', protocol: 'files', maxTicks: 32, stopWhen: 'all-terminal' },
    budget: { maxToolCalls: 8, maxRuntimeMs: 60_000 },
    replicate,
    provenance: {
      configDigest: 'a'.repeat(64),
      taskSetDigest: 'c'.repeat(64),
      sharedosRevision: 'b'.repeat(40),
      sharedosRuntimeDigest: 'd'.repeat(64),
    },
  };
}

function publishedPlanFixture(replicates: readonly number[]): PublishedExperimentPlanV1 {
  const plan = experimentPlanV1Schema.parse({
    apiVersion: 'sharedeval-experiment-plan/v1',
    kind: 'ExperimentPlan',
    experimentId: 'exp-sched',
    cells: replicates.map(replicate => cellInputFixture(replicate)),
  });
  const planDigest = deriveExperimentPlanDigestV1(plan);
  const cells = plan.cells.map(cell => {
    const cellId = deriveExperimentCellIdV1(cell);
    return {
      planDigest,
      experimentId: plan.experimentId,
      cellId,
      runId: deriveExperimentRunIdV1(plan.experimentId, cellId, cell.replicate),
      replicate: cell.replicate,
      cell,
    };
  });
  return { plan, planDigest, cells };
}

function compiledManifests(replicates: readonly number[]): readonly ExperimentCellManifestV1[] {
  return compileExperimentPlanV1(publishedPlanFixture(replicates), {
    configDirectory: CONFIG_DIRECTORY,
  });
}

type FakeClock = ExperimentScheduleClockV1 & { readonly sleeps: readonly number[] };

function fakeClock(): FakeClock {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => {
      nowMs += 1;
      return nowMs;
    },
    sleep: async delayMs => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
  };
}

const COMMITTED_EXIT: ExperimentCellExecResultV1 = { exitCode: 0, signal: null };
const FAILED_EXIT: ExperimentCellExecResultV1 = { exitCode: 1, signal: null };

type ScheduleHarness = {
  readonly execCommands: ReadonlyArray<readonly string[]>;
  readonly execRunIds: readonly string[];
  readonly probeCalls: readonly string[];
  readonly clock: FakeClock;
  readonly options: ExperimentScheduleOptionsV1;
};

function harness(
  outcomes: (
    manifest: ExperimentCellManifestV1,
    attempt: number,
  ) => ExperimentCellExitOutcomeV1,
  startStatus: ExperimentRunStartStatusV1 = 'provably_not_started',
  overrides: Partial<ExperimentScheduleOptionsV1> = {},
): ScheduleHarness {
  const execCommands: Array<readonly string[]> = [];
  const execRunIds: string[] = [];
  const probeCalls: string[] = [];
  const attemptsByRunId = new Map<string, number>();
  const clock = fakeClock();
  return {
    execCommands,
    execRunIds,
    probeCalls,
    clock,
    options: {
      exec: async (command, manifest) => {
        execCommands.push(command);
        execRunIds.push(manifest.runId);
        const attempt = (attemptsByRunId.get(manifest.runId) ?? 0) + 1;
        attemptsByRunId.set(manifest.runId, attempt);
        return outcomes(manifest, attempt).kind === 'committed'
          ? COMMITTED_EXIT
          : FAILED_EXIT;
      },
      classifyExit: (manifest, _exit) =>
        outcomes(manifest, attemptsByRunId.get(manifest.runId) ?? 1),
      probeRunStart: manifest => {
        probeCalls.push(manifest.runId);
        return startStatus;
      },
      clock,
      ...overrides,
    },
  };
}

const alwaysCommitted = (): ExperimentCellExitOutcomeV1 => ({ kind: 'committed' });

test('compilePlan orders manifests deterministically and builds CLI commands', () => {
  const forward = compileExperimentPlanV1(publishedPlanFixture([1, 2, 3]), {
    configDirectory: CONFIG_DIRECTORY,
  });
  const shuffled = compileExperimentPlanV1(publishedPlanFixture([3, 1, 2]), {
    configDirectory: CONFIG_DIRECTORY,
  });

  const sortedRunIds = [...forward.map(manifest => manifest.runId)].sort();
  assert.deepEqual(forward.map(manifest => manifest.runId), sortedRunIds);
  assert.deepEqual(
    shuffled.map(manifest => manifest.runId),
    forward.map(manifest => manifest.runId),
  );
  assert.deepEqual(
    shuffled.map(manifest => manifest.cellId),
    forward.map(manifest => manifest.cellId),
  );

  for (const manifest of forward) {
    assert.equal(manifest.mode, 'multi');
    assert.equal(
      manifest.configPath,
      `${CONFIG_DIRECTORY}/${manifest.cellId}.sharedeval-run.yaml`,
    );
    assert.deepEqual(
      [...manifest.command],
      [
        'npm',
        'run',
        'sharedeval',
        '--',
        'multi',
        '--config',
        manifest.configPath,
        '--run-id',
        manifest.runId,
      ],
    );
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.command));
  }
});

test('compilePlan supports a wrapper-script launcher', () => {
  const [manifest] = compileExperimentPlanV1(publishedPlanFixture([1]), {
    configDirectory: CONFIG_DIRECTORY,
    launcher: { kind: 'wrapper-script', scriptPath: '/home/runner/bin/run-cell.sh' },
  });
  assert.deepEqual(
    [...manifest.command],
    [
      '/home/runner/bin/run-cell.sh',
      'multi',
      '--config',
      manifest.configPath,
      '--run-id',
      manifest.runId,
    ],
  );
  assert.throws(
    () =>
      experimentCellCommandV1('multi', manifest.configPath, manifest.runId, {
        kind: 'wrapper-script',
        scriptPath: '   ',
      }),
    /wrapper script path/,
  );
});

test('runSchedule rejects concurrency above the hard cap and below one', async () => {
  const manifests = compiledManifests([1]);
  const { options } = harness(alwaysCommitted);
  await assert.rejects(
    runExperimentScheduleV1(manifests, {
      ...options,
      concurrency: MAX_EXPERIMENT_SCHEDULE_CONCURRENCY_V1 + 1,
    }),
    /must not exceed 4/,
  );
  await assert.rejects(
    runExperimentScheduleV1(manifests, { ...options, concurrency: 0 }),
    /positive integer/,
  );
});

test('runSchedule rejects empty, mixed-plan, and tampered batches', async () => {
  const { options } = harness(alwaysCommitted);
  await assert.rejects(runExperimentScheduleV1([], options), /at least one cell/);

  const left = compiledManifests([1]);
  const mixed = compileExperimentPlanV1(publishedPlanFixture([1, 2]), {
    configDirectory: CONFIG_DIRECTORY,
  });
  await assert.rejects(
    runExperimentScheduleV1([...left, ...mixed], options),
    /mixes cells|duplicate cells/,
  );

  const [manifest] = compiledManifests([1]);
  const tampered: ExperimentCellManifestV1 = {
    ...manifest,
    command: experimentCellCommandV1('multi', manifest.configPath, 'other-run-id'),
  };
  await assert.rejects(
    runExperimentScheduleV1([tampered], options),
    /does not match its manifest identity/,
  );
});

test('runSchedule never exceeds the concurrency bound and starts cells in order', async () => {
  const manifests = compiledManifests([1, 2, 3, 4, 5]);
  const pendingExits: Array<() => void> = [];
  const startedRunIds: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { options } = harness(alwaysCommitted, 'provably_not_started', {
    exec: (_command, manifest) => {
      startedRunIds.push(manifest.runId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise(resolve => {
        pendingExits.push(() => {
          inFlight -= 1;
          resolve(COMMITTED_EXIT);
        });
      });
    },
  });

  let settled = false;
  const done = runExperimentScheduleV1(manifests, { ...options, concurrency: 2 }).then(
    ledger => {
      settled = true;
      return ledger;
    },
  );
  while (!settled) {
    await new Promise(resolve => setImmediate(resolve));
    pendingExits.shift()?.();
  }
  const ledger = await done;

  assert.equal(maxInFlight, 2);
  assert.deepEqual(startedRunIds, manifests.map(manifest => manifest.runId));
  assert.equal(ledger.cells.length, manifests.length);
  assert.ok(ledger.cells.every(cell => cell.finalState === 'committed'));
});

test('runSchedule emits a typed per-cell transition ledger with injected clock times', async () => {
  const manifests = compiledManifests([1]);
  const { options, clock } = harness(alwaysCommitted);
  const ledger = await runExperimentScheduleV1(manifests, options);

  assert.equal(ledger.planDigest, manifests[0].planDigest);
  assert.equal(ledger.experimentId, 'exp-sched');
  assert.equal(ledger.concurrency, 2);
  assert.ok(ledger.startedAtMs < ledger.finishedAtMs);

  const [cell] = ledger.cells;
  assert.equal(cell.finalState, 'committed');
  assert.equal(cell.attempts, 1);
  assert.equal(cell.failureCause, undefined);
  assert.deepEqual(
    cell.transitions.map(transition => [transition.state, transition.attempt]),
    [['planned', 0], ['starting', 1], ['running', 1], ['committed', 1]],
  );
  const stamps = cell.transitions.map(transition => transition.atMs);
  assert.deepEqual([...stamps].sort((a, b) => a - b), stamps);
  assert.equal(clock.sleeps.length, 0);
  assert.equal(cell.transitions.at(-1)?.exitCode, 0);
});

test('runSchedule relaunches an infrastructure failure with bounded backoff and the same run id', async () => {
  const manifests = compiledManifests([1]);
  const h = harness(
    () => ({ kind: 'infrastructure_failed', beforeDurableCommit: true, detail: 'http 429' }),
    'provably_not_started',
  );
  const ledger = await runExperimentScheduleV1(manifests, {
    ...h.options,
    maxRelaunches: 3,
    backoff: { initialDelayMs: 100, multiplier: 10, maxDelayMs: 500 },
  });

  assert.equal(h.execCommands.length, 4);
  assert.ok(h.execCommands.every(command => command === manifests[0].command));
  assert.deepEqual(h.execRunIds, Array(4).fill(manifests[0].runId));
  assert.deepEqual(h.probeCalls, Array(3).fill(manifests[0].runId));
  assert.deepEqual(h.clock.sleeps, [100, 500, 500]);

  const [cell] = ledger.cells;
  assert.equal(cell.finalState, 'failed');
  assert.equal(cell.failureCause, 'infrastructure_failed');
  assert.equal(cell.attempts, 4);
  const failedTransition = cell.transitions.at(-1);
  assert.equal(failedTransition?.state, 'failed');
  assert.equal(failedTransition?.cause, 'infrastructure_failed');
  assert.equal(failedTransition?.detail, 'http 429');
});

test('runSchedule commits after a successful relaunch without changing identity', async () => {
  const manifests = compiledManifests([1]);
  const before = JSON.parse(JSON.stringify(manifests[0])) as unknown;
  const h = harness((_manifest, attempt) =>
    attempt === 1
      ? { kind: 'infrastructure_failed', beforeDurableCommit: true }
      : { kind: 'committed' },
  );
  const ledger = await runExperimentScheduleV1(manifests, h.options);

  assert.equal(h.execCommands.length, 2);
  assert.equal(h.execCommands[0], h.execCommands[1]);
  assert.deepEqual(h.execRunIds, [manifests[0].runId, manifests[0].runId]);
  assert.equal(ledger.cells[0].finalState, 'committed');
  assert.equal(ledger.cells[0].attempts, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(manifests[0])), before);
  assert.throws(() => {
    (manifests[0] as { runId: string }).runId = 'mutated';
  }, TypeError);
});

test('runSchedule never relaunches a model_behavior_terminal cell', async () => {
  const manifests = compiledManifests([1]);
  const h = harness(() => ({
    kind: 'model_behavior_terminal',
    detail: 'file_memory_format_invalid exhausted',
  }));
  const ledger = await runExperimentScheduleV1(manifests, {
    ...h.options,
    maxRelaunches: 8,
  });

  assert.equal(h.execCommands.length, 1);
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.clock.sleeps.length, 0);
  const [cell] = ledger.cells;
  assert.equal(cell.finalState, 'failed');
  assert.equal(cell.failureCause, 'model_behavior_terminal');
  assert.equal(cell.attempts, 1);
});

test('runSchedule never auto-retries an indeterminate external operation', async () => {
  const manifests = compiledManifests([1]);
  const h = harness(() => ({ kind: 'indeterminate_external_operation' }));
  const ledger = await runExperimentScheduleV1(manifests, {
    ...h.options,
    maxRelaunches: 8,
  });

  assert.equal(h.execCommands.length, 1);
  assert.equal(h.probeCalls.length, 0);
  const [cell] = ledger.cells;
  assert.equal(cell.finalState, 'indeterminate');
  assert.equal(cell.failureCause, 'indeterminate_external_operation');
  assert.equal(cell.transitions.at(-1)?.state, 'indeterminate');
});

test('runSchedule refuses to relaunch unless the run is provably not started', async () => {
  const manifests = compiledManifests([1]);
  const h = harness(
    () => ({ kind: 'infrastructure_failed', beforeDurableCommit: true }),
    'possibly_started',
  );
  const ledger = await runExperimentScheduleV1(manifests, {
    ...h.options,
    maxRelaunches: 8,
  });

  assert.equal(h.execCommands.length, 1);
  assert.equal(h.probeCalls.length, 1);
  assert.equal(h.clock.sleeps.length, 0);
  assert.equal(ledger.cells[0].finalState, 'failed');
  assert.equal(ledger.cells[0].failureCause, 'infrastructure_failed');
});

test('runSchedule refuses to relaunch after a durable commit or broken seams', async () => {
  const afterCommit = harness(() => ({
    kind: 'infrastructure_failed',
    beforeDurableCommit: false,
  }));
  const committedLedger = await runExperimentScheduleV1(compiledManifests([1]), {
    ...afterCommit.options,
    maxRelaunches: 8,
  });
  assert.equal(afterCommit.execCommands.length, 1);
  assert.equal(afterCommit.probeCalls.length, 0);
  assert.equal(committedLedger.cells[0].failureCause, 'infrastructure_failed');

  const throwing = harness(alwaysCommitted, 'provably_not_started', {
    exec: async () => {
      throw new Error('spawn failed');
    },
  });
  const thrownLedger = await runExperimentScheduleV1(compiledManifests([1]), {
    ...throwing.options,
    maxRelaunches: 8,
  });
  assert.equal(throwing.probeCalls.length, 0);
  const [cell] = thrownLedger.cells;
  assert.equal(cell.finalState, 'failed');
  assert.equal(cell.failureCause, 'infrastructure_failed');
  assert.match(cell.transitions.at(-1)?.detail ?? '', /scheduler seam failed/);
});

test('runSchedule fails closed when the status probe itself throws', async () => {
  const manifests = compiledManifests([1]);
  const h = harness(() => ({ kind: 'infrastructure_failed', beforeDurableCommit: true }));
  const ledger = await runExperimentScheduleV1(manifests, {
    ...h.options,
    maxRelaunches: 8,
    probeRunStart: () => {
      throw new Error('ledger unreadable');
    },
  });
  assert.equal(h.execCommands.length, 1);
  assert.equal(ledger.cells[0].finalState, 'failed');
});

test('runSchedule validates relaunch and backoff bounds', async () => {
  const manifests = compiledManifests([1]);
  const { options } = harness(alwaysCommitted);
  await assert.rejects(
    runExperimentScheduleV1(manifests, { ...options, maxRelaunches: 9 }),
    /must not exceed 8/,
  );
  await assert.rejects(
    runExperimentScheduleV1(manifests, {
      ...options,
      backoff: { initialDelayMs: 0, multiplier: 2, maxDelayMs: 1_000 },
    }),
    /initial delay/,
  );
  await assert.rejects(
    runExperimentScheduleV1(manifests, {
      ...options,
      backoff: { initialDelayMs: 100, multiplier: 2, maxDelayMs: 600_000 },
    }),
    /max delay/,
  );
  assert.equal(experimentBackoffDelayMsV1(DEFAULT_EXPERIMENT_SCHEDULE_BACKOFF_V1, 1), 1_000);
  assert.equal(experimentBackoffDelayMsV1(DEFAULT_EXPERIMENT_SCHEDULE_BACKOFF_V1, 6), 30_000);
});
