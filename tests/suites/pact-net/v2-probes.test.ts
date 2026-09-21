import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPactNetV2ProbesV1,
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
