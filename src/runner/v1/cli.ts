#!/usr/bin/env node
import {
  loadPactRunConfigV1,
  resolvePactRunModelApiKeyV1,
} from './config.js';
import { runPactPairBenchmarkV1 } from './runner.js';
import { loadPactPairTasksV1 } from './task-loader.js';

type CliOptions = {
  configPath: string;
  check: boolean;
};

export async function mainPactRunnerV1(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArguments(argv);
  const config = await loadPactRunConfigV1(options.configPath);

  if (options.check) {
    const tasks = loadPactPairTasksV1({
      policy: config.benchmark.policy,
      requester: config.benchmark.requester,
      kind: config.benchmark.tasks.kind,
      ids: config.benchmark.tasks.ids,
      limit: config.benchmark.tasks.limit,
    });
    process.stdout.write(`${JSON.stringify({
      valid: true,
      config: config.sourcePath,
      model: {
        provider: config.model.provider,
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        maxOutputTokens: config.model.maxOutputTokens,
        ...(config.model.temperature === undefined
          ? {}
          : { temperature: config.model.temperature }),
        credentialEnvironmentVariable: config.model.apiKeyEnv,
      },
      benchmark: {
        policy: config.benchmark.policy,
        requester: config.benchmark.requester,
        taskCount: tasks.length,
        firstTask: tasks.at(0)?.taskId ?? null,
        lastTask: tasks.at(-1)?.taskId ?? null,
      },
      note: 'Configuration check does not call the model API.',
    }, null, 2)}\n`);
    return 0;
  }

  // Fail before creating a run directory or iterating over tasks.
  resolvePactRunModelApiKeyV1(config);
  const result = await runPactPairBenchmarkV1(config);
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
  return { configPath, check };
}

function usage(): string {
  return `Usage: npm run benchmark -- --config <pact-run.yaml> [--check]\n\n` +
    `  --config, -c  Strict pact-run/v1 YAML configuration\n` +
    `  --check       Validate and count tasks without calling a model API\n`;
}

try {
  process.exitCode = await mainPactRunnerV1();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`PACT runner error: ${message}\n`);
  process.exitCode = 1;
}
