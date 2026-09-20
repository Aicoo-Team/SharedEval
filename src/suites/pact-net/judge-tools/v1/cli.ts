#!/usr/bin/env tsx
/**
 * PACT-Net v2 disclosure-judge CLI.
 *
 *   npm run judge:pact-net -- build [--check]
 *   npm run judge:pact-net -- run --fake oracle
 *   npm run judge:pact-net -- run --model DeepSeek-V4-Flash-0731 --sample 4 --votes 3 --max-calls 15
 *
 * Outputs, under --out (default runs/pact-net-judge/<label>):
 *   judgments.json   one record per item: cache key, rubric hash, prompt hash,
 *                    model id, every raw response, every parsed verdict
 *   score.json       per-variant rates, the exit criteria, the disagreement rate
 *   run.json         seed, order, model, votes, live call count
 *
 * Live calls are serialized and capped. --max-calls is a hard stop, not a target:
 * the Azure quota is a subscription-level pool shared with other experiments.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadPactNetV2ProbesV1,
  readPactNetAgentIdentityV1,
} from '../../v2-probes.js';
import { pactAzureOpenAIModelConfigV1Schema, resolvePactRunModelApiKeyV1 } from '../../../../runner/v1/model-config.js';
import {
  buildPactNetJudgeCalibrationSetV1,
  PACT_NET_JUDGE_CONSTRUCTION_RULES_V1,
} from './calibration-set.js';
import { PACT_NET_JUDGE_RUBRIC_V1, pactNetJudgeRubricHashV1 } from './rubric.js';
import {
  azurePactNetJudgeBackendV1,
  fakePactNetJudgeBackendV1,
  loadPactNetJudgeCacheV1,
  runPactNetJudgeV1,
  savePactNetJudgeCacheV1,
  type PactNetJudgeBackendV1,
  type PactNetJudgeFakeModeV1,
} from './judge.js';
import { scorePactNetJudgeCalibrationV1 } from './scoring.js';
import type {
  PactNetJudgeCalibrationItemV1,
  PactNetJudgeCalibrationSetV1,
  PactNetJudgeVariantV1,
} from './contracts.js';

export const PACT_NET_JUDGE_CALIBRATION_DIR_V1 = join(
  'dataset', 'pact-net', 'judge-calibration', 'v1',
);
const SET_FILE_V1 = 'calibration-set.json';
const DUMP_FILE_V1 = 'calibration-set.txt';

function usage(): never {
  console.error(
    'usage: cli.ts build [--check] [--include-machine-negatives]\n'
    + '       cli.ts run [--fake oracle|matcher|always-disclosed|always-refused]\n'
    + '                  [--model <azure deployment>] [--votes 3] [--seed 20260921]\n'
    + '                  [--sample <n per variant>] [--max-calls <n>] [--out <dir>]\n'
    + '                  [--cache <file>] [--label <name>]',
  );
  process.exit(2);
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`missing value for ${flag}`);
    process.exit(2);
  }
  return value;
}

function humanDumpV1(set: PactNetJudgeCalibrationSetV1): string {
  const lines: string[] = [
    'PACT-Net v2 disclosure-judge calibration set',
    `rubric sha256: ${set.rubricHash}`,
    `probes: ${set.probeCounts.total} total, ${set.probeCounts.machineCheckable} `
      + `machine-checkable, ${set.probeCounts.rubric} rubric`,
    `items: ${set.items.length}   refused by a construction gate: ${set.skipped.length}`,
    '',
    'Construction rules',
    ...Object.entries(PACT_NET_JUDGE_CONSTRUCTION_RULES_V1)
      .map(([id, rule]) => `  ${id}\n    ${rule}`),
    '',
    'Items',
  ];
  for (const item of set.items) {
    lines.push(
      '-'.repeat(96),
      `${item.itemId}   [${item.probeClass}]   label=${item.label}`,
      `rule: ${item.constructionRuleId}`,
      `ask : ${item.ask}`,
      `${item.requesterAgent} asked ${item.responderAgent}`,
      'reply:',
      ...item.replyText.split('\n').map(line => `  ${line}`),
    );
  }
  lines.push('', 'Refused by a construction gate');
  for (const skip of set.skipped) {
    lines.push(`  ${skip.probeId}#${skip.variant} [${skip.probeClass}] ${skip.reason}`,
      `    ${skip.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

function identitiesForV1(
  items: readonly PactNetJudgeCalibrationItemV1[],
  rootDir?: string,
): Map<string, { displayName: string; role: string }> {
  const options = rootDir === undefined ? {} : { rootDir };
  const identities = new Map<string, { displayName: string; role: string }>();
  for (const agent of new Set(items.flatMap(i => [i.requesterAgent, i.responderAgent]))) {
    const identity = readPactNetAgentIdentityV1(agent, options);
    identities.set(agent, { displayName: identity.name, role: identity.role });
  }
  return identities;
}

/**
 * A round-robin sample across variants rather than the first n of the shuffle.
 * Twelve random items can easily hold no positive at all, and a smoke that never
 * exercised (b) has told us nothing about recall.
 */
function sampleAcrossVariantsV1(
  items: readonly PactNetJudgeCalibrationItemV1[],
  perVariant: number,
): PactNetJudgeCalibrationItemV1[] {
  const order: PactNetJudgeVariantV1[] = ['b', 'a', 'c1', 'c2', 'c3'];
  return order.flatMap(variant =>
    items.filter(item => item.variant === variant).slice(0, perVariant));
}

function buildCommand(argv: readonly string[], rootDir: string): number {
  const set = buildPactNetJudgeCalibrationSetV1({
    rootDir,
    includeMachineNegatives: argv.includes('--include-machine-negatives'),
  });
  const dir = join(rootDir, PACT_NET_JUDGE_CALIBRATION_DIR_V1);
  const json = `${JSON.stringify(set, null, 2)}\n`;
  const dump = humanDumpV1(set);
  if (argv.includes('--check')) {
    for (const [file, expected] of [[SET_FILE_V1, json], [DUMP_FILE_V1, dump]] as const) {
      let actual: string;
      try {
        actual = readFileSync(join(dir, file), 'utf8');
      } catch {
        console.error(`${file} is missing; run the build without --check`);
        return 1;
      }
      if (actual !== expected) {
        console.error(`${file} is out of date; run the build without --check`);
        return 1;
      }
    }
    console.log(`calibration set is in sync: ${set.items.length} items`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SET_FILE_V1), json);
  writeFileSync(join(dir, DUMP_FILE_V1), dump);
  const byVariant = new Map<string, number>();
  for (const item of set.items) {
    byVariant.set(`${item.variant}/${item.label}`,
      (byVariant.get(`${item.variant}/${item.label}`) ?? 0) + 1);
  }
  console.log(`probes: ${set.probeCounts.total} (${set.probeCounts.rubric} rubric, `
    + `${set.probeCounts.machineCheckable} machine-checkable)`);
  console.log(`items: ${set.items.length}`, Object.fromEntries([...byVariant].sort()));
  const skipReasons = new Map<string, number>();
  for (const skip of set.skipped) {
    skipReasons.set(skip.reason, (skipReasons.get(skip.reason) ?? 0) + 1);
  }
  console.log('refused by a construction gate:', Object.fromEntries([...skipReasons].sort()));
  console.log(`written to ${join(PACT_NET_JUDGE_CALIBRATION_DIR_V1, SET_FILE_V1)}`);
  return 0;
}

async function runCommand(argv: readonly string[], rootDir: string): Promise<number> {
  const dir = join(rootDir, PACT_NET_JUDGE_CALIBRATION_DIR_V1);
  const set = JSON.parse(
    readFileSync(join(dir, SET_FILE_V1), 'utf8'),
  ) as PactNetJudgeCalibrationSetV1;
  const rubricHash = pactNetJudgeRubricHashV1();
  if (set.rubricHash !== rubricHash) {
    console.error('the committed calibration set was built against a different rubric; '
      + 'rebuild it so the cache keys and the judged rubric agree');
    return 1;
  }

  const fake = flagValue(argv, '--fake') as PactNetJudgeFakeModeV1 | null;
  const deployment = flagValue(argv, '--model') ?? 'DeepSeek-V4-Flash-0731';
  const votesPerItem = Number.parseInt(flagValue(argv, '--votes') ?? '3', 10);
  const seed = Number.parseInt(flagValue(argv, '--seed') ?? '20260921', 10);
  const sample = flagValue(argv, '--sample');
  const maxCalls = Number.parseInt(flagValue(argv, '--max-calls') ?? '15', 10);
  const label = flagValue(argv, '--label') ?? (fake ? `fake-${fake}` : `live-${deployment}`);
  const outDir = resolve(flagValue(argv, '--out') ?? join(rootDir, 'runs', 'pact-net-judge', label));
  const cachePath = resolve(flagValue(argv, '--cache')
    ?? join(rootDir, 'runs', 'pact-net-judge', 'cache.json'));

  const items = sample
    ? sampleAcrossVariantsV1(set.items, Number.parseInt(sample, 10))
    : set.items;
  const identities = identitiesForV1(items, rootDir);
  const modelId = fake ? `fake:${fake}` : deployment;

  let backend: PactNetJudgeBackendV1;
  let liveBudget = 0;
  if (fake) {
    const { probes } = loadPactNetV2ProbesV1({ rootDir });
    backend = fakePactNetJudgeBackendV1(fake, {
      items,
      identities,
      forbiddenFactByProbeId: new Map(probes.map(p => [p.probeId, p.forbiddenFact])),
    });
  } else {
    const endpoint = process.env['AZURE_OPENAI_ENDPOINT'];
    if (!endpoint) {
      console.error('AZURE_OPENAI_ENDPOINT is not set');
      return 1;
    }
    const model = pactAzureOpenAIModelConfigV1Schema.parse({
      provider: 'azure-openai',
      endpoint,
      deployment,
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      maxOutputTokens: 512,
    });
    liveBudget = maxCalls;
    const needed = items.length * votesPerItem;
    console.log(`live run: ${items.length} items x ${votesPerItem} votes = ${needed} calls; `
      + `budget ${maxCalls}, concurrency 1`);
    backend = azurePactNetJudgeBackendV1({
      model,
      apiKey: resolvePactRunModelApiKeyV1(model),
      maxCalls,
      temperature: Number.parseFloat(flagValue(argv, '--temperature') ?? '0.2'),
    });
  }

  const cache = loadPactNetJudgeCacheV1(cachePath);
  const { judgments, order, liveCalls } = await runPactNetJudgeV1({
    items, identities, backend, modelId, rubricHash, votesPerItem, seed, cache,
    onProgress: (done, total, itemId, cached) => {
      if (!fake) console.log(`  [${done}/${total}] ${itemId}${cached ? ' (cached)' : ''}`);
    },
  });
  savePactNetJudgeCacheV1(cachePath, cache);

  const score = scorePactNetJudgeCalibrationV1({
    items, judgments, modelId, rubricHash, votesPerItem,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'judgments.json'), `${JSON.stringify(judgments, null, 2)}\n`);
  writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({
    label, modelId, rubricHash, seed, votesPerItem, itemCount: items.length,
    liveCalls, liveBudget, order,
  }, null, 2)}\n`);

  console.log(`\nmodel ${score.modelId}   items ${score.itemsJudged}   `
    + `votes/item ${score.votesPerItem}   live calls ${liveCalls}`);
  for (const rate of score.rates) {
    console.log(`  ${rate.variant.padEnd(14)} judged=${String(rate.judged).padStart(3)} `
      + `flagged=${String(rate.flaggedDisclosed).padStart(3)} `
      + `unparseable=${rate.unparseable} `
      + `rate=${rate.rate === null ? 'n/a' : rate.rate.toFixed(3)}`);
  }
  console.log(`  disagreement  ${score.disagreementRate === null
    ? 'n/a' : score.disagreementRate.toFixed(3)}`);
  for (const criterion of score.exitCriteria) {
    const mark = criterion.met === null ? '·' : criterion.met ? 'PASS' : 'FAIL';
    console.log(`  ${mark.padEnd(5)} ${criterion.name} ${criterion.threshold} `
      + `observed=${criterion.observed === null ? 'n/a' : criterion.observed.toFixed(3)}`);
  }
  if (score.failingVariants.length > 0) {
    console.log(`\nFAILS: ${score.failingVariants.join('; ')}`);
  }
  console.log(`written to ${outDir}`);
  return 0;
}

export async function runCli(argv: string[], rootDir: string): Promise<number> {
  const command = argv[0];
  if (command === 'build') return buildCommand(argv.slice(1), rootDir);
  if (command === 'run') return runCommand(argv.slice(1), rootDir);
  if (command === 'rubric') { console.log(PACT_NET_JUDGE_RUBRIC_V1); return 0; }
  usage();
}

const repositoryRoot = new URL('../../../../../', import.meta.url).pathname;
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]).replace(/\.ts$/, '')
    === resolve(new URL(import.meta.url).pathname).replace(/\.ts$/, '');

if (isDirectRun) {
  runCli(process.argv.slice(2), repositoryRoot)
    .then(code => { process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
