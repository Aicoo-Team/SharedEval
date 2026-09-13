import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadPilotProfile, type PilotProfile } from '../../../src/suites/pact-net/pilot/profile.js';
import { evaluatePilotEvidence } from '../../../src/suites/pact-net/pilot/score.js';

const data = resolve(import.meta.dirname, '../../../dataset/pact-net');
const loadProfile = () => loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), 'success');

test('post-hoc scoring rejects assigned and world profiles or evidence instead of registering them for P-01', async () => {
  const legacy = await loadProfile();
  const assigned = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures/assigned-procurement.json'), 'utf8'));
  const world = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures/procurement-world-multi.json'), 'utf8'));
  for (const profile of [assigned, world]) {
    await assert.rejects(evaluatePilotEvidence({ profile: profile as PilotProfile, evidence: {}, dataDirectory: data }), /profile_not_registered/);
  }
  await assert.rejects(evaluatePilotEvidence({
    profile: legacy, evidence: { mode: 'assigned' }, dataDirectory: data,
  }), /profile_not_registered/);
  await assert.rejects(evaluatePilotEvidence({
    profile: legacy,
    evidence: { mode: 'multi', evidence_kind: 'scripted-native-runtime-world', commit_status: 'committed', pending: null, queue: [] },
    dataDirectory: data,
  }));
});

test('post-hoc scoring retains the projection rejection for incomplete or uncertain legacy evidence', async () => {
  const profile = await loadProfile();
  for (const [evidence, expected] of [
    [{ commit_status: 'indeterminate', pending: null, queue: [] }, /requires_committed/],
    [{ commit_status: 'committed', pending: 'unknown-effect', queue: [] }, /requires_committed/],
    [{ commit_status: 'committed', pending: null, queue: [{ id: 'unfinished' }] }, /incomplete_queue/],
    [{ commit_status: 'committed', pending: null, queue: [] }, /evidence_kind/],
  ] as const) {
    await assert.rejects(evaluatePilotEvidence({ profile, evidence, dataDirectory: data }), expected);
  }
});

test('projection rejection precedes temporary-file creation, Python execution and caller outputs', async () => {
  const profile = await loadProfile();
  const directory = await mkdtemp(join(tmpdir(), 'pilot-score-boundary-'));
  const previousTmpdir = process.env.TMPDIR;
  try {
    const dataDirectory = join(directory, 'data');
    await mkdir(join(dataDirectory, 'scripts'), { recursive: true });
    const marker = join(directory, 'python-was-invoked');
    await writeFile(join(dataDirectory, 'scripts/evaluate_executable_task.py'),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("invoked")\nprint("{}")\n`);
    // This parent does not exist: mkdtemp before projection would fail with ENOENT,
    // replacing the required evidence rejection and exposing the ordering bug.
    process.env.TMPDIR = join(directory, 'missing-temp-parent');
    for (const [evidence, expected] of [
      [{ mode: 'assigned' }, /profile_not_registered/],
      [{ commit_status: 'indeterminate', pending: null, queue: [] }, /requires_committed/],
      [{ commit_status: 'committed', pending: 'unknown-effect', queue: [] }, /requires_committed/],
      [{ commit_status: 'committed', pending: null, queue: [{ id: 'unfinished' }] }, /incomplete_queue/],
    ] as const) {
      await assert.rejects(evaluatePilotEvidence({ profile, evidence, dataDirectory }), expected);
    }
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await readdir(directory), ['data']);
    assert.deepEqual(await readdir(dataDirectory), ['scripts']);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(directory, { recursive: true, force: true });
  }
});
