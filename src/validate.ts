import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  parseDatasetManifestYamlV1,
} from './datasets/index.js';
import { validateDatasetCatalogV1 } from './datasets/validate-catalog.js';
import {
  dataStoreSchema,
  pairBenchmarkSchema,
  pairRelationshipLabelMatrixSchema,
  pairRelationshipLabelMatrixV2Schema,
  type PairDataStore,
  type PairBenchmark,
  type PairRelationshipLabelMatrix,
  type PairRelationshipLabelMatrixV2,
} from './suites/pact-pair/schemas.js';
import {
  loadPactNetAgentStoresV1,
  pactNetBenchmarkV1Schema,
  pactNetContactGraphV1Schema,
  pactNetRelationalMatrixV1Schema,
  routingAllowsPactNetMessageV1,
  type PactNetAgentStoreV1,
  type PactNetBenchmarkV1,
  type PactNetContactGraphV1,
  type PactNetRelationalMatrixV1,
} from './suites/pact-net/index.js';

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

function readText(pathFromRoot: string): string {
  return readFileSync(join(repoRoot, pathFromRoot), 'utf8');
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

function validatePairRelationshipLabels(
  data: PairBenchmark,
  matrix: PairRelationshipLabelMatrix,
): void {
  assertEqual(matrix.labels.length, 99, 'PACT-Pair relationship label count');
  assertUnique(matrix.labels.map(row => String(row.id)), 'PACT-Pair relationship label ids');

  const questions = new Map(data.questions.map(question => [question.id, question]));
  const expectedIds = new Set(
    data.questions
      .filter(question => question.id >= 101 && question.id <= 200 && question.id !== 125)
      .map(question => question.id),
  );
  assertEqual(expectedIds.size, 99, 'PACT-Pair relationship label target count');

  for (const row of matrix.labels) {
    if (!expectedIds.delete(row.id)) {
      throw new Error(`PACT-Pair relationship labels: unexpected question id ${row.id}`);
    }
    const question = questions.get(row.id);
    if (!question || question.category !== row.category || question.question !== row.question) {
      throw new Error(`PACT-Pair relationship label Q${row.id}: task text or category mismatch`);
    }
  }
  if (expectedIds.size > 0) {
    throw new Error(
      `PACT-Pair relationship labels: missing question ids ${Array.from(expectedIds).join(', ')}`,
    );
  }
}

/**
 * The optional schema-v2 label matrix (full 600×5 grid, produced
 * incrementally by the annotation workstream) is validated whenever the file
 * exists: ids must name real tasks with matching text, and action rows may
 * only label a requester `execute` when the canonical verdict is `execute` —
 * a canonically-refused action has no executable gold contract.
 */
function validatePairRelationshipLabelsV2(
  data: PairBenchmark,
  matrix: PairRelationshipLabelMatrixV2,
): void {
  assertEqual(
    matrix.questions.length,
    data.questions.length,
    'PACT-Pair v2 relationship QA label count',
  );
  assertEqual(
    matrix.actions.length,
    data.actions.length,
    'PACT-Pair v2 relationship action label count',
  );
  assertUnique(
    matrix.questions.map(row => String(row.id)),
    'PACT-Pair v2 relationship QA label ids',
  );
  assertUnique(
    matrix.actions.map(row => String(row.id)),
    'PACT-Pair v2 relationship action label ids',
  );

  const questions = new Map(data.questions.map(question => [question.id, question]));
  const expectedQuestionIds = new Set(questions.keys());
  for (const row of matrix.questions) {
    if (!expectedQuestionIds.delete(row.id)) {
      throw new Error(`PACT-Pair v2 relationship labels: unexpected question id ${row.id}`);
    }
    const question = questions.get(row.id);
    if (!question || question.category !== row.category || question.question !== row.question) {
      throw new Error(`PACT-Pair v2 relationship label Q${row.id}: task text or category mismatch`);
    }
  }
  if (expectedQuestionIds.size > 0) {
    throw new Error(
      `PACT-Pair v2 relationship labels: missing question ids ${
        Array.from(expectedQuestionIds).slice(0, 10).join(', ')
      }`,
    );
  }

  const actions = new Map(data.actions.map(action => [action.id, action]));
  const expectedActionIds = new Set(actions.keys());
  const requesters = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
  for (const row of matrix.actions) {
    if (!expectedActionIds.delete(row.id)) {
      throw new Error(`PACT-Pair v2 relationship labels: unexpected action id ${row.id}`);
    }
    const action = actions.get(row.id);
    if (!action || action.category !== row.category || action.instruction !== row.instruction) {
      throw new Error(`PACT-Pair v2 relationship label A${row.id}: task text or category mismatch`);
    }
    if (action.expected_verdict === 'refuse') {
      for (const requester of requesters) {
        if (row[requester] === 'execute') {
          throw new Error(
            `PACT-Pair v2 relationship label A${row.id}: ${requester} labelled execute `
            + 'on a canonically refuse-expected action',
          );
        }
      }
    }
  }
  if (expectedActionIds.size > 0) {
    throw new Error(
      `PACT-Pair v2 relationship labels: missing action ids ${
        Array.from(expectedActionIds).slice(0, 10).join(', ')
      }`,
    );
  }
}

function validatePair(): void {
  const datasetRoot = 'dataset/pact-pair';
  const manifest = parseDatasetManifestYamlV1(readText(`${datasetRoot}/manifest.yaml`));
  if (manifest.id !== 'pact-pair' || manifest.version !== '7.0.0') {
    throw new Error(`PACT-Pair manifest identity is unexpected: ${manifest.id}@${manifest.version}`);
  }
  for (const [name, asset] of Object.entries(manifest.assets)) {
    if (!existsSync(join(repoRoot, datasetRoot, asset))) {
      throw new Error(`PACT-Pair manifest asset ${name} does not exist: ${asset}`);
    }
  }

  const data = pairBenchmarkSchema.parse(readJson(`${datasetRoot}/${manifest.assets.tasks}`));
  const store = dataStoreSchema.parse(readJson(`${datasetRoot}/${manifest.assets.workspace}`));
  const relationshipLabels = pairRelationshipLabelMatrixSchema.parse(
    readJson(`${datasetRoot}/${manifest.assets.relationships}`),
  );

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
  validatePairRelationshipLabels(data, relationshipLabels);

  const v2LabelsPath = `${datasetRoot}/relationship_labels/relationship_label_matrix_v2.json`;
  if (existsSync(join(repoRoot, v2LabelsPath))) {
    const v2Labels = pairRelationshipLabelMatrixV2Schema.parse(readJson(v2LabelsPath));
    validatePairRelationshipLabelsV2(data, v2Labels);
  }

  console.log(formatPairSummary(data));
}

const NET_QA_CATEGORY_COUNTS: Record<string, number> = {
  should_answer: 172,
  should_refuse: 139,
  transitive_risk: 94,
  non_contact_probe: 50,
  cross_cluster: 28,
};

const NET_ACTION_CATEGORY_COUNTS: Record<string, number> = {
  authorized_create: 184,
  authorized_complete: 115,
  unauthorized_mutation: 115,
  confused_deputy: 50,
  cross_surface_plant: 50,
};

function validateNet(): void {
  const datasetRoot = 'dataset/pact-net';
  const manifest = parseDatasetManifestYamlV1(readText(`${datasetRoot}/manifest.yaml`));
  if (manifest.id !== 'pact-net' || manifest.version !== '1.0.0') {
    throw new Error(`PACT-Net manifest identity is unexpected: ${manifest.id}@${manifest.version}`);
  }
  for (const [name, asset] of Object.entries(manifest.assets)) {
    if (!existsSync(join(repoRoot, datasetRoot, asset))) {
      throw new Error(`PACT-Net manifest asset ${name} does not exist: ${asset}`);
    }
  }

  const data = pactNetBenchmarkV1Schema.parse(
    readJson(`${datasetRoot}/${manifest.assets.tasks}`),
  );
  const graph = pactNetContactGraphV1Schema.parse(
    readJson(`${datasetRoot}/${manifest.assets.contact_graph}`),
  );
  const matrix = pactNetRelationalMatrixV1Schema.parse(
    readJson(`${datasetRoot}/${manifest.assets.relationships}`),
  );
  // Loads every per-agent store, including the alex_chen projection from the
  // PACT-Pair workspace, so the mapping is exercised on every validation run.
  const stores = loadPactNetAgentStoresV1({ rootDir: repoRoot });

  assertEqual(data.questions.length, 483, 'PACT-Net QA count');
  assertEqual(data.actions.length, 514, 'PACT-Net action count');
  assertUnique(data.questions.map(question => question.id), 'PACT-Net QA ids');
  assertUnique(data.actions.map(action => action.id), 'PACT-Net action ids');

  const qaCounts = new Map<string, number>();
  for (const question of data.questions) {
    qaCounts.set(question.category, (qaCounts.get(question.category) ?? 0) + 1);
  }
  for (const [category, expected] of Object.entries(NET_QA_CATEGORY_COUNTS)) {
    assertEqual(qaCounts.get(category) ?? 0, expected, `PACT-Net QA ${category}`);
  }
  const actionCounts = new Map<string, number>();
  for (const action of data.actions) {
    actionCounts.set(action.category, (actionCounts.get(action.category) ?? 0) + 1);
  }
  for (const [category, expected] of Object.entries(NET_ACTION_CATEGORY_COUNTS)) {
    assertEqual(actionCounts.get(category) ?? 0, expected, `PACT-Net action ${category}`);
  }

  validateNetWorld(graph, stores);
  validateNetTasks(data, graph, stores);
  validateNetMatrix(matrix, graph);

  console.log([
    'PACT-Net validation passed',
    `  QA tasks: ${data.questions.length}`,
    `  Action tasks: ${data.actions.length}`,
    `  Agents: ${Object.keys(graph.agents).length}`,
  ].join('\n'));
}

function validateNetWorld(
  graph: PactNetContactGraphV1,
  stores: Map<string, PactNetAgentStoreV1>,
): void {
  const agents = Object.keys(graph.agents);
  assertEqual(agents.length, 25, 'PACT-Net agent count');
  for (const agent of agents) {
    if (!graph.contacts[agent]) {
      throw new Error(`PACT-Net agent ${agent} has no contact list`);
    }
    if (!stores.has(agent)) {
      throw new Error(`PACT-Net agent ${agent} has no seed store`);
    }
    for (const file of ['USER.md', 'COO.md', 'POLICY.md']) {
      if (!existsSync(join(repoRoot, 'dataset/pact-net/agent_configs', agent, file))) {
        throw new Error(`PACT-Net agent ${agent} is missing ${file}`);
      }
    }
  }
}

function validateNetTasks(
  data: PactNetBenchmarkV1,
  graph: PactNetContactGraphV1,
  stores: Map<string, PactNetAgentStoreV1>,
): void {
  const agents = new Set(Object.keys(graph.agents));
  for (const question of data.questions) {
    assertKnown(question.source_agent, agents, `PACT-Net ${question.id} source_agent`);
    assertKnown(question.target_agent, agents, `PACT-Net ${question.id} target_agent`);
    for (const requester of Object.keys(question.relational_labels)) {
      assertKnown(requester, agents, `PACT-Net ${question.id} relational_labels`);
    }
    const routingAllowed = routingAllowsPactNetMessageV1(
      graph,
      question.source_agent,
      question.target_agent,
    );
    if ((question.category === 'non_contact_probe') === routingAllowed) {
      throw new Error(
        `PACT-Net ${question.id} (${question.category}) conflicts with the contact graph`,
      );
    }
    const store = stores.get(question.target_agent);
    if (!store) throw new Error(`PACT-Net ${question.id}: missing target store`);
    const titles = question.surface === 'notes'
      ? new Set(store.notes.map(note => note.title))
      : new Set(store.todos.map(todo => todo.title));
    for (const title of question.source_notes ?? question.source_todos ?? []) {
      assertKnown(title, titles, `PACT-Net ${question.id} source ${question.surface}`);
    }
  }
  for (const action of data.actions) {
    assertKnown(action.source_agent, agents, `PACT-Net ${action.id} source_agent`);
    assertKnown(action.target_agent, agents, `PACT-Net ${action.id} target_agent`);
    for (const requester of Object.keys(action.relational_labels)) {
      assertKnown(requester, agents, `PACT-Net ${action.id} relational_labels`);
    }
    if (!routingAllowsPactNetMessageV1(graph, action.source_agent, action.target_agent)) {
      throw new Error(`PACT-Net ${action.id} is not deliverable through the contact graph`);
    }
    if (action.gold_check.type === 'todo_completed') {
      const goldTitle = action.gold_check.title;
      const store = stores.get(action.target_agent);
      if (!store) throw new Error(`PACT-Net ${action.id}: missing target store`);
      const todo = store.todos.find(candidate => candidate.title === goldTitle);
      if (!todo) {
        throw new Error(`PACT-Net ${action.id}: gold todo does not exist in the target store`);
      }
      if (todo.completed) {
        throw new Error(`PACT-Net ${action.id}: gold todo is already completed`);
      }
    }
  }
}

function validateNetMatrix(
  matrix: PactNetRelationalMatrixV1,
  graph: PactNetContactGraphV1,
): void {
  const agents = new Set(Object.keys(graph.agents));
  assertEqual(Object.keys(matrix.agents).length, 25, 'PACT-Net matrix owner count');
  let pairs = 0;
  let labels = 0;
  for (const [owner, entry] of Object.entries(matrix.agents)) {
    assertKnown(owner, agents, 'PACT-Net matrix owner');
    for (const requester of Object.keys(entry.requesters)) {
      assertKnown(requester, agents, `PACT-Net matrix ${owner} requester`);
      if (requester === owner) {
        throw new Error(`PACT-Net matrix ${owner} labels itself as a requester`);
      }
      pairs += 1;
      labels += 5;
    }
  }
  assertEqual(pairs, 115, 'PACT-Net matrix (owner, requester) pairs');
  assertEqual(labels, 575, 'PACT-Net matrix label count');
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

try {
  const suite = parseArgs();
  if (suite === 'all') {
    validateDatasetCatalogV1({ repoRoot });
  }
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
