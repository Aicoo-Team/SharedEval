import { z } from 'zod';

export const sensitivitySchema = z.enum([
  'work_public',
  'sensitive_work',
  'personal_finance',
  'personal_health',
  'personal_relationships',
]);

export const surfaceSchema = z.enum(['notes', 'todos']);
export const actionVerdictSchema = z.enum(['execute', 'refuse']);
export const relationshipLabelSchema = z.enum(['L', 'P', 'B', 'BLOCKED']);

export const pairQuestionSchema = z.object({
  id: z.number().int().positive(),
  category: z.string().min(1),
  topic: z.string().min(1),
  question: z.string().min(1),
  source_notes: z.array(z.string()).optional(),
  source_todos: z.array(z.string()).optional(),
  gold_key_facts: z.array(z.string().min(1)).min(1),
  minimum_correct: z.string().min(1),
});

export const goldCheckSchema = z.object({ type: z.string().min(1) }).passthrough();

export const pairActionSchema = z.object({
  id: z.number().int().positive(),
  surface: surfaceSchema,
  operation: z.string().min(1),
  category: z.string().min(1),
  instruction: z.string().min(1),
  expected_verdict: actionVerdictSchema,
  gold_check: goldCheckSchema,
});

export const pairBenchmarkSchema = z.object({
  version: z.number().int().positive(),
  total: z.number().int().positive(),
  tracks: z.record(z.unknown()),
  categories: z.array(z.record(z.unknown())),
  questions: z.array(pairQuestionSchema),
  actions: z.array(pairActionSchema),
});

const relationalLabelsSchema = z.record(
  z.object({
    label: relationshipLabelSchema,
  }).passthrough(),
);

export const netQuestionSchema = z.object({
  id: z.string().min(1),
  source_agent: z.string().min(1),
  target_agent: z.string().min(1),
  surface: surfaceSchema,
  topic: z.string().min(1),
  question: z.string().min(1),
  source_notes: z.array(z.string()).optional(),
  source_todos: z.array(z.string()).optional(),
  gold_key_facts: z.array(z.string().min(1)),
  minimum_correct: z.string().min(1),
  category: z.string().min(1),
  sensitivity: sensitivitySchema,
  relational_labels: relationalLabelsSchema,
  sensitive_facts_in_scope: z.array(z.unknown()).optional(),
  transitive_leak_rule: z.unknown().nullable().optional(),
});

export const netActionSchema = z.object({
  id: z.string().min(1),
  source_agent: z.string().min(1),
  target_agent: z.string().min(1),
  surface: surfaceSchema,
  operation: z.string().min(1),
  instruction: z.string().min(1),
  category: z.string().min(1),
  expected_verdict: actionVerdictSchema,
  gold_check: goldCheckSchema,
  relational_labels: relationalLabelsSchema,
});

export const netBenchmarkSchema = z.object({
  version: z.string().min(1),
  description: z.string().min(1),
  questions: z.array(netQuestionSchema),
  actions: z.array(netActionSchema),
});

export const dataStoreSchema = z.object({
  version: z.number().or(z.string()),
  owner: z.record(z.unknown()),
  note_folders: z.array(z.record(z.unknown())),
  todo_folders: z.array(z.record(z.unknown())),
  notes: z.array(z.record(z.unknown())),
  todos: z.array(z.record(z.unknown())),
}).passthrough();

export type PairBenchmark = z.infer<typeof pairBenchmarkSchema>;
export type PairQuestion = z.infer<typeof pairQuestionSchema>;
export type PairAction = z.infer<typeof pairActionSchema>;
export type NetBenchmark = z.infer<typeof netBenchmarkSchema>;
export type NetQuestion = z.infer<typeof netQuestionSchema>;
export type NetAction = z.infer<typeof netActionSchema>;
