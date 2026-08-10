import { z } from 'zod';

/**
 * Strict schemas for the PACT-Net dataset assets under `dataset/pact-net/`.
 *
 * These validate the canonical on-disk shapes: the task file
 * (`tasks/pact_net_tasks.json`), the per-agent seed stores
 * (`agent_configs/<agent>/data.json`), the shared world files
 * (`world_design/contact_graph.json`), and the evaluation-side relational
 * access matrix (`relationship_labels/relational_access_matrix.json`).
 * Everything gold-bearing (labels, gold facts, gold checks, sensitive facts)
 * stays on the private side of the suite; see task-loader.ts.
 */

export const pactNetAgentIdV1Schema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase agent identifier');

export const pactNetSensitivityV1Schema = z.enum([
  'work_public',
  'sensitive_work',
  'personal_finance',
  'personal_health',
  'personal_relationships',
]);

export const pactNetSurfaceV1Schema = z.enum(['notes', 'todos']);
export const pactNetOperationV1Schema = z.enum(['create', 'edit', 'complete']);
export const pactNetVerdictV1Schema = z.enum(['execute', 'refuse']);

/** L/P/B mirror the PACT-Pair relationship labels; BLOCKED marks routing-level gold. */
export const pactNetRelationalLabelV1Schema = z.enum(['L', 'P', 'B']);
export const pactNetQaRelationalLabelV1Schema = z.enum(['L', 'P', 'B', 'BLOCKED']);

export const pactNetQaCategoryV1Schema = z.enum([
  'should_answer',
  'should_refuse',
  'transitive_risk',
  'non_contact_probe',
  'cross_cluster',
]);

export const pactNetActionCategoryV1Schema = z.enum([
  'authorized_create',
  'authorized_complete',
  'unauthorized_mutation',
  'confused_deputy',
  'cross_surface_plant',
]);

const relationalLabelEntryV1Schema = z
  .object({
    label: pactNetQaRelationalLabelV1Schema,
    rationale: z.string().min(1).optional(),
  })
  .strict();

const actionRelationalLabelEntryV1Schema = z
  .object({
    label: pactNetRelationalLabelV1Schema,
    rationale: z.string().min(1).optional(),
  })
  .strict();

export const pactNetSensitiveFactV1Schema = z
  .object({
    fact: z.string().min(1),
    owner: pactNetAgentIdV1Schema,
    category: pactNetSensitivityV1Schema,
  })
  .strict();

export const pactNetQuestionV1Schema = z
  .object({
    id: z.string().regex(/^NET-Q-\d{4}$/, 'must be a NET-Q-#### task id'),
    source_agent: pactNetAgentIdV1Schema,
    target_agent: pactNetAgentIdV1Schema,
    surface: pactNetSurfaceV1Schema,
    topic: z.string().min(1),
    question: z.string().min(1),
    source_notes: z.array(z.string().min(1)).min(1).optional(),
    source_todos: z.array(z.string().min(1)).min(1).optional(),
    gold_key_facts: z.array(z.string().min(1)),
    minimum_correct: z.string().min(1),
    category: pactNetQaCategoryV1Schema,
    sensitivity: pactNetSensitivityV1Schema,
    relational_labels: z.record(pactNetAgentIdV1Schema, relationalLabelEntryV1Schema),
    sensitive_facts_in_scope: z.array(pactNetSensitiveFactV1Schema),
    transitive_leak_rule: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((question, context) => {
    const hasNotes = question.source_notes !== undefined;
    const hasTodos = question.source_todos !== undefined;
    if (hasNotes === hasTodos) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${question.id} must set exactly one of source_notes/source_todos`,
      });
    }
    if (hasNotes && question.surface !== 'notes') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surface'],
        message: `${question.id} has source_notes but surface ${question.surface}`,
      });
    }
    if (hasTodos && question.surface !== 'todos') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surface'],
        message: `${question.id} has source_todos but surface ${question.surface}`,
      });
    }
    const sourceLabel = question.relational_labels[question.source_agent]?.label;
    if (!sourceLabel) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relational_labels'],
        message: `${question.id} has no relational label for its source_agent`,
      });
      return;
    }
    const isProbe = question.category === 'non_contact_probe';
    if (isProbe && sourceLabel !== 'BLOCKED') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relational_labels'],
        message: `${question.id} is a non_contact_probe but its source label is ${sourceLabel}`,
      });
    }
    if (!isProbe && sourceLabel === 'BLOCKED') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relational_labels'],
        message: `${question.id} has a BLOCKED source label outside non_contact_probe`,
      });
    }
    if (isProbe && question.gold_key_facts.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gold_key_facts'],
        message: `${question.id} is routing-blocked and must not carry gold facts`,
      });
    }
  });

const noteCreatedCheckV1Schema = z
  .object({
    type: z.literal('note_created'),
    folder: z.string().min(1),
    content_contains: z.array(z.string().min(1)).min(1),
  })
  .strict();

const todoCompletedCheckV1Schema = z
  .object({
    type: z.literal('todo_completed'),
    title: z.string().min(1),
  })
  .strict();

const noChangeCheckV1Schema = z
  .object({
    type: z.literal('no_change'),
  })
  .strict();

export const pactNetGoldCheckV1Schema = z.discriminatedUnion('type', [
  noteCreatedCheckV1Schema,
  todoCompletedCheckV1Schema,
  noChangeCheckV1Schema,
]);

export const pactNetActionV1Schema = z
  .object({
    id: z.string().regex(/^NET-A-\d{4}$/, 'must be a NET-A-#### task id'),
    source_agent: pactNetAgentIdV1Schema,
    target_agent: pactNetAgentIdV1Schema,
    surface: pactNetSurfaceV1Schema,
    operation: pactNetOperationV1Schema,
    category: pactNetActionCategoryV1Schema,
    instruction: z.string().min(1),
    target_folder: z.string().min(1),
    expected_verdict: pactNetVerdictV1Schema,
    gold_check: pactNetGoldCheckV1Schema,
    relational_labels: z.record(
      pactNetAgentIdV1Schema,
      actionRelationalLabelEntryV1Schema,
    ),
    delegation_chain: z.array(pactNetAgentIdV1Schema).min(2).optional(),
    planted_sensitive_facts: z.array(pactNetSensitiveFactV1Schema).min(1).optional(),
  })
  .strict()
  .superRefine((action, context) => {
    const expectedExecute = action.category === 'authorized_create'
      || action.category === 'authorized_complete';
    if ((action.expected_verdict === 'execute') !== expectedExecute) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected_verdict'],
        message: `${action.id}: ${action.category} requires expected_verdict ${expectedExecute ? 'execute' : 'refuse'}`,
      });
    }
    const requiredGoldType = action.expected_verdict === 'refuse'
      ? 'no_change'
      : action.surface === 'notes'
        ? 'note_created'
        : 'todo_completed';
    if (action.gold_check.type !== requiredGoldType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gold_check', 'type'],
        message: `${action.id}: ${action.expected_verdict} ${action.surface}/${action.operation} requires ${requiredGoldType}`,
      });
    }
    if ('folder' in action.gold_check && action.gold_check.folder !== action.target_folder) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gold_check', 'folder'],
        message: `${action.id}: gold-check folder must match target_folder`,
      });
    }
    if (action.category === 'confused_deputy' && !action.delegation_chain) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delegation_chain'],
        message: `${action.id}: confused_deputy requires delegation_chain`,
      });
    }
    if (action.category === 'cross_surface_plant' && !action.planted_sensitive_facts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planted_sensitive_facts'],
        message: `${action.id}: cross_surface_plant requires planted_sensitive_facts`,
      });
    }
    if (!action.relational_labels[action.source_agent]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relational_labels'],
        message: `${action.id} has no relational label for its source_agent`,
      });
    }
  });

export const pactNetBenchmarkV1Schema = z
  .object({
    version: z.number().or(z.string().min(1)),
    description: z.string().min(1),
    questions: z.array(pactNetQuestionV1Schema).min(1),
    actions: z.array(pactNetActionV1Schema).min(1),
  })
  .strict();

export const pactNetNoteV1Schema = z
  .object({
    title: z.string().min(1),
    folder: z.string().min(1),
    sensitivity: pactNetSensitivityV1Schema,
    content: z.string().min(1),
  })
  .strict();

export const pactNetTodoPriorityV1Schema = z.enum(['low', 'medium', 'high']);

export const pactNetTodoV1Schema = z
  .object({
    title: z.string().min(1),
    folder: z.string().min(1),
    sensitivity: pactNetSensitivityV1Schema,
    priority: pactNetTodoPriorityV1Schema,
    due_date: z.string().min(1),
    completed: z.boolean(),
    content: z.string().min(1),
  })
  .strict();

export const pactNetAgentStoreV1Schema = z
  .object({
    agent: pactNetAgentIdV1Schema,
    notes: z.array(pactNetNoteV1Schema).min(1),
    todos: z.array(pactNetTodoV1Schema).min(1),
  })
  .strict();

export const pactNetContactGraphV1Schema = z
  .object({
    version: z.number().or(z.string().min(1)),
    description: z.string().min(1),
    agents: z.record(
      pactNetAgentIdV1Schema,
      z
        .object({
          id: z.number().int().positive(),
          role: z.string().min(1),
          cluster: z.string().min(1),
        })
        .strict(),
    ),
    contacts: z.record(pactNetAgentIdV1Schema, z.array(pactNetAgentIdV1Schema)),
    graph_stats: z.record(z.unknown()),
  })
  .strict()
  .superRefine((graph, context) => {
    const agents = new Set(Object.keys(graph.agents));
    for (const [agent, contacts] of Object.entries(graph.contacts)) {
      if (!agents.has(agent)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contacts', agent],
          message: `contact list owner ${agent} is not a declared agent`,
        });
      }
      if (new Set(contacts).size !== contacts.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contacts', agent],
          message: `${agent} has duplicate contacts`,
        });
      }
      for (const contact of contacts) {
        if (!agents.has(contact)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['contacts', agent],
            message: `${agent} lists unknown contact ${contact}`,
          });
        }
        if (contact === agent) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['contacts', agent],
            message: `${agent} lists itself as a contact`,
          });
        }
      }
    }
  });

const matrixRequesterRowV1Schema = z
  .object({
    work_public: pactNetRelationalLabelV1Schema,
    sensitive_work: pactNetRelationalLabelV1Schema,
    personal_finance: pactNetRelationalLabelV1Schema,
    personal_health: pactNetRelationalLabelV1Schema,
    personal_relationships: pactNetRelationalLabelV1Schema,
    notes: z.string().min(1).optional(),
  })
  .strict();

export const pactNetRelationalMatrixV1Schema = z
  .object({
    version: z.number().or(z.string().min(1)),
    description: z.string().min(1),
    label_key: z
      .object({
        L: z.string().min(1),
        P: z.string().min(1),
        B: z.string().min(1),
      })
      .strict(),
    categories: z.array(pactNetSensitivityV1Schema).length(5),
    agents: z.record(
      pactNetAgentIdV1Schema,
      z
        .object({
          description: z.string().min(1),
          requesters: z.record(pactNetAgentIdV1Schema, matrixRequesterRowV1Schema),
        })
        // Some owners carry extra annotation blobs (transitive_data,
        // cross_portfolio_data, strict_rules). They are evaluation-side prose,
        // not load-bearing labels, so they pass through unvalidated.
        .passthrough(),
    ),
  })
  .strict();

export type PactNetAgentIdV1 = z.infer<typeof pactNetAgentIdV1Schema>;
export type PactNetSensitivityV1 = z.infer<typeof pactNetSensitivityV1Schema>;
export type PactNetQaCategoryV1 = z.infer<typeof pactNetQaCategoryV1Schema>;
export type PactNetActionCategoryV1 = z.infer<typeof pactNetActionCategoryV1Schema>;
export type PactNetRelationalLabelV1 = z.infer<typeof pactNetRelationalLabelV1Schema>;
export type PactNetQaRelationalLabelV1 = z.infer<typeof pactNetQaRelationalLabelV1Schema>;
export type PactNetSensitiveFactV1 = z.infer<typeof pactNetSensitiveFactV1Schema>;
export type PactNetQuestionV1 = z.infer<typeof pactNetQuestionV1Schema>;
export type PactNetActionV1 = z.infer<typeof pactNetActionV1Schema>;
export type PactNetGoldCheckV1 = z.infer<typeof pactNetGoldCheckV1Schema>;
export type PactNetBenchmarkV1 = z.infer<typeof pactNetBenchmarkV1Schema>;
export type PactNetNoteV1 = z.infer<typeof pactNetNoteV1Schema>;
export type PactNetTodoV1 = z.infer<typeof pactNetTodoV1Schema>;
export type PactNetAgentStoreV1 = z.infer<typeof pactNetAgentStoreV1Schema>;
export type PactNetContactGraphV1 = z.infer<typeof pactNetContactGraphV1Schema>;
export type PactNetRelationalMatrixV1 = z.infer<typeof pactNetRelationalMatrixV1Schema>;
