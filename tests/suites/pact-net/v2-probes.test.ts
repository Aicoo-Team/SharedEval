import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACT_NET_V2_TASKS_PATH_V1,
  loadPactNetV2ProbesV1,
  pactNetV2TaskFileSchema,
  pactNetAgentStoreToPairStoreV1,
  pactNetV2ProbeNumbersV1,
  parsePactNetV2ProbeIdV1,
  readPactNetAgentNotesV1,
  type PactNetV2ProbeV1,
} from '../../../src/suites/pact-net/v2-probes.js';
import { evaluatePactPairTaskV1 } from '../../../src/suites/pact-pair/evaluator.js';
import { pactPairMetricContributionsV1 } from '../../../src/suites/pact-pair/evaluation.js';
import { pactPairFullEvaluationV1Schema } from '../../../src/suites/pact-pair/public-evaluation.js';
import { pactNetV2IndicatorsV1 } from '../../../src/suites/pact-net/v2-indicators.js';

/** Indicators for a probe, or none, under the rule a run actually scores with. */
function indicatorsForV1(probe: PactNetV2ProbeV1): readonly string[] {
  const outcome = pactNetV2IndicatorsV1({
    probe,
    holderNotes: readPactNetAgentNotesV1(probe.responderAgent),
    askerNotes: readPactNetAgentNotesV1(probe.requesterAgent),
  });
  return outcome.ok ? outcome.value.indicators : [];
}
import { pactNetV2ProbesToPairTasksV1 } from '../../../src/suites/pact-net/v2-pair-tasks.js';
import { dataStoreSchema } from '../../../src/suites/pact-pair/schemas.js';
import { buildPactNetRunBindingV1 } from '../../../src/runner/v1/sharedeval-net-binding.js';

const repositoryRoot = new URL('../../../', import.meta.url).pathname;

test('every probe names two distinct actors of its own task and a note its holder owns', () => {
  const { probes, rejected } = loadPactNetV2ProbesV1();
  assert.ok(probes.length > 0);
  for (const probe of probes) {
    assert.notEqual(probe.requesterAgent, probe.responderAgent, probe.probeId);
    const store = dataStoreSchema.parse(
      pactNetAgentStoreToPairStoreV1(probe.responderAgent).store,
    );
    assert.ok(
      store.notes.some(note => note.title === probe.evidenceNoteTitle),
      `${probe.probeId}: evidence note is not in the holder's own store`,
    );
  }
  // Rejections are reported rather than dropped, and every reason is a known one.
  const reasons = new Set(rejected.map(entry => entry.reason));
  for (const reason of reasons) {
    assert.ok([
      'forbidden_to_is_everyone', 'forbidden_to_equals_holder',
      'forbidden_to_not_an_actor', 'holder_not_an_actor', 'holder_has_no_store',
      'evidence_outside_bundled_notes', 'evidence_note_absent_from_holder_store',
    ].includes(reason), reason);
  }
});

test('every responder store survives the pair store contract, with its data quality counted', () => {
  const { probes } = loadPactNetV2ProbesV1();
  for (const agent of new Set(probes.map(probe => probe.responderAgent))) {
    const { store, todoQuality } = pactNetAgentStoreToPairStoreV1(agent);
    const parsed = dataStoreSchema.parse(store);
    assert.ok(parsed.notes.length > 0, agent);
    // The shipped world writes priority both ways and leaves bodies empty; the
    // projection normalises both and says how often it had to.
    assert.ok(todoQuality.total > 0, agent);
    assert.ok(todoQuality.numericPriorities <= todoQuality.total, agent);
    assert.ok(todoQuality.emptyContents <= todoQuality.total, agent);
  }
});

test('question numbers are stable against the selection, not the subset', () => {
  const { probes } = loadPactNetV2ProbesV1();
  const all = pactNetV2ProbeNumbersV1(probes);
  const subset = pactNetV2ProbeNumbersV1(probes.slice(0, 3));
  const target = probes[probes.length - 1]!.probeId;
  assert.equal(typeof all.get(target), 'number');
  const tasks = pactNetV2ProbesToPairTasksV1(
    [probes[probes.length - 1]!], () => ['$1,000'], { allProbes: probes },
  );
  assert.equal(tasks[0]!.question.id, all.get(target));
  assert.notEqual(all.size, subset.size);
});

test('a projected probe is refuse-expected and its gold is the note\'s values', () => {
  const { probes } = loadPactNetV2ProbesV1();
  const decidable = probes.filter(probe => indicatorsForV1(probe).length > 0);
  const tasks = pactNetV2ProbesToPairTasksV1(decidable, indicatorsForV1, { allProbes: probes });
  for (const [index, task] of tasks.entries()) {
    const probe = decidable[index]!;
    assert.equal(task.expectedBehavior, 'refuse', task.taskId);
    assert.deepEqual(task.question.gold_key_facts, [...indicatorsForV1(probe)]);
    assert.equal(task.question.question, probe.ask);
    assert.equal(task.category, probe.category);
    // The MEMORY row grammar splits on spaces around an em dash, so a task id
    // may not contain whitespace.
    assert.doesNotMatch(task.taskId, /\s/);
  }
  assert.equal(new Set(tasks.map(task => task.taskId)).size, tasks.length);
});

test('a probe with no indicator is refused rather than given a synthetic gold', () => {
  const { probes } = loadPactNetV2ProbesV1();
  assert.throws(
    () => pactNetV2ProbesToPairTasksV1([probes[0]!], () => [], { allProbes: probes }),
    /no leak indicator/,
  );
});

test('a run seats one responder and refuses a selection that spans two', () => {
  const { probes } = loadPactNetV2ProbesV1();
  // Only decidable probes can be bound, so the selection is drawn from those.
  const decidable = probes.filter(probe => indicatorsForV1(probe).length > 0);
  const byResponder = new Map<string, string[]>();
  for (const probe of decidable) {
    byResponder.set(probe.responderAgent,
      [...(byResponder.get(probe.responderAgent) ?? []), probe.probeId]);
  }
  const [first, second] = [...byResponder.keys()];
  const binding = buildPactNetRunBindingV1({
    rootDir: repositoryRoot, probeIds: byResponder.get(first!)!.slice(0, 1),
  });
  assert.equal(binding.responderAgent, first);
  assert.ok(binding.responderReferences.policy.id.includes(first!));
  assert.equal(binding.tasks.length, 1);

  assert.throws(() => buildPactNetRunBindingV1({
    rootDir: repositoryRoot,
    probeIds: [byResponder.get(first!)![0]!, byResponder.get(second!)![0]!],
  }), /seats one responder/);
});

test('selecting a probe that needs a rubric fails loudly and says why', () => {
  const { probes } = loadPactNetV2ProbesV1();
  const undecidable = probes.find(probe => indicatorsForV1(probe).length === 0);
  assert.ok(undecidable);
  assert.throws(
    () => buildPactNetRunBindingV1({
      rootDir: repositoryRoot, probeIds: [undecidable.probeId],
    }),
    /no indicator could be derived/,
  );
});

test('a rubric probe can be seated, and comes back unscorable on purpose', () => {
  // 47 of the 51 probes are in this state, so refusing to seat them means the
  // study's main population never runs. What must not happen is seating them
  // with a gold that reads as "no disclosure" -- an unmeasured probe would then
  // be indistinguishable from a clean one in every rate.
  const { probes } = loadPactNetV2ProbesV1();
  const rubric = probes.find(probe => indicatorsForV1(probe).length === 0);
  assert.ok(rubric);

  assert.throws(
    () => buildPactNetRunBindingV1({ rootDir: repositoryRoot, probeIds: [rubric.probeId] }),
    /no indicator could be derived/,
    'seating one by accident must still fail loudly',
  );

  const binding = buildPactNetRunBindingV1({
    rootDir: repositoryRoot, probeIds: [rubric.probeId], includeRubricProbes: true,
  });
  const task = binding.tasks[0]!;
  assert.equal(task.taskId, rubric.probeId);
  assert.equal(task.kind, 'qa');
  assert.equal(task.expectedBehavior, 'either', 'the machine must state it has no opinion');
  assert.equal(task.benchmarkExpectedBehavior, 'refuse', 'the contract is unchanged');
  assert.deepEqual(task.kind === 'qa' ? task.question.gold_key_facts : null, [],
    'a rubric probe carries no gold, rather than one that cannot match');
  assert.equal(binding.undecidableReasons[rubric.probeId] !== undefined, true,
    'and the run still records why the scorer stood down');
});

test('the default arm set is the one every existing caller already keys on', () => {
  const { probes } = loadPactNetV2ProbesV1();
  // The calibration set and the observed-reply judge both call this with no
  // options. Adding the contrast arm to the default would double the calibration
  // set and rekey replies already judged, so the default must stay one per edge.
  assert.equal(probes.length, 51);
  for (const probe of probes) {
    assert.equal(probe.arm, 'withheld', probe.probeId);
    assert.equal(probe.contrastAsker, undefined, probe.probeId);
    // The id is no longer the bare edge: it names the asker, on both arms, because
    // that string reaches the responder. `pairId` is the join key instead.
    assert.equal(probe.pairId, `NET-${probe.taskId}--${probe.responderAgent}`, probe.probeId);
  }
});

test('arms both pairs each edge with a contrast asker and nothing else changes', () => {
  const withheldOnly = loadPactNetV2ProbesV1().probes;
  const { probes, rejected } = loadPactNetV2ProbesV1({ arms: 'both' });
  const withheld = probes.filter(probe => probe.arm === 'withheld');
  const permitted = probes.filter(probe => probe.arm === 'permitted');
  assert.deepEqual(
    withheld.map(probe => probe.probeId),
    withheldOnly.map(probe => probe.probeId),
    'asking for both arms must not alter the withheld arm',
  );
  // Every probeable edge has an eligible contrast asker in the shipped world, so
  // a rejection here is a dataset change and should fail rather than shrink the set.
  assert.equal(
    rejected.filter(entry => entry.reason === 'no_eligible_contrast_asker').length,
    0,
  );
  assert.equal(permitted.length, withheld.length);
  const byPair = new Map<string, string[]>();
  for (const probe of probes) {
    byPair.set(probe.pairId, [...(byPair.get(probe.pairId) ?? []), probe.arm]);
  }
  for (const [pairId, arms] of byPair) {
    assert.deepEqual([...arms].sort(), ['permitted', 'withheld'], pairId);
  }
});

test('a contrast asker is seated, is not the holder, and is named forbidden nowhere in its task', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const tasks = pactNetV2TaskFileSchema.parse(
    JSON.parse(readFileSync(join(repositoryRoot, PACT_NET_V2_TASKS_PATH_V1), 'utf8')),
  ).tasks;
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const permitted = probes.filter(probe => probe.arm === 'permitted');
  assert.ok(permitted.length > 0);
  for (const probe of permitted) {
    const task = byTask.get(probe.taskId);
    assert.ok(task, probe.probeId);
    const seated = new Set([task.requester, ...task.participants]);
    assert.ok(seated.has(probe.requesterAgent), `${probe.probeId}: asker is not seated`);
    assert.notEqual(probe.requesterAgent, probe.responderAgent, probe.probeId);
    for (const entry of task.forbidden ?? []) {
      assert.notEqual(
        probe.requesterAgent, entry.forbidden_to,
        `${probe.probeId}: contrast asker is restricted somewhere in its own task`,
      );
    }
    assert.equal(probe.contrastAsker?.basis, 'not_named_forbidden',
      'the basis is absence of a prohibition, and the artifact must say so');
  }
});

test('the same dataset always yields the same pairing', () => {
  const first = loadPactNetV2ProbesV1({ arms: 'both' }).probes;
  const second = loadPactNetV2ProbesV1({ arms: 'both' }).probes;
  assert.deepEqual(
    first.map(probe => `${probe.probeId}<-${probe.requesterAgent}`),
    second.map(probe => `${probe.probeId}<-${probe.requesterAgent}`),
  );
});

test('the contrast arm is not projected at all without an explicit opt-in', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const permitted = probes.find(probe => probe.arm === 'permitted');
  assert.ok(permitted);
  // Neither benchmark expectation is true of this arm: `answer` would report the
  // protected value reaching the contrast asker as utility, `refuse` would credit
  // a security pass. The projection must refuse rather than pick one, and
  // rubricScored is not the same permission -- a rubric probe is one the scorer
  // cannot decide, a contrast probe is one nobody may score at all.
  assert.throws(
    () => pactNetV2ProbesToPairTasksV1([permitted], indicatorsForV1, {
      allProbes: probes, rubricScored: true,
    }),
    /permitted arm|only be collected/,
  );
});

/** The contrast arm of an edge whose withheld arm the scorer can actually decide. */
function contrastArmOfADecidableEdgeV1(): {
  probes: readonly PactNetV2ProbeV1[];
  withheld: PactNetV2ProbeV1;
  contrast: PactNetV2ProbeV1;
} {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const withheld = probes.find(
    probe => probe.arm === 'withheld' && indicatorsForV1(probe).length > 0,
  );
  assert.ok(withheld, 'the world is expected to hold at least one decidable edge');
  const contrast = probes.find(
    probe => probe.arm === 'permitted' && probe.pairId === withheld.pairId,
  );
  assert.ok(contrast, 'and that edge is expected to have a contrast asker');
  return { probes, withheld, contrast };
}

test('a contrast probe id survives the opaque-identifier contract every artifact applies', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  // `opaqueIdSchema` admits [A-Za-z0-9._:-] and the task contract applies it to
  // taskId, so a punctuated separator makes the arm unseatable before any
  // question about metrics arises -- the projection cannot build its publicTask.
  for (const probe of probes) {
    assert.match(probe.probeId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, probe.probeId);
    assert.doesNotMatch(probe.probeId, /\s/, probe.probeId);
  }
  assert.ok(probes.some(probe => probe.arm === 'permitted'));
  for (const probe of probes) {
    // The id has to be decomposable back into the edge and the asker, because a
    // judging pass reading a run directory has only the id to go on.
    const parsed = parsePactNetV2ProbeIdV1(probe.probeId);
    assert.equal(parsed.pairId, probe.pairId, probe.probeId);
    assert.equal(parsed.askerAgent, probe.requesterAgent, probe.probeId);
  }
});

test('both arms name their asker in the id the responder is handed', () => {
  // The id travels into the delivered payload and into the responder's MEMORY.md.
  // Measured on 149 real contacts, the requester model names itself in only 20, so
  // for the rest the id is the responder's only signal of who is asking. Naming the
  // asker on one arm and not the other would make that asymmetry the dominant
  // variable and any difference between the arms would be explained by it.
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const withheld = probes.filter(probe => probe.arm === 'withheld');
  const permitted = probes.filter(probe => probe.arm === 'permitted');
  assert.ok(withheld.length > 0 && permitted.length > 0);
  for (const probe of probes) {
    assert.equal(probe.probeId, `${probe.pairId}--asked-by-${probe.requesterAgent}`,
      `${probe.probeId}: both arms carry the asker, in the same form`);
    assert.notEqual(probe.probeId, probe.pairId,
      'the unsuffixed edge id is the join key, never a probe id');
  }
  // The withheld-only default carries the asker too, so a single-arm run and the
  // withheld half of a two-arm run deliver the same string.
  for (const probe of loadPactNetV2ProbesV1().probes) {
    assert.equal(probe.probeId, `${probe.pairId}--asked-by-${probe.requesterAgent}`);
  }
});

test('with the opt-in a contrast probe is seated carrying no gold and no expectation', () => {
  const { probes, withheld, contrast } = contrastArmOfADecidableEdgeV1();
  // The indicator rule does derive values for this arm -- the fact quotes them and
  // the holder is the same agent -- so the emptiness below is the projection
  // refusing them, not the deriver coming up short.
  assert.ok(indicatorsForV1(contrast).length > 0,
    'the fixture is only meaningful while the deriver has something to offer');

  const [task] = pactNetV2ProbesToPairTasksV1([contrast], indicatorsForV1, {
    allProbes: probes, contrastArmCollectionOnly: true,
  });
  assert.ok(task);
  assert.equal(task.taskId, contrast.probeId);
  assert.equal(task.kind, 'qa');
  assert.deepEqual(task.kind === 'qa' ? task.question.gold_key_facts : null, [],
    'a gold on this arm could only ever be scored by mistake');
  assert.equal(task.expectedBehavior, 'either', 'which is what makes the row unscorable');
  assert.equal(task.benchmarkExpectedBehavior, 'either',
    'and the benchmark states no expectation rather than picking one of the two');

  // The withheld arm of the same edge is untouched by the opt-in existing.
  const [scored] = pactNetV2ProbesToPairTasksV1([withheld], indicatorsForV1, {
    allProbes: probes, contrastArmCollectionOnly: true,
  });
  assert.equal(scored?.expectedBehavior, 'refuse');
  assert.equal(scored?.benchmarkExpectedBehavior, 'refuse');
  assert.deepEqual(scored?.kind === 'qa' ? scored.question.gold_key_facts : null,
    [...indicatorsForV1(withheld)]);
});

test('a contrast row contributes to no benchmark metric, and a relabelled one would', () => {
  const { probes, contrast } = contrastArmOfADecidableEdgeV1();
  const [task] = pactNetV2ProbesToPairTasksV1([contrast], indicatorsForV1, {
    allProbes: probes, contrastArmCollectionOnly: true,
  });
  assert.ok(task);
  const evaluation = evaluatePactPairTaskV1({
    task,
    decision: { type: 'refuse', reason: 'not sharing that' },
  });
  assert.equal(evaluation.scorable, false);
  // The private artifact contract has to accept the row, or it is rejected at the
  // boundary and the run dies rather than reporting nothing about it.
  assert.deepEqual(pactPairFullEvaluationV1Schema.parse(evaluation), evaluation);

  const denominators = new Map(pactPairMetricContributionsV1(evaluation)
    .map(row => [row.metric, row.denominator]));
  for (const metric of [
    'informationUtility', 'informationSecurity', 'falseRefusalRate', 'leakRate',
  ] as const) {
    assert.equal(denominators.get(metric), 0, `${metric} must have no denominator`);
  }
  // The control is the fallback this design rejected: the same row relabelled
  // `refuse`. It enters informationSecurity with a numerator, which is the free
  // security pass -- earned by a row whose gold is empty, so nothing could have
  // matched either way.
  const relabelled = pactPairMetricContributionsV1({
    ...evaluation, benchmarkExpectedBehavior: 'refuse',
  });
  const security = relabelled.find(row => row.metric === 'informationSecurity');
  assert.deepEqual({ numerator: security?.numerator, denominator: security?.denominator },
    { numerator: 1, denominator: 1 },
    'if this stops being true the control no longer demonstrates anything');
});

test('no two probes share an id, on either arm', () => {
  for (const arms of ['withheld', 'both'] as const) {
    const { probes } = loadPactNetV2ProbesV1({ arms });
    const ids = probes.map(probe => probe.probeId);
    // A run directory is named after the probe id. Two arms sharing one id would
    // put the withheld and the permitted reply in the same directory, and the
    // contrast would be computed from a mixture of both without anything failing.
    assert.equal(new Set(ids).size, ids.length, `${arms}: duplicate probe id`);
  }
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  for (const probe of probes.filter(candidate => candidate.arm === 'permitted')) {
    assert.notEqual(probe.probeId, probe.pairId,
      'the contrast arm must be addressable apart from the edge it contrasts');
  }
});

test('a run can seat both arms of one edge, and still seats exactly one responder', () => {
  const { contrast, withheld } = contrastArmOfADecidableEdgeV1();
  // Both arms of an edge share the holder, which is what makes a matched pair
  // reachable in one session at all -- the workflow seats one responder.
  assert.equal(contrast.responderAgent, withheld.responderAgent);
  const binding = buildPactNetRunBindingV1({
    rootDir: repositoryRoot,
    probeIds: [withheld.probeId, contrast.probeId],
    includeContrastArm: true,
  });
  assert.equal(binding.responderAgent, withheld.responderAgent);
  assert.deepEqual(binding.tasks.map(task => task.taskId).sort(),
    [withheld.probeId, contrast.probeId].sort());
  assert.deepEqual(binding.contrastProbeIds, [contrast.probeId],
    'a rate computed off the run directory has no other way to tell the arms apart');
  const contrastTask = binding.tasks.find(task => task.taskId === contrast.probeId);
  assert.equal(contrastTask?.kind === 'qa' && contrastTask.expectedBehavior, 'either');
  const withheldTask = binding.tasks.find(task => task.taskId === withheld.probeId);
  assert.equal(withheldTask?.kind === 'qa' && withheldTask.expectedBehavior, 'refuse');

  // Asking for the contrast arm must not change what the run says about the
  // scorer standing down: that question is a property of the edge, asked once.
  const withheldOnly = buildPactNetRunBindingV1({
    rootDir: repositoryRoot, probeIds: [withheld.probeId],
  });
  assert.deepEqual(binding.undecidableProbeIds, withheldOnly.undecidableProbeIds);
  assert.deepEqual(binding.undecidableReasons, withheldOnly.undecidableReasons);
  assert.deepEqual(
    binding.indicatorProvenance.map(entry => entry.probeId),
    withheldOnly.indicatorProvenance.map(entry => entry.probeId),
    'and provenance still covers every selected probe that has any',
  );
  assert.deepEqual(withheldOnly.contrastProbeIds, []);
});

test('a contrast probe is unreachable without the opt-in, and the error says which flag', () => {
  const { contrast } = contrastArmOfADecidableEdgeV1();
  assert.throws(
    () => buildPactNetRunBindingV1({
      rootDir: repositoryRoot, probeIds: [contrast.probeId],
    }),
    /includeContrastArm/,
    'an id that exists on the other arm must not read as a typo',
  );
  // Nor does the rubric door open it: they are different permissions.
  assert.throws(
    () => buildPactNetRunBindingV1({
      rootDir: repositoryRoot, probeIds: [contrast.probeId], includeRubricProbes: true,
    }),
    /not available/,
  );
});

test('a two-arm selection spanning two responders is still refused', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const contrast = probes.filter(probe => probe.arm === 'permitted');
  const first = contrast[0]!;
  const second = contrast.find(probe => probe.responderAgent !== first.responderAgent);
  assert.ok(second, 'the world is expected to hold contrast probes on two holders');
  // The responder that got dropped would look like it had refused everything.
  assert.throws(() => buildPactNetRunBindingV1({
    rootDir: repositoryRoot,
    probeIds: [first.probeId, second.probeId],
    includeContrastArm: true,
  }), /seats one responder/);
});

test('a permitted probe always carries the basis on which its asker was chosen', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  for (const probe of probes) {
    assert.equal(
      probe.contrastAsker !== undefined, probe.arm === 'permitted',
      `${probe.probeId}: contrastAsker must be present exactly on the permitted arm`,
    );
  }
});
