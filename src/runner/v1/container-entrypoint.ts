#!/usr/bin/env node
import { basename, dirname, resolve } from 'node:path';
import { pactRunConfigV1Schema, type PactRunConfigV1 } from './config.js';
import { runPactPairBenchmarkV1 } from './runner.js';
import { createScriptedPactHarnessV1 } from './scripted-harness.js';
import {
  PACT_PAIR_GRADING_MODES_V1,
  PACT_PAIR_POLICIES_V1,
  PACT_PAIR_REQUESTERS_V1,
  type PactPairGradingModeV1,
  type PactPairPolicyV1,
  type PactPairRequesterIdV1,
} from '../../suites/pact-pair/task-loader.js';

export type ContainerOptionsV1 = {
  taskId: string;
  outputDirectory: string;
  policy: PactPairPolicyV1;
  requester: PactPairRequesterIdV1;
  gradingMode: PactPairGradingModeV1;
  maxTurns: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
};

/**
 * Builds the in-container run configuration from the materialized task
 * arguments. Exported so parity tests can prove that the container evaluates a
 * task under exactly the grading configuration the host would use locally:
 * the full policy surface (D0–D5, matched ablations, REL_*) plus gradingMode
 * flow through the same strict config schema as the host run.
 */
export function buildPactContainerRunConfigV1(
  options: Pick<
    ContainerOptionsV1,
    | 'taskId'
    | 'policy'
    | 'requester'
    | 'gradingMode'
    | 'maxTurns'
    | 'maxToolCalls'
    | 'maxRuntimeMs'
  > & { outputDirectoryName: string },
): PactRunConfigV1 {
  return pactRunConfigV1Schema.parse({
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
      gradingMode: options.gradingMode,
      // REL_* policies are validated for QA selections only; deriving the
      // filter kind from the task id keeps the strict schema satisfied while
      // still selecting exactly this one task.
      tasks: {
        kind: options.taskId.startsWith('PAIR-A') ? 'action' : 'qa',
        ids: [options.taskId],
      },
    },
    budget: {
      maxTurns: options.maxTurns,
      maxToolCalls: options.maxToolCalls,
      maxRuntimeMs: options.maxRuntimeMs,
    },
    output: {
      directory: options.outputDirectoryName,
      saveTraces: true,
    },
  });
}

export async function mainPactContainerV1(
  argv = process.argv.slice(2),
): Promise<number> {
  const options = parseContainerOptions(argv);
  const absoluteOutput = resolve(options.outputDirectory);
  const config = buildPactContainerRunConfigV1({
    ...options,
    outputDirectoryName: basename(absoluteOutput),
  });
  const result = await runPactPairBenchmarkV1(config, {
    harnessFactory: () => createScriptedPactHarnessV1(),
    // The container always runs the deterministic scripted parity harness —
    // never a caller-selected model — and its artifacts must say so.
    executor: 'scripted-harness',
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

function parseContainerOptions(argv: string[]): ContainerOptionsV1 {
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
  if (!(PACT_PAIR_POLICIES_V1 as readonly string[]).includes(policy)) {
    throw new Error(`Invalid PACT policy: ${policy}`);
  }
  const requester = required(values, 'requester');
  if (!(PACT_PAIR_REQUESTERS_V1 as readonly string[]).includes(requester)) {
    throw new Error(`Invalid PACT requester: ${requester}`);
  }
  const gradingMode = required(values, 'grading-mode');
  if (!(PACT_PAIR_GRADING_MODES_V1 as readonly string[]).includes(gradingMode)) {
    throw new Error(`Invalid PACT grading mode: ${gradingMode}`);
  }
  return {
    taskId,
    outputDirectory: required(values, 'output-directory'),
    policy: policy as PactPairPolicyV1,
    requester: requester as PactPairRequesterIdV1,
    gradingMode: gradingMode as PactPairGradingModeV1,
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
