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
    gradingMode: 'category',
    ids: ['A1', 'PAIR-Q1'],
  });

  assert.deepEqual(tasks.map(task => task.taskId), ['PAIR-A1', 'PAIR-Q1']);
  assert.equal(tasks[0]?.kind, 'action');
  assert.equal(tasks[1]?.kind, 'qa');
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'qa',
    ids: ['PAIR-A1'],
  }), /does not exist in the qa filter/);
});

test('grading mode explicitly selects category or relationship expectations', () => {
  const categoryForStranger = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D0',
    requester: 'R0',
    gradingMode: 'category',
    ids: ['Q101'],
  })[0];
  const privateForStranger = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D0',
    requester: 'R0',
    gradingMode: 'relationship',
    ids: ['Q101'],
  })[0];
  const legitimateForDelegate = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R2',
    gradingMode: 'relationship',
    ids: ['Q101'],
  })[0];
  const categoryOnly = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D1',
    requester: 'R1',
    gradingMode: 'category',
    ids: ['Q251'],
  })[0];

  assert.equal(categoryForStranger?.expectedBehavior, 'answer');
  assert.equal(categoryForStranger?.gradingMode, 'category');
  assert.equal(
    categoryForStranger?.kind === 'qa' && categoryForStranger.relationshipLabel,
    'P',
  );
  assert.equal(privateForStranger?.kind, 'qa');
  assert.equal(privateForStranger?.expectedBehavior, 'refuse');
  assert.equal(privateForStranger?.gradingMode, 'relationship');
  assert.equal(privateForStranger?.kind === 'qa' && privateForStranger.relationshipLabel, 'P');
  assert.equal(legitimateForDelegate?.expectedBehavior, 'answer');
  assert.equal(
    legitimateForDelegate?.kind === 'qa' && legitimateForDelegate.relationshipLabel,
    'L',
  );
  assert.equal(categoryOnly?.expectedBehavior, 'either');
  assert.equal(categoryOnly?.kind === 'qa' && categoryOnly.relationshipLabel, undefined);
});

test('matched ablations share the fixed D2 category gold contract', () => {
  for (const policy of [
    'A_LONG_GENERIC',
    'A_CATEGORY_ONLY',
    'A_CATEGORY_EXAMPLES',
  ] as const) {
    const [protectedTask, publicTask] = loadPactPairTasksV1({
      rootDir: repoRoot,
      policy,
      requester: 'R1',
      gradingMode: 'category',
      ids: ['Q101', 'Q1'],
    });
    assert.equal(protectedTask?.expectedBehavior, 'refuse');
    assert.equal(publicTask?.expectedBehavior, 'answer');
  }
});

test('keeps the fixed benchmark category split independent of policy labels', () => {
  const ids = Array.from({ length: 200 }, (_, index) => `Q${index + 1}`);
  const expectedPolicyCounts = {
    D0: { answer: 200, refuse: 0, either: 0 },
    D1: { answer: 101, refuse: 0, either: 99 },
    D2_SUBMITTED: { answer: 101, refuse: 99, either: 0 },
  } as const;

  for (const policy of ['D0', 'D1', 'D2_SUBMITTED'] as const) {
    const tasks = loadPactPairTasksV1({
      rootDir: repoRoot,
      policy,
      requester: 'R0',
      gradingMode: 'category',
      kind: 'qa',
      ids,
    });
    const count = (behavior: 'answer' | 'refuse' | 'either') =>
      tasks.filter(task => task.kind === 'qa' && task.expectedBehavior === behavior).length;
    assert.deepEqual(
      {
        answer: count('answer'),
        refuse: count('refuse'),
        either: count('either'),
      },
      expectedPolicyCounts[policy],
    );
    assert.equal(
      tasks.filter(task =>
        task.kind === 'qa' && task.benchmarkExpectedBehavior === 'answer').length,
      101,
    );
    assert.equal(
      tasks.filter(task =>
        task.kind === 'qa' && task.benchmarkExpectedBehavior === 'refuse').length,
      99,
    );
  }
});

test('submitted policy IDs use their original policy dials', () => {
  for (const policy of [
    'D2_SUBMITTED',
    'D3_SUBMITTED',
    'D4_SUBMITTED',
    'D5_SUBMITTED',
  ] as const) {
    const [protectedTask, publicTask] = loadPactPairTasksV1({
      rootDir: repoRoot,
      policy,
      requester: 'R1',
      gradingMode: 'category',
      ids: ['Q101', 'Q1'],
    });
    assert.equal(protectedTask?.expectedBehavior, 'refuse');
    assert.equal(publicTask?.expectedBehavior, 'answer');
  }

  const categoryBaseline = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2_SUBMITTED',
    requester: 'R2',
    gradingMode: 'category',
    kind: 'qa',
    ids: ['Q101'],
  })[0];
  const relationshipBaseline = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2_SUBMITTED',
    requester: 'R2',
    gradingMode: 'relationship',
    kind: 'qa',
    ids: ['Q101'],
  })[0];
  assert.equal(categoryBaseline?.expectedBehavior, 'refuse');
  assert.equal(relationshipBaseline?.expectedBehavior, 'answer');
});

test('public task intro omits every private grading and retrieval field', () => {
  const task = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'relationship',
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
    gradingMode: 'category',
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
    gradingMode: 'category',
    kind: 'action',
    limit: 2,
  });
  assert.deepEqual(tasks.map(task => task.taskId), ['PAIR-A1', 'PAIR-A2']);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids: ['Q1', 'PAIR-Q1'],
  }), /ids must be unique/);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids: ['1'],
  }), /Invalid PACT-Pair task id/);
});

test('rejects mismatched relationship policy calls outside config parsing', () => {
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'REL_R3',
    requester: 'R1',
    gradingMode: 'relationship',
    ids: ['Q101'],
  }), /REL_R3 must be paired with requester R3/);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'REL_R3',
    requester: 'R3',
    gradingMode: 'category',
    ids: ['Q101'],
  }), /REL_R3 requires relationship grading/);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'REL_R3',
    requester: 'R3',
    gradingMode: 'relationship',
    kind: 'action',
    ids: ['A1'],
  }), /REL_R3 is validated only for QA tasks/);
});
