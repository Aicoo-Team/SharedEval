#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rescorePactPairRequesterGridV1,
  type PactPairRequesterGridArmV1,
} from '../src/suites/pact-pair/rescore.js';
import {
  PACT_PAIR_REQUESTERS_V1,
  type PactPairRequesterIdV1,
} from '../src/suites/pact-pair/task-loader.js';

type CliOptions = {
  runsRoot: string;
  datasetRoot: string;
  output?: string;
  arms: PactPairRequesterGridArmV1[];
  requesters: PactPairRequesterIdV1[];
  taskIds?: string[];
};

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseCli(argv: string[]): CliOptions {
  let runsRoot: string | undefined;
  let datasetRoot = repositoryRoot;
  let output: string | undefined;
  const arms: PactPairRequesterGridArmV1[] = [];
  let requesters: PactPairRequesterIdV1[] = [...PACT_PAIR_REQUESTERS_V1];
  let taskIds: string[] | undefined;

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
    if (flag === '--runs-root') {
      if (runsRoot) throw new Error('--runs-root may be provided only once');
      runsRoot = valueAfter(index, flag);
      index += 1;
      continue;
    }
    if (flag === '--dataset-root') {
      datasetRoot = valueAfter(index, flag);
      index += 1;
      continue;
    }
    if (flag === '--output') {
      if (output) throw new Error('--output may be provided only once');
      output = valueAfter(index, flag);
      index += 1;
      continue;
    }
    if (flag === '--arm') {
      const value = valueAfter(index, flag);
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error('--arm must use LABEL=RELATIVE_PREFIX');
      }
      arms.push({
        label: value.slice(0, separator),
        prefix: value.slice(separator + 1),
      });
      index += 1;
      continue;
    }
    if (flag === '--requesters') {
      const values = valueAfter(index, flag).split(',').filter(Boolean);
      if (values.some(value =>
        !PACT_PAIR_REQUESTERS_V1.includes(value as PactPairRequesterIdV1))) {
        throw new Error(`--requesters must be a comma list of ${PACT_PAIR_REQUESTERS_V1.join(',')}`);
      }
      requesters = values as PactPairRequesterIdV1[];
      index += 1;
      continue;
    }
    if (flag === '--task-ids') {
      taskIds = valueAfter(index, flag).split(',').filter(Boolean);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${String(flag)}`);
  }

  if (!runsRoot) throw new Error('--runs-root is required');
  if (arms.length === 0) throw new Error('at least one --arm is required');
  return {
    runsRoot: resolve(runsRoot),
    datasetRoot: resolve(datasetRoot),
    ...(output ? { output: resolve(output) } : {}),
    arms,
    requesters,
    ...(taskIds ? { taskIds } : {}),
  };
}

function usage(): string {
  return `Usage: rescore-requester-grid --runs-root PATH --arm LABEL=PREFIX [options]

Options:
  --dataset-root PATH    Dataset checkout (defaults to this repository)
  --output PATH          Also write the deterministic JSON report to PATH
  --arm LABEL=PREFIX     Repeatable run-bucket mapping
  --requesters R0,R1     Requester subset (defaults to R0,R1,R2,R3,R4)
  --task-ids Q1,A1       Task subset (defaults to all 600 tasks)
  --help                 Show this help
`;
}

try {
  const options = parseCli(process.argv.slice(2));
  const report = rescorePactPairRequesterGridV1(options);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, serialized, 'utf8');
  }
  process.stdout.write(serialized);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
