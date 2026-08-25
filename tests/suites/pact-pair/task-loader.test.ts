import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { loadPactPairRelationshipLabelSetV2 } from '../../../src/suites/pact-pair/relationship-labels.js';
import {
  loadPactPairTasksV1,
  loadPactPairTaskSetV1,
} from '../../../src/suites/pact-pair/task-loader.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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
    undefined,
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
  const tasksDir = join(fixtureRoot, 'dataset', 'pact-pair', 'tasks');
  const labelsDir = join(
    fixtureRoot,
    'dataset',
    'pact-pair',
    'relationship_labels',
  );
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(labelsDir, { recursive: true });

  const benchmark = JSON.parse(
    readFileSync(
      join(repoRoot, 'dataset', 'pact-pair', 'tasks', 'questions.json'),
      'utf8',
    ),
  ) as { questions: Array<Record<string, unknown>> };
  benchmark.questions[0] = {
    ...benchmark.questions[0],
    source_todos: ['Synthetic correlated todo'],
  };
  writeFileSync(join(tasksDir, 'questions.json'), JSON.stringify(benchmark));
  writeFileSync(
    join(labelsDir, 'relationship_label_matrix.json'),
    readFileSync(
      join(
        repoRoot,
        'dataset',
        'pact-pair',
        'relationship_labels',
        'relationship_label_matrix.json',
      ),
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
  const relationshipAction = loadPactPairTasksV1({
    rootDir: repoRoot,
    policy: 'REL_R3',
    requester: 'R3',
    gradingMode: 'relationship',
    kind: 'action',
    ids: ['A1'],
  })[0];
  assert.equal(relationshipAction?.kind, 'action');
  assert.equal(relationshipAction?.expectedBehavior, 'refuse');
});

function makeTaskDataFixture(
  t: { after(callback: () => void): void },
): { root: string; labelsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pact-pair-task-set-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tasksDir = join(root, 'dataset', 'pact-pair', 'tasks');
  const labelsDir = join(root, 'dataset', 'pact-pair', 'relationship_labels');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(labelsDir, { recursive: true });
  writeFileSync(
    join(tasksDir, 'questions.json'),
    readFileSync(join(repoRoot, 'dataset', 'pact-pair', 'tasks', 'questions.json')),
  );
  return { root, labelsDir };
}

test('category task bytes stay independent of relationship gold', t => {
  const loadTaskSet = loadPactPairTaskSetV1;
  const fixture = makeTaskDataFixture(t);
  const matrixPath = join(fixture.labelsDir, 'relationship_label_matrix_v2.json');
  writeFileSync(
    matrixPath,
    readFileSync(join(
      repoRoot,
      'dataset',
      'pact-pair',
      'relationship_labels',
      'relationship_label_matrix_v2.json',
    )),
  );
  const options = {
    rootDir: fixture.root,
    policy: 'D2' as const,
    requester: 'R0' as const,
    gradingMode: 'category' as const,
    ids: ['Q1', 'Q101', 'A1'],
  };
  const before = loadTaskSet(options);
  writeFileSync(matrixPath, '{ deliberately invalid and changed gold');
  const after = loadTaskSet(options);

  const bytes = (value: unknown) => JSON.stringify(value);
  const digest = (value: unknown) => createHash('sha256').update(bytes(value)).digest('hex');
  assert.equal(bytes(before), bytes(after));
  assert.equal(digest(before), digest(after));
  assert.equal(before.relationshipLabelProvenance, undefined);
  assert.ok(before.tasks.every(task => !('relationshipLabel' in task)));
});

test('relationship task set returns exact v2 labels, provenance hash, and Riley identity', () => {
  const taskSet = loadPactPairTaskSetV1({
    rootDir: repoRoot,
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'relationship',
    ids: ['Q1', 'A1'],
  });
  const [qa, action] = taskSet.tasks;
  assert.equal(qa?.kind, 'qa');
  assert.equal(qa?.expectedBehavior, 'refuse');
  assert.equal(qa?.kind === 'qa' && qa.relationshipLabel, 'P');
  assert.equal(action?.kind, 'action');
  assert.equal(action?.expectedBehavior, 'refuse');
  assert.equal(action?.kind === 'action' && action.benchmarkExpectedBehavior, 'execute');
  assert.equal(action?.kind === 'action' && action.relationshipLabel, 'refuse');

  const matrixBytes = readFileSync(join(
    repoRoot,
    'dataset',
    'pact-pair',
    'relationship_labels',
    'relationship_label_matrix_v2.json',
  ));
  assert.equal(taskSet.relationshipLabelProvenance?.schema, 'pact-pair-relationship-labels/v2');
  assert.equal(taskSet.relationshipLabelProvenance?.qaRows, 400);
  assert.equal(taskSet.relationshipLabelProvenance?.actionRows, 200);
  assert.equal(
    taskSet.relationshipLabelProvenance?.sha256,
    createHash('sha256').update(matrixBytes).digest('hex'),
  );
  assert.deepEqual(taskSet.requesterIdentityProvenance, {
    schema: 'pact-pair-requester-identities/v2',
    version: '2',
    requesterId: 'R0',
    displayName: 'Riley Novak',
  });
  assert.equal(qa?.publicTask.requester.displayName, 'Riley Novak');
});

test('loads relationship labels once and binds tasks to that exact source', t => {
  const loadTaskSet = loadPactPairTaskSetV1;
  const fixture = makeTaskDataFixture(t);
  const matrixPath = join(fixture.labelsDir, 'relationship_label_matrix_v2.json');
  const originalBytes = readFileSync(join(
    repoRoot,
    'dataset',
    'pact-pair',
    'relationship_labels',
    'relationship_label_matrix_v2.json',
  ));
  writeFileSync(matrixPath, originalBytes);
  let reads = 0;
  const taskSet = loadTaskSet({
    rootDir: fixture.root,
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'relationship',
    ids: ['Q1'],
  }, {
    loadRelationshipLabels(rootDir) {
      reads += 1;
      const loaded = loadPactPairRelationshipLabelSetV2(rootDir);
      writeFileSync(matrixPath, '{ changed between potential reads');
      return loaded;
    },
  });

  assert.equal(reads, 1);
  assert.equal(taskSet.tasks[0]?.expectedBehavior, 'refuse');
  assert.equal(
    taskSet.relationshipLabelProvenance?.sha256,
    createHash('sha256').update(originalBytes).digest('hex'),
  );
});

test('keeps the frozen v1 R0 identity distinct from v2 Riley', t => {
  const fixture = makeTaskDataFixture(t);
  writeFileSync(
    join(fixture.labelsDir, 'relationship_label_matrix.json'),
    readFileSync(join(
      repoRoot,
      'dataset',
      'pact-pair',
      'relationship_labels',
      'relationship_label_matrix.json',
    )),
  );
  const taskSet = loadPactPairTaskSetV1({
    rootDir: fixture.root,
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'relationship',
    kind: 'qa',
    ids: ['Q101'],
  });
  assert.deepEqual(taskSet.requesterIdentityProvenance, {
    schema: 'pact-pair-requester-identities/v1',
    version: '1',
    requesterId: 'R0',
    displayName: 'Tina Rodriguez',
  });
  assert.equal(taskSet.tasks[0]?.publicTask.requester.displayName, 'Tina Rodriguez');
});
