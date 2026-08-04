import { z } from 'zod';

export const sensitivitySchema = z.enum([
  'work_public',
  'sensitive_work',
  'personal_finance',
  'personal_health',
  'personal_relationships',
]);

export const surfaceSchema = z.enum(['notes', 'todos']);
export const actionOperationSchema = z.enum(['create', 'edit', 'complete']);
export const actionVerdictSchema = z.enum(['execute', 'refuse']);
export const relationshipLabelSchema = z.enum(['L', 'P', 'B']);

const pairRelationshipLabelRowSchema = z
  .object({
    id: z.number().int().positive(),
    category: z.string().min(1),
    question: z.string().min(1),
    R0: relationshipLabelSchema,
    R1: relationshipLabelSchema,
    R2: relationshipLabelSchema,
    R3: relationshipLabelSchema,
    R4: relationshipLabelSchema,
    R1_rationale: z.string().min(1).optional(),
    R2_rationale: z.string().min(1).optional(),
    R3_rationale: z.string().min(1).optional(),
    R4_rationale: z.string().min(1).optional(),
  })
  .strict();

export const pairRelationshipLabelMatrixSchema = z
  .object({
    version: z.string().min(1),
    description: z.string().min(1),
    requesters: z
      .object({
        R0: z.string().min(1),
        R1: z.string().min(1),
        R2: z.string().min(1),
        R3: z.string().min(1),
        R4: z.string().min(1),
      })
      .strict(),
    label_key: z
      .object({
        P: z.string().min(1),
        L: z.string().min(1),
        B: z.string().min(1),
      })
      .strict(),
    labels: z.array(pairRelationshipLabelRowSchema).min(1),
  })
  .strict();

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

const createdContentCheckSchema = z
  .object({
    folder: z.string().min(1),
    content_contains: z.array(z.string().min(1)).min(1),
  })
  .strict();

function editedContentCheckSchema(type: 'note_edited' | 'todo_edited') {
  return z.union([
    z
      .object({
        type: z.literal(type),
        folder: z.string().min(1),
        content_contains: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal(type),
        target: z.string().min(1),
        content_contains: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  ]);
}

const todoCompletedCheckSchema = z
  .object({
    type: z.literal('todo_completed'),
    target: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict()
  .refine(value => Boolean(value.target || value.title), {
    message: 'todo_completed requires target or title',
  });

export const goldCheckSchema = z.union([
  createdContentCheckSchema.extend({ type: z.literal('note_created') }).strict(),
  editedContentCheckSchema('note_edited'),
  createdContentCheckSchema.extend({ type: z.literal('todo_created') }).strict(),
  editedContentCheckSchema('todo_edited'),
  todoCompletedCheckSchema,
  z
    .object({
      type: z.literal('no_change'),
      verify: z.string().min(1).optional(),
    })
    .strict(),
]);

type ActionContract = {
  surface: z.infer<typeof surfaceSchema>;
  operation: z.infer<typeof actionOperationSchema>;
  target_folder: string;
  target_item?: string | null;
  expected_verdict: z.infer<typeof actionVerdictSchema>;
  gold_check: z.infer<typeof goldCheckSchema>;
};

function validateActionContract(value: ActionContract, ctx: z.RefinementCtx): void {
  const expectedGoldType = value.surface === 'notes'
    ? value.operation === 'create'
      ? 'note_created'
      : value.operation === 'edit'
        ? 'note_edited'
        : null
    : value.operation === 'create'
      ? 'todo_created'
      : value.operation === 'edit'
        ? 'todo_edited'
        : 'todo_completed';

  if (!expectedGoldType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['operation'],
      message: 'notes actions do not support the complete operation',
    });
    return;
  }

  const requiredGoldType = value.expected_verdict === 'refuse' ? 'no_change' : expectedGoldType;
  if (value.gold_check.type !== requiredGoldType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gold_check', 'type'],
      message: `${value.expected_verdict} ${value.surface}/${value.operation} actions require ${requiredGoldType}`,
    });
  }

  if ('folder' in value.gold_check && value.gold_check.folder !== value.target_folder) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gold_check', 'folder'],
      message: 'gold-check folder must match target_folder',
    });
  }

  if ('target_item' in value) {
    if (value.operation === 'create' && value.target_item !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_item'],
        message: 'create actions must have a null target_item',
      });
    }
    if (value.operation !== 'create' && !value.target_item) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_item'],
        message: 'edit and complete actions require target_item',
      });
    }

    const goldTarget = 'target' in value.gold_check
      ? value.gold_check.target
      : 'title' in value.gold_check
        ? value.gold_check.title
        : undefined;
    if (goldTarget && value.target_item && goldTarget !== value.target_item) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gold_check'],
        message: 'gold-check target must match target_item',
      });
    }
  } else if (
    value.expected_verdict === 'execute'
    && value.operation === 'edit'
    && !('target' in value.gold_check)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gold_check'],
      message: 'executed edit actions require an exact gold-check target',
    });
  }
}

export const pairActionSchema = z.object({
  id: z.number().int().positive(),
  surface: surfaceSchema,
  operation: actionOperationSchema,
  category: z.string().min(1),
  instruction: z.string().min(1),
  target_folder: z.string().min(1),
  target_item: z.string().min(1).nullable(),
  expected_verdict: actionVerdictSchema,
  gold_check: goldCheckSchema,
}).strict().superRefine(validateActionContract);

export const pairBenchmarkSchema = z.object({
  version: z.number().int().positive(),
  total: z.number().int().positive(),
  tracks: z.record(z.unknown()),
  categories: z.array(z.record(z.unknown())),
  questions: z.array(pairQuestionSchema),
  actions: z.array(pairActionSchema),
});

const pairOwnerSchema = z
  .object({
    name: z.string().min(1),
    role: z.string().min(1),
    company: z.string().min(1),
    background: z.string().min(1),
  })
  .strict();

export const pairNoteFolderSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    parentId: z.number().int().positive().nullable(),
    sensitivity: z.string().min(1),
  })
  .strict();

export const pairTodoFolderSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    sensitivity: z.string().min(1),
  })
  .strict();

export const pairNoteSchema = z
  .object({
    id: z.number().int().positive(),
    folderId: z.number().int().positive(),
    title: z.string().min(1),
    content: z.string().min(1),
  })
  .strict();

const pairTodoBaseSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().min(1),
  folderId: z.number().int().positive(),
  priority: z.number().int().min(0).max(2),
  category: sensitivitySchema,
});

export const pairTodoSchema = z.discriminatedUnion('completed', [
  pairTodoBaseSchema.extend({
    completed: z.literal(false),
    dueDate: z.string().min(1),
  }).strict(),
  pairTodoBaseSchema.extend({
    completed: z.literal(true),
    completedAt: z.string().min(1),
  }).strict(),
]);

export const dataStoreSchema = z
  .object({
    version: z.number().or(z.string()),
    description: z.string().min(1),
    owner: pairOwnerSchema,
    note_folders: z.array(pairNoteFolderSchema).min(1),
    todo_folders: z.array(pairTodoFolderSchema).min(1),
    notes: z.array(pairNoteSchema).min(1),
    todos: z.array(pairTodoSchema).min(1),
  })
  .strict();

export type PairBenchmark = z.infer<typeof pairBenchmarkSchema>;
export type PairQuestion = z.infer<typeof pairQuestionSchema>;
export type PairAction = z.infer<typeof pairActionSchema>;
export type PairDataStore = z.infer<typeof dataStoreSchema>;
export type PairRelationshipLabelMatrix = z.infer<typeof pairRelationshipLabelMatrixSchema>;
