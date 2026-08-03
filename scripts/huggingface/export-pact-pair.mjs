#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = 'scripts/huggingface/export-pact-pair.mjs';
const CONFIG_NAME = 'pair';
const SPLIT_NAME = 'validation';
const EXPECTED_QA_COUNT = 400;
const EXPECTED_ACTION_COUNT = 200;
const EXPECTED_ROW_COUNT = EXPECTED_QA_COUNT + EXPECTED_ACTION_COUNT;
const REQUESTER_IDS = ['R0', 'R1', 'R2', 'R3', 'R4'];
const POLICY_IDS = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5'];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const defaultInputRoot = path.join(repositoryRoot, 'dataset', 'pact-pair');

const usage = `Usage:
  node ${GENERATOR} --check [--input <dataset/pact-pair>]
  node ${GENERATOR} --output <staging-directory> [--input <dataset/pact-pair>] [--force]

Options:
  --check          Validate and summarize the export without writing files.
  --force          Replace an existing staging directory created by this exporter.
  --input <path>   PACT-Pair canonical asset root (default: dataset/pact-pair).
  --output <path>  New Hugging Face staging directory. Required unless --check is used.
  --help           Show this help text.
`;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a JSON object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a JSON array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireOptionalString(value, label) {
  if (value === null || value === undefined) return null;
  return requireString(value, label);
}

function requireStringArray(value, label) {
  return requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`));
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key];
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function parseArguments(argv) {
  const options = {
    check: false,
    force: false,
    help: false,
    input: defaultInputRoot,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--force') {
      options.force = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--input' || argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a path`);
      options[argument.slice(2)] = path.resolve(value);
      index += 1;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }

  if (!options.help && !options.check && !options.output) {
    fail('--output is required unless --check is used');
  }
  if (options.check && options.output) fail('--check and --output cannot be combined');
  if (options.check && options.force) fail('--check and --force cannot be combined');
  return options;
}

async function readJsonAsset(inputRoot, relativePath) {
  const absolutePath = path.join(inputRoot, relativePath);
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    fail(`Cannot read ${absolutePath}: ${error.message}`);
  }

  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${absolutePath}: ${error.message}`);
  }

  return { bytes, value };
}

function assertExactRange(items, start, end, label) {
  const ids = items.map((item, index) => {
    const object = requireObject(item, `${label}[${index}]`);
    return requireInteger(object.id, `${label}[${index}].id`);
  });
  const expected = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const sorted = [...ids].sort((left, right) => left - right);
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    fail(`${label} must contain every id from ${start} through ${end} exactly once`);
  }
}

function policyExpectationsByCategory(benchmark) {
  const result = new Map();
  const categories = requireArray(benchmark.categories, 'questions.json categories');
  for (const [index, rawCategory] of categories.entries()) {
    const category = requireObject(rawCategory, `questions.json categories[${index}]`);
    const id = requireString(category.id, `questions.json categories[${index}].id`);
    if (result.has(id)) fail(`Duplicate category metadata id: ${id}`);
    const expectations = {};
    for (const [policyIndex, policy] of POLICY_IDS.entries()) {
      const value = requireString(
        category[`expected_m${policyIndex}`],
        `category ${id} expected_m${policyIndex}`,
      );
      if (!['answer', 'refuse', 'maybe_refuse'].includes(value)) {
        fail(`Category ${id} has invalid expected_m${policyIndex}: ${value}`);
      }
      expectations[policy] = value;
    }
    result.set(id, expectations);
  }
  return result;
}

function relationshipLabelsByQuestion(matrix, questionsById) {
  const rows = requireArray(matrix.labels, 'relationship_label_matrix.json labels');
  if (rows.length !== 99) {
    fail(`Expected 99 requester-conditioned label rows, found ${rows.length}`);
  }

  const result = new Map();
  for (const [index, rawRow] of rows.entries()) {
    const row = requireObject(rawRow, `relationship labels[${index}]`);
    const id = requireInteger(row.id, `relationship labels[${index}].id`);
    if (result.has(id)) fail(`Duplicate requester-conditioned label row: Q${id}`);
    const question = questionsById.get(id);
    if (!question) fail(`Requester-conditioned label Q${id} has no matching question`);
    if (row.category !== question.category || row.question !== question.question) {
      fail(`Requester-conditioned label Q${id} does not match its canonical question`);
    }
    const labels = {};
    for (const requester of REQUESTER_IDS) {
      const label = requireString(row[requester], `relationship Q${id}.${requester}`);
      if (!['L', 'P', 'B'].includes(label)) {
        fail(`Relationship Q${id}.${requester} must be L, P, or B`);
      }
      labels[requester] = label;
    }
    result.set(id, labels);
  }
  return result;
}

function qaRow(question, track, benchmarkVersion, expectations, relationships) {
  const id = requireInteger(question.id, `${track} question id`);
  const category = requireString(question.category, `Q${id}.category`);
  const policy = expectations.get(category);
  if (!policy) fail(`Q${id} refers to category without policy metadata: ${category}`);
  const relationship = relationships.get(id) ?? {};
  const surface = track === 'notes_qa' ? 'notes' : 'todos';

  return {
    benchmark_version: benchmarkVersion,
    category,
    config: CONFIG_NAME,
    expected_policy_d0: policy.D0,
    expected_policy_d1: policy.D1,
    expected_policy_d2: policy.D2,
    expected_policy_d3: policy.D3,
    expected_policy_d4: policy.D4,
    expected_policy_d5: policy.D5,
    expected_verdict: null,
    gold_check_content_contains: [],
    gold_check_folder: null,
    gold_check_target: null,
    gold_check_type: null,
    gold_check_verify: null,
    gold_key_facts: requireStringArray(question.gold_key_facts, `Q${id}.gold_key_facts`),
    kind: 'qa',
    minimum_correct: requireString(question.minimum_correct, `Q${id}.minimum_correct`),
    numeric_id: id,
    operation: null,
    prompt: requireString(question.question, `Q${id}.question`),
    relationship_r0: relationship.R0 ?? null,
    relationship_r1: relationship.R1 ?? null,
    relationship_r2: relationship.R2 ?? null,
    relationship_r3: relationship.R3 ?? null,
    relationship_r4: relationship.R4 ?? null,
    source_notes: track === 'notes_qa'
      ? requireStringArray(question.source_notes, `Q${id}.source_notes`)
      : [],
    source_todos: track === 'todo_qa'
      ? requireStringArray(question.source_todos, `Q${id}.source_todos`)
      : [],
    split: SPLIT_NAME,
    surface,
    target_folder: null,
    target_item: null,
    task_id: `PAIR-Q${id}`,
    topic: requireString(question.topic, `Q${id}.topic`),
    track,
    world_asset: 'assets/pair/alex_data_store.json',
  };
}

function actionRow(action, benchmarkVersion) {
  const id = requireInteger(action.id, 'action id');
  const goldCheck = requireObject(action.gold_check, `A${id}.gold_check`);
  const verdict = requireString(action.expected_verdict, `A${id}.expected_verdict`);
  if (!['execute', 'refuse'].includes(verdict)) {
    fail(`A${id}.expected_verdict must be execute or refuse`);
  }

  return {
    benchmark_version: benchmarkVersion,
    category: requireString(action.category, `A${id}.category`),
    config: CONFIG_NAME,
    expected_policy_d0: null,
    expected_policy_d1: null,
    expected_policy_d2: null,
    expected_policy_d3: null,
    expected_policy_d4: null,
    expected_policy_d5: null,
    expected_verdict: verdict,
    gold_check_content_contains: goldCheck.content_contains === undefined
      ? []
      : requireStringArray(goldCheck.content_contains, `A${id}.gold_check.content_contains`),
    gold_check_folder: requireOptionalString(goldCheck.folder, `A${id}.gold_check.folder`),
    gold_check_target: requireOptionalString(goldCheck.target, `A${id}.gold_check.target`),
    gold_check_type: requireString(goldCheck.type, `A${id}.gold_check.type`),
    gold_check_verify: requireOptionalString(goldCheck.verify, `A${id}.gold_check.verify`),
    gold_key_facts: [],
    kind: 'action',
    minimum_correct: null,
    numeric_id: id,
    operation: requireString(action.operation, `A${id}.operation`),
    prompt: requireString(action.instruction, `A${id}.instruction`),
    relationship_r0: null,
    relationship_r1: null,
    relationship_r2: null,
    relationship_r3: null,
    relationship_r4: null,
    source_notes: [],
    source_todos: [],
    split: SPLIT_NAME,
    surface: requireString(action.surface, `A${id}.surface`),
    target_folder: requireOptionalString(action.target_folder, `A${id}.target_folder`),
    target_item: requireOptionalString(action.target_item, `A${id}.target_item`),
    task_id: `PAIR-A${id}`,
    topic: null,
    track: 'actions',
    world_asset: 'assets/pair/alex_data_store.json',
  };
}

function validateWorld(world) {
  const object = requireObject(world, 'alex_data_store.json');
  const notes = requireArray(object.notes, 'alex_data_store.json notes');
  const todos = requireArray(object.todos, 'alex_data_store.json todos');
  if (notes.length !== 100 || todos.length !== 150) {
    fail(`Expected world asset with 100 notes and 150 todos; found ${notes.length} and ${todos.length}`);
  }
}

function buildRows(benchmark, relationshipMatrix) {
  const object = requireObject(benchmark, 'questions.json');
  const benchmarkVersion = requireInteger(object.version, 'questions.json version');
  const declaredTotal = requireInteger(object.total, 'questions.json total');
  const questions = requireArray(object.questions, 'questions.json questions');
  const actions = requireArray(object.actions, 'questions.json actions');
  if (questions.length !== EXPECTED_QA_COUNT || actions.length !== EXPECTED_ACTION_COUNT) {
    fail(
      `Expected ${EXPECTED_QA_COUNT} QA and ${EXPECTED_ACTION_COUNT} action tasks; `
      + `found ${questions.length} and ${actions.length}`,
    );
  }
  if (declaredTotal !== EXPECTED_ROW_COUNT) {
    fail(`questions.json total must be ${EXPECTED_ROW_COUNT}, found ${declaredTotal}`);
  }

  const notesQuestions = questions.filter(question => question.id >= 1 && question.id <= 200);
  const todoQuestions = questions.filter(question => question.id >= 201 && question.id <= 400);
  assertExactRange(notesQuestions, 1, 200, 'Notes QA questions');
  assertExactRange(todoQuestions, 201, 400, 'Todo QA questions');
  assertExactRange(actions, 1, 200, 'Actions');

  const sortedQuestions = [...questions].sort((left, right) => left.id - right.id);
  const sortedActions = [...actions].sort((left, right) => left.id - right.id);
  const questionsById = new Map(sortedQuestions.map(question => [question.id, question]));
  const expectations = policyExpectationsByCategory(object);
  const relationships = relationshipLabelsByQuestion(
    requireObject(relationshipMatrix, 'relationship_label_matrix.json'),
    questionsById,
  );

  const rows = [
    ...sortedQuestions.slice(0, 200).map(question =>
      qaRow(question, 'notes_qa', benchmarkVersion, expectations, relationships)),
    ...sortedQuestions.slice(200).map(question =>
      qaRow(question, 'todo_qa', benchmarkVersion, expectations, relationships)),
    ...sortedActions.map(action => actionRow(action, benchmarkVersion)),
  ];
  const taskIds = new Set(rows.map(row => row.task_id));
  if (rows.length !== EXPECTED_ROW_COUNT || taskIds.size !== EXPECTED_ROW_COUNT) {
    fail('Export must produce exactly 600 uniquely identified rows');
  }
  return rows;
}

function rowSchema() {
  return {
    benchmark_version: 'int64',
    category: 'string',
    config: 'string',
    expected_policy_d0: 'string|null',
    expected_policy_d1: 'string|null',
    expected_policy_d2: 'string|null',
    expected_policy_d3: 'string|null',
    expected_policy_d4: 'string|null',
    expected_policy_d5: 'string|null',
    expected_verdict: 'string|null',
    gold_check_content_contains: 'list<string>',
    gold_check_folder: 'string|null',
    gold_check_target: 'string|null',
    gold_check_type: 'string|null',
    gold_check_verify: 'string|null',
    gold_key_facts: 'list<string>',
    kind: 'string',
    minimum_correct: 'string|null',
    numeric_id: 'int64',
    operation: 'string|null',
    prompt: 'string',
    relationship_r0: 'string|null',
    relationship_r1: 'string|null',
    relationship_r2: 'string|null',
    relationship_r3: 'string|null',
    relationship_r4: 'string|null',
    source_notes: 'list<string>',
    source_todos: 'list<string>',
    split: 'string',
    surface: 'string',
    target_folder: 'string|null',
    target_item: 'string|null',
    task_id: 'string',
    topic: 'string|null',
    track: 'string',
    world_asset: 'string',
  };
}

function buildDatasetCard({ benchmarkVersion, dataBytes, dataHash, rows, sourceHashes }) {
  const trackCounts = countBy(rows, 'track');
  return `---
pretty_name: PACT-Bench
language:
- en
license: mit
task_categories:
- question-answering
- text-generation
size_categories:
- "n<1K"
tags:
- agents
- benchmark
- privacy
- safety
configs:
- config_name: pair
  default: true
  data_files:
  - split: validation
    path: data/pair/validation.jsonl
---

# PACT-Bench

This staging tree contains the public **PACT-Pair** validation data. It is a
derived release artifact for the recommended Hugging Face dataset family
repository, \`ORG/PACT-Bench\`; replace \`ORG\` with the publishing organization.

## Dataset structure

- Configuration: \`pair\`
- Split: \`validation\`
- Rows: ${rows.length}
- Tracks: ${trackCounts.notes_qa} \`notes_qa\`, ${trackCounts.todo_qa} \`todo_qa\`, ${trackCounts.actions} \`actions\`
- Benchmark data version: ${benchmarkVersion}
- World asset: \`assets/pair/alex_data_store.json\`

Each row is one task. The \`track\` column selects Notes QA, Todo QA, or Actions;
\`kind\` groups the two QA tracks when a QA/action distinction is sufficient.
The columns have one stable schema across all tracks, using nulls and empty
lists when a field does not apply. The companion world asset is stored once
instead of being duplicated in every row.

The QA rows include public gold facts, category-policy expectations, and the
available requester-conditioned labels. Action rows include the expected
verdict and a flattened state-diff check. These labels are suitable for public
validation and development, not for estimating performance on held-out data.

## Loading

After publication, pin an immutable full commit SHA rather than relying on the
mutable \`main\` branch:

\`\`\`python
from datasets import load_dataset

validation = load_dataset(
    "ORG/PACT-Bench",
    "pair",
    split="validation",
    revision="FULL_40_CHARACTER_COMMIT_SHA",
)
\`\`\`

## Public and official evaluation

This repository contains only released synthetic validation data. Official
leaderboard test tasks, labels, evaluator state, and traces must live in a
separate private system and must never be added to this dataset repository.
Scores on this split are development results, not official leaderboard scores.

## Responsible use and limitations

PACT-Pair evaluates privacy boundaries and delegated actions in one synthetic
workspace. Although the people and records are synthetic, some examples model
health, finance, employment, and relationship information. Do not interpret
the labels as universal legal or social rules. Results do not establish safety
outside the benchmark's task distribution, policy, tools, or evaluator.

## Reproducibility

This artifact was produced by \`${GENERATOR}\` without network access or an
upload step.

- Validation JSONL bytes: ${dataBytes}
- Validation JSONL SHA-256: \`${dataHash}\`
- Canonical tasks SHA-256: \`${sourceHashes.tasks}\`
- Canonical relationship labels SHA-256: \`${sourceHashes.relationshipLabels}\`
- Canonical world SHA-256: \`${sourceHashes.world}\`
`;
}

function buildArtifacts({ benchmark, relationshipMatrix, worldAsset }) {
  validateWorld(worldAsset.value);
  const rows = buildRows(benchmark.value, relationshipMatrix.value);
  const validationJsonl = Buffer.from(
    `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  const sourceHashes = {
    relationshipLabels: sha256(relationshipMatrix.bytes),
    tasks: sha256(benchmark.bytes),
    world: sha256(worldAsset.bytes),
  };
  const validationHash = sha256(validationJsonl);
  const benchmarkVersion = benchmark.value.version;
  const datasetCard = buildDatasetCard({
    benchmarkVersion,
    dataBytes: validationJsonl.byteLength,
    dataHash: validationHash,
    rows,
    sourceHashes,
  });
  const manifest = {
    artifact_schema_version: 1,
    dataset: {
      benchmark_version: benchmarkVersion,
      config: CONFIG_NAME,
      hidden_official_tests_included: false,
      repository_recommendation: 'ORG/PACT-Bench',
      split: SPLIT_NAME,
    },
    files: {
      'README.md': {
        bytes: Buffer.byteLength(datasetCard, 'utf8'),
        sha256: sha256(datasetCard),
      },
      'assets/pair/alex_data_store.json': {
        bytes: worldAsset.bytes.byteLength,
        sha256: sourceHashes.world,
      },
      'data/pair/validation.jsonl': {
        bytes: validationJsonl.byteLength,
        rows: rows.length,
        sha256: validationHash,
      },
    },
    generator: GENERATOR,
    row_schema: rowSchema(),
    source: {
      'data_spec/alex_data_store.json': { sha256: sourceHashes.world },
      'relationship_labels/relationship_label_matrix.json': {
        sha256: sourceHashes.relationshipLabels,
      },
      'tasks/questions.json': { sha256: sourceHashes.tasks },
    },
    statistics: {
      categories: countBy(rows, 'category'),
      kinds: countBy(rows, 'kind'),
      rows: rows.length,
      tracks: countBy(rows, 'track'),
    },
  };

  return {
    datasetCard,
    manifest,
    rows,
    validationJsonl,
    worldBytes: worldAsset.bytes,
  };
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertReplaceableOutput(outputRoot, force) {
  if (!(await exists(outputRoot))) return;
  if (!force) fail(`Output already exists: ${outputRoot} (pass --force to replace it)`);

  const manifestPath = path.join(outputRoot, 'export-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail(`Refusing to replace ${outputRoot}: it is not a staging tree created by this exporter`);
  }
  if (manifest?.generator !== GENERATOR) {
    fail(`Refusing to replace ${outputRoot}: exporter marker is missing or invalid`);
  }
}

async function writeArtifacts(inputRoot, outputRoot, artifacts, force) {
  if (pathsOverlap(inputRoot, outputRoot) || pathsOverlap(outputRoot, inputRoot)) {
    fail('Input and output directories must not overlap');
  }
  await assertReplaceableOutput(outputRoot, force);

  const temporaryRoot = `${outputRoot}.tmp-${process.pid}`;
  await rm(temporaryRoot, { force: true, recursive: true });
  try {
    await mkdir(path.join(temporaryRoot, 'data', 'pair'), { recursive: true });
    await mkdir(path.join(temporaryRoot, 'assets', 'pair'), { recursive: true });
    await writeFile(path.join(temporaryRoot, 'README.md'), artifacts.datasetCard, 'utf8');
    await writeFile(
      path.join(temporaryRoot, 'data', 'pair', 'validation.jsonl'),
      artifacts.validationJsonl,
    );
    await writeFile(
      path.join(temporaryRoot, 'assets', 'pair', 'alex_data_store.json'),
      artifacts.worldBytes,
    );
    await writeFile(
      path.join(temporaryRoot, 'export-manifest.json'),
      prettyJson(artifacts.manifest),
      'utf8',
    );

    if (await exists(outputRoot)) await rm(outputRoot, { force: true, recursive: true });
    await mkdir(path.dirname(outputRoot), { recursive: true });
    await rename(temporaryRoot, outputRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  const [benchmark, relationshipMatrix, worldAsset] = await Promise.all([
    readJsonAsset(options.input, path.join('tasks', 'questions.json')),
    readJsonAsset(
      options.input,
      path.join('relationship_labels', 'relationship_label_matrix.json'),
    ),
    readJsonAsset(options.input, path.join('data_spec', 'alex_data_store.json')),
  ]);
  const artifacts = buildArtifacts({ benchmark, relationshipMatrix, worldAsset });

  if (options.check) {
    process.stdout.write(prettyJson({
      benchmark_version: artifacts.manifest.dataset.benchmark_version,
      config: CONFIG_NAME,
      data_sha256: artifacts.manifest.files['data/pair/validation.jsonl'].sha256,
      rows: artifacts.rows.length,
      split: SPLIT_NAME,
      tracks: artifacts.manifest.statistics.tracks,
    }));
    return;
  }

  await writeArtifacts(options.input, options.output, artifacts, options.force);
  process.stdout.write(
    `Staged ${artifacts.rows.length} rows at ${options.output}\n`
    + `SHA-256 ${artifacts.manifest.files['data/pair/validation.jsonl'].sha256}\n`,
  );
}

main().catch(error => {
  process.stderr.write(`PACT-Pair Hugging Face export failed: ${error.message}\n`);
  process.exitCode = 1;
});
