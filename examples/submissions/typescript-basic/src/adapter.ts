import type {
  JsonValue,
  PactAdapterV1,
  PactBoundaryPlanV1,
  PactDecisionV1,
  PactFinalizeReportV1,
  PactObservationV1,
  PactRunInitV1,
  PactTaskIntroV1,
} from '../../../../src/protocol/v1/index.js';

const SENSITIVE_REQUEST = /\b(password|secret|credential|private key|api key)\b/i;

export class TypeScriptBasicAdapter implements PactAdapterV1 {
  private availableTools = new Set<string>();

  async initialize(init: PactRunInitV1): Promise<void> {
    this.availableTools = new Set(init.tools.map(tool => tool.name));
  }

  async planBoundary(task: PactTaskIntroV1): Promise<PactBoundaryPlanV1> {
    const canReadNotes = task.kind === 'qa' && task.surface === 'notes';
    const canReadTodos = task.kind === 'qa' && task.surface === 'todos';

    return {
      access: {
        notes: {
          read: canReadNotes ? { scope: 'all' } : { scope: 'none' },
          write: false,
        },
        todos: { read: canReadTodos, write: false },
        memory: { read: 'none', write: false },
      },
    };
  }

  async step(observation: PactObservationV1): Promise<PactDecisionV1> {
    if (observation.type === 'tool_result') {
      if (observation.isError) {
        return { type: 'refuse', reason: 'The permitted lookup failed.' };
      }
      return {
        type: 'answer',
        content: formatToolOutput(observation.output),
      };
    }

    const { task } = observation;
    if (task.kind === 'action') {
      return {
        type: 'escalate',
        reason: 'This minimal starter requires owner review for mutations.',
      };
    }
    if (SENSITIVE_REQUEST.test(task.prompt)) {
      return {
        type: 'refuse',
        reason: 'This starter does not retrieve credential-like material.',
      };
    }

    const toolName = toolForSurface(task.surface);
    if (!toolName || !this.availableTools.has(toolName)) {
      return {
        type: 'refuse',
        reason: 'No permitted lookup tool is available for this task surface.',
      };
    }

    return {
      type: 'tool_call',
      toolName,
      input: { query: task.prompt },
    };
  }

  async finalize(): Promise<PactFinalizeReportV1> {
    return {
      status: 'completed',
      summary: 'TypeScript basic adapter session completed.',
    };
  }
}

function toolForSurface(surface: PactTaskIntroV1['surface']): string | undefined {
  if (surface === 'notes') return 'search_notes';
  if (surface === 'todos') return 'search_todos';
  return undefined;
}

function formatToolOutput(output: JsonValue): string {
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  return serialized.slice(0, 8_192) || 'The permitted lookup returned no content.';
}
