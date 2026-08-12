#!/usr/bin/env node
import {
  loadPactRunConfigV1,
  pactAttemptsConfigV1Schema,
  pactExecutionAdapterIdV1Schema,
  resolvePactRunModelApiKeyV1,
  selectedPactExecutionAdapterV1,
  selectedPactExecutionBackendV1,
  type PactAttemptsConfigV1,
  type PactExecutionAdapterIdV1,
} from './config.js';
import { inspectPactBenchmarkV1, runPactBenchmarkV1 } from './runner.js';

type CliOptions = {
  configPath: string;
  check: boolean;
  executionAdapter?: PactExecutionAdapterIdV1;
  attempts?: PactAttemptsConfigV1;
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
  if (options.attempts) {
    // Same provenance rule as --execution.adapter: the override becomes part
    // of the effective config and therefore of the reproducibility digest.
    config = {
      ...config,
      benchmark: {
        ...config.benchmark,
        attempts: options.attempts,
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
  const result = await runPactBenchmarkV1(config);
  process.stdout.write(`${JSON.stringify({
    runId: result.runId,
    outputDirectory: result.outputDirectory,
    ...(result.aborted ? { aborted: result.aborted } : {}),
    summary: result.summary,
  }, null, 2)}\n`);
  return result.summary.errors > 0 ? 1 : 0;
}

function parseArguments(argv: string[]): CliOptions {
  const args = argv[0] === 'run' ? argv.slice(1) : argv;
  let configPath: string | undefined;
  let check = false;
  let executionAdapter: PactExecutionAdapterIdV1 | undefined;
  let attempts: PactAttemptsConfigV1 | undefined;

  const parseAttempts = (value: string): PactAttemptsConfigV1 =>
    pactAttemptsConfigV1Schema.parse({ max: Number(value) });

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
    if (argument === '--attempts.max') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires an attempt count (1-3)`);
      }
      attempts = parseAttempts(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--attempts.max=')) {
      attempts = parseAttempts(argument.slice('--attempts.max='.length));
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
    throw new Error(`Unknown PACT runner argument: ${argument}`);
  }

  if (!configPath) throw new Error(`Missing --config\n\n${usage()}`);
  return {
    configPath,
    check,
    ...(executionAdapter === undefined ? {} : { executionAdapter }),
    ...(attempts === undefined ? {} : { attempts }),
  };
}

function usage(): string {
  return `Usage: npm run benchmark -- --config <pact-run.yaml> [--check] [--execution.adapter <id>] [--attempts.max <n>]\n\n` +
    `  --config, -c          Strict pact-run/v1 YAML configuration\n` +
    `  --check               Validate and count tasks without calling a model API\n` +
    `  --execution.adapter   Override benchmark.execution.adapter\n` +
    `                        (pact-public-runner | sharedos-embedded)\n` +
    `  --attempts.max        Enable the multi-attempt requester protocol with\n` +
    `                        up to n attempts per task (1-3); rows then carry\n` +
    `                        per-attempt records\n`;
}

try {
  process.exitCode = await mainPactRunnerV1();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`PACT runner error: ${message}\n`);
  process.exitCode = 1;
}
