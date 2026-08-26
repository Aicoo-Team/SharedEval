import type { JsonObject, JsonValue } from '../../../contracts/json.js';

export type SoAddress =
  | { kind: 'human'; userId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'group'; conversationId: string }
  | { kind: 'service'; serviceId: string };

export type SoExecutionStatus =
  | 'succeeded'
  | 'denied'
  | 'failed'
  | 'cancelled'
  | 'escalated';

export type SoProtocolError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
};

export type SoRuntimeVisibleContext = {
  actor: SoAddress;
  owner: SoAddress;
  namespaceId: string;
  purpose: string;
  traceId: string;
  now: string;
};

export type SoMessageProvenance = {
  source: string;
  parentIds: readonly string[];
  metadata?: JsonObject;
};

export type SoMessageEnvelope = {
  version: '1';
  id: string;
  sender: SoAddress;
  receiver: SoAddress;
  purpose: string;
  payload: JsonValue;
  traceId: string;
  replyTo?: string;
  createdAt: string;
  provenance?: SoMessageProvenance;
};

export type SoResourceRef = {
  namespace: string;
  path: string[];
  owner?: SoAddress;
};

export type SoCapabilityRequirement = {
  resource: SoResourceRef;
  action: string;
};

export type SoToolDefinition = {
  name: string;
  description: string;
  namespace: string;
  source: string;
  readWrite: 'read' | 'write';
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  requiredCapability: SoCapabilityRequirement;
};

export type SoAccessContext = {
  namespaceId: string;
  actor: SoAddress;
  authority: SoAddress;
  owner: SoAddress;
  purpose: string;
  traceId: string;
  enabledToolNamespaces: readonly string[];
  now: string;
};

export type SoCapabilityGrant = {
  id: string;
  namespaceId: string;
  subject: SoAddress;
  issuer: SoAddress;
  capabilities: readonly {
    resource: SoResourceRef;
    actions: readonly string[];
    scope: 'exact' | 'descendants';
  }[];
  constraints: {
    purposes?: readonly string[];
    notBefore?: string;
    expiresAt?: string;
    maxUses?: number;
    delegationDepth?: number;
  };
  issuedAt: string;
  revokedAt?: string;
  parentGrantId?: string;
  metadata?: JsonObject;
};

export interface SoGrantSource {
  load(context: SoAccessContext, signal: AbortSignal): Promise<readonly SoCapabilityGrant[]>;
}

export interface SoGrantUsageStore {
  getUsage(namespaceId: string, grantId: string): Promise<number>;
  tryConsume(namespaceId: string, grantId: string, maximumUses: number): Promise<boolean>;
}

export type SoAuditEvent = {
  version: '1';
  type: string;
  outcome: string;
  at: string;
  traceId: string;
  namespaceId: string;
  actor: SoAddress;
  authority: SoAddress;
  owner: SoAddress;
  purpose: string;
  resource?: SoResourceRef;
  action?: string;
  grantId?: string;
  authorityHash?: string;
  operationId?: string;
  tool?: string;
  messageId?: string;
  receiver?: SoAddress;
  reason?: string;
  metadata?: JsonObject;
};

export interface SoAuditSink {
  record(event: SoAuditEvent): Promise<void>;
}

export type SoMessageDeliveryResult =
  | { status: 'accepted' | 'delivered'; messageId: string; timestamp: string; metadata?: JsonObject }
  | { status: 'denied' | 'failed'; messageId: string; timestamp: string; error: SoProtocolError; metadata?: JsonObject };

export interface SoMessageTransport {
  deliver(
    context: SoAccessContext,
    envelope: SoMessageEnvelope,
    signal: AbortSignal,
  ): Promise<SoMessageDeliveryResult>;
}

export interface SoMessageRequestRouter {
  resolveReply(
    context: SoAccessContext,
    request: SoMessageEnvelope,
    delivery: SoMessageDeliveryResult,
    signal: AbortSignal,
  ): Promise<SoMessageEnvelope>;
}

export type SoResourceOperation = {
  operationId: string;
  context: SoAccessContext;
  resource: SoResourceRef;
  action: string;
  input?: JsonValue;
  metadata?: JsonObject;
};

export type SoResourceResult =
  | { status: 'succeeded'; operationId: string; output: JsonValue; completedAt: string; metadata?: JsonObject }
  | { status: 'denied' | 'failed'; operationId: string; error: SoProtocolError; completedAt: string; metadata?: JsonObject };

export interface SoResourceProvider {
  readonly namespace: string;
  invoke(operation: SoResourceOperation, signal: AbortSignal): Promise<SoResourceResult>;
}

export type SoToolCall = {
  id: string;
  tool: string;
  arguments: JsonObject;
  traceId: string;
  requestedAt: string;
};

export type SoToolResult = {
  callId: string;
  tool: string;
  status: 'succeeded' | 'denied' | 'failed';
  output?: JsonValue;
  error?: SoProtocolError;
  completedAt: string;
};

export type SoTurnInput =
  | { type: 'start' }
  | { type: 'tool_result'; result: SoToolResult };

export type SoTurnDecision =
  | { type: 'tool_call'; call: SoToolCall }
  | { type: 'complete'; output: JsonValue; metadata?: JsonObject }
  | { type: 'fail'; error: SoProtocolError };

export interface SoTurnDriver {
  open(
    request: {
      version: '1';
      executionId: string;
      agent: Extract<SoAddress, { kind: 'agent' }>;
      context: SoRuntimeVisibleContext;
      message: SoMessageEnvelope;
      tools: readonly SoToolDefinition[];
      state?: JsonObject;
      options?: { maxSteps?: number; maxToolCalls?: number; timeoutMs?: number };
      metadata?: JsonObject;
    },
    signal: AbortSignal,
  ): Promise<{
    next(input: SoTurnInput, signal: AbortSignal): Promise<SoTurnDecision>;
    close?(outcome: SoExecutionStatus, signal: AbortSignal): void | Promise<void>;
  }>;
}

export type SoToolHandler = {
  readonly definition: SoToolDefinition;
  readonly parseArguments: (arguments_: JsonObject) => unknown;
  readonly resolveRequirement?: (
    context: SoAccessContext,
    call: SoToolCall,
  ) => SoCapabilityRequirement;
  invoke(context: SoAccessContext, call: SoToolCall, signal: AbortSignal): Promise<SoToolResult>;
};

export type SoExecutionEvent = {
  version: '1';
  eventId: string;
  executionId: string;
  traceId: string;
  sequence: number;
  type: string;
  data: JsonValue;
  occurredAt: string;
};

export type SoExecutionResult =
  | { version: '1'; status: 'succeeded'; executionId: string; traceId: string; output: JsonValue; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string; metadata?: JsonObject }
  | { version: '1'; status: 'denied' | 'failed'; executionId: string; traceId: string; error: SoProtocolError; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string; metadata?: JsonObject }
  | { version: '1'; status: 'cancelled'; executionId: string; traceId: string; error?: SoProtocolError; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string; metadata?: JsonObject }
  | { version: '1'; status: 'escalated'; executionId: string; traceId: string; escalation: JsonObject; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string; metadata?: JsonObject };

export type SoExecutionRequest = {
  version: '1';
  executionId: string;
  agent: Extract<SoAddress, { kind: 'agent' }>;
  context: SoAccessContext;
  message: SoMessageEnvelope;
  tools: readonly SoToolDefinition[];
  options?: { maxSteps?: number; maxToolCalls?: number; timeoutMs?: number };
  state?: JsonObject;
  metadata?: JsonObject;
};

export interface SoSchema<T = unknown> {
  parse(value: unknown): T;
}

export interface SoKernel {
  registerResourceProvider(provider: SoResourceProvider): void;
  registerTool(handler: SoToolHandler): void;
  sendMessage(
    context: SoAccessContext,
    envelope: SoMessageEnvelope,
    options?: { signal?: AbortSignal },
  ): Promise<SoMessageDeliveryResult>;
}

export type SoKernelOptions = {
  grantSource: SoGrantSource;
  authorizer?: unknown;
  messageTransport?: SoMessageTransport;
  messageRequestRouter?: SoMessageRequestRouter;
  messageCapabilityResolver?: unknown;
  createMessageId?: (context: SoAccessContext, call: SoToolCall) => string;
  audit?: SoAuditSink;
};

export type SharedOsContractsModuleV1 = {
  AccessContextSchema: SoSchema<SoAccessContext>;
  CapabilityGrantSchema: SoSchema<SoCapabilityGrant>;
  ExecutionRequestSchema: SoSchema<SoExecutionRequest>;
  ExecutionResultSchema: SoSchema<SoExecutionResult>;
  MessageDeliveryResultSchema: SoSchema<SoMessageDeliveryResult>;
  MessageEnvelopeSchema: SoSchema<SoMessageEnvelope>;
  ResourceOperationSchema: SoSchema<SoResourceOperation>;
  ResourceResultSchema: SoSchema<SoResourceResult>;
  ToolCallSchema: SoSchema<SoToolCall>;
  ToolDefinitionSchema: SoSchema<SoToolDefinition>;
  ToolResultSchema: SoSchema<SoToolResult>;
};

export type SharedOsCoreModuleV1 = {
  SharedOSKernel: new (options: SoKernelOptions) => SoKernel;
  CapabilityAuthorizer: new (options?: { usageStore?: SoGrantUsageStore }) => unknown;
  RecipientScopedMessageCapabilityResolver: new (namespace?: string) => unknown;
  agentExecutionCapability: (agent: SoAddress, owner: SoAddress) => unknown;
  messageSendCapability: (receiver: SoAddress, owner: SoAddress) => unknown;
  MESSAGE_REQUEST_TOOL_DEFINITION: SoToolDefinition;
};

export type SharedOsOsModuleV1 = {
  createFileTools(provider: SoResourceProvider): readonly SoToolHandler[];
};

export type SharedOsRuntimeModuleV1 = {
  StandardRuntime: new (driver: SoTurnDriver, options?: { closeTimeoutMs?: number }) => unknown;
  SharedOSExecutor: new (
    kernel: SoKernel,
    runtime: unknown,
    options?: {
      clock?: () => string;
      createId?: () => string;
      defaultMaxSteps?: number;
      defaultMaxToolCalls?: number;
      defaultTimeoutMs?: number;
    },
  ) => {
    execute(
      input: SoExecutionRequest,
      options?: { signal?: AbortSignal; onEvent?: (event: SoExecutionEvent) => void },
    ): Promise<SoExecutionResult>;
  };
};

export type SharedOsModulesV1 = {
  contracts: SharedOsContractsModuleV1;
  core: SharedOsCoreModuleV1;
  os: SharedOsOsModuleV1;
  runtime: SharedOsRuntimeModuleV1;
};
