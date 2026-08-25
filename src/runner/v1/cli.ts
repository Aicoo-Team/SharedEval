#!/usr/bin/env node
import {
  loadPactRunConfigV1,
  pactExecutionAdapterIdV1Schema,
  resolvePactRunModelApiKeyV1,
  selectedPactExecutionAdapterV1,
  selectedPactExecutionBackendV1,
  type PactExecutionAdapterIdV1,
} from './config.js';
import {
  inspectPactBenchmarkV1,
  PactPairRunFatalErrorV1,
  runPactBenchmarkV1,
} from './runner.js';
import {
  buildPactCliFailureDiagnosticsV1,
  PACT_CLI_FAILURE_MESSAGE_LIMIT_V1,
  PACT_CLI_FAILURE_TASK_ID_LIMIT_V1,
} from './diagnostics.js';

type CliOptions = {
  configPath: string;
  check: boolean;
  executionAdapter?: PactExecutionAdapterIdV1;
  resume?: string;
};

export async function mainPactRunnerV1(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArguments(argv);
  let config = await loadPactRunConfigV1(options.configPath);
  if (options.executionAdapter) {
    // An explicit CLI override is part of run provenance: it changes the
    // effective config, so it flows through the same strict schema and
    // lands in the reproducibility digest like any config-file setting.
    config = {
      ...config,
      benchmark: {
        ...config.benchmark,
        execution: { adapter: options.executionAdapter },
      },
    };
  }

  if (options.check) {
    const inspection = inspectPactBenchmarkV1(config);
    process.stdout.write(`${JSON.stringify({
      valid: true,
      config: config.sourcePath,
      backend: selectedPactExecutionBackendV1(config),
      execution: { adapter: selectedPactExecutionAdapterV1(config) },
      model: {
        ...(config.model.provider === 'azure-openai'
          ? {
              provider: config.model.provider,
              endpoint: config.model.endpoint,
              deployment: config.model.deployment,
              ...(config.model.apiVersion === undefined
                ? {}
                : { apiVersion: config.model.apiVersion }),
            }
          : {
              provider: config.model.provider,
              baseUrl: config.model.baseUrl,
              model: config.model.model,
              ...(config.model.seed === undefined
                ? {}
                : { seed: config.model.seed }),
              ...(config.model.reasoning === undefined
                ? {}
                : { reasoning: config.model.reasoning }),
              ...(config.model.providerRouting === undefined
                ? {}
                : { providerRouting: config.model.providerRouting }),
            }),
        maxOutputTokens: config.model.maxOutputTokens,
        ...(config.model.temperature === undefined
          ? {}
          : { temperature: config.model.temperature }),
        credentialEnvironmentVariable: config.model.apiKeyEnv,
      },
      benchmark: {
        dataset: inspection.dataset,
        policy: config.benchmark.policy,
        requester: config.benchmark.requester,
        gradingMode: config.benchmark.gradingMode,
        taskCount: inspection.taskCount,
        firstTask: inspection.firstTask,
        lastTask: inspection.lastTask,
      },
      note: 'Configuration check does not call the model API.',
    }, null, 2)}\n`);
    return 0;
  }

  // The Harbor parity path uses its bundled no-network scripted harness.
  // Local/model-backed runs still fail before creating a run directory.
  if (selectedPactExecutionBackendV1(config).kind === 'local') {
    resolvePactRunModelApiKeyV1(config);
  }
  if (options.resume !== undefined && config.benchmark.dataset !== 'pact-pair') {
    throw new Error('--resume is supported only for the legacy pact-pair runner');
  }
  let result: Awaited<ReturnType<typeof runPactBenchmarkV1>>;
  try {
    result = await runPactBenchmarkV1(
      config,
      options.resume === undefined ? {} : { resume: options.resume },
    );
  } catch (error) {
    if (!(error instanceof PactPairRunFatalErrorV1)) throw error;
    const taskIds = [...error.taskIds].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0);
    process.stdout.write(`${JSON.stringify({
      runId: error.runId,
      outputDirectory: error.outputDirectory,
      fatal: true,
      summary: {
        total: taskIds.length,
        errors: taskIds.length,
      },
      failures: {
        groups: [{
          kind: 'error',
          message: error.message.slice(0, PACT_CLI_FAILURE_MESSAGE_LIMIT_V1),
          count: taskIds.length,
          taskIds: taskIds.slice(0, PACT_CLI_FAILURE_TASK_ID_LIMIT_V1),
          omittedTaskIds: Math.max(
            0,
            taskIds.length - PACT_CLI_FAILURE_TASK_ID_LIMIT_V1,
          ),
        }],
        omittedGroups: 0,
      },
    }, null, 2)}\n`);
    return 1;
  }
  const failures = buildPactCliFailureDiagnosticsV1(result);
  process.stdout.write(`${JSON.stringify({
    runId: result.runId,
    outputDirectory: result.outputDirectory,
    ...(result.aborted ? { aborted: result.aborted } : {}),
    ...('resumed' in result && result.resumed
      ? { resumed: true, resumes: result.resumes }
      : {}),
    summary: result.summary,
    ...(failures ? { failures } : {}),
  }, null, 2)}\n`);
  return result.summary.errors > 0 ? 1 : 0;
}

function parseArguments(argv: string[]): CliOptions {
  const args = argv[0] === 'run' ? argv.slice(1) : argv;
  let configPath: string | undefined;
  let check = false;
  let executionAdapter: PactExecutionAdapterIdV1 | undefined;
  let resume: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--execution.adapter') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires an adapter id`);
      }
      executionAdapter = pactExecutionAdapterIdV1Schema.parse(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--execution.adapter=')) {
      executionAdapter = pactExecutionAdapterIdV1Schema.parse(
        argument.slice('--execution.adapter='.length),
      );
      continue;
    }
    if (argument === '--config' || argument === '-c') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a YAML file path`);
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--config=')) {
      configPath = argument.slice('--config='.length);
      continue;
    }
    if (argument === '--resume') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a prior run output directory`);
      }
      resume = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--resume=')) {
      const value = argument.slice('--resume='.length);
      if (!value) {
        throw new Error('--resume requires a prior run output directory');
      }
      resume = value;
      continue;
    }
    throw new Error(`Unknown PACT runner argument: ${argument}`);
  }

  if (!configPath) throw new Error(`Missing --config\n\n${usage()}`);
  if (resume !== undefined && check) {
    throw new Error('--resume cannot be combined with --check');
  }
  return {
    configPath,
    check,
    ...(executionAdapter === undefined ? {} : { executionAdapter }),
    ...(resume === undefined ? {} : { resume }),
  };
}

function usage(): string {
  return `Usage: npm run benchmark -- --config <pact-run.yaml> [--check] [--resume <runDir>] [--execution.adapter <id>]\n\n` +
    `  --config, -c          Strict pact-run/v1 YAML configuration\n` +
    `  --check               Validate and count tasks without calling a model API\n` +
    `  --resume              Resume a prior run output directory: re-run only\n` +
    `                        missing and retryable transient-failure tasks\n` +
    `                        (same config and output.saveTraces: true)\n` +
    `  --execution.adapter   Override benchmark.execution.adapter\n` +
    `                        (pact-public-runner | sharedos-embedded)\n`;
}

try {
  process.exitCode = await mainPactRunnerV1();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`PACT runner error: ${message}\n`);
  process.exitCode = 1;
}
