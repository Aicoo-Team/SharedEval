import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  dataStoreSchema,
  netBenchmarkSchema,
  pairBenchmarkSchema,
  relationshipLabelSchema,
  type NetBenchmark,
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

function validatePair(): void {
  const data = pairBenchmarkSchema.parse(readJson('pact_pair/tasks/questions.json'));
  dataStoreSchema.parse(readJson('pact_pair/data_spec/alex_data_store.json'));

  assertEqual(data.total, 600, 'PACT-Pair total metadata');
  assertEqual(data.questions.length, 400, 'PACT-Pair QA count');
  assertEqual(data.actions.length, 200, 'PACT-Pair action count');
  assertEqual(data.questions.length + data.actions.length, data.total, 'PACT-Pair total');
  assertUnique(data.questions.map((q) => `Q${q.id}`), 'PACT-Pair QA ids');
  assertUnique(data.actions.map((a) => `A${a.id}`), 'PACT-Pair action ids');

  const notesQa = data.questions.filter((q) => q.id >= 1 && q.id <= 200);
  const todoQa = data.questions.filter((q) => q.id >= 201 && q.id <= 400);
  assertEqual(notesQa.length, 200, 'PACT-Pair notes QA range');
  assertEqual(todoQa.length, 200, 'PACT-Pair todo QA range');

  const executable = data.actions.filter((a) => a.expected_verdict === 'execute');
  const refusals = data.actions.filter((a) => a.expected_verdict === 'refuse');
  assertEqual(executable.length, 100, 'PACT-Pair executable actions');
  assertEqual(refusals.length, 100, 'PACT-Pair refusal actions');

  console.log(formatPairSummary(data));
}

function validateNet(): void {
  const data = netBenchmarkSchema.parse(readJson('pact_net/pact_net_tasks.json'));
  const accessMatrix = readJson('pact_net/world_design/relational_access_matrix.json') as {
    agents?: Record<string, unknown>;
  };

  assertEqual(data.questions.length, 483, 'PACT-Net QA count');
  assertEqual(data.actions.length, 514, 'PACT-Net action count');
  assertEqual(data.questions.length + data.actions.length, 997, 'PACT-Net total');
  assertUnique(data.questions.map((q) => q.id), 'PACT-Net QA ids');
  assertUnique(data.actions.map((a) => a.id), 'PACT-Net action ids');

  if (!accessMatrix.agents || Object.keys(accessMatrix.agents).length !== 25) {
    throw new Error('PACT-Net relational access matrix must contain 25 agents');
  }

  for (const question of data.questions) {
    for (const label of Object.values(question.relational_labels)) {
      relationshipLabelSchema.parse(label.label);
    }
  }

  console.log(formatNetSummary(data));
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
