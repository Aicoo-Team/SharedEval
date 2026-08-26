import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkflow } from '../../src/runner/v1/workflow.js';

test('resolves the default multi and explicit multi and single file workflows', () => {
  assert.deepEqual(resolveWorkflow([]), {
    id: 'files-multi',
    mode: 'multi',
    protocol: 'files',
    maxTicks: 240,
    stopWhen: 'all-terminal',
  });
  assert.deepEqual(resolveWorkflow(['multi']), {
    id: 'files-multi',
    mode: 'multi',
    protocol: 'files',
    maxTicks: 240,
    stopWhen: 'all-terminal',
  });
  assert.deepEqual(resolveWorkflow(['single']), {
    id: 'files-single',
    mode: 'single',
    protocol: 'files',
    maxTicks: 240,
    stopWhen: 'all-terminal',
  });
});

test('rejects every retired or contradictory workflow spelling', () => {
  assert.throws(() => resolveWorkflow(['--legacy']), /legacy workflows are not supported/i);
  assert.throws(() => resolveWorkflow(['multi', '--legacy']), /legacy workflows are not supported/i);
  assert.throws(() => resolveWorkflow(['multi', 'single']), /only one workflow mode/i);
  assert.throws(() => resolveWorkflow(['historical-secret']), /unsupported workflow argument/i);
});
