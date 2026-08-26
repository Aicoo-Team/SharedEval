#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  applySharedevalOverridesV1,
  loadSharedevalRunConfigV1,
  MAX_SHAREDEVAL_TICKS_V1,
  type SharedevalCliOverridesV1,
} from './sharedeval-config.js';
import {
  runSharedevalProductionV1,
  type RunSharedevalProductionV1Options,
  type SharedevalProductionRunV1,
} from './sharedeval-production.js';
import { resolveWorkflow, type ResolvedSharedevalWorkflowV1 } from './workflow.js';

export type SharedevalCliOptionsV1 = SharedevalCliOverridesV1 & Readonly<{
  configPath: string;
  check: boolean;
  runId?: string;
  workflow: ResolvedSharedevalWorkflowV1;
}>;

export type SharedevalCliDependenciesV1 = Readonly<{
  runProduction?: (
    input: RunSharedevalProductionV1Options,
  ) => Promise<SharedevalProductionRunV1>;
  writeOutput?: (source: string) => void;
}>;

export function parseSharedevalCliArgumentsV1(argv: readonly string[]): SharedevalCliOptionsV1 {
  let configPath: string | undefined;
  let check = false;
  let mode: 'multi' | 'single' | undefined;
  let runId: string | undefined;
  let maxTicks: number | undefined;
  const taskIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'multi' || argument === 'single') {
      if (mode !== undefined) throw new Error('Sharedeval accepts only one workflow mode');
      mode = argument;
      continue;
    }
    if (argument === '--legacy') {
      throw new Error('Legacy workflows are not supported');
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--run-id') {
      if (runId !== undefined) throw new Error('Sharedeval accepts --run-id only once');
      runId = parseRunId(requiredValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--run-id=')) {
      if (runId !== undefined) throw new Error('Sharedeval accepts --run-id only once');
      runId = parseRunId(requiredInlineValue(argument, '--run-id='));
      continue;
    }
    if (argument === '--config' || argument === '-c') {
      if (configPath !== undefined) throw new Error('Sharedeval accepts --config only once');
      configPath = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--config=')) {
      if (configPath !== undefined) throw new Error('Sharedeval accepts --config only once');
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
      taskIds.push(...parseTaskList(requiredValue(argv, index, argument)));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--tasks=')) {
      taskIds.push(...parseTaskList(requiredInlineValue(argument, '--tasks=')));
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
    throw new Error('Unknown Sharedeval argument');
  }

  const workflow = resolveWorkflow(mode === undefined ? [] : [mode]);
  if (!configPath) throw new Error(`Missing --config\n\n${usage()}`);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Sharedeval task overrides must be unique');
  }
  return Object.freeze({
    configPath,
    check,
    ...(runId === undefined ? {} : { runId }),
    ...(taskIds.length === 0 ? {} : { taskIds }),
    ...(maxTicks === undefined ? {} : { maxTicks }),
    workflow,
  });
}

export async function mainSharedevalV1(
  argv = process.argv.slice(2),
  dependencies: SharedevalCliDependenciesV1 = {},
): Promise<number> {
  const options = parseSharedevalCliArgumentsV1(argv);
  let config;
  try {
    config = await loadSharedevalRunConfigV1(options.configPath);
  } catch {
    throw new Error('Sharedeval run configuration is invalid');
  }
  const effective = applySharedevalOverridesV1(config, options.workflow, options);
  const writeOutput = dependencies.writeOutput ?? (source => process.stdout.write(source));
  if (options.check) {
    writeOutput(`${JSON.stringify({
      valid: true,
      config: config.sourcePath,
      workflow: effective.workflow,
      benchmark: effective.benchmark,
      budget: effective.budget,
      configDigest: effective.configDigest,
      note: 'Configuration check does not call a model or SharedOS.',
    }, null, 2)}\n`);
    return 0;
  }
  if (!options.runId) throw new Error('--run-id is required for execution');
  const production = await (dependencies.runProduction ?? runSharedevalProductionV1)({
    config: effective,
    configRootDir: config.rootDir,
    runId: options.runId,
  });
  writeOutput(`${JSON.stringify({
    runId: production.runId,
    workflowId: production.workflowId,
    runRoot: production.runRoot,
    sourceRevision: production.sourceRevision,
  }, null, 2)}\n`);
  return 0;
}

function requiredValue(argv: readonly string[], index: number, argument: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
  return value;
}

function requiredInlineValue(argument: string, prefix: string): string {
  const value = argument.slice(prefix.length);
  if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
  return value;
}

function parseTaskList(value: string): string[] {
  const taskIds = value.split(',').map(taskId => taskId.trim()).filter(Boolean);
  if (taskIds.length === 0) throw new Error('--tasks requires at least one task id');
  return taskIds;
}

function parseMaxTicks(value: string): number {
  const maxTicks = Number(value);
  if (!Number.isSafeInteger(maxTicks) || maxTicks <= 0 || maxTicks > MAX_SHAREDEVAL_TICKS_V1) {
    throw new Error('--max-ticks must be a positive safe integer up to 10000');
  }
  return maxTicks;
}

function parseRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Sharedeval run id is invalid');
  }
  return value;
}

function usage(): string {
  return 'Usage: npm run sharedeval -- [multi|single] --config <sharedeval-run.yaml> --run-id <id> [--task <id>|--tasks <id,...>] [--max-ticks <count>] [--check]\n';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = await mainSharedevalV1();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown failure';
    process.stderr.write(`Sharedeval runner error: ${message}\n`);
    process.exitCode = 1;
  }
}
