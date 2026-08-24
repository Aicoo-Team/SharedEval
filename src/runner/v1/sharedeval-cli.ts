#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  applySharedevalOverridesV1,
  loadSharedevalRunConfigV1,
  MAX_SHAREDEVAL_TICKS_V1,
  type SharedevalCliOverridesV1,
} from './sharedeval-config.js';
import { resolveWorkflow, type ResolvedSharedevalWorkflowV1 } from './workflow.js';

export type SharedevalCliOptionsV1 = SharedevalCliOverridesV1 & {
  configPath: string;
  check: boolean;
  workflow: ResolvedSharedevalWorkflowV1;
};

export function parseSharedevalCliArgumentsV1(argv: string[]): SharedevalCliOptionsV1 {
  let configPath: string | undefined;
  let check = false;
  let mode: 'multi' | 'single' | undefined;
  let legacy = false;
  let maxTicks: number | undefined;
  const taskIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'multi' || argument === 'single') {
      if (mode) throw new Error('Sharedeval accepts only one workflow mode');
      mode = argument;
      continue;
    }
    if (argument === '--legacy') {
      if (legacy) throw new Error('Sharedeval accepts --legacy only once');
      legacy = true;
      continue;
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--config' || argument === '-c') {
      configPath = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--config=')) {
      configPath = requiredInlineValue(argument, '--config=');
      continue;
    }
    if (argument === '--task') {
      taskIds.push(requiredValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--task=')) {
      taskIds.push(requiredInlineValue(argument, '--task='));
      continue;
    }
    if (argument === '--tasks') {
      taskIds.push(...parseTaskList(requiredValue(argv, index, argument), argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--tasks=')) {
      taskIds.push(...parseTaskList(requiredInlineValue(argument, '--tasks='), '--tasks'));
      continue;
    }
    if (argument === '--max-ticks') {
      maxTicks = parseMaxTicks(requiredValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--max-ticks=')) {
      maxTicks = parseMaxTicks(requiredInlineValue(argument, '--max-ticks='));
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      throw new Error(usage());
    }
    throw new Error(`Unknown Sharedeval argument: ${argument}`);
  }

  if (!configPath) throw new Error(`Missing --config\n\n${usage()}`);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Sharedeval task overrides must be unique');
  }
  return {
    configPath,
    check,
    ...(taskIds.length === 0 ? {} : { taskIds }),
    ...(maxTicks === undefined ? {} : { maxTicks }),
    workflow: resolveWorkflow([
      ...(mode === undefined ? [] : [mode]),
      ...(legacy ? ['--legacy'] : []),
    ]),
  };
}

export async function mainSharedevalV1(argv = process.argv.slice(2)): Promise<number> {
  const options = parseSharedevalCliArgumentsV1(argv);
  if (options.workflow.protocol !== 'files') {
    return dispatchLegacyV1(options);
  }

  if (await isPactRunConfigV1(options.configPath)) {
    throw new Error('pact-run/v1 configurations require --legacy; use sharedeval-run/v1 for file workflows');
  }
  const config = await loadSharedevalRunConfigV1(options.configPath);
  const effective = applySharedevalOverridesV1(config, options.workflow, options);
  if (options.check) {
    process.stdout.write(`${JSON.stringify({
      valid: true,
      config: config.sourcePath,
      workflow: effective.workflow,
      benchmark: effective.benchmark,
      configDigest: effective.configDigest,
      note: 'Configuration check does not call the model API.',
    }, null, 2)}\n`);
    return 0;
  }
  throw new Error(
    'File-driven Sharedeval execution is not available yet; use --check or single --legacy for the existing runner',
  );
}

async function dispatchLegacyV1(options: SharedevalCliOptionsV1): Promise<number> {
  if (options.taskIds || options.maxTicks !== undefined) {
    throw new Error('Task and tick overrides are not supported by the legacy PACT runner');
  }
  if (options.workflow.id !== 'legacy-single-prompt') {
    throw new Error('legacy-multi-transcript is not available in this runner; use single --legacy');
  }
  return runLegacyPactCliV1([
    '--config',
    options.configPath,
    ...(options.check ? ['--check'] : []),
  ]);
}

function runLegacyPactCliV1(argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'src/runner/v1/cli.ts', ...argv],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Legacy PACT runner stopped by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function isPactRunConfigV1(configPath: string): Promise<boolean> {
  const source = await readFile(configPath, 'utf8');
  return /^\s*apiVersion:\s*["']?pact-run\/v1["']?\s*$/m.test(source);
}

function requiredValue(argv: string[], index: number, argument: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
  return value;
}

function requiredInlineValue(argument: string, prefix: string): string {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

function parseTaskList(value: string, argument: string): string[] {
  const taskIds = value.split(',').map(taskId => taskId.trim()).filter(Boolean);
  if (taskIds.length === 0) throw new Error(`${argument} requires at least one task id`);
  return taskIds;
}

function parseMaxTicks(value: string): number {
  const maxTicks = Number(value);
  if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0 || maxTicks > MAX_SHAREDEVAL_TICKS_V1) {
    throw new Error('--max-ticks must be a positive safe integer');
  }
  return maxTicks;
}

function usage(): string {
  return 'Usage: npm run sharedeval -- [multi|single] [--legacy] --config <sharedeval-run.yaml> [--task <id>|--tasks <id,...>] [--max-ticks <count>] [--check]\n';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = await mainSharedevalV1();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sharedeval runner error: ${message}\n`);
    process.exitCode = 1;
  }
}
