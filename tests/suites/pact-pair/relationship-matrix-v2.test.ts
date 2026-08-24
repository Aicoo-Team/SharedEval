import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const exportScript = join(repoRoot, 'scripts', 'huggingface', 'export-pact-pair.mjs');
const matrixPath = join(
  'dataset',
  'pact-pair',
  'relationship_labels',
  'relationship_label_matrix_v2.json',
);

type MatrixRow = Record<string, unknown> & { id: number };
type Matrix = { questions: MatrixRow[]; actions: MatrixRow[] };

function fixtureRoot(
  t: { after: (callback: () => void) => void },
  mutate: (matrix: Matrix) => void,
): string {
  const root = mkdtempSync(join(repoRoot, '.pact-pair-v2-matrix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dataset'), { recursive: true });
  cpSync(join(repoRoot, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(repoRoot, 'dataset', 'pact-pair'), join(root, 'dataset', 'pact-pair'), {
    recursive: true,
  });

  const target = join(root, matrixPath);
  const matrix = JSON.parse(readFileSync(target, 'utf8')) as Matrix;
  mutate(matrix);
  writeFileSync(target, JSON.stringify(matrix));
  return root;
}

function runValidator(root: string) {
  const result = spawnSync(process.execPath, [tsxCli, 'src/validate.ts', '--suite', 'pair'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

function runExporter(root: string) {
  const result = spawnSync(process.execPath, [
    exportScript,
    '--check',
    '--input',
    join(root, 'dataset', 'pact-pair'),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

function assertFails(
  result: { output: string; status: number | null },
  expected: RegExp,
): void {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, expected);
}

test('fails closed for invalid v2 relationship matrix rows in validator and exporter', t => {
  const missing = fixtureRoot(t, matrix => {
    matrix.questions.shift();
  });
  assertFails(
    runValidator(missing),
    /PACT-Pair v2 relationship QA label count: expected 400, got 399/,
  );

  const duplicate = fixtureRoot(t, matrix => {
    matrix.questions[1]!.id = 1;
  });
  assertFails(
    runValidator(duplicate),
    /PACT-Pair v2 relationship QA label ids: duplicate ids 1/,
  );

  const unknown = fixtureRoot(t, matrix => {
    matrix.questions[0]!.id = 401;
  });
  assertFails(
    runValidator(unknown),
    /PACT-Pair v2 relationship labels: unexpected question id 401/,
  );

  const refusedActionEscalation = fixtureRoot(t, matrix => {
    const action = matrix.actions.find(row => row.id === 51);
    assert.ok(action);
    action.R0 = 'execute';
  });
  assertFails(
    runExporter(refusedActionEscalation),
    /Relationship action A51\.R0 must be refuse because canonical action A51 is refuse/,
  );
});
