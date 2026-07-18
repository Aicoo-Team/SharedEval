import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  pactToolSpecV1Schema,
  type PactBoundaryPlanV1,
} from '../../src/protocol/v1/index.js';
import {
  createPactPairToolExecutorV1,
  executePactPairToolV1,
  PACT_PAIR_TOOL_SPECS_V1,
} from '../../src/runner/v1/tools.js';
import {
  clonePactPairWorkspaceSnapshotV1,
  createPactPairWorkspaceV1,
  loadCanonicalPactPairStoreV1,
} from '../../src/runner/v1/workspace.js';

const deniedAccess = {
  access: {
    notes: { read: { scope: 'none' }, write: false },
    todos: { read: false, write: false },
    memory: { read: 'none', write: false },
  },
} satisfies PactBoundaryPlanV1;

const readOnlyAccess = {
  access: {
    notes: { read: { scope: 'all' }, write: false },
    todos: { read: true, write: false },
    memory: { read: 'none', write: false },
  },
} satisfies PactBoundaryPlanV1;

const fullWorkspaceAccess = {
  access: {
    notes: { read: { scope: 'all' }, write: true },
    todos: { read: true, write: true },
    memory: { read: 'none', write: false },
  },
} satisfies PactBoundaryPlanV1;

test('starts every workspace from an isolated canonical deep clone', () => {
  const first = createPactPairWorkspaceV1();
  const second = createPactPairWorkspaceV1();
  const canonical = loadCanonicalPactPairStoreV1();

  first.createNote({
    folder: 'Shared',
    title: 'Isolation canary',
    content: 'Only the first task may observe this note.',
  });

  assert.equal(first.getNoteByTitle('Isolation canary').title, 'Isolation canary');
  assert.throws(() => second.getNoteByTitle('Isolation canary'), /was not found/);
  assert.equal(canonical.notes.some(note => note.title === 'Isolation canary'), false);

  canonical.notes[0]!.content = 'mutated caller clone';
  assert.notEqual(
    loadCanonicalPactPairStoreV1().notes[0]!.content,
    'mutated caller clone',
  );
});

test('snapshots are deep clones and can restore action state exactly', () => {
  const workspace = createPactPairWorkspaceV1(undefined, {
    now: () => '2026-07-18T00:00:00.000Z',
  });
  const before = workspace.snapshot();
  const externalClone = clonePactPairWorkspaceSnapshotV1(before);

  externalClone.notes[0]!.content = 'external mutation';
  assert.notEqual(workspace.snapshot().notes[0]!.content, 'external mutation');

  workspace.editNote({ title: 'Project Alpha Overview', content: 'Changed during action.' });
  workspace.completeTodo({ title: 'Submit Q1 board deck' });
  assert.notDeepEqual(workspace.snapshot(), before);

  workspace.restore(before);
  assert.deepEqual(workspace.snapshot(), before);
});

test('publishes nine protocol-valid runner-owned tool specifications', () => {
  assert.deepEqual(
    PACT_PAIR_TOOL_SPECS_V1.map(spec => spec.name),
    [
      'search_notes',
      'get_note',
      'create_note',
      'edit_note',
      'search_todos',
      'get_todo',
      'create_todo',
      'edit_todo',
      'complete_todo',
    ],
  );
  assert.equal(new Set(PACT_PAIR_TOOL_SPECS_V1.map(spec => spec.name)).size, 9);
  for (const spec of PACT_PAIR_TOOL_SPECS_V1) {
    assert.doesNotThrow(() => pactToolSpecV1Schema.parse(spec));
    assert.equal(spec.inputSchema.type, 'object');
    assert.equal(spec.inputSchema.additionalProperties, false);
  }
});

test('strictly validates tool arguments before touching workspace state', async () => {
  const workspace = createPactPairWorkspaceV1();
  const before = workspace.snapshot();

  const unknownField = await executePactPairToolV1({
    workspace,
    access: fullWorkspaceAccess,
    toolName: 'create_note',
    input: {
      folder: 'Shared',
      title: 'Should not exist',
      content: 'Rejected.',
      privateOverride: true,
    },
  });
  const emptyEdit = await executePactPairToolV1({
    workspace,
    access: fullWorkspaceAccess,
    toolName: 'edit_todo',
    input: { title: 'Submit Q1 board deck' },
  });
  const unknownTool = await executePactPairToolV1({
    workspace,
    access: fullWorkspaceAccess,
    toolName: 'drop_database',
    input: {},
  });

  assert.equal(unknownField.isError, true);
  assert.match(JSON.stringify(unknownField.output), /invalid_arguments/);
  assert.equal(emptyEdit.isError, true);
  assert.match(JSON.stringify(emptyEdit.output), /invalid_arguments/);
  assert.equal(unknownTool.isError, true);
  assert.match(JSON.stringify(unknownTool.output), /unknown_tool/);
  assert.deepEqual(workspace.snapshot(), before);
});

test('enforces note read scope, folder scope, write access, and system-memory separation', async () => {
  const workspace = createPactPairWorkspaceV1();
  const denied = createPactPairToolExecutorV1(workspace, deniedAccess);
  const sharedOnlyAccess = {
    access: {
      notes: { read: { scope: 'folders', folderIds: ['9'] }, write: true },
      todos: { read: false, write: false },
      memory: { read: 'none', write: false },
    },
  } satisfies PactBoundaryPlanV1;
  const sharedOnly = createPactPairToolExecutorV1(workspace, sharedOnlyAccess);

  assert.equal((await denied('search_notes', { query: 'Project Alpha' })).isError, true);
  assert.equal((await sharedOnly('get_note', { title: 'Project Alpha Overview' })).isError, true);

  const shared = await sharedOnly('get_note', { title: 'Public Bio' });
  assert.equal(shared.isError, false);
  assert.match(JSON.stringify(shared.output), /Public Bio/);

  const hiddenSearch = await sharedOnly('search_notes', { query: 'Project Alpha' });
  assert.equal(hiddenSearch.isError, false);
  assert.deepEqual((hiddenSearch.output as { matches: unknown[] }).matches, []);

  const created = await sharedOnly('create_note', {
    folder: 'Shared',
    title: 'Runner-created note',
    content: 'A permitted mutation.',
  });
  assert.equal(created.isError, false);
  const hiddenFolder = await sharedOnly('create_note', {
    folder: 'Projects',
    title: 'Out-of-scope note',
    content: 'Must be rejected.',
  });
  const absentFolder = await sharedOnly('create_note', {
    folder: 'Does not exist',
    title: 'Out-of-scope note',
    content: 'Must be rejected.',
  });
  assert.deepEqual(hiddenFolder, absentFolder);

  const readOnly = createPactPairToolExecutorV1(workspace, readOnlyAccess);
  assert.equal((await readOnly('edit_note', {
    title: 'Public Bio',
    content: 'Unauthorized replacement.',
  })).isError, true);

  const allNotes = createPactPairToolExecutorV1(workspace, fullWorkspaceAccess);
  const memorySearch = await allNotes('search_notes', { query: 'Agent Memory' });
  const visibleMatches = (
    memorySearch.output as { matches: Array<{ title: string }> }
  ).matches;
  assert.equal(visibleMatches.some(note => note.title === 'MEMORY.md'), false);
  const hiddenMemory = await allNotes('get_note', { title: 'MEMORY.md' });
  const absentMemory = await allNotes('get_note', { title: 'DOES-NOT-EXIST.md' });
  assert.deepEqual(hiddenMemory, absentMemory);

  const shadowedSystemTitle = await sharedOnly('create_note', {
    folder: 'Shared',
    title: 'MEMORY.md',
    content: 'A separate visible note with the same opaque title.',
  });
  assert.equal(shadowedSystemTitle.isError, false);
  assert.match(
    JSON.stringify(await sharedOnly('get_note', { title: 'MEMORY.md' })),
    /separate visible note/i,
  );
});

test('executes permitted note create and edit operations', async () => {
  const workspace = createPactPairWorkspaceV1();
  const execute = createPactPairToolExecutorV1(workspace, fullWorkspaceAccess);

  const created = await execute('create_note', {
    folder: 'Projects',
    title: 'New CI Plan',
    content: 'GitHub Actions with lint and type-check stages.',
  });
  assert.equal(created.isError, false);
  assert.equal(workspace.getNoteByTitle('New CI Plan').folderId, 2);

  const edited = await execute('edit_note', {
    title: 'New CI Plan',
    content: 'GitHub Actions with lint, type-check, and E2E stages.',
  });
  assert.equal(edited.isError, false);
  assert.match(workspace.getNoteByTitle('New CI Plan').content, /E2E/);
});

test('ranks natural-language searches by meaningful token overlap', async () => {
  const workspace = createPactPairWorkspaceV1();
  const execute = createPactPairToolExecutorV1(workspace, readOnlyAccess);

  const notes = await execute('search_notes', {
    query: 'What is the launch date for Project Alpha?',
    limit: 3,
  });
  assert.equal(notes.isError, false);
  const noteMatches = (notes.output as { matches: Array<{ title: string }> }).matches;
  assert.equal(noteMatches[0]?.title, 'Project Alpha Overview');

  const todos = await execute('search_todos', {
    query: 'When is the board deck due?',
    limit: 3,
  });
  assert.equal(todos.isError, false);
  const todoMatches = (todos.output as { matches: Array<{ title: string }> }).matches;
  assert.equal(todoMatches[0]?.title, 'Submit Q1 board deck');
});

test('retrieves every canonical QA source from the public question in the top ten', () => {
  const benchmark = JSON.parse(readFileSync(
    new URL('../../pact_pair/tasks/questions.json', import.meta.url),
    'utf8',
  )) as {
    questions: Array<{
      id: number;
      question: string;
      source_notes?: string[];
      source_todos?: string[];
    }>;
  };
  const workspace = createPactPairWorkspaceV1();

  for (const question of benchmark.questions) {
    const noteTitles = workspace.searchNotes(question.question)
      .slice(0, 10)
      .map(note => note.title);
    for (const source of question.source_notes ?? []) {
      assert.ok(
        noteTitles.includes(source),
        `Q${question.id} note source ${source} was not retrievable`,
      );
    }

    const todoTitles = workspace.searchTodos(question.question)
      .slice(0, 10)
      .map(todo => todo.title);
    for (const source of question.source_todos ?? []) {
      assert.ok(
        todoTitles.includes(source),
        `Q${question.id} todo source ${source} was not retrievable`,
      );
    }
  }
});

test('enforces todo read and write permissions', async () => {
  const workspace = createPactPairWorkspaceV1();
  const denied = createPactPairToolExecutorV1(workspace, deniedAccess);
  const readOnly = createPactPairToolExecutorV1(workspace, readOnlyAccess);

  assert.equal((await denied('get_todo', { title: 'Submit Q1 board deck' })).isError, true);
  assert.equal(
    (await readOnly('get_todo', { title: 'Submit Q1 board deck' })).isError,
    false,
  );
  assert.equal((await readOnly('complete_todo', {
    title: 'Submit Q1 board deck',
  })).isError, true);
  assert.equal(workspace.getTodoByTitle('Submit Q1 board deck').completed, false);
});

test('executes todo create, edit, and complete with valid datastore shapes', async () => {
  const workspace = createPactPairWorkspaceV1(undefined, {
    now: () => '2026-07-18T12:34:56.000Z',
  });
  const execute = createPactPairToolExecutorV1(workspace, fullWorkspaceAccess);

  const created = await execute('create_todo', {
    folder: 'Work',
    title: 'Send weekly update',
    description: 'Send the team update by Friday.',
    priority: 2,
  });
  assert.equal(created.isError, false);
  assert.equal(workspace.getTodoByTitle('Send weekly update').completed, false);

  const edited = await execute('edit_todo', {
    title: 'Send weekly update',
    description: 'Send the team update and include the launch metrics.',
    dueDate: '2026-07-24',
  });
  assert.equal(edited.isError, false);
  const editedTodo = workspace.getTodoByTitle('Send weekly update');
  assert.match(editedTodo.description, /launch metrics/);
  assert.equal(editedTodo.completed ? undefined : editedTodo.dueDate, '2026-07-24');

  const completed = await execute('complete_todo', { title: 'Send weekly update' });
  assert.equal(completed.isError, false);
  const completedTodo = workspace.getTodoByTitle('Send weekly update');
  assert.equal(completedTodo.completed, true);
  assert.equal(
    completedTodo.completed ? completedTodo.completedAt : undefined,
    '2026-07-18T12:34:56.000Z',
  );

  assert.doesNotThrow(() => JSON.stringify(workspace.snapshot()));
});
