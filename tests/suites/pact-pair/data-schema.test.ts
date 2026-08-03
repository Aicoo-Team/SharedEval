import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  dataStoreSchema,
  pairActionSchema,
  pairRelationshipLabelMatrixSchema,
} from '../../../src/suites/pact-pair/schemas.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('preserves action target fields required by the evaluator', () => {
  const pair = JSON.parse(
    readFileSync(join(repoRoot, 'dataset/pact-pair/tasks/questions.json'), 'utf8'),
  ) as { actions: unknown[] };

  const pairAction = pairActionSchema.parse(pair.actions[0]);

  assert.equal(pairAction.target_folder, 'Shared');
  assert.equal(pairAction.target_item, null);
});

test('rejects evaluator-breaking action schema corruption', () => {
  const pair = JSON.parse(
    readFileSync(join(repoRoot, 'dataset/pact-pair/tasks/questions.json'), 'utf8'),
  ) as { actions: Array<Record<string, unknown>> };
  const { target_folder: _pairFolder, ...pairWithoutFolder } = pair.actions[0];

  assert.throws(() => pairActionSchema.parse(pairWithoutFolder));
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
});

test('requires exact mutation targets for edit and completion actions', () => {
  const pair = JSON.parse(
    readFileSync(join(repoRoot, 'dataset/pact-pair/tasks/questions.json'), 'utf8'),
  ) as { actions: Array<Record<string, unknown>> };
  const pairEdit = pair.actions.find(action => action.operation === 'edit');
  const pairCompletion = pair.actions.find(action => action.operation === 'complete');

  assert.ok(pairEdit);
  assert.ok(pairCompletion);
  assert.throws(() => pairActionSchema.parse({ ...pairEdit, target_item: null }));
  assert.equal(pairActionSchema.parse(pairCompletion).gold_check.type, 'todo_completed');

  const evaluatorSource = readFileSync(join(repoRoot, 'scripts/experiment_v2.ts'), 'utf8');
  assert.match(
    evaluatorSource,
    /goldCheck\?\.target \|\| goldCheck\?\.title \|\| action\?\.target_item/,
  );
});

test('validates a concrete Pair datastore record', () => {
  const pairStore = JSON.parse(
    readFileSync(
      join(repoRoot, 'dataset/pact-pair/data_spec/alex_data_store.json'),
      'utf8',
    ),
  );

  assert.doesNotThrow(() => dataStoreSchema.parse(pairStore));
  assert.throws(() => dataStoreSchema.parse({
    version: 1,
    description: 'invalid',
    owner: {},
    note_folders: [{}],
    todo_folders: [{}],
    notes: [{}],
    todos: [{}],
  }));
});

test('validates the Pair requester-conditioned relationship labels', () => {
  const matrix = JSON.parse(
    readFileSync(
      join(
        repoRoot,
        'dataset/pact-pair/relationship_labels/relationship_label_matrix.json',
      ),
      'utf8',
    ),
  ) as { labels: Array<Record<string, unknown>> };

  assert.equal(pairRelationshipLabelMatrixSchema.parse(matrix).labels.length, 99);
  assert.throws(() => pairRelationshipLabelMatrixSchema.parse({
    ...matrix,
    labels: [{ ...matrix.labels[0], R0: 'BLOCKED' }],
  }));
});
