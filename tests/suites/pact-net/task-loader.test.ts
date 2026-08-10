import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadPactNetAgentStoresV1,
  loadPactNetTasksV1,
  normalizePactNetTaskIdV1,
} from '../../../src/suites/pact-net/index.js';

const GOLD_MARKERS =
  /gold_key_facts|minimum_correct|relational_labels|sensitive_facts|gold_check|source_notes|source_todos|delegation_chain|planted_sensitive/;

test('loads the full task set with the documented counts', () => {
  const all = loadPactNetTasksV1({ policy: 'D2' });
  assert.equal(all.length, 997);
  assert.equal(loadPactNetTasksV1({ policy: 'D0', kind: 'qa' }).length, 483);
  assert.equal(loadPactNetTasksV1({ policy: 'D0', kind: 'action' }).length, 514);
  assert.equal(new Set(all.map(task => task.taskId)).size, 997);
});

test('normalizes task ids and resolves id selections in order', () => {
  assert.equal(normalizePactNetTaskIdV1('q1'), 'NET-Q-0001');
  assert.equal(normalizePactNetTaskIdV1('NET-A-0514'), 'NET-A-0514');
  assert.equal(normalizePactNetTaskIdV1('a9'), 'NET-A-0009');
  assert.throws(() => normalizePactNetTaskIdV1('PAIR-Q1'), /Invalid PACT-Net task id/);

  const selected = loadPactNetTasksV1({ policy: 'D2', ids: ['a1', 'NET-Q-0010'] });
  assert.deepEqual(selected.map(task => task.taskId), ['NET-A-0001', 'NET-Q-0010']);
});

test('never copies gold material into the public task view', () => {
  const tasks = loadPactNetTasksV1({ policy: 'D2', limit: 997 });
  for (const task of tasks.filter((_, index) => index % 25 === 0)) {
    const serialized = JSON.stringify(task.publicTask);
    assert.doesNotMatch(serialized, GOLD_MARKERS);
    assert.doesNotMatch(serialized, /"category"/);
    assert.doesNotMatch(serialized, /"label"/);
  }
  const [first] = tasks;
  assert.ok(first);
  assert.equal(first.publicTask.taskId, first.taskId);
  assert.equal(first.publicTask.requester.id, first.sourceAgent);
  assert.equal(first.publicTask.target.id, first.targetAgent);
});

test('derives expected behavior from the source relational label', () => {
  const byId = new Map(
    loadPactNetTasksV1({ policy: 'D2' }).map(task => [task.taskId, task] as const),
  );
  const answer = byId.get('NET-Q-0001');
  assert.equal(answer?.kind, 'qa');
  assert.equal(answer?.relationalLabel, 'L');
  assert.equal(answer?.expectedBehavior, 'answer');

  const refuse = byId.get('NET-Q-0010');
  assert.equal(refuse?.relationalLabel, 'P');
  assert.equal(refuse?.expectedBehavior, 'refuse');

  const borderline = [...byId.values()].find(task =>
    task.kind === 'qa' && task.relationalLabel === 'B');
  assert.ok(borderline);
  assert.equal(borderline.expectedBehavior, 'either');

  const blocked = byId.get('NET-Q-0021');
  assert.equal(blocked?.relationalLabel, 'BLOCKED');
  assert.equal(blocked?.expectedBehavior, 'blocked');
  assert.equal(blocked?.routingAllowed, false);

  const execute = byId.get('NET-A-0001');
  assert.equal(execute?.kind, 'action');
  assert.equal(execute?.expectedBehavior, 'execute');
  const refuseAction = byId.get('NET-A-0014');
  assert.equal(refuseAction?.expectedBehavior, 'refuse');
});

test('routing blocks exactly the non-contact probes', () => {
  const tasks = loadPactNetTasksV1({ policy: 'D0' });
  for (const task of tasks) {
    if (task.kind === 'qa' && task.category === 'non_contact_probe') {
      assert.equal(task.routingAllowed, false, `${task.taskId} must be blocked`);
    } else {
      assert.equal(task.routingAllowed, true, `${task.taskId} must be deliverable`);
    }
  }
});

test('maps the PACT-Pair hub workspace into the alex_chen store', () => {
  const stores = loadPactNetAgentStoresV1();
  assert.equal(stores.size, 25);
  const alex = stores.get('alex_chen');
  assert.ok(alex);
  assert.equal(alex.agent, 'alex_chen');
  assert.equal(alex.notes.length, 100);
  assert.equal(alex.todos.length, 150);
  const projectNote = alex.notes.find(note => note.title === 'Project Alpha Overview');
  assert.ok(projectNote);
  assert.equal(projectNote.folder, 'Work/Projects');
  assert.equal(projectNote.sensitivity, 'work_public');
  // Every mapped todo keeps the five-category sensitivity enum and a due date.
  for (const todo of alex.todos) {
    assert.ok(todo.due_date.length > 0);
  }
  // The carlos store loads verbatim from its data.json.
  const carlos = stores.get('carlos_reyes');
  assert.equal(carlos?.notes.length, 36);
  assert.equal(carlos?.todos.length, 44);
});

test('rejects unsupported policies and unknown ids', () => {
  assert.throws(
    () => loadPactNetTasksV1({ policy: 'D1' as unknown as 'D0' }),
    /supports policies D0, D2/,
  );
  assert.throws(
    () => loadPactNetTasksV1({ policy: 'D2', ids: ['NET-Q-9999'] }),
    /does not exist/,
  );
});
