import { z } from 'zod';

const usageCountSchema = z.number().int().safe().nonnegative();

export const fileTurnDecisionV1Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('completed'),
    content: z.string().min(1).max(1_048_576),
    toolSteps: usageCountSchema,
    contactCalls: usageCountSchema,
  }).strict(),
  z.object({
    type: z.literal('denied'),
    reason: z.string().min(1).max(65_536),
    toolSteps: usageCountSchema,
    contactCalls: usageCountSchema,
  }).strict(),
  z.object({
    type: z.literal('cancelled'),
    reason: z.string().min(1).max(4_096),
    toolSteps: usageCountSchema,
    contactCalls: usageCountSchema,
  }).strict(),
]);

export type FileTurnDecisionV1 = z.infer<typeof fileTurnDecisionV1Schema>;
