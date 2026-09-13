import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { worldProfileSchema } from '../../../runner/world/profile.js';
import {
  actorIdSchema, assignedProcurementProfileSchema, caseIdSchema, profileActors,
} from '../pilot/profile.js';

/** Bounded synthetic case bindings and explicit public disclosure; not a benchmark rubric. */
export const procurementWorldProfileSchema = z.object({
  version: z.literal('pact-net-procurement-world/v1'),
  mode: z.enum(['multi', 'single']),
  context: worldProfileSchema,
  cases: z.array(assignedProcurementProfileSchema).min(1).max(8),
  publicState: z.object({
    caseIds: z.array(caseIdSchema).max(8),
    readers: z.array(actorIdSchema).max(24),
  }).strict(),
}).strict().superRefine((profile, context) => {
  const reject = (message: string, path: string[]) => context.addIssue({
    code: z.ZodIssueCode.custom, message, path,
  });
  const caseIds = new Set(profile.cases.map(entry => entry.initial.case_id));
  if (caseIds.size !== profile.cases.length) reject('world case IDs must be unique', ['cases']);
  const actors = new Set(profile.cases.flatMap(profile => profileActors(profile)));
  const disclosure = profile.publicState;
  if (new Set(disclosure.caseIds).size !== disclosure.caseIds.length) {
    reject('public state case IDs must be unique', ['publicState', 'caseIds']);
  }
  if (disclosure.caseIds.some(caseId => !caseIds.has(caseId))) {
    reject('public state case IDs must belong to the world', ['publicState', 'caseIds']);
  }
  if (new Set(disclosure.readers).size !== disclosure.readers.length) {
    reject('public state readers must be unique', ['publicState', 'readers']);
  }
  if (disclosure.readers.some(actor => !actors.has(actor))) {
    reject('public state readers must belong to the world', ['publicState', 'readers']);
  }
}).transform(profile => deepFreeze(profile));

export type ProcurementWorldProfile = z.infer<typeof procurementWorldProfileSchema>;

export function createProcurementWorldProfile(input: unknown): ProcurementWorldProfile {
  try { return procurementWorldProfileSchema.parse(input); }
  catch (cause) { throw new Error('procurement_world_profile_invalid', { cause }); }
}

export async function loadProcurementWorldProfile(path: string): Promise<ProcurementWorldProfile> {
  return createProcurementWorldProfile(JSON.parse(await readFile(path, 'utf8')));
}

export function worldActors(profile: ProcurementWorldProfile): string[] {
  return deepFreeze([...new Set(profile.cases.flatMap(entry => profileActors(entry)))].sort());
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
