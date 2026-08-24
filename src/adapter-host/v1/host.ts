import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import {
  MAX_PACT_WIRE_LINE_BYTES_V1,
  PACT_ADAPTER_PROTOCOL_VERSION_V1,
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactFinalizeReportV1Schema,
  parsePactRunnerRequestLineV1,
  serializePactWireMessageV1,
  type PactHarnessV1,
  type PactBoundaryPlanV1,
  type PactRunnerRequestV1,
  type PactTaskIntroV1,
} from '../../protocol/v1/index.js';

export type PactHarnessHostStateV1 =
  | 'new'
  | 'initialized'
  | 'planned'
  | 'active'
  | 'decided'
  | 'finalizing'
  | 'failed'
  | 'finalized';

export type ServePactHarnessV1Options = {
  input?: Readable;
  output?: Writable;
};

export class PactHarnessHostV1 {
  private currentState: PactHarnessHostStateV1 = 'new';
  private readonly seenRequestIds = new Set<string>();
  private readonly seenToolCallIds = new Set<string>();
  private availableTools = new Set<string>();
  private plannedTask: PactTaskIntroV1 | undefined;
  private requestedPlan: PactBoundaryPlanV1 | undefined;
  private pendingTool: { name: string; expectedTurn: number } | undefined;
  private finalizeAttempted = false;

  constructor(private readonly harness: PactHarnessV1) {}

  get state(): PactHarnessHostStateV1 {
    return this.currentState;
  }

  async handleLine(line: string): Promise<string> {
    let request: PactRunnerRequestV1;
    try {
      request = parsePactRunnerRequestLineV1(line);
    } catch {
      const failure = classifyInvalidRequest(line);
      return serializeError(failure.id, failure.code, failure.message);
    }

    if (this.seenRequestIds.has(request.id)) {
      return serializeError(request.id, -32_001, 'JSON-RPC request ids must be unique');
    }
    this.seenRequestIds.add(request.id);

    try {
      return await this.handleRequest(request);
    } catch (error) {
      if (error instanceof PactLifecycleError) {
        return serializeError(request.id, -32_001, error.message);
      }
      this.currentState = 'failed';
      this.pendingTool = undefined;
      return serializeError(request.id, -32_000, 'Adapter execution failed');
    }
  }

  private async handleRequest(request: PactRunnerRequestV1): Promise<string> {
    switch (request.method) {
      case 'pact.initialize': {
        this.requireState(request.method, ['new']);
        const availableTools = new Set(request.params.tools.map(tool => tool.name));
        await this.harness.initialize(structuredClone(request.params));
        this.availableTools = availableTools;
        this.currentState = 'initialized';
        return serializeResult(request.id, {
          ready: true,
          protocolVersion: PACT_ADAPTER_PROTOCOL_VERSION_V1,
        });
      }
      case 'pact.planBoundary': {
        this.requireState(request.method, ['initialized']);
        const plannedTask = structuredClone(request.params.task);
        const plan = pactBoundaryPlanV1Schema.parse(
          await this.harness.planBoundary(structuredClone(plannedTask)),
        );
        this.plannedTask = plannedTask;
        this.requestedPlan = plan;
        this.currentState = 'planned';
        return serializeResult(request.id, { plan });
      }
      case 'pact.step': {
        this.requireState(request.method, ['planned', 'active']);
        if (this.currentState === 'planned' && request.params.observation.type !== 'task') {
          throw new PactLifecycleError('the first pact.step observation must be a task');
        }
        if (this.currentState === 'active' && request.params.observation.type !== 'tool_result') {
          throw new PactLifecycleError('a tool call must be followed by a tool_result observation');
        }
        if (
          request.params.observation.type === 'requester_message'
          && this.pendingTool !== undefined
        ) {
          // A follow-up may only arrive after the target has finished an
          // exchange with a terminal decision, never while a tool call is
          // outstanding — otherwise the requester could interrupt mid-retrieval
          // and the leak could not be attributed to an exchange.
          throw new PactLifecycleError(
            'a requester_message must not arrive while a tool call is pending',
          );
        }

        const { observation } = request.params;
        if (observation.type === 'task') {
          if (!this.plannedTask || !isDeepStrictEqual(observation.task, this.plannedTask)) {
            throw new PactLifecycleError(
              'the first task observation must match the task used for boundary planning',
            );
          }
          if (!this.requestedPlan || !isAccessWithinPlan(observation.grantedAccess, this.requestedPlan)) {
            throw new PactLifecycleError(
              'granted access must not exceed the adapter boundary plan',
            );
          }
        } else if (observation.type === 'tool_result') {
          if (!this.pendingTool) {
            throw new PactLifecycleError('no tool call is awaiting a result');
          }
          if (observation.toolName !== this.pendingTool.name) {
            throw new PactLifecycleError('tool_result does not match the pending tool call');
          }
          if (observation.turn !== this.pendingTool.expectedTurn) {
            throw new PactLifecycleError(
              `tool_result turn must be ${this.pendingTool.expectedTurn}`,
            );
          }
          if (this.seenToolCallIds.has(observation.toolCallId)) {
            throw new PactLifecycleError('toolCallId must be unique within a session');
          }
        }

        const decision = pactDecisionV1Schema.parse(
          await this.harness.step(structuredClone(observation)),
        );
        if (observation.type === 'tool_result') {
          this.seenToolCallIds.add(observation.toolCallId);
        }
        if (decision.type === 'tool_call') {
          if (!this.availableTools.has(decision.toolName)) {
            throw new Error('adapter requested a tool that was not advertised by the runner');
          }
          this.pendingTool = {
            name: decision.toolName,
            expectedTurn: observation.turn + 1,
          };
          this.currentState = 'active';
        } else {
          this.pendingTool = undefined;
          this.currentState = 'decided';
        }
        return serializeResult(request.id, { decision });
      }
      case 'pact.finalize': {
        if (this.finalizeAttempted) {
          throw new PactLifecycleError('pact.finalize may only be called once');
        }
        if (request.params.reason === 'completed') {
          this.requireState(`${request.method}(completed)`, ['decided']);
        } else {
          this.requireState(`${request.method}(aborted)`, [
            'initialized',
            'planned',
            'active',
            'decided',
            'failed',
          ]);
        }
        this.finalizeAttempted = true;
        this.currentState = 'finalizing';
        const report = pactFinalizeReportV1Schema.parse(await this.harness.finalize());
        this.currentState = 'finalized';
        return serializeResult(request.id, { report });
      }
    }
  }

  private requireState(method: string, allowed: PactHarnessHostStateV1[]): void {
    if (!allowed.includes(this.currentState)) {
      throw new PactLifecycleError(
        `${method} is invalid while the adapter is ${this.currentState}`,
      );
    }
  }
}

export async function servePactHarnessV1(
  harness: PactHarnessV1,
  options: ServePactHarnessV1Options = {},
): Promise<void> {
  const host = new PactHarnessHostV1(harness);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  for await (const frame of readBoundedPactWireLinesV1(input)) {
    const response = frame.kind === 'line'
      ? await host.handleLine(frame.value)
      : serializeError(null, -32_600, 'Invalid JSON-RPC request');
    if (!output.write(response)) {
      await once(output, 'drain');
    }
  }
}

/** @deprecated Use PactHarnessHostStateV1. */
export type PactAdapterHostStateV1 = PactHarnessHostStateV1;
/** @deprecated Use ServePactHarnessV1Options. */
export type ServePactAdapterV1Options = ServePactHarnessV1Options;
/** @deprecated Use PactHarnessHostV1. */
export { PactHarnessHostV1 as PactAdapterHostV1 };
/** @deprecated Use servePactHarnessV1. */
export const servePactAdapterV1 = servePactHarnessV1;

type PactWireInputFrameV1 =
  | { kind: 'line'; value: string }
  | { kind: 'oversized' };

async function* readBoundedPactWireLinesV1(
  input: Readable,
): AsyncGenerator<PactWireInputFrameV1> {
  const parts: Buffer[] = [];
  let bufferedBytes = 0;
  let discarding = false;

  for await (const rawChunk of input) {
    const chunk = toBuffer(rawChunk);
    let offset = 0;

    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.subarray(offset, segmentEnd);

      if (!discarding && segment.length > 0) {
        if (bufferedBytes + segment.length > MAX_PACT_WIRE_LINE_BYTES_V1 + 1) {
          parts.length = 0;
          bufferedBytes = 0;
          discarding = true;
        } else {
          parts.push(segment);
          bufferedBytes += segment.length;
        }
      }

      if (newlineIndex === -1) break;

      yield discarding
        ? { kind: 'oversized' }
        : decodeBufferedLine(parts, bufferedBytes);
      parts.length = 0;
      bufferedBytes = 0;
      discarding = false;
      offset = newlineIndex + 1;
    }
  }

  if (discarding) {
    yield { kind: 'oversized' };
  } else if (bufferedBytes > 0) {
    yield decodeBufferedLine(parts, bufferedBytes);
  }
}

function decodeBufferedLine(parts: Buffer[], byteLength: number): PactWireInputFrameV1 {
  const lastPart = parts.at(-1);
  const hasTrailingCarriageReturn = Boolean(
    lastPart && lastPart[lastPart.length - 1] === 0x0d,
  );
  const decodedByteLength = byteLength - (hasTrailingCarriageReturn ? 1 : 0);
  if (decodedByteLength > MAX_PACT_WIRE_LINE_BYTES_V1) {
    return { kind: 'oversized' };
  }

  const line = Buffer.concat(parts, byteLength).subarray(0, decodedByteLength);
  return { kind: 'line', value: line.toString('utf8') };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError('PACT adapter stdin must be a byte or string stream');
}

class PactLifecycleError extends Error {}

type RequestFailure = {
  id: string | null;
  code: -32_700 | -32_600 | -32_601 | -32_602;
  message: string;
};

const METHODS = new Set([
  'pact.initialize',
  'pact.planBoundary',
  'pact.step',
  'pact.finalize',
]);

function classifyInvalidRequest(line: string): RequestFailure {
  if (Buffer.byteLength(line, 'utf8') > MAX_PACT_WIRE_LINE_BYTES_V1) {
    return { id: null, code: -32_600, message: 'Invalid JSON-RPC request' };
  }

  let value: unknown;
  try {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) throw new Error();
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return { id: null, code: -32_700, message: 'JSON parse error' };
  }

  if (!isRecord(value)) {
    return { id: null, code: -32_600, message: 'Invalid JSON-RPC request' };
  }
  const id = isRequestId(value.id) ? value.id : null;
  if (value.jsonrpc !== '2.0' || !id || typeof value.method !== 'string') {
    return { id, code: -32_600, message: 'Invalid JSON-RPC request' };
  }
  if (!METHODS.has(value.method)) {
    return { id, code: -32_601, message: 'JSON-RPC method not found' };
  }
  const envelopeKeys = Object.keys(value);
  if (
    envelopeKeys.some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'params')
  ) {
    return { id, code: -32_600, message: 'Invalid JSON-RPC request' };
  }
  return { id, code: -32_602, message: 'Invalid JSON-RPC method parameters' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isAccessWithinPlan(
  granted: PactBoundaryPlanV1,
  requested: PactBoundaryPlanV1,
): boolean {
  if (granted.access.notes.write && !requested.access.notes.write) return false;
  if (!isNotesReadWithin(granted, requested)) return false;
  if (granted.access.todos.read && !requested.access.todos.read) return false;
  if (granted.access.todos.write && !requested.access.todos.write) return false;
  if (granted.access.memory.write && !requested.access.memory.write) return false;

  const memoryRank = { none: 0, relationship: 1, all: 2 } as const;
  return memoryRank[granted.access.memory.read] <= memoryRank[requested.access.memory.read];
}

function isNotesReadWithin(
  granted: PactBoundaryPlanV1,
  requested: PactBoundaryPlanV1,
): boolean {
  const grantedRead = granted.access.notes.read;
  const requestedRead = requested.access.notes.read;
  if (grantedRead.scope === 'none') return true;
  if (requestedRead.scope === 'none') return false;
  if (requestedRead.scope === 'all') return true;
  if (grantedRead.scope === 'all') return false;
  const requestedFolders = new Set(requestedRead.folderIds);
  return grantedRead.folderIds.every(folderId => requestedFolders.has(folderId));
}

function serializeResult(id: string, result: unknown): string {
  return serializePactWireMessageV1({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function serializeError(id: string | null, code: number, message: string): string {
  return serializePactWireMessageV1({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message: message.slice(0, 4_096) || 'Unknown adapter error',
    },
  });
}
