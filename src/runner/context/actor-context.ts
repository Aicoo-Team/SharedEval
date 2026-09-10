import { z } from 'zod';
import { assertJsonComplexityV1, jsonValueSchema, type JsonValue } from '../../contracts/json.js';

export type ActorContextMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{
    id: string; type: 'function'; function: { name: string; arguments: string };
  }>; reasoning_details?: JsonValue[]; refusal?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ActorContextStatus = 'succeeded' | 'failed' | 'cancelled';
export type ActorContextFrontier = { sequence: number; hash: string };
export interface ActorContextTurn {
  readonly priorMessages: readonly ActorContextMessage[];
  readonly inputHash: string;
  append(messages: readonly ActorContextMessage[]): Promise<void>;
  finish(status: ActorContextStatus): Promise<void>;
}
export interface ActorContextStore {
  beginTurn(options: { actorId: string; turnId: string; input: ActorContextMessage }): Promise<ActorContextTurn>;
  getFrontier(actorId: string): Promise<ActorContextFrontier>;
  close(): Promise<void>;
}
export type OpenActorContextStoreOptions = {
  directory: string;
  worldId: string;
  bindingDigest: string;
  actorIds: readonly string[];
  maxContextBytes: number;
};

export class ActorContextError extends Error {
  constructor(readonly code: 'context_budget_exhausted' | 'context_integrity_error' | 'context_turn_incomplete') {
    super(code);
    this.name = 'ActorContextError';
  }
}

export const actorContextMessageSchema: z.ZodType<ActorContextMessage> = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    tool_calls: z.array(z.object({
      id: z.string().min(1), type: z.literal('function'),
      function: z.object({ name: z.string().min(1), arguments: z.string() }).strict(),
    }).strict()).optional(),
    reasoning_details: z.array(jsonValueSchema).optional(),
    refusal: z.string().optional(),
  }).strict(),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().min(1), content: z.string() }).strict(),
]);

export function parseActorContextMessage(value: unknown): ActorContextMessage {
  try {
    assertJsonComplexityV1(value, 'actor context message');
    return JSON.parse(JSON.stringify(actorContextMessageSchema.parse(value))) as ActorContextMessage;
  } catch {
    throw new ActorContextError('context_integrity_error');
  }
}

export function assertActorContextBudget(messages: readonly ActorContextMessage[], maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ActorContextError('context_integrity_error');
  }
  const parsed = messages.map(parseActorContextMessage);
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > maxBytes) {
    throw new ActorContextError('context_budget_exhausted');
  }
}
