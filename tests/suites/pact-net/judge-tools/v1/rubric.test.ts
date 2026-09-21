import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PACT_NET_JUDGE_RUBRIC_V1,
  pactNetJudgeCacheKeyV1,
  pactNetJudgeRubricHashV1,
  pactNetJudgePromptScaffoldV1,
  renderPactNetJudgePromptV1,
} from '../../../../../src/suites/pact-net/judge-tools/v1/rubric.js';
import { buildPactNetJudgeCalibrationSetV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/calibration-set.js';
import {
  loadPactNetV2ProbesV1,
  readPactNetAgentIdentityV1,
} from '../../../../../src/suites/pact-net/v2-probes.js';

const promptInput = {
  ask: 'What is blocking the order?',
  requesterDisplayName: 'Ada Asker',
  requesterRole: 'Buyer at Northwind',
  responderDisplayName: 'Hal Holder',
  responderRole: 'Sourcing lead at Kestrel',
  replyText: 'I cannot share the competitor bid.',
};

test('the rubric never quotes a protected string from the world it judges', () => {
  // An illustration lifted from a real task would prime the judge on that task.
  const { probes } = loadPactNetV2ProbesV1();
  const rubric = PACT_NET_JUDGE_RUBRIC_V1.toLowerCase();
  for (const probe of probes) {
    assert.ok(!rubric.includes(probe.forbiddenFact.toLowerCase()),
      `rubric quotes ${probe.probeId}'s forbidden fact`);
  }
});

test('the prompt scaffold holds neither the probe id, the forbidden fact, nor the variant', () => {
  const set = buildPactNetJudgeCalibrationSetV1();
  const { probes } = loadPactNetV2ProbesV1();
  const factByProbe = new Map(probes.map(probe => [probe.probeId, probe.forbiddenFact]));
  const identity = (agent: string) => readPactNetAgentIdentityV1(agent);

  for (const item of set.items) {
    const scaffold = pactNetJudgePromptScaffoldV1({
      ask: item.ask,
      requesterDisplayName: identity(item.requesterAgent).name,
      requesterRole: identity(item.requesterAgent).role,
      responderDisplayName: identity(item.responderAgent).name,
      responderRole: identity(item.responderAgent).role,
      replyText: item.replyText,
    });
    const fact = factByProbe.get(item.probeId)!;
    // The scaffold is the whole prompt minus the reply. The reply itself must be
    // allowed to contain the fact -- variant (a) is a refusal that names the
    // withheld topic in the task's own words, which is the entire point of it --
    // so the property that can hold, and the one that stops the judge
    // degenerating into topic-word matching, is that the fact never appears in
    // what the judge is *told*.
    assert.ok(!scaffold.toLowerCase().includes(fact.toLowerCase()),
      `${item.itemId}: the prompt tells the judge the forbidden string`);
    assert.ok(!scaffold.includes(item.probeId), `${item.itemId}: prompt leaks the probe id`);
    assert.ok(!scaffold.includes(item.itemId), `${item.itemId}: prompt leaks the item id`);
    assert.ok(!scaffold.includes(item.constructionRuleId),
      `${item.itemId}: prompt leaks the construction rule`);
    assert.ok(!scaffold.includes(item.label), `${item.itemId}: prompt leaks the label`);
    assert.ok(!/\bvariant\b/i.test(scaffold), `${item.itemId}: prompt names a variant`);
  }
});

test('the rendered prompt carries the reply and the question, and nothing else new', () => {
  const rendered = renderPactNetJudgePromptV1(promptInput);
  assert.ok(rendered.includes(promptInput.replyText));
  assert.ok(rendered.includes(promptInput.ask));
  assert.ok(rendered.includes(PACT_NET_JUDGE_RUBRIC_V1));
  // The scaffold is the rendered prompt with the reply removed, so the two
  // differ by exactly the reply.
  assert.equal(
    rendered.replace(`\n${promptInput.replyText}`, ''),
    pactNetJudgePromptScaffoldV1(promptInput),
  );
});

test('the cache key moves when the rubric moves, and when the model moves', () => {
  const rubricHash = pactNetJudgeRubricHashV1();
  const changed = pactNetJudgeRubricHashV1(`${PACT_NET_JUDGE_RUBRIC_V1}\nAlso: be strict.`);
  assert.notEqual(rubricHash, changed);
  const base = pactNetJudgeCacheKeyV1('a reply', rubricHash, 'model-x');
  assert.equal(base, pactNetJudgeCacheKeyV1('a reply', rubricHash, 'model-x'));
  // A rubric edit invalidates every cached judgment, which is the point: a
  // verdict under the old rubric is not evidence about the new one.
  assert.notEqual(base, pactNetJudgeCacheKeyV1('a reply', changed, 'model-x'));
  assert.notEqual(base, pactNetJudgeCacheKeyV1('a reply', rubricHash, 'model-y'));
  assert.notEqual(base, pactNetJudgeCacheKeyV1('another reply', rubricHash, 'model-x'));
});
