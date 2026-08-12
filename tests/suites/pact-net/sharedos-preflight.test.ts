/**
 * Regression tests for the fail-loud contract of the PACT-Net
 * `sharedos-embedded` adapter (sharedos-execution.ts).
 *
 * The config explicitly opts into the embedded adapter, so a missing or
 * unloadable PACT_SHAREDOS_DIR must reject the whole benchmark run — before
 * any task executes and before any output file is written — never resolve
 * as `completed_with_errors` with one infrastructure_error row per selected
 * task.
 *
 * This file lives on its own because it deliberately poisons the
 * process-wide SharedOS module cache with a load rejection; the test runner
 * isolates test files per process, so no other suite observes it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pactRunConfigV1Schema } from '../../../src/runner/v1/config.js';
import {
  createScriptedPactNetHarnessV1,
  loadPactNetAgentStoresV1,
  loadPactNetTasksV1,
  runPactNetBenchmarkV1,
  runSinglePactNetTaskV1,
} from '../../../src/suites/pact-net/index.js';

// Point the loader at a directory that cannot contain a SharedOS build,
// before anything in this process can load (and cache) a real one.
process.env.PACT_SHAREDOS_DIR = join(
  tmpdir(),
  `pact-net-missing-sharedos-${process.pid}`,
);

const LOAD_FAILURE =
  /benchmark\.execution\.adapter is sharedos-embedded but SharedOS could not be loaded/;

// A multi-task, routing-allowed selection: the failure mode under test is
// precisely the large selection degrading into one error row per task.
const MULTI_TASK_IDS = ['NET-Q-0001', 'NET-Q-0010', 'NET-A-0001', 'NET-A-0009'];

function sharedOsConfig(ids: string[]) {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'test-model',
    },
    benchmark: {
      dataset: 'pact-net',
      policy: 'D2',
      tasks: { kind: 'all', ids },
      execution: { adapter: 'sharedos-embedded' },
    },
    budget: { maxTurns: 4, maxToolCalls: 2, maxRuntimeMs: 10_000 },
    output: { directory: 'runs', saveTraces: true },
  });
}

test('a multi-task run rejects at preflight with no task rows and no output artifacts', async () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'pact-net-preflight-'));
  let harnessCreations = 0;
  try {
    await assert.rejects(
      runPactNetBenchmarkV1(sharedOsConfig(MULTI_TASK_IDS), {
        harnessFactory: context => {
          harnessCreations += 1;
          return createScriptedPactNetHarnessV1(context);
        },
        runId: 'net-sharedos-preflight',
        workingDirectory,
      }),
      LOAD_FAILURE,
    );
    // Loud rejection, not completed_with_errors: no harness was ever
    // created and the run directory (results.jsonl, run.json, checkpoints)
    // was never written — zero per-task rows.
    assert.equal(harnessCreations, 0);
    assert.deepEqual(readdirSync(workingDirectory), []);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test('a direct per-task call rethrows the load failure instead of degrading into an error row', async () => {
  // Defense in depth behind the run-level preflight: even a caller that
  // bypasses runPactNetBenchmarkV1 must not receive a normal
  // infrastructure_error task row for a configuration/load failure.
  const tasks = loadPactNetTasksV1({ policy: 'D2', kind: 'all', ids: ['NET-Q-0001'] });
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.ok(task);
  const seed = loadPactNetAgentStoresV1().get(task.targetAgent);
  assert.ok(seed, `no seed store for ${task.targetAgent}`);

  await assert.rejects(
    runSinglePactNetTaskV1({
      config: sharedOsConfig(['NET-Q-0001']),
      task,
      seed,
      runId: 'net-sharedos-preflight-single',
      now: () => new Date(),
      harnessFactory: createScriptedPactNetHarnessV1,
      environment: {},
    }),
    LOAD_FAILURE,
  );
});
