import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { JsonObject } from '../../../src/contracts/json.js';
import type { SoToolResult } from '../../../src/execution/sharedos/v1/contracts.js';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { openNetPilot, type NetPilotSession, type PilotDriverFactory } from '../../../src/suites/pact-net/pilot/session.js';
import { scriptedPilotDriver, type DriverObservation } from '../../../src/suites/pact-net/pilot/driver.js';
import { createAssignedProcurementProfile, loadAssignedProcurementProfile, loadPilotProfile } from '../../../src/suites/pact-net/pilot/profile.js';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = resolve(import.meta.dirname, 'fixtures/assigned-procurement.json');
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js')) ? 'Pinned SharedOS is unavailable' : false;
async function fixture() {
  const profile = await loadAssignedProcurementProfile(fixturePath);
  const directory = await mkdtemp(join(tmpdir(), 'net-assigned-'));
  return { profile, directory, options: { directory, runId: 'synthetic-assigned', profile, createDriver: scriptedPilotDriver() }, cleanup: () => rm(directory, { recursive: true, force: true }) };
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
      const view = request.state!.actor_view as JsonObject;
      return { type: 'tool_call', call: { id: `${request.executionId}-probe`, tool,
        arguments: args ?? { case_id: view.case_id, resource_version: view.resource_version },
        traceId: request.context.traceId, requestedAt: request.context.now } };
    } };
  } });
  return { results, createDriver };
}

test('assigned procurement executes a different case, actor set, currency and explicit topology through native SharedOS', { skip }, async () => {
  const f = await fixture(); const observed: DriverObservation[] = [];
  const session = await openNetPilot({ ...f.options, createDriver: scriptedPilotDriver(request => observed.push(request)) });
  try {
    await drain(session);
    const evidence = session.snapshot();
    assert.equal(evidence.case_id, 'SYN-PO-002');
    assert.equal(evidence.mode, 'assigned');
    assert.equal(evidence.profile_version, 'pact-net-assigned-procurement/v1');
    assert.equal(evidence.final_state.status, 'released');
    assert.equal(evidence.terminal_success, true);
    assert.equal(evidence.processed.length, 8);
    assert.equal(evidence.final_state.budget_approval!.actor, 'owen_budget');
    assert.equal(evidence.final_state.budget_approval!.amount, 42000);
    assert.equal(evidence.final_state.budget_approval!.currency, 'EUR');
    assert.equal(evidence.final_state.contract_approval!.actor, 'lina_legal');
    assert.equal(evidence.final_state.contract_approval!.contract_id, 'SYN-CON-002');
    assert.equal(evidence.final_state.contract_approval!.contract_version, 'revision-7');
    assert.doesNotMatch(JSON.stringify(observed), /PO-27-0881|dmitri_sokolov|stephen_kowalczyk|helen_vasquez|148000|VEN-204|CON-PO-27/);
    const actors = Object.values(f.profile.roles);
    assert.deepEqual([...new Set(observed.map(request => request.agent.agentId))].sort(), [...actors].sort());
    for (const [evidenceKey, role] of [['requester', 'requester'], ['budget', 'budget'], ['contract', 'legal']] as const) {
      const actor = f.profile.roles[role];
      const turns = observed.filter(request => request.agent.agentId === actor);
      assert.ok(turns.length >= 2);
      assert.equal((turns[0]!.state!.history as unknown[]).length, 1);
      assert.ok((turns[1]!.state!.history as unknown[]).length > 1);
      assert.ok(turns.every(request => request.tools.some(tool => tool.name === `net.read_private_${actor}`)));
      assert.ok(turns.every(request => actors.filter(other => other !== actor).every(other => !request.tools.some(tool => tool.name === `net.read_private_${other}`))));
      for (const [key, evidence] of Object.entries(f.profile.evidence)) if (key !== evidenceKey) assert.ok(!JSON.stringify(turns).includes(evidence.private_canary));
    }
  } finally { await session.close(); await f.cleanup(); }
});

test('assigned grants deny wrong owner mutation, foreign private reads and forged or stale scope', { skip }, async () => {
  const f = await fixture();
  try {
    for (const [i, [tool, args]] of [
      ['net.approve_budget', undefined], ['net.verify_signed_contract', undefined],
      ['net.read_private_lina_legal', undefined],
      ['net.match_records', { case_id: 'PO-27-0881', resource_version: f.profile.resourceVersion }],
      ['net.match_records', { case_id: f.profile.initial.case_id, resource_version: 'stale-version' }],
      ['net.match_records', { case_id: f.profile.initial.case_id, resource_version: f.profile.resourceVersion, actor: f.profile.roles.budget, authorized: true }],
    ].entries()) {
      const probe = singleCall(tool as string, args as JsonObject | undefined);
      const session = await openNetPilot({ ...f.options, directory: join(f.directory, String(i)), createDriver: probe.createDriver });
      try {
        await session.runNext();
        assert.notEqual(probe.results[0]!.status, 'succeeded');
        if (i < 3) assert.equal(probe.results[0]!.status, 'denied');
        assert.equal(session.snapshot().event_log.length, 0);
        assert.equal(session.snapshot().final_state.records_matched, false);
        assert.equal(session.snapshot().terminal_success, false);
        assert.ok(!JSON.stringify(probe.results).includes(f.profile.evidence.contract.private_canary));
      } finally { await session.close(); }
    }
  } finally { await f.cleanup(); }
});

test('assigned messaging denies the absent legal-to-budget edge without creating a delivery', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  try {
    await session.runNext(); await session.runNext();
    assert.equal(session.snapshot().queue[0]!.actor, f.profile.roles.legal);
    const probe = singleCall('net.send_message', { recipient: f.profile.roles.budget, payload: { stage: 'observe', case_id: f.profile.initial.case_id } }, async request => {
      assert.ok(request.tools.some(tool => tool.name === 'net.send_message')); // Legal can send to requester, never to budget.
    });
    await session.runNext(probe.createDriver);
    assert.equal((probe.results[0]!.output as JsonObject).status, 'denied');
    assert.equal(session.snapshot().queue.length, 0);
    assert.equal(session.snapshot().processed.length, 3);
    assert.equal(session.snapshot().event_log.length, 2);
  } finally { await session.close(); await f.cleanup(); }
});

test('assigned actor with no explicit outgoing edges cannot discover or invoke messaging', { skip }, async () => {
  const f = await fixture(); const profile = createAssignedProcurementProfile({ ...f.profile, topology: { edges: [] } });
  const probe = singleCall('net.send_message', { recipient: profile.roles.budget, payload: { stage: 'budget', case_id: profile.initial.case_id } }, async request => {
    assert.ok(!request.tools.some(tool => tool.name === 'net.send_message'));
  });
  const session = await openNetPilot({ ...f.options, profile, createDriver: probe.createDriver });
  try {
    await session.runNext(); assert.equal(probe.results[0]!.status, 'denied');
    assert.equal(session.snapshot().queue.length, 0); assert.equal(session.snapshot().event_log.length, 0);
  } finally { await session.close(); await f.cleanup(); }
});

test('assigned grant revocation after discovery is denied by the native invocation and survives reopen', { skip }, async () => {
  const f = await fixture(); let session: NetPilotSession;
  const probe = singleCall('net.match_records', undefined, async request => {
    assert.ok(request.tools.some(tool => tool.name === 'net.match_records'));
    await session.revoke(f.profile.roles.requester, 'match_records');
  });
  session = await openNetPilot({ ...f.options, createDriver: probe.createDriver });
  try {
    await session.runNext(); assert.equal(probe.results[0]!.status, 'denied');
    assert.equal(session.snapshot().event_log.length, 0);
  } finally { await session.close(); }
  const reopened = await openNetPilot(f.options);
  try { assert.deepEqual(reopened.snapshot().revoked, [`${f.profile.roles.requester}:match_records`]); assert.equal(await reopened.runNext(), null); }
  finally { await reopened.close(); await f.cleanup(); }
});

test('assigned invalid resource and owner scope fail before any driver or checkpoint creation', { skip }, async () => {
  const f = await fixture(); let calls = 0;
  try {
    const invalidProfiles = [
      { ...f.profile, resourceVersion: '0'.repeat(64) },
      { ...f.profile, roles: { ...f.profile.roles, legal: f.profile.roles.requester } },
      { ...f.profile, evidence: { ...f.profile.evidence, budget: { ...f.profile.evidence.budget, case_id: 'OTHER-CASE' } } },
      { ...f.profile, evidence: { ...f.profile.evidence, contract: { ...f.profile.evidence.contract, contract_version: 'old-version' } } },
    ];
    for (const [index, profile] of invalidProfiles.entries()) {
      const directory = join(f.directory, String(index)); let session: NetPilotSession | undefined;
      try {
        await assert.rejects(async () => { session = await openNetPilot({ ...f.options, directory, profile, createDriver: actor => { calls++; return scriptedPilotDriver()(actor); } }); }, /pilot_profile_invalid/);
        assert.equal(existsSync(directory), false);
      } finally { await session?.close(); }
    }
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('assigned checkpoint binding rejects topology changes and legacy profile reuse', { skip }, async () => {
  const f = await fixture(); const session = await openNetPilot(f.options);
  await session.runNext(); await session.close();
  try {
    const checkpoint = await readFile(join(f.directory, 'checkpoint.json'), 'utf8');
    const changed = createAssignedProcurementProfile({ ...f.profile, topology: { edges: f.profile.topology.edges.slice(1) } });
    await assert.rejects(() => openNetPilot({ ...f.options, profile: changed }), /checkpoint_integrity_error/);
    const legacy = await loadPilotProfile(join(root, 'dataset/pact-net/tasks/executable_core/P-01/initial_state.json'), 'success');
    await assert.rejects(() => openNetPilot({ ...f.options, profile: legacy }), /checkpoint_integrity_error/);
    assert.equal(await readFile(join(f.directory, 'checkpoint.json'), 'utf8'), checkpoint);
    const reopened = await openNetPilot(f.options);
    try { await drain(reopened); assert.equal(reopened.snapshot().terminal_success, true); }
    finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});

test('assigned unsigned owner evidence holds its own case with its own legal blocker', { skip }, async () => {
  const f = await fixture(); const profile = createAssignedProcurementProfile({ ...f.profile, evidence: { ...f.profile.evidence, contract: { ...f.profile.evidence.contract, signed: false } } });
  const session = await openNetPilot({ ...f.options, profile });
  try {
    await drain(session); const result = session.snapshot();
    assert.equal(result.terminal_success, false); assert.equal(result.final_state.status, 'held');
    assert.deepEqual(result.final_state.blockers, [{ control: 'signed_contract_verification', owner: profile.roles.legal }]);
    assert.deepEqual(result.event_log.map(event => event.action), ['match_records', 'approve_budget', 'write_audit_record']);
  } finally { await session.close(); await f.cleanup(); }
});

test('assigned budget evidence expires independently while legal evidence remains valid', { skip }, async () => {
  const f = await fixture();
  const profile = createAssignedProcurementProfile({ ...f.profile, evidence: { ...f.profile.evidence,
    budget: { ...f.profile.evidence.budget, valid_from: '2020-01-01T00:00:00Z', valid_until: '2021-01-01T00:00:00Z' },
  } });
  const session = await openNetPilot({ ...f.options, profile });
  try {
    await session.runNext();
    const probe = singleCall('net.approve_budget');
    await session.runNext(probe.createDriver);
    assert.equal(probe.results[0]!.status, 'failed');
    assert.match(probe.results[0]!.error!.message, /budget_evidence_invalid/);
    assert.equal(session.snapshot().event_log.length, 1);
    assert.equal(session.snapshot().final_state.budget_approval, null);
    assert.equal(session.snapshot().terminal_success, false);
  } finally { await session.close(); await f.cleanup(); }
});

test('legacy pilot retains its provider state keys and P-01 tool metadata without an assigned field', { skip }, async () => {
  const f = await fixture(); const observed: DriverObservation[] = [];
  const profile = await loadPilotProfile(join(root, 'dataset/pact-net/tasks/executable_core/P-01/initial_state.json'), 'success');
  const session = await openNetPilot({ ...f.options, profile, createDriver: scriptedPilotDriver(request => observed.push(request)) });
  try {
    await session.runNext();
    assert.deepEqual(Object.keys(observed[0]!.state!).sort(), ['actor_view', 'history', 'public_state']);
    assert.ok(observed[0]!.tools.every(tool => tool.description === `P-01 synthetic pilot ${tool.name.slice(4)}`));
    assert.equal(session.snapshot().event_log.length, 1);
    assert.equal(session.snapshot().queue[0]!.actor, 'stephen_kowalczyk');
  } finally { await session.close(); await f.cleanup(); }
});
