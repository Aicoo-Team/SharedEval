import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../contracts/json.js';
import type {
  SoAddress,
  SoCapabilityRequirement,
  SoProtocolError,
  SoToolCall,
  SoToolHandler,
  SoToolResult,
} from '../../execution/sharedos/v1/contracts.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import {
  executePactPairToolV1,
  PACT_PAIR_TOOL_SPECS_V1,
  type PactPairToolNameV1,
} from './tools.js';
import type { PactPairWorkspaceV1 } from './workspace.js';

const PACT_PAIR_NAMESPACE = 'pact-pair';
const PACT_PAIR_SOURCE = 'sharedeval';

type PactPairSurface = 'notes' | 'todos';

type ToolBinding = {
  surface: PactPairSurface;
  action: 'read' | 'create' | 'update';
};

const TOOL_BINDINGS: Record<PactPairToolNameV1, ToolBinding> = {
  search_notes: { surface: 'notes', action: 'read' },
  get_note: { surface: 'notes', action: 'read' },
  create_note: { surface: 'notes', action: 'create' },
  edit_note: { surface: 'notes', action: 'update' },
  search_todos: { surface: 'todos', action: 'read' },
  get_todo: { surface: 'todos', action: 'read' },
  create_todo: { surface: 'todos', action: 'create' },
  edit_todo: { surface: 'todos', action: 'update' },
  complete_todo: { surface: 'todos', action: 'update' },
};

export function resolvePactPairSharedOsToolBindingV1(
  name: string,
): Readonly<{ surface: 'notes' | 'todos'; action: 'read' | 'create' | 'update' }> | null {
  if (!isPactPairToolName(name)) return null;
  return Object.freeze({ ...TOOL_BINDINGS[name] });
}

const searchArgumentsSchema = z.object({
  query: z.string().trim().min(1).max(512),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const titleArgumentsSchema = z.object({
  title: z.string().trim().min(1).max(512),
}).strict();
const createNoteArgumentsSchema = z.object({
  folder: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(512),
  content: z.string().trim().min(1).max(65_536),
}).strict();
const editNoteArgumentsSchema = z.object({
  title: z.string().trim().min(1).max(512),
  content: z.string().trim().min(1).max(65_536),
}).strict();
const createTodoArgumentsSchema = z.object({
  folder: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(512),
  description: z.string().trim().min(1).max(65_536),
  priority: z.number().int().min(0).max(2).optional(),
  dueDate: z.string().trim().min(1).max(128).optional(),
}).strict();
const editTodoArgumentsSchema = z.object({
  title: z.string().trim().min(1).max(512),
  description: z.string().trim().min(1).max(65_536).optional(),
  priority: z.number().int().min(0).max(2).optional(),
  dueDate: z.string().trim().min(1).max(128).optional(),
}).strict().refine(
  input => input.description !== undefined
    || input.priority !== undefined
    || input.dueDate !== undefined,
  { message: 'at least one editable field is required' },
);

const ARGUMENT_SCHEMAS: Record<PactPairToolNameV1, z.ZodTypeAny> = {
  search_notes: searchArgumentsSchema,
  get_note: titleArgumentsSchema,
  create_note: createNoteArgumentsSchema,
  edit_note: editNoteArgumentsSchema,
  search_todos: searchArgumentsSchema,
  get_todo: titleArgumentsSchema,
  create_todo: createTodoArgumentsSchema,
  edit_todo: editTodoArgumentsSchema,
  complete_todo: titleArgumentsSchema,
};

const rawFailureSchema = z.object({
  error: z.object({
    code: z.enum([
      'invalid_arguments',
      'not_found',
      'conflict',
      'invalid_operation',
      'unknown_tool',
      'tool_error',
    ]),
    message: z.string().min(1).max(4_096),
  }).strict(),
}).strict();

export function createPactPairSharedOsToolHandlersV1(options: {
  task: LoadedPactPairTaskV1;
  owner: SoAddress;
  workspace: PactPairWorkspaceV1;
}): readonly SoToolHandler[] {
  const surfaces = taskSurfaces(options.task);
  const owner = structuredClone(options.owner);

  return PACT_PAIR_TOOL_SPECS_V1.flatMap(spec => {
    const name = spec.name;
    if (!isPactPairToolName(name)) {
      throw new Error(`Unsupported PACT-Pair tool specification: ${name}`);
    }
    const binding = TOOL_BINDINGS[name];
    if (!surfaces.has(binding.surface)) return [];
    if (options.task.kind === 'qa' && binding.action !== 'read') return [];

    const requirement = taskRequirement(
      options.task.taskId,
      binding,
      owner,
    );
    const parseArguments = (arguments_: JsonObject): JsonObject => (
      ARGUMENT_SCHEMAS[name].parse(arguments_) as JsonObject
    );

    return [{
      definition: {
        name: spec.name,
        description: spec.description ?? `PACT-Pair tool ${spec.name}`,
        namespace: PACT_PAIR_NAMESPACE,
        source: PACT_PAIR_SOURCE,
        readWrite: spec.sideEffects,
        inputSchema: structuredClone(spec.inputSchema),
        requiredCapability: structuredClone(requirement),
      },
      parseArguments,
      resolveRequirement: (_context, call) => {
        parseArguments(call.arguments);
        return structuredClone(requirement);
      },
      invoke: async (context, call, signal) => {
        throwIfAborted(signal);
        if (call.tool !== name) {
          return failedToolResult(
            call,
            context.now,
            'invalid_tool_call',
            'The tool call does not match the selected PACT-Pair handler',
          );
        }

        let parsedArguments: JsonObject;
        try {
          parsedArguments = parseArguments(call.arguments);
        } catch {
          return failedToolResult(
            call,
            context.now,
            'invalid_arguments',
            'Tool arguments did not match the declared schema',
          );
        }
        throwIfAborted(signal);
        const executed = await executePactPairToolV1({
          workspace: options.workspace,
          toolName: name,
          input: parsedArguments,
        });
        if (!executed.isError) {
          return {
            callId: call.id,
            tool: call.tool,
            status: 'succeeded',
            output: executed.output,
            completedAt: context.now,
          };
        }
        const error = protocolError(executed.output);
        return failedToolResult(call, context.now, error.code, error.message);
      },
    } satisfies SoToolHandler];
  });
}

function taskSurfaces(task: LoadedPactPairTaskV1): ReadonlySet<PactPairSurface> {
  if (task.publicTask.taskId !== task.taskId || task.publicTask.kind !== task.kind) {
    throw new Error('PACT-Pair task binding does not match its public task');
  }
  const surface = task.publicTask.surface;
  if (task.kind === 'action') {
    if (
      (surface !== 'notes' && surface !== 'todos')
      || task.action.surface !== surface
    ) {
      throw new Error('PACT-Pair action task has an invalid surface binding');
    }
    return new Set([surface]);
  }
  if (surface === 'unknown') return new Set(['notes', 'todos']);
  if (surface === 'notes' || surface === 'todos') return new Set([surface]);
  throw new Error('PACT-Pair QA task has an unsupported tool surface');
}

function taskRequirement(
  taskId: string,
  binding: ToolBinding,
  owner: SoAddress,
): SoCapabilityRequirement {
  return {
    resource: {
      namespace: PACT_PAIR_NAMESPACE,
      path: ['task', taskId, binding.surface],
      owner: structuredClone(owner),
    },
    action: binding.action,
  };
}

function protocolError(output: JsonValue): SoProtocolError {
  const parsed = rawFailureSchema.safeParse(output);
  if (parsed.success) return parsed.data.error;
  return {
    code: 'tool_error',
    message: 'PACT-Pair tool execution failed',
  };
}

function failedToolResult(
  call: SoToolCall,
  completedAt: string,
  code: string,
  message: string,
): SoToolResult {
  return {
    callId: call.id,
    tool: call.tool,
    status: 'failed',
    error: { code, message },
    completedAt,
  };
}

function isPactPairToolName(name: string): name is PactPairToolNameV1 {
  return Object.prototype.hasOwnProperty.call(TOOL_BINDINGS, name);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('PACT-Pair tool call cancelled');
  }
}
