import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPactNetV2ProbeAnchorV1,
  loadPactNetV2ProbesV1,
  pactNetAgentStoreToPairStoreV1,
  pactNetV2ProbeNumbersV1,
} from '../../../src/suites/pact-net/v2-probes.js';
import { pactNetV2ProbesToPairTasksV1 } from '../../../src/suites/pact-net/v2-pair-tasks.js';
import { containsPactPairFactV1 } from '../../../src/suites/pact-pair/evaluator.js';
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

test('a probe whose protected string is only a class description is not decidable', () => {
  const { probes } = loadPactNetV2ProbesV1();
  const anchors = probes.map(probe => classifyPactNetV2ProbeAnchorV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
    containsPactPairFactV1,
  ));
  assert.ok(anchors.includes('not_quotable'), 'the class-description case must exist');
  assert.ok(anchors.some(anchor => anchor === 'named_note'), 'the quotable case must exist');
});

test('question numbers are stable against the selection, not the subset', () => {
  const { probes } = loadPactNetV2ProbesV1();
  const all = pactNetV2ProbeNumbersV1(probes);
  const subset = pactNetV2ProbeNumbersV1(probes.slice(0, 3));
  const target = probes[probes.length - 1]!.probeId;
  assert.equal(typeof all.get(target), 'number');
  const tasks = pactNetV2ProbesToPairTasksV1([probes[probes.length - 1]!], {
    allProbes: probes,
  });
  assert.equal(tasks[0]!.question.id, all.get(target));
  assert.notEqual(all.size, subset.size);
});

test('a projected probe is refuse-expected and carries its protected string as the gold', () => {
  const { probes } = loadPactNetV2ProbesV1();
  const tasks = pactNetV2ProbesToPairTasksV1(probes, { allProbes: probes });
  for (const [index, task] of tasks.entries()) {
    const probe = probes[index]!;
    assert.equal(task.expectedBehavior, 'refuse', task.taskId);
    assert.deepEqual(task.question.gold_key_facts, [probe.forbiddenFact]);
    assert.equal(task.question.question, probe.ask);
    assert.equal(task.category, probe.category);
    // The MEMORY row grammar splits on spaces around an em dash, so a task id
    // may not contain whitespace.
    assert.doesNotMatch(task.taskId, /\s/);
  }
  assert.equal(new Set(tasks.map(task => task.taskId)).size, tasks.length);
});

test('a run seats one responder and refuses a selection that spans two', () => {
  const { probes } = loadPactNetV2ProbesV1();
  // Only decidable probes can be bound, so the selection is drawn from those.
  const decidable = probes.filter(probe => classifyPactNetV2ProbeAnchorV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
    containsPactPairFactV1,
  ) !== 'not_quotable');
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
  const undecidable = probes.find(probe => classifyPactNetV2ProbeAnchorV1(
    probe,
    dataStoreSchema.parse(pactNetAgentStoreToPairStoreV1(probe.responderAgent).store).notes,
    containsPactPairFactV1,
  ) === 'not_quotable');
  assert.ok(undecidable);
  assert.throws(
    () => buildPactNetRunBindingV1({
      rootDir: repositoryRoot, probeIds: [undecidable.probeId],
    }),
    /protected class rather than a quotable string/,
  );
});
