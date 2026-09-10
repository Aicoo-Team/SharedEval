import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { sha256JsonV1, type JsonValue } from '../../contracts/json.js';
import {
  ActorContextError, actorContextMessageSchema, assertActorContextBudget, parseActorContextMessage,
  type ActorContextFrontier, type ActorContextMessage, type ActorContextStatus,
  type ActorContextStore, type ActorContextTurn, type OpenActorContextStoreOptions,
} from './actor-context.js';

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const identifier = z.string().min(1).max(1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const frontierSchema = z.object({ sequence: z.number().int().safe().nonnegative(), hash: digest }).strict();
const manifestSchema = z.object({
  version: z.literal('actor-context/v1'), worldId: identifier, bindingDigest: digest,
  actorIds: z.array(identifier).min(1), maxContextBytes: z.number().int().safe().positive(),
}).strict();
const recordBase = {
  version: z.literal('actor-context-record/v1'), actorId: identifier, turnId: identifier,
  sequence: z.number().int().safe().positive(), previousHash: digest, hash: digest,
};
const recordSchema = z.discriminatedUnion('kind', [
  z.object({ ...recordBase, kind: z.literal('begin'), input: actorContextMessageSchema, inputHash: digest }).strict(),
  z.object({ ...recordBase, kind: z.literal('message'), message: actorContextMessageSchema }).strict(),
  z.object({ ...recordBase, kind: z.literal('finish'), status: z.enum(['succeeded', 'failed', 'cancelled']) }).strict(),
]);
type RecordPayload =
  | { kind: 'begin'; input: ActorContextMessage; inputHash: string }
  | { kind: 'message'; message: ActorContextMessage }
  | { kind: 'finish'; status: ActorContextStatus };
type TurnState = { turnId: string; inputHash: string; messages: ActorContextMessage[]; status?: ActorContextStatus };
type ActorState = { frontier: ActorContextFrontier; turns: TurnState[] };
type Identity = { dev: number; ino: number };

function hash(value: unknown): string { return sha256JsonV1(value as JsonValue); }
function actorName(actorId: string): string { return createHash('sha256').update(actorId).digest('hex'); }
function integrity(): never { throw new ActorContextError('context_integrity_error'); }
function incomplete(): never { throw new ActorContextError('context_turn_incomplete'); }
function sameIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino; }

// Tool references are renamed only in the model projection; journal bytes remain provider wire data.
function project(turns: readonly TurnState[]): ActorContextMessage[] {
  return turns.flatMap(turn => {
    const pending = new Map<string, string>();
    return turn.messages.map((message, messageIndex) => {
      const copy = structuredClone(message);
      if (copy.role === 'assistant' && copy.tool_calls) {
        copy.tool_calls = copy.tool_calls.map(call => {
          const id = `ctx_${hash([turn.turnId, messageIndex, call.id]).slice(0, 48)}`;
          pending.set(call.id, id);
          return { ...call, id };
        });
      } else if (copy.role === 'tool') {
        const id = pending.get(copy.tool_call_id);
        if (!id) integrity();
        pending.delete(copy.tool_call_id);
        copy.tool_call_id = id;
      }
      return copy;
    });
  });
}

function pendingCalls(messages: readonly ActorContextMessage[]): Set<string> {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) integrity();
      continue;
    }
    if (pending.size) incomplete();
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) integrity();
        pending.add(call.id);
      }
    }
  }
  return pending;
}

export async function openActorContextStore(options: OpenActorContextStoreOptions): Promise<ActorContextStore> {
  let lock: FileHandle | undefined;
  let lockIdentity: Identity | undefined;
  let directory = resolve(options.directory);
  let lockPath = join(directory, 'writer.lock');
  async function releaseLock(): Promise<void> {
    if (!lock) return;
    const owned = lock;
    lock = undefined;
    try {
      const current = await lstat(lockPath);
      if (!lockIdentity || !current.isFile() || !sameIdentity(current, lockIdentity)) integrity();
      await unlink(lockPath);
      await syncDirectory(directory);
    } finally { await owned.close(); }
  }
  try {
    const manifest = manifestSchema.parse({
      version: 'actor-context/v1', worldId: options.worldId, bindingDigest: options.bindingDigest,
      actorIds: [...options.actorIds].sort(), maxContextBytes: options.maxContextBytes,
    });
    if (new Set(manifest.actorIds).size !== manifest.actorIds.length) integrity();
    directory = await canonicalOwnedDirectory(directory);
    lockPath = join(directory, 'writer.lock');
    await ensureDirectory(directory);
    const rootIdentity = await assertDirectory(directory);
    // A failed competing open never owns this handle and therefore cannot remove this lock.
    lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    lockIdentity = await lock.stat();
    await lock.writeFile(randomUUID());
    await lock.sync();
    await syncDirectory(directory);
    const actorRoot = join(directory, 'actors');
    const manifestPath = join(directory, 'manifest.json');
    const manifestHash = hash(manifest);
    const fresh = !(await readdir(directory)).includes('manifest.json');
    if (fresh) {
      if ((await readdir(directory)).some(name => name !== 'writer.lock')) integrity();
      await ensureDirectory(actorRoot);
      for (const actorId of manifest.actorIds) {
        const path = join(actorRoot, actorName(actorId));
        await ensureDirectory(path);
        await publishImmutable(path, 'frontier.json', { sequence: 0, hash: hash([manifestHash, actorId]) });
      }
      await publishImmutable(directory, 'manifest.json', manifest);
    }
    if (hash(manifestSchema.parse(await readJson(manifestPath))) !== manifestHash) integrity();
    await assertDirectory(actorRoot);
    const expectedNames = manifest.actorIds.map(actorName).sort();
    if (JSON.stringify((await readdir(actorRoot)).sort()) !== JSON.stringify(expectedNames)) integrity();
    const actorIdentities = new Map<string, Identity>();
    for (const actorId of manifest.actorIds) {
      actorIdentities.set(actorId, await assertDirectory(join(actorRoot, actorName(actorId))));
    }
    let closed = false;
    let poisoned = false;
    let queue = Promise.resolve();
    const states = new Map<string, ActorState>();

    async function guard(): Promise<void> {
      if (closed || poisoned) integrity();
      if (!sameIdentity(await assertDirectory(directory), rootIdentity)) integrity();
      await assertDirectoryAncestry(directory);
      const currentLock = await lstat(lockPath);
      if (!currentLock.isFile() || !lockIdentity || !sameIdentity(currentLock, lockIdentity)) integrity();
      const names = (await readdir(directory)).sort();
      if (JSON.stringify(names) !== JSON.stringify(['actors', 'manifest.json', 'writer.lock'])) integrity();
      if (hash(manifestSchema.parse(await readJson(manifestPath))) !== manifestHash) integrity();
      await assertDirectory(actorRoot);
      if (JSON.stringify((await readdir(actorRoot)).sort()) !== JSON.stringify(expectedNames)) integrity();
    }

    async function readActor(actorId: string): Promise<ActorState> {
      const identity = actorIdentities.get(actorId);
      if (!identity) integrity();
      const path = join(actorRoot, actorName(actorId));
      if (!sameIdentity(await assertDirectory(path), identity)) integrity();
      const names = (await readdir(path)).sort();
      if (names.some(name => name !== 'frontier.json' && !/^record-[0-9]{12}\.json$/.test(name))) integrity();
      const frontier = { sequence: 0, hash: hash([manifestHash, actorId]) };
      const turns: TurnState[] = [];
      const ids = new Set<string>();
      for (const name of names.filter(name => name.startsWith('record-'))) {
        const record = recordSchema.parse(await readJson(join(path, name)));
        const { hash: recordHash, ...body } = record;
        if (record.actorId !== actorId || record.sequence !== frontier.sequence + 1
          || name !== recordName(record.sequence) || record.previousHash !== frontier.hash || recordHash !== hash(body)) integrity();
        const active = turns.at(-1);
        if (record.kind === 'begin') {
          if (ids.has(record.turnId) || (active && !active.status)) integrity();
          const input = parseActorContextMessage(record.input);
          pendingCalls([input]);
          if (record.inputHash !== hash([...project(turns), input])) integrity();
          ids.add(record.turnId);
          turns.push({ turnId: record.turnId, inputHash: record.inputHash, messages: [input] });
        } else {
          if (!active || active.status || active.turnId !== record.turnId) integrity();
          if (record.kind === 'message') {
            const message = parseActorContextMessage(record.message);
            pendingCalls([...active.messages, message]);
            active.messages.push(message);
          } else {
            if (pendingCalls(active.messages).size) integrity();
            active.status = record.status;
          }
        }
        frontier.sequence = record.sequence;
        frontier.hash = recordHash;
      }
      if (hash(frontierSchema.parse(await readJson(join(path, 'frontier.json')))) !== hash(frontier)) integrity();
      return { frontier, turns };
    }

    async function checkedActor(actorId: string): Promise<ActorState> {
      await guard();
      const state = await readActor(actorId);
      const expected = states.get(actorId);
      if (expected && hash(expected.frontier) !== hash(state.frontier)) integrity();
      return state;
    }

    function serialized<T>(work: () => Promise<T>): Promise<T> {
      const result = queue.then(work).catch(error => {
        if (error instanceof ActorContextError) throw error;
        poisoned = true;
        throw new ActorContextError('context_integrity_error');
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    }

    async function appendRecord(actorId: string, turnId: string, payload: RecordPayload): Promise<void> {
      const state = states.get(actorId)!;
      const path = join(actorRoot, actorName(actorId));
      const body = { version: 'actor-context-record/v1', actorId, turnId,
        sequence: state.frontier.sequence + 1, previousHash: state.frontier.hash, ...payload };
      const record = recordSchema.parse({ ...body, hash: hash(body) });
      try {
        await publishImmutable(path, recordName(record.sequence), record);
        // An interrupted record/tip update is deliberately not auto-reconciled on reopen.
        const tip = { sequence: record.sequence, hash: record.hash };
        await replaceFrontier(path, tip);
        states.set(actorId, await readActor(actorId));
      } catch {
        poisoned = true;
        integrity();
      }
    }

    await guard();
    for (const actorId of manifest.actorIds) states.set(actorId, await readActor(actorId));
    return {
      beginTurn: async options => {
        const request = { actorId: options.actorId, turnId: options.turnId, input: parseActorContextMessage(options.input) };
        return serialized(async () => {
          if (!identifier.safeParse(request.turnId).success) integrity();
          const input = request.input;
          const state = await checkedActor(request.actorId);
          if (state.turns.some(turn => turn.turnId === request.turnId)) integrity();
          if (state.turns.at(-1) && !state.turns.at(-1)!.status) incomplete();
          pendingCalls([input]);
          const priorMessages = project(state.turns);
          const inputHash = hash([...priorMessages, input]);
          await appendRecord(request.actorId, request.turnId, { kind: 'begin', input, inputHash });
          assertActorContextBudget([...priorMessages, input], manifest.maxContextBytes);
          const handle: ActorContextTurn = {
            get priorMessages() { return structuredClone(priorMessages); },
            inputHash,
            append: async messages => {
              const parsed = messages.map(parseActorContextMessage);
              if (!parsed.length) integrity();
              return serialized(async () => {
                const current = await checkedActor(request.actorId);
                const active = current.turns.at(-1);
                if (!active || active.turnId !== request.turnId || active.status) integrity();
                pendingCalls([...active.messages, ...parsed]);
                for (const message of parsed) await appendRecord(request.actorId, request.turnId, { kind: 'message', message });
              });
            },
            finish: status => serialized(async () => {
              if (!['succeeded', 'failed', 'cancelled'].includes(status)) integrity();
              const current = await checkedActor(request.actorId);
              const active = current.turns.at(-1);
              if (!active || active.turnId !== request.turnId) integrity();
              if (active.status) {
                if (active.status !== status) integrity();
                return;
              }
              if (pendingCalls(active.messages).size) incomplete();
              await appendRecord(request.actorId, request.turnId, { kind: 'finish', status });
            }),
          };
          return handle;
        });
      },
      getFrontier: actorId => serialized(async () => ({ ...(await checkedActor(actorId)).frontier })),
      close: () => serialized(async () => {
        if (closed) return;
        closed = true;
        await releaseLock();
      }),
    };
  } catch (error) {
    await releaseLock().catch(() => undefined);
    if (error instanceof ActorContextError) throw error;
    throw new ActorContextError('context_integrity_error');
  }
}

function recordName(sequence: number): string { return `record-${String(sequence).padStart(12, '0')}.json`; }

async function canonicalOwnedDirectory(path: string): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) integrity();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = dirname(path);
  if (parent === path) return path;
  let canonicalParent: string;
  try { canonicalParent = await realpath(parent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    canonicalParent = await canonicalOwnedDirectory(parent);
  }
  return join(canonicalParent, basename(path));
}

async function assertDirectory(path: string): Promise<Identity> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) integrity();
  return stat;
}

async function assertDirectoryAncestry(path: string): Promise<void> {
  await assertDirectory(path);
  if (dirname(path) !== path) await assertDirectoryAncestry(dirname(path));
}

async function ensureDirectory(path: string): Promise<void> {
  try { await assertDirectoryAncestry(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await ensureDirectory(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); }
    catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
    await assertDirectory(path);
    await syncDirectory(dirname(path));
  }
}

async function writeStage(directory: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES) integrity();
  const path = join(directory, `stage-${randomUUID()}.json`);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  return path;
}

async function publishImmutable(directory: string, name: string, value: unknown): Promise<void> {
  const stage = await writeStage(directory, value);
  try { await link(stage, join(directory, name)); await syncDirectory(directory); }
  finally { await unlink(stage); await syncDirectory(directory); }
}

async function replaceFrontier(directory: string, frontier: ActorContextFrontier): Promise<void> {
  const stage = await writeStage(directory, frontier);
  await rename(stage, join(directory, 'frontier.json'));
  await syncDirectory(directory);
}

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_RECORD_BYTES) integrity();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(before, current)
      || before.size !== after.size || offset !== before.size || before.mtimeMs !== after.mtimeMs) integrity();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  finally { await handle.close(); }
}
