#!/usr/bin/env node
/**
 * Regenerates the committed local golden fixtures used by the backend-parity
 * tests and verify_harbor.sh.
 *
 * Both fixtures are produced by the default LocalBackendV1 driving the
 * deterministic no-network scripted harness, so they are byte-stable across
 * machines. `budgetUsed.runtimeMs` is the only nondeterministic field and is
 * normalized to 0 (the same normalization the parity comparisons apply).
 *
 * Usage:
 *   npx tsx scripts/generate-golden.ts [outputRoot]
 *
 * With no argument it rewrites tests/golden/**. Pass an output root (e.g. a
 * temp dir) to generate without touching the committed fixtures — useful to
 * confirm this generator still reproduces a committed golden via `git diff`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PactTaskResultV1 } from '../src/runner/v1/artifacts.js';
import { PACT_HARBOR_SMOKE_TASK_IDS_V1 } from '../src/runner/v1/backends/harbor-backend.js';
import { pactRunConfigV1Schema, type PactRunConfigV1 } from '../src/runner/v1/config.js';
import { runPactPairBenchmarkV1 } from '../src/runner/v1/runner.js';
import { createScriptedPactHarnessV1 } from '../src/runner/v1/scripted-harness.js';
import {
  loadPactPairSplitTaskIdsV1,
  pactPairSplitPathV1,
} from '../src/runner/v1/task-loader.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function scriptedConfig(ids: string[]): PactRunConfigV1 {
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
    benchmark: { policy: 'D2', requester: 'R1', tasks: { kind: 'all', ids } },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 30_000 },
    output: { directory: 'runs', saveTraces: true },
  });
}

function normalizeResult(result: PactTaskResultV1): PactTaskResultV1 {
  const clone = structuredClone(result);
  clone.budgetUsed.runtimeMs = 0;
  return clone;
}

async function generateGolden(
  name: string,
  ids: string[],
  outputRoot: string,
): Promise<void> {
  const result = await runPactPairBenchmarkV1(scriptedConfig(ids), {
    harnessFactory: () => createScriptedPactHarnessV1(),
    environment: {},
    runId: `golden-${name}`,
    writeOutputs: false,
  });
  const results = result.tasks.map(normalizeResult);
  const directory = join(outputRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'summary.json'),
    `${JSON.stringify(result.summary, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(directory, 'results.jsonl'),
    `${results.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  process.stdout.write(
    `wrote ${name}: ${results.length} tasks, ${result.summary.correct}/${result.summary.total} correct\n`,
  );
}

async function main(): Promise<void> {
  const outputRoot = process.argv[2]
    ? resolve(process.argv[2])
    : join(repositoryRoot, 'tests', 'golden');
  await generateGolden(
    'pact-pair-smoke-v1',
    [...PACT_HARBOR_SMOKE_TASK_IDS_V1],
    outputRoot,
  );
  await generateGolden(
    'pact-pair-split-01-v1',
    loadPactPairSplitTaskIdsV1(pactPairSplitPathV1({ rootDir: repositoryRoot, index: 1 })),
    outputRoot,
  );
}

await main();
