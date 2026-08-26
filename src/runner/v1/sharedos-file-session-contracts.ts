import type {
  SoAuditEvent,
  SoMessageEnvelope,
  SoTurnDriver,
} from '../../execution/sharedos/v1/contracts.js';
import type {
  FileProviderTelemetrySourceV1,
  FileProviderTelemetryV1,
} from './file-model-driver.js';
import type { FileTurnDecisionV1 } from './file-turn-contracts.js';
import type { FileReadReceiptV1, FileWorkspacePortV1 } from './file-workspace.js';
import type { LoadedPactPairTaskV1 } from '../../suites/pact-pair/task-loader.js';
import type { PactPairWorkspaceV1 } from '../../suites/pact-pair/workspace.js';
import type { SharedOsFileOperationReceiptV1 } from './sharedos-file-provider.js';

export const SHAREDEVAL_PACT_PAIR_PURPOSE_V1 = 'sharedeval:pact-pair' as const;
export const SHAREDEVAL_SERVICE_ADDRESS_V1 = Object.freeze({
  kind: 'service',
  serviceId: 'sharedeval',
} as const);

export const FILE_SESSION_CONTACT_ERROR_CODES_V1 = Object.freeze([
  'CONTACT_REQUESTER_FILE_READ_REQUIRED',
  'CONTACT_DUPLICATE_TASK',
  'CONTACT_RESPONDER_FILE_READ_REQUIRED',
  'CONTACT_RESPONDER_DENIED',
  'CONTACT_RESPONDER_FAILED',
  'CONTACT_CANCELLED',
] as const);

export type FileSessionContactErrorCodeV1 =
  (typeof FILE_SESSION_CONTACT_ERROR_CODES_V1)[number];

export type SharedOsFileSessionProvenanceV1 = Readonly<{
  runStartedAt: string;
  namespaceId: string;
  grantManifestDigest: string;
  sharedOsRevision: string;
  sharedOsRuntimeDigest: string;
}>;

export type SharedOsFileTurnSourceEvidenceV1 = Readonly<{
  requesterFileOperations: readonly SharedOsFileOperationReceiptV1[];
  responderFileOperations: readonly SharedOsFileOperationReceiptV1[];
  acceptedMessages: readonly SoMessageEnvelope[];
  auditEvents: readonly SoAuditEvent[];
}>;

export type SharedOsFileTurnResultV1 = Readonly<{
  executionId: string;
  traceId: string;
  executionStatus: 'succeeded' | 'denied' | 'failed' | 'cancelled' | 'escalated';
  decision: FileTurnDecisionV1 | null;
  requesterReads: readonly FileReadReceiptV1[];
  contact?: Readonly<{
    taskId: string;
    requestMessageId: string;
    replyMessageId?: string;
    responderExecutionId?: string;
    status: 'completed' | 'denied' | 'failed' | 'cancelled';
    response?: string;
    errorCode?: FileSessionContactErrorCodeV1;
    responderReads: readonly FileReadReceiptV1[];
    providerUsage: FileProviderTelemetryV1;
  }>;
  providerUsage: FileProviderTelemetryV1;
  provenance: SharedOsFileSessionProvenanceV1;
  sourceEvidence: SharedOsFileTurnSourceEvidenceV1;
  audit: Readonly<{
    firstSequence: number;
    lastSequence: number;
    sha256: string;
  }>;
}>;

export type CreateSharedOsFileSessionV1Options = Readonly<{
  runId: string;
  namespaceId: string;
  sessionIndex: number;
  maxTicks: number;
  maxToolCalls: number;
  deadlineMs: number;
  requester: Readonly<{
    actorId: string;
    workspace: FileWorkspacePortV1;
  }>;
  responder: Readonly<{
    actorId: string;
    workspace: FileWorkspacePortV1;
  }>;
  tasks: readonly LoadedPactPairTaskV1[];
  pactWorkspace: PactPairWorkspaceV1;
  storeRoot: string;
  createDriver(input: Readonly<{
    actorId: string;
    role: 'requester' | 'responder';
  }>): SoTurnDriver & FileProviderTelemetrySourceV1;
}>;

export interface SharedOsFileSessionV1 {
  readonly provenance: SharedOsFileSessionProvenanceV1;
  runRequesterTurn(input: Readonly<{
    tick: number;
    eventId: string;
    traceId: string;
    inputDigest: string;
    signal?: AbortSignal;
  }>): Promise<SharedOsFileTurnResultV1>;
  close(): Promise<void>;
}

export type SharedOsFileSessionFactoryV1 = (
  input: CreateSharedOsFileSessionV1Options,
) => Promise<SharedOsFileSessionV1>;
