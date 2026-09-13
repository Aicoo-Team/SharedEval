import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { JsonObject } from '../../../src/contracts/json.js';
import type { SoToolResult, SoTurnInput } from '../../../src/execution/sharedos/v1/contracts.js';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { scriptedPilotDriver, type DriverObservation } from '../../../src/suites/pact-net/pilot/driver.js';
import type { PilotDriverFactory } from '../../../src/suites/pact-net/pilot/session.js';
import { digest } from '../../../src/suites/pact-net/pilot/profile.js';
import { createProcurementWorldProfile, loadProcurementWorldProfile } from '../../../src/suites/pact-net/world/profile.js';
import { openNetWorld, type NetWorldSession } from '../../../src/suites/pact-net/world/session.js';

const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js')) ? 'Pinned SharedOS is unavailable' : false;
async function fixture(mode: 'multi' | 'single' = 'multi') {
  const profile = await loadProcurementWorldProfile(resolve(import.meta.dirname, `fixtures/procurement-world-${mode}.json`));
  const directory = await mkdtemp(join(tmpdir(), 'net-world-'));
  return { profile, directory, options: { directory, runId: 'world-regression', profile, createDriver: scriptedPilotDriver() }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function drain(session: NetWorldSession) { for (let i = 0; i < 40; i++) if (!await session.runNext()) return; throw new Error('unbounded world'); }

/** Inject a real kernel call, then let the existing scripted actor execute its turn. */
function probeThenContinue(tool: string, args: (request: DriverObservation) => JsonObject,
  observe?: (request: DriverObservation) => void,
  beforeCall?: (request: DriverObservation) => Promise<void>) {
  const results: Array<{ request: DriverObservation; result: SoToolResult }> = [];
  const base = scriptedPilotDriver(observe);
  const createDriver: PilotDriverFactory = actor => ({ open: async (request, signal) => {
    const delegate = await base(actor).open(request, signal);
    let initial: SoTurnInput | undefined;
    let awaitingProbe = false;
    return { next: async (input, nextSignal) => {
      if (!initial) {
        initial = input; awaitingProbe = true;
        await beforeCall?.(request);
        return { type: 'tool_call', call: { id: `${request.executionId}-world-probe`, tool,
          arguments: args(request), traceId: request.context.traceId, requestedAt: request.context.now } };
      }
      if (awaitingProbe) {
        assert.equal(input.type, 'tool_result');
        if (input.type === 'tool_result') results.push({ request: structuredClone(request), result: input.result });
        awaitingProbe = false;
        return delegate.next(initial, nextSignal);
      }
      return delegate.next(input, nextSignal);
    }, close: delegate.close?.bind(delegate) };
  } });
  return { createDriver, results };
}

for (const mode of ['multi', 'single'] as const) test(`${mode} crosses an audited case boundary with private histories and explicitly authorized world state`, { skip }, async () => {
  const f = await fixture(mode); const observations: DriverObservation[] = [];
  const probe = probeThenContinue('net.world_read_public', () => ({}), request => observations.push(request));
  let session = await openNetWorld({ ...f.options, createDriver: probe.createDriver });
  try {
    for (let i = 0; i < 4; i++) await session.runNext();
    assert.ok(session.snapshot().cases[0]!.final_state.audit_record);
    assert.equal(session.snapshot().world_complete, false);
    assert.equal(session.snapshot().current_case_index, 0); // Observers still need their turns.
    for (let i = 4; i < 8; i++) await session.runNext();
    const boundary = session.snapshot();
    assert.equal(boundary.processed.length, 8);
    assert.equal(boundary.cases[0]!.final_state.status, 'released');
    assert.equal(boundary.current_case_index, 1);
    assert.equal(boundary.queue.length, 1);
    const aEvents = structuredClone(boundary.cases[0]!.event_log);
    await session.close();
    session = await openNetWorld({ ...f.options, createDriver: probe.createDriver });
    await drain(session);
    const final = session.snapshot();
    assert.equal(final.world_complete, true);
    assert.equal(final.terminal_success, true);
    assert.equal(final.commit_status, 'committed');
    assert.equal(final.processed.length, 16);
    assert.equal(new Set(final.processed).size, 16);
    assert.deepEqual(final.cases[0]!.event_log, aEvents);
    assert.deepEqual(final.cases.map(value => value.event_log.length), [5, 5]);
    assert.equal(new Set(observations.map(request => request.executionId)).size, 16);
    const [a, b] = f.profile.cases;
    for (const [role, actor] of Object.entries(b!.roles)) {
      const bRequests = observations.filter(request => request.agent.agentId === actor && (request.state!.actor_view as JsonObject).case_id === b!.initial.case_id);
      const first = bRequests[0]!;
      const history = first.state!.history as unknown[];
      assert.equal(history.length > 1, mode === 'multi');
      const ownKey = role === 'legal' ? 'contract' : role as 'requester' | 'budget';
      assert.equal(JSON.stringify(history).includes(a!.evidence[ownKey].private_canary), mode === 'multi');
      for (const caseProfile of f.profile.cases) for (const [key, evidence] of Object.entries(caseProfile.evidence)) {
        if (key !== ownKey) assert.ok(!JSON.stringify(bRequests).includes(evidence.private_canary), `foreign ${key} canary in ${actor}`);
      }
    }
    const bReads = probe.results.filter(item => (item.request.state!.actor_view as JsonObject).case_id === b!.initial.case_id);
    const requesterRead = bReads.find(item => item.request.agent.agentId === b!.roles.requester)!;
    assert.equal(requesterRead.result.status, 'succeeded');
    const visible = (requesterRead.result.output as JsonObject).cases as JsonObject[];
    assert.equal(visible.find(value => value.case_id === a!.initial.case_id)!.status, mode === 'multi' ? 'released' : 'pending_control_check');
    assert.ok(visible.every(value => Object.keys(value).every(key => ['case_id', 'resource_version', 'status', 'records_matched', 'budget_verified', 'contract_verified', 'audit_written'].includes(key))));
    for (const item of bReads.filter(value => value.request.agent.agentId !== b!.roles.requester)) {
      assert.equal(item.result.status, 'denied');
      assert.ok(!item.request.tools.some(tool => tool.name === 'net.world_read_public'));
    }
    await session.close();
    let calls = 0;
    session = await openNetWorld({ ...f.options, createDriver: actor => { calls++; return scriptedPilotDriver()(actor); } });
    assert.equal(await session.runNext(), null);
    assert.equal(calls, 0);
    assert.deepEqual(session.snapshot(), final);
  } finally { await session.close(); await f.cleanup(); }
});

test('world public read revocation after discovery is enforced by native invocation', { skip }, async () => {
  const f = await fixture(); let session: NetWorldSession;
  const probe = probeThenContinue('net.world_read_public', () => ({}), undefined, async request => {
    assert.ok(request.tools.some(tool => tool.name === 'net.world_read_public'));
    await session.revoke(f.profile.cases[0]!.roles.requester, 'world_read_public');
  });
  session = await openNetWorld({ ...f.options, createDriver: probe.createDriver });
  try {
    await session.runNext();
    assert.equal(probe.results[0]!.result.status, 'denied');
    assert.equal(session.snapshot().cases[0]!.event_log.length, 1);
  } finally { await session.close(); await f.cleanup(); }
});

test('world binding rejects mode, order, public disclosure, context budget and future resource changes before continuing', { skip }, async () => {
  const f = await fixture(); const session = await openNetWorld(f.options);
  await session.runNext(); await session.close();
  try {
    const saved = await readFile(join(f.directory, 'checkpoint.json'), 'utf8');
    const profiles = [
      { ...f.profile, mode: 'single' },
      { ...f.profile, cases: [...f.profile.cases].reverse() },
      { ...f.profile, publicState: { ...f.profile.publicState, readers: [] } },
      { ...f.profile, context: { ...f.profile.context, maxContextBytes: 2_097_152 } },
      { ...f.profile, cases: [f.profile.cases[0], { ...f.profile.cases[1], topology: { edges: [] } }] },
    ];
    let calls = 0;
    for (const input of profiles) await assert.rejects(() => openNetWorld({ ...f.options, profile: createProcurementWorldProfile(input), createDriver: actor => { calls++; return scriptedPilotDriver()(actor); } }), /integrity|binding/);
    assert.equal(calls, 0);
    assert.equal(await readFile(join(f.directory, 'checkpoint.json'), 'utf8'), saved);
  } finally { await f.cleanup(); }
});

test('case B cannot use case A scope or approval receipts to release its resources', { skip }, async () => {
  const f = await fixture(); let session = await openNetWorld(f.options);
  try {
    for (let i = 0; i < 8; i++) await session.runNext();
    const prior = session.snapshot().cases[0]!;
    assert.ok(prior.final_state.budget_approval);
    const forged = probeThenContinue('net.release_po', request => ({
      case_id: (request.state!.actor_view as JsonObject).case_id,
      resource_version: (request.state!.actor_view as JsonObject).resource_version,
      budget_receipt: prior.final_state.budget_approval as unknown as JsonObject,
      contract_receipt: prior.final_state.contract_approval as unknown as JsonObject,
    }));
    await session.runNext(forged.createDriver);
    assert.notEqual(forged.results[0]!.result.status, 'succeeded');
    assert.equal(session.snapshot().cases[1]!.final_state.status, 'pending_control_check');
    assert.equal(session.snapshot().cases[1]!.final_state.budget_approval, null);
    const stale = probeThenContinue('net.read_case', () => ({ case_id: prior.case_id, resource_version: prior.final_state.resource_version }));
    await session.runNext(stale.createDriver);
    assert.notEqual(stale.results[0]!.result.status, 'succeeded');
    assert.deepEqual(session.snapshot().cases[0]!.event_log, prior.event_log);
    await drain(session);
    assert.equal(session.snapshot().terminal_success, true);
  } finally { await session.close(); await f.cleanup(); }
});

test('a drained case without a domain audit blocks the world instead of silently starting another case', { skip }, async () => {
  const f = await fixture();
  const createDriver: PilotDriverFactory = () => ({ open: async () => ({ next: async () => ({ type: 'complete', output: { claimed_done: true } }) }) });
  const session = await openNetWorld({ ...f.options, createDriver });
  try {
    await session.runNext();
    assert.equal(await session.runNext(), null);
    assert.equal(session.snapshot().blocked, true);
    assert.equal(session.snapshot().world_complete, false);
    assert.equal(session.snapshot().current_case_index, 0);
    assert.equal(session.snapshot().cases[1]!.event_log.length, 0);
  } finally { await session.close(); await f.cleanup(); }
});

test('unknown pending work fails closed before reopening or changing case', { skip }, async () => {
  const f = await fixture(); const session = await openNetWorld(f.options);
  await session.close();
  try {
    const path = join(f.directory, 'checkpoint.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const { checksum: _checksum, ...body } = saved;
    body.pending = body.queue[0].id;
    await writeFile(path, JSON.stringify({ ...body, checksum: digest(body) }));
    const before = await readFile(path, 'utf8');
    let calls = 0;
    await assert.rejects(() => openNetWorld({ ...f.options, createDriver: actor => { calls++; return scriptedPilotDriver()(actor); } }), /pending.*incomplete/);
    assert.equal(calls, 0);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await f.cleanup(); }
});
