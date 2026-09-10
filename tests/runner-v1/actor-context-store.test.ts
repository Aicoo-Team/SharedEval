import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { assertActorContextBudget, type ActorContextMessage } from '../../src/runner/context/actor-context.js';
import { openActorContextStore } from '../../src/runner/context/actor-context-store.js';

const input = (content: string): ActorContextMessage => ({ role: 'user', content });
const reply = (content: string): ActorContextMessage => ({ role: 'assistant', content });
const call: ActorContextMessage = { role: 'assistant', content: null, tool_calls: [
  { id: 'same-id', type: 'function', function: { name: 'files.read', arguments: '{}' } },
] };
const result: ActorContextMessage = { role: 'tool', tool_call_id: 'same-id', content: 'visible result' };
const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'actor-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, worldId: 'world-a', bindingDigest: 'a'.repeat(64), actorIds: ['alice', 'bob'], maxContextBytes: 100_000 };
  return { directory, options };
}

test('persists final replies, actor isolation, deterministic frontier and input hashes across reopen', async t => {
  const { options } = await fixture(t);
  let store = await openActorContextStore(options);
  const first = await store.beginTurn({ actorId: 'alice', turnId: 'task-a', input: input('question one') });
  assert.deepEqual(first.priorMessages, []);
  await first.append([reply('answer one')]);
  await first.finish('succeeded');
  const frontier = await store.getFrontier('alice');
  assert.ok(frontier.sequence >= 3);
  assert.match(frontier.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(frontier.hash, (await store.getFrontier('bob')).hash);
  await store.close();
  store = await openActorContextStore(options);
  assert.deepEqual(await store.getFrontier('alice'), frontier);
  const next = await store.beginTurn({ actorId: 'alice', turnId: 'task-b', input: input('question two') });
  assert.deepEqual(next.priorMessages, [input('question one'), reply('answer one')]);
  assert.match(next.inputHash, /^[a-f0-9]{64}$/);
  const bob = await store.beginTurn({ actorId: 'bob', turnId: 'task-b', input: input('private bob') });
  assert.deepEqual(bob.priorMessages, []);
  await next.finish('failed');
  await bob.finish('cancelled');
  await store.close();
});

test('namespaces old tool IDs with matching results without changing wire journal', async t => {
  const { options, directory } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: '../turn', input: input('read') });
  await turn.append([call, result, reply('done')]);
  await turn.finish('succeeded');
  const second = await store.beginTurn({ actorId: 'alice', turnId: 'next', input: input('again') });
  const oldCall = second.priorMessages[1];
  const oldResult = second.priorMessages[2];
  assert.equal(oldCall.role, 'assistant');
  assert.equal(oldResult.role, 'tool');
  if (oldCall.role !== 'assistant' || oldResult.role !== 'tool') throw new Error('roles');
  assert.notEqual(oldCall.tool_calls?.[0].id, 'same-id');
  assert.equal(oldCall.tool_calls?.[0].id, oldResult.tool_call_id);
  await second.append([call, result]);
  await second.finish('succeeded');
  await store.close();
  const actor = join(directory, 'actors', createHash('sha256').update('alice').digest('hex'));
  const names = await readdir(actor);
  const bytes = await Promise.all(names.filter(n => n.startsWith('record-')).map(n => readFile(join(actor, n), 'utf8')));
  assert.ok(bytes.some(value => value.includes('"id":"same-id"')));
});

test('rejects changed world, binding, actor membership and duplicate writer without stealing its lock', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  await assert.rejects(openActorContextStore(options), code('context_integrity_error'));
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('alive') });
  await turn.finish('succeeded');
  await store.close();
  for (const changed of [{ worldId: 'world-b' }, { bindingDigest: 'b'.repeat(64) }, { actorIds: ['alice'] }]) {
    await assert.rejects(openActorContextStore({ ...options, ...changed }), code('context_integrity_error'));
  }
  const reopened = await openActorContextStore(options);
  await reopened.close();
});

test('duplicate turn IDs, mismatched tool results and invalid finish cannot mutate frontier', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('read') });
  await turn.append([call]);
  const before = await store.getFrontier('alice');
  await assert.rejects(turn.append([reply('too soon')]), code('context_turn_incomplete'));
  await assert.rejects(turn.append([{ role: 'tool', tool_call_id: 'other', content: 'bad' }]), code('context_integrity_error'));
  await assert.rejects(turn.finish('succeeded'), code('context_turn_incomplete'));
  assert.deepEqual(await store.getFrontier('alice'), before);
  await turn.append([result]);
  if (call.role !== 'assistant') throw new Error('role');
  await assert.rejects(turn.append([{ ...call, tool_calls: [...call.tool_calls!, ...call.tool_calls!] }]), code('context_integrity_error'));
  await turn.finish('failed');
  const finished = await store.getFrontier('alice');
  await turn.finish('failed');
  assert.deepEqual(await store.getFrontier('alice'), finished);
  await assert.rejects(turn.finish('succeeded'), code('context_integrity_error'));
  await assert.rejects(turn.append([reply('late')]), code('context_integrity_error'));
  await assert.rejects(store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('read') }), code('context_integrity_error'));
  await store.close();
});

test('unfinished turns remain durable and block unsafe continuation after reopen', async t => {
  const { options } = await fixture(t);
  let store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('read') });
  await turn.append([call]);
  const frontier = await store.getFrontier('alice');
  await store.close();
  store = await openActorContextStore(options);
  assert.deepEqual(await store.getFrontier('alice'), frontier);
  await assert.rejects(store.beginTurn({ actorId: 'alice', turnId: 'two', input: input('next') }), code('context_turn_incomplete'));
  await store.close();
});

test('records observed results beyond budget and rejects next input without truncating history', async t => {
  const fixtureValue = await fixture(t);
  const options = { ...fixtureValue.options, maxContextBytes: 100 };
  let store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('read') });
  await turn.append([call, { ...result, content: 'x'.repeat(500) }]);
  await turn.finish('succeeded');
  const before = await store.getFrontier('alice');
  assert.throws(() => assertActorContextBudget([input('x'.repeat(100))], 100), code('context_budget_exhausted'));
  await assert.rejects(store.beginTurn({ actorId: 'alice', turnId: 'two', input: input('next') }), code('context_budget_exhausted'));
  const after = await store.getFrontier('alice');
  assert.ok(after.sequence > before.sequence);
  await store.close();
  store = await openActorContextStore(options);
  assert.deepEqual(await store.getFrontier('alice'), after);
  await store.close();
});

test('rejects tampered, missing trailing and torn record files', async t => {
  for (const damage of ['tamper', 'delete', 'torn']) {
    const { options, directory } = await fixture(t);
    const store = await openActorContextStore(options);
    const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('input') });
    await turn.append([reply('answer')]);
    await turn.finish('succeeded');
    await store.close();
    const actor = join(directory, 'actors', createHash('sha256').update('alice').digest('hex'));
    const records = (await readdir(actor)).filter(name => name.startsWith('record-')).sort();
    const last = join(actor, records.at(-1)!);
    if (damage === 'delete') await unlink(last);
    else if (damage === 'torn') await writeFile(last, '{');
    else await writeFile(last, (await readFile(last, 'utf8')).replace('succeeded', 'cancelled'));
    await assert.rejects(openActorContextStore(options), code('context_integrity_error'));
  }
});

test('rejects symlink roots and record files and uses hashed actor paths', async t => {
  const { options, directory } = await fixture(t);
  const store = await openActorContextStore({ ...options, actorIds: ['../../escape'] });
  await store.close();
  assert.deepEqual(await readdir(join(directory, 'actors')), [createHash('sha256').update('../../escape').digest('hex')]);
  const linkPath = `${directory}-link`;
  t.after(() => unlink(linkPath));
  await symlink(directory, linkPath);
  await assert.rejects(openActorContextStore({ ...options, directory: linkPath }), code('context_integrity_error'));
  const other = await fixture(t);
  const otherStore = await openActorContextStore(other.options);
  const turn = await otherStore.beginTurn({ actorId: 'alice', turnId: 'one', input: input('hi') });
  await turn.finish('succeeded');
  await otherStore.close();
  const actor = join(other.directory, 'actors', createHash('sha256').update('alice').digest('hex'));
  const record = (await readdir(actor)).find(name => name.startsWith('record-'))!;
  const target = join(other.directory, 'external');
  await writeFile(target, await readFile(join(actor, record)));
  await unlink(join(actor, record));
  await symlink(target, join(actor, record));
  await assert.rejects(openActorContextStore(other.options), code('context_integrity_error'));
});

test('turn handles keep their original actor and turn identity when caller mutates the request', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const request = { actorId: 'alice', turnId: 'one', input: input('alice only') };
  const alice = await store.beginTurn(request);
  const bob = await store.beginTurn({ actorId: 'bob', turnId: 'two', input: input('bob only') });
  request.actorId = 'bob';
  request.turnId = 'two';
  await alice.append([reply('alice answer')]);
  await alice.finish('succeeded');
  await bob.finish('succeeded');
  const next = await store.beginTurn({ actorId: 'alice', turnId: 'three', input: input('next') });
  assert.deepEqual(next.priorMessages, [input('alice only'), reply('alice answer')]);
  await next.finish('succeeded');
  await store.close();
});

test('serializes concurrent actor operations and rejects handles after close', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const [first, other] = await Promise.all([
    store.beginTurn({ actorId: 'alice', turnId: 'a', input: input('a') }),
    store.beginTurn({ actorId: 'bob', turnId: 'b', input: input('b') }),
  ]);
  await Promise.all([first.append([reply('one')]), first.append([reply('two')]), other.append([reply('private')])]);
  await Promise.all([first.finish('succeeded'), other.finish('succeeded')]);
  const next = await store.beginTurn({ actorId: 'alice', turnId: 'next', input: input('next') });
  assert.deepEqual(next.priorMessages, [input('a'), reply('one'), reply('two')]);
  const exposed = next.priorMessages as ActorContextMessage[];
  exposed.length = 0;
  assert.equal(next.priorMessages.length, 3);
  await store.close();
  await assert.rejects(next.append([reply('late')]), code('context_integrity_error'));
  await store.close();
});

test('detects externally changed records before allowing another append', async t => {
  const { options, directory } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('original') });
  const actor = join(directory, 'actors', createHash('sha256').update('alice').digest('hex'));
  const record = (await readdir(actor)).find(name => name.startsWith('record-'))!;
  await writeFile(join(actor, record), (await readFile(join(actor, record), 'utf8')).replace('original', 'tampered'));
  await assert.rejects(turn.append([reply('must not append')]), code('context_integrity_error'));
  assert.equal((await readdir(actor)).filter(name => name.startsWith('record-')).length, 1);
  await store.close();
});

test('rejects interrupted staging files without deleting evidence', async t => {
  const { options, directory } = await fixture(t);
  const store = await openActorContextStore(options);
  await store.close();
  const actor = join(directory, 'actors', createHash('sha256').update('alice').digest('hex'));
  const stage = join(actor, 'stage-interrupted.json');
  await writeFile(stage, 'partial');
  await assert.rejects(openActorContextStore(options), code('context_integrity_error'));
  assert.equal(await readFile(stage, 'utf8'), 'partial');
});

test('resolved provider IDs can recur and project to distinct paired historical call IDs', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('read') });
  await turn.append([call, result, call, result]);
  await turn.finish('succeeded');
  const next = await store.beginTurn({ actorId: 'alice', turnId: 'two', input: input('next') });
  const messages = next.priorMessages;
  const calls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
  const results = messages.filter(message => message.role === 'tool');
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(calls[0].id, results[0].tool_call_id);
  assert.equal(calls[1].id, results[1].tool_call_id);
  await next.finish('succeeded');
  await store.close();
});

test('canonicalizes platform parent aliases while keeping the owned root symlink check', async t => {
  const { options, directory } = await fixture(t);
  const alias = `${directory}-parent-alias`;
  t.after(() => unlink(alias));
  await symlink(directory, alias);
  const store = await openActorContextStore({ ...options, directory: join(alias, 'context') });
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('hi') });
  await turn.finish('succeeded');
  await store.close();
  const reopened = await openActorContextStore({ ...options, directory: join(directory, 'context') });
  await reopened.close();
});

test('normalizes undefined optional wire fields before hashing durable JSON', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('hi') });
  await turn.append([{ role: 'assistant', content: 'done', tool_calls: undefined, reasoning_details: undefined }]);
  await turn.finish('succeeded');
  await store.close();
  const reopened = await openActorContextStore(options);
  const next = await reopened.beginTurn({ actorId: 'alice', turnId: 'two', input: input('next') });
  assert.deepEqual(next.priorMessages, [input('hi'), reply('done')]);
  await next.finish('succeeded');
  await reopened.close();
});

test('snapshots append arguments and nested wire data before queueing persistence', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('read') });
  const messages: ActorContextMessage[] = structuredClone([call, result]);
  const saving = turn.append(messages);
  const assistant = messages[0];
  if (assistant.role !== 'assistant') throw new Error('role');
  assistant.tool_calls![0].function.arguments = '{"changed":true}';
  messages[1].content = 'changed result';
  messages.push(reply('injected after append'));
  await saving;
  await turn.finish('succeeded');
  const next = await store.beginTurn({ actorId: 'alice', turnId: 'two', input: input('next') });
  const history = next.priorMessages;
  const historicalCall = history[1];
  assert.equal(historicalCall.role, 'assistant');
  if (historicalCall.role !== 'assistant') throw new Error('role');
  assert.equal(historicalCall.tool_calls![0].function.arguments, '{}');
  assert.equal(history[2].content, 'visible result');
  assert.equal(history.length, 3);
  await next.finish('succeeded');
  await store.close();
});

test('append validation rejects asynchronously without poisoning the active turn', async t => {
  const { options } = await fixture(t);
  const store = await openActorContextStore(options);
  const turn = await store.beginTurn({ actorId: 'alice', turnId: 'one', input: input('hi') });
  let rejected!: Promise<void>;
  assert.doesNotThrow(() => { rejected = turn.append([{ role: 'user', content: 42 } as unknown as ActorContextMessage]); });
  await assert.rejects(rejected, code('context_integrity_error'));
  await turn.append([reply('valid')]);
  await turn.finish('succeeded');
  await store.close();
});

test('requires a canonical SHA-256 binding digest before creating a manifest', async t => {
  const { options } = await fixture(t);
  for (const bindingDigest of ['binding-a', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
    const attempt = await openActorContextStore({ ...options, bindingDigest }).then(
      store => ({ store, error: undefined }), error => ({ store: undefined, error }),
    );
    await attempt.store?.close();
    assert.equal((attempt.error as { code?: string } | undefined)?.code, 'context_integrity_error');
  }
  const store = await openActorContextStore(options);
  await store.close();
});
