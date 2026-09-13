import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { openWorldSession } from '../../../src/runner/world/session.js';
import { digest } from '../../../src/suites/pact-net/pilot/profile.js';
import { scriptedPilotDriver } from '../../../src/suites/pact-net/pilot/driver.js';
import { createProcurementWorldProfile, loadProcurementWorldProfile, worldActors } from '../../../src/suites/pact-net/world/profile.js';
import { openNetWorld, type NetWorldSession } from '../../../src/suites/pact-net/world/session.js';

const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js')) ? 'Pinned SharedOS is unavailable' : false;
async function fixture(mode: 'multi' | 'single' = 'single') {
  const profile = await loadProcurementWorldProfile(join(import.meta.dirname, `fixtures/procurement-world-${mode}.json`));
  const directory = await mkdtemp(join(tmpdir(), 'net-world-recovery-'));
  return { profile, directory, options: { directory, runId: 'world-recovery', profile, createDriver: scriptedPilotDriver() }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function drain(session: NetWorldSession) { for (let i = 0; i < 40; i++) if (!await session.runNext()) return; throw new Error('unbounded world'); }

// Reconstruct the durable checkpoint at the transition's documented fault window.
// The epoch contains no turns here; this does not repair an indeterminate run.
async function prepareEmptyEpoch(directory: string) {
  const path = join(directory, 'checkpoint.json');
  const { checksum: _checksum, ...body } = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(body.epoch, 1);
  assert.equal(body.cases[1].processed.length, 0);
  body.epochReady = false;
  body.frontiers = body.frontiers.map((value: { actorId: string }) => ({ actorId: value.actorId, sequence: 0, hash: '0'.repeat(64) }));
  body.cases[1].contextCommit = { before: body.frontiers, after: body.frontiers };
  await writeFile(path, JSON.stringify({ ...body, checksum: digest(body) }));
}

for (const phase of ['store-absent', 'store-empty'] as const) test(`Single reopens a durably selected next epoch with ${phase}`, { skip }, async () => {
  const f = await fixture(); let session = await openNetWorld(f.options);
  try {
    for (let i = 0; i < 8; i++) await session.runNext();
    const events = structuredClone(session.snapshot().cases[0]!.event_log);
    await session.close();
    await prepareEmptyEpoch(f.directory);
    if (phase === 'store-absent') await rm(join(f.directory, 'contexts/epoch-1'), { recursive: true });
    session = await openNetWorld(f.options);
    assert.equal(session.snapshot().processed.length, 8);
    assert.ok(session.snapshot().context_frontiers.every(value => value.sequence === 0 && value.hash !== '0'.repeat(64)));
    assert.equal(session.snapshot().cases[0]!.resource_state.status, 'pending_control_check');
    await drain(session);
    assert.equal(session.snapshot().processed.length, 16);
    assert.equal(session.snapshot().terminal_success, true);
    assert.deepEqual(session.snapshot().cases[0]!.event_log, events);
    assert.ok(existsSync(join(f.directory, 'contexts/epoch-0')));
  } finally { await session.close(); await f.cleanup(); }
});

test('a prepared Single epoch cannot adopt uncommitted nonzero history', { skip }, async () => {
  const f = await fixture(); const session = await openNetWorld(f.options);
  try { for (let i = 0; i < 8; i++) await session.runNext(); }
  finally { await session.close(); }
  try {
    await prepareEmptyEpoch(f.directory);
    const checkpoint = JSON.parse(await readFile(join(f.directory, 'checkpoint.json'), 'utf8'));
    const world = await openWorldSession({ directory: join(f.directory, 'contexts/epoch-1'), worldId: 'net-world-world-recovery-epoch-1',
      bindingDigest: checkpoint.binding, actorIds: worldActors(f.profile), profile: f.profile.context });
    try {
      const actor = f.profile.cases[1]!.roles.requester;
      const turn = await world.actorContext(actor).store.beginTurn({ actorId: actor, turnId: 'orphaned-host-turn', input: { role: 'user', content: 'uncommitted history' } });
      await turn.append([{ role: 'assistant', content: 'orphaned response' }]); await turn.finish('succeeded');
    } finally { await world.close(); }
    let calls = 0;
    await assert.rejects(() => openNetWorld({ ...f.options, createDriver: actor => { calls++; return scriptedPilotDriver()(actor); } }), /context_integrity_error/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

for (const mode of ['multi', 'single'] as const) test(`${mode} retains the pending marker after a context-budget failure and cannot advance or reopen`, { skip }, async () => {
  const f = await fixture(mode);
  const profile = createProcurementWorldProfile({ ...f.profile, context: { ...f.profile.context, maxContextBytes: 1024 } });
  let calls = 0;
  const options = { ...f.options, profile, createDriver: (actor: string) => { calls++; return scriptedPilotDriver()(actor); } };
  const session = await openNetWorld(options);
  try {
    await assert.rejects(() => session.runNext(), /pending.*incomplete/);
    assert.equal(session.snapshot().indeterminate, true);
    assert.ok(session.snapshot().pending);
    assert.equal(session.snapshot().processed.length, 0);
    assert.equal(session.snapshot().cases[1]!.event_log.length, 0);
    await assert.rejects(() => session.runNext(), /session_unavailable/);
  } finally { await session.close(); }
  try {
    const count = calls;
    await assert.rejects(() => openNetWorld(options), /pending.*incomplete/);
    assert.equal(calls, count);
  } finally { await f.cleanup(); }
});

test('a held audited case advances after its queue drains without claiming whole-world business success', { skip }, async () => {
  const f = await fixture('multi');
  const input = structuredClone(f.profile);
  input.cases[0]!.evidence.contract.signed = false;
  const profile = createProcurementWorldProfile(input);
  const session = await openNetWorld({ ...f.options, profile });
  try {
    await drain(session);
    const evidence = session.snapshot();
    assert.equal(evidence.world_complete, true);
    assert.equal(evidence.terminal_success, false);
    assert.deepEqual(evidence.cases.map(value => value.final_state.status), ['held', 'released']);
    assert.deepEqual(evidence.cases.map(value => value.event_log.length), [3, 5]);
  } finally { await session.close(); await f.cleanup(); }
});
