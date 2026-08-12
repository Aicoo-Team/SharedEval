import { z } from 'zod';

export const PACT_MANIFEST_API_VERSION_V1 = 'pact-bench/v1' as const;
export const PACT_ADAPTER_PROTOCOL_VERSION_V1 = 'pact-adapter/v1' as const;
export const PACT_ADAPTER_TRANSPORT_V1 = 'jsonrpc-stdio/v1' as const;

// These are schemas rather than literals embedded at each call site so a
// future track can extend the protocol boundary without bypassing validation.
// Protocol v1 still supports only the PACT-Pair responder contract.
export const pactBenchmarkTrackV1Schema = z.enum(['pact-pair']);
export const pactBenchmarkModeV1Schema = z.enum(['pair-responder']);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const reservedJsonObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);
const jsonObjectKeySchema = z.string().refine(key => !reservedJsonObjectKeys.has(key), {
  message: 'reserved JSON object keys are not allowed',
});

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonObjectKeySchema, jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  jsonObjectKeySchema,
  jsonValueSchema,
);

const textSchema = z.string().trim().min(1);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be an opaque identifier');
export const pactToolNameV1Schema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be a valid tool identifier');
const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug');
const semverSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    'must be a semantic version',
  );

export const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => !value.includes('\0'), 'NUL is not allowed')
  .refine(value => !value.startsWith('/'), 'path must be relative')
  .refine(value => !/^[A-Za-z]:/.test(value), 'path must be relative')
  .refine(value => !value.includes('\\'), 'use POSIX path separators')
  .refine(value => !value.split('/').includes('..'), 'path cannot escape the submission root')
  .refine(
    value => value === '.' || /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value),
    'path contains unsupported characters',
  )
  .refine(
    value => value === '.' || value.split('/').every(segment => segment !== '.'),
    'dot path segments are not allowed',
  );

const httpUrlSchema = z
  .string()
  .url()
  .refine(value => value.startsWith('https://') || value.startsWith('http://'), {
    message: 'must use http or https',
  });

export const pactCapabilityV1Schema = z.enum([
  'answer',
  'refuse',
  'tool_call',
  'escalate',
]);

const dockerBuildSourceV1Schema = z
  .object({
    kind: z.literal('build'),
    context: safeRelativePathSchema,
    dockerfile: safeRelativePathSchema,
  })
  .strict();

export const pactRuntimeV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('local-ts'),
      entrypoint: safeRelativePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('docker'),
      protocol: z.literal(PACT_ADAPTER_TRANSPORT_V1),
      source: dockerBuildSourceV1Schema,
      network: z.enum(['disabled', 'model-gateway']),
    })
    .strict(),
]);

const capabilityListV1Schema = z
  .array(pactCapabilityV1Schema)
  .min(1)
  .max(4)
  .refine(values => new Set(values).size === values.length, {
    message: 'capabilities must be unique',
  });

export const pactSubmissionManifestV1Schema = z
  .object({
    apiVersion: z.literal(PACT_MANIFEST_API_VERSION_V1),
    kind: z.literal('Submission'),
    id: slugSchema,
    name: textSchema.max(80),
    version: semverSchema,
    description: textSchema.max(500).optional(),
    track: pactBenchmarkTrackV1Schema,
    mode: pactBenchmarkModeV1Schema,
    submitter: z
      .object({
        organization: textSchema.max(100),
        contact: z.string().email().max(254).optional(),
      })
      .strict(),
    model: z
      .object({
        provider: textSchema.max(64),
        name: textSchema.max(128),
        revision: textSchema.max(128).optional(),
        temperature: z.number().finite().min(0).max(2).optional(),
      })
      .strict(),
    agent: z
      .object({
        architecture: textSchema.max(128),
        repository: httpUrlSchema.optional(),
        revision: textSchema.max(128).optional(),
      })
      .strict(),
    capabilities: capabilityListV1Schema,
    runtime: pactRuntimeV1Schema,
    declarations: z
      .object({
        usesExternalServices: z.boolean(),
        usesExternalTools: z.boolean(),
        usesPersistentMemory: z.boolean(),
        frameworks: z.array(textSchema.max(64)).max(16).optional(),
        notes: z.string().trim().max(2_000).optional(),
      })
      .strict(),
  })
  .strict();

export const pactBudgetV1Schema = z
  .object({
    maxTurns: z.number().int().min(1).max(64),
    maxToolCalls: z.number().int().min(0).max(64),
    maxRuntimeMs: z.number().int().min(1).max(3_600_000),
    maxTokens: z.number().int().safe().positive().max(10_000_000).optional(),
    maxCostUsd: z.number().finite().nonnegative().max(10_000).optional(),
  })
  .strict();

export const pactBudgetRemainingV1Schema = z
  .object({
    turns: z.number().int().safe().nonnegative().max(64),
    toolCalls: z.number().int().safe().nonnegative().max(64),
    runtimeMs: z.number().int().safe().nonnegative().max(3_600_000),
    tokens: z.number().int().safe().nonnegative().max(10_000_000).optional(),
    costUsd: z.number().finite().nonnegative().max(10_000).optional(),
  })
  .strict();

export const pactToolSpecV1Schema = z
  .object({
    name: pactToolNameV1Schema,
    description: z.string().max(2_000).optional(),
    inputSchema: jsonObjectSchema,
    sideEffects: z.enum(['read', 'write']),
  })
  .strict();

const toolListV1Schema = z
  .array(pactToolSpecV1Schema)
  .max(64)
  .refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length, {
    message: 'tool names must be unique',
  });

export const pactRunInitV1Schema = z
  .object({
    protocolVersion: z.literal(PACT_ADAPTER_PROTOCOL_VERSION_V1),
    sessionId: opaqueIdSchema,
    benchmark: z
      .object({
        track: pactBenchmarkTrackV1Schema,
        mode: pactBenchmarkModeV1Schema,
        version: textSchema.max(64),
      })
      .strict(),
    budget: pactBudgetV1Schema,
    tools: toolListV1Schema,
  })
  .strict();

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

const taskCommonV1Shape = {
  taskId: opaqueIdSchema,
  prompt: z.string().min(1).max(32_768),
  requester: pactIdentityV1Schema,
  target: pactIdentityV1Schema,
  surface: z.enum(['notes', 'todos', 'calendar', 'email', 'messaging', 'unknown']),
};

export const pactTaskIntroV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      ...taskCommonV1Shape,
      kind: z.literal('qa'),
    })
    .strict(),
  z
    .object({
      ...taskCommonV1Shape,
      kind: z.literal('action'),
      operation: textSchema.max(64),
    })
    .strict(),
]);

const notesReadAccessV1Schema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('none') }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
  z
    .object({
      scope: z.literal('folders'),
      folderIds: z
        .array(opaqueIdSchema)
        .min(1)
        .max(64)
        .refine(ids => new Set(ids).size === ids.length, {
          message: 'folder ids must be unique',
        }),
    })
    .strict(),
]);

export const pactBoundaryPlanV1Schema = z
  .object({
    access: z
      .object({
        notes: z
          .object({
            read: notesReadAccessV1Schema,
            write: z.boolean(),
          })
          .strict(),
        todos: z
          .object({
            read: z.boolean(),
            write: z.boolean(),
          })
          .strict(),
        memory: z
          .object({
            read: z.enum(['none', 'relationship', 'all']),
            write: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.access.notes.write && plan.access.notes.read.scope === 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['access', 'notes', 'write'],
        message: 'notes write access requires notes read access in protocol v1',
      });
    }
    if (plan.access.todos.write && !plan.access.todos.read) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['access', 'todos', 'write'],
        message: 'todos write access requires todos read access in protocol v1',
      });
    }
    if (plan.access.memory.write && plan.access.memory.read === 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['access', 'memory', 'write'],
        message: 'memory write access requires memory read access in protocol v1',
      });
    }
  });

export const pactObservationV1Schema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('task'),
      turn: z.literal(0),
      task: pactTaskIntroV1Schema,
      grantedAccess: pactBoundaryPlanV1Schema,
      budgetRemaining: pactBudgetRemainingV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      turn: z.number().int().min(1).max(64),
      toolCallId: opaqueIdSchema,
      toolName: pactToolNameV1Schema,
      output: jsonValueSchema,
      isError: z.boolean(),
      budgetRemaining: pactBudgetRemainingV1Schema,
    })
    .strict(),
  // A renewed ask from the same requester after a terminal refusal or
  // escalation. Emitted only when the run opts into the multi-attempt
  // requester protocol (benchmark.attempts); single-attempt runs never
  // produce this variant. The message carries requester words only —
  // never authority, grants, or policy state — and the attempt counter
  // is 2-based (attempt 1 is the original task observation).
  z
    .object({
      type: z.literal('requester_followup'),
      turn: z.number().int().min(1).max(64),
      attempt: z.number().int().min(2).max(8),
      message: z.string().min(1).max(32_768),
      budgetRemaining: pactBudgetRemainingV1Schema,
    })
    .strict(),
]);

export const pactAnswerDecisionV1Schema = z
  .object({
    type: z.literal('answer'),
    content: z.string().min(1).max(65_536),
  })
  .strict();

export const pactRefuseDecisionV1Schema = z
  .object({
    type: z.literal('refuse'),
    reason: z.string().min(1).max(4_096),
  })
  .strict();

export const pactToolCallDecisionV1Schema = z
  .object({
    type: z.literal('tool_call'),
    toolName: pactToolNameV1Schema,
    input: jsonObjectSchema,
  })
  .strict();

export const pactEscalateDecisionV1Schema = z
  .object({
    type: z.literal('escalate'),
    reason: z.string().min(1).max(4_096),
  })
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

export const pactFinalizeReportV1Schema = z
  .object({
    status: z.enum(['completed', 'failed']),
    summary: z.string().min(1).max(4_096).optional(),
  })
  .strict();
