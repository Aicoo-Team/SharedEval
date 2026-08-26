import { z } from 'zod';
import { jsonObjectSchema } from './json.js';

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be an opaque identifier');
const textSchema = z.string().trim().min(1);

export const pactToolNameV1Schema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be a valid tool identifier');

export const pactToolSpecV1Schema = z
  .object({
    name: pactToolNameV1Schema,
    description: z.string().max(2_000).optional(),
    inputSchema: jsonObjectSchema,
    sideEffects: z.enum(['read', 'write']),
  })
  .strict();
export type PactToolSpecV1 = z.infer<typeof pactToolSpecV1Schema>;

export const pactIdentityV1Schema = z
  .object({
    id: opaqueIdSchema,
    displayName: textSchema.max(128).optional(),
    relationship: textSchema
      .max(128)
      .refine(value => !['P', 'L', 'B', 'BLOCKED'].includes(value.toUpperCase()), {
        message: 'private benchmark relationship labels are not public identities',
      })
      .optional(),
  })
  .strict();
export type PactIdentityV1 = z.infer<typeof pactIdentityV1Schema>;

const taskCommonV1Shape = {
  taskId: opaqueIdSchema,
  prompt: z.string().min(1).max(32_768),
  requester: pactIdentityV1Schema,
  target: pactIdentityV1Schema,
  surface: z.enum(['notes', 'todos', 'calendar', 'email', 'messaging', 'unknown']),
};

export const pactTaskIntroV1Schema = z.discriminatedUnion('kind', [
  z.object({ ...taskCommonV1Shape, kind: z.literal('qa') }).strict(),
  z.object({
    ...taskCommonV1Shape,
    kind: z.literal('action'),
    operation: textSchema.max(64),
  }).strict(),
]);
export type PactTaskIntroV1 = z.infer<typeof pactTaskIntroV1Schema>;

export const pactAnswerDecisionV1Schema = z
  .object({ type: z.literal('answer'), content: z.string().min(1).max(65_536) })
  .strict();
export const pactRefuseDecisionV1Schema = z
  .object({ type: z.literal('refuse'), reason: z.string().min(1).max(4_096) })
  .strict();
export const pactToolCallDecisionV1Schema = z
  .object({
    type: z.literal('tool_call'),
    toolName: pactToolNameV1Schema,
    input: jsonObjectSchema,
  })
  .strict();
export const pactEscalateDecisionV1Schema = z
  .object({ type: z.literal('escalate'), reason: z.string().min(1).max(4_096) })
  .strict();

export const pactTerminalDecisionV1Schema = z.discriminatedUnion('type', [
  pactAnswerDecisionV1Schema,
  pactRefuseDecisionV1Schema,
  pactEscalateDecisionV1Schema,
]);

export const pactDecisionV1Schema = z.discriminatedUnion('type', [
  pactAnswerDecisionV1Schema,
  pactRefuseDecisionV1Schema,
  pactToolCallDecisionV1Schema,
  pactEscalateDecisionV1Schema,
]);
export type PactDecisionV1 = z.infer<typeof pactDecisionV1Schema>;

function toPublicIdentity(input: PactIdentityV1): PactIdentityV1 {
  return pactIdentityV1Schema.parse({
    id: input.id,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.relationship === undefined ? {} : { relationship: input.relationship }),
  });
}

export function toPublicPactTaskIntroV1(input: PactTaskIntroV1): PactTaskIntroV1 {
  const common = {
    taskId: input.taskId,
    kind: input.kind,
    prompt: input.prompt,
    requester: toPublicIdentity(input.requester),
    target: toPublicIdentity(input.target),
    surface: input.surface,
  };
  return pactTaskIntroV1Schema.parse(
    input.kind === 'action' ? { ...common, operation: input.operation } : common,
  );
}
