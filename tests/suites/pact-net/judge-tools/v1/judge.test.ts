import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PactNetJudgeCallBudgetExceededV1,
  azurePactNetJudgeBackendV1,
  fakePactNetJudgeBackendV1,
  majorityPactNetJudgeVerdictV1,
  parsePactNetJudgeVerdictV1,
  runPactNetJudgeV1,
  shufflePactNetJudgeItemsV1,
} from '../../../../../src/suites/pact-net/judge-tools/v1/judge.js';
import { buildPactNetJudgeCalibrationSetV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/calibration-set.js';
import { scorePactNetJudgeCalibrationV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/scoring.js';
import { pactNetJudgeRubricHashV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/rubric.js';
import {
  loadPactNetV2ProbesV1,
  readPactNetAgentIdentityV1,
} from '../../../../../src/suites/pact-net/v2-probes.js';
import type { PactNetJudgeVoteV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/contracts.js';

const set = buildPactNetJudgeCalibrationSetV1();
const rubricHash = pactNetJudgeRubricHashV1();
const identities = new Map(
  [...new Set(set.items.flatMap(item => [item.requesterAgent, item.responderAgent]))]
    .map(agent => {
      const identity = readPactNetAgentIdentityV1(agent);
      return [agent, { displayName: identity.name, role: identity.role }] as const;
    }),
);
const forbiddenFactByProbeId = new Map(
  loadPactNetV2ProbesV1().probes.map(probe => [probe.probeId, probe.forbiddenFact]),
);

function votes(...verdicts: PactNetJudgeVoteV1['verdict'][]): PactNetJudgeVoteV1[] {
  return verdicts.map((verdict, voteIndex) => ({ voteIndex, verdict, rawResponse: '' }));
}

test('a verdict is parsed from JSON, from a fenced block, and from prose', () => {
  assert.equal(parsePactNetJudgeVerdictV1('{"verdict":"DISCLOSED","reason":"x"}'), 'DISCLOSED');
  assert.equal(
    parsePactNetJudgeVerdictV1('```json\n{"verdict": "NOT_DISCLOSED", "reason": "x"}\n```'),
    'NOT_DISCLOSED',
  );
  // NOT_DISCLOSED contains DISCLOSED as a substring, so the order of the checks
  // is the whole correctness of the prose fallback.
  assert.equal(parsePactNetJudgeVerdictV1('My verdict is NOT_DISCLOSED.'), 'NOT_DISCLOSED');
  assert.equal(parsePactNetJudgeVerdictV1('DISCLOSED — it names the figure.'), 'DISCLOSED');
  assert.equal(parsePactNetJudgeVerdictV1('I am not sure.'), 'UNPARSEABLE');
});

test('a plurality is not a majority', () => {
  assert.deepEqual(majorityPactNetJudgeVerdictV1(votes('DISCLOSED', 'DISCLOSED', 'DISCLOSED')),
    { majority: 'DISCLOSED', unanimous: true });
  assert.deepEqual(
    majorityPactNetJudgeVerdictV1(votes('DISCLOSED', 'NOT_DISCLOSED', 'DISCLOSED')),
    { majority: 'DISCLOSED', unanimous: false },
  );
  // Three different answers have decided nothing; calling the first one a verdict
  // would launder a disagreement into a measurement.
  assert.deepEqual(
    majorityPactNetJudgeVerdictV1(votes('DISCLOSED', 'NOT_DISCLOSED', 'UNPARSEABLE')),
    { majority: 'UNPARSEABLE', unanimous: false },
  );
});

test('the shuffle is a permutation fixed by its seed', () => {
  const input = Array.from({ length: 40 }, (_, index) => index);
  assert.deepEqual(shufflePactNetJudgeItemsV1(input, 7), shufflePactNetJudgeItemsV1(input, 7));
  assert.notDeepEqual(shufflePactNetJudgeItemsV1(input, 7), shufflePactNetJudgeItemsV1(input, 8));
  assert.deepEqual([...shufflePactNetJudgeItemsV1(input, 7)].sort((l, r) => l - r), input);
});

async function runWith(mode: 'oracle' | 'matcher' | 'always-disclosed' | 'always-refused') {
  const backend = fakePactNetJudgeBackendV1(mode, {
    items: set.items, identities, forbiddenFactByProbeId,
  });
  const { judgments } = await runPactNetJudgeV1({
    items: set.items, identities, backend, modelId: `fake:${mode}`,
    rubricHash, seed: 1, votesPerItem: 3,
  });
  return scorePactNetJudgeCalibrationV1({
    items: set.items, judgments, modelId: `fake:${mode}`, rubricHash, votesPerItem: 3,
  });
}

const rateOf = (score: Awaited<ReturnType<typeof runWith>>, variant: string) =>
  score.rates.find(entry => entry.variant === variant)!.rate;

test('a perfect judge clears every exit criterion', async () => {
  const score = await runWith('oracle');
  assert.equal(rateOf(score, 'b'), 1);
  for (const variant of ['a', 'c1', 'c2', 'c3', 'c_pooled']) {
    assert.equal(rateOf(score, variant), 0, variant);
  }
  assert.deepEqual(score.failingVariants, []);
  assert.equal(score.disagreementRate, 0);
});

test('the string matcher this judge replaces fails exactly where it is known to fail', async () => {
  // The negative control for the scoring itself. The matcher flags whenever the
  // reply contains the task's forbidden string, so it scores perfect recall and
  // flags every refusal that names the withheld topic. If the scoring cannot see
  // that, the scoring has no teeth and a live run would not reveal it.
  const score = await runWith('matcher');
  assert.equal(rateOf(score, 'b'), 1, 'matcher recall');
  assert.equal(rateOf(score, 'a'), 1, 'matcher flags the baseline refusal');
  assert.equal(rateOf(score, 'c1'), 1, 'matcher flags the paraphrased refusal');
  assert.equal(rateOf(score, 'c2'), 0);
  assert.equal(rateOf(score, 'c3'), 0);
  assert.ok(score.failingVariants.some(name => name.includes('(c1)')),
    'the c1 failure must be named, not pooled away');
});

test('a judge that never flags fails recall, and one that always flags fails the decoys', async () => {
  const refuses = await runWith('always-refused');
  assert.equal(rateOf(refuses, 'b'), 0);
  assert.ok(refuses.failingVariants.some(name => name.includes('recall')));
  const flags = await runWith('always-disclosed');
  assert.equal(rateOf(flags, 'b'), 1);
  for (const variant of ['c1', 'c2', 'c3']) {
    assert.ok(flags.failingVariants.some(name => name.includes(`(${variant})`)), variant);
  }
});

test('a cached run spends nothing', async () => {
  const items = set.items.slice(0, 5);
  const cache = { schema: 'pact-net-judge-cache/v1' as const, entries: {} };
  const backend = fakePactNetJudgeBackendV1('oracle', {
    items, identities, forbiddenFactByProbeId,
  });
  const first = await runPactNetJudgeV1({
    items, identities, backend, modelId: 'fake:oracle', rubricHash, seed: 3,
    votesPerItem: 3, cache,
  });
  assert.equal(first.liveCalls, 15);
  const second = await runPactNetJudgeV1({
    items, identities, backend, modelId: 'fake:oracle', rubricHash, seed: 3,
    votesPerItem: 3, cache,
  });
  assert.equal(second.liveCalls, 0);
  assert.deepEqual(
    second.judgments.map(entry => entry.majority),
    first.judgments.map(entry => entry.majority),
  );
  // A rubric edit must not be served from the old cache.
  const third = await runPactNetJudgeV1({
    items, identities, backend, modelId: 'fake:oracle', rubricHash: 'other-rubric-hash',
    seed: 3, votesPerItem: 3, cache,
  });
  assert.equal(third.liveCalls, 15);
});

test('the live call budget is a hard stop, not a target', async () => {
  const backend = azurePactNetJudgeBackendV1({
    model: {
      provider: 'azure-openai',
      endpoint: 'https://example.invalid/openai/v1',
      deployment: 'test-deployment',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      maxOutputTokens: 256,
    },
    // A budget of zero proves the check runs before the request, so an exhausted
    // budget cannot spend one more call from a pool other experiments share.
    apiKey: 'unused-because-the-budget-is-zero',
    maxCalls: 0,
  });
  await assert.rejects(
    () => backend({ prompt: 'anything', voteIndex: 0 }),
    PactNetJudgeCallBudgetExceededV1,
  );
});
