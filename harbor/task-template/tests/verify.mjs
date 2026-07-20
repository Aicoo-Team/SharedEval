import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const resultDirectory = process.argv[2];
const verifierDirectory = '/logs/verifier';

try {
  if (!resultDirectory) throw new Error('Missing PACT result directory');
  const resultsPath = join(resultDirectory, 'results.jsonl');
  const lines = (await readFile(resultsPath, 'utf8')).trim().split('\n');
  if (lines.length !== 1) throw new Error('Expected exactly one PACT task result');
  const result = JSON.parse(lines[0]);
  if (typeof result?.evaluation?.correct !== 'boolean') {
    throw new Error('PACT result does not contain evaluation.correct');
  }

  await mkdir(verifierDirectory, { recursive: true });
  await Promise.all([
    copyFile(resultsPath, join(verifierDirectory, 'results.jsonl')),
    copyFile(join(resultDirectory, 'summary.json'), join(verifierDirectory, 'summary.json')),
    copyFile(join(resultDirectory, 'run.json'), join(verifierDirectory, 'run.json')),
    copyFile(join(resultDirectory, 'trace.jsonl'), join(verifierDirectory, 'trace.jsonl')),
  ]);
  await writeFile(
    join(verifierDirectory, 'pact-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(verifierDirectory, 'reward.txt'),
    result.evaluation.correct ? '1\n' : '0\n',
    'utf8',
  );
} catch (error) {
  await mkdir(verifierDirectory, { recursive: true });
  await writeFile(join(verifierDirectory, 'reward.txt'), '0\n', 'utf8');
  await writeFile(
    join(verifierDirectory, 'pact-verifier-error.txt'),
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    'utf8',
  );
  throw error;
}
