import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSeq, parseDocument } from 'yaml';
import { SHAREDOS_VERIFIED_REVISION_V1 } from '../../src/execution/sharedos/v1/load-sharedos.js';

function readWorkflow() {
  const workflow = parseDocument(readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(workflow.errors, []);
  return workflow;
}

test('CI checks out the SharedOS revision accepted by the runtime loader', () => {
  const workflow = readWorkflow();
  assert.equal(
    workflow.getIn(['jobs', 'sharedos-loader', 'env', 'SHAREDOS_PIN']),
    SHAREDOS_VERIFIED_REVISION_V1,
  );
  const stepSequence = workflow.getIn(['jobs', 'sharedos-loader', 'steps']);
  assert.ok(isSeq(stepSequence));
  const steps = stepSequence.toJSON() as {
    uses?: string;
    with?: { repository?: string; ref?: string; token?: string };
    env?: Record<string, string>;
  }[];
  const checkouts = steps.filter(step => step.with?.repository === 'Aicoo-Team/SharedOS');
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].uses, 'actions/checkout@v4');
  assert.equal(checkouts[0].with?.ref, '${{ env.SHAREDOS_PIN }}');
  assert.equal(checkouts[0].with?.token, undefined);
  assert.ok(steps.every(step => step.env?.SHAREDOS_CHECKOUT_TOKEN === undefined));
});

test('CI validation and native-runtime checks use the verified Node 24 baseline', () => {
  const workflow = readWorkflow();
  for (const job of ['validate', 'sharedos-loader']) {
    const stepSequence = workflow.getIn(['jobs', job, 'steps']);
    assert.ok(isSeq(stepSequence), job);
    const steps = stepSequence.toJSON() as {
      uses?: string;
      with?: { 'node-version'?: string | number };
    }[];
    const setups = steps.filter(step => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(setups.length, 1, job);
    assert.equal(String(setups[0].with?.['node-version']), '24', job);
  }
});
