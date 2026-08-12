import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { parsePactManifestYamlV1 } from './protocol/v1/index.js';
import {
  parseDatasetManifestYamlV1,
  type DatasetManifestV1,
} from './datasets/index.js';
import {
  dataStoreSchema,
  pairBenchmarkSchema,
  pairRelationshipLabelMatrixSchema,
  pairRelationshipLabelMatrixV2Schema,
  type PairDataStore,
  type PairBenchmark,
  type PairRelationshipLabelMatrix,
  type PairRelationshipLabelMatrixV2,
} from './schemas.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

type Suite = 'all' | 'pair';

function parseArgs(): Suite {
  const idx = process.argv.indexOf('--suite');
  if (idx === -1) return 'all';
  const value = process.argv[idx + 1];
  if (value === 'pair' || value === 'all') return value;
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
  assertUnique(
    matrix.questions.map(row => String(row.id)),
    'PACT-Pair v2 relationship QA label ids',
  );
  assertUnique(
    matrix.actions.map(row => String(row.id)),
    'PACT-Pair v2 relationship action label ids',
  );

  const questions = new Map(data.questions.map(question => [question.id, question]));
  for (const row of matrix.questions) {
    const question = questions.get(row.id);
    if (!question || question.category !== row.category || question.question !== row.question) {
      throw new Error(`PACT-Pair v2 relationship label Q${row.id}: task text or category mismatch`);
    }
  }

  const actions = new Map(data.actions.map(action => [action.id, action]));
  const requesters = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
  for (const row of matrix.actions) {
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
}

function validatePair(): void {
  const datasetRoot = 'dataset/pact-pair';
  const manifest = parseDatasetManifestYamlV1(readText(`${datasetRoot}/manifest.yaml`));
  if (manifest.id !== 'pact-pair' || manifest.version !== '6.0.0') {
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

function validateDatasetCatalog(): Map<string, DatasetManifestV1> {
  const datasetDirectory = join(repoRoot, 'dataset');
  const manifests = new Map<string, DatasetManifestV1>();
  const entries = readdirSync(datasetDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const relativeRoot = `dataset/${entry.name}`;
    const manifestPath = `${relativeRoot}/manifest.yaml`;
    if (!existsSync(join(repoRoot, manifestPath))) {
      throw new Error(`Dataset directory ${entry.name} is missing manifest.yaml`);
    }
    const manifest = parseDatasetManifestYamlV1(readText(manifestPath));
    if (manifest.id !== entry.name) {
      throw new Error(
        `Dataset directory ${entry.name} contains manifest id ${manifest.id}`,
      );
    }
    const identity = `${manifest.id}@${manifest.version}`;
    if (manifests.has(identity)) throw new Error(`Duplicate dataset identity ${identity}`);
    for (const [name, asset] of Object.entries(manifest.assets)) {
      if (!existsSync(join(repoRoot, relativeRoot, asset))) {
        throw new Error(`Dataset ${identity} asset ${name} does not exist: ${asset}`);
      }
    }
    manifests.set(identity, manifest);
  }

  console.log(`Dataset catalog validation passed (${manifests.size} manifest${manifests.size === 1 ? '' : 's'})`);
  return manifests;
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

try {
  const suite = parseArgs();
  if (suite === 'all') {
    validateDatasetCatalog();
    validateProtocolExample();
  }
  if (suite === 'all' || suite === 'pair') validatePair();
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
