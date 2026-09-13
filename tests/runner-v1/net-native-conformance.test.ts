import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { defaultSharedOsDirV1 } from '../../src/execution/sharedos/v1/load-sharedos.js';
import { digest } from '../../src/suites/pact-net/pilot/profile.js';

const root = resolve(import.meta.dirname, '../..');
const executeFile = promisify(execFile);
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js')) ? 'Pinned SharedOS is unavailable' : false;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function fixture(execution: Record<string, string>, runId = 'native-cli-conformance') {
  const directory = await mkdtemp(join(tmpdir(), 'net-native-cli-'));
  const configPath = join(directory, 'config.json');
  const config = { version: 'pact-net-native-run/v1', runId, outputDirectory: 'run', provider: { type: 'scripted-procurement/v1' }, execution };
  await writeFile(configPath, JSON.stringify(config));
  const run = join(directory, 'run');
  async function invoke(command: 'check' | 'run' | 'score', turns?: number, path = configPath) {
    const args = ['--import', 'tsx', join(root, 'src/runner/v1/sharedeval-cli.ts'), 'net', command, '--config', path];
    if (turns !== undefined) args.push('--max-turns', String(turns));
    const { stdout } = await executeFile(process.execPath, args, { cwd: root, env: { ...process.env, SHAREDEVAL_REQUIRE_SHAREDOS: '1' }, encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576 });
    return JSON.parse(stdout);
  }
  return { directory, configPath, config, run, invoke, execution: () => readJson(join(run, 'execution.json')), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

for (const [mode, score, actions] of [['success', 1, 5], ['safe-partial', 0.175, 3]] as const) {
  test(`main NET CLI cold-resumes ${mode} and scores committed evidence without repeating effects`, { skip }, async () => {
    const f = await fixture({ kind: 'p01-pilot', mode });
    try {
      const paused = await f.invoke('run', 2);
      assert.equal(paused.turns, 2);
      const initial = await f.execution();
      await assert.rejects(() => f.invoke('score'), error => /incomplete_queue/.test((error as { stderr: string }).stderr));
      assert.equal(existsSync(join(f.run, 'evaluation.json')), false);
      assert.deepEqual(await f.execution(), initial);
      const complete = await f.invoke('run', 40);
      assert.equal(complete.turns, 8);
      const committed = await f.execution();
      assert.deepEqual(committed.evidence.processed.slice(0, 2), initial.evidence.processed);
      assert.deepEqual(committed.evidence.event_log.slice(0, initial.evidence.event_log.length), initial.evidence.event_log);
      assert.equal(committed.evidence.event_log.length, actions);
      assert.equal(committed.evidence.final_state.status, mode === 'success' ? 'released' : 'held');
      const checkpoint = await readFile(join(f.run, 'checkpoint.json'), 'utf8');
      assert.equal((await f.invoke('score')).result.score, score);
      const evaluation = await readJson(join(f.run, 'evaluation.json'));
      assert.equal(evaluation.configDigest, committed.configDigest);
      assert.equal(evaluation.evidenceDigest, committed.evidenceDigest);
      assert.equal(await readFile(join(f.run, 'checkpoint.json'), 'utf8'), checkpoint);
      assert.deepEqual(await f.execution(), committed);
      await f.invoke('run', 40);
      assert.deepEqual(await f.execution(), committed);
      // Portability retains all context/receipts; location does not define an experiment.
      if (mode === 'success') {
        await cp(f.run, join(f.directory, 'copy'), { recursive: true });
        const copiedConfig = join(f.directory, 'copied.json');
        await writeFile(copiedConfig, JSON.stringify({ ...f.config, outputDirectory: 'copy' }));
        assert.equal((await f.invoke('score', undefined, copiedConfig)).result.score, 1);
        assert.equal((await f.invoke('run', 0, copiedConfig)).turns, 8);
      }
    } finally { await f.cleanup(); }
  });
}

for (const mode of ['multi', 'single'] as const) {
  test(`main NET ${mode} CLI crosses case boundaries in separate processes with explicit scoring rejection`, { skip }, async () => {
    const f = await fixture({ kind: 'procurement-world', profileFile: join(root, `tests/suites/pact-net/fixtures/procurement-world-${mode}.json`) });
    try {
      assert.equal((await f.invoke('check')).workflowId, `net-${mode}`);
      assert.equal((await f.invoke('run', 8)).turns, 8);
      const boundary = (await f.execution()).evidence;
      assert.equal(boundary.current_case_index, 1);
      assert.equal(boundary.world_complete, false);
      assert.ok(boundary.cases[1].context_commit.before.every((frontier: { sequence: number }) => mode === 'multi' ? frontier.sequence > 0 : frontier.sequence === 0));
      assert.equal((await f.invoke('run', 1)).turns, 9);
      const firstB = (await f.execution()).evidence;
      assert.deepEqual(firstB.cases[0].event_log, boundary.cases[0].event_log);
      assert.equal(firstB.cases[0].resource_state.status, mode === 'multi' ? 'released' : 'pending_control_check');
      assert.equal((await f.invoke('run', 40)).worldComplete, true);
      const complete = await f.execution();
      assert.equal(complete.evidence.processed.length, 16);
      assert.deepEqual(complete.evidence.cases.map((item: { event_log: unknown[] }) => item.event_log.length), [5, 5]);
      await f.invoke('run', 40);
      assert.deepEqual(await f.execution(), complete);
      await assert.rejects(() => f.invoke('score'), error => /native_net_evaluator_not_registered/.test((error as { stderr: string }).stderr));
      assert.equal(existsSync(join(f.run, 'evaluation.json')), false);
      assert.deepEqual(await f.execution(), complete);
    } finally { await f.cleanup(); }
  });
}

test('main NET assigned CLI executes its supplied profile but cannot inherit the P-01 evaluator', { skip }, async () => {
  const f = await fixture({ kind: 'assigned-pilot', profileFile: join(root, 'tests/suites/pact-net/fixtures/assigned-procurement.json') });
  try {
    assert.equal((await f.invoke('run', 40)).turns, 8);
    assert.equal((await f.execution()).evidence.terminal_success, true);
    await assert.rejects(() => f.invoke('score'), error => /native_net_evaluator_not_registered/.test((error as { stderr: string }).stderr));
    assert.equal(existsSync(join(f.run, 'evaluation.json')), false);
  } finally { await f.cleanup(); }
});

for (const mode of ['multi', 'single'] as const) {
  test(`legacy and unified ${mode} entry points preserve the same world binding across cold resumes`, { skip }, async () => {
    const profileFile = join(root, `tests/suites/pact-net/fixtures/procurement-world-${mode}.json`);
    const f = await fixture({ kind: 'procurement-world', profileFile }, 'assigned-procurement-world');
    const legacy = async (turns: number) => {
      await executeFile(process.execPath, ['--import', 'tsx', join(root, 'scripts/pact-net-world.ts'),
        '--profile', profileFile, '--output', f.run, '--max-turns', String(turns)],
      { cwd: root, env: { ...process.env, SHAREDEVAL_REQUIRE_SHAREDOS: '1' }, encoding: 'utf8', timeout: 120_000 });
      const { stop_reason: _stopReason, ...snapshot } = await readJson(join(f.run, 'evidence.json'));
      return snapshot;
    };
    try {
      // Start with the versioned manifest; adopting an old directory is intentionally rejected.
      await f.invoke('run', 0);
      const boundary = await legacy(8);
      assert.equal(boundary.processed.length, 8);
      await f.invoke('run', 0); // Revalidate the native checkpoint, then refresh the stale export.
      assert.deepEqual((await f.execution()).evidence, boundary);
      await f.invoke('run', 1);
      const afterNew = (await f.execution()).evidence;
      assert.deepEqual(await legacy(0), afterNew);
      const complete = await legacy(40);
      assert.equal(complete.world_complete, true);
      assert.deepEqual(complete.cases[0].event_log, boundary.cases[0].event_log);
      await f.invoke('run', 0);
      // Full equality includes frontiers, grants/revocations, audit, resources and archives.
      assert.deepEqual((await f.execution()).evidence, complete);
    } finally { await f.cleanup(); }
  });
}

test('main NET scoring fails closed on corrupt, stale and pending receipts without repairing or rerunning', { skip }, async () => {
  const f = await fixture({ kind: 'p01-pilot', mode: 'success' });
  try {
    await f.invoke('run', 0);
    const originalExecution = await readFile(join(f.run, 'execution.json'), 'utf8');
    const originalCheckpoint = await readFile(join(f.run, 'checkpoint.json'), 'utf8');
    const changed = { ...f.config, execution: { kind: 'p01-pilot', mode: 'safe-partial' } };
    await writeFile(f.configPath, JSON.stringify(changed));
    await assert.rejects(() => f.invoke('run', 1), error => /run_binding_mismatch/.test((error as { stderr: string }).stderr));
    assert.equal(await readFile(join(f.run, 'checkpoint.json'), 'utf8'), originalCheckpoint);
    await writeFile(f.configPath, JSON.stringify(f.config));
    const receipt = JSON.parse(originalExecution);
    receipt.evidence.terminal_success = true;
    await writeFile(join(f.run, 'execution.json'), JSON.stringify(receipt));
    await assert.rejects(() => f.invoke('score'), error => /artifact_integrity_error/.test((error as { stderr: string }).stderr));
    await writeFile(join(f.run, 'execution.json'), originalExecution);
    const { checksum: _checksum, ...checkpoint } = JSON.parse(originalCheckpoint);
    checkpoint.pending = { unknown: 'effect' };
    await writeFile(join(f.run, 'checkpoint.json'), JSON.stringify({ ...checkpoint, checksum: digest(checkpoint) }));
    await assert.rejects(() => f.invoke('score'), error => /pending_turn_incomplete/.test((error as { stderr: string }).stderr));
    assert.equal((await readJson(join(f.run, 'checkpoint.json'))).pending.unknown, 'effect');
    await writeFile(join(f.run, 'checkpoint.json'), originalCheckpoint);
    await f.invoke('run', 1);
    const advancedCheckpoint = await readFile(join(f.run, 'checkpoint.json'), 'utf8');
    await writeFile(join(f.run, 'execution.json'), originalExecution); // Valid but stale export.
    await assert.rejects(() => f.invoke('score'), error => /execution_integrity_error/.test((error as { stderr: string }).stderr));
    assert.equal(await readFile(join(f.run, 'checkpoint.json'), 'utf8'), advancedCheckpoint);
    assert.equal(await readFile(join(f.run, 'execution.json'), 'utf8'), originalExecution);
    assert.equal(existsSync(join(f.run, 'evaluation.json')), false);
    assert.equal(existsSync(join(f.run, 'command.lock')), false);
    assert.equal(existsSync(join(f.run, 'writer.lock')), false);
  } finally { await f.cleanup(); }
});
