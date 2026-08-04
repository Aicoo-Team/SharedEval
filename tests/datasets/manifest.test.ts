import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  DATASET_MANIFEST_API_VERSION_V1,
  MAX_DATASET_MANIFEST_BYTES_V1,
  parseDatasetManifestV1,
  parseDatasetManifestYamlV1,
  type DatasetManifestV1,
} from '../../src/datasets/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const validManifest: DatasetManifestV1 = {
  apiVersion: DATASET_MANIFEST_API_VERSION_V1,
  kind: 'Dataset',
  id: 'demo-dataset',
  name: 'Demo dataset',
  version: '1.2.3',
  protocol: 'demo-task/v1',
  assets: {
    tasks: 'tasks/index.json',
    fixtures: 'fixtures',
  },
  evaluation: {
    evaluator: {
      id: 'demo-evaluator',
      version: '2.0.0',
    },
    metrics: ['utility', 'informationSecurity'],
  },
};

test('strictly parses the generic dataset v1 manifest', () => {
  const parsed = parseDatasetManifestV1(validManifest);
  assert.deepEqual(parsed, validManifest);
  assert.notEqual(parsed, validManifest);
});

test('parses the canonical PACT-Pair dataset manifest', () => {
  const source = readFileSync(
    join(repoRoot, 'dataset/pact-pair/manifest.yaml'),
    'utf8',
  );
  const manifest = parseDatasetManifestYamlV1(source);
  assert.equal(manifest.id, 'pact-pair');
  assert.deepEqual(manifest.evaluation.evaluator, {
    id: 'pact-pair',
    version: '1.0.0',
  });
});

test('rejects unknown fields at every fixed object level', () => {
  assert.throws(() => parseDatasetManifestV1({
    ...validManifest,
    code: './evaluator.ts',
  }), /Unrecognized key/);
  assert.throws(() => parseDatasetManifestV1({
    ...validManifest,
    evaluation: {
      ...validManifest.evaluation,
      module: './evaluator.ts',
    },
  }), /Unrecognized key/);
  assert.throws(() => parseDatasetManifestV1({
    ...validManifest,
    evaluation: {
      ...validManifest.evaluation,
      evaluator: {
        ...validManifest.evaluation.evaluator,
        entrypoint: './evaluator.ts',
      },
    },
  }), /Unrecognized key/);
});

test('accepts named relative assets and rejects unsafe paths', () => {
  for (const unsafePath of [
    '/etc/passwd',
    '../outside.json',
    'tasks/../outside.json',
    './tasks.json',
    'tasks\\index.json',
    'C:/tasks.json',
    'https://example.test/tasks.json',
  ]) {
    assert.throws(() => parseDatasetManifestV1({
      ...validManifest,
      assets: { tasks: unsafePath },
    }), `expected ${unsafePath} to be rejected`);
  }
});

test('enforces exact api, kind, versions, identifiers, and unique metrics', () => {
  const invalidValues = [
    { ...validManifest, apiVersion: 'pact-bench/dataset/v2' },
    { ...validManifest, kind: 'Submission' },
    { ...validManifest, id: 'Demo Dataset' },
    { ...validManifest, version: 'v1' },
    { ...validManifest, protocol: '../task-protocol' },
    {
      ...validManifest,
      evaluation: { ...validManifest.evaluation, metrics: ['utility', 'utility'] },
    },
    {
      ...validManifest,
      evaluation: {
        ...validManifest.evaluation,
        evaluator: { id: 'demo-evaluator', version: 'latest' },
      },
    },
  ];
  for (const invalid of invalidValues) {
    assert.throws(() => parseDatasetManifestV1(invalid));
  }
});

test('parses one bounded YAML document with strict keys', () => {
  assert.deepEqual(
    parseDatasetManifestYamlV1(stringify(validManifest)),
    validManifest,
  );

  const source = stringify(validManifest);
  assert.throws(() => parseDatasetManifestYamlV1(
    source.replace(
      'apiVersion: pact-bench/dataset/v1',
      'apiVersion: pact-bench/dataset/v1\napiVersion: pact-bench/dataset/v1',
    ),
  ));
  assert.throws(() => parseDatasetManifestYamlV1(`${source}\n---\n${source}`));
  assert.throws(() => parseDatasetManifestYamlV1(
    source
      .replace('tasks: tasks/index.json', 'tasks: &tasks tasks/index.json')
      .replace('fixtures: fixtures', 'fixtures: *tasks'),
  ));
  assert.throws(() => parseDatasetManifestYamlV1(
    source.replace('name: Demo dataset', 'name: !env Demo dataset'),
  ));
});

test('rejects oversized YAML before parsing', () => {
  assert.throws(
    () => parseDatasetManifestYamlV1('x'.repeat(MAX_DATASET_MANIFEST_BYTES_V1 + 1)),
    /exceeds/,
  );
});
