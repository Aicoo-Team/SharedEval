import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { JsonObject } from '../../../src/contracts/json.js';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { loadAssignedProcurementProfile, loadPilotProfile, type PilotMode } from '../../../src/suites/pact-net/pilot/profile.js';
import { scriptedPilotDriver } from '../../../src/suites/pact-net/pilot/driver.js';
import { openNetPilot, type PilotDriverFactory } from '../../../src/suites/pact-net/pilot/session.js';
import { projectPilotEvaluation } from '../../../src/suites/pact-net/pilot/evaluation.js';
import { replayEvents } from '../../../src/suites/pact-net/pilot/state.js';

const root = resolve(import.meta.dirname, '../../..');
const data = join(root, 'dataset/pact-net');
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js'))
  ? 'Pinned SharedOS is unavailable' : false;

for (const mode of ['success', 'safe-partial'] as const satisfies readonly PilotMode[]) {
  test(`P-01 ${mode}: native effects project into the original evaluator without reference gold`, { skip }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p01-evaluation-'));
    const profile = await loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), mode);
    const session = await openNetPilot({ directory, runId: `evaluation-${mode}`, profile, createDriver: scriptedPilotDriver() });
    try {
      for (let tick = 0; tick < 20; tick++) if (!await session.runNext()) break;
      const evidence = session.snapshot();
      const submission = projectPilotEvaluation(profile, evidence);
      const path = join(directory, 'submission.json');
      await writeFile(path, JSON.stringify(submission), { mode: 0o600 });
      const score = JSON.parse(execFileSync('python3', [join(data, 'scripts/evaluate_executable_task.py'), data, 'P-01', path], { encoding: 'utf8' }));
      assert.equal(score.safety_passed, true);
      assert.equal(score.full_completion, mode === 'success');
      if (mode === 'success') assert.equal(score.score, 1);
      else assert.ok(score.score > 0 && score.score < 1);
      assert.equal(submission.trajectory.length, evidence.event_log.length);

      const contradictory = structuredClone(evidence);
      contradictory.final_state.status = mode === 'success' ? 'held' : 'released';
      assert.throws(() => projectPilotEvaluation(profile, contradictory), /state|evidence/);
      const unaudited = structuredClone(evidence);
      unaudited.authorization_audit = unaudited.authorization_audit.filter(event => event.type !== 'tool.invoked');
      assert.throws(() => projectPilotEvaluation(profile, unaudited), /audit/);
      const wrongActor = structuredClone(evidence);
      const actionAudit = wrongActor.authorization_audit.find(event => event.type === 'tool.invoked' && event.tool === 'net.approve_budget');
      assert.ok(actionAudit);
      actionAudit.actor = { kind: 'agent', agentId: 'dmitri_sokolov' };
      assert.throws(() => projectPilotEvaluation(profile, wrongActor), /audit/);
      const unchecked = structuredClone(evidence);
      unchecked.authorization_audit = unchecked.authorization_audit.filter(event => event.type !== 'authorization.checked');
      assert.throws(() => projectPilotEvaluation(profile, unchecked), /audit/);
      if (mode === 'success') {
        const hiddenRelease = structuredClone(evidence);
        hiddenRelease.event_log = hiddenRelease.event_log.filter(event => event.action !== 'release_po')
          .map((event, index) => ({ ...event, sequence: index + 1 }));
        hiddenRelease.final_state = replayEvents(profile, hiddenRelease.event_log);
        hiddenRelease.terminal_success = false;
        assert.throws(() => projectPilotEvaluation(profile, hiddenRelease), /audit/);
      }
      assert.throws(() => projectPilotEvaluation(profile, { ...evidence, commit_status: 'indeterminate' }), /committed/);
      assert.throws(() => projectPilotEvaluation(profile, { ...evidence, pending: 'unknown-effect' }), /committed/);
      assert.throws(() => projectPilotEvaluation(profile, { ...evidence, queue: [{ id: 'unfinished' }] }), /incomplete/);
      assert.throws(() => projectPilotEvaluation(profile, { ...evidence, terminal_success: !evidence.terminal_success }), /state|evidence/);
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('P-01 audit-before-release through the provider seam cannot score full completion', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p01-audit-order-evaluation-'));
  const profile = await loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), 'success');
  const scripted = scriptedPilotDriver();
  const createDriver: PilotDriverFactory = actor => ({ open: async (request, signal) => {
    const delegate = await scripted(actor).open(request, signal);
    return { ...delegate, next: async (input, nextSignal) => {
      const decision = await delegate.next(input, nextSignal);
      if ((request.message.payload as JsonObject).stage === 'finalize' && decision.type === 'tool_call') {
        if (decision.call.tool === 'net.release_po') decision.call.tool = 'net.write_audit_record';
        else if (decision.call.tool === 'net.write_audit_record') decision.call.tool = 'net.release_po';
      }
      return decision;
    } };
  } });
  const session = await openNetPilot({ directory, runId: 'evaluation-audit-order', profile, createDriver });
  try {
    for (let tick = 0; tick < 20; tick++) if (!await session.runNext()) break;
    const evidence = session.snapshot();
    assert.equal(evidence.commit_status, 'committed');
    assert.equal(evidence.final_state.status, 'held');
    assert.equal(evidence.final_state.audit_record?.status, 'held');
    assert.equal(evidence.terminal_success, false);
    assert.ok(evidence.event_log.every(event => event.action !== 'release_po'));
    const submission = projectPilotEvaluation(profile, evidence);
    const path = join(directory, 'submission.json');
    await writeFile(path, JSON.stringify(submission), { mode: 0o600 });
    const score = JSON.parse(execFileSync('python3', [join(data, 'scripts/evaluate_executable_task.py'), data, 'P-01', path], { encoding: 'utf8' }));
    assert.equal(score.full_completion, false);
    assert.ok(score.score < 1);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed assigned execution is not eligible for the registered P-01 evaluator or scoring CLI', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assigned-evaluation-boundary-'));
  const assigned = await loadAssignedProcurementProfile(join(root, 'tests/suites/pact-net/fixtures/assigned-procurement.json'));
  const legacy = await loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), 'success');
  const session = await openNetPilot({ directory, runId: 'assigned-evaluation', profile: assigned, createDriver: scriptedPilotDriver() });
  try {
    for (let tick = 0; tick < 20; tick++) if (!await session.runNext()) break;
    const evidence = session.snapshot();
    assert.equal(evidence.commit_status, 'committed');
    assert.equal(evidence.terminal_success, true);
    assert.equal(evidence.final_state.case_id, assigned.initial.case_id);
    // Exercise the JavaScript boundary as well as a caller mistakenly selecting the P-01 profile.
    assert.throws(() => projectPilotEvaluation(assigned as unknown as typeof legacy, evidence), /profile_not_registered/);
    assert.throws(() => projectPilotEvaluation(legacy, evidence), /profile_not_registered/);
    const path = join(directory, 'evidence.json');
    await writeFile(path, JSON.stringify(evidence), { mode: 0o600 });
    assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/pact-net-pilot-evaluate.ts'), path, 'success'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    }), /profile_not_registered/);
    assert.equal(existsSync(join(directory, 'submission.json')), false);
    assert.equal(existsSync(join(directory, 'evaluation.json')), false);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
