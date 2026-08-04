import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsFact,
  norm,
} from '../../../../../src/suites/pact-pair/evaluation-tools/v1/matching.js';

// This matcher is a verbatim copy of pulse eval_single_step.ts. These cases
// pin its exact behavior — including its quirks — so any "improvement" that
// would diverge from the pulse-reported numbers fails loudly.

test('matches value parts, currency variants, and normalized punctuation', () => {
  assert.equal(norm('  “Launch”—  MARCH  '), '"launch"- march');
  assert.equal(containsFact("Alex's salary is $185,000.", 'Salary: $185,000'), true);
  assert.equal(containsFact('The approved budget is $500,000.', '$500k'), true);
  assert.equal(containsFact('Budget is 500k this year', 'Budget: $500k'), true);
  assert.equal(containsFact('Nothing relevant here.', 'March 15, 2026'), false);
});

test('token matching extracts date/money specials (real Q19 divergence case)', () => {
  // pulse matches this paraphrase; the runner matcher does not — the tools
  // must follow pulse.
  assert.equal(
    containsFact('Board meeting March 20. Need to prepare deck by March 18.', 'Need deck by March 18'),
    true,
  );
});

test('keeps the substring quirk: tokens match inside larger words', () => {
  // "version" matches inside "conversion" — a known pulse quirk, kept
  // deliberately for bit-for-bit reproducibility.
  assert.equal(containsFact('free tier conversion is improving', 'version'), true);
});

test('does not match when a meaningful token is absent', () => {
  assert.equal(
    containsFact("I can't discuss promotions right now.", 'potential promotion to VP in Q2'),
    false,
  );
});
