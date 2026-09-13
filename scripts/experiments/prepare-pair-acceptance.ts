import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { pairBenchmarkSchema } from '../../src/suites/pact-pair/schemas.js';
import { sharedevalRunConfigV2Schema } from '../../src/runner/v1/sharedeval-config.js';

export const FROZEN_SOURCE = '4eede49a83cf43da146664bd67c8c2c405aecc11';
export const SPLIT_PATH = 'dataset/pact-pair/splits/10_splits_v2/split_02.json';
export const QUESTIONS_PATH = 'dataset/pact-pair/tasks/questions.json';
export const PREFLIGHT_IDS = ['PAIR-Q11', 'PAIR-Q103'];
export const SPLIT_IDS = [
  'PAIR-Q11', 'PAIR-Q38', 'PAIR-Q46', 'PAIR-Q49', 'PAIR-Q56', 'PAIR-Q57',
  'PAIR-Q73', 'PAIR-Q74', 'PAIR-Q77', 'PAIR-Q93', 'PAIR-Q103', 'PAIR-Q105',
  'PAIR-Q131', 'PAIR-Q143', 'PAIR-Q145', 'PAIR-Q168', 'PAIR-Q170', 'PAIR-Q178',
  'PAIR-Q180', 'PAIR-Q186', 'PAIR-Q215', 'PAIR-Q219', 'PAIR-Q224', 'PAIR-Q234',
  'PAIR-Q239', 'PAIR-Q252', 'PAIR-Q265', 'PAIR-Q272', 'PAIR-Q275', 'PAIR-Q293',
  'PAIR-Q295', 'PAIR-Q318', 'PAIR-Q319', 'PAIR-Q324', 'PAIR-Q325', 'PAIR-Q338',
  'PAIR-Q355', 'PAIR-Q380', 'PAIR-Q390', 'PAIR-Q395',
  'PAIR-A12', 'PAIR-A35', 'PAIR-A37', 'PAIR-A54', 'PAIR-A59', 'PAIR-A62',
  'PAIR-A71', 'PAIR-A74', 'PAIR-A84', 'PAIR-A108', 'PAIR-A111', 'PAIR-A114',
  'PAIR-A131', 'PAIR-A134', 'PAIR-A144', 'PAIR-A149', 'PAIR-A163', 'PAIR-A164',
  'PAIR-A167', 'PAIR-A176',
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

export function acceptanceConfig(ids: string[], preflight = false) {
  return sharedevalRunConfigV2Schema.parse({
    apiVersion: 'sharedeval-run/v2', kind: 'RunConfig',
    model: {
      provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY', model: 'deepseek/deepseek-v4-flash-0731',
      temperature: 0, maxOutputTokens: 4096,
      providerRouting: { requireParameters: true, allowFallbacks: false, only: ['Inceptron'] },
    },
    benchmark: { dataset: 'pact-pair', policy: 'D2', requester: 'R1',
      gradingMode: 'category', tasks: { kind: 'all', ids } },
    workflow: {
      mode: 'multi', protocol: 'files', maxTicks: preflight ? 8 : 300,
      stopWhen: 'all-terminal',
      world: { protocol: 'actor-context/v1', maxContextBytes: 16 * 1024 * 1024 },
      multiTurn: { phase2StartTick: preflight ? 3 : 61, finalizeTick: preflight ? 8 : 261 },
    },
    budget: { maxToolCalls: 12, maxRuntimeMs: 300000 },
    output: { directory: 'runs', saveTraces: true },
  });
}

async function writeImmutable(path: string, content: string) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) {
      throw new Error(`Refusing to replace a different acceptance artifact: ${path}`);
    }
  }
}

export async function prepareAcceptance(outputDirectory: string, root = repositoryRoot) {
  const source = (path: string) => execFileSync('git', ['show', `${FROZEN_SOURCE}:${path}`],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const splitBytes = source(SPLIT_PATH);
  const questionBytes = source(QUESTIONS_PATH);
  const split = JSON.parse(splitBytes) as {
    questions: { id: number }[]; action_items: { id: number }[];
  };
  const actualIds = [
    ...split.questions.map(row => row.id).sort((a, b) => a - b).map(id => `PAIR-Q${id}`),
    ...split.action_items.map(row => row.id).sort((a, b) => a - b).map(id => `PAIR-A${id}`),
  ];
  if (JSON.stringify(actualIds) !== JSON.stringify(SPLIT_IDS)) {
    throw new Error('Frozen split 02 does not match the acceptance task IDs');
  }
  const benchmark = pairBenchmarkSchema.parse(JSON.parse(questionBytes));
  const categories = new Map(benchmark.categories.map(row => [row.id, row.expected_m2]));
  const selected = new Set(SPLIT_IDS);
  const tasks = [
    ...benchmark.questions.filter(row => selected.has(`PAIR-Q${row.id}`)).map(row => ({
      taskId: `PAIR-Q${row.id}`, kind: 'qa',
      surface: row.source_todos?.length ? 'todos' : 'notes', category: row.category,
      expectedBehavior: String(categories.get(row.category)),
    })),
    ...benchmark.actions.filter(row => selected.has(`PAIR-A${row.id}`)).map(row => ({
      taskId: `PAIR-A${row.id}`, kind: 'action', surface: row.surface,
      category: row.category, expectedBehavior: row.expected_verdict,
    })),
  ];
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    for (const key of [task.kind === 'action' ? 'action' : `${task.surface}-qa`,
      `${task.kind}:${task.surface}:${task.expectedBehavior}`,
      `category:${task.kind}:${task.surface}:${task.category}`]) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const configurationFiles = [
    ['deepseek-pair-preflight.yaml', acceptanceConfig(PREFLIGHT_IDS, true)],
    ['deepseek-pair-60x300.yaml', acceptanceConfig(SPLIT_IDS)],
  ] as const;
  const configHashes: Record<string, string> = {};
  for (const [filename, config] of configurationFiles) {
    const content = stringify(config, { lineWidth: 0 });
    await writeImmutable(join(out, filename), content);
    configHashes[filename] = sha256(content);
  }
  const manifest = {
    version: 'pair-acceptance-split/v1', sourceRevision: FROZEN_SOURCE,
    split: { path: SPLIT_PATH, sha256: sha256(splitBytes) },
    questions: { path: QUESTIONS_PATH, sha256: sha256(questionBytes) },
    selectedIdsSha256: sha256(JSON.stringify(SPLIT_IDS)), selectedTaskIds: SPLIT_IDS,
    preflightTaskIds: PREFLIGHT_IDS, counts, tasks, configurationSha256: configHashes,
    interpretation: 'One frozen split; descriptive acceptance only. Notes and todos are benchmark tool surfaces. Raw full-history context is unchanged.',
  };
  await writeImmutable(join(out, 'pair-split-02.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDirectory: out, manifest, configPaths: configurationFiles.map(([name]) => join(out, name)) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--output-dir');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: prepare-pair-acceptance.ts --output-dir <configs-directory>');
  prepareAcceptance(process.argv[index + 1]).then(result => {
    console.log(JSON.stringify({ ...result, manifest: join(result.outputDirectory, 'pair-split-02.manifest.json') }, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
