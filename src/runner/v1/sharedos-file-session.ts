import {
  sha256JsonV1,
  stableIdV1,
  type JsonValue,
} from '../../contracts/json.js';
import {
  loadSharedOsModulesV1,
  type LoadSharedOsResultV1,
} from '../../execution/sharedos/v1/load-sharedos.js';
import type {
  SharedOsModulesV1,
  SoAccessContext,
  SoAddress,
  SoExecutionRequest,
  SoExecutionResult,
  SoKernel,
  SoMessageEnvelope,
  SoToolCall,
  SoToolDefinition,
  SoToolHandler,
  SoTurnDriver,
} from '../../execution/sharedos/v1/contracts.js';
import { buildPactPairSharedOsGrantManifestV1 } from '../../suites/pact-pair/sharedos-grants.js';
import { createPactPairSharedOsToolHandlersV1 } from '../../suites/pact-pair/sharedos-tools.js';
import type { LoadedPactPairTaskV1 } from '../../suites/pact-pair/task-loader.js';
import type {
  FileProviderTelemetrySourceV1,
  FileProviderTelemetryV1,
} from './file-model-driver.js';
import { fileTurnDecisionV1Schema } from './file-turn-contracts.js';
import type { FileReadReceiptV1 } from './file-workspace.js';
import {
  createSharedOsFileProviderV1,
  type SharedOsFileOperationReceiptV1,
  type SharedOsFileProviderV1,
} from './sharedos-file-provider.js';
import {
  SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
  SHAREDEVAL_SERVICE_ADDRESS_V1,
  type CreateSharedOsFileSessionV1Options,
  type SharedOsFileSessionFactoryV1,
  type SharedOsFileSessionV1,
  type SharedOsFileTurnResultV1,
} from './sharedos-file-session-contracts.js';
import {
  createSharedOsMessageRequestRouterV1,
  type SharedOsMessageContactResultV1,
  type SharedOsMessageRequestRouterV1,
} from './sharedos-message-router.js';
import {
  openSharedOsSessionStoreV1,
  readSharedOsSessionStartedAtV1,
  type SharedOsSessionStoreV1,
} from './sharedos-session-store.js';

const FILE_TOOL_NAMES = new Set(['files.read', 'files.replace']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function createSharedOsFileSessionV1(
  input: CreateSharedOsFileSessionV1Options,
): Promise<SharedOsFileSessionV1> {
  validateOptions(input);
  const loaded = await loadSharedOsModulesV1();
  if (!loaded.ok) {
    throw new Error('The pinned SharedOS runtime is unavailable');
  }
  return await createPreloadedSharedOsFileSessionFactoryV1(loaded)(input);
}

/** Reuses one verified SharedOS module load across every session in a run. */
export function createPreloadedSharedOsFileSessionFactoryV1(
  loaded: Extract<LoadSharedOsResultV1, { ok: true }>,
): SharedOsFileSessionFactoryV1 {
  const authority = Object.freeze({
    ...loaded,
    modules: loaded.modules,
  });
  return async input => {
    validateOptions(input);
    return await SharedOsFileSession.create(input, authority);
  };
}

class SharedOsFileSession implements SharedOsFileSessionV1 {
  private operationTail: Promise<void> = Promise.resolve();
  private readonly seenTraces = new Set<string>();
  private readonly responderUsageByTrace = new Map<string, FileProviderTelemetryV1>();
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly options: CreateSharedOsFileSessionV1Options,
    private readonly modules: SharedOsModulesV1,
    private readonly store: SharedOsSessionStoreV1,
    private readonly fileProvider: SharedOsFileProviderV1,
    private readonly fileHandlers: readonly SoToolHandler[],
    private readonly router: SharedOsMessageRequestRouterV1,
    readonly provenance: NonNullable<SharedOsFileTurnResultV1['provenance']>,
  ) {}

  static async create(
    input: CreateSharedOsFileSessionV1Options,
    loaded: Extract<LoadSharedOsResultV1, { ok: true }>,
  ): Promise<SharedOsFileSession> {
    const options = freezeOptions(input);
    const persistedStartedAt = await readSharedOsSessionStartedAtV1(options.storeRoot);
    let runStartedAt = persistedStartedAt ?? new Date().toISOString();
    let authority: Awaited<ReturnType<typeof openSessionAuthority>>;
    try {
      authority = await openSessionAuthority(options, runStartedAt);
    } catch (error) {
      if (persistedStartedAt !== null) throw error;
      const concurrentlyCommittedStartedAt = await readSharedOsSessionStartedAtV1(
        options.storeRoot,
      );
      if (
        concurrentlyCommittedStartedAt === null
        || concurrentlyCommittedStartedAt === runStartedAt
      ) throw error;
      runStartedAt = concurrentlyCommittedStartedAt;
      authority = await openSessionAuthority(options, runStartedAt);
    }
    const store = authority.store;
    const manifest = authority.manifest;
    const fileProvider = createSharedOsFileProviderV1({
      runId: options.runId,
      deadlineMs: options.deadlineMs,
      requester: options.requester,
      responder: options.responder,
    });
    const fileHandlers = loaded.modules.os.createFileTools(fileProvider);
    let session: SharedOsFileSession | undefined;
    const router = createSharedOsMessageRequestRouterV1({
      namespaceId: options.namespaceId,
      purpose: SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
      requesterActorId: options.requester.actorId,
      responderActorId: options.responder.actorId,
      tasks: options.tasks,
      responderGrantSets: manifest.responderGrantSets,
      store,
      fileProvider,
      executeResponderTurn: (turn, signal) => {
        if (!session) throw new Error('SharedOS file session is not initialized');
        return session.executeResponderTurn(turn, signal);
      },
      sendReply: (context, envelope, signal) => {
        if (!session) throw new Error('SharedOS file session is not initialized');
        return session.sendReply(context, envelope, signal);
      },
    });
    session = new SharedOsFileSession(
      options,
      loaded.modules,
      store,
      fileProvider,
      fileHandlers,
      router,
      immutableClone({
        runStartedAt,
        namespaceId: options.namespaceId,
        grantManifestDigest: sha256JsonV1(manifest.grants as unknown as JsonValue),
        sharedOsRevision: loaded.revision,
        sharedOsRuntimeDigest: loaded.runtimeDigest,
      }),
    );
    return session;
  }

  async runRequesterTurn(input: Readonly<{
    tick: number;
    eventId: string;
    traceId: string;
    inputDigest: string;
    signal?: AbortSignal;
  }>): Promise<SharedOsFileTurnResultV1> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error('SharedOS file session is closed'));
    }
    validateHeartbeat(input, this.options);
    if (this.seenTraces.has(input.traceId)) {
      return Promise.reject(new Error('SharedOS heartbeat trace has already executed'));
    }
    this.seenTraces.add(input.traceId);
    return await this.enqueue(() => this.executeRequesterTurn(input));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.closePromise = this.enqueue(async () => {
      await this.store.close();
      await this.fileProvider.close();
      this.responderUsageByTrace.clear();
      this.closed = true;
      this.closing = false;
    });
    return this.closePromise;
  }

  private async executeRequesterTurn(input: Readonly<{
    tick: number;
    eventId: string;
    traceId: string;
    inputDigest: string;
    signal?: AbortSignal;
  }>): Promise<SharedOsFileTurnResultV1> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const auditStart = await this.store.snapshotAudit();
    const driver = this.options.createDriver({
      actorId: this.options.requester.actorId,
      role: 'requester',
    });
    const executionId = stableIdV1('execution', [
      'requester-execution',
      input.eventId,
      this.options.requester.actorId,
    ]);
    const now = new Date().toISOString();
    const context = this.context(
      this.options.requester.actorId,
      input.traceId,
      ['files', 'messages'],
      now,
    );
    const kernel = this.createKernel(this.router);
    const execution = await this.execute({
      kernel,
      driver,
      executionId,
      actorId: this.options.requester.actorId,
      context,
      message: {
        version: '1',
        id: stableIdV1('message', [
          'heartbeat-instruction',
          input.eventId,
          this.options.requester.actorId,
        ]),
        sender: structuredClone(SHAREDEVAL_SERVICE_ADDRESS_V1),
        receiver: { kind: 'agent', agentId: this.options.requester.actorId },
        purpose: SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
        payload: {
          text: 'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.',
        },
        traceId: input.traceId,
        createdAt: now,
        provenance: {
          source: 'sharedeval.scheduler',
          parentIds: [input.eventId],
        },
      },
      tools: [
        ...this.fileToolDefinitions(),
        structuredClone(this.modules.core.MESSAGE_REQUEST_TOOL_DEFINITION),
      ],
      signal,
    });
    // Health first: a failed route records the real cause (a provider timeout,
    // say) in fatalByTrace, and the trace also stays active because it never
    // settled. Asserting settled first masks that cause behind a generic
    // indeterminate-route error.
    this.router.assertTraceHealthy({ traceId: input.traceId });
    this.router.assertTraceSettled({ traceId: input.traceId });
    const decision = decisionFor(execution);
    const requesterReceipts = await this.fileProvider.readReceipts({
      actorId: this.options.requester.actorId,
      traceId: input.traceId,
    });
    const responderReceipts = await this.fileProvider.readReceipts({
      actorId: this.options.responder.actorId,
      traceId: input.traceId,
    });
    const contact = this.router.readContactResult({ traceId: input.traceId });
    const projectedContact = contact
      ? this.projectContact(contact, input.traceId)
      : undefined;
    const acceptedMessages = await this.readAcceptedMessages(contact, input.traceId);
    const auditEnd = await this.store.snapshotAudit();
    const auditEvents = await this.store.readAuditWindow({
      fromSequence: auditStart.nextSequence,
      toSequenceExclusive: auditEnd.nextSequence,
    });
    if (auditEnd.nextSequence <= auditStart.nextSequence) {
      throw new Error('SharedOS turn produced no authorization audit evidence');
    }
    if (auditEvents.some(event => event.traceId !== input.traceId)) {
      throw new Error('SharedOS audit window contains a foreign heartbeat trace');
    }
    return Object.freeze({
      executionId,
      traceId: input.traceId,
      executionStatus: execution.status,
      decision,
      requesterReads: projectReadReceipts(requesterReceipts),
      ...(projectedContact ? { contact: projectedContact } : {}),
      providerUsage: cloneTelemetry(driver.getFileProviderTelemetryV1()),
      provenance: this.provenance,
      sourceEvidence: immutableClone({
        requesterFileOperations: requesterReceipts,
        responderFileOperations: responderReceipts,
        acceptedMessages,
        auditEvents,
      }),
      audit: Object.freeze({
        firstSequence: auditStart.nextSequence,
        lastSequence: auditEnd.nextSequence - 1,
        sha256: sha256JsonV1(auditEvents as unknown as JsonValue),
      }),
    });
  }

  private async executeResponderTurn(
    input: Readonly<{
      task: LoadedPactPairTaskV1;
      executionId: string;
      context: SoAccessContext;
      message: SoMessageEnvelope;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ context: SoAccessContext; execution: SoExecutionResult }>> {
    const driver = this.options.createDriver({
      actorId: this.options.responder.actorId,
      role: 'responder',
    });
    const taskHandlers = createPactPairSharedOsToolHandlersV1({
      task: input.task,
      owner: SHAREDEVAL_SERVICE_ADDRESS_V1,
      workspace: this.options.pactWorkspace,
    });
    const kernel = this.createKernel(undefined, taskHandlers);
    let execution: SoExecutionResult;
    try {
      execution = await this.execute({
        kernel,
        driver,
        executionId: input.executionId,
        actorId: this.options.responder.actorId,
        context: input.context,
        message: input.message,
        tools: [
          ...this.fileToolDefinitions(),
          ...taskHandlers.map(handler => structuredClone(handler.definition)),
        ],
        signal,
      });
    } finally {
      this.responderUsageByTrace.set(
        input.context.traceId,
        cloneTelemetry(driver.getFileProviderTelemetryV1()),
      );
    }
    return Object.freeze({
      context: structuredClone(input.context),
      execution: structuredClone(execution),
    });
  }

  private sendReply(
    context: SoAccessContext,
    envelope: SoMessageEnvelope,
    signal: AbortSignal,
  ) {
    return this.createKernel().sendMessage(context, envelope, { signal });
  }

  private createKernel(
    router?: SharedOsMessageRequestRouterV1,
    taskHandlers: readonly SoToolHandler[] = [],
  ): SoKernel {
    const kernel = new this.modules.core.SharedOSKernel({
      grantSource: this.store,
      authorizer: new this.modules.core.CapabilityAuthorizer({ usageStore: this.store }),
      messageTransport: this.store,
      ...(router ? { messageRequestRouter: router } : {}),
      messageCapabilityResolver:
        new this.modules.core.RecipientScopedMessageCapabilityResolver(),
      createMessageId: (context, call) => this.requestMessageId(context, call),
      audit: this.store,
    });
    kernel.registerResourceProvider(this.fileProvider);
    for (const handler of this.fileHandlers) kernel.registerTool(handler);
    for (const handler of taskHandlers) kernel.registerTool(handler);
    return kernel;
  }

  private async execute(input: Readonly<{
    kernel: SoKernel;
    driver: SoTurnDriver & FileProviderTelemetrySourceV1;
    executionId: string;
    actorId: string;
    context: SoAccessContext;
    message: SoMessageEnvelope;
    tools: readonly SoToolDefinition[];
    signal: AbortSignal;
  }>): Promise<SoExecutionResult> {
    let eventSequence = 0;
    const runtime = new this.modules.runtime.StandardRuntime(input.driver);
    const executor = new this.modules.runtime.SharedOSExecutor(input.kernel, runtime, {
      clock: () => input.context.now,
      createId: () => stableIdV1('event', [
        'execution-event',
        input.executionId,
        eventSequence++,
      ]),
      defaultMaxSteps: this.options.maxToolCalls + 1,
      defaultMaxToolCalls: this.options.maxToolCalls,
      defaultTimeoutMs: this.options.deadlineMs,
    });
    const request: SoExecutionRequest = {
      version: '1',
      executionId: input.executionId,
      agent: { kind: 'agent', agentId: input.actorId },
      context: structuredClone(input.context),
      message: structuredClone(input.message),
      tools: input.tools.map(tool => structuredClone(tool)),
      options: {
        maxSteps: this.options.maxToolCalls + 1,
        maxToolCalls: this.options.maxToolCalls,
        timeoutMs: this.options.deadlineMs,
      },
    };
    return await executor.execute(request, { signal: input.signal });
  }

  private context(
    actorId: string,
    traceId: string,
    enabledToolNamespaces: readonly string[],
    now: string,
  ): SoAccessContext {
    return {
      namespaceId: this.options.namespaceId,
      actor: { kind: 'agent', agentId: actorId },
      authority: structuredClone(SHAREDEVAL_SERVICE_ADDRESS_V1),
      owner: structuredClone(SHAREDEVAL_SERVICE_ADDRESS_V1),
      purpose: SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
      traceId,
      enabledToolNamespaces: [...enabledToolNamespaces],
      now,
    };
  }

  private fileToolDefinitions(): SoToolDefinition[] {
    return this.fileHandlers
      .filter(handler => FILE_TOOL_NAMES.has(handler.definition.name))
      .map(handler => structuredClone(handler.definition));
  }

  private requestMessageId(context: SoAccessContext, call: SoToolCall): string {
    const recipient = parseRecipient(call.arguments['recipient']);
    return stableIdV1('message', [
      'message-request',
      this.options.namespaceId,
      context.traceId,
      call.id,
      recipient as unknown as JsonValue,
    ]);
  }

  private projectContact(
    contact: SharedOsMessageContactResultV1,
    traceId: string,
  ): NonNullable<SharedOsFileTurnResultV1['contact']> {
    if (!contact.taskId || !this.options.tasks.some(task => task.taskId === contact.taskId)) {
      throw new Error('SharedOS contact does not bind one selected task');
    }
    const responderUsage = this.responderUsageByTrace.get(traceId);
    if (contact.responderExecutionId !== undefined && responderUsage === undefined) {
      throw new Error('SharedOS responder execution lost its provider telemetry');
    }
    this.responderUsageByTrace.delete(traceId);
    return Object.freeze({
      taskId: contact.taskId,
      requestMessageId: contact.requestMessageId,
      ...(contact.replyMessageId ? { replyMessageId: contact.replyMessageId } : {}),
      ...(contact.responderExecutionId
        ? { responderExecutionId: contact.responderExecutionId }
        : {}),
      status: contact.status,
      ...(contact.response === undefined ? {} : { response: contact.response }),
      ...(contact.errorCode === undefined ? {} : { errorCode: contact.errorCode }),
      responderReads: Object.freeze(contact.responderReads.map(receipt => (
        Object.freeze(structuredClone(receipt))
      ))),
      providerUsage: cloneTelemetry(responderUsage ?? emptyTelemetry()),
    });
  }

  private async readAcceptedMessages(
    contact: SharedOsMessageContactResultV1 | null,
    traceId: string,
  ): Promise<readonly SoMessageEnvelope[]> {
    if (!contact) return Object.freeze([]);
    const request = await this.store.readMessage(contact.requestMessageId);
    if (!request || !isExactContactRequest(
      request,
      traceId,
      this.options.requester.actorId,
      this.options.responder.actorId,
    )) {
      throw new Error('SharedOS contact request lost its exact durable envelope');
    }
    const messages: SoMessageEnvelope[] = [request];
    if (contact.replyMessageId !== undefined) {
      const reply = await this.store.readMessage(contact.replyMessageId);
      if (!reply || !isExactContactReply(
        reply,
        request,
        traceId,
        this.options.requester.actorId,
        this.options.responder.actorId,
      )) {
        throw new Error('SharedOS contact reply lost its exact durable envelope');
      }
      messages.push(reply);
    }
    return immutableClone(messages);
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function openSessionAuthority(
  options: CreateSharedOsFileSessionV1Options,
  runStartedAt: string,
) {
  const manifest = buildPactPairSharedOsGrantManifestV1({
    namespaceId: options.namespaceId,
    runStartedAt,
    requesterId: options.requester.actorId,
    responderId: options.responder.actorId,
    maxTicks: options.maxTicks,
    maxToolCalls: options.maxToolCalls,
    tasks: options.tasks,
  });
  const openOptions = {
    runDirectory: options.storeRoot,
    binding: {
      apiVersion: 'sharedeval-sharedos-session-binding/v1' as const,
      runId: options.runId,
      namespaceId: options.namespaceId,
      owner: structuredClone(SHAREDEVAL_SERVICE_ADDRESS_V1),
      authority: structuredClone(SHAREDEVAL_SERVICE_ADDRESS_V1),
      purpose: SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
      startedAt: runStartedAt,
      toolSurface: 'sharedos-runtime' as const,
      responderGrantSets: manifest.responderGrantSets.map(set => ({
        taskId: set.taskId,
        grantIds: [...set.grantIds],
      })),
    },
    grants: manifest.grants,
  };
  return Object.freeze({
    manifest,
    store: await openSharedOsSessionStoreV1(openOptions),
  });
}

function validateOptions(input: CreateSharedOsFileSessionV1Options): void {
  const expectedNamespace = stableIdV1('namespace', [
    'namespace',
    input.runId,
    input.sessionIndex,
  ]);
  if (
    !IDENTIFIER_PATTERN.test(input.runId)
    || !IDENTIFIER_PATTERN.test(input.requester.actorId)
    || !IDENTIFIER_PATTERN.test(input.responder.actorId)
    || input.namespaceId !== expectedNamespace
    || !Number.isSafeInteger(input.sessionIndex)
    || input.sessionIndex < 0
    || !Number.isSafeInteger(input.maxTicks)
    || input.maxTicks <= 0
    || input.maxTicks > 10_000
    || !Number.isSafeInteger(input.maxToolCalls)
    || input.maxToolCalls < 6
    || input.maxToolCalls > 128
    || !Number.isSafeInteger(input.deadlineMs)
    || input.deadlineMs <= 0
    || input.deadlineMs > 600_000
    || input.tasks.length === 0
    || new Set(input.tasks.map(task => task.taskId)).size !== input.tasks.length
    || typeof input.storeRoot !== 'string'
    || input.storeRoot.length === 0
    || typeof input.createDriver !== 'function'
  ) {
    throw new Error('SharedOS file session options are invalid');
  }
}

function validateHeartbeat(
  input: Readonly<{
    tick: number;
    eventId: string;
    traceId: string;
    inputDigest: string;
  }>,
  options: CreateSharedOsFileSessionV1Options,
): void {
  if (
    !Number.isSafeInteger(input.tick)
    || input.tick <= 0
    || input.tick > options.maxTicks
    || !SHA256_PATTERN.test(input.inputDigest)
  ) {
    throw new Error('SharedOS heartbeat identity is invalid');
  }
  const eventId = stableIdV1('heartbeat', [
    'heartbeat',
    options.namespaceId,
    input.tick,
    input.inputDigest,
  ]);
  const traceId = stableIdV1('trace', ['trace', eventId]);
  if (input.eventId !== eventId || input.traceId !== traceId) {
    throw new Error('SharedOS heartbeat identity is invalid');
  }
}

function freezeOptions(
  input: CreateSharedOsFileSessionV1Options,
): CreateSharedOsFileSessionV1Options {
  return Object.freeze({
    ...input,
    requester: Object.freeze({ ...input.requester }),
    responder: Object.freeze({ ...input.responder }),
    tasks: Object.freeze(input.tasks.map(task => Object.freeze(structuredClone(task)))),
  });
}

function decisionFor(execution: SoExecutionResult) {
  if (execution.status !== 'succeeded') return null;
  const parsed = fileTurnDecisionV1Schema.safeParse(execution.output);
  if (!parsed.success) throw new Error('SharedOS turn returned an invalid terminal decision');
  return Object.freeze(structuredClone(parsed.data));
}

function projectReadReceipts(
  receipts: readonly SharedOsFileOperationReceiptV1[],
): readonly FileReadReceiptV1[] {
  return Object.freeze(receipts.flatMap(receipt => receipt.action === 'read'
    ? [Object.freeze({
        actorId: receipt.actorId,
        path: receipt.path,
        action: receipt.action,
        version: receipt.version,
        sha256: receipt.sha256,
        byteLength: receipt.byteLength,
      })]
    : []));
}

function cloneTelemetry(input: FileProviderTelemetryV1): FileProviderTelemetryV1 {
  return Object.freeze(structuredClone(input));
}

function emptyTelemetry(): FileProviderTelemetryV1 {
  return Object.freeze({
    requestedModel: 'not-invoked',
    resolvedModel: 'not-invoked',
    requests: [],
    totals: { requests: 0 },
  });
}

function parseRecipient(value: JsonValue | undefined): SoAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SharedOS message recipient is invalid');
  }
  const keys = Object.keys(value);
  if (value['kind'] === 'agent' && keys.length === 2 && typeof value['agentId'] === 'string') {
    return { kind: 'agent', agentId: value['agentId'] };
  }
  if (value['kind'] === 'human' && keys.length === 2 && typeof value['userId'] === 'string') {
    return { kind: 'human', userId: value['userId'] };
  }
  if (
    value['kind'] === 'group'
    && keys.length === 2
    && typeof value['conversationId'] === 'string'
  ) {
    return { kind: 'group', conversationId: value['conversationId'] };
  }
  if (
    value['kind'] === 'service'
    && keys.length === 2
    && typeof value['serviceId'] === 'string'
  ) {
    return { kind: 'service', serviceId: value['serviceId'] };
  }
  throw new Error('SharedOS message recipient is invalid');
}

function isExactContactRequest(
  envelope: SoMessageEnvelope,
  traceId: string,
  requesterActorId: string,
  responderActorId: string,
): boolean {
  return envelope.traceId === traceId
    && envelope.replyTo === undefined
    && envelope.purpose === SHAREDEVAL_PACT_PAIR_PURPOSE_V1
    && envelope.sender.kind === 'agent'
    && envelope.sender.agentId === requesterActorId
    && envelope.receiver.kind === 'agent'
    && envelope.receiver.agentId === responderActorId;
}

function isExactContactReply(
  envelope: SoMessageEnvelope,
  request: SoMessageEnvelope,
  traceId: string,
  requesterActorId: string,
  responderActorId: string,
): boolean {
  return envelope.id === stableIdV1('message', ['message-reply', request.id])
    && envelope.traceId === traceId
    && envelope.replyTo === request.id
    && envelope.purpose === SHAREDEVAL_PACT_PAIR_PURPOSE_V1
    && envelope.sender.kind === 'agent'
    && envelope.sender.agentId === responderActorId
    && envelope.receiver.kind === 'agent'
    && envelope.receiver.agentId === requesterActorId;
}

function immutableClone<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
