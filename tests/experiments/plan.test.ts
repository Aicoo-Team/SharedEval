import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  deriveExperimentCellIdV1,
  serializeExperimentPlanV1,
  experimentPlanV1Schema,
} from '../../src/experiments/v1/contracts.js';
import {
  EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1,
  EXPERIMENT_PLAN_FILE_NAME_V1,
  assertSingleExperimentBatchV1,
  deriveExperimentRunIdV1,
  loadExperimentPlanV1,
  nodeExperimentPlanFilesV1,
  publishExperimentPlanV1,
} from '../../src/experiments/v1/plan.js';
import type { ExperimentPlanFilesV1 } from '../../src/experiments/v1/plan.js';
import {
  experimentCellInput,
  experimentPlanInput,
} from './experiment-test-fixtures.js';

async function publishedTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sharedeval-experiment-plan-'));
}

function memoryExperimentPlanFiles(): ExperimentPlanFilesV1 & {
  contents: Map<string, string>;
} {
  const contents = new Map<string, string>();
  return {
    contents,
    async mkdir() {},
    async readFile(filePath) {
      const stored = contents.get(filePath);
      if (stored === undefined) throw new Error(`missing ${filePath}`);
      return stored;
    },
    async writeFileExclusive(filePath, value) {
      if (contents.has(filePath)) throw new Error(`exists ${filePath}`);
      contents.set(filePath, value);
    },
  };
}

test('publishes plan.json plus digest and loads it back verbatim', async () => {
  const directory = await publishedTempDir();
  const published = await publishExperimentPlanV1(experimentPlanInput(), directory);

  assert.match(published.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(published.cells.length, 2);
  for (const cell of published.cells) {
    assert.equal(cell.planDigest, published.planDigest);
    assert.equal(cell.experimentId, 'pair-grid-aug');
    assert.equal(
      cell.runId,
      deriveExperimentRunIdV1('pair-grid-aug', cell.cellId, cell.replicate),
    );
  }

  const digestFile = await readFile(
    join(directory, EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1),
    'utf8',
  );
  assert.equal(digestFile, `${published.planDigest}\n`);

  const loaded = await loadExperimentPlanV1(directory);
  assert.equal(loaded.planDigest, published.planDigest);
  assert.deepEqual(loaded.plan, published.plan);
  assert.deepEqual(loaded.cells, published.cells);
});

test('a published plan is immutable: republish into the same directory fails', async () => {
  const directory = await publishedTempDir();
  await publishExperimentPlanV1(experimentPlanInput(), directory);

  await assert.rejects(
    publishExperimentPlanV1(experimentPlanInput(), directory),
    /EEXIST/,
  );
  await assert.rejects(
    publishExperimentPlanV1(
      experimentPlanInput({ experimentId: 'pair-grid-sep' }),
      directory,
    ),
    /EEXIST/,
  );
});

test('publish validates before writing anything', async () => {
  const files = memoryExperimentPlanFiles();

  await assert.rejects(
    publishExperimentPlanV1(
      experimentPlanInput({ cells: [experimentCellInput({ replicate: 0 })] }),
      '/plans/invalid',
      files,
    ),
  );
  assert.equal(files.contents.size, 0);
});

test('load rejects value tampering via the published digest', async () => {
  const directory = await publishedTempDir();
  await publishExperimentPlanV1(experimentPlanInput(), directory);

  const tampered = experimentPlanV1Schema.parse(
    experimentPlanInput({ cells: [experimentCellInput({ replicate: 3 })] }),
  );
  await writeFile(
    join(directory, EXPERIMENT_PLAN_FILE_NAME_V1),
    serializeExperimentPlanV1(tampered),
    'utf8',
  );

  await assert.rejects(loadExperimentPlanV1(directory), /does not match its digest/);
});

test('load rejects any byte-level modification of plan.json', async () => {
  const directory = await publishedTempDir();
  await publishExperimentPlanV1(experimentPlanInput(), directory);
  const planPath = join(directory, EXPERIMENT_PLAN_FILE_NAME_V1);
  const raw = await readFile(planPath, 'utf8');

  await writeFile(planPath, `${raw}\n`, 'utf8');
  await assert.rejects(loadExperimentPlanV1(directory), /canonical published form/);

  await writeFile(planPath, raw.replace('"cells":', ' "cells":'), 'utf8');
  await assert.rejects(loadExperimentPlanV1(directory), /canonical published form/);

  await writeFile(planPath, 'not json', 'utf8');
  await assert.rejects(loadExperimentPlanV1(directory), /not valid JSON/);
});

test('load rejects digest-file tampering and missing files', async () => {
  const directory = await publishedTempDir();
  await publishExperimentPlanV1(experimentPlanInput(), directory);
  const digestPath = join(directory, EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1);

  await writeFile(digestPath, `${'f'.repeat(64)}\n`, 'utf8');
  await assert.rejects(loadExperimentPlanV1(directory), /does not match its digest/);

  await writeFile(digestPath, 'not-a-digest\n', 'utf8');
  await assert.rejects(loadExperimentPlanV1(directory), /digest file is invalid/);

  await assert.rejects(
    loadExperimentPlanV1(await publishedTempDir()),
    /Unable to read published experiment plan\.json/,
  );
});

test('plan files seam is injectable: publish/load round-trips without real fs', async () => {
  const files = memoryExperimentPlanFiles();
  const published = await publishExperimentPlanV1(
    experimentPlanInput(),
    '/plans/pair-grid-aug',
    files,
  );
  const loaded = await loadExperimentPlanV1('/plans/pair-grid-aug', files);

  assert.deepEqual(loaded, published);
  assert.deepEqual(
    [...files.contents.keys()].sort(),
    [
      join('/plans/pair-grid-aug', EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1),
      join('/plans/pair-grid-aug', EXPERIMENT_PLAN_FILE_NAME_V1),
    ].sort(),
  );
  assert.equal(typeof nodeExperimentPlanFilesV1().writeFileExclusive, 'function');
});

test('mixed batches across published plans are rejected', async () => {
  const files = memoryExperimentPlanFiles();
  const first = await publishExperimentPlanV1(experimentPlanInput(), '/plans/first', files);
  const second = await publishExperimentPlanV1(
    experimentPlanInput({ experimentId: 'pair-grid-sep' }),
    '/plans/second',
    files,
  );

  assert.notEqual(first.planDigest, second.planDigest);
  assertSingleExperimentBatchV1(first.cells);
  assert.throws(
    () => assertSingleExperimentBatchV1([...first.cells, ...second.cells]),
    /mixes cells from 2 published plans/,
  );
  assert.throws(
    () => assertSingleExperimentBatchV1([first.cells[0]!, first.cells[0]!]),
    /duplicate cells/,
  );
  assert.throws(() => assertSingleExperimentBatchV1([]), /at least one cell/);
});

test('runId derivation is explicit, deterministic, and CLI-compatible', () => {
  const cellId = deriveExperimentCellIdV1(experimentCellInput());
  const runId = deriveExperimentRunIdV1('pair-grid-aug', cellId, 3);

  assert.equal(runId, `pair-grid-aug.${cellId.slice(0, 24)}.r3`);
  assert.equal(deriveExperimentRunIdV1('pair-grid-aug', cellId, 3), runId);
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.notEqual(deriveExperimentRunIdV1('pair-grid-aug', cellId, 4), runId);
  assert.notEqual(deriveExperimentRunIdV1('pair-grid-sep', cellId, 3), runId);

  assert.throws(() => deriveExperimentRunIdV1('Pair-Grid', cellId, 1), /Experiment id/);
  assert.throws(() => deriveExperimentRunIdV1('pair-grid-aug', 'abc', 1), /cell id/);
  for (const replicate of [0, 1.5, 1_001]) {
    assert.throws(
      () => deriveExperimentRunIdV1('pair-grid-aug', cellId, replicate),
      /replicate/,
    );
  }
});
