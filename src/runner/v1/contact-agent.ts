import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentWorkspaceFilePathV1 } from './agent-workspace.js';
import {
  InternalFileTurnDeadlineV1,
  InternalFileTurnPublicErrorV1,
  fileTurnDecisionV1Schema,
  type FileTurnDecisionV1,
  type FreshFileHarnessFactoryV1,
  type FreshFileHarnessV1,
} from './file-harness.js';
import type { FileWorkspacePortV1 } from './file-workspace.js';

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const contactInputV1Schema = z.object({
  senderId: opaqueIdSchema,
  recipientId: opaqueIdSchema,
  message: z.string().min(1).max(65_536),
  intent: z.string().min(1).max(256),
  purpose: z.string().min(1).max(256),
  traceId: opaqueIdSchema,
  deadlineMs: z.number().int().safe().positive().max(3_600_000),
}).strict();

const responderPaths = Object.freeze([
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[]);

export const CONTACT_AGENT_ERROR_CODES_V1 = Object.freeze({
  invalidRequest: 'CONTACT_INVALID_REQUEST',
  recipientUnknown: 'CONTACT_RECIPIENT_UNKNOWN',
  edgeDenied: 'CONTACT_EDGE_DENIED',
  purposeDenied: 'CONTACT_PURPOSE_DENIED',
  deadlineInvalid: 'CONTACT_DEADLINE_INVALID',
  contactBudgetExhausted: 'CONTACT_BUDGET_EXHAUSTED',
  depthBudgetExhausted: 'CONTACT_DEPTH_BUDGET_EXHAUSTED',
  toolBudgetExhausted: 'CONTACT_TOOL_BUDGET_EXHAUSTED',
  cancelled: 'CONTACT_CANCELLED',
  deadlineExceeded: 'CONTACT_DEADLINE_EXCEEDED',
  factoryFailed: 'CONTACT_FACTORY_FAILED',
  responderDenied: 'CONTACT_RESPONDER_DENIED',
  responderCancelled: 'CONTACT_RESPONDER_CANCELLED',
  recursiveContactDenied: 'CONTACT_RECURSIVE_CONTACT_DENIED',
  responderToolFailed: 'CONTACT_RESPONDER_TOOL_FAILED',
  responderParseFailed: 'CONTACT_RESPONDER_PARSE_FAILED',
  responderFailed: 'CONTACT_RESPONDER_FAILED',
  finalizeFailed: 'CONTACT_FINALIZE_FAILED',
} as const);

export interface ContactAgentPortV1 {
  contact(input: {
    senderId: string;
    recipientId: string;
    message: string;
    intent: string;
    purpose: string;
    traceId: string;
    deadlineMs: number;
  }): Promise<{
    status: 'completed' | 'denied' | 'failed' | 'cancelled';
    response?: string;
    errorCode?: string;
    recipientTraceId: string;
  }>;
}

export type ContactAuthorizationGrantV1 = Readonly<{
  senderId: string;
  recipientId: string;
  purpose: string;
}>;

export type ContactAgentBudgetsV1 = Readonly<{
  /** Total responder contacts that this port instance may start. */
  maxContacts: number;
  /** Remaining delegation edges, including the sender-to-recipient edge. */
  remainingDepth: number;
  /** Maximum file/tool steps for each fresh recipient turn. */
  maxToolSteps: number;
}>;

export type ContactAuthorizedRequestDataV1 = Readonly<{
  message: string;
  intent: string;
  purpose: string;
}>;

/**
 * Trusted host input for one responder factory. `request` is authorized but
 * remains untrusted model data: it does not select the actor, workspace,
 * files, tools, recursion, or budgets in this object.
 */
export type ContactResponderHarnessFactoryInputV1 = Readonly<{
  senderId: string;
  recipientId: string;
  recipientTraceId: string;
  request: ContactAuthorizedRequestDataV1;
  workspace: FileWorkspacePortV1;
  readablePaths: readonly AgentWorkspaceFilePathV1[];
  allowMemoryReplacement: true;
  remainingDepth: number;
}>;

export type InProcessContactAgentPortV1Options = Readonly<{
  recipients: ReadonlyMap<string, FileWorkspacePortV1>;
  grants: readonly ContactAuthorizationGrantV1[];
  budgets: ContactAgentBudgetsV1;
  /** Called only after request authorization and every pre-spend budget gate. */
  createResponderHarnessFactory: (
    input: ContactResponderHarnessFactoryInputV1,
  ) => FreshFileHarnessFactoryV1;
  /** Optional host cancellation for this bounded port instance. */
  cancellationSignal?: AbortSignal;
}>;

type ContactInputV1 = z.infer<typeof contactInputV1Schema>;
type ContactResultV1 = Awaited<ReturnType<ContactAgentPortV1['contact']>>;

/**
 * In-process reference boundary for one-hop file-driven contacts. It never
 * installs a recursive contact port in the responder. Task-specific request
 * presentation remains a separate trusted factory concern.
 */
export function createInProcessContactAgentPortV1(
  options: InProcessContactAgentPortV1Options,
): ContactAgentPortV1 {
  return new InProcessContactAgentPortV1(options);
}

class InProcessContactAgentPortV1 implements ContactAgentPortV1 {
  private readonly recipients: ReadonlyMap<string, FileWorkspacePortV1>;
  private readonly grants: readonly ContactAuthorizationGrantV1[];
  private readonly budgets: ContactAgentBudgetsV1;
  private readonly createResponderHarnessFactory:
    InProcessContactAgentPortV1Options['createResponderHarnessFactory'];
  private readonly cancellationSignal?: AbortSignal;
  private remainingContacts: number;

  constructor(options: InProcessContactAgentPortV1Options) {
    this.recipients = new Map(options.recipients);
    this.grants = options.grants.map(grant => Object.freeze({ ...grant }));
    this.budgets = Object.freeze({ ...options.budgets });
    this.createResponderHarnessFactory = options.createResponderHarnessFactory;
    this.cancellationSignal = options.cancellationSignal;
    this.remainingContacts = this.budgets.maxContacts;
  }

  async contact(input: ContactInputV1): Promise<ContactResultV1> {
    const recipientTraceId = createRecipientTraceId(
      typeof input?.traceId === 'string' ? input.traceId : '',
    );
    if (!validDeadline(input?.deadlineMs)) {
      return failed(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.deadlineInvalid);
    }
    const parsed = contactInputV1Schema.safeParse(input);
    if (!parsed.success) {
      return failed(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.invalidRequest);
    }
    const request = parsed.data;

    if (this.cancellationSignal?.aborted) {
      return cancelled(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.cancelled);
    }

    const workspace = this.recipients.get(request.recipientId);
    if (!workspace) {
      return denied(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.recipientUnknown);
    }
    const edgeAuthorized = this.grants.some(grant =>
      grant.senderId === request.senderId
      && grant.recipientId === request.recipientId);
    if (!edgeAuthorized) {
      return denied(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.edgeDenied);
    }
    const purposeAuthorized = this.grants.some(grant =>
      grant.senderId === request.senderId
      && grant.recipientId === request.recipientId
      && grant.purpose === request.purpose);
    if (!purposeAuthorized) {
      return denied(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.purposeDenied);
    }

    if (!positiveSafeInteger(this.remainingContacts)) {
      return failed(
        recipientTraceId,
        CONTACT_AGENT_ERROR_CODES_V1.contactBudgetExhausted,
      );
    }
    if (!positiveSafeInteger(this.budgets.remainingDepth)) {
      return failed(
        recipientTraceId,
        CONTACT_AGENT_ERROR_CODES_V1.depthBudgetExhausted,
      );
    }
    if (
      !positiveSafeInteger(this.budgets.maxToolSteps)
      || this.budgets.maxToolSteps > 128
    ) {
      return failed(
        recipientTraceId,
        CONTACT_AGENT_ERROR_CODES_V1.toolBudgetExhausted,
      );
    }

    const deadline = new InternalFileTurnDeadlineV1(request.deadlineMs);
    const cancelDeadline = () => deadline.close();
    this.cancellationSignal?.addEventListener('abort', cancelDeadline, {
      once: true,
    });
    let harness: FreshFileHarnessV1 | undefined;
    let result: ContactResultV1 | undefined;
    try {
      if (this.cancellationSignal?.aborted) {
        deadline.close();
        return cancelled(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.cancelled);
      }
      deadline.remainingMs();
      // Reserve synchronously so concurrent calls cannot overrun the contact
      // count while either factory or model work is pending.
      this.remainingContacts -= 1;

      const authorizedRequest = Object.freeze({
        message: request.message,
        intent: request.intent,
        purpose: request.purpose,
      });
      const factoryInput = Object.freeze({
        senderId: request.senderId,
        recipientId: request.recipientId,
        recipientTraceId,
        request: authorizedRequest,
        workspace,
        readablePaths: responderPaths,
        allowMemoryReplacement: true as const,
        remainingDepth: this.budgets.remainingDepth - 1,
      });

      try {
        const factory = this.createResponderHarnessFactory(factoryInput);
        if (typeof factory !== 'function') {
          return failed(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.factoryFailed);
        }
        harness = factory();
        if (!isFreshFileHarness(harness)) {
          return failed(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.factoryFailed);
        }
      } catch {
        return failed(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.factoryFailed);
      }

      if (this.cancellationSignal?.aborted) {
        deadline.close();
        result = cancelled(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.cancelled);
      } else {
        try {
          const remainingMs = deadline.remainingMs();
          const decision = await deadline.settle(harness.step({
            actorId: request.recipientId,
            traceId: recipientTraceId,
            deadlineMs: remainingMs,
            maxToolSteps: this.budgets.maxToolSteps,
            maxContactCalls: 0,
          }));
          deadline.remainingMs();
          const parsedDecision = fileTurnDecisionV1Schema.safeParse(decision);
          result = parsedDecision.success
            ? resultFromBoundedDecision(
              parsedDecision.data,
              this.budgets.maxToolSteps,
              recipientTraceId,
            )
            : failed(
              recipientTraceId,
              CONTACT_AGENT_ERROR_CODES_V1.responderParseFailed,
            );
        } catch (error) {
          result = resultFromStepFailure({
            error,
            deadline,
            cancellationSignal: this.cancellationSignal,
            recipientTraceId,
          });
        }
      }

      try {
        let finalization: Promise<void>;
        try {
          finalization = Promise.resolve(harness.finalize());
        } catch (error) {
          finalization = Promise.reject(error);
        }
        await deadline.settle(finalization);
        deadline.remainingMs();
      } catch (error) {
        if (this.cancellationSignal?.aborted) {
          result = cancelled(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.cancelled);
        } else if (deadline.ownsFailure(error)) {
          result = cancelled(
            recipientTraceId,
            CONTACT_AGENT_ERROR_CODES_V1.deadlineExceeded,
          );
        } else if (
          result?.errorCode !== CONTACT_AGENT_ERROR_CODES_V1.deadlineExceeded
          && result?.errorCode !== CONTACT_AGENT_ERROR_CODES_V1.cancelled
          && result?.status !== 'failed'
        ) {
          result = failed(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.finalizeFailed);
        }
      }
      return result ?? failed(
        recipientTraceId,
        CONTACT_AGENT_ERROR_CODES_V1.responderFailed,
      );
    } catch (error) {
      return resultFromStepFailure({
        error,
        deadline,
        cancellationSignal: this.cancellationSignal,
        recipientTraceId,
      });
    } finally {
      this.cancellationSignal?.removeEventListener('abort', cancelDeadline);
      deadline.close();
    }
  }
}

function resultFromBoundedDecision(
  decision: FileTurnDecisionV1,
  maxToolSteps: number,
  recipientTraceId: string,
): ContactResultV1 {
  if (decision.contactCalls !== 0) {
    return failed(
      recipientTraceId,
      CONTACT_AGENT_ERROR_CODES_V1.recursiveContactDenied,
    );
  }
  if (decision.toolSteps > maxToolSteps) {
    return failed(
      recipientTraceId,
      CONTACT_AGENT_ERROR_CODES_V1.toolBudgetExhausted,
    );
  }
  if (decision.type === 'completed') {
    return { status: 'completed', response: decision.content, recipientTraceId };
  }
  if (decision.type === 'denied') {
    return denied(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.responderDenied);
  }
  return cancelled(recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.responderCancelled);
}

function resultFromStepFailure(input: {
  error: unknown;
  deadline: InternalFileTurnDeadlineV1;
  cancellationSignal?: AbortSignal;
  recipientTraceId: string;
}): ContactResultV1 {
  if (input.cancellationSignal?.aborted) {
    return cancelled(input.recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.cancelled);
  }
  if (input.deadline.ownsFailure(input.error)) {
    return cancelled(
      input.recipientTraceId,
      CONTACT_AGENT_ERROR_CODES_V1.deadlineExceeded,
    );
  }
  if (input.error instanceof InternalFileTurnPublicErrorV1) {
    if (isResponderParseFailure(input.error.message)) {
      return failed(
        input.recipientTraceId,
        CONTACT_AGENT_ERROR_CODES_V1.responderParseFailed,
      );
    }
    if (isResponderToolFailure(input.error.message)) {
      return failed(
        input.recipientTraceId,
        CONTACT_AGENT_ERROR_CODES_V1.responderToolFailed,
      );
    }
  }
  return failed(input.recipientTraceId, CONTACT_AGENT_ERROR_CODES_V1.responderFailed);
}

function isResponderParseFailure(message: string): boolean {
  return /(?:invalid (?:JSON|response|first choice|turn decision)|malformed tool arguments|duplicate tool-call|multiple parallel tool calls|reused a prior tool-call)/i.test(
    message,
  );
}

function isResponderToolFailure(message: string): boolean {
  return /^(?:File workspace|MEMORY replacement|Agent contact|File turn (?:contact|tool-step)|File model provider (?:selected|returned invalid (?:contact_agent|files_)))/.test(
    message,
  );
}

function createRecipientTraceId(outerTraceId: string): string {
  let value: string;
  do {
    value = `contact:${randomUUID()}`;
  } while (value === outerTraceId);
  return value;
}

function validDeadline(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && typeof value === 'number'
    && value > 0
    && value <= 3_600_000;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isFreshFileHarness(value: unknown): value is FreshFileHarnessV1 {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Partial<FreshFileHarnessV1>).step === 'function'
    && typeof (value as Partial<FreshFileHarnessV1>).finalize === 'function';
}

function denied(recipientTraceId: string, errorCode: string): ContactResultV1 {
  return { status: 'denied', errorCode, recipientTraceId };
}

function failed(recipientTraceId: string, errorCode: string): ContactResultV1 {
  return { status: 'failed', errorCode, recipientTraceId };
}

function cancelled(recipientTraceId: string, errorCode: string): ContactResultV1 {
  return { status: 'cancelled', errorCode, recipientTraceId };
}
