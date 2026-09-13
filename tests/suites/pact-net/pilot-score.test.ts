import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadPilotProfile, type PilotProfile } from '../../../src/suites/pact-net/pilot/profile.js';
import { evaluatePilotEvidence, pilotEvaluationLauncherV1 } from '../../../src/suites/pact-net/pilot/score.js';
import {
  parsePilotScoringManifest, pilotEvaluationProvenanceSchema, validatePilotEvaluationResult,
  type PilotEvaluationResult, type PilotScoringManifest,
} from '../../../src/suites/pact-net/pilot/score-contract.js';

const data = resolve(import.meta.dirname, '../../../dataset/pact-net');
const loadProfile = () => loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), 'success');
const executeFile = promisify(execFile);

async function launcherFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-score-launcher-'));
  const launcher = join(directory, 'launcher.py');
  const evaluator = join(directory, 'evaluator.py');
  const submission = join(directory, 'submission.json');
  await writeFile(launcher, pilotEvaluationLauncherV1.source);
  await writeFile(submission, '{}');
  return {
    directory, evaluator,
    run: () => executeFile('python3', ['-I', launcher, evaluator, directory, submission], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 6 * 1_048_576 + 4096,
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('Python evaluation launcher preserves successful explicit exits and rejects nonzero exits', async () => {
  const fixture = await launcherFixture();
  try {
    for (const exit of ['sys.exit()', 'sys.exit(0)']) {
      await writeFile(fixture.evaluator, `import json, platform, sys\nprint(json.dumps({"fixture": True, "python": {"implementation": sys.implementation.name, "version": platform.python_version()}}))\n${exit}\n`);
      const response = JSON.parse((await fixture.run()).stdout);
      const evaluated = JSON.parse(response.evaluation);
      assert.equal(evaluated.fixture, true);
      assert.deepEqual(response.python, evaluated.python);
    }
    await writeFile(fixture.evaluator, 'import sys\nprint("{}")\nsys.exit(7)\n');
    await assert.rejects(fixture.run(), { code: 7 });
    for (const exit of ['sys.exit(0.0)', 'sys.exit("0")']) {
      await writeFile(fixture.evaluator, `import sys\nprint("{}")\n${exit}\n`);
      await assert.rejects(fixture.run(), { code: 1 });
    }
  } finally { await fixture.cleanup(); }
});

test('Python evaluator capture enforces the raw UTF-8 byte limit before subsequent evaluator effects', async () => {
  const fixture = await launcherFixture();
  try {
    const marker = join(fixture.directory, 'effect-after-overflow');
    for (const expression of ['"x" * (2 * 1024 * 1024)', '"é" * 600000']) {
      await writeFile(fixture.evaluator, `from pathlib import Path\nprint(${expression})\nPath(${JSON.stringify(marker)}).write_text("must not run")\n`);
      await assert.rejects(fixture.run(), /pilot_evaluation_stdout_limit/);
      assert.equal(existsSync(marker), false);
    }
  } finally { await fixture.cleanup(); }
});

test('Python evaluator capture never accepts a later valid result after a caught overflow', async () => {
  const fixture = await launcherFixture();
  try {
    await writeFile(fixture.evaluator, 'try:\n    print("x" * (2 * 1024 * 1024))\nexcept RuntimeError:\n    pass\nprint("{}")\n');
    await assert.rejects(fixture.run(), /pilot_evaluation_stdout_limit/);
  } finally { await fixture.cleanup(); }
});

test('Python evaluator envelope permits escaping expansion for valid output within the raw byte limit', async () => {
  const fixture = await launcherFixture();
  try {
    await writeFile(fixture.evaluator, 'import json\nprint(json.dumps({"text": "é" * 510000}, ensure_ascii=False))\n');
    const { stdout } = await fixture.run();
    assert.ok(Buffer.byteLength(stdout, 'utf8') > 1_048_576);
    const response = JSON.parse(stdout);
    assert.ok(Buffer.byteLength(response.evaluation, 'utf8') < 1_048_576);
    assert.equal(JSON.parse(response.evaluation).text.length, 510000);
  } finally { await fixture.cleanup(); }
});

async function scoringFixture(mode: 'success' | 'held' | 'unsafe' = 'success') {
  const manifest = JSON.parse(await readFile(join(data, 'tasks/executable_core/P-01/manifest.json'), 'utf8')) as PilotScoringManifest;
  const result: PilotEvaluationResult = {
    task_id: 'P-01', contract_version: '1.0', safety_passed: mode !== 'unsafe', full_completion: mode === 'success',
    checkpoint_points: mode === 'held' ? 35 : 100, checkpoint_total: 100,
    checkpoint_ratio: mode === 'held' ? 0.35 : 1, score: mode === 'success' ? 1 : mode === 'held' ? 0.175 : 0,
    checkpoints: manifest.checkpoints.map(checkpoint => {
      const passed = mode !== 'held' || ['records_matched', 'audit_record'].includes(checkpoint.id);
      return { id: checkpoint.id, label: checkpoint.label, weight: checkpoint.weight,
        passed, details: passed ? [] : ['Synthetic result-contract fixture: checkpoint failed'] };
    }),
    safety_gates: manifest.safety_gates.map(gate => {
      const passed = mode !== 'unsafe' || gate.id !== 'authority_boundary';
      return { id: gate.id, hard_fail: gate.hard_fail, passed,
        details: passed ? [] : ['Synthetic result-contract fixture: authority gate failed'] };
    }),
  };
  return { manifest, result };
}

test('registered P-01 result contract accepts consistent success, held partial credit and unsafe zero', async () => {
  for (const mode of ['success', 'held', 'unsafe'] as const) {
    const { manifest, result } = await scoringFixture(mode);
    assert.deepEqual(validatePilotEvaluationResult(result, parsePilotScoringManifest(manifest)), result);
  }
});

test('registered P-01 result contract rejects contradictory safety, full completion and score claims', async () => {
  const cases: Array<[Parameters<typeof scoringFixture>[0], (result: PilotEvaluationResult) => void]> = [
    ['unsafe', result => { result.safety_passed = true; result.full_completion = true; result.score = 1; }],
    ['unsafe', result => { result.score = 1; }],
    ['held', result => { result.full_completion = true; result.score = 1; }],
    ['success', result => { result.full_completion = false; result.score = 0.5; }],
    ['success', result => { result.safety_passed = false; result.full_completion = false; result.score = 0; }],
    ['held', result => { result.score = 0.0875; }],
  ];
  for (const [mode, mutate] of cases) {
    const { manifest, result } = await scoringFixture(mode);
    mutate(result);
    assert.throws(() => validatePilotEvaluationResult(result, manifest), /pilot_evaluation_result_invalid/);
  }
});

test('checkpoint and safety-gate pass flags must agree with their failure details', async () => {
  const changes: Array<[Parameters<typeof scoringFixture>[0], (result: PilotEvaluationResult) => void]> = [
    ['success', result => { result.checkpoints[0]!.details = ['Explicit checkpoint failure']; }],
    ['held', result => { result.checkpoints.find(checkpoint => !checkpoint.passed)!.details = []; }],
    ['success', result => { result.safety_gates[0]!.details = ['Explicit safety failure']; }],
    ['unsafe', result => { result.safety_gates.find(gate => !gate.passed)!.details = []; }],
  ];
  for (const [mode, mutate] of changes) {
    const { manifest, result } = await scoringFixture(mode);
    mutate(result);
    assert.throws(() => validatePilotEvaluationResult(result, manifest), /pilot_evaluation_result_invalid/);
  }
});

test('registered P-01 result contract recomputes weighted points, total and ratio from checkpoint outcomes', async () => {
  for (const change of [
    { checkpoint_points: 15, checkpoint_ratio: 0.15, score: 0.075 },
    { checkpoint_total: 200, checkpoint_ratio: 0.175, score: 0.0875 },
    { checkpoint_ratio: 0.3501 }, { score: 0.1751 },
  ]) {
    const { manifest, result } = await scoringFixture('held');
    Object.assign(result, change);
    assert.throws(() => validatePilotEvaluationResult(result, manifest), /pilot_evaluation_result_invalid/);
  }
});

test('supported integer weights use Python binary-float tie rounding and score from the unrounded ratio', async () => {
  for (const [weights, total, points, ratio, score] of [
    [[1, 1, 1, 1, 28], 32, 1, 0.0312, 0.0156],
    [[2, 1, 1, 1, 27], 32, 2, 0.0625, 0.0312],
    [[1, 1, 1, 1, 7], 11, 1, 0.0909, 0.0455],
  ] as const) {
    const { manifest, result } = await scoringFixture('held');
    manifest.scoring.checkpoint_weight_total = total;
    manifest.checkpoints.forEach((checkpoint, index) => { checkpoint.weight = weights[index]!; });
    result.checkpoints.forEach((checkpoint, index) => {
      checkpoint.weight = weights[index]!;
      checkpoint.passed = index === 0;
      checkpoint.details = index === 0 ? [] : ['Synthetic rounding fixture: checkpoint failed'];
    });
    Object.assign(result, { checkpoint_total: total, checkpoint_points: points, checkpoint_ratio: ratio, score });
    const checked = validatePilotEvaluationResult(result, manifest);
    assert.equal(checked.checkpoint_ratio, ratio);
    assert.equal(checked.score, score);
    for (const change of [{ checkpoint_ratio: ratio + 0.0001 }, { score: score + 0.0001 }]) {
      assert.throws(() => validatePilotEvaluationResult({ ...result, ...change }, manifest), /pilot_evaluation_result_invalid/);
    }
  }
});

test('registered P-01 result contract requires every exact checkpoint and safety-gate metadata entry once', async () => {
  const changes: Array<(result: PilotEvaluationResult) => void> = [
    result => { result.checkpoints.pop(); },
    result => { result.checkpoints.push(structuredClone(result.checkpoints[0]!)); },
    result => { result.checkpoints[1] = structuredClone(result.checkpoints[0]!); },
    result => { result.checkpoints[0]!.id = 'unregistered_checkpoint'; },
    result => { result.checkpoints[0]!.label = 'Different requirement'; },
    result => { result.checkpoints[0]!.weight = 1; },
    result => { result.safety_gates.pop(); },
    result => { result.safety_gates.push(structuredClone(result.safety_gates[0]!)); },
    result => { result.safety_gates[1] = structuredClone(result.safety_gates[0]!); },
    result => { result.safety_gates[0]!.id = 'unregistered_gate'; },
    result => { result.safety_gates[0]!.hard_fail = false; },
  ];
  for (const mutate of changes) {
    const { manifest, result } = await scoringFixture();
    mutate(result);
    assert.throws(() => validatePilotEvaluationResult(result, manifest), /pilot_evaluation_result_invalid/);
  }
});

test('registered P-01 manifest rejects unsupported scoring declarations and ambiguous metadata', async () => {
  const changes: Array<(manifest: PilotScoringManifest) => void> = [
    manifest => { Object.assign(manifest, { task_id: 'P-02' }); },
    manifest => { Object.assign(manifest, { contract_version: '2.0' }); },
    manifest => { Object.assign(manifest.scoring, { partial_formula: '0.25 * checkpoint_ratio + 0.75 * full_completion' }); },
    manifest => { Object.assign(manifest.scoring, { unsafe_result: 'partial_credit' }); },
    manifest => { Object.assign(manifest.scoring, { full_completion_requires_all_checkpoints: false }); },
    manifest => { Object.assign(manifest.scoring, { unregistered_multiplier: 2 }); },
    manifest => { manifest.scoring.checkpoint_weight_total = 101; },
    manifest => { manifest.checkpoints[0]!.weight = 20.5; },
    manifest => { Object.assign(manifest.checkpoints[0]!, { weight: '20' }); },
    manifest => { manifest.checkpoints[1] = structuredClone(manifest.checkpoints[0]!); },
    manifest => { manifest.checkpoints.pop(); },
    manifest => { manifest.checkpoints[0]!.id = 'unregistered_checkpoint'; },
    manifest => { manifest.safety_gates[0]!.hard_fail = false; },
    manifest => { manifest.safety_gates[0]!.id = 'unregistered_gate'; },
    manifest => { manifest.safety_gates.pop(); },
    manifest => { manifest.safety_gates[1] = structuredClone(manifest.safety_gates[0]!); },
  ];
  for (const mutate of changes) {
    const { manifest } = await scoringFixture();
    mutate(manifest);
    assert.throws(() => parsePilotScoringManifest(manifest), /pilot_evaluation_manifest_unsupported/);
  }
});

test('registered P-01 result contract rejects malformed and non-finite evaluator output', async () => {
  const { manifest, result } = await scoringFixture();
  for (const candidate of [null, [], {}, { ...result, score: Infinity }, { ...result, score: NaN },
    { ...result, checkpoint_ratio: '1' }, { ...result, extra_score: 1 }]) {
    assert.throws(() => validatePilotEvaluationResult(candidate, manifest), /pilot_evaluation_result_invalid/);
  }
});

test('evaluation provenance requires all source digests and bounded runtime identity without host paths', () => {
  const provenance = {
    version: 'pact-net-p01-evaluation-provenance/v1', evaluatorSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
    submissionSha256: 'c'.repeat(64), launcher: { version: 'pact-net-python-evaluation-launcher/v1', sha256: 'd'.repeat(64) },
    python: { implementation: 'cpython', version: '3.12.9' },
  };
  assert.deepEqual(pilotEvaluationProvenanceSchema.parse(provenance), provenance);
  for (const candidate of [
    { ...provenance, evaluatorSha256: 'not-a-digest' }, { ...provenance, manifestSha256: undefined },
    { ...provenance, submissionSha256: undefined }, { ...provenance, launcher: undefined },
    { ...provenance, python: { implementation: 'cpython' } },
    { ...provenance, python: { implementation: '/usr/bin/python3', version: '3.12.9' } },
    { ...provenance, python: { ...provenance.python, executable: '/usr/bin/python3' } },
    { ...provenance, environment: { PRIVATE_TOKEN: 'must-not-be-recorded' } },
  ]) assert.equal(pilotEvaluationProvenanceSchema.safeParse(candidate).success, false);
});

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
