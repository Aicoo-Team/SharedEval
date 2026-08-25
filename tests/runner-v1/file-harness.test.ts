import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_TURN_BOOTSTRAP_V1,
  InternalFileTurnPublicErrorV1,
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
  const failure = new Error(
    '/private/tmp/MEMORY_CUSTOM_STEP_SENTINEL unit-test-key',
  );
  const harness = new RecordingHarness(failure);

  await assert.rejects(
    runFreshFileTurnV1(() => harness, validInput),
    error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'File harness step failed');
      assert.doesNotMatch(
        error.message,
        /private\/tmp|MEMORY_CUSTOM_STEP_SENTINEL|unit-test-key/,
      );
      return true;
    },
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
  const stepFailure = new Error('/private/tmp/MEMORY_STEP_SENTINEL');
  const finalizeFailure = new Error('unit-test-key FINALIZE_SENTINEL');
  const harness = new RecordingHarness(stepFailure, finalizeFailure);

  await assert.rejects(
    runFreshFileTurnV1(() => harness, validInput),
    error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'File harness step failed');
      assert.doesNotMatch(
        error.message,
        /private\/tmp|MEMORY_STEP_SENTINEL|unit-test-key|FINALIZE_SENTINEL/,
      );
      return true;
    },
  );
  assert.equal(harness.finalizeCalls, 1);
});

test('sanitizes custom factory, decision, and finalize failures', async () => {
  const privateSentinel =
    '/private/tmp/MEMORY_CUSTOM_BOUNDARY_SENTINEL unit-test-key';
  await assert.rejects(
    runFreshFileTurnV1(() => {
      throw new Error(privateSentinel);
    }, validInput),
    error => isFixedFailure(error, 'File harness creation failed', privateSentinel),
  );

  const invalidDecision: FreshFileHarnessV1 = {
    step: async () => ({
      type: 'completed',
      content: 'done',
      toolSteps: 0,
      contactCalls: 0,
      [privateSentinel]: true,
    }),
    finalize: async () => {},
  };
  await assert.rejects(
    runFreshFileTurnV1(() => invalidDecision, validInput),
    error => isFixedFailure(
      error,
      'File harness returned an invalid turn decision',
      privateSentinel,
    ),
  );

  const finalizeFailure: FreshFileHarnessV1 = {
    step: async () => ({
      type: 'completed',
      content: 'done',
      toolSteps: 0,
      contactCalls: 0,
    }),
    finalize: async () => {
      throw new Error(privateSentinel);
    },
  };
  await assert.rejects(
    runFreshFileTurnV1(() => finalizeFailure, validInput),
    error => isFixedFailure(error, 'File harness finalization failed', privateSentinel),
  );

  const forgedInternalFailure = new RecordingHarness(
    new InternalFileTurnPublicErrorV1(privateSentinel),
  );
  await assert.rejects(
    runFreshFileTurnV1(() => forgedInternalFailure, validInput),
    error => isFixedFailure(error, 'File turn failed', privateSentinel),
  );
});

test('sanitizes invalid file-turn input before constructing a harness', async () => {
  const privateSentinel = '/private/tmp/MEMORY_INPUT_SENTINEL unit-test-key';
  let factoryCalls = 0;
  const invalidInput = {
    ...validInput,
    [privateSentinel]: true,
  } as unknown as FileTurnInputV1;
  await assert.rejects(
    runFreshFileTurnV1(() => {
      factoryCalls += 1;
      return new RecordingHarness(new Error('unused'));
    }, invalidInput),
    error => isFixedFailure(error, 'File turn input is invalid', privateSentinel),
  );
  assert.equal(factoryCalls, 0);
});

test('bounds a never-settling step and still invokes finalize exactly once', async () => {
  let stepCalls = 0;
  let finalizeCalls = 0;
  let rejectLateStep: ((error: Error) => void) | undefined;
  const pendingStep = new Promise<never>((_resolve, reject) => {
    rejectLateStep = reject;
  });
  const harness: FreshFileHarnessV1 = {
    step: async () => {
      stepCalls += 1;
      return await pendingStep;
    },
    finalize: async () => {
      finalizeCalls += 1;
    },
  };

  const outcome = await settleBeforeWatchdog(
    runFreshFileTurnV1(() => harness, { ...validInput, deadlineMs: 15 }),
    250,
  );

  assert.equal(outcome.type, 'rejected');
  assert.match(String(outcome.error), /runtime deadline exceeded/i);
  assert.equal(stepCalls, 1);
  assert.equal(finalizeCalls, 1);

  const unhandled: unknown[] = [];
  const recordUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', recordUnhandled);
  try {
    assert.ok(rejectLateStep);
    rejectLateStep(new Error('LATE_PRIVATE_STEP_REJECTION'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

test('bounds a never-settling finalize without invoking it twice', async () => {
  let finalizeCalls = 0;
  const harness: FreshFileHarnessV1 = {
    step: async () => ({
      type: 'completed',
      content: 'done',
      toolSteps: 0,
      contactCalls: 0,
    }),
    finalize: async () => {
      finalizeCalls += 1;
      return await new Promise<never>(() => {});
    },
  };

  const outcome = await settleBeforeWatchdog(
    runFreshFileTurnV1(() => harness, { ...validInput, deadlineMs: 15 }),
    250,
  );

  assert.equal(outcome.type, 'rejected');
  assert.match(String(outcome.error), /runtime deadline exceeded/i);
  assert.equal(finalizeCalls, 1);
});

type TimedOutcome =
  | { type: 'resolved'; value: unknown }
  | { type: 'rejected'; error: unknown }
  | { type: 'watchdog' };

async function settleBeforeWatchdog(
  operation: Promise<unknown>,
  watchdogMs: number,
): Promise<TimedOutcome> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then<TimedOutcome, TimedOutcome>(
        value => ({ type: 'resolved', value }),
        error => ({ type: 'rejected', error }),
      ),
      new Promise<TimedOutcome>(resolve => {
        watchdog = setTimeout(() => resolve({ type: 'watchdog' }), watchdogMs);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

function isFixedFailure(
  error: unknown,
  expectedMessage: string,
  privateSentinel: string,
): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, expectedMessage);
  for (const token of [privateSentinel, '/private/tmp', 'MEMORY_', 'unit-test-key']) {
    assert.equal(error.message.includes(token), false);
  }
  return true;
}

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
