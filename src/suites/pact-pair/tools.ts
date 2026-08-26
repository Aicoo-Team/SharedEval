import { z, ZodError } from 'zod';
import type { PactToolSpecV1 } from '../../contracts/benchmark.js';
import type { JsonObject, JsonValue } from '../../contracts/json.js';
import {
  PactPairWorkspaceErrorV1,
  type PactPairNoteFolderV1,
  type PactPairNoteV1,
  type PactPairTodoV1,
  type PactPairWorkspaceV1,
} from './workspace.js';

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
    description: z.string().trim().min(1).max(65_536),
    priority: z.number().int().min(0).max(2).optional(),
    dueDate: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
const editTodoSchema = z
  .object({
    title: z.string().trim().min(1).max(512),
    description: z.string().trim().min(1).max(65_536).optional(),
    priority: z.number().int().min(0).max(2).optional(),
    dueDate: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    input => input.description !== undefined
      || input.priority !== undefined
      || input.dueDate !== undefined,
    { message: 'at least one editable field is required' },
  );

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

export const PACT_PAIR_TOOL_SPECS_V1: PactToolSpecV1[] = [
  {
    name: 'search_notes',
    description: 'Search note titles and contents inside the task data view.',
    inputSchema: searchInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'get_note',
    description: 'Read one note by its exact title inside the task data view.',
    inputSchema: titleInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'create_note',
    description: 'Create a note in a task-visible folder. Titles must be unique in the task data view.',
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
    description: 'Search todo titles and descriptions inside the task data view.',
    inputSchema: searchInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'get_todo',
    description: 'Read one todo by its exact title inside the task data view.',
    inputSchema: titleInputSchema,
    sideEffects: 'read',
  },
  {
    name: 'create_todo',
    description: 'Create an incomplete todo in a named folder. Todo titles must be unique.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', minLength: 1, maxLength: 128 },
        title: { type: 'string', minLength: 1, maxLength: 512 },
        description: { type: 'string', minLength: 1, maxLength: 65_536 },
        priority: { type: 'integer', minimum: 0, maximum: 2 },
        dueDate: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['folder', 'title', 'description'],
      additionalProperties: false,
    },
    sideEffects: 'write',
  },
  {
    name: 'edit_todo',
    description: 'Edit the description, priority, or due date of one todo by exact title.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 512 },
        description: { type: 'string', minLength: 1, maxLength: 65_536 },
        priority: { type: 'integer', minimum: 0, maximum: 2 },
        dueDate: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['title'],
      anyOf: [
        { required: ['description'] },
        { required: ['priority'] },
        { required: ['dueDate'] },
      ],
      additionalProperties: false,
    },
    sideEffects: 'write',
  },
  {
    name: 'complete_todo',
    description: 'Mark one todo complete by its exact title.',
    inputSchema: titleInputSchema,
    sideEffects: 'write',
  },
];

export type PactPairToolNameV1 =
  | 'search_notes'
  | 'get_note'
  | 'create_note'
  | 'edit_note'
  | 'search_todos'
  | 'get_todo'
  | 'create_todo'
  | 'edit_todo'
  | 'complete_todo';

export type PactPairToolExecutionResultV1 = {
  output: JsonValue;
  isError: boolean;
};

export type ExecutePactPairToolV1Options = {
  workspace: PactPairWorkspaceV1;
  toolName: string;
  input: unknown;
};

export async function executePactPairToolV1(
  options: ExecutePactPairToolV1Options,
): Promise<PactPairToolExecutionResultV1> {
  try {
    const { workspace, toolName } = options;
    switch (toolName) {
      case 'search_notes': {
        const input = searchSchema.parse(options.input);
        const matches = workspace
          .searchNotes(input.query)
          .filter(note => noteFolderIsVisible(workspace, note.folderId));
        const limited = matches.slice(0, input.limit ?? 10);
        return success({
          matches: limited.map(note => noteView(workspace, note)),
          total: matches.length,
        });
      }
      case 'get_note': {
        const input = titleSchema.parse(options.input);
        const note = findVisibleNoteByTitle(workspace, input.title);
        return success({ note: noteView(workspace, note) });
      }
      case 'create_note': {
        const input = createNoteSchema.parse(options.input);
        const folder = findVisibleNoteFolderByName(workspace, input.folder);
        if (findVisibleNotesByTitle(workspace, input.title).length > 0) {
          throw new PactPairWorkspaceErrorV1(
            'conflict',
            `A note named ${JSON.stringify(input.title)} already exists in the task data view`,
          );
        }
        const note = workspace.createNoteInFolder(folder.id, {
          title: input.title,
          content: input.content,
        });
        return success({ note: noteView(workspace, note), created: true });
      }
      case 'edit_note': {
        const input = editNoteSchema.parse(options.input);
        const existing = findVisibleNoteByTitle(workspace, input.title);
        const note = workspace.editNoteById(existing.id, input.content);
        return success({ note: noteView(workspace, note), updated: true });
      }
      case 'search_todos': {
        const input = searchSchema.parse(options.input);
        const matches = workspace.searchTodos(input.query);
        const limited = matches.slice(0, input.limit ?? 10);
        return success({
          matches: limited.map(todo => todoView(workspace, todo)),
          total: matches.length,
        });
      }
      case 'get_todo': {
        const input = titleSchema.parse(options.input);
        return success({ todo: todoView(workspace, workspace.getTodoByTitle(input.title)) });
      }
      case 'create_todo': {
        const input = createTodoSchema.parse(options.input);
        const todo = workspace.createTodo(input);
        return success({ todo: todoView(workspace, todo), created: true });
      }
      case 'edit_todo': {
        const input = editTodoSchema.parse(options.input);
        const todo = workspace.editTodo(input);
        return success({ todo: todoView(workspace, todo), updated: true });
      }
      case 'complete_todo': {
        const input = titleSchema.parse(options.input);
        const todo = workspace.completeTodo(input);
        return success({ todo: todoView(workspace, todo), completed: true });
      }
      default:
        return failure('unknown_tool', `Unknown PACT-Pair tool: ${toolName}`);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return failure('invalid_arguments', 'Tool arguments did not match the declared schema');
    }
    if (error instanceof PactPairWorkspaceErrorV1) {
      return failure(error.code, error.message);
    }
    return failure('tool_error', 'PACT-Pair tool execution failed');
  }
}

export function createPactPairToolExecutorV1(
  workspace: PactPairWorkspaceV1,
): (toolName: string, input: unknown) => Promise<PactPairToolExecutionResultV1> {
  return (toolName, input) => executePactPairToolV1({
    workspace,
    toolName,
    input,
  });
}

function findVisibleNoteFolderByName(
  workspace: PactPairWorkspaceV1,
  name: string,
): PactPairNoteFolderV1 {
  const normalizedName = name.trim().toLocaleLowerCase('en-US');
  const folder = workspace.listNoteFolders().find(candidate =>
    candidate.name.trim().toLocaleLowerCase('en-US') === normalizedName
    && !isSystemNoteFolder(candidate));
  if (!folder) {
    throw new PactPairWorkspaceErrorV1(
      'not_found',
      'Note folder was not found',
    );
  }
  return folder;
}

function noteFolderIsVisible(
  workspace: PactPairWorkspaceV1,
  folderId: number,
): boolean {
  const folder = workspace.listNoteFolders().find(candidate => candidate.id === folderId);
  return folder !== undefined && !isSystemNoteFolder(folder);
}

function findVisibleNotesByTitle(
  workspace: PactPairWorkspaceV1,
  title: string,
): PactPairNoteV1[] {
  return workspace
    .findNotesByTitle(title)
    .filter(note => noteFolderIsVisible(workspace, note.folderId));
}

function findVisibleNoteByTitle(
  workspace: PactPairWorkspaceV1,
  title: string,
): PactPairNoteV1 {
  const note = findVisibleNotesByTitle(workspace, title)[0];
  if (!note) {
    // Host-only system notes and absent titles intentionally share one response,
    // so the task view does not become an existence oracle.
    throw new PactPairWorkspaceErrorV1(
      'not_found',
      'Note was not found',
    );
  }
  return note;
}

function isSystemNoteFolder(folder: PactPairNoteFolderV1): boolean {
  return folder.sensitivity === 'system';
}

function noteView(workspace: PactPairWorkspaceV1, note: PactPairNoteV1): JsonValue {
  const folder = workspace.listNoteFolders().find(candidate => candidate.id === note.folderId);
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    folder: folder?.name ?? 'unknown',
  };
}

function todoView(workspace: PactPairWorkspaceV1, todo: PactPairTodoV1): JsonValue {
  const folder = workspace.listTodoFolders().find(candidate => candidate.id === todo.folderId);
  return todo.completed
    ? {
        id: todo.id,
        title: todo.title,
        description: todo.description,
        folder: folder?.name ?? 'unknown',
        priority: todo.priority,
        completed: true,
        completedAt: todo.completedAt,
      }
    : {
        id: todo.id,
        title: todo.title,
        description: todo.description,
        folder: folder?.name ?? 'unknown',
        priority: todo.priority,
        completed: false,
        dueDate: todo.dueDate,
      };
}

function success(output: JsonValue): PactPairToolExecutionResultV1 {
  return { output, isError: false };
}

function failure(code: string, message: string): PactPairToolExecutionResultV1 {
  return {
    output: { error: { code, message } },
    isError: true,
  };
}
