import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPactPairTasksV1 } from '../../src/runner/v1/task-loader.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('loads distinct QA/action ids and preserves requested filter order', () => {
  const tasks = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    ids: ['A1', 'PAIR-Q1'],
  });

  assert.deepEqual(tasks.map(task => task.taskId), ['PAIR-A1', 'PAIR-Q1']);
  assert.equal(tasks[0]?.kind, 'action');
  assert.equal(tasks[1]?.kind, 'qa');
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    kind: 'qa',
    ids: ['PAIR-A1'],
  }), /does not exist in the qa filter/);
});

test('relationship labels take precedence over policy category expectations', () => {
  const privateForStranger = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D0',
    requester: 'R0',
    ids: ['Q101'],
  })[0];
  const legitimateForDelegate = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R2',
    ids: ['Q101'],
  })[0];
  const categoryOnly = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D1',
    requester: 'R1',
    ids: ['Q251'],
  })[0];

  assert.equal(privateForStranger?.kind, 'qa');
  assert.equal(privateForStranger?.expectedBehavior, 'refuse');
  assert.equal(privateForStranger?.kind === 'qa' && privateForStranger.relationshipLabel, 'P');
  assert.equal(legitimateForDelegate?.expectedBehavior, 'answer');
  assert.equal(
    legitimateForDelegate?.kind === 'qa' && legitimateForDelegate.relationshipLabel,
    'L',
  );
  assert.equal(categoryOnly?.expectedBehavior, 'either');
  assert.equal(categoryOnly?.kind === 'qa' && categoryOnly.relationshipLabel, undefined);
});

test('public task intro omits every private grading and retrieval field', () => {
  const task = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R0',
    ids: ['Q101'],
  })[0];
  assert.ok(task);
  assert.equal(task.kind, 'qa');
  assert.deepEqual(Object.keys(task.publicTask).sort(), [
    'kind',
    'prompt',
    'requester',
    'surface',
    'target',
    'taskId',
  ]);

  const serialized = JSON.stringify(task.publicTask);
  assert.doesNotMatch(serialized, /gold_key_facts|minimum_correct|source_notes|source_todos|category/);
  assert.doesNotMatch(serialized, /potential promotion to president/i);
  assert.doesNotMatch(serialized, /"relationship":"[LPB]"/);
});

test('infers note, todo, and mixed-source QA surfaces without exposing sources', t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pact-pair-loader-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const tasksDir = join(fixtureRoot, 'pact_pair', 'tasks');
  const labelsDir = join(fixtureRoot, 'pact_pair', 'relationship_labels');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(labelsDir, { recursive: true });

  const benchmark = JSON.parse(
    readFileSync(join(repoRoot, 'pact_pair', 'tasks', 'questions.json'), 'utf8'),
  ) as { questions: Array<Record<string, unknown>> };
  benchmark.questions[0] = {
    ...benchmark.questions[0],
    source_todos: ['Synthetic correlated todo'],
  };
  writeFileSync(join(tasksDir, 'questions.json'), JSON.stringify(benchmark));
  writeFileSync(
    join(labelsDir, 'relationship_label_matrix.json'),
    readFileSync(
      join(repoRoot, 'pact_pair', 'relationship_labels', 'relationship_label_matrix.json'),
    ),
  );

  const [mixed, todo, note] = loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R1',
    ids: ['Q1', 'Q201', 'Q2'],
  });
  assert.equal(mixed?.publicTask.surface, 'unknown');
  assert.equal(todo?.publicTask.surface, 'todos');
  assert.equal(note?.publicTask.surface, 'notes');
});

test('applies kind and limit and rejects malformed or duplicate ids', () => {
  const tasks = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D5',
    requester: 'R4',
    kind: 'action',
    limit: 2,
  });
  assert.deepEqual(tasks.map(task => task.taskId), ['PAIR-A1', 'PAIR-A2']);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    ids: ['Q1', 'PAIR-Q1'],
  }), /ids must be unique/);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    ids: ['1'],
  }), /Invalid PACT-Pair task id/);
});
