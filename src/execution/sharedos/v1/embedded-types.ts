/**
 * Minimal structural types for the SharedOS modules the embedded adapter
 * uses. The `@sharedos/*` packages are private and unpublished, so PACT
 * cannot declare them as dependencies yet; the adapter loads a locally
 * built checkout at runtime (see load-sharedos.ts) and relies on these
 * structural views. Every value crossing the boundary is still validated
 * by SharedOS's own strict Zod schemas on its side.
 */

export type SoAddress = { readonly kind: string } & Record<string, unknown>;

export type SoProtocolError = { code: string; message?: string } & Record<string, unknown>;

export type SoToolCall = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  traceId: string;
  requestedAt: string;
};

export type SoToolResult = {
  callId: string;
  tool: string;
  status: 'succeeded' | 'denied' | 'failed';
  output?: unknown;
  error?: SoProtocolError;
  completedAt: string;
};

export type SoTurnInput =
  | { type: 'start' }
  | { type: 'tool_result'; result: SoToolResult };

export type SoTurnDecision =
  | { type: 'tool_call'; call: SoToolCall }
  | { type: 'complete'; output: unknown; metadata?: Record<string, unknown> }
  | { type: 'fail'; error: SoProtocolError };

export type SoTurnSession = {
  next(input: SoTurnInput, signal: AbortSignal): Promise<SoTurnDecision>;
  close?(outcome: string, signal: AbortSignal): void | Promise<void>;
};

/** The model-facing request; SharedOS strips grants before it reaches here. */
export type SoAgentTurnRequest = {
  context: Record<string, unknown>;
  message: Record<string, unknown>;
  tools: ReadonlyArray<{ name: string } & Record<string, unknown>>;
} & Record<string, unknown>;

export type SoTurnDriver = {
  open(request: SoAgentTurnRequest, signal: AbortSignal): Promise<SoTurnSession>;
};

export type SoExecutionEvent = {
  sequence: number;
  type: string;
  data: unknown;
  occurredAt: string;
} & Record<string, unknown>;

export type SoExecutionResult = {
  status: 'succeeded' | 'denied' | 'failed' | 'cancelled';
  executionId: string;
  traceId: string;
  events: SoExecutionEvent[];
  startedAt: string;
  completedAt: string;
  output?: unknown;
  error?: SoProtocolError;
};

export type SoKernel = {
  registerTool(handler: unknown): void;
  listTools(context: Record<string, unknown>): Promise<ReadonlyArray<{ name: string }>>;
} & Record<string, unknown>;

/** Kernel-level audit record (core AuditEvent, structurally). */
export type SoAuditEvent = {
  type: string;
  outcome: string;
  at: string;
  traceId: string;
  namespaceId: string;
  purpose: string;
  grantId?: string;
  reason?: string;
} & Record<string, unknown>;

export type SoTestKernel = {
  kernel: SoKernel;
  audit: { events: SoAuditEvent[] };
  messages: unknown;
};

export type SharedOsModulesV1 = {
  core: {
    agentExecutionCapability(agent: SoAddress, owner: SoAddress): unknown;
  } & Record<string, unknown>;
  runtime: {
    TurnExecutor: new (
      kernel: SoKernel,
      driver: SoTurnDriver,
      options?: Record<string, unknown>,
    ) => { execute(request: Record<string, unknown>): Promise<SoExecutionResult> };
  } & Record<string, unknown>;
  os: {
    createFileTools(provider: unknown): readonly unknown[];
  } & Record<string, unknown>;
  testkit: {
    createTestKernel(): SoTestKernel;
    createTestGrant(options: Record<string, unknown>): unknown;
    InMemoryResourceProvider: new (
      namespace: string,
      handler?: (operation: Record<string, unknown> & { operationId: string }) => Promise<unknown>,
    ) => unknown;
  } & Record<string, unknown>;
};
