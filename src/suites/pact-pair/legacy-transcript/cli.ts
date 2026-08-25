import {
  loadLegacyMultiConfigV1,
  MAX_LEGACY_MULTI_TICKS_V1,
  type LegacyMultiConfigV1,
  type LegacyMultiOverridesV1,
  type ResolvedLegacyMultiConfigV1,
} from './config.js';
import {
  runLegacyMultiTranscriptBenchmarkV1,
  type LegacyMultiBenchmarkResultV1,
  type RunLegacyMultiTranscriptBenchmarkOptionsV1,
} from './runner.js';

export type LegacyMultiTranscriptWorkflowIdV1 =
  | 'files-multi'
  | 'files-single'
  | 'legacy-single-prompt'
  | 'legacy-multi-transcript';

export type LegacyMultiTranscriptRouteV1 = {
  handled: boolean;
  workflowId: LegacyMultiTranscriptWorkflowIdV1;
};

export type LegacyMultiTranscriptCliOptionsV1 = LegacyMultiOverridesV1 & {
  configPath: string;
  check: boolean;
};

export type LegacyMultiTranscriptCliDependenciesV1 = {
  loadConfig?: (configPath: string) => Promise<ResolvedLegacyMultiConfigV1>;
  runBenchmark?: (
    options: RunLegacyMultiTranscriptBenchmarkOptionsV1,
  ) => Promise<LegacyMultiBenchmarkResultV1>;
  writeOutput?: (output: string) => void;
  repositoryRoot?: string;
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
};

/** Resolves only the four command cells; it never reads config or assets. */
export function classifyLegacyMultiTranscriptRouteV1(
  routeArguments: readonly string[],
): LegacyMultiTranscriptRouteV1 {
  let mode: 'multi' | 'single' = 'multi';
  let modeSet = false;
  let legacy = false;
  for (const argument of routeArguments) {
    if (argument === 'multi' || argument === 'single') {
      if (modeSet) throw new Error('Sharedeval accepts only one workflow mode');
      mode = argument;
      modeSet = true;
      continue;
    }
    if (argument === '--legacy') {
      if (legacy) throw new Error('Sharedeval accepts --legacy only once');
      legacy = true;
      continue;
    }
    throw new Error(`Unknown Sharedeval workflow argument: ${argument}`);
  }
  const workflowId: LegacyMultiTranscriptWorkflowIdV1 = legacy
    ? mode === 'multi' ? 'legacy-multi-transcript' : 'legacy-single-prompt'
    : mode === 'multi' ? 'files-multi' : 'files-single';
  return { handled: workflowId === 'legacy-multi-transcript', workflowId };
}

export function parseLegacyMultiTranscriptCliArgumentsV1(
  argv: readonly string[],
): LegacyMultiTranscriptCliOptionsV1 {
  if (argv.some(argument => argument === '--resume' || argument.startsWith('--resume='))) {
    throw new Error(
      '--resume is not supported by legacy-multi-transcript/v1; start a new run instead',
    );
  }

  let mode: 'multi' | 'single' = 'multi';
  let modeSet = false;
  let legacy = false;
  let configPath: string | undefined;
  let check = false;
  let maxTicks: number | undefined;
  let taskMode: 'task' | 'tasks' | undefined;
  let taskIds: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'multi' || argument === 'single') {
      if (modeSet) throw new Error('Legacy multi accepts only one workflow mode');
      mode = argument;
      modeSet = true;
      continue;
    }
    if (argument === '--legacy') {
      if (legacy) throw new Error('Legacy multi accepts --legacy only once');
      legacy = true;
      continue;
    }
    if (argument === '--check') {
      if (check) throw new Error('Legacy multi accepts --check only once');
      check = true;
      continue;
    }
    if (argument === '--config' || argument === '-c') {
      if (configPath !== undefined) throw new Error('Legacy multi accepts --config only once');
      configPath = requiredValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--config=')) {
      if (configPath !== undefined) throw new Error('Legacy multi accepts --config only once');
      configPath = requiredInlineValue(argument, '--config=');
      continue;
    }
    if (argument === '--task' || argument?.startsWith('--task=')) {
      assertOneTaskMode(taskMode);
      taskMode = 'task';
      const value = argument === '--task'
        ? requiredValue(argv, index, argument)
        : requiredInlineValue(argument, '--task=');
      if (argument === '--task') index += 1;
      taskIds = [parseTaskId(value, '--task')];
      continue;
    }
    if (argument === '--tasks' || argument?.startsWith('--tasks=')) {
      assertOneTaskMode(taskMode);
      taskMode = 'tasks';
      const value = argument === '--tasks'
        ? requiredValue(argv, index, argument)
        : requiredInlineValue(argument, '--tasks=');
      if (argument === '--tasks') index += 1;
      taskIds = parseTaskList(value);
      continue;
    }
    if (argument === '--max-ticks' || argument?.startsWith('--max-ticks=')) {
      if (maxTicks !== undefined) throw new Error('Legacy multi accepts --max-ticks only once');
      const value = argument === '--max-ticks'
        ? requiredValue(argv, index, argument)
        : requiredInlineValue(argument, '--max-ticks=');
      if (argument === '--max-ticks') index += 1;
      maxTicks = parseMaxTicks(value);
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      throw new Error(legacyMultiTranscriptUsageV1());
    }
    throw new Error(`Unknown legacy multi argument: ${argument}`);
  }

  if (!modeSet || mode !== 'multi' || !legacy) {
    throw new Error(
      'Legacy multi dispatcher requires the explicit `multi --legacy` command route',
    );
  }
  if (!configPath) {
    throw new Error(`Missing --config\n\n${legacyMultiTranscriptUsageV1()}`);
  }
  return {
    configPath,
    check,
    ...(taskIds === undefined ? {} : { taskIds }),
    ...(maxTicks === undefined ? {} : { maxTicks }),
  };
}

/** Entry point used by the SharedEval dispatcher after it has selected the route. */
export async function runLegacyMultiTranscriptCliV1(
  options: LegacyMultiTranscriptCliOptionsV1,
  dependencies: LegacyMultiTranscriptCliDependenciesV1 = {},
): Promise<number> {
  const loadConfig = dependencies.loadConfig ?? loadLegacyMultiConfigV1;
  const runBenchmark = dependencies.runBenchmark ?? runLegacyMultiTranscriptBenchmarkV1;
  const writeOutput = dependencies.writeOutput ?? (output => process.stdout.write(output));
  const loaded = await loadConfig(options.configPath);
  const {
    sourcePath: _sourcePath,
    configDirectory: _configDirectory,
    ...config
  } = loaded;
  const overrides: LegacyMultiOverridesV1 = {
    ...(options.taskIds === undefined ? {} : { taskIds: [...options.taskIds] }),
    ...(options.maxTicks === undefined ? {} : { maxTicks: options.maxTicks }),
  };
  const result = await runBenchmark({
    config: config as LegacyMultiConfigV1,
    overrides,
    rootDir: dependencies.repositoryRoot ?? process.cwd(),
    workingDirectory: dependencies.workingDirectory ?? process.cwd(),
    check: options.check,
    ...(dependencies.environment === undefined
      ? {}
      : { environment: dependencies.environment }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });

  if (result.mode === 'check') {
    if (!options.check) throw new Error('Legacy multi runner returned check mode for a run');
    writeOutput(`${JSON.stringify({
      valid: true,
      workflowId: result.preflight.workflowId,
      protocolId: result.preflight.protocolId,
      metricFamilyId: result.preflight.metricFamilyId,
      preflight: result.preflight,
      note: 'Legacy multi preflight completed without creating factories or calling a model API.',
    }, null, 2)}\n`);
    return 0;
  }
  if (options.check) throw new Error('Legacy multi runner spent during --check');
  writeOutput(`${JSON.stringify({
    workflowId: result.manifest.workflowId,
    protocolId: result.manifest.protocolId,
    metricFamilyId: result.manifest.metricFamilyId,
    runId: result.manifest.runId,
    status: result.manifest.status,
    ...(result.outputDirectory ? { outputDirectory: result.outputDirectory } : {}),
    summary: result.metrics,
  }, null, 2)}\n`);
  return result.manifest.status === 'completed' ? 0 : 1;
}

export async function mainLegacyMultiTranscriptCliV1(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: LegacyMultiTranscriptCliDependenciesV1 = {},
): Promise<number> {
  return runLegacyMultiTranscriptCliV1(
    parseLegacyMultiTranscriptCliArgumentsV1(argv),
    dependencies,
  );
}

export function legacyMultiTranscriptUsageV1(): string {
  return 'Usage: sharedeval multi --legacy --config <pact-run.yaml> '
    + '[--task <id>|--tasks <id,...>] [--max-ticks <count>] [--check]';
}

function assertOneTaskMode(current: 'task' | 'tasks' | undefined): void {
  if (current !== undefined) {
    throw new Error('Legacy multi accepts either --task or --tasks exactly once');
  }
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
  const values = value.split(',').map(taskId => taskId.trim());
  if (values.length === 0 || values.some(taskId => !taskId)) {
    throw new Error('--tasks requires a non-empty comma-separated task list');
  }
  const taskIds = values.map(taskId => parseTaskId(taskId, '--tasks'));
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Legacy multi task overrides must be unique');
  }
  return taskIds;
}

function parseTaskId(value: string, argument: '--task' | '--tasks'): string {
  const taskId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) {
    throw new Error(`${argument} contains an invalid task id`);
  }
  return taskId;
}

function parseMaxTicks(value: string): number {
  const maxTicks = Number(value);
  if (
    !Number.isSafeInteger(maxTicks)
    || maxTicks < 1
    || maxTicks > MAX_LEGACY_MULTI_TICKS_V1
  ) {
    throw new Error(
      `--max-ticks must be between 1 and ${MAX_LEGACY_MULTI_TICKS_V1}`,
    );
  }
  return maxTicks;
}
