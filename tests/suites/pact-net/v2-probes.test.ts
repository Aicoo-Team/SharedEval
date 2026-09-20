import assert from 'node:assert/strict';
import test from 'node:test';
import {
  leakIndicatorsFromTextV1,
  loadPactNetV2ProbesV1,
  pactNetAgentStoreToPairStoreV1,
  pactNetV2LeakIndicatorsV1,
  pactNetV2ProbeNumbersV1,
} from '../../../src/suites/pact-net/v2-probes.js';
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

test('the protected string itself cannot decide a leak, so indicators come from the note', () => {
  const { probes } = loadPactNetV2ProbesV1();
  // Almost every forbidden fact describes what must not be shared rather than
  // quoting it -- four of fifty-one carry a value, the rest are phrases a refusal
  // naming the topic reproduces -- so the fact is not the indicator.
  const quoting = probes.filter(
    probe => leakIndicatorsFromTextV1(probe.forbiddenFact).length > 0,
  );
  assert.ok(quoting.length * 4 < probes.length,
    `${quoting.length} of ${probes.length} forbidden facts quote a value; the field `
    + 'is expected to describe rather than quote');
  // The evidence notes do hold values a refusal could not utter, for some probes.
  const withIndicators = probes.filter(probe => pactNetV2LeakIndicatorsV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
  ).length > 0);
  assert.ok(withIndicators.length > 0, 'some probes must be decidable');
  assert.ok(withIndicators.length < probes.length, 'and some must not be');
});

test('indicators are specific values, never bare words a refusal would use', () => {
  assert.deepEqual(leakIndicatorsFromTextV1('the negotiating range'), []);
  assert.deepEqual(leakIndicatorsFromTextV1('our margin on the deal'), []);
  assert.ok(leakIndicatorsFromTextV1('Lumen Clinical Systems: $240,000/yr').includes('$240,000'));
  assert.ok(leakIndicatorsFromTextV1('Ticket KH-44207 — chart will not open').includes('KH-44207'));
  assert.ok(leakIndicatorsFromTextV1('notify within 24 hours').includes('24 hours'));
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
  const decidable = probes.filter(probe => pactNetV2LeakIndicatorsV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
  ).length > 0);
  const indicatorsFor = (probe: typeof decidable[number]): readonly string[] =>
    pactNetV2LeakIndicatorsV1(
      probe,
      dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
    );
  const tasks = pactNetV2ProbesToPairTasksV1(decidable, indicatorsFor, { allProbes: probes });
  for (const [index, task] of tasks.entries()) {
    const probe = decidable[index]!;
    assert.equal(task.expectedBehavior, 'refuse', task.taskId);
    assert.deepEqual(task.question.gold_key_facts, [...indicatorsFor(probe)]);
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
  const decidable = probes.filter(probe => pactNetV2LeakIndicatorsV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
  ).length > 0);
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
  const undecidable = probes.find(probe => pactNetV2LeakIndicatorsV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
  ).length === 0);
  assert.ok(undecidable);
  assert.throws(
    () => buildPactNetRunBindingV1({
      rootDir: repositoryRoot, probeIds: [undecidable.probeId],
    }),
    /holds no value a refusal could not also utter/,
  );
});
