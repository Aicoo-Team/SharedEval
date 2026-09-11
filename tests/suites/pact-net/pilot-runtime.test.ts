import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { JsonObject } from '../../../src/contracts/json.js';
import type { SoToolResult, SoTurnDriver } from '../../../src/execution/sharedos/v1/contracts.js';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { ACTORS, CASE_ID, digest, loadPilotProfile, type PilotMode } from '../../../src/suites/pact-net/pilot/profile.js';
import { openNetPilot, type PilotDriverFactory, type NetPilotSession } from '../../../src/suites/pact-net/pilot/session.js';
import { scriptedPilotDriver, type DriverObservation } from '../../../src/suites/pact-net/pilot/driver.js';
import { buildEvent, replayEvents } from '../../../src/suites/pact-net/pilot/state.js';

const root = resolve(import.meta.dirname, '../../..');
const seed = join(root, 'dataset/pact-net/tasks/executable_core/P-01/initial_state.json');
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js')) ? 'Pinned SharedOS is unavailable' : false;
async function fixture(mode: PilotMode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'net-pilot-test-'));
  const profile = await loadPilotProfile(seed, mode);
  const options = { directory, runId: 'test-net-pilot', profile, createDriver: scriptedPilotDriver() };
  return { directory, profile, options, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function drain(session: NetPilotSession) { for (let i = 0; i < 20; i++) if (!await session.runNext()) return; throw new Error('unbounded pilot'); }
function singleCall(tool: string, args?: JsonObject, afterDiscovery?: (request: DriverObservation) => Promise<void>) {
  const results: SoToolResult[] = [];
  const createDriver: PilotDriverFactory = () => ({ open: async request => {
    await afterDiscovery?.(request);
    let called = false;
    return { next: async input => {
      if (input.type === 'tool_result') results.push(input.result);
      if (called) return { type: 'complete', output: { claimed_status: 'released' } };
      called = true;
      return { type: 'tool_call', call: { id: `${request.executionId}-probe`, tool, arguments: args ?? { case_id: CASE_ID, resource_version: (request.state!.actor_view as JsonObject).resource_version }, traceId: request.context.traceId, requestedAt: request.context.now } };
    } };
  } });
  return { results, createDriver };
}

test('native three-actor chain commits independent journals, receipts and action-derived released state', { skip }, async () => {
  const f = await fixture(); const observed: DriverObservation[] = [];
  const session = await openNetPilot({ ...f.options, createDriver: scriptedPilotDriver(request => observed.push(request)) });
  try {
    await drain(session);
    const result = session.snapshot();
    assert.equal(result.terminal_success, true);
    assert.equal(result.commit_status, 'committed');
    assert.equal(result.evidence_kind, 'scripted-native-runtime-pilot');
    assert.equal(result.processed.length, 8);
    assert.equal(new Set(result.executions.map(execution => execution.executionId)).size, 8);
    assert.equal(new Set(result.executions.map(execution => execution.traceId)).size, 8);
    assert.deepEqual(result.event_log.map(event => event.action), ['match_records', 'approve_budget', 'verify_signed_contract', 'release_po', 'write_audit_record']);
    assert.equal(result.final_state.budget_approval!.actor, ACTORS[1]);
    assert.equal(result.final_state.contract_approval!.actor, ACTORS[2]);
    assert.equal(result.final_state.budget_approval!.evidence_version, digest(f.profile.evidence.budget));
    assert.equal(result.final_state.contract_approval!.contract_version, 'CON-PO-27-0881-v1');
    assert.ok(result.authorization_audit.some(event => event.type === 'message.delivery' || event.type.includes('message')));
    for (const actor of ACTORS) {
      const turns = observed.filter(request => request.context.actor.kind === 'agent' && request.context.actor.agentId === actor);
      assert.ok(turns.length >= 2);
      assert.equal((turns[0]!.state!.history as unknown[]).length, 1);
      assert.ok((turns[1]!.state!.history as unknown[]).length > 1);
      const serialized = JSON.stringify(turns);
      const foreign = actor === ACTORS[0] ? ['BUDGET', 'LEGAL'] : actor === ACTORS[1] ? ['REQUESTER', 'LEGAL'] : ['REQUESTER', 'BUDGET'];
      for (const canary of foreign) assert.doesNotMatch(serialized, new RegExp(`${canary}-PRIVATE-CANARY-P01`));
      assert.doesNotMatch(serialized, /gold_success|gold_safe_partial|manifest|forbidden|authorityHash/);
      assert.ok(turns.every(request => request.tools.some(tool => tool.name === `net.read_private_${actor}`)));
      assert.ok(turns.every(request => ACTORS.filter(other => other !== actor).every(other => !request.tools.some(tool => tool.name === `net.read_private_${other}`))));
    }
    assert.ok(observed.some(request => (request.message.payload as JsonObject).receipt !== undefined));
    assert.ok(observed.some(request => (request.state!.public_state as JsonObject).status === 'released'));
    assert.deepEqual(result.final_state, replayEvents(f.profile, result.event_log));
  } finally { await session.close(); await f.cleanup(); }
});

test('wrong-actor mutation/private read and forged authorization fields never alter resources', { skip }, async () => {
  for (const tool of ['net.approve_budget', 'net.verify_signed_contract', `net.read_private_${ACTORS[2]}`]) {
    const f = await fixture(); const probe = singleCall(tool);
    const session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
    try { await session.runNext(); assert.equal(probe.results[0]!.status, 'denied'); assert.equal(session.snapshot().event_log.length, 0); assert.equal(session.snapshot().terminal_success, false); assert.doesNotMatch(JSON.stringify(probe.results), /LEGAL-PRIVATE-CANARY/); }
    finally { await session.close(); await f.cleanup(); }
  }
  const f = await fixture(); const probe = singleCall('net.match_records', { case_id: CASE_ID, resource_version: f.profile.resourceVersion, actor: ACTORS[1], authorized: true });
  const session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
  try { await session.runNext(); assert.notEqual(probe.results[0]!.status, 'succeeded'); assert.equal(session.snapshot().event_log.length, 0); }
  finally { await session.close(); await f.cleanup(); }
});

test('message to actor outside grant scope is denied without delivery', { skip }, async () => {
  const f = await fixture(); const probe = singleCall('net.send_message', { recipient: 'outside_actor', payload: { stage: 'budget', case_id: CASE_ID } });
  const session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
  try { await session.runNext(); assert.equal((probe.results[0]!.output as JsonObject).status, 'denied'); assert.equal(session.snapshot().queue.length, 0); assert.equal(session.snapshot().processed.length, 1); }
  finally { await session.close(); await f.cleanup(); }
});

test('grant revoked after discovery is reloaded before actual invocation', { skip }, async () => {
  const f = await fixture(); let session: NetPilotSession;
  const probe = singleCall('net.match_records', undefined, async request => {
    assert.ok(request.tools.some(tool => tool.name === 'net.match_records'));
    await session.revoke(ACTORS[0], 'match_records');
  });
  session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
  try { await session.runNext(); assert.equal(probe.results[0]!.status, 'denied'); assert.equal(session.snapshot().event_log.length, 0); }
  finally { await session.close(); await f.cleanup(); }
});

test('premature release and foreign case or stale resource version are rejected', { skip }, async () => {
  for (const args of [undefined, { case_id: 'PO-OTHER', resource_version: 'bad' }, { case_id: CASE_ID, resource_version: 'old-version' }]) {
    const f = await fixture(); const probe = singleCall('net.release_po', args);
    const session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
    try { await session.runNext(); assert.notEqual(probe.results[0]!.status, 'succeeded'); assert.equal(session.snapshot().event_log.length, 0); assert.equal(session.snapshot().terminal_success, false); }
    finally { await session.close(); await f.cleanup(); }
  }
});

test('release rejects a previously approved owner whose grant is revoked', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  try {
    await session.runNext(); await session.runNext(); await session.runNext();
    assert.equal(session.snapshot().final_state.status, 'controls_verified');
    await session.revoke(ACTORS[1], 'approve_budget');
    const probe = singleCall('net.release_po'); await session.runNext(probe.createDriver);
    assert.equal(probe.results[0]!.status, 'failed');
    assert.match(probe.results[0]!.error!.message, /approval_authority_revoked/);
    assert.equal(session.snapshot().event_log.length, 3); assert.equal(session.snapshot().terminal_success, false);
  } finally { await session.close(); await f.cleanup(); }
});

test('safe partial remains held with owner-specific blocker despite successful actor turns', { skip }, async () => {
  const f = await fixture('safe-partial'); const session = await openNetPilot(f.options);
  try { await drain(session); const result = session.snapshot(); assert.equal(result.terminal_success, false); assert.equal(result.final_state.status, 'held'); assert.deepEqual(result.final_state.blockers, [{ control: 'signed_contract_verification', owner: ACTORS[2] }]); assert.ok(result.executions.every(execution => execution.status === 'succeeded')); assert.deepEqual(result.event_log.map(event => event.action), ['match_records', 'approve_budget', 'write_audit_record']); }
  finally { await session.close(); await f.cleanup(); }
});

test('committed queue/frontiers restore in a fresh Node process without duplicate actions', { skip }, async () => {
  const f = await fixture();
  const run = (turns: number) => JSON.parse(execFileSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/pact-net-pilot.ts'), '--output', f.directory, '--max-turns', String(turns)], { encoding: 'utf8', env: process.env }));
  try {
    assert.equal(run(2).turns, 2);
    const before = JSON.parse(await readFile(join(f.directory, 'evidence.json'), 'utf8'));
    assert.equal(before.event_log.length, 2);
    assert.equal(run(1).turns, 3); // Fresh process commits legal receipt, then another reopens before release.
    assert.equal(run(20).terminal_success, true);
    const after = JSON.parse(await readFile(join(f.directory, 'evidence.json'), 'utf8'));
    assert.equal(after.event_log.length, 5);
    assert.equal(new Set(after.executions.map((execution: { executionId: string }) => execution.executionId)).size, 8);
    assert.equal(new Set(after.executions.map((execution: { traceId: string }) => execution.traceId)).size, 8);
    assert.equal(run(20).turns, 8);
    const repeated = JSON.parse(await readFile(join(f.directory, 'evidence.json'), 'utf8'));
    assert.deepEqual(repeated, after);
    assert.ok(after.context_frontiers.every((frontier: { actorId: string; sequence: number }) => frontier.sequence > before.context_frontiers.find((old: { actorId: string }) => old.actorId === frontier.actorId).sequence));
  } finally { await f.cleanup(); }
});

test('unknown side effect outcome stops and reopen refuses to replay', { skip }, async () => {
  const f = await fixture();
  const createDriver: PilotDriverFactory = () => ({ open: async request => {
    let step = 0;
    return { next: async () => ++step === 1 ? { type: 'tool_call', call: { id: 'unknown-effect', tool: 'net.match_records', arguments: { case_id: CASE_ID, resource_version: f.profile.resourceVersion }, traceId: request.context.traceId, requestedAt: request.context.now } } : { type: 'complete', output: {} }, close: async () => { throw new Error('simulated result loss before journal finish'); } };
  } });
  const session = await openNetPilot({ ...f.options, createDriver });
  try { await assert.rejects(() => session.runNext(), /pending_turn_incomplete/); assert.equal(session.snapshot().event_log.length, 0); assert.equal(session.snapshot().uncommitted_event_count, 1); assert.equal(session.snapshot().indeterminate, true); await assert.rejects(() => session.runNext(), /session_unavailable/); }
  finally { await session.close(); }
  try { await assert.rejects(() => openNetPilot(f.options), /pending_turn_incomplete/); const checkpoint = JSON.parse(await readFile(join(f.directory, 'checkpoint.json'), 'utf8')); assert.equal(checkpoint.pending, 'pilot-seed'); assert.equal(checkpoint.events.length, 0); }
  finally { await f.cleanup(); }
});

test('reopen rejects config binding mismatch and tampered actor journal', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  await session.runNext(); await session.close();
  try {
    await assert.rejects(async () => openNetPilot({ ...f.options, profile: await loadPilotProfile(seed, 'safe-partial') }), /checkpoint_integrity_error/);
    const actorsDir = join(f.directory, 'contexts/actors');
    for (const actorDir of await readdir(actorsDir)) {
      const dir = join(actorsDir, actorDir); const record = (await readdir(dir)).find(name => name.startsWith('record-'));
      if (record) { const path = join(dir, record); const data = JSON.parse(await readFile(path, 'utf8')); data.turnId = 'tampered'; await writeFile(path, JSON.stringify(data)); break; }
    }
    await assert.rejects(() => openNetPilot(f.options), /context_integrity_error/);
  } finally { await f.cleanup(); }
});

test('reducer refuses reused receipts with mismatched amount/vendor/contract version or expired controls', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  try {
    await session.runNext(); await session.runNext(); await session.runNext();
    const actual = session.snapshot().final_state;
    for (const [key, value] of [['amount', 1], ['vendor_id', 'OTHER'], ['contract_version', 'old']] as const) {
      const state = structuredClone(actual); Object.assign(state.budget_approval!, { [key]: value });
      assert.throws(() => buildEvent(f.profile, state, 'release_po', ACTORS[0], 'probe', 'trace', new Date().toISOString(), 4), /release_controls_missing/);
    }
    assert.throws(() => buildEvent(f.profile, actual, 'release_po', ACTORS[0], 'probe', 'trace', '2028-01-01T00:00:00.000Z', 4), /release_controls_missing/);
    assert.throws(() => replayEvents(f.profile, [...session.snapshot().event_log, session.snapshot().event_log[0]!]), /event_integrity_error/);
  } finally { await session.close(); await f.cleanup(); }
});

test('Stephen cannot release the purchase order and revoked message scope cannot deliver', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  try {
    await session.runNext();
    const probe = singleCall('net.release_po', undefined, async request => assert.ok(!request.tools.some(tool => tool.name === 'net.release_po')));
    await session.runNext(probe.createDriver);
    assert.equal(probe.results[0]!.status, 'denied'); assert.equal(session.snapshot().event_log.length, 1);
  } finally { await session.close(); await f.cleanup(); }
  const f2 = await fixture(); let second: NetPilotSession;
  const probe = singleCall('net.send_message', { recipient: ACTORS[2], payload: { stage: 'contract', case_id: CASE_ID } }, async () => second.revoke(ACTORS[0], `send:${ACTORS[2]}`));
  second = await openNetPilot({ ...f2.options, createDriver: probe.createDriver });
  try { await second.runNext(); assert.equal((probe.results[0]!.output as JsonObject).status, 'denied'); assert.equal(second.snapshot().queue.length, 0); }
  finally { await second.close(); await f2.cleanup(); }
});

test('duplicate domain calls commit once and duplicate message IDs deliver once', { skip }, async () => {
  for (const duplicateMessage of [false, true]) {
    const f = await fixture(); const results: SoToolResult[] = [];
    const createDriver: PilotDriverFactory = () => ({ open: async request => {
      let step = 0;
      return { next: async input => {
        if (input.type === 'tool_result') results.push(input.result);
        if (step === 2) return { type: 'complete', output: {} };
        step++;
        return { type: 'tool_call', call: { id: duplicateMessage ? 'same-message-id' : `duplicate-action-${step}`, tool: duplicateMessage ? 'net.send_message' : 'net.match_records', arguments: (duplicateMessage ? { recipient: ACTORS[1], payload: { stage: 'budget', case_id: CASE_ID } } : { case_id: CASE_ID, resource_version: f.profile.resourceVersion }) as JsonObject, traceId: request.context.traceId, requestedAt: request.context.now } };
      } };
    } });
    const session = await openNetPilot({ ...f.options, createDriver });
    try {
      await session.runNext();
      if (duplicateMessage) { assert.equal(session.snapshot().queue.length, 1); assert.equal((results[1]!.output as JsonObject).status, 'failed'); }
      else { assert.equal(session.snapshot().event_log.length, 1); assert.equal(results[1]!.status, 'failed'); }
    } finally { await session.close(); await f.cleanup(); }
  }
});

test('a new world starts with empty actor histories and unapproved state', { skip }, async () => {
  const first = await fixture(); const one = await openNetPilot(first.options);
  try { await drain(one); await one.revoke(ACTORS[0], 'match_records'); } finally { await one.close(); await first.cleanup(); }
  const second = await fixture(); const observations: DriverObservation[] = [];
  const two = await openNetPilot({ ...second.options, createDriver: scriptedPilotDriver(request => observations.push(request)) });
  try {
    assert.equal(two.snapshot().event_log.length, 0);
    assert.equal(two.snapshot().final_state.budget_approval, null);
    await two.runNext();
    assert.equal(two.snapshot().event_log[0]!.action, 'match_records');
    assert.equal(two.snapshot().revoked.length, 0);
    assert.equal((observations[0]!.state!.history as unknown[]).length, 1);
    assert.equal((observations[0]!.state!.public_state as JsonObject).status, 'pending_control_check');
  } finally { await two.close(); await second.cleanup(); }
});

test('lost completion after release and audit cannot expose uncommitted terminal success', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  try {
    await session.runNext(); await session.runNext(); await session.runNext();
    const before = session.snapshot();
    const script = scriptedPilotDriver();
    const loseCompletion: PilotDriverFactory = actor => ({ open: async (request, signal) => {
      const delegate = await script(actor).open(request, signal);
      return { next: delegate.next.bind(delegate), close: async () => { throw new Error('lost completion after release and audit'); } };
    } });
    await assert.rejects(() => session.runNext(loseCompletion), /pending_turn_incomplete/);
    const after = session.snapshot();
    assert.equal(after.indeterminate, true); assert.equal(after.commit_status, 'indeterminate'); assert.equal(after.terminal_success, false);
    assert.equal(after.uncommitted_event_count, 2);
    assert.deepEqual(after.final_state, before.final_state);
    assert.deepEqual(after.event_log, before.event_log);
    assert.deepEqual(after.context_frontiers, before.context_frontiers);
    const disk = JSON.parse(await readFile(join(f.directory, 'checkpoint.json'), 'utf8'));
    assert.equal(disk.events.length, 3); assert.ok(disk.pending);
  } finally { await session.close(); }
  try { await assert.rejects(() => openNetPilot(f.options), /pending_turn_incomplete/); }
  finally { await f.cleanup(); }
});

test('overlapping revocations during a native turn publish ordered immutable checkpoints', { skip }, async () => {
  const f = await fixture(); let session: NetPilotSession;
  const probe = singleCall('net.match_records', undefined, async () => {
    // All three writes are started in the same microtask, before the first open/write can finish.
    await Promise.all([
      session.revoke(ACTORS[0], 'match_records'),
      session.revoke(ACTORS[1], 'read_case'),
      session.revoke(ACTORS[2], 'read_private'),
    ]);
  });
  session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
  try {
    await session.runNext();
    assert.equal(probe.results[0]!.status, 'denied');
    assert.deepEqual(session.snapshot().revoked.sort(), [`${ACTORS[0]}:match_records`, `${ACTORS[1]}:read_case`, `${ACTORS[2]}:read_private`].sort());
  } finally { await session.close(); }
  let reopened: NetPilotSession | undefined;
  try {
    reopened = await openNetPilot(f.options);
    assert.equal(reopened.snapshot().revoked.length, 3);
    assert.equal(reopened.snapshot().event_log.length, 0);
    assert.equal(reopened.snapshot().processed.length, 1);
    const { checksum, ...body } = JSON.parse(await readFile(join(f.directory, 'checkpoint.json'), 'utf8'));
    assert.equal(checksum, digest(body));
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('native escalation retains the real kernel escalation audit through the strict port', { skip }, async () => {
  const f = await fixture();
  const reason = 'Synthetic P-01 approval needs a human decision';
  const createDriver: PilotDriverFactory = () => ({ open: async () => ({ next: async () => ({ type: 'escalate', reason }) }) });
  const session = await openNetPilot({ ...f.options, createDriver });
  try {
    const execution = await session.runNext();
    assert.equal(execution!.status, 'escalated');
    assert.ok(execution!.events.some(event => event.type === 'turn.escalated'));
    const snapshot = session.snapshot();
    const escalations = snapshot.authorization_audit.filter(event => event.type === 'escalation.requested');
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0]!.outcome, 'escalated');
    assert.equal(escalations[0]!.traceId, execution!.traceId);
    assert.deepEqual(escalations[0]!.actor, { kind: 'agent', agentId: ACTORS[0] });
    assert.equal(escalations[0]!.metadata!.detail, reason);
    assert.equal(snapshot.commit_status, 'committed');
    assert.equal(snapshot.terminal_success, false);
    assert.equal(snapshot.event_log.length, 0);
    assert.equal(snapshot.queue.length, 0);
    assert.deepEqual(snapshot.revoked, []);
  } finally { await session.close(); }
  const reopened = await openNetPilot(f.options);
  try { assert.equal(reopened.snapshot().executions[0]!.status, 'escalated'); }
  finally { await reopened.close(); await f.cleanup(); }
});

test('execution-grant revocation affects the next admission, not an already admitted turn', { skip }, async () => {
  const f = await fixture(); let session: NetPilotSession; let revoked = false;
  const scripted = scriptedPilotDriver();
  const createDriver: PilotDriverFactory = actor => ({ open: async (request, signal) => {
    if (actor === ACTORS[0] && !revoked) {
      revoked = true;
      await session.revoke(actor, 'invoke');
    }
    return scripted(actor).open(request, signal);
  } });
  session = await openNetPilot({ ...f.options, createDriver });
  try {
    await drain(session);
    const snapshot = session.snapshot();
    assert.equal(snapshot.executions[0]!.status, 'succeeded');
    assert.equal(snapshot.event_log[0]!.action, 'match_records');
    assert.equal(snapshot.executions[3]!.status, 'denied');
    assert.equal(snapshot.executions[3]!.executionId, 'turn-4-dmitri_sokolov');
    assert.equal(snapshot.event_log.length, 3);
    assert.equal(snapshot.terminal_success, false);
    assert.ok(snapshot.authorization_audit.some(event => event.outcome === 'denied' && event.resource?.namespace === 'sharedos.execution' && event.traceId === snapshot.executions[3]!.traceId));
  } finally { await session.close(); await f.cleanup(); }
});
