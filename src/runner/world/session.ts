import { isDeepStrictEqual } from 'node:util';
import { ActorContextError, type ActorContextStore } from '../context/actor-context.js';
import { openActorContextStore } from '../context/actor-context-store.js';
import { worldProfileSchema, worldContextFrontiersSchema,
  type WorldContextFrontiers, type WorldProfile } from './profile.js';

export type WorldActorContext = Readonly<{
  store: ActorContextStore;
  actorId: string;
  maxContextBytes: number;
}>;

export interface WorldSession {
  actorContext(actorId: string): WorldActorContext;
  frontiers(): Promise<WorldContextFrontiers>;
  assertCommittedFrontiers(expected: WorldContextFrontiers | undefined): Promise<void>;
  close(): Promise<void>;
}

/** Benchmark adapters own topology, work selection, and scoring, not actor history. */
export async function openWorldSession(options: Readonly<{
  directory: string;
  worldId: string;
  bindingDigest: string;
  actorIds: readonly string[];
  profile: WorldProfile;
}>): Promise<WorldSession> {
  const profile = worldProfileSchema.parse(options.profile);
  const actorIds = [...options.actorIds].sort();
  worldContextFrontiersSchema.parse(actorIds.map(actorId => ({
    actorId, sequence: 0, hash: '0'.repeat(64),
  })));
  const store = await openActorContextStore({
    directory: options.directory,
    worldId: options.worldId,
    bindingDigest: options.bindingDigest,
    actorIds,
    maxContextBytes: profile.maxContextBytes,
  });
  const frontiers = async () => {
    const values: WorldContextFrontiers = [];
    for (const actorId of actorIds) values.push({ actorId, ...await store.getFrontier(actorId) });
    return worldContextFrontiersSchema.parse(values);
  };
  return {
    actorContext(actorId) {
      if (!actorIds.includes(actorId)) throw new ActorContextError('context_integrity_error');
      return Object.freeze({ store, actorId, maxContextBytes: profile.maxContextBytes });
    },
    frontiers,
    async assertCommittedFrontiers(expected) {
      const actual = await frontiers();
      if (expected === undefined ? actual.some(value => value.sequence !== 0)
        : !isDeepStrictEqual(actual, worldContextFrontiersSchema.parse(expected))) {
        throw new ActorContextError('context_integrity_error');
      }
    },
    close: () => store.close(),
  };
}
