#!/usr/bin/env -S npx tsx
/**
 * Offline relationship-v2 re-scoring CLI for completed category-graded
 * files-single grid cells.
 *
 *   npx tsx scripts/experiments/rescore-relationship-grid.ts \
 *     --cell deepseek-d1-r3=/grid/deepseek-d1-r3 \
 *     --cell glm-d1-r3=/glm-fix/glm-d1-r3 \
 *     --output /out/rescore.json \
 *     --detail-dir /out/tasks --include-text
 *
 * Every scored task is replayed through the repository evaluator from the
 * committed ledger evidence; the category replay must reproduce the run
 * artifacts exactly before any relationship number is emitted. Run artifacts
 * are only ever read; all output goes to the paths given here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rescorePactPairRelationshipGridV1,
  PACT_PAIR_RELATIONSHIP_ACTIVE_METRICS_V1,
  type PactPairRelationshipRescoreCellV1,
  type PactPairRescoreRateV1,
} from '../../src/suites/pact-pair/relationship-rescore.js';

type CliOptions = {
  cells: Array<{ label: string; cellDir: string }>;
  datasetRoot: string;
  output?: string;
  detailDir?: string;
  includeText: boolean;
};

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function usage(): string {
  return [
    'usage: rescore-relationship-grid.ts --cell <label>=<cell-dir> [...] ',
    '         [--dataset-root <dir>] [--output <file.json>]',
    '         [--detail-dir <dir>] [--include-text]',
    '',
    '  --cell          repeatable; label plus the cell directory that holds',
    '                  the run root (config.yaml + runs/<runId>/single/...)',
    '  --dataset-root  repository root providing dataset/ (default: this repo)',
    '  --output        write the grid report JSON here',
    '  --detail-dir    write per-cell task detail JSONL files here',
    '  --include-text  include reconstructed request/reply text in details',
    '',
  ].join('\n');
}

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    cells: [],
    datasetRoot: repositoryRoot,
    includeText: false,
  };
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (flag === '--cell') {
      const value = valueAfter(index, flag);
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`--cell requires <label>=<cell-dir>, got ${value}`);
      }
      options.cells.push({
        label: value.slice(0, separator),
        cellDir: value.slice(separator + 1),
      });
      index += 1;
      continue;
    }
    if (flag === '--dataset-root') {
      options.datasetRoot = valueAfter(index, flag);
      index += 1;
      continue;
    }
    if (flag === '--output') {
      options.output = valueAfter(index, flag);
      index += 1;
      continue;
    }
    if (flag === '--detail-dir') {
      options.detailDir = valueAfter(index, flag);
      index += 1;
      continue;
    }
    if (flag === '--include-text') {
      options.includeText = true;
      continue;
    }
    throw new Error(`unknown flag ${flag}\n${usage()}`);
  }
  if (options.cells.length === 0) {
    throw new Error(`at least one --cell is required\n${usage()}`);
  }
  return options;
}

function formatRate(rate: PactPairRescoreRateV1): string {
  if (rate.value === null) return 'n/a';
  return `${(rate.value * 100).toFixed(1)}% (${rate.numerator}/${rate.denominator})`;
}

function printCell(cell: PactPairRelationshipRescoreCellV1): void {
  const lines: string[] = [];
  lines.push(
    `=== ${cell.label} — ${cell.model} ${cell.policy}×${cell.requester} `
    + `(${cell.runId}) ===`,
  );
  lines.push(
    `  tasks: ${cell.taskCounts.scored}/${cell.taskCounts.selected} scored `
    + `${JSON.stringify(cell.taskCounts.byStatus)}`,
  );
  if (Object.keys(cell.taskCounts.errorCodes).length > 0) {
    lines.push(`  errorCodes: ${JSON.stringify(cell.taskCounts.errorCodes)}`);
  }
  lines.push('  relationship-active (v2 contract) vs category-active:');
  const categoryActive: Record<string, PactPairRescoreRateV1> = {
    informationUtility: cell.category.policyComplianceInformationUtility,
    informationSecurity: cell.category.policyComplianceInformationSecurity,
    actionUtility: cell.category.actionUtility,
    actionSafety: cell.category.actionSafety,
    falseRefusalRate: cell.category.policyComplianceFalseRefusalRate,
    leakRate: cell.category.policyComplianceLeakRate,
  };
  for (const metric of PACT_PAIR_RELATIONSHIP_ACTIVE_METRICS_V1) {
    const left = cell.relationshipActive[metric];
    const right = categoryActive[metric];
    lines.push(
      `    ${metric.padEnd(22)} ${formatRate(left).padEnd(18)}`
      + ` category ${right ? formatRate(right) : 'n/a'}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(): void {
  const options = parseCli(process.argv.slice(2));
  if (options.detailDir) mkdirSync(resolve(options.detailDir), { recursive: true });
  const report = rescorePactPairRelationshipGridV1({
    cells: options.cells,
    datasetRoot: options.datasetRoot,
    includeText: options.includeText,
    onCell: result => {
      printCell(result.cell);
      if (options.detailDir) {
        const path = join(
          resolve(options.detailDir),
          `${result.cell.label}.tasks.jsonl`,
        );
        writeFileSync(
          path,
          `${result.tasks.map(task => JSON.stringify(task)).join('\n')}\n`,
        );
      }
    },
  });
  if (options.output) {
    const path = resolve(options.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`report written to ${path}\n`);
  }
}

main();
