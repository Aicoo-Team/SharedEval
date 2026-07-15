import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  dataStoreSchema,
  netActionSchema,
  netDataStoreSchema,
  netQuestionSchema,
  pairActionSchema,
} from '../../src/schemas.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('preserves action target fields required by the evaluator', () => {
  const pair = JSON.parse(
    readFileSync(join(repoRoot, 'pact_pair/tasks/questions.json'), 'utf8'),
  ) as { actions: unknown[] };
  const net = JSON.parse(
    readFileSync(join(repoRoot, 'pact_net/pact_net_tasks.json'), 'utf8'),
  ) as { actions: unknown[] };

  const pairAction = pairActionSchema.parse(pair.actions[0]);
  const netAction = netActionSchema.parse(net.actions[0]);

  assert.equal(pairAction.target_folder, 'Shared');
  assert.equal(pairAction.target_item, null);
  assert.equal(netAction.target_folder, 'Shared');
});

test('rejects evaluator-breaking action schema corruption', () => {
  const pair = JSON.parse(
    readFileSync(join(repoRoot, 'pact_pair/tasks/questions.json'), 'utf8'),
  ) as { actions: Array<Record<string, unknown>> };
  const net = JSON.parse(
    readFileSync(join(repoRoot, 'pact_net/pact_net_tasks.json'), 'utf8'),
  ) as { actions: Array<Record<string, unknown>> };
  const { target_folder: _pairFolder, ...pairWithoutFolder } = pair.actions[0];
  const { target_folder: _netFolder, ...netWithoutFolder } = net.actions[0];

  assert.throws(() => pairActionSchema.parse(pairWithoutFolder));
  assert.throws(() => netActionSchema.parse(netWithoutFolder));
  assert.throws(() =>
    pairActionSchema.parse({
      ...pairWithoutFolder,
      target_fodler: 'Shared',
    }),
  );
  assert.throws(() =>
    pairActionSchema.parse({
      ...pair.actions[0],
      gold_check: { type: 'note_created' },
    }),
  );
  assert.throws(() => pairActionSchema.parse({ ...pair.actions[0], operation: 'cretae' }));
  assert.throws(() => pairActionSchema.parse({
    ...pair.actions[0],
    expected_verdict: 'refuse',
  }));
  assert.throws(() => pairActionSchema.parse({ ...pair.actions[0], surface: 'todos' }));
  assert.throws(() => pairActionSchema.parse({
    ...pair.actions[0],
    target_folder: 'Work',
  }));
  assert.throws(() => netActionSchema.parse({
    ...net.actions[0],
    gold_check: { type: 'no_change' },
  }));
});

test('requires exact mutation targets for edit and completion actions', () => {
  const pair = JSON.parse(
    readFileSync(join(repoRoot, 'pact_pair/tasks/questions.json'), 'utf8'),
  ) as { actions: Array<Record<string, unknown>> };
  const net = JSON.parse(
    readFileSync(join(repoRoot, 'pact_net/pact_net_tasks.json'), 'utf8'),
  ) as { actions: Array<Record<string, unknown>> };
  const pairEdit = pair.actions.find(action => action.operation === 'edit');
  const netCompletion = net.actions.find(action => action.operation === 'complete');

  assert.ok(pairEdit);
  assert.ok(netCompletion);
  assert.throws(() => pairActionSchema.parse({ ...pairEdit, target_item: null }));
  assert.equal(netActionSchema.parse(netCompletion).gold_check.type, 'todo_completed');

  const evaluatorSource = readFileSync(join(repoRoot, 'scripts/experiment_v2.ts'), 'utf8');
  assert.match(
    evaluatorSource,
    /goldCheck\?\.target \|\| goldCheck\?\.title \|\| action\?\.target_item/,
  );
});

test('validates concrete Pair and Net datastore records', () => {
  const pairStore = JSON.parse(
    readFileSync(join(repoRoot, 'pact_pair/data_spec/alex_data_store.json'), 'utf8'),
  );
  const netStore = JSON.parse(
    readFileSync(join(repoRoot, 'pact_net/agent_configs/tom_bradford/data.json'), 'utf8'),
  );

  assert.doesNotThrow(() => dataStoreSchema.parse(pairStore));
  assert.doesNotThrow(() => netDataStoreSchema.parse(netStore));
  assert.throws(() => dataStoreSchema.parse({
    version: 1,
    description: 'invalid',
    owner: {},
    note_folders: [{}],
    todo_folders: [{}],
    notes: [{}],
    todos: [{}],
  }));
  assert.throws(() => netDataStoreSchema.parse({ agent: 'tom_bradford', notes: [{}], todos: [{}] }));
});

test('requires nonempty relational labels and typed leakage facts', () => {
  const net = JSON.parse(
    readFileSync(join(repoRoot, 'pact_net/pact_net_tasks.json'), 'utf8'),
  ) as { questions: Array<Record<string, unknown>> };
  const question = net.questions[0];

  assert.throws(() => netQuestionSchema.parse({ ...question, relational_labels: {} }));
  assert.throws(() => netQuestionSchema.parse({ ...question, sensitive_facts_in_scope: [null] }));
  assert.throws(() => netQuestionSchema.parse({ ...question, transitive_leak_rule: 42 }));
  assert.throws(() => netQuestionSchema.parse({
    ...question,
    sensitive_facts_in_scope: [{
      fact: 'secret',
      owner: 'alex_chen',
      category: 'not_a_sensitivity',
    }],
  }));
});
