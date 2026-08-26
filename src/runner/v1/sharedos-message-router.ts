import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { stableIdV1 } from '../../contracts/json.js';
import type {
  SoAccessContext,
  SoExecutionResult,
  SoMessageDeliveryResult,
  SoMessageEnvelope,
  SoMessageRequestRouter,
} from '../../execution/sharedos/v1/contracts.js';
import type { LoadedPactPairTaskV1 } from '../../suites/pact-pair/task-loader.js';
import { fileTurnDecisionV1Schema } from './file-turn-contracts.js';
import type { FileReadReceiptV1 } from './file-workspace.js';
import type {
  SharedOsFileOperationReceiptV1,
  SharedOsFileProviderV1,
} from './sharedos-file-provider.js';
import {
  SharedOsResponderTaskAlreadyBoundErrorV1,
  type SharedOsSessionStoreV1,
} from './sharedos-session-store.js';
import type { FileSessionContactErrorCodeV1 } from './sharedos-file-session-contracts.js';

const logicalFiles = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const;
const identifierSchema = z.string().min(1).max(256).refine(
  value => value.trim() === value,
  'identifier must not have leading or trailing whitespace',
);
const purposeSchema = z.string().min(1).max(512).refine(
  value => value.trim() === value,
  'purpose must not have leading or trailing whitespace',
);
const requestPayloadSchema = z.object({
  taskId: identifierSchema,
  message: z.string().min(1).max(1_048_576).refine(
    value => value.trim().length > 0,
    'message must contain non-whitespace text',
  ),
}).strict();
const replyPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    taskId: identifierSchema,
    status: z.literal('completed'),
    response: z.string().min(1).max(1_048_576),
  }).strict(),
  z.object({
    taskId: identifierSchema,
    status: z.literal('denied'),
    errorCode: z.literal('CONTACT_RESPONDER_DENIED'),
  }).strict(),
]);

export type SharedOsMessageRouterSessionPortV1 = Pick<
  SharedOsSessionStoreV1,
  'readMessage' | 'bindResponderGrantSet'
>;

export type ExecuteSharedOsResponderTurnV1 = (
  input: Readonly<{
    task: LoadedPactPairTaskV1;
    executionId: string;
    context: SoAccessContext;
    message: SoMessageEnvelope;
  }>,
  signal: AbortSignal,
) => Promise<Readonly<{
  context: SoAccessContext;
  execution: SoExecutionResult;
}>>;

export type SendSharedOsReplyV1 = (
  context: SoAccessContext,
  envelope: SoMessageEnvelope,
  signal: AbortSignal,
) => Promise<SoMessageDeliveryResult>;

export type SharedOsMessageContactResultV1 = Readonly<{
  taskId?: string;
  requestMessageId: string;
  replyMessageId?: string;
  responderExecutionId?: string;
  status: 'completed' | 'denied' | 'failed' | 'cancelled';
  response?: string;
  errorCode?: FileSessionContactErrorCodeV1;
  responderReads: readonly FileReadReceiptV1[];
}>;

export type CreateSharedOsMessageRequestRouterV1Options = Readonly<{
  namespaceId: string;
  purpose: string;
  requesterActorId: string;
  responderActorId: string;
  tasks: readonly LoadedPactPairTaskV1[];
  responderGrantSets: readonly Readonly<{
    taskId: string;
    grantIds: readonly string[];
  }>[];
  store: SharedOsMessageRouterSessionPortV1;
  fileProvider: SharedOsFileProviderV1;
  executeResponderTurn: ExecuteSharedOsResponderTurnV1;
  sendReply: SendSharedOsReplyV1;
}>;

export interface SharedOsMessageRequestRouterV1 extends SoMessageRequestRouter {
  readContactResult(input: Readonly<{ traceId: string }>): SharedOsMessageContactResultV1 | null;
  assertTraceHealthy(input: Readonly<{ traceId: string }>): void;
  assertTraceSettled(input: Readonly<{ traceId: string }>): void;
}

/**
 * Resolve one already-authorized request synchronously through its recipient.
 * Scheduling and recovery remain host concerns; this router owns no queue.
 */
export function createSharedOsMessageRequestRouterV1(
  input: CreateSharedOsMessageRequestRouterV1Options,
): SharedOsMessageRequestRouterV1 {
  return new RunScopedMessageRequestRouter(normalizeOptions(input));
}

type NormalizedOptions = Readonly<{
  namespaceId: string;
  purpose: string;
  requesterActorId: string;
  responderActorId: string;
  tasksById: ReadonlyMap<string, LoadedPactPairTaskV1>;
  grantIdsByTask: ReadonlyMap<string, readonly string[]>;
  store: SharedOsMessageRouterSessionPortV1;
  fileProvider: SharedOsFileProviderV1;
  executeResponderTurn: ExecuteSharedOsResponderTurnV1;
  sendReply: SendSharedOsReplyV1;
}>;

class RunScopedMessageRequestRouter implements SharedOsMessageRequestRouterV1 {
  private readonly contacts = new Map<string, SharedOsMessageContactResultV1>();
  private readonly fatalByTrace = new Map<string, Error>();
  private readonly activeByTrace = new Map<string, Readonly<{
    context: SoAccessContext;
    request: SoMessageEnvelope;
    delivery: SoMessageDeliveryResult;
    signal: AbortSignal;
    route: Promise<SoMessageEnvelope>;
  }>>();

  constructor(private readonly options: NormalizedOptions) {}

  async resolveReply(
    context: SoAccessContext,
    request: SoMessageEnvelope,
    delivery: SoMessageDeliveryResult,
    signal: AbortSignal,
  ): Promise<SoMessageEnvelope> {
    const traceId = safeTraceId(request, context);
    if (traceId !== undefined) this.assertTraceHealthy({ traceId });
    const active = traceId === undefined ? undefined : this.activeByTrace.get(traceId);
    if (
      traceId !== undefined
      && active
      && isDeepStrictEqual(active.context, context)
      && isDeepStrictEqual(active.request, request)
      && isDeepStrictEqual(active.delivery, delivery)
    ) {
      try {
        return structuredClone(await waitForRoute(active.route, signal));
      } catch (error) {
        this.latchIfFatal(traceId, error, signal, active.signal);
        throw error;
      }
    }
    if (active) throw new SharedOsMessageRouteFailedErrorV1();

    const ownsActive = traceId !== undefined && active === undefined;
    let snapshot: Readonly<{
      context: SoAccessContext;
      request: SoMessageEnvelope;
      delivery: SoMessageDeliveryResult;
    }> | undefined;
    if (ownsActive && traceId !== undefined) {
      try {
        snapshot = Object.freeze({
          context: structuredClone(context),
          request: structuredClone(request),
          delivery: structuredClone(delivery),
        });
      } catch (error) {
        this.latchIfFatal(traceId, error, signal);
        throw error;
      }
    }
    const route = this.route(context, request, delivery, signal);
    if (snapshot && traceId !== undefined) {
      this.activeByTrace.set(traceId, Object.freeze({ ...snapshot, signal, route }));
    }
    try {
      return await route;
    } catch (error) {
      if (traceId !== undefined) this.latchIfFatal(traceId, error, signal);
      throw error;
    } finally {
      if (
        traceId !== undefined
        && ownsActive
        && this.activeByTrace.get(traceId)?.route === route
      ) {
        this.activeByTrace.delete(traceId);
      }
    }
  }

  readContactResult(input: Readonly<{ traceId: string }>): SharedOsMessageContactResultV1 | null {
    const traceId = identifierSchema.parse(input.traceId);
    const contact = this.contacts.get(traceId);
    return contact ? immutableContact(contact) : null;
  }

  assertTraceHealthy(input: Readonly<{ traceId: string }>): void {
    const traceId = identifierSchema.parse(input.traceId);
    const fatal = this.fatalByTrace.get(traceId);
    if (fatal) throw fatal;
  }

  assertTraceSettled(input: Readonly<{ traceId: string }>): void {
    const traceId = identifierSchema.parse(input.traceId);
    if (this.activeByTrace.has(traceId)) {
      throw new SharedOsMessageRouteIndeterminateErrorV1();
    }
  }

  private async route(
    inputContext: SoAccessContext,
    inputRequest: SoMessageEnvelope,
    delivery: SoMessageDeliveryResult,
    signal: AbortSignal,
  ): Promise<SoMessageEnvelope> {
    throwIfAborted(signal);
    const context = structuredClone(inputContext);
    const request = structuredClone(inputRequest);
    if (!validRequestBoundary(context, request, delivery, this.options)) {
      return this.fail({
        traceId: usableTraceId(request.traceId) ?? usableTraceId(context.traceId),
        requestMessageId: usableId(request.id) ?? 'untrusted-request',
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }

    const durableRequest = await this.options.store.readMessage(request.id);
    if (!durableRequest || !isDeepStrictEqual(durableRequest, request)) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }

    const parsedPayload = requestPayloadSchema.safeParse(durableRequest.payload);
    if (!parsedPayload.success) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }
    const task = this.options.tasksById.get(parsedPayload.data.taskId);
    const grantIds = this.options.grantIdsByTask.get(parsedPayload.data.taskId);
    if (!task || !grantIds) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }

    const requesterReads = await this.readFileReceipts(
      this.options.requesterActorId,
      request.traceId,
    );
    if (!hasCompleteReadCoverage(requesterReads)) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        errorCode: 'CONTACT_REQUESTER_FILE_READ_REQUIRED',
      });
    }

    let bindingOutcome: 'created' | 'replayed';
    try {
      bindingOutcome = await this.options.store.bindResponderGrantSet({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        grantIds,
      });
    } catch (error) {
      if (error instanceof SharedOsResponderTaskAlreadyBoundErrorV1) {
        return this.fail({
          traceId: request.traceId,
          requestMessageId: request.id,
          taskId: task.taskId,
          errorCode: 'CONTACT_DUPLICATE_TASK',
        });
      }
      throw error;
    }

    if (bindingOutcome === 'replayed') {
      return await this.resolveAuthoritativeReplay(request, task);
    }

    const responderBefore = await this.readFileReceipts(
      this.options.responderActorId,
      request.traceId,
    );

    const responderExecutionId = stableIdV1('execution', [
      'responder-execution',
      request.id,
      this.options.responderActorId,
    ]);
    const responderContext: SoAccessContext = {
      ...structuredClone(context),
      actor: { kind: 'agent', agentId: this.options.responderActorId },
      enabledToolNamespaces: ['files', 'pact-pair'],
    };

    let executed: Awaited<ReturnType<ExecuteSharedOsResponderTurnV1>>;
    try {
      executed = await this.options.executeResponderTurn({
        task: structuredClone(task),
        executionId: responderExecutionId,
        context: structuredClone(responderContext),
        message: structuredClone(durableRequest),
      }, signal);
      throwIfAborted(signal);
    } catch (error) {
      if (isCancellation(error, signal)) {
        this.recordFailure({
          traceId: request.traceId,
          requestMessageId: request.id,
          taskId: task.taskId,
          responderExecutionId,
          status: 'cancelled',
          errorCode: 'CONTACT_CANCELLED',
        });
        throw signal.reason ?? error;
      }
      throw error;
    }

    if (!validExecutionIdentity(executed, responderContext, responderExecutionId)) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }

    const responderAfter = await this.readFileReceipts(
      this.options.responderActorId,
      request.traceId,
    );
    const responderReads = readsAddedDuringTurn(responderBefore, responderAfter);
    const execution = executed.execution;
    if (execution.status === 'cancelled') {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        responderReads,
        status: 'cancelled',
        errorCode: 'CONTACT_CANCELLED',
      });
    }
    if (execution.status !== 'succeeded') {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        responderReads,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }

    const decision = fileTurnDecisionV1Schema.safeParse(execution.output);
    if (!decision.success) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        responderReads,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }
    if (decision.data.type === 'cancelled') {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        responderReads,
        status: 'cancelled',
        errorCode: 'CONTACT_CANCELLED',
      });
    }
    if (!hasCompleteReadCoverage(responderReads)) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        responderReads,
        errorCode: 'CONTACT_RESPONDER_FILE_READ_REQUIRED',
      });
    }

    const reply: SoMessageEnvelope = {
      version: '1',
      id: stableIdV1('message', ['message-reply', request.id]),
      sender: { kind: 'agent', agentId: this.options.responderActorId },
      receiver: { kind: 'agent', agentId: this.options.requesterActorId },
      purpose: this.options.purpose,
      payload: decision.data.type === 'completed'
        ? {
            taskId: task.taskId,
            status: 'completed',
            response: decision.data.content,
          }
        : {
            taskId: task.taskId,
            status: 'denied',
            errorCode: 'CONTACT_RESPONDER_DENIED',
          },
      traceId: request.traceId,
      replyTo: request.id,
      createdAt: responderContext.now,
    };

    let replyDelivery: SoMessageDeliveryResult;
    try {
      replyDelivery = await this.options.sendReply(
        structuredClone(responderContext),
        structuredClone(reply),
        signal,
      );
    } catch (error) {
      if (isCancellation(error, signal)) {
        try {
          const durableReply = await this.readExactDurableReply(reply);
          return this.acceptAuthoritativeReply({
            request,
            task,
            responderExecutionId,
            responderReads: projectReadReceipts(responderReads),
            reply: durableReply,
          });
        } catch (reconciliationError) {
          if (!(reconciliationError instanceof SharedOsMessageRouteIndeterminateErrorV1)) {
            throw reconciliationError;
          }
        }
        this.recordFailure({
          traceId: request.traceId,
          requestMessageId: request.id,
          taskId: task.taskId,
          responderExecutionId,
          responderReads,
          status: 'cancelled',
          errorCode: 'CONTACT_CANCELLED',
        });
        throw signal.reason ?? error;
      }
      throw error;
    }
    if (!acceptedFor(replyDelivery, reply.id)) {
      return this.fail({
        traceId: request.traceId,
        requestMessageId: request.id,
        taskId: task.taskId,
        responderExecutionId,
        responderReads,
        errorCode: 'CONTACT_RESPONDER_FAILED',
      });
    }
    const durableReply = await this.readExactDurableReply(reply);
    return this.acceptAuthoritativeReply({
      request,
      task,
      responderExecutionId,
      responderReads: projectReadReceipts(responderReads),
      reply: durableReply,
    });
  }

  private async resolveAuthoritativeReplay(
    request: SoMessageEnvelope,
    task: LoadedPactPairTaskV1,
  ): Promise<SoMessageEnvelope> {
    const replyId = stableIdV1('message', ['message-reply', request.id]);
    const durableReply = await this.options.store.readMessage(replyId);
    const existing = this.contacts.get(request.traceId);
    if (!durableReply) {
      if (existing && isCoherentCachedFailure(existing, request, task, this.options)) {
        throw new SharedOsMessageRouteFailedErrorV1(existing.status === 'cancelled');
      }
      throw new SharedOsMessageRouteIndeterminateErrorV1();
    }

    let responderReads: readonly FileReadReceiptV1[];
    if (existing) {
      responderReads = existing.responderReads;
    } else {
      const receipts = await this.readFileReceipts(
        this.options.responderActorId,
        request.traceId,
      );
      if (!hasCompleteReadCoverage(receipts)) {
        throw new SharedOsMessageRouteIndeterminateErrorV1();
      }
      responderReads = projectReadReceipts(receipts);
    }

    return this.acceptAuthoritativeReply({
      request,
      task,
      responderExecutionId: stableIdV1('execution', [
        'responder-execution',
        request.id,
        this.options.responderActorId,
      ]),
      responderReads,
      reply: durableReply,
    });
  }

  private async readExactDurableReply(
    expected: SoMessageEnvelope,
  ): Promise<SoMessageEnvelope> {
    const durable = await this.options.store.readMessage(expected.id);
    if (!durable || !isDeepStrictEqual(durable, expected)) {
      throw new SharedOsMessageRouteIndeterminateErrorV1();
    }
    return durable;
  }

  private acceptAuthoritativeReply(input: Readonly<{
    request: SoMessageEnvelope;
    task: LoadedPactPairTaskV1;
    responderExecutionId: string;
    responderReads: readonly FileReadReceiptV1[];
    reply: SoMessageEnvelope;
  }>): SoMessageEnvelope {
    const payload = correlatedReplyPayload(input.reply, input.request, input.task, this.options);
    if (!payload) throw new SharedOsMessageRouteIndeterminateErrorV1();
    const contact = immutableContact({
      taskId: input.task.taskId,
      requestMessageId: input.request.id,
      replyMessageId: input.reply.id,
      responderExecutionId: input.responderExecutionId,
      status: payload.status,
      ...(payload.status === 'completed'
        ? { response: payload.response }
        : { errorCode: 'CONTACT_RESPONDER_DENIED' as const }),
      responderReads: input.responderReads,
    });
    const existing = this.contacts.get(input.request.traceId);
    if (existing && !isDeepStrictEqual(existing, contact)) {
      throw new SharedOsMessageRouteIndeterminateErrorV1();
    }
    if (!existing) this.contacts.set(input.request.traceId, contact);
    return structuredClone(input.reply);
  }

  private async readFileReceipts(
    actorId: string,
    traceId: string,
  ): Promise<readonly SharedOsFileOperationReceiptV1[]> {
    const receipts = await this.options.fileProvider.readReceipts({ actorId, traceId });
    return receipts.filter(receipt => validReceipt(receipt, actorId, traceId));
  }

  private fail(input: Readonly<{
    traceId: string | undefined;
    requestMessageId: string;
    taskId?: string;
    responderExecutionId?: string;
    responderReads?: readonly SharedOsFileOperationReceiptV1[];
    status?: 'failed' | 'cancelled';
    errorCode: FileSessionContactErrorCodeV1;
  }>): never {
    if (input.traceId !== undefined) {
      this.recordFailure({ ...input, traceId: input.traceId });
    }
    throw new SharedOsMessageRouteFailedErrorV1(input.status === 'cancelled');
  }

  private recordFailure(input: Readonly<{
    traceId: string;
    requestMessageId: string;
    taskId?: string;
    responderExecutionId?: string;
    responderReads?: readonly SharedOsFileOperationReceiptV1[];
    status?: 'failed' | 'cancelled';
    errorCode: FileSessionContactErrorCodeV1;
  }>): void {
    if (this.contacts.has(input.traceId)) return;
    this.contacts.set(input.traceId, immutableContact({
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      requestMessageId: input.requestMessageId,
      ...(input.responderExecutionId === undefined
        ? {}
        : { responderExecutionId: input.responderExecutionId }),
      status: input.status ?? 'failed',
      errorCode: input.errorCode,
      responderReads: projectReadReceipts(input.responderReads ?? []),
    }));
  }

  private latchFatal(traceId: string, error: unknown): void {
    if (!this.fatalByTrace.has(traceId)) {
      this.fatalByTrace.set(traceId, normalizeFatalError(error));
    }
  }

  private latchIfFatal(
    traceId: string,
    error: unknown,
    signal: AbortSignal,
    originatingSignal: AbortSignal = signal,
  ): void {
    if (
      !(error instanceof SharedOsMessageRouteFailedErrorV1)
      && !isCancellation(error, signal)
      && !isCancellation(error, originatingSignal)
    ) {
      this.latchFatal(traceId, error);
    }
  }
}

export class SharedOsMessageRouteFailedErrorV1 extends Error {
  constructor(cancelled = false) {
    super(cancelled
      ? 'SharedOS message reply resolution was cancelled'
      : 'SharedOS message reply could not be resolved');
    this.name = 'SharedOsMessageRouteFailedErrorV1';
  }
}

export class SharedOsMessageRouteIndeterminateErrorV1 extends Error {
  constructor() {
    super('SharedOS message replay has no coherent authoritative reply');
    this.name = 'SharedOsMessageRouteIndeterminateErrorV1';
  }
}

function normalizeOptions(input: CreateSharedOsMessageRequestRouterV1Options): NormalizedOptions {
  const namespaceId = identifierSchema.parse(input.namespaceId);
  const purpose = purposeSchema.parse(input.purpose);
  const requesterActorId = identifierSchema.parse(input.requesterActorId);
  const responderActorId = identifierSchema.parse(input.responderActorId);
  if (requesterActorId === responderActorId) {
    throw new Error('Message router actors must be distinct');
  }
  if (input.fileProvider.namespace !== 'files') {
    throw new Error('Message router requires the SharedOS files provider');
  }
  const tasksById = new Map<string, LoadedPactPairTaskV1>();
  for (const task of input.tasks) {
    const taskId = identifierSchema.parse(task.taskId);
    if (tasksById.has(taskId)) throw new Error('Message router tasks must be unique');
    tasksById.set(taskId, structuredClone(task));
  }
  if (tasksById.size === 0) throw new Error('Message router requires selected tasks');

  const grantIdsByTask = new Map<string, readonly string[]>();
  for (const set of input.responderGrantSets) {
    const taskId = identifierSchema.parse(set.taskId);
    const grantIds = set.grantIds.map(grantId => identifierSchema.parse(grantId));
    if (grantIds.length === 0 || new Set(grantIds).size !== grantIds.length) {
      throw new Error('Message router responder grant sets must be non-empty and unique');
    }
    if (grantIdsByTask.has(taskId)) {
      throw new Error('Message router responder task grant sets must be unique');
    }
    grantIdsByTask.set(taskId, Object.freeze([...grantIds]));
  }
  if (
    tasksById.size !== grantIdsByTask.size
    || [...tasksById.keys()].some(taskId => !grantIdsByTask.has(taskId))
  ) {
    throw new Error('Message router tasks and responder grant sets must match exactly');
  }
  return Object.freeze({
    namespaceId,
    purpose,
    requesterActorId,
    responderActorId,
    tasksById,
    grantIdsByTask,
    store: input.store,
    fileProvider: input.fileProvider,
    executeResponderTurn: input.executeResponderTurn,
    sendReply: input.sendReply,
  });
}

function validRequestBoundary(
  context: SoAccessContext,
  request: SoMessageEnvelope,
  delivery: SoMessageDeliveryResult,
  options: NormalizedOptions,
): boolean {
  return (
    context.namespaceId === options.namespaceId
    && context.purpose === options.purpose
    && context.traceId === request.traceId
    && context.actor.kind === 'agent'
    && context.actor.agentId === options.requesterActorId
    && request.version === '1'
    && request.sender.kind === 'agent'
    && request.sender.agentId === options.requesterActorId
    && request.receiver.kind === 'agent'
    && request.receiver.agentId === options.responderActorId
    && request.purpose === options.purpose
    && request.replyTo === undefined
    && acceptedFor(delivery, request.id)
  );
}

function validExecutionIdentity(
  executed: Awaited<ReturnType<ExecuteSharedOsResponderTurnV1>>,
  expectedContext: SoAccessContext,
  expectedExecutionId: string,
): boolean {
  return (
    isDeepStrictEqual(executed.context, expectedContext)
    && executed.execution.version === '1'
    && executed.execution.executionId === expectedExecutionId
    && executed.execution.traceId === expectedContext.traceId
  );
}

function correlatedReplyPayload(
  reply: SoMessageEnvelope,
  request: SoMessageEnvelope,
  task: LoadedPactPairTaskV1,
  options: NormalizedOptions,
): z.infer<typeof replyPayloadSchema> | null {
  const payload = replyPayloadSchema.safeParse(reply.payload);
  if (
    !payload.success
    || payload.data.taskId !== task.taskId
    || reply.version !== '1'
    || reply.id !== stableIdV1('message', ['message-reply', request.id])
    || reply.sender.kind !== 'agent'
    || reply.sender.agentId !== options.responderActorId
    || reply.receiver.kind !== 'agent'
    || reply.receiver.agentId !== options.requesterActorId
    || reply.purpose !== options.purpose
    || reply.traceId !== request.traceId
    || reply.replyTo !== request.id
  ) {
    return null;
  }
  return payload.data;
}

function isCoherentCachedFailure(
  contact: SharedOsMessageContactResultV1,
  request: SoMessageEnvelope,
  task: LoadedPactPairTaskV1,
  options: NormalizedOptions,
): boolean {
  const expectedExecutionId = stableIdV1('execution', [
    'responder-execution',
    request.id,
    options.responderActorId,
  ]);
  return (
    contact.taskId === task.taskId
    && contact.requestMessageId === request.id
    && contact.replyMessageId === undefined
    && contact.responderExecutionId === expectedExecutionId
    && contact.response === undefined
    && (
      (contact.status === 'cancelled' && contact.errorCode === 'CONTACT_CANCELLED')
      || (
        contact.status === 'failed'
        && contact.errorCode !== undefined
        && contact.errorCode !== 'CONTACT_CANCELLED'
        && contact.errorCode !== 'CONTACT_RESPONDER_DENIED'
      )
    )
  );
}

function acceptedFor(delivery: SoMessageDeliveryResult, messageId: string): boolean {
  return (
    (delivery.status === 'accepted' || delivery.status === 'delivered')
    && delivery.messageId === messageId
  );
}

function readsAddedDuringTurn(
  before: readonly SharedOsFileOperationReceiptV1[],
  after: readonly SharedOsFileOperationReceiptV1[],
): readonly SharedOsFileOperationReceiptV1[] {
  const priorIds = new Set(before.map(receipt => receipt.operationId));
  return after.filter(receipt => !priorIds.has(receipt.operationId));
}

function hasCompleteReadCoverage(
  receipts: readonly SharedOsFileOperationReceiptV1[],
): boolean {
  const observed = new Set(receipts.filter(receipt => receipt.action === 'read')
    .map(receipt => receipt.path));
  return logicalFiles.every(path => observed.has(path));
}

function validReceipt(
  receipt: SharedOsFileOperationReceiptV1,
  actorId: string,
  traceId: string,
): boolean {
  return (
    receipt.actorId === actorId
    && receipt.traceId === traceId
    && identifierSchema.safeParse(receipt.operationId).success
    && Number.isSafeInteger(receipt.version)
    && receipt.version >= 0
    && /^[a-f0-9]{64}$/.test(receipt.sha256)
    && Number.isSafeInteger(receipt.byteLength)
    && receipt.byteLength >= 0
  );
}

function projectReadReceipts(
  receipts: readonly SharedOsFileOperationReceiptV1[],
): readonly FileReadReceiptV1[] {
  return Object.freeze(receipts.flatMap(receipt => receipt.action === 'read' ? [Object.freeze({
    actorId: receipt.actorId,
    path: receipt.path,
    action: receipt.action,
    version: receipt.version,
    sha256: receipt.sha256,
    byteLength: receipt.byteLength,
  })] : []));
}

function immutableContact(contact: SharedOsMessageContactResultV1): SharedOsMessageContactResultV1 {
  return Object.freeze({
    ...structuredClone(contact),
    responderReads: Object.freeze(contact.responderReads.map(receipt => (
      Object.freeze(structuredClone(receipt))
    ))),
  });
}

function usableId(value: unknown): string | undefined {
  const result = identifierSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function usableTraceId(value: unknown): string | undefined {
  return usableId(value);
}

function safeTraceId(
  request: SoMessageEnvelope,
  context: SoAccessContext,
): string | undefined {
  try {
    return usableTraceId(request.traceId) ?? usableTraceId(context.traceId);
  } catch {
    return undefined;
  }
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (
    error === signal.reason
    || (error instanceof Error && error.name === 'AbortError')
  );
}

function normalizeFatalError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('SharedOS message routing infrastructure failed', { cause: error });
}

function waitForRoute(
  route: Promise<SoMessageEnvelope>,
  signal: AbortSignal,
): Promise<SoMessageEnvelope> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('SharedOS message route cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    route.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('SharedOS message route cancelled');
}
