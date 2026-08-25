import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_TURN_BOOTSTRAP_V1,
  runFreshFileTurnV1,
  type FileTurnInputV1,
  type FreshFileHarnessV1,
} from '../../src/runner/v1/file-harness.js';

const validInput: FileTurnInputV1 = {
  actorId: 'requester-1',
  traceId: 'trace-1',
  deadlineMs: 1_000,
  maxToolSteps: 4,
  maxContactCalls: 1,
};

test('uses the exact file-turn bootstrap contract', () => {
  assert.equal(
    FILE_TURN_BOOTSTRAP_V1,
    'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.',
  );
});

test('creates a new harness and finalizes it exactly once for every turn', async () => {
  const created: RecordingHarness[] = [];
  const factory = () => {
    const harness = new RecordingHarness({
      type: 'completed',
      content: 'done',
      toolSteps: 0,
      contactCalls: 0,
    });
    created.push(harness);
    return harness;
  };

  assert.deepEqual(await runFreshFileTurnV1(factory, validInput), {
    type: 'completed',
    content: 'done',
    toolSteps: 0,
    contactCalls: 0,
  });
  assert.deepEqual(await runFreshFileTurnV1(factory, {
    ...validInput,
    traceId: 'trace-2',
  }), {
    type: 'completed',
    content: 'done',
    toolSteps: 0,
    contactCalls: 0,
  });

  assert.equal(created.length, 2);
  assert.notEqual(created[0], created[1]);
  assert.deepEqual(created.map(harness => harness.finalizeCalls), [1, 1]);
  assert.deepEqual(created.map(harness => harness.stepCalls), [1, 1]);
});

test('finalizes exactly once when a turn fails', async () => {
  const failure = new Error('provider failed');
  const harness = new RecordingHarness(failure);

  await assert.rejects(
    runFreshFileTurnV1(() => harness, validInput),
    failure,
  );
  assert.equal(harness.stepCalls, 1);
  assert.equal(harness.finalizeCalls, 1);
});

test('finalizes exactly once when a turn starts cancelled', async () => {
  const harness = new RecordingHarness({
    type: 'completed',
    content: 'unused',
    toolSteps: 0,
    contactCalls: 0,
  });

  assert.deepEqual(await runFreshFileTurnV1(() => harness, {
    ...validInput,
    cancelled: true,
  }), {
    type: 'cancelled',
    reason: 'The file turn was cancelled before it started.',
    toolSteps: 0,
    contactCalls: 0,
  });
  assert.equal(harness.stepCalls, 0);
  assert.equal(harness.finalizeCalls, 1);
});

test('does not hide a step failure behind a finalize failure', async () => {
  const stepFailure = new Error('host tool failed');
  const finalizeFailure = new Error('cleanup failed');
  const harness = new RecordingHarness(stepFailure, finalizeFailure);

  await assert.rejects(
    runFreshFileTurnV1(() => harness, validInput),
    stepFailure,
  );
  assert.equal(harness.finalizeCalls, 1);
});

class RecordingHarness implements FreshFileHarnessV1 {
  stepCalls = 0;
  finalizeCalls = 0;

  constructor(
    private readonly result: Awaited<ReturnType<FreshFileHarnessV1['step']>> | Error,
    private readonly finalizeFailure?: Error,
  ) {}

  async step(_input: FileTurnInputV1) {
    this.stepCalls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async finalize(): Promise<void> {
    this.finalizeCalls += 1;
    if (this.finalizeFailure) throw this.finalizeFailure;
  }
}
