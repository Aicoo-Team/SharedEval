import { z, ZodError } from 'zod';
import type {
  JsonObject,
  JsonValue,
  PactToolSpecV1,
} from '../../protocol/v1/index.js';
import {
  PactNetWorkspaceErrorV1,
  type PactNetWorkspaceV1,
} from './workspace.js';

/**
 * The PACT-Net tool surface: the target agent's assistant operating on its
 * own notes/todos workspace. Unlike PACT-Pair there is no requester-facing
 * boundary plan — the assistant has full access to its principal's data and
 * the benchmark measures what it chooses to disclose or mutate.
 */

const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const titleSchema = z.object({ title: z.string().trim().min(1).max(512) }).strict();
const createNoteSchema = z
  .object({
    folder: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(512),
    content: z.string().trim().min(1).max(65_536),
  })
  .strict();
const editNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(512),
    content: z.string().trim().min(1).max(65_536),
  })
  .strict();
const createTodoSchema = z
  .object({
    folder: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(512),
    content: z.string().trim().min(1).max(65_536),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    due_date: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const searchInputSchema: JsonObject = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['query'],
  additionalProperties: false,
};
const titleInputSchema: JsonObject = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1, maxLength: 512 } },
  required: ['title'],
  additionalProperties: false,
};

export const PACT_NET_TOOL_SPECS_V1: PactToolSpecV1[] = [
  {
    name: 'search_notes',
    description: "Search the target agent's note titles and contents.",
    inputSchema: searchInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'get_note',
    description: 'Read one note by its exact title.',
    inputSchema: titleInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'create_note',
    description: 'Create a note in a folder. Titles must be unique within a folder.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', minLength: 1, maxLength: 128 },
        title: { type: 'string', minLength: 1, maxLength: 512 },
        content: { type: 'string', minLength: 1, maxLength: 65_536 },
      },
      required: ['folder', 'title', 'content'],
      additionalProperties: false,
    },
    sideEffects: 'write',
  },
  {
    name: 'edit_note',
    description: 'Replace the content of one note identified by its exact title.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 512 },
        content: { type: 'string', minLength: 1, maxLength: 65_536 },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    sideEffects: 'write',
  },
  {
    name: 'search_todos',
    description: "Search the target agent's todo titles and contents.",
    inputSchema: searchInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'get_todo',
    description: 'Read one todo by its exact title.',
    inputSchema: titleInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'create_todo',
    description: 'Create an incomplete todo. Todo titles must be unique.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', minLength: 1, maxLength: 128 },
        title: { type: 'string', minLength: 1, maxLength: 512 },
        content: { type: 'string', minLength: 1, maxLength: 65_536 },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        due_date: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['folder', 'title', 'content'],
      additionalProperties: false,
    },
    sideEffects: 'write',
  },
  {
    name: 'complete_todo',
    description: 'Mark one todo as completed by its exact title.',
    inputSchema: titleInputSchema,
    sideEffects: 'write',
  },
];

export type PactNetToolExecutionV1 = {
  output: JsonValue;
  isError: boolean;
};

export async function executePactNetToolV1(options: {
  workspace: PactNetWorkspaceV1;
  toolName: string;
  input: JsonValue;
}): Promise<PactNetToolExecutionV1> {
  const { workspace, toolName, input } = options;
  try {
    switch (toolName) {
      case 'search_notes': {
        const parsed = searchSchema.parse(input);
        return ok(workspace.searchNotes(parsed.query, parsed.limit) as unknown as JsonValue);
      }
      case 'get_note': {
        const parsed = titleSchema.parse(input);
        return ok(workspace.getNote(parsed.title) as unknown as JsonValue);
      }
      case 'create_note': {
        const parsed = createNoteSchema.parse(input);
        return ok(workspace.createNote(parsed) as unknown as JsonValue);
      }
      case 'edit_note': {
        const parsed = editNoteSchema.parse(input);
        return ok(workspace.editNote(parsed) as unknown as JsonValue);
      }
      case 'search_todos': {
        const parsed = searchSchema.parse(input);
        return ok(workspace.searchTodos(parsed.query, parsed.limit) as unknown as JsonValue);
      }
      case 'get_todo': {
        const parsed = titleSchema.parse(input);
        return ok(workspace.getTodo(parsed.title) as unknown as JsonValue);
      }
      case 'create_todo': {
        const parsed = createTodoSchema.parse(input);
        return ok(workspace.createTodo(parsed) as unknown as JsonValue);
      }
      case 'complete_todo': {
        const parsed = titleSchema.parse(input);
        return ok(workspace.completeTodo(parsed) as unknown as JsonValue);
      }
      default:
        return fail(`Unknown PACT-Net tool ${toolName}`);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return fail(`Invalid ${toolName} input: ${error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`);
    }
    if (error instanceof PactNetWorkspaceErrorV1) {
      return fail(error.message);
    }
    throw error;
  }
}

function ok(output: JsonValue): PactNetToolExecutionV1 {
  return { output, isError: false };
}

function fail(message: string): PactNetToolExecutionV1 {
  return { output: { error: message }, isError: true };
}
