import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openWorldSession } from '../../src/runner/world/session.js';

test('world lifecycle supports three independent actors without benchmark roles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'world-session-'));
  const options = { directory: join(directory, 'history'), worldId: 'world-1',
    bindingDigest: 'a'.repeat(64), actorIds: ['b', 'c', 'a'],
    profile: { protocol: 'actor-context/v1' as const, maxContextBytes: 4096 } };
  let world = await openWorldSession(options);
  try {
    await world.assertCommittedFrontiers(undefined);
    for (const actorId of options.actorIds) {
      const context = world.actorContext(actorId);
      const turn = await context.store.beginTurn({ actorId, turnId: `${actorId}-1`,
        input: { role: 'user', content: `private-${actorId}` } });
      assert.deepEqual(turn.priorMessages, []);
      await turn.append([{ role: 'assistant', content: 'done' }]);
      await turn.finish('succeeded');
    }
    const committed = await world.frontiers();
    assert.deepEqual(committed.map(value => value.actorId), ['a', 'b', 'c']);
    await world.assertCommittedFrontiers(committed);
    await assert.rejects(world.assertCommittedFrontiers(undefined), /context_integrity_error/);
    assert.throws(() => world.actorContext('foreign'), /context_integrity_error/);
    await world.close();
    world = await openWorldSession(options);
    await world.assertCommittedFrontiers(committed);
    const turn = await world.actorContext('a').store.beginTurn({ actorId: 'a', turnId: 'different-task',
      input: { role: 'user', content: 'next task' } });
    assert.deepEqual(turn.priorMessages, [
      { role: 'user', content: 'private-a' }, { role: 'assistant', content: 'done' },
    ]);
    await turn.finish('succeeded');
    await assert.rejects(world.assertCommittedFrontiers(committed), /context_integrity_error/);
  } finally { await world.close(); await rm(directory, { recursive: true, force: true }); }
});

test('separate worlds with the same actor IDs never inherit each other', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'isolated-worlds-'));
  const profile = { protocol: 'actor-context/v1' as const, maxContextBytes: 4096 };
  try {
    for (let index = 0; index < 2; index++) {
      const world = await openWorldSession({ directory: join(directory, String(index)),
        worldId: `task-${index}`, bindingDigest: 'b'.repeat(64), actorIds: ['requester', 'responder'], profile });
      try {
        const turn = await world.actorContext('requester').store.beginTurn({ actorId: 'requester',
          turnId: 'one-contact', input: { role: 'user', content: `task-${index}` } });
        assert.deepEqual(turn.priorMessages, []);
        await turn.finish('succeeded');
      } finally { await world.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
