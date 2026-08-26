import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  SoAddress,
  SoResourceOperation,
  SoResourceProvider,
  SoResourceResult,
} from '../../execution/sharedos/v1/contracts.js';
import type { JsonObject } from '../../contracts/json.js';
import type { AgentWorkspaceFilePathV1 } from './agent-workspace.js';
import type {
  FileReadReceiptV1,
  FileWorkspacePortV1,
  ReplaceMemoryResultV1,
} from './file-workspace.js';

const FILES_NAMESPACE = 'files';
const MEMORY_PATH = 'MEMORY.md' as const;
const logicalFiles = new Set<string>([
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  MEMORY_PATH,
]);

export type SharedOsFileReadOperationReceiptV1 = Readonly<{
  runId: string;
  actorId: string;
  traceId: string;
  operationId: string;
  path: AgentWorkspaceFilePathV1;
  action: 'read';
  outcome: 'succeeded';
  version: number;
  sha256: string;
  byteLength: number;
}>;

export type SharedOsFileReplaceOperationReceiptV1 = Readonly<{
  runId: string;
  actorId: string;
  traceId: string;
  operationId: string;
  path: 'MEMORY.md';
  action: 'replace';
  outcome: 'committed' | 'conflict';
  expectedVersion: number;
  previousVersion: number;
  previousSha256: string;
  previousByteLength: number;
  previousBytesBase64: string;
  newBytesBase64: string;
  version: number;
  sha256: string;
  byteLength: number;
  durability?: 'published_unsynced';
}>;

export type SharedOsFileOperationReceiptV1 =
  | SharedOsFileReadOperationReceiptV1
  | SharedOsFileReplaceOperationReceiptV1;

export interface SharedOsFileProviderV1 extends SoResourceProvider {
  /**
   * Returns evidence collected by this live provider for one actor turn.
   * It is an ephemeral host projection, not recovery authority. The heartbeat
   * ledger must durably commit any evidence it accepts before this provider is
   * closed.
   */
  readReceipts(input: Readonly<{
    actorId: string;
    traceId: string;
  }>): Promise<readonly SharedOsFileOperationReceiptV1[]>;
  close(): Promise<void>;
}

export type CreateSharedOsFileProviderV1Options = Readonly<{
  runId: string;
  /** Duration from the trusted, frozen turn timestamp in AccessContext.now. */
  deadlineMs: number;
  requester: Readonly<{
    actorId: string;
    workspace: FileWorkspacePortV1;
  }>;
  responder: Readonly<{
    actorId: string;
    workspace: FileWorkspacePortV1;
  }>;
}>;

type ActorBinding = Readonly<{
  actorId: string;
  workspace: FileWorkspacePortV1;
}>;

type MemoryObservation = Readonly<{
  content: string;
  receipt: FileReadReceiptV1;
}>;

type TurnState = {
  receipts: SharedOsFileOperationReceiptV1[];
  memoryObservation?: MemoryObservation;
  publicationCommitted: boolean;
  tail: Promise<void>;
};

type ValidOperation = Readonly<{
  actor: ActorBinding;
  actorId: string;
  traceId: string;
  path: AgentWorkspaceFilePathV1;
  deadlineAtMs: number;
}>;

export function encodeFileVersionV1(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('File version must be a non-negative safe integer');
  }
  return String(version);
}

export function decodeFileVersionV1(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Expected a canonical file version decimal string');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0 || String(version) !== value) {
    throw new Error('Expected a canonical file version decimal string');
  }
  return version;
}

export function createSharedOsFileProviderV1(
  options: CreateSharedOsFileProviderV1Options,
): SharedOsFileProviderV1 {
  assertOpaqueId(options.runId, 'run ID');
  assertOpaqueId(options.requester.actorId, 'requester actor ID');
  assertOpaqueId(options.responder.actorId, 'responder actor ID');
  if (options.requester.actorId === options.responder.actorId) {
    throw new Error('Requester and responder must use distinct actor IDs');
  }
  if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new Error('File provider deadline must be a positive safe integer');
  }
  return new ActorOwnedFileProvider(Object.freeze({
    runId: options.runId,
    deadlineMs: options.deadlineMs,
    requester: Object.freeze({
      actorId: options.requester.actorId,
      workspace: options.requester.workspace,
    }),
    responder: Object.freeze({
      actorId: options.responder.actorId,
      workspace: options.responder.workspace,
    }),
  }));
}

class ActorOwnedFileProvider implements SharedOsFileProviderV1 {
  readonly namespace = FILES_NAMESPACE;
  private readonly actors: ReadonlyMap<string, ActorBinding>;
  private readonly turns = new Map<string, TurnState>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: CreateSharedOsFileProviderV1Options) {
    this.actors = new Map([
      [options.requester.actorId, options.requester],
      [options.responder.actorId, options.responder],
    ]);
  }

  async invoke(
    operation: SoResourceOperation,
    signal: AbortSignal,
  ): Promise<SoResourceResult> {
    if (this.closed) {
      return failedResult(
        operation,
        'file_provider_closed',
        'The actor file provider is closed.',
      );
    }
    throwIfAborted(signal);

    const validated = this.validateOperation(operation);
    if ('result' in validated) return validated.result;
    const state = this.turnState(validated.actorId, validated.traceId);
    return enqueueTurn(state, async () => {
      if (this.closed) {
        return failedResult(
          operation,
          'file_provider_closed',
          'The actor file provider is closed.',
        );
      }
      throwIfAborted(signal);
      if (Date.now() >= validated.deadlineAtMs) {
        return failedResult(
          operation,
          'file_deadline_exceeded',
          'The actor file operation deadline has elapsed.',
        );
      }
      return operation.action === 'read'
        ? this.read(operation, validated, state, signal)
        : this.replace(operation, validated, state, signal);
    });
  }

  async readReceipts(input: Readonly<{
    actorId: string;
    traceId: string;
  }>): Promise<readonly SharedOsFileOperationReceiptV1[]> {
    if (this.closed) throw new Error('File provider is closed');
    if (!this.actors.has(input.actorId)) throw new Error('Unknown file provider actor');
    assertOpaqueId(input.traceId, 'trace ID');
    const state = this.turns.get(turnKey(input.actorId, input.traceId));
    if (!state) return Object.freeze([]);
    await state.tail;
    if (this.closed) throw new Error('File provider is closed');
    return Object.freeze(state.receipts.map(receipt => (
      Object.freeze(structuredClone(receipt))
    )));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const pending = [...this.turns.values()].map(state => state.tail);
    this.closePromise = Promise.all(pending).then(() => {
      this.turns.clear();
    });
    return this.closePromise;
  }

  private validateOperation(
    operation: SoResourceOperation,
  ): ValidOperation | { result: SoResourceResult } {
    const denied = () => ({
      result: deniedResult(
        operation,
        'file_operation_invalid',
        'The actor file operation is outside its bound resource shape.',
      ),
    });
    const { actor, traceId, now } = operation.context;
    if (
      actor.kind !== 'agent'
      || !isOpaqueId(traceId)
      || operation.resource.namespace !== FILES_NAMESPACE
      || !sameAddress(operation.resource.owner, operation.context.owner)
      || !Array.isArray(operation.resource.path)
      || operation.resource.path.length !== 1
    ) {
      return denied();
    }
    const [filename] = operation.resource.path;
    const binding = this.actors.get(actor.agentId);
    if (
      !binding
      || typeof filename !== 'string'
      || !logicalFiles.has(filename)
      || (operation.action !== 'read' && operation.action !== 'replace')
      || (operation.action === 'replace' && filename !== MEMORY_PATH)
      || (operation.action === 'read' && operation.input !== undefined)
    ) {
      return denied();
    }

    const startedAtMs = Date.parse(now);
    const deadlineAtMs = startedAtMs + this.options.deadlineMs;
    if (
      !Number.isFinite(startedAtMs)
      || !Number.isSafeInteger(deadlineAtMs)
      || deadlineAtMs < 0
    ) {
      return {
        result: failedResult(
          operation,
          'file_deadline_invalid',
          'The trusted actor turn deadline is invalid.',
        ),
      };
    }
    return {
      actor: binding,
      actorId: actor.agentId,
      traceId,
      path: filename as AgentWorkspaceFilePathV1,
      deadlineAtMs,
    };
  }

  private async read(
    operation: SoResourceOperation,
    validated: ValidOperation,
    state: TurnState,
    signal: AbortSignal,
  ): Promise<SoResourceResult> {
    try {
      const result = await validated.actor.workspace.read({
        actorId: validated.actorId,
        path: validated.path,
        signal,
        deadlineAtMs: validated.deadlineAtMs,
      });
      throwIfAborted(signal);
      if (!validReadResult(result, validated.actorId, validated.path)) {
        return failedResult(
          operation,
          'file_workspace_invalid_result',
          'The actor file workspace returned an invalid read result.',
        );
      }
      const receipt: SharedOsFileReadOperationReceiptV1 = Object.freeze({
        runId: this.options.runId,
        actorId: validated.actorId,
        traceId: validated.traceId,
        operationId: operation.operationId,
        path: validated.path,
        action: 'read',
        outcome: 'succeeded',
        version: result.receipt.version,
        sha256: result.receipt.sha256,
        byteLength: result.receipt.byteLength,
      });
      state.receipts.push(receipt);
      if (validated.path === MEMORY_PATH) {
        state.memoryObservation = Object.freeze({
          content: result.content,
          receipt: Object.freeze(structuredClone(result.receipt)),
        });
      }
      return {
        status: 'succeeded',
        operationId: operation.operationId,
        output: {
          content: result.content,
          version: encodeFileVersionV1(result.receipt.version),
          sha256: result.receipt.sha256,
          byteLength: result.receipt.byteLength,
        },
        completedAt: operation.context.now,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return failedResult(
        operation,
        'file_workspace_failed',
        'The actor file workspace operation failed.',
      );
    }
  }

  private async replace(
    operation: SoResourceOperation,
    validated: ValidOperation,
    state: TurnState,
    signal: AbortSignal,
  ): Promise<SoResourceResult> {
    const parsed = parseReplaceInput(operation.input);
    if (!parsed) {
      return deniedResult(
        operation,
        'file_replace_input_invalid',
        'MEMORY replacement requires exact content and canonical expectedVersion fields.',
      );
    }
    let expectedVersion: number;
    try {
      expectedVersion = decodeFileVersionV1(parsed.expectedVersion);
    } catch {
      return deniedResult(
        operation,
        'file_replace_input_invalid',
        'MEMORY replacement requires exact content and canonical expectedVersion fields.',
      );
    }
    if (state.publicationCommitted) {
      return deniedResult(
        operation,
        'file_publication_limit',
        'This actor turn has already published MEMORY.',
      );
    }
    const previous = state.memoryObservation;
    if (!previous || previous.receipt.version !== expectedVersion) {
      return deniedResult(
        operation,
        'file_read_required',
        'MEMORY must be read at expectedVersion in this actor turn before replacement.',
      );
    }

    let result: unknown;
    try {
      result = await validated.actor.workspace.replaceMemory({
        actorId: validated.actorId,
        expectedVersion,
        content: parsed.content,
        signal,
        deadlineAtMs: validated.deadlineAtMs,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return failedResult(
        operation,
        'file_workspace_failed',
        'The actor file workspace operation failed.',
      );
    }
    const inspected = inspectReplaceResult(result, expectedVersion, parsed.content);
    if (inspected.status === 'invalid') {
      if (inspected.possiblyCommitted) {
        state.publicationCommitted = true;
        delete state.memoryObservation;
      }
      return failedResult(
        operation,
        'file_workspace_invalid_result',
        'The actor file workspace returned an invalid replacement result.',
      );
    }
    const replacement = inspected.result;
    const durability = replacement.outcome === 'committed'
      ? replacement.durability
      : undefined;

    const receipt: SharedOsFileReplaceOperationReceiptV1 = Object.freeze({
      runId: this.options.runId,
      actorId: validated.actorId,
      traceId: validated.traceId,
      operationId: operation.operationId,
      path: MEMORY_PATH,
      action: 'replace',
      outcome: replacement.outcome,
      expectedVersion,
      previousVersion: previous.receipt.version,
      previousSha256: previous.receipt.sha256,
      previousByteLength: previous.receipt.byteLength,
      previousBytesBase64: Buffer.from(previous.content, 'utf8').toString('base64'),
      newBytesBase64: Buffer.from(parsed.content, 'utf8').toString('base64'),
      version: replacement.version,
      sha256: replacement.sha256,
      byteLength: replacement.byteLength,
      ...(durability ? { durability } : {}),
    });
    state.receipts.push(receipt);
    delete state.memoryObservation;
    if (replacement.outcome === 'committed') state.publicationCommitted = true;

    // A committed result is authoritative even if cancellation arrives after
    // publication. Throwing here would hide a real side effect from SharedOS.
    return {
      status: 'succeeded',
      operationId: operation.operationId,
      output: {
        outcome: replacement.outcome,
        version: encodeFileVersionV1(replacement.version),
        sha256: replacement.sha256,
        byteLength: replacement.byteLength,
        ...(durability ? { durability } : {}),
      },
      completedAt: operation.context.now,
    };
  }

  private turnState(actorId: string, traceId: string): TurnState {
    const key = turnKey(actorId, traceId);
    let state = this.turns.get(key);
    if (!state) {
      state = {
        receipts: [],
        publicationCommitted: false,
        tail: Promise.resolve(),
      };
      this.turns.set(key, state);
    }
    return state;
  }
}

function enqueueTurn<T>(state: TurnState, work: () => Promise<T>): Promise<T> {
  const result = state.tail.then(work);
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}

function parseReplaceInput(
  input: SoResourceOperation['input'],
): { content: string; expectedVersion: string } | undefined {
  if (!isPlainObject(input)) return undefined;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'content' || keys[1] !== 'expectedVersion') {
    return undefined;
  }
  const content = input['content'];
  const expectedVersion = input['expectedVersion'];
  return typeof content === 'string' && typeof expectedVersion === 'string'
    ? { content, expectedVersion }
    : undefined;
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validReadResult(
  value: unknown,
  actorId: string,
  path: AgentWorkspaceFilePathV1,
): value is Awaited<ReturnType<FileWorkspacePortV1['read']>> {
  if (!isPlainObject(value) || !hasExactKeys(value, ['content', 'receipt'])) return false;
  const content = value['content'];
  const receipt = value['receipt'];
  if (
    typeof content !== 'string'
    || !isPlainObject(receipt)
    || !hasExactKeys(receipt, ['action', 'actorId', 'byteLength', 'path', 'sha256', 'version'])
  ) {
    return false;
  }
  const version = receipt['version'];
  const sha256 = receipt['sha256'];
  const byteLength = receipt['byteLength'];
  return receipt['actorId'] === actorId
    && receipt['path'] === path
    && receipt['action'] === 'read'
    && typeof version === 'number'
    && Number.isSafeInteger(version)
    && version >= 0
    && isSha256(sha256)
    && sha256 === sha256Text(content)
    && typeof byteLength === 'number'
    && Number.isSafeInteger(byteLength)
    && byteLength >= 0
    && byteLength === Buffer.byteLength(content, 'utf8');
}

type InspectedReplaceResult =
  | { status: 'valid'; result: ReplaceMemoryResultV1 }
  | { status: 'invalid'; possiblyCommitted: boolean };

function inspectReplaceResult(
  value: unknown,
  expectedVersion: number,
  content: string,
): InspectedReplaceResult {
  let possiblyCommitted = false;
  try {
    if (!isPlainObject(value)) return { status: 'invalid', possiblyCommitted };
    const outcome = value['outcome'];
    possiblyCommitted = outcome === 'committed';
    if (outcome !== 'committed' && outcome !== 'conflict') {
      return { status: 'invalid', possiblyCommitted };
    }
    if (!hasExactKeys(
      value,
      ['byteLength', 'outcome', 'sha256', 'version'],
      outcome === 'committed' ? ['durability'] : [],
    )) {
      return { status: 'invalid', possiblyCommitted };
    }
    const version = value['version'];
    const sha256 = value['sha256'];
    const byteLength = value['byteLength'];
    const durability = value['durability'];
    if (
      typeof version !== 'number'
      || !Number.isSafeInteger(version)
      || version < 0
      || !isSha256(sha256)
      || typeof byteLength !== 'number'
      || !Number.isSafeInteger(byteLength)
      || byteLength < 0
    ) {
      return { status: 'invalid', possiblyCommitted };
    }
    if (outcome === 'conflict') {
      return version === expectedVersion
        ? { status: 'invalid', possiblyCommitted }
        : {
          status: 'valid',
          result: { outcome, version, sha256, byteLength },
        };
    }
    if (
      expectedVersion >= Number.MAX_SAFE_INTEGER
      || version !== expectedVersion + 1
      || sha256 !== sha256Text(content)
      || byteLength !== Buffer.byteLength(content, 'utf8')
      || (durability !== undefined && durability !== 'published_unsynced')
    ) {
      return { status: 'invalid', possiblyCommitted };
    }
    return {
      status: 'valid',
      result: {
        outcome,
        version,
        sha256,
        byteLength,
        ...(durability ? { durability } : {}),
      },
    };
  } catch {
    return { status: 'invalid', possiblyCommitted: true };
  }
}

function hasExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && allowed.has(key));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deniedResult(
  operation: SoResourceOperation,
  code: string,
  message: string,
): SoResourceResult {
  return {
    status: 'denied',
    operationId: operation.operationId,
    error: { code, message },
    completedAt: safeCompletedAt(operation.context.now),
  };
}

function failedResult(
  operation: SoResourceOperation,
  code: string,
  message: string,
): SoResourceResult {
  return {
    status: 'failed',
    operationId: operation.operationId,
    error: { code, message },
    completedAt: safeCompletedAt(operation.context.now),
  };
}

function safeCompletedAt(candidate: string): string {
  return Number.isFinite(Date.parse(candidate)) ? candidate : new Date().toISOString();
}

function sameAddress(left: SoAddress | undefined, right: SoAddress): boolean {
  return left !== undefined && addressKey(left) === addressKey(right);
}

function addressKey(address: SoAddress): string {
  switch (address.kind) {
    case 'human': return `human:${address.userId}`;
    case 'agent': return `agent:${address.agentId}`;
    case 'group': return `group:${address.conversationId}`;
    case 'service': return `service:${address.serviceId}`;
  }
}

function turnKey(actorId: string, traceId: string): string {
  return `${actorId.length}:${actorId}${traceId.length}:${traceId}`;
}

function assertOpaqueId(value: string, label: string): void {
  if (!isOpaqueId(value)) throw new Error(`${label} must be a canonical non-empty identifier`);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('File operation cancelled');
  }
}
