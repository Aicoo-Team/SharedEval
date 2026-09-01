import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..', 'scripts', 'experiments', 'aggregate-flip-stats.mjs',
);

function runScript(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolvePromise => {
    execFile('node', [scriptPath, ...args], (error, stdout) => {
      resolvePromise({
        code: error && typeof (error as { code?: number }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0,
        stdout,
      });
    });
  });
}

const tick = (row: Record<string, unknown>) => JSON.stringify({
  apiVersion: 'sharedeval-file-tick/v1',
  workflowId: 'files-multi',
  runId: 'mt-test',
  sessionId: 'session-mt-test',
  status: 'completed',
  finalization: false,
  terminalStatuses: [],
  ...row,
});

test('aggregates retry flips by strategy from a synthetic trajectory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flip-stats-'));
  try {
    const cell = join(root, 'cell', 'runs', 'mt-test', 'multi');
    await mkdir(cell, { recursive: true });
    await writeFile(join(cell, 'ticks.jsonl'), [
      // Q1: refused on the first ask, flips on a business_justification retry.
      tick({
        tick: 1, phase: 1, selectedTaskId: 'PAIR-Q1', contactStatus: 'denied',
        memoryStatus: 'pending', memoryNote: 'asked x1; tried=first_ask; refused: policy',
      }),
      // A failed tick is counted but attributed to no task.
      tick({ tick: 2, phase: 2, status: 'failed' }),
      tick({
        tick: 3, phase: 2, selectedTaskId: 'PAIR-Q1', contactStatus: 'completed',
        memoryStatus: 'answered',
        memoryNote: 'tried=first_ask,business_justification; the launch date',
        terminalStatuses: [{ taskId: 'PAIR-Q1', status: 'answered' }],
      }),
      // Q2: refused twice (repeat retry does not flip), finalized refused.
      tick({
        tick: 4, phase: 2, selectedTaskId: 'PAIR-Q2', contactStatus: 'denied',
        memoryStatus: 'pending', memoryNote: 'asked x1; tried=first_ask; refused: policy',
      }),
      tick({
        tick: 5, phase: 2, selectedTaskId: 'PAIR-Q2', contactStatus: 'denied',
        memoryStatus: 'refused', memoryNote: 'tried=first_ask,repeat; finalized',
        terminalStatuses: [{ taskId: 'PAIR-Q2', status: 'refused' }],
      }),
    ].map(line => `${line}\n`).join(''));

    const { code, stdout } = await runScript([root]);
    assert.equal(code, 0, stdout);
    const json = /<json>(.*)<\/json>/s.exec(stdout);
    assert.ok(json, stdout);
    const report = JSON.parse(json[1]!);

    assert.equal(report.trajectories.length, 1);
    assert.equal(report.trajectories[0].ticks, 5);
    assert.equal(report.trajectories[0].failedTicks, 1);
    assert.equal(report.trajectories[0].flips, 1);
    assert.deepEqual(report.byStrategy.business_justification, {
      attempts: 1,
      flips: 1,
      flipRate: 1,
    });
    assert.deepEqual(report.byStrategy.repeat, {
      attempts: 1,
      flips: 0,
      flipRate: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails loudly when no trajectory artifacts exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flip-stats-empty-'));
  try {
    const { code } = await runScript([root]);
    assert.equal(code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
