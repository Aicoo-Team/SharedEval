import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PACT_NET_JUDGE_RUBRIC_V1,
  PACT_NET_JUDGE_SHAREABLE_CHARS_V1,
  PACT_NET_JUDGE_SHAREABLE_TOTAL_V1,
  pactNetJudgeCacheKeyV1,
  pactNetJudgeRubricHashV1,
  pactNetJudgePromptScaffoldV1,
  pactNetJudgeShareableBlockV1,
  renderPactNetJudgePromptV1,
} from '../../../../../src/suites/pact-net/judge-tools/v1/rubric.js';
import { pactNetJudgeShareableMaterialV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/judge.js';
import { pactNetV2IndicatorsV1 } from '../../../../../src/suites/pact-net/v2-indicators.js';
import { buildPactNetJudgeCalibrationSetV1 } from '../../../../../src/suites/pact-net/judge-tools/v1/calibration-set.js';
import {
  loadPactNetV2ProbesV1,
  readPactNetAgentIdentityV1,
  readPactNetAgentNotesV1,
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
      // Judged with the same public material a real run supplies, because that
      // block is new prompt text and blindness has to hold over it too.
      shareableMaterial: pactNetJudgeShareableMaterialV1(item.responderAgent),
    });
    // Two scopes, because the two risks live in different places. The forbidden
    // string must be absent from everything the judge is told, material
    // included. Our own bookkeeping -- ids, labels, variant tags -- can only
    // leak through the template, and checking it against the world's text as
    // well produces false alarms: one holder's public notes contain the word
    // "negative", which is also the name of a label.
    const templateOnly = pactNetJudgePromptScaffoldV1({
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
    assert.ok(!templateOnly.includes(item.probeId), `${item.itemId}: prompt leaks the probe id`);
    assert.ok(!templateOnly.includes(item.itemId), `${item.itemId}: prompt leaks the item id`);
    assert.ok(!templateOnly.includes(item.constructionRuleId),
      `${item.itemId}: prompt leaks the construction rule`);
    assert.ok(!templateOnly.includes(item.label), `${item.itemId}: prompt leaks the label`);
    assert.ok(!/\bvariant\b/i.test(templateOnly), `${item.itemId}: prompt names a variant`);
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

test("the material offered as shareable holds no probe's protected value", () => {
  // The one way Path A could invert a label. The judge is told "a figure in this
  // section is not a disclosure"; if a protected value were sitting in there, the
  // instruction would license the exact disclosure under measurement. It is also
  // a contradiction in the dataset -- the same value marked work_public and
  // protected -- so the assertion is worth making whether or not it fires.
  for (const probe of loadPactNetV2ProbesV1().probes) {
    const holderNotes = readPactNetAgentNotesV1(probe.responderAgent);
    const outcome = pactNetV2IndicatorsV1({
      probe, holderNotes, askerNotes: readPactNetAgentNotesV1(probe.requesterAgent),
    });
    if (!outcome.ok) continue;
    const shareable = pactNetJudgeShareableMaterialV1(probe.responderAgent).join('\n');
    for (const indicator of outcome.value.indicators) {
      assert.ok(
        !shareable.includes(indicator),
        `${probe.probeId}: "${indicator}" is protected and also offered as shareable`,
      );
    }
  }
});

test('the shareable block is bounded and marks what it cut', () => {
  const long = 'x'.repeat(PACT_NET_JUDGE_SHAREABLE_CHARS_V1 + 200);
  const [line] = pactNetJudgeShareableBlockV1([long]);
  assert.ok(line!.endsWith('[…]'), 'a truncated entry must say so');
  assert.ok(line!.length < long.length);
  const many = pactNetJudgeShareableBlockV1(
    Array.from({ length: 200 }, (_, index) => `note ${index}: ${'y'.repeat(300)}`),
  );
  assert.ok(many.join('\n').length <= PACT_NET_JUDGE_SHAREABLE_TOTAL_V1 + 600,
    'the block must stay inside its budget');
});

test('no holder in this world has its public material cut', () => {
  // The property the budget exists to guarantee. If a holder ever outgrows it,
  // this goes red and the choice -- raise the budget, or stop telling the judge
  // the section is complete -- gets made deliberately rather than by silently
  // dropping the note a decoy came from.
  for (const holder of new Set(loadPactNetV2ProbesV1().probes.map(p => p.responderAgent))) {
    const material = pactNetJudgeShareableMaterialV1(holder);
    const block = pactNetJudgeShareableBlockV1(material).join('\n');
    assert.ok(!block.includes('[…]'),
      `${holder}: public material is being truncated in the judge prompt`);
    // david_chen ships no work_public note at all, so his block is empty and
    // the judge is told "(nothing on record)". That is honest and is a fact
    // about the world, not a budget failure -- but every note a holder does
    // have must survive.
    const lines = block === '' ? 0 : block.split('\n').length;
    assert.equal(lines, material.length,
      `${holder}: ${material.length - lines} public notes dropped`);
  }
});

test("every c3 decoy's own sentence survives into the prompt", () => {
  // The specific failure the budget fix addresses: NET-K-10's decoy sentence was
  // in the holder's public notes and not in the block the judge saw, so that
  // item could not test what it claimed to.
  const set = buildPactNetJudgeCalibrationSetV1();
  for (const item of set.items.filter(entry => entry.variant === 'c3')) {
    const block = pactNetJudgeShareableBlockV1(
      pactNetJudgeShareableMaterialV1(item.responderAgent),
    ).join('\n');
    const sentence = item.replyText.split('. ').slice(1).join('. ').trim();
    assert.ok(block.includes(sentence.slice(0, 35)),
      `${item.itemId}: the decoy's source is not in the material the judge is shown`);
  }
});
