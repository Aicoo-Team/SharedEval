import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { parsePactManifestYamlV1 } from './protocol/v1/index.js';
import {
  dataStoreSchema,
  netDataStoreSchema,
  netBenchmarkSchema,
  pairBenchmarkSchema,
  relationshipLabelSchema,
  type NetBenchmark,
  type NetDataStore,
  type PairDataStore,
  type PairBenchmark,
} from './schemas.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type Suite = 'all' | 'pair' | 'net';

function parseArgs(): Suite {
  const idx = process.argv.indexOf('--suite');
  if (idx === -1) return 'all';
  const value = process.argv[idx + 1];
  if (value === 'pair' || value === 'net' || value === 'all') return value;
  throw new Error(`Invalid --suite value: ${value ?? '<missing>'}`);
}

function readJson(pathFromRoot: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, pathFromRoot), 'utf8'));
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(`${label}: duplicate ids ${Array.from(duplicates).slice(0, 10).join(', ')}`);
  }
}

function assertExactIntegerRange(
  values: number[],
  start: number,
  end: number,
  label: string,
): void {
  const actual = new Set(values);
  const missing: number[] = [];
  const unexpected: number[] = [];
  for (let expected = start; expected <= end; expected++) {
    if (!actual.has(expected)) missing.push(expected);
  }
  for (const value of actual) {
    if (value < start || value > end) unexpected.push(value);
  }
  if (actual.size !== end - start + 1 || missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label}: expected ${start}..${end}; missing ${missing.slice(0, 10).join(', ') || 'none'}; `
      + `unexpected ${unexpected.slice(0, 10).join(', ') || 'none'}`,
    );
  }
}

function assertKnown(value: string, allowed: Set<string>, label: string): void {
  if (!allowed.has(value)) throw new Error(`${label}: unknown value ${value}`);
}

function assertReferences(values: string[], allowed: Set<string>, label: string): void {
  for (const value of values) assertKnown(value, allowed, label);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value;
}

function validatePairStore(store: PairDataStore): void {
  assertUnique(store.note_folders.map(folder => String(folder.id)), 'PACT-Pair note folder ids');
  assertUnique(store.note_folders.map(folder => folder.name), 'PACT-Pair note folder names');
  assertUnique(store.todo_folders.map(folder => String(folder.id)), 'PACT-Pair todo folder ids');
  assertUnique(store.todo_folders.map(folder => folder.name), 'PACT-Pair todo folder names');
  assertUnique(store.notes.map(note => String(note.id)), 'PACT-Pair note ids');
  assertUnique(store.notes.map(note => note.title), 'PACT-Pair note titles');
  assertUnique(store.todos.map(todo => String(todo.id)), 'PACT-Pair todo ids');
  assertUnique(store.todos.map(todo => todo.title), 'PACT-Pair todo titles');

  const noteFolderIds = new Set(store.note_folders.map(folder => folder.id));
  const todoFolderIds = new Set(store.todo_folders.map(folder => folder.id));
  for (const folder of store.note_folders) {
    if (folder.parentId !== null) {
      if (folder.parentId === folder.id) {
        throw new Error(`PACT-Pair note folder ${folder.id} cannot be its own parent`);
      }
      if (!noteFolderIds.has(folder.parentId)) {
        throw new Error(`PACT-Pair note folder ${folder.id}: unknown parent ${folder.parentId}`);
      }
    }
  }
  for (const note of store.notes) {
    if (!noteFolderIds.has(note.folderId)) {
      throw new Error(`PACT-Pair note ${note.id}: unknown folder ${note.folderId}`);
    }
  }
  for (const todo of store.todos) {
    if (!todoFolderIds.has(todo.folderId)) {
      throw new Error(`PACT-Pair todo ${todo.id}: unknown folder ${todo.folderId}`);
    }
  }
}

function validatePairReferences(data: PairBenchmark, store: PairDataStore): void {
  const noteTitles = new Set(store.notes.map(note => note.title));
  const todoTitles = new Set(store.todos.map(todo => todo.title));
  const noteFolders = new Set(store.note_folders.map(folder => folder.name));
  const todoFolders = new Set(store.todo_folders.map(folder => folder.name));

  for (const question of data.questions) {
    if (question.id <= 200) {
      if (!question.source_notes?.length || question.source_todos !== undefined) {
        throw new Error(`PACT-Pair Q${question.id}: Notes QA requires source_notes only`);
      }
      assertReferences(question.source_notes, noteTitles, `PACT-Pair Q${question.id} source_notes`);
    } else {
      if (!question.source_todos?.length || question.source_notes !== undefined) {
        throw new Error(`PACT-Pair Q${question.id}: Todo QA requires source_todos only`);
      }
      assertReferences(question.source_todos, todoTitles, `PACT-Pair Q${question.id} source_todos`);
    }
  }

  for (const action of data.actions) {
    const titles = action.surface === 'notes' ? noteTitles : todoTitles;
    const folders = action.surface === 'notes' ? noteFolders : todoFolders;
    assertKnown(action.target_folder, folders, `PACT-Pair A${action.id} target_folder`);
    if (action.target_item) {
      assertKnown(action.target_item, titles, `PACT-Pair A${action.id} target_item`);
    }
  }
}

function validatePair(): void {
  const data = pairBenchmarkSchema.parse(readJson('pact_pair/tasks/questions.json'));
  const store = dataStoreSchema.parse(readJson('pact_pair/data_spec/alex_data_store.json'));

  assertEqual(data.total, 600, 'PACT-Pair total metadata');
  assertEqual(data.questions.length, 400, 'PACT-Pair QA count');
  assertEqual(data.actions.length, 200, 'PACT-Pair action count');
  assertEqual(data.questions.length + data.actions.length, data.total, 'PACT-Pair total');
  assertUnique(data.questions.map((q) => `Q${q.id}`), 'PACT-Pair QA ids');
  assertUnique(data.actions.map((a) => `A${a.id}`), 'PACT-Pair action ids');
  assertExactIntegerRange(data.actions.map(action => action.id), 1, 200, 'PACT-Pair action ids');

  const notesQa = data.questions.filter((q) => q.id >= 1 && q.id <= 200);
  const todoQa = data.questions.filter((q) => q.id >= 201 && q.id <= 400);
  assertEqual(notesQa.length, 200, 'PACT-Pair notes QA range');
  assertEqual(todoQa.length, 200, 'PACT-Pair todo QA range');

  const executable = data.actions.filter((a) => a.expected_verdict === 'execute');
  const refusals = data.actions.filter((a) => a.expected_verdict === 'refuse');
  assertEqual(executable.length, 100, 'PACT-Pair executable actions');
  assertEqual(refusals.length, 100, 'PACT-Pair refusal actions');

  validatePairStore(store);
  validatePairReferences(data, store);

  console.log(formatPairSummary(data));
}

function validateNet(): void {
  const data = netBenchmarkSchema.parse(readJson('pact_net/pact_net_tasks.json'));
  const accessMatrix = asRecord(
    readJson('pact_net/world_design/relational_access_matrix.json'),
    'PACT-Net relational access matrix',
  );
  const contactGraph = asRecord(
    readJson('pact_net/world_design/contact_graph.json'),
    'PACT-Net contact graph',
  );

  assertEqual(data.questions.length, 483, 'PACT-Net QA count');
  assertEqual(data.actions.length, 514, 'PACT-Net action count');
  assertEqual(data.questions.length + data.actions.length, 997, 'PACT-Net total');
  assertUnique(data.questions.map((q) => q.id), 'PACT-Net QA ids');
  assertUnique(data.actions.map((a) => a.id), 'PACT-Net action ids');

  const accessAgents = asRecord(accessMatrix.agents, 'PACT-Net access matrix agents');
  const graphAgents = asRecord(contactGraph.agents, 'PACT-Net contact graph agents');
  const contacts = asRecord(contactGraph.contacts, 'PACT-Net contact graph contacts');
  const agentIds = new Set(Object.keys(graphAgents));

  if (Object.keys(accessAgents).length !== 25 || agentIds.size !== 25) {
    throw new Error('PACT-Net relational access matrix must contain 25 agents');
  }
  assertReferences(Object.keys(accessAgents), agentIds, 'PACT-Net access matrix owner');
  assertReferences(Object.keys(contacts), agentIds, 'PACT-Net contact graph owner');
  if (Object.keys(accessAgents).length !== agentIds.size || Object.keys(contacts).length !== agentIds.size) {
    throw new Error('PACT-Net world files must describe the same 25 agents');
  }

  const contactSets = new Map<string, Set<string>>();
  for (const agentId of agentIds) {
    const agentContacts = asStringArray(contacts[agentId], `PACT-Net contacts for ${agentId}`);
    assertUnique(agentContacts, `PACT-Net contacts for ${agentId}`);
    assertReferences(agentContacts, agentIds, `PACT-Net contacts for ${agentId}`);
    if (agentContacts.includes(agentId)) {
      throw new Error(`PACT-Net contacts for ${agentId}: self-contact is not allowed`);
    }
    contactSets.set(agentId, new Set(agentContacts));

    const accessAgent = asRecord(accessAgents[agentId], `PACT-Net access matrix agent ${agentId}`);
    const requesters = asRecord(
      accessAgent.requesters,
      `PACT-Net access matrix requesters for ${agentId}`,
    );
    assertReferences(Object.keys(requesters), agentIds, `PACT-Net requester for ${agentId}`);
    for (const [requester, rawAccess] of Object.entries(requesters)) {
      const requesterAccess = asRecord(rawAccess, `PACT-Net access ${requester} -> ${agentId}`);
      for (const category of [
        'work_public',
        'sensitive_work',
        'personal_finance',
        'personal_health',
        'personal_relationships',
      ]) {
        relationshipLabelSchema.exclude(['BLOCKED']).parse(requesterAccess[category]);
      }
    }
  }

  type StoreTitles = { notes: Set<string>; todos: Set<string> };
  const stores = new Map<string, StoreTitles>();
  const alexStore = dataStoreSchema.parse(readJson('pact_pair/data_spec/alex_data_store.json'));
  validatePairStore(alexStore);
  stores.set('alex_chen', {
    notes: new Set(alexStore.notes.map(note => note.title)),
    todos: new Set(alexStore.todos.map(todo => todo.title)),
  });
  for (const agentId of agentIds) {
    if (agentId === 'alex_chen') continue;
    const store: NetDataStore = netDataStoreSchema.parse(
      readJson(`pact_net/agent_configs/${agentId}/data.json`),
    );
    if (store.agent !== agentId) {
      throw new Error(`PACT-Net data store ${agentId}: agent field is ${store.agent}`);
    }
    assertUnique(store.notes.map(note => note.title), `PACT-Net ${agentId} note titles`);
    assertUnique(store.todos.map(todo => todo.title), `PACT-Net ${agentId} todo titles`);
    stores.set(agentId, {
      notes: new Set(store.notes.map(note => note.title)),
      todos: new Set(store.todos.map(todo => todo.title)),
    });
  }

  function validateTaskWorldReferences(
    task: NetBenchmark['questions'][number] | NetBenchmark['actions'][number],
  ): void {
    assertKnown(task.source_agent, agentIds, `${task.id} source_agent`);
    assertKnown(task.target_agent, agentIds, `${task.id} target_agent`);
    if (!(task.source_agent in task.relational_labels)) {
      throw new Error(`${task.id}: relational_labels must include source_agent`);
    }

    const targetAccessAgent = asRecord(
      accessAgents[task.target_agent],
      `${task.id} access matrix target`,
    );
    const targetRequesters = asRecord(
      targetAccessAgent.requesters,
      `${task.id} access matrix requesters`,
    );
    for (const [requester, relational] of Object.entries(task.relational_labels)) {
      assertKnown(requester, agentIds, `${task.id} relational requester`);
      const hasContact = contactSets.get(requester)?.has(task.target_agent) ?? false;
      if (relational.label === 'BLOCKED') {
        if (hasContact) {
          throw new Error(`${task.id}: BLOCKED requester ${requester} can contact ${task.target_agent}`);
        }
        continue;
      }
      if (!hasContact) {
        throw new Error(`${task.id}: requester ${requester} cannot contact ${task.target_agent}`);
      }
      const requesterAccess = asRecord(
        targetRequesters[requester],
        `${task.id} access matrix ${requester} -> ${task.target_agent}`,
      );
      if ('sensitivity' in task && requesterAccess[task.sensitivity] !== relational.label) {
        throw new Error(
          `${task.id}: label ${relational.label} conflicts with matrix label `
          + `${String(requesterAccess[task.sensitivity])} for ${requester}`,
        );
      }
    }
  }

  for (const question of data.questions) {
    validateTaskWorldReferences(question);
    const targetStore = stores.get(question.target_agent);
    if (!targetStore) throw new Error(`${question.id}: missing data store for ${question.target_agent}`);
    if (question.surface === 'notes') {
      if (!question.source_notes?.length || question.source_todos !== undefined) {
        throw new Error(`${question.id}: notes question requires source_notes only`);
      }
      assertReferences(question.source_notes, targetStore.notes, `${question.id} source_notes`);
    } else {
      if (!question.source_todos?.length || question.source_notes !== undefined) {
        throw new Error(`${question.id}: todos question requires source_todos only`);
      }
      assertReferences(question.source_todos, targetStore.todos, `${question.id} source_todos`);
    }
    for (const fact of question.sensitive_facts_in_scope ?? []) {
      assertKnown(fact.owner, agentIds, `${question.id} sensitive fact owner`);
    }
  }

  for (const action of data.actions) {
    validateTaskWorldReferences(action);
    for (const delegate of action.delegation_chain ?? []) {
      assertKnown(delegate, agentIds, `${action.id} delegation_chain`);
    }
    if (
      action.delegation_chain
      && action.delegation_chain.at(-1) !== action.source_agent
    ) {
      throw new Error(`${action.id}: delegation_chain must end with source_agent`);
    }
    for (const fact of action.planted_sensitive_facts ?? []) {
      assertKnown(fact.owner, agentIds, `${action.id} planted sensitive fact owner`);
    }
    if (action.gold_check.type === 'todo_completed') {
      const title = action.gold_check.target ?? action.gold_check.title;
      const targetStore = stores.get(action.target_agent);
      if (!targetStore || !title) throw new Error(`${action.id}: missing completion target`);
      assertKnown(title, targetStore.todos, `${action.id} completion target`);
    }
  }

  console.log(formatNetSummary(data));
}

function validateProtocolExample(): void {
  const source = readFileSync(
    join(repoRoot, 'examples/submissions/typescript-basic/pact.yaml'),
    'utf8',
  );
  const manifest = parsePactManifestYamlV1(source);
  console.log(`PACT protocol example passed (${manifest.id}@${manifest.version})`);
}

function formatPairSummary(data: PairBenchmark): string {
  const byCategory = new Map<string, number>();
  for (const question of data.questions) {
    byCategory.set(question.category, (byCategory.get(question.category) ?? 0) + 1);
  }
  return [
    'PACT-Pair validation passed',
    `  QA tasks: ${data.questions.length}`,
    `  Action tasks: ${data.actions.length}`,
    `  Categories: ${byCategory.size}`,
  ].join('\n');
}

function formatNetSummary(data: NetBenchmark): string {
  const byCategory = new Map<string, number>();
  for (const task of [...data.questions, ...data.actions]) {
    byCategory.set(task.category, (byCategory.get(task.category) ?? 0) + 1);
  }
  return [
    'PACT-Net validation passed',
    `  QA tasks: ${data.questions.length}`,
    `  Action tasks: ${data.actions.length}`,
    `  Categories: ${byCategory.size}`,
  ].join('\n');
}

try {
  const suite = parseArgs();
  if (suite === 'all') validateProtocolExample();
  if (suite === 'all' || suite === 'pair') validatePair();
  if (suite === 'all' || suite === 'net') validateNet();
} catch (error) {
  if (error instanceof ZodError) {
    console.error('Validation failed:');
    for (const issue of error.issues.slice(0, 20)) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
