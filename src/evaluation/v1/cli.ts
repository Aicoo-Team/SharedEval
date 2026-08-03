#!/usr/bin/env tsx
/**
 * Evaluation tool CLI.
 *
 *   tsx src/evaluation/v1/cli.ts golden-key  --results <results.jsonl> --questions <questions.json> [--task-ids 1-200] [--out <dir>]
 *   tsx src/evaluation/v1/cli.ts message     --results <results.jsonl> --questions <questions.json> [--task-ids ...] [--out <dir>]
 *   tsx src/evaluation/v1/cli.ts global-leak --results <results.jsonl> --questions <questions.json> [--trace <trace.jsonl>] [--task-ids ...] [--out <dir>]
 *
 * Outputs (per check, under --out, default alongside the results file):
 *   <check>.evaluations.jsonl  one EvaluationRecord per task (fixed denominator)
 *   <check>.summary.json       CheckSummary
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CheckSummary, EvaluationRecord } from './contracts.js';
import {
  indexByTask,
  loadQuestions,
  loadResults,
  parseTaskIds,
} from './input.js';
import { runGoldenKeyCheck } from './golden-key-check.js';
import { runMessageCheck } from './message-check.js';
import { loadTraceDecisionText, runGlobalLeakCheck } from './global-leak-check.js';

const CHECKS = ['golden-key', 'message', 'global-leak'] as const;
type CheckName = (typeof CHECKS)[number];

function usage(): never {
  console.error(
    'usage: cli.ts <golden-key|message|global-leak> --results <file> --questions <file> '
    + '[--task-ids 1-200,301] [--trace <file>] [--protected-categories a,b] [--out <dir>]',
  );
  process.exit(2);
}

function flagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`missing value for ${flag}`);
    process.exit(2);
  }
  return value;
}

export function runCli(argv: string[]): { evaluations: EvaluationRecord[]; summary: CheckSummary; outDir: string } {
  const check = argv[0] as CheckName | undefined;
  if (!check || !CHECKS.includes(check)) usage();
  const resultsPath = flagValue(argv, '--results');
  const questionsPath = flagValue(argv, '--questions');
  if (!resultsPath || !questionsPath) usage();

  const questions = loadQuestions(resolve(questionsPath));
  const records = indexByTask(loadResults(resolve(resultsPath)));
  const taskIds = parseTaskIds(flagValue(argv, '--task-ids'))
    ?? [...questions.keys()];
  const protectedCategories = flagValue(argv, '--protected-categories')
    ?.split(',').map(s => s.trim()).filter(Boolean);

  let output: { evaluations: EvaluationRecord[]; summary: CheckSummary };
  if (check === 'golden-key') {
    output = runGoldenKeyCheck({ taskIds, questions, records });
  } else if (check === 'message') {
    output = runMessageCheck({ taskIds, questions, records, protectedCategories });
  } else {
    const tracePath = flagValue(argv, '--trace');
    output = runGlobalLeakCheck({
      taskIds,
      questions,
      records,
      protectedCategories,
      traceDecisionText: tracePath ? loadTraceDecisionText(resolve(tracePath)) : undefined,
    });
  }

  const outDir = resolve(flagValue(argv, '--out') ?? join(dirname(resolve(resultsPath)), 'eval_output'));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${check}.evaluations.jsonl`),
    output.evaluations.map(row => JSON.stringify(row)).join('\n') + '\n',
  );
  writeFileSync(
    join(outDir, `${check}.summary.json`),
    JSON.stringify(output.summary, null, 2) + '\n',
  );
  return { ...output, outDir };
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]).replace(/\.ts$/, '') === resolve(new URL(import.meta.url).pathname).replace(/\.ts$/, '');

if (isDirectRun) {
  const { summary, outDir } = runCli(process.argv.slice(2));
  if (summary.metricClass === 'diagnostic') {
    console.log(
      'DIAGNOSTIC METRIC: scan-based; do not report alongside direct-response metrics.',
    );
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${outDir}`);
}
