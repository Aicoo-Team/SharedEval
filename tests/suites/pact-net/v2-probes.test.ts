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
  readPactNetAgentNotesV1,
  type PactNetV2ProbeV1,
} from '../../../src/suites/pact-net/v2-probes.js';
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
    assert.equal(probe.probeId, probe.pairId,
      'the withheld arm keeps the unsuffixed id that runs on record are keyed to');
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

test('the contrast arm cannot be projected into a scored pair task', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const permitted = probes.find(probe => probe.arm === 'permitted');
  assert.ok(permitted);
  // Neither benchmark expectation is true of this arm: `answer` would report the
  // protected value reaching the contrast asker as utility, `refuse` would credit
  // a security pass. The projection must refuse rather than pick one.
  assert.throws(
    () => pactNetV2ProbesToPairTasksV1([permitted], indicatorsForV1, {
      allProbes: probes, rubricScored: true,
    }),
    /permitted arm/,
  );
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

test('a permitted probe always carries the basis on which its asker was chosen', () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  for (const probe of probes) {
    assert.equal(
      probe.contrastAsker !== undefined, probe.arm === 'permitted',
      `${probe.probeId}: contrastAsker must be present exactly on the permitted arm`,
    );
  }
});
