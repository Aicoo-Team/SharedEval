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
import { loadPactPairTasksV1 } from '../../../src/suites/pact-pair/task-loader.js';

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
  // Since the schema-v2 matrix release every task carries a relationship
  // label; category grading records it as metadata without consuming it.
  assert.equal(categoryOnly?.kind === 'qa' && categoryOnly.relationshipLabel, 'P');
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
  // Action selections are no longer rejected up front for relationship
  // policies. The released repo matrix now labels every action, so the
  // unlabelled-action fail-loud path is exercised against a fixture whose
  // v2 matrix is empty.
  const emptyFixtureRoot = mkdtempSync(join(tmpdir(), 'pact-pair-empty-grid-'));
  try {
    const probe = writeGridFixture({ fixtureRoot: emptyFixtureRoot });
    const q101 = probe.questions.find(question => question['id'] === 101);
    assert.ok(q101);
    // One QA row keeps the matrix schema-valid while every action stays
    // unlabelled, exercising the action coverage gate.
    writeGridFixture({
      fixtureRoot: emptyFixtureRoot,
      questionRows: [{
        id: q101['id'],
        category: q101['category'],
        question: q101['question'],
        R0: 'P',
        R1: 'P',
        R2: 'L',
        R3: 'P',
        R4: 'P',
      }],
    });
    assert.throws(() => loadPactPairTasksV1({
      rootDir: emptyFixtureRoot,
      policy: 'REL_R3',
      requester: 'R3',
      gradingMode: 'relationship',
      kind: 'action',
      ids: ['A1'],
    }), /requires a relationship label for every selected task.*PAIR-A1/);
  } finally {
    rmSync(emptyFixtureRoot, { recursive: true, force: true });
  }
});

test('fails loudly when relationship grading selects unlabelled tasks', t => {
  // The released repo matrix covers all 600 tasks, so partial coverage is
  // reproduced with a fixture matrix that labels only Q101.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pact-pair-partial-grid-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const probe = writeGridFixture({ fixtureRoot });
  const q101 = probe.questions.find(question => question['id'] === 101);
  assert.ok(q101);
  writeGridFixture({
    fixtureRoot,
    questionRows: [{
      id: q101['id'],
      category: q101['category'],
      question: q101['question'],
      R0: 'P',
      R1: 'P',
      R2: 'L',
      R3: 'P',
      R4: 'P',
    }],
  });

  assert.throws(() => loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'relationship',
    kind: 'qa',
    ids: ['Q1', 'Q101'],
  }), /requires a relationship label for every selected task.*PAIR-Q1\b/);

  // Tasks outside the final selection never trigger the coverage gate: the
  // same unlabelled Q1 is fine under category grading, and a relationship
  // run restricted to labelled tasks loads normally.
  const labelled = loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'relationship',
    kind: 'qa',
    ids: ['Q101'],
  })[0];
  assert.equal(labelled?.expectedBehavior, 'refuse');
});

function writeGridFixture(options: {
  fixtureRoot: string;
  actionRows?: Array<Record<string, unknown>>;
  questionRows?: Array<Record<string, unknown>>;
}): { questions: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> } {
  const tasksDir = join(options.fixtureRoot, 'dataset', 'pact-pair', 'tasks');
  const labelsDir = join(options.fixtureRoot, 'dataset', 'pact-pair', 'relationship_labels');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(labelsDir, { recursive: true });
  const benchmarkSource = readFileSync(
    join(repoRoot, 'dataset', 'pact-pair', 'tasks', 'questions.json'),
    'utf8',
  );
  writeFileSync(join(tasksDir, 'questions.json'), benchmarkSource);
  const benchmark = JSON.parse(benchmarkSource) as {
    questions: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
  };
  const matrix = {
    schema: 'pact-pair-relationship-labels/v2',
    version: '2.0-test',
    description: 'Test fixture grid labels',
    requesters: {
      R0: 'Stranger',
      R1: 'Colleague',
      R2: 'CEO delegate',
      R3: 'Close friend',
      R4: 'Investor',
    },
    label_key: { P: 'refuse', L: 'answer', B: 'either' },
    action_label_key: { execute: 'perform', refuse: 'decline' },
    questions: options.questionRows ?? [],
    actions: options.actionRows ?? [],
  };
  // Deliberately no v1 relationship_label_matrix.json in the fixture: the v2
  // file must be authoritative and self-sufficient when present.
  writeFileSync(
    join(labelsDir, 'relationship_label_matrix_v2.json'),
    JSON.stringify(matrix),
  );
  return benchmark;
}

test('loads per-requester action expectations from a v2 label matrix', t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pact-pair-grid-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const probe = writeGridFixture({ fixtureRoot });
  const executeAction = probe.actions.find(action => action['expected_verdict'] === 'execute');
  assert.ok(executeAction);
  writeGridFixture({
    fixtureRoot,
    actionRows: [{
      id: executeAction['id'],
      category: executeAction['category'],
      instruction: executeAction['instruction'],
      R0: 'refuse',
      R1: 'execute',
      R2: 'execute',
      R3: 'refuse',
      R4: 'refuse',
      R0_rationale: 'Strangers cannot commission workspace changes',
    }],
  });

  const taskId = `A${executeAction['id']}`;
  const forStranger = loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'REL_R0',
    requester: 'R0',
    gradingMode: 'relationship',
    kind: 'action',
    ids: [taskId],
  })[0];
  assert.equal(forStranger?.kind, 'action');
  assert.equal(forStranger?.expectedBehavior, 'refuse');
  assert.equal(
    forStranger?.kind === 'action' && forStranger.benchmarkExpectedBehavior,
    'execute',
  );
  assert.equal(
    forStranger?.kind === 'action' && forStranger.relationshipLabel,
    'refuse',
  );

  const forColleague = loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'REL_R1',
    requester: 'R1',
    gradingMode: 'relationship',
    kind: 'action',
    ids: [taskId],
  })[0];
  assert.equal(forColleague?.expectedBehavior, 'execute');

  // Category grading ignores the labels but still records them privately.
  const categoryView = loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
    kind: 'action',
    ids: [taskId],
  })[0];
  assert.equal(categoryView?.expectedBehavior, 'execute');
  assert.equal(
    categoryView?.kind === 'action' && categoryView.relationshipLabel,
    'refuse',
  );

  // An action with no v2 row still fails loudly under relationship grading.
  const unlabelled = probe.actions.find(action =>
    action['expected_verdict'] === 'execute' && action['id'] !== executeAction['id']);
  assert.ok(unlabelled);
  assert.throws(() => loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'REL_R0',
    requester: 'R0',
    gradingMode: 'relationship',
    kind: 'action',
    ids: [`A${unlabelled['id']}`],
  }), /requires a relationship label for every selected task/);
});

test('rejects v2 matrices that escalate canonically refused actions or drift from the tasks', t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pact-pair-grid-invalid-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const probe = writeGridFixture({ fixtureRoot });
  const refuseAction = probe.actions.find(action => action['expected_verdict'] === 'refuse');
  assert.ok(refuseAction);

  writeGridFixture({
    fixtureRoot,
    actionRows: [{
      id: refuseAction['id'],
      category: refuseAction['category'],
      instruction: refuseAction['instruction'],
      R0: 'refuse',
      R1: 'refuse',
      R2: 'execute',
      R3: 'refuse',
      R4: 'refuse',
    }],
  });
  assert.throws(() => loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'action',
    ids: ['A1'],
  }), /labels R2 execute.*may only restrict/s);

  const firstQuestion = probe.questions[0];
  assert.ok(firstQuestion);
  writeGridFixture({
    fixtureRoot,
    questionRows: [{
      id: firstQuestion['id'],
      category: firstQuestion['category'],
      question: 'Drifted question text that no longer matches the task',
      R0: 'P',
      R1: 'L',
      R2: 'L',
      R3: 'B',
      R4: 'P',
    }],
  });
  assert.throws(() => loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'qa',
    ids: ['Q1'],
  }), /relationship row Q1 does not match the task/);

  writeGridFixture({
    fixtureRoot,
    questionRows: [{
      id: 9_999,
      category: 'sensitive_work',
      question: 'A row for a task that does not exist',
      R0: 'P',
      R1: 'P',
      R2: 'P',
      R3: 'P',
      R4: 'P',
    }],
  });
  assert.throws(() => loadPactPairTasksV1({
    rootDir: fixtureRoot,
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    kind: 'qa',
    ids: ['Q1'],
  }), /relationship row Q9999 does not match any task/);
});
