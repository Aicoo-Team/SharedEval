#!/usr/bin/env node
import { basename, dirname, resolve } from 'node:path';
import { pactRunConfigV1Schema } from './config.js';
import { runPactPairBenchmarkV1 } from './runner.js';
import { createScriptedPactHarnessV1 } from './scripted-harness.js';

type ContainerOptions = {
  taskId: string;
  outputDirectory: string;
  policy: 'D0' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
  requester: 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
  maxTurns: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
};

export async function mainPactContainerV1(
  argv = process.argv.slice(2),
): Promise<number> {
  const options = parseContainerOptions(argv);
  const absoluteOutput = resolve(options.outputDirectory);
  const config = pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    backend: { kind: 'local' },
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://scripted.invalid/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'pact-scripted-parity-v1',
      maxOutputTokens: 256,
    },
    benchmark: {
      policy: options.policy,
      requester: options.requester,
      tasks: { kind: 'all', ids: [options.taskId] },
    },
    budget: {
      maxTurns: options.maxTurns,
      maxToolCalls: options.maxToolCalls,
      maxRuntimeMs: options.maxRuntimeMs,
    },
    output: {
      directory: basename(absoluteOutput),
      saveTraces: true,
    },
  });
  const result = await runPactPairBenchmarkV1(config, {
    harnessFactory: () => createScriptedPactHarnessV1(),
    environment: {},
    runId: `harbor-${options.taskId}`,
    workingDirectory: dirname(absoluteOutput),
  });
  process.stdout.write(`${JSON.stringify({
    taskId: options.taskId,
    outputDirectory: result.outputDirectory,
    correct: result.tasks[0]?.evaluation?.correct ?? false,
  })}\n`);
  return result.summary.errors === 0 ? 0 : 1;
}

function parseContainerOptions(argv: string[]): ContainerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error('Container entrypoint arguments must be --name value pairs');
    }
    values.set(key.slice(2), value);
  }
  const taskId = required(values, 'task-id');
  if (!/^PAIR-[QA][1-9][0-9]*$/.test(taskId)) {
    throw new Error(`Invalid PACT task id: ${taskId}`);
  }
  const policy = required(values, 'policy');
  if (!/^D[0-5]$/.test(policy)) throw new Error(`Invalid PACT policy: ${policy}`);
  const requester = required(values, 'requester');
  if (!/^R[0-4]$/.test(requester)) {
    throw new Error(`Invalid PACT requester: ${requester}`);
  }
  return {
    taskId,
    outputDirectory: required(values, 'output-directory'),
    policy: policy as ContainerOptions['policy'],
    requester: requester as ContainerOptions['requester'],
    maxTurns: positiveInteger(values, 'max-turns'),
    maxToolCalls: nonNegativeInteger(values, 'max-tool-calls'),
    maxRuntimeMs: positiveInteger(values, 'max-runtime-ms'),
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function positiveInteger(values: Map<string, string>, name: string): number {
  const value = Number(required(values, name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(values: Map<string, string>, name: string): number {
  const value = Number(required(values, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

if (process.argv[1]?.endsWith('container-entrypoint.js')) {
  try {
    process.exitCode = await mainPactContainerV1();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`PACT container error: ${message}\n`);
    process.exitCode = 1;
  }
}
