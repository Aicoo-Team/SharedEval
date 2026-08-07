import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWithConcurrencyV1 } from '../../src/runner/v1/backends/concurrency.js';

test('bounded map stops scheduling and drains in-flight work after a failure', async () => {
  const failure = new Error('worker failed');
  const started: number[] = [];
  let releaseSibling = (): void => {};
  const siblingGate = new Promise<void>(resolve => {
    releaseSibling = resolve;
  });

  const running = mapWithConcurrencyV1([0, 1, 2, 3], 2, async item => {
    started.push(item);
    if (item === 0) throw failure;
    if (item === 1) await siblingGate;
    return item;
  });
  let settled = false;
  void running.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(started, [0, 1]);
    assert.equal(settled, false, 'must drain the already-running sibling before rejecting');
  } finally {
    releaseSibling();
  }

  await assert.rejects(running, error => error === failure);
  assert.deepEqual(started, [0, 1], 'must not schedule items after the first failure');
});
