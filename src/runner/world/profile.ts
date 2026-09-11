import { z } from 'zod';

export const worldProfileSchema = z.object({
  protocol: z.literal('actor-context/v1').default('actor-context/v1'),
  maxContextBytes: z.number().int().safe().min(1_024).max(16 * 1_024 * 1_024)
    .default(1_048_576),
}).strict();

export type WorldProfile = Readonly<z.infer<typeof worldProfileSchema>>;

export const worldContextFrontiersSchema = z.array(z.object({
  actorId: z.string().min(1).max(128),
  sequence: z.number().int().safe().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()).min(1).max(10_000).refine(
  values => new Set(values.map(value => value.actorId)).size === values.length,
  'actor context frontiers must be unique',
);

export type WorldContextFrontiers = z.infer<typeof worldContextFrontiersSchema>;

export const worldContextCommitSchema = z.object({
  before: worldContextFrontiersSchema,
  after: worldContextFrontiersSchema,
}).strict();
export type WorldContextCommit = z.infer<typeof worldContextCommitSchema>;

export function assertWorldContextCommit(
  actorIds: readonly string[], commit: WorldContextCommit,
  previous?: WorldContextFrontiers,
): void {
  const parsed = worldContextCommitSchema.parse(commit);
  const expectedIds = JSON.stringify([...actorIds].sort());
  if ([parsed.before, parsed.after].some(values => (
    JSON.stringify(values.map(value => value.actorId)) !== expectedIds
  ))) throw new Error('World context commit carries a foreign actor set');
  if (previous ? JSON.stringify(parsed.before) !== JSON.stringify(previous)
    : parsed.before.some(value => value.sequence !== 0)) {
    throw new Error('World context history is not contiguous');
  }
  for (const [index, before] of parsed.before.entries()) {
    const after = parsed.after[index]!;
    if (after.sequence < before.sequence
      || (after.sequence === before.sequence) !== (after.hash === before.hash)) {
      throw new Error('World context commit has an invalid frontier transition');
    }
  }
}
