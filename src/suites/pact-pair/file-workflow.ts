import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  sha256JsonV1,
  stableIdV1,
  type JsonValue,
} from '../../contracts/json.js';
import type {
  AgentWorkspaceFilePathV1,
  AgentWorkspaceTemplateV1,
} from '../../runner/v1/agent-workspace.js';
import {
  deriveFileMemoryTerminalStatusV1,
} from '../../runner/v1/file-memory.js';
import type { FileTurnDecisionV1 } from '../../runner/v1/file-turn-contracts.js';
import {
  inspectFileWorkspacePresenceV1,
  materializeFileWorkspaceV1,
  openFileWorkspaceV1,
  type FileReadReceiptV1,
  type FileWorkspaceFileSetV1,
  type FileWorkspacePortV1,
  type FileWorkspaceSnapshotV1,
} from '../../runner/v1/file-workspace.js';
import {
  fileWorkflowHostRunProvenanceV1Schema,
  fileWorkflowRunBindingV1Schema,
  fileWorkflowSelectedTaskDigestV1,
  isFileWorkflowQuarantinePayloadV1,
  type FileWorkflowContactAuthorityV1,
  type FileWorkflowHostRunProvenanceV1,
  type FileWorkflowRunBindingV1,
} from '../../runner/v1/file-workflow-artifacts.js';
import {
  openFileWorkflowLedgerV1,
  type FileWorkflowLedgerRecordV1,
  type FileWorkflowLedgerV1,
} from '../../runner/v1/file-workflow-ledger.js';
import {
  buildFileWorkflowHeartbeatPayloadV1,
  type FileWorkflowHeartbeatTerminalOutcomeV1,
} from '../../runner/v1/file-workflow-heartbeat.js';
import { runFileWorkflowHeartbeatV1 } from '../../runner/v1/file-workflow-recovery.js';
import {
  projectFileWorkflowRetainedSharedOsEvidenceV1,
  projectFileWorkflowSharedOsEvidenceV1,
  type FileWorkflowSharedOsProjectionV1,
} from '../../runner/v1/file-workflow-sharedos-evidence.js';
import type {
  CreateSharedOsFileSessionV1Options,
  FileSessionContactErrorCodeV1,
  SharedOsFileSessionFactoryV1,
  SharedOsFileTurnResultV1,
} from '../../runner/v1/sharedos-file-session-contracts.js';
import {
  loadWorkspaceRegistryV1,
  resolveAgentWorkspaceRegistryV1,
  type AgentWorkspaceRegistryReferencesV1,
  type WorkspaceRegistryV1,
} from '../../runner/v1/workspace-registry.js';
import { evaluateWithRegisteredEvaluator } from '../../evaluation/index.js';
import {
  PACT_PAIR_EVALUATION_TARGET_V1,
  type PactPairRegisteredEvaluationResultV1,
} from './evaluation.js';
import type {
  PactPairEvaluationV1,
  PactPairTerminalDecisionV1,
} from './evaluator.js';
import {
  pactPairFullEvaluationV1Schema,
  toPublicEvaluation,
  type PactPairPublicEvaluationV1,
} from './public-evaluation.js';
import type { PairDataStore } from './schemas.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';
import {
  loadCanonicalPactPairStoreV1,
  type PactPairWorkspaceV1,
} from './workspace.js';

const MAX_FILE_DRIVEN_PAIR_TICKS_V1 = 10_000;
const MAX_FILE_DRIVEN_DEADLINE_MS_V1 = 600_000;
const MIN_FILE_DRIVEN_TOOL_CALLS_V1 = 6;
const MAX_FILE_DRIVEN_TOOL_CALLS_V1 = 128;
const safeWorkspaceId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type FileDrivenPairWorkflowIdV1 = 'files-multi' | 'files-single';

export type FileDrivenPairActorV1 = Readonly<{
  actorId: string;
  references: AgentWorkspaceRegistryReferencesV1;
}>;

export type FileDrivenPairBudgetV1 = Readonly<{
  deadlineMs: number;
  maxToolCalls: number;
}>;

export type FileDrivenPairMultiTurnV1 = Readonly<{
  phase2StartTick: number;
  finalizeTick: number;
}>;

export type RunOneFileDrivenPairSessionV1Options = Readonly<{
  workflowId: FileDrivenPairWorkflowIdV1;
  runId: string;
  sessionId?: string;
  sessionIndex: number;
  workspaceRootDir: string;
  registryRootDir: string;
  registry?: WorkspaceRegistryV1;
  requester: FileDrivenPairActorV1;
  responder: FileDrivenPairActorV1;
  tasks: readonly LoadedPactPairTaskV1[];
  maxTicks: number;
  multiTurn?: FileDrivenPairMultiTurnV1;
  budget: FileDrivenPairBudgetV1;
  pactWorkspace: PactPairWorkspaceV1;
  storeRoot: string;
  createDriver: CreateSharedOsFileSessionV1Options['createDriver'];
  createSharedOsSession: SharedOsFileSessionFactoryV1;
  runProvenance: FileWorkflowHostRunProvenanceV1;
  cancellationSignal?: AbortSignal;
  materializeWorkspace?: typeof materializeFileWorkspaceV1;
  loadRegistry?: typeof loadWorkspaceRegistryV1;
  openLedger?: typeof openFileWorkflowLedgerV1;
}>;

export class FileDrivenPairSessionPreparationErrorV1 extends Error {
  constructor() {
    super('File-driven SharedOS session preparation failed');
    this.name = 'FileDrivenPairSessionPreparationErrorV1';
  }
}

export class FileDrivenPairIndeterminateExternalOperationErrorV1 extends Error {
  readonly errorCode = 'indeterminate_external_operation' as const;

  constructor() {
    super('File-driven SharedOS heartbeat has indeterminate external effects');
    this.name = 'FileDrivenPairIndeterminateExternalOperationErrorV1';
  }
}

export type FrozenInitialFileBytesV1 = Readonly<{
  path: AgentWorkspaceFilePathV1;
  sha256: string;
  byteLength: number;
  bytesBase64: string;
}>;

export type FrozenInitialWorkspaceBytesV1 = Readonly<
  Record<AgentWorkspaceFilePathV1, FrozenInitialFileBytesV1>
>;

export type FileDrivenPairTickV1 = Readonly<{
  tick: number;
  eventId: string;
  traceId: string;
  status: 'completed' | 'failed';
  executionId?: string;
  executionStatus?: SharedOsFileTurnResultV1['executionStatus'];
  decision?: FileTurnDecisionV1;
  errorCode?: 'FILE_TURN_FAILED' | 'INDETERMINATE_EXTERNAL_OPERATION';
  requesterReads: readonly FileReadReceiptV1[];
  requesterMemoryVersion?: number;
  providerUsage?: SharedOsFileTurnResultV1['providerUsage'];
  audit?: SharedOsFileTurnResultV1['audit'];
}>;

export type FileDrivenPairContactV1 = Readonly<{
  taskId: string;
  tick: number;
  status: 'completed' | 'denied' | 'failed' | 'cancelled';
  requestMessageId: string;
  replyMessageId?: string;
  responderExecutionId?: string;
  response?: string;
  errorCode?: FileSessionContactErrorCodeV1;
  responderReads: readonly FileReadReceiptV1[];
  providerUsage?: SharedOsFileTurnResultV1['providerUsage'];
  actionBefore?: PairDataStore;
  actionAfter?: PairDataStore;
}>;

export type FileDrivenPairTerminalStatusV1 =
  | 'answered'
  | 'refused'
  | 'error'
  | 'no_response'
  | 'side_effect_before_failure';

export type FileDrivenPairTaskOutcomeV1 = Readonly<{
  taskId: string;
  kind: LoadedPactPairTaskV1['kind'];
  status: FileDrivenPairTerminalStatusV1;
  terminalTick: number;
  contactStatus?: FileDrivenPairContactV1['status'];
  finalDecision?: PactPairTerminalDecisionV1;
  evaluation: PactPairEvaluationV1 | null;
  evaluationResult: PactPairRegisteredEvaluationResultV1 | null;
  publicEvaluation: PactPairPublicEvaluationV1 | null;
}>;

export type FileDrivenPairStopReasonV1 =
  | 'all_terminal'
  | 'tick_exhausted'
  | 'fatal_error';

export type FileDrivenPairSessionV1 = Readonly<{
  workflowId: FileDrivenPairWorkflowIdV1;
  runId: string;
  sessionId: string;
  selectedTaskIds: readonly string[];
  registryReferences: Readonly<{
    requester: AgentWorkspaceRegistryReferencesV1;
    responder: AgentWorkspaceRegistryReferencesV1;
  }>;
  stopReason: FileDrivenPairStopReasonV1;
  fatalErrorCode?: 'FILE_SESSION_FAILED' | 'INDETERMINATE_EXTERNAL_OPERATION';
  ticks: readonly FileDrivenPairTickV1[];
  contacts: readonly FileDrivenPairContactV1[];
  outcomes: readonly FileDrivenPairTaskOutcomeV1[];
  initial: Readonly<{
    requester: FileWorkspaceSnapshotV1['initial'];
    responder: FileWorkspaceSnapshotV1['initial'];
  }>;
  final: Readonly<{
    requester: FileWorkspaceSnapshotV1['final'];
    responder: FileWorkspaceSnapshotV1['final'];
  }>;
  initialPrivateBytes: Readonly<{
    requester: FrozenInitialWorkspaceBytesV1;
    responder: FrozenInitialWorkspaceBytesV1;
  }>;
}>;

export type PublicFileDrivenPairSessionV1 = Readonly<{
  workflowId: FileDrivenPairWorkflowIdV1;
  runId: string;
  sessionId: string;
  selectedTaskIds: readonly string[];
  registryReferences: FileDrivenPairSessionV1['registryReferences'];
  stopReason: FileDrivenPairStopReasonV1;
  fatalErrorCode?: 'FILE_SESSION_FAILED' | 'INDETERMINATE_EXTERNAL_OPERATION';
  tickCount: number;
  initial: FileDrivenPairSessionV1['initial'];
  final: FileDrivenPairSessionV1['final'];
  outcomes: readonly Readonly<{
    taskId: string;
    kind: LoadedPactPairTaskV1['kind'];
    status: FileDrivenPairTerminalStatusV1;
    terminalTick: number;
    contactStatus?: FileDrivenPairContactV1['status'];
    publicEvaluation: PactPairPublicEvaluationV1 | null;
  }>[];
}>;

/**
 * SharedEval schedules heartbeats and evaluates their durable effects. The
 * injected SharedOS session is the only component allowed to execute a turn,
 * expose or invoke tools, or send and route agent messages.
 */
export async function runOneFileDrivenPairSessionV1(
  options: RunOneFileDrivenPairSessionV1Options,
): Promise<FileDrivenPairSessionV1> {
  validateSessionOptions(options);
  const taskIds = options.tasks.map(task => task.taskId);
  const sessionId = stableIdV1('session', [
    'file-workflow-session',
    options.workflowId,
    options.runId,
    options.sessionIndex,
  ]);
  if (options.sessionId !== undefined && options.sessionId !== sessionId) {
    throw new Error('File-driven session identity must match the scheduler-derived session ID');
  }
  const initialActionSha256 = sha256JsonV1(
    loadCanonicalPactPairStoreV1() as unknown as JsonValue,
  );
  const runProvenance = fileWorkflowHostRunProvenanceV1Schema.parse(options.runProvenance);
  const registry = options.registry ?? await (options.loadRegistry ?? loadWorkspaceRegistryV1)({
    rootDir: options.registryRootDir,
  });
  const [resolvedRequester, resolvedResponder] = await Promise.all([
    resolveAgentWorkspaceRegistryV1({
      rootDir: options.registryRootDir,
      registry,
      references: options.requester.references,
      actorRole: 'requester',
      datasetId: 'pact-pair',
      workflowId: options.workflowId,
    }),
    resolveAgentWorkspaceRegistryV1({
      rootDir: options.registryRootDir,
      registry,
      references: options.responder.references,
      actorRole: 'responder',
      datasetId: 'pact-pair',
      workflowId: options.workflowId,
    }),
  ]);

  const requesterTemplate = renderRequesterTemplate(resolvedRequester.template, options.tasks);
  const responderTemplate = renderResponderTemplate(resolvedResponder.template, taskIds);
  const initialPrivateBytes = Object.freeze({
    requester: freezeTemplateBytes(requesterTemplate),
    responder: freezeTemplateBytes(responderTemplate),
  });
  const materialize = options.materializeWorkspace ?? materializeFileWorkspaceV1;
  const [requesterPresence, responderPresence] = await Promise.all([
    inspectFileWorkspacePresenceV1({
      rootDir: options.workspaceRootDir,
      runId: options.runId,
      actorId: options.requester.actorId,
    }),
    inspectFileWorkspacePresenceV1({
      rootDir: options.workspaceRootDir,
      runId: options.runId,
      actorId: options.responder.actorId,
    }),
  ]);
  const [requesterWorkspace, responderWorkspace] = await Promise.all([
    requesterPresence === 'present'
      ? openFileWorkspaceV1({
        rootDir: options.workspaceRootDir,
        runId: options.runId,
        actorId: options.requester.actorId,
        selectedTaskIds: taskIds,
      })
      : materialize({
        rootDir: options.workspaceRootDir,
        runId: options.runId,
        actorId: options.requester.actorId,
        template: requesterTemplate,
        selectedTaskIds: taskIds,
      }),
    responderPresence === 'present'
      ? openFileWorkspaceV1({
        rootDir: options.workspaceRootDir,
        runId: options.runId,
        actorId: options.responder.actorId,
        selectedTaskIds: taskIds,
      })
      : materialize({
        rootDir: options.workspaceRootDir,
        runId: options.runId,
        actorId: options.responder.actorId,
        template: responderTemplate,
        selectedTaskIds: taskIds,
      }),
  ]);
  const [requesterInitialSnapshot, responderInitialSnapshot] = await Promise.all([
    requesterWorkspace.snapshot(options.requester.actorId),
    responderWorkspace.snapshot(options.responder.actorId),
  ]);
  assertWorkspaceInitialMatchesTemplate(
    'requester',
    requesterInitialSnapshot,
    requesterTemplate,
  );
  assertWorkspaceInitialMatchesTemplate(
    'responder',
    responderInitialSnapshot,
    responderTemplate,
  );
  const initial = Object.freeze({
    requester: structuredClone(requesterInitialSnapshot.initial),
    responder: structuredClone(responderInitialSnapshot.initial),
  });
  const namespaceId = stableIdV1('namespace', [
    'namespace',
    options.runId,
    options.sessionIndex,
  ]);

  let sharedOsSession;
  try {
    sharedOsSession = await options.createSharedOsSession({
      runId: options.runId,
      namespaceId,
      sessionIndex: options.sessionIndex,
      maxTicks: options.maxTicks,
      ...(options.multiTurn ? { multiTurn: structuredClone(options.multiTurn) } : {}),
      maxToolCalls: options.budget.maxToolCalls,
      deadlineMs: options.budget.deadlineMs,
      requester: { actorId: options.requester.actorId, workspace: requesterWorkspace },
      responder: { actorId: options.responder.actorId, workspace: responderWorkspace },
      tasks: options.tasks,
      pactWorkspace: options.pactWorkspace,
      storeRoot: options.storeRoot,
      createDriver: options.createDriver,
    });
  } catch {
    throw new FileDrivenPairSessionPreparationErrorV1();
  }
  let binding: FileWorkflowRunBindingV1;
  try {
    binding = buildRunBinding({
      options,
      runProvenance,
      taskIds,
      requesterPolicySha256: requesterTemplate.files.policy.sha256,
      responderPolicy: resolvedResponder.assets.policy,
      requesterInitial: requesterInitialSnapshot.initial.files,
      responderInitial: responderInitialSnapshot.initial.files,
      sharedOs: sharedOsSession.provenance,
      namespaceId,
      sessionId,
      initialActionSha256,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await sharedOsSession.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    throw combinedFailure(failures, 'Run binding failed and SharedOS cleanup also failed');
  }

  let ledger: FileWorkflowLedgerV1;
  try {
    ledger = await (options.openLedger ?? openFileWorkflowLedgerV1)({
      runDirectory: options.storeRoot,
      binding,
      retainPrivate: true,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await sharedOsSession.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    throw combinedFailure(failures, 'Ledger open failed and SharedOS cleanup also failed');
  }

  let state: HydratedFileWorkflowStateV1 | undefined;
  let finalSnapshots: Readonly<{
    requester: FileWorkspaceSnapshotV1;
    responder: FileWorkspaceSnapshotV1;
  }> | undefined;
  const failures: unknown[] = [];
  try {
    const recovery = await ledger.inspectRecovery();
    if (recovery.kind === 'indeterminate_external_operation') {
      if (!isolatableIndeterminateSession(options)) {
        throw new FileDrivenPairIndeterminateExternalOperationErrorV1();
      }
      // files-single: the unresolved heartbeat start belongs to this session's
      // one task alone, so its unprovable external work is sealed as a typed
      // terminal error (never re-executed) instead of failing the whole run.
      await ledger.commitQuarantine();
    }
    await ledger.repairPublicProjections();
    let records = [...await ledger.readRecords()];
    state = hydrateCommittedRecords({ binding, records, tasks: options.tasks });
    if (!state.quarantined) {
      restoreCommittedPactPairState(
        options.pactWorkspace,
        state.actionSnapshots,
        binding.scheduler.initialActionSha256,
      );
      await assertCommittedWorkspaceAuthority({
        binding,
        state,
        requesterWorkspace,
        responderWorkspace,
      });
    }

    while (!state.stopReason) {
      const tick = records.length + 1;
      if (tick > options.maxTicks) {
        throw new Error('Committed heartbeat history exhausted maxTicks without terminal authority');
      }
      const [requesterBefore, responderBefore] = await Promise.all([
        requesterWorkspace.snapshot(options.requester.actorId),
        responderWorkspace.snapshot(options.responder.actorId),
      ]);
      const inputDigest = sha256JsonV1([
        'heartbeat-input',
        namespaceId,
        tick,
        requesterBefore.final as unknown as JsonValue,
        responderBefore.final as unknown as JsonValue,
        sha256JsonV1(options.pactWorkspace.snapshot() as unknown as JsonValue),
        [...state.terminalTaskIds],
      ]);
      const eventId = stableIdV1('heartbeat', [
        'heartbeat',
        namespaceId,
        tick,
        inputDigest,
      ]);
      const traceId = stableIdV1('trace', ['trace', eventId]);
      const event = {
        eventId,
        runId: options.runId,
        sessionId,
        tick,
        actorId: options.requester.actorId,
        traceId,
      } as const;
      const stateBeforeTurn = state;
      const heartbeat = await runFileWorkflowHeartbeatV1({
        ledger,
        start: { event, inputDigest },
        execute: async () => {
          const actionBefore = options.pactWorkspace.snapshot();
          const turn = await sharedOsSession.runRequesterTurn({
            tick,
            eventId,
            traceId,
            inputDigest,
            ...(options.cancellationSignal ? { signal: options.cancellationSignal } : {}),
          });
          const actionAfter = options.pactWorkspace.snapshot();
          const contactedTask = turn.contact
            ? options.tasks.find(task => task.taskId === turn.contact!.taskId)
            : undefined;
          const native = projectFileWorkflowSharedOsEvidenceV1({
            binding,
            event,
            turn,
            ...(contactedTask?.kind === 'action'
              ? { actionSnapshot: { before: actionBefore, after: actionAfter } }
              : {}),
          });
          const planned = await planCommittedHeartbeat({
            binding,
            sessionId,
            tick,
            native,
            tasks: options.tasks,
            history: stateBeforeTurn,
            maxTicks: options.maxTicks,
          });
          return buildFileWorkflowHeartbeatPayloadV1({
            binding,
            sessionId,
            heartbeat: { eventId, tick, traceId, inputDigest },
            native,
            history: {
              terminalTaskIds: stateBeforeTurn.terminalTaskIds,
              contacts: stateBeforeTurn.contactAuthorities,
            },
            terminalOutcomes: planned.terminalOutcomes,
            ...(planned.stopReason ? { sessionStopReason: planned.stopReason } : {}),
          });
        },
      });
      if (heartbeat.kind === 'indeterminate_external_operation') {
        if (!isolatableIndeterminateSession(options)) {
          throw new FileDrivenPairIndeterminateExternalOperationErrorV1();
        }
        // The turn died without provable external effects. Seal this single
        // task as a typed terminal error; the started heartbeat is never
        // re-executed, and the batch scheduler keeps its other tasks alive.
        const sealed = await ledger.commitQuarantine();
        records = [...records, sealed.record];
        state = hydrateCommittedRecords({ binding, records, tasks: options.tasks });
        continue;
      }
      const existing = records[heartbeat.record.sequence];
      if (existing) {
        if (!isDeepStrictEqual(existing, heartbeat.record)) {
          throw new Error('Heartbeat replay conflicts with committed record authority');
        }
      } else if (heartbeat.record.sequence === records.length) {
        records = [...records, heartbeat.record];
      } else {
        throw new Error('Committed heartbeat record sequence is non-contiguous');
      }
      state = hydrateCommittedRecords({ binding, records, tasks: options.tasks });
      restoreCommittedPactPairState(
        options.pactWorkspace,
        state.actionSnapshots,
        binding.scheduler.initialActionSha256,
      );
      await assertCommittedWorkspaceAuthority({
        binding,
        state,
        requesterWorkspace,
        responderWorkspace,
      });
    }

    const [requesterFinal, responderFinal] = await Promise.all([
      requesterWorkspace.snapshot(options.requester.actorId),
      responderWorkspace.snapshot(options.responder.actorId),
    ]);
    finalSnapshots = { requester: requesterFinal, responder: responderFinal };
  } catch (error) {
    failures.push(error);
  }

  try {
    await sharedOsSession.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0 && state?.stopReason && finalSnapshots) {
    try {
      await ledger.finalize({
        stopReason: state.stopReason,
        // A quarantined session may hold unproven workspace writes from the
        // lost turn; the durable final authority records the last committed
        // state instead of claiming those bytes.
        finalFiles: state.quarantined
          ? {
            requester: structuredClone(state.expectedWorkspace.requester.files),
            responder: structuredClone(state.expectedWorkspace.responder.files),
          }
          : {
            requester: bindingFileSet(finalSnapshots.requester.final.files),
            responder: bindingFileSet(finalSnapshots.responder.final.files),
          },
      });
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await ledger.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw combinedFailure(failures, 'File-driven session lifecycle failed');
  }
  if (!state?.stopReason || !finalSnapshots) {
    throw new Error('File-driven session closed without terminal committed authority');
  }

  return deepFreeze(structuredClone({
    workflowId: options.workflowId,
    runId: options.runId,
    sessionId,
    selectedTaskIds: taskIds,
    registryReferences: {
      requester: options.requester.references,
      responder: options.responder.references,
    },
    stopReason: state.stopReason,
    ...(state.stopReason === 'fatal_error'
      ? {
        fatalErrorCode: state.quarantined
          ? 'INDETERMINATE_EXTERNAL_OPERATION' as const
          : 'FILE_SESSION_FAILED' as const,
      }
      : {}),
    ticks: state.ticks,
    contacts: state.contacts,
    outcomes: state.outcomes,
    initial,
    final: {
      requester: finalSnapshots.requester.final,
      responder: finalSnapshots.responder.final,
    },
    initialPrivateBytes,
  }));
}

export function toPublicFileDrivenPairSessionV1(
  session: FileDrivenPairSessionV1,
): PublicFileDrivenPairSessionV1 {
  return {
    workflowId: session.workflowId,
    runId: session.runId,
    sessionId: session.sessionId,
    selectedTaskIds: [...session.selectedTaskIds],
    registryReferences: structuredClone(session.registryReferences),
    stopReason: session.stopReason,
    ...(session.fatalErrorCode ? { fatalErrorCode: session.fatalErrorCode } : {}),
    tickCount: session.ticks.length,
    initial: structuredClone(session.initial),
    final: structuredClone(session.final),
    outcomes: session.outcomes.map(outcome => ({
      taskId: outcome.taskId,
      kind: outcome.kind,
      status: outcome.status,
      terminalTick: outcome.terminalTick,
      ...(outcome.contactStatus ? { contactStatus: outcome.contactStatus } : {}),
      publicEvaluation: outcome.publicEvaluation === null
        ? null
        : structuredClone(outcome.publicEvaluation),
    })),
  };
}

export function renderRequesterPolicyV1(tasks: readonly LoadedPactPairTaskV1[]): string {
  if (tasks.length === 0) throw new Error('Requester policy requires at least one public task');
  const lines = tasks.map((task, index) => (
    `${index + 1}. ${JSON.stringify(structuredClone(task.publicTask))}`
  ));
  return ['# Ordered Public Task Queue', '', ...lines, ''].join('\n');
}

export function renderInitialFileMemoryV1(taskIds: readonly string[]): string {
  if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) {
    throw new Error('Initial file memory requires unique selected task IDs');
  }
  return `${taskIds.map(taskId => `${taskId} [pending] — `).join('\n')}\n`;
}

function renderRequesterTemplate(
  template: AgentWorkspaceTemplateV1,
  tasks: readonly LoadedPactPairTaskV1[],
): AgentWorkspaceTemplateV1 {
  return replaceTemplateFiles(template, {
    'POLICY.md': renderRequesterPolicyV1(tasks),
    'MEMORY.md': renderInitialFileMemoryV1(tasks.map(task => task.taskId)),
  });
}

function renderResponderTemplate(
  template: AgentWorkspaceTemplateV1,
  taskIds: readonly string[],
): AgentWorkspaceTemplateV1 {
  return replaceTemplateFiles(template, { 'MEMORY.md': renderInitialFileMemoryV1(taskIds) });
}

function replaceTemplateFiles(
  template: AgentWorkspaceTemplateV1,
  replacements: Partial<Record<AgentWorkspaceFilePathV1, string>>,
): AgentWorkspaceTemplateV1 {
  const replace = <
    Path extends AgentWorkspaceFilePathV1,
    Access extends 'read_only' | 'read_write',
  >(file: { path: Path; access: Access; content: string; sha256: string }) => {
    const content = replacements[file.path] ?? file.content;
    return { ...file, content, sha256: sha256(content) };
  };
  return {
    apiVersion: template.apiVersion,
    kind: template.kind,
    files: {
      agent: replace(template.files.agent),
      heartbeat: replace(template.files.heartbeat),
      policy: replace(template.files.policy),
      memory: replace(template.files.memory),
    },
  };
}

function freezeTemplateBytes(template: AgentWorkspaceTemplateV1): FrozenInitialWorkspaceBytesV1 {
  const byPath = Object.fromEntries(Object.values(template.files).map(file => {
    const bytes = Buffer.from(file.content, 'utf8');
    return [file.path, Object.freeze({
      path: file.path,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      bytesBase64: bytes.toString('base64'),
    })];
  })) as Record<AgentWorkspaceFilePathV1, FrozenInitialFileBytesV1>;
  return Object.freeze(byPath);
}

function assertWorkspaceInitialMatchesTemplate(
  role: 'requester' | 'responder',
  snapshot: FileWorkspaceSnapshotV1,
  template: AgentWorkspaceTemplateV1,
): void {
  const templateByPath = {
    'AGENT.md': template.files.agent,
    'HEARTBEAT.md': template.files.heartbeat,
    'POLICY.md': template.files.policy,
    'MEMORY.md': template.files.memory,
  } as const;
  if (snapshot.initial.version !== 0) {
    throw new Error(`${role} initial workspace version conflicts with its resolved template`);
  }
  for (const path of Object.keys(templateByPath) as AgentWorkspaceFilePathV1[]) {
    const expected = templateByPath[path];
    const actual = snapshot.initial.files[path];
    if (
      actual.path !== path
      || actual.sha256 !== expected.sha256
      || actual.byteLength !== Buffer.byteLength(expected.content)
    ) {
      throw new Error(
        `${role} initial workspace ${path} conflicts with the newly resolved template`,
      );
    }
  }
}

type CommittedActionSnapshotV1 = Readonly<{
  taskId: string;
  contactId: string;
  actorId: string;
  eventId: string;
  before: PairDataStore;
  after: PairDataStore;
}>;

type ExpectedWorkspaceAuthorityV1 = Readonly<{
  version: number;
  files: FileWorkflowRunBindingV1['actors']['requester']['initial'];
}>;

type HydratedFileWorkflowStateV1 = Readonly<{
  ticks: readonly FileDrivenPairTickV1[];
  contacts: readonly FileDrivenPairContactV1[];
  outcomes: readonly FileDrivenPairTaskOutcomeV1[];
  terminalTaskIds: readonly string[];
  contactAuthorities: readonly FileWorkflowContactAuthorityV1[];
  actionSnapshots: readonly CommittedActionSnapshotV1[];
  expectedWorkspace: Readonly<{
    requester: ExpectedWorkspaceAuthorityV1;
    responder: ExpectedWorkspaceAuthorityV1;
  }>;
  /** True when the history ends in a committed quarantine record. */
  quarantined: boolean;
  stopReason?: FileDrivenPairStopReasonV1;
}>;

function buildRunBinding(input: {
  options: RunOneFileDrivenPairSessionV1Options;
  runProvenance: FileWorkflowHostRunProvenanceV1;
  taskIds: readonly string[];
  requesterPolicySha256: string;
  responderPolicy: Readonly<{
    asset: Readonly<{ id: string; version: string }>;
    sha256: string;
  }>;
  requesterInitial: FileWorkspaceFileSetV1;
  responderInitial: FileWorkspaceFileSetV1;
  sharedOs: SharedOsFileTurnResultV1['provenance'];
  namespaceId: string;
  sessionId: string;
  initialActionSha256: string;
}): FileWorkflowRunBindingV1 {
  if (input.sharedOs.namespaceId !== input.namespaceId) {
    throw new Error('SharedOS session provenance conflicts with its scheduler namespace');
  }
  return deepFreeze(fileWorkflowRunBindingV1Schema.parse({
    apiVersion: 'sharedeval-file-run-binding/v1',
    workflowId: input.options.workflowId,
    runId: input.options.runId,
    selectedTaskIds: [...input.taskIds],
    selectedTasks: input.options.tasks.map(task => ({ taskId: task.taskId, kind: task.kind })),
    selectedTaskDigest: fileWorkflowSelectedTaskDigestV1(input.taskIds),
    scheduler: {
      sessionId: input.sessionId,
      sessionIndex: input.options.sessionIndex,
      maxTicks: input.options.maxTicks,
      budget: structuredClone(input.options.budget),
      initialActionSha256: input.initialActionSha256,
      ...(input.options.multiTurn
        ? { multiTurn: structuredClone(input.options.multiTurn) }
        : {}),
    },
    dataset: structuredClone(input.runProvenance.dataset),
    goldSet: structuredClone(input.runProvenance.goldSet),
    policies: {
      requester: {
        id: 'sharedeval/scheduler/ordered-public-task-queue',
        version: '1.0.0',
        sha256: input.requesterPolicySha256,
      },
      responder: {
        id: input.responderPolicy.asset.id,
        version: input.responderPolicy.asset.version,
        sha256: input.responderPolicy.sha256,
      },
    },
    actors: {
      requester: {
        actorId: input.options.requester.actorId,
        references: structuredClone(input.options.requester.references),
        model: structuredClone(input.runProvenance.models.requester),
        initial: bindingFileSet(input.requesterInitial),
      },
      responder: {
        actorId: input.options.responder.actorId,
        references: structuredClone(input.options.responder.references),
        model: structuredClone(input.runProvenance.models.responder),
        initial: bindingFileSet(input.responderInitial),
      },
    },
    backend: structuredClone(input.runProvenance.backend),
    sharedOs: structuredClone(input.sharedOs),
  }));
}

function hydrateCommittedRecords(input: {
  binding: FileWorkflowRunBindingV1;
  records: readonly FileWorkflowLedgerRecordV1[];
  tasks: readonly LoadedPactPairTaskV1[];
}): HydratedFileWorkflowStateV1 {
  const ticks: FileDrivenPairTickV1[] = [];
  const contacts: FileDrivenPairContactV1[] = [];
  const outcomes = new Map<string, FileDrivenPairTaskOutcomeV1>();
  const contactsById = new Map<string, FileDrivenPairContactV1>();
  const contactAuthorities: FileWorkflowContactAuthorityV1[] = [];
  const actionSnapshots: CommittedActionSnapshotV1[] = [];
  const expected = {
    requester: {
      version: 0,
      files: structuredClone(input.binding.actors.requester.initial),
    },
    responder: {
      version: 0,
      files: structuredClone(input.binding.actors.responder.initial),
    },
  };
  let stopReason: FileDrivenPairStopReasonV1 | undefined;
  let quarantined = false;

  for (const [index, record] of input.records.entries()) {
    if (record.sequence !== index || record.payload.event.tick !== index + 1) {
      throw new Error('Committed heartbeat history is not scheduler-contiguous');
    }
    if (isFileWorkflowQuarantinePayloadV1(record.payload)) {
      // The quarantine record proves only that the turn's external effects
      // are unprovable: no contact, MEMORY, or workspace authority to apply.
      quarantined = true;
      ticks.push(Object.freeze({
        tick: record.payload.event.tick,
        eventId: record.payload.event.eventId,
        traceId: record.payload.event.traceId,
        status: 'failed' as const,
        errorCode: record.payload.quarantine.errorCode,
        requesterReads: Object.freeze([]),
      }));
      for (const transition of record.payload.transitions) {
        if (outcomes.has(transition.taskId)) {
          throw new Error('Committed heartbeat history repeats terminal task authority');
        }
        const task = input.tasks.find(candidate => candidate.taskId === transition.taskId);
        if (!task) throw new Error('Committed terminal authority is outside selected tasks');
        outcomes.set(transition.taskId, Object.freeze({
          taskId: transition.taskId,
          kind: transition.result.kind,
          status: transition.result.status,
          terminalTick: transition.result.terminalTick,
          evaluation: null,
          evaluationResult: null,
          publicEvaluation: null,
        }));
      }
      stopReason = record.payload.sessionStopReason;
      continue;
    }
    const evidence = record.payload.privateEvidence;
    if (!evidence) throw new Error('Recoverable scheduler records require retained private evidence');
    const { fullEvaluations, ...retainedEvidence } = evidence;
    const native = projectFileWorkflowRetainedSharedOsEvidenceV1({
      binding: input.binding,
      event: record.payload.event,
      retainedEvidence,
      sharedOsAuthority: record.payload.sharedOsAuthority,
      ...(record.payload.contactAuthority
        ? { contactAuthority: record.payload.contactAuthority }
        : {}),
    });
    applyMemoryAuthority(expected, native, input.binding);
    const contact = contactFromCommittedProjection(record, native);
    if (contact) {
      contacts.push(contact);
      contactsById.set(contact.requestMessageId, contact);
      contactAuthorities.push(structuredClone(record.payload.contactAuthority!));
    }
    actionSnapshots.push(...retainedEvidence.actionSnapshots.map(row => structuredClone(row)));

    const requesterMemory = native.memoryAuthorities.find(row => (
      row.actorId === input.binding.actors.requester.actorId
    ));
    const decision = retainedEvidence.tickDecisions[0];
    const failed = retainedEvidence.requesterExecutionStatus !== 'succeeded'
      || decision?.type === 'cancelled';
    ticks.push(Object.freeze({
      tick: record.payload.event.tick,
      eventId: record.payload.event.eventId,
      traceId: record.payload.event.traceId,
      status: failed ? 'failed' as const : 'completed' as const,
      executionId: native.sharedOsAuthority.requesterExecutionId,
      executionStatus: retainedEvidence.requesterExecutionStatus,
      ...(decision ? { decision: structuredClone(decision) } : {}),
      ...(failed ? { errorCode: 'FILE_TURN_FAILED' as const } : {}),
      requesterReads: cloneReceipts(native.fileReads.filter(row => (
        row.actorId === input.binding.actors.requester.actorId
      ))),
      ...(requesterMemory ? { requesterMemoryVersion: requesterMemory.newVersion } : {}),
      providerUsage: structuredClone(retainedEvidence.providerTelemetry.requester),
      audit: structuredClone(native.sharedOsAuthority.audit),
    }));

    for (const transition of record.payload.transitions) {
      if (outcomes.has(transition.taskId)) {
        throw new Error('Committed heartbeat history repeats terminal task authority');
      }
      const task = input.tasks.find(candidate => candidate.taskId === transition.taskId);
      if (!task) throw new Error('Committed terminal authority is outside selected tasks');
      const contactForOutcome = transition.contactId
        ? contactsById.get(transition.contactId)
        : undefined;
      const full = fullEvaluations.find(row => row.taskId === transition.taskId);
      const evaluation = full ? normalizeCommittedEvaluation(full.evaluation) : null;
      const evaluationResult = full
        ? { details: structuredClone(evaluation!), metrics: structuredClone(full.metrics) }
        : null;
      const decisionForOutcome = terminalDecision(transition.result.status, contactForOutcome);
      outcomes.set(transition.taskId, Object.freeze({
        taskId: transition.taskId,
        kind: transition.result.kind,
        status: transition.result.status,
        terminalTick: transition.result.terminalTick,
        ...(transition.result.contactStatus
          ? { contactStatus: transition.result.contactStatus }
          : {}),
        ...(decisionForOutcome ? { finalDecision: decisionForOutcome } : {}),
        evaluation: evaluation === null ? null : structuredClone(evaluation),
        evaluationResult,
        publicEvaluation: transition.result.publicEvaluation === null
          ? null
          : structuredClone(transition.result.publicEvaluation),
      }));
    }
    if (record.payload.sessionStopReason) stopReason = record.payload.sessionStopReason;
  }
  const terminalTaskIds = input.binding.selectedTaskIds.filter(taskId => outcomes.has(taskId));
  return deepFreeze({
    ticks,
    contacts,
    outcomes: input.binding.selectedTaskIds.flatMap(taskId => {
      const outcome = outcomes.get(taskId);
      return outcome ? [outcome] : [];
    }),
    terminalTaskIds,
    contactAuthorities,
    actionSnapshots,
    expectedWorkspace: expected,
    quarantined,
    ...(stopReason ? { stopReason } : {}),
  });
}

function contactFromCommittedProjection(
  record: FileWorkflowLedgerRecordV1,
  native: FileWorkflowSharedOsProjectionV1,
): FileDrivenPairContactV1 | undefined {
  const authority = native.currentContact?.authority;
  if (!authority) return undefined;
  const evidence = record.payload.privateEvidence!;
  const snapshot = evidence.actionSnapshots.find(row => row.contactId === authority.contactId);
  const responderUsage = evidence.providerTelemetry.responder;
  return Object.freeze({
    taskId: authority.taskId,
    tick: record.payload.event.tick,
    status: authority.status,
    requestMessageId: authority.contactId,
    ...(authority.replyMessageId ? { replyMessageId: authority.replyMessageId } : {}),
    ...(authority.responderExecutionId
      ? { responderExecutionId: authority.responderExecutionId }
      : {}),
    ...(native.currentContact?.response === undefined
      ? {}
      : { response: native.currentContact.response }),
    ...(authority.errorCode ? { errorCode: authority.errorCode } : {}),
    responderReads: cloneReceipts(native.fileReads.filter(row => (
      row.actorId === authority.recipientId
    ))),
    ...(responderUsage ? { providerUsage: structuredClone(responderUsage) } : {}),
    ...(snapshot
      ? {
        actionBefore: structuredClone(snapshot.before),
        actionAfter: structuredClone(snapshot.after),
      }
      : {}),
  });
}

function applyMemoryAuthority(
  expected: {
    requester: { version: number; files: FileWorkflowRunBindingV1['actors']['requester']['initial'] };
    responder: { version: number; files: FileWorkflowRunBindingV1['actors']['requester']['initial'] };
  },
  native: FileWorkflowSharedOsProjectionV1,
  binding: FileWorkflowRunBindingV1,
): void {
  for (const authority of native.memoryAuthorities) {
    const role = authority.actorId === binding.actors.requester.actorId
      ? 'requester'
      : authority.actorId === binding.actors.responder.actorId
        ? 'responder'
        : undefined;
    if (!role) throw new Error('Committed MEMORY authority has a foreign actor');
    const current = expected[role];
    if (
      authority.previousVersion !== current.version
      || authority.previousSha256 !== current.files['MEMORY.md'].sha256
      || authority.newVersion !== current.version + 1
    ) {
      throw new Error('Committed MEMORY authority is not linear with scheduler state');
    }
    current.version = authority.newVersion;
    const transition = native.memoryTransitions.find(row => (
      row.actorId === authority.actorId && row.newVersion === authority.newVersion
    ));
    if (!transition) throw new Error('Committed MEMORY authority lacks its transition receipt');
    current.files['MEMORY.md'] = {
      path: 'MEMORY.md',
      sha256: authority.newSha256,
      byteLength: transition.byteLength,
    };
  }
}

async function planCommittedHeartbeat(input: {
  binding: FileWorkflowRunBindingV1;
  sessionId: string;
  tick: number;
  native: FileWorkflowSharedOsProjectionV1;
  tasks: readonly LoadedPactPairTaskV1[];
  history: HydratedFileWorkflowStateV1;
  maxTicks: number;
}): Promise<Readonly<{
  terminalOutcomes: readonly FileWorkflowHeartbeatTerminalOutcomeV1[];
  stopReason?: FileDrivenPairStopReasonV1;
}>> {
  const existing = new Set(input.history.terminalTaskIds);
  const contacts = new Map(input.history.contacts.map(row => [row.taskId, row]));
  const current = contactFromLiveProjection(input.native, input.tick);
  if (current) contacts.set(current.taskId, current);
  // Fallback terminals must honor every committed contact, not only a task's
  // latest: under the multi-turn gate a later no-op retry cannot hide an
  // earlier proven action-state change.
  const contactRows = [...input.history.contacts, ...(current ? [current] : [])];
  const anyStateChangedFor = (taskId: string): boolean => contactRows.some(row => (
    row.taskId === taskId
    && row.actionBefore !== undefined
    && row.actionAfter !== undefined
    && !isDeepStrictEqual(row.actionBefore, row.actionAfter)
  ));
  const requesterMemory = input.native.memoryAuthorities.find(row => (
    row.actorId === input.binding.actors.requester.actorId
  ));
  const deltas = new Map(requesterMemory?.newRows.flatMap((row, index) => (
    requesterMemory.previousRows[index]?.status === 'pending' && row.status !== 'pending'
      ? [[row.taskId, row.status] as const]
      : []
  )) ?? []);
  const planned = new Map<string, FileWorkflowHeartbeatTerminalOutcomeV1>();
  const cancelled = input.native.retainedEvidence.tickDecisions[0]?.type === 'cancelled';
  const failed = input.native.sharedOsAuthority.requesterExecutionStatus !== 'succeeded';
  // Under the multi-turn gate a plainly failed turn (provider/driver failure,
  // never a cancellation) is committable as one lost tick instead of ending the
  // whole trajectory — but only when the turn left no terminal MEMORY flip: a
  // flip could not be terminalized against a failed execution, so fail-closed
  // stays in force for that shape.
  const survivableFailure = failed
    && !cancelled
    && input.binding.scheduler.multiTurn !== undefined
    && deltas.size === 0;
  const fatal = (failed || cancelled) && !survivableFailure;

  for (const task of input.tasks) {
    if (existing.has(task.taskId)) continue;
    const memoryStatus = deltas.get(task.taskId);
    const contact = contacts.get(task.taskId);
    if (!memoryStatus || !contact) continue;
    const state = actionStateFromContact(task, contact);
    const status = deriveFileMemoryTerminalStatusV1({
      memoryStatus,
      contactStatus: contact.status,
      stateChanged: hasStateChanged(state),
    });
    if (!status) continue;
    planned.set(task.taskId, await heartbeatTerminalOutcome({ task, status, contact, state }));
  }

  const remainingAfterMemory = input.tasks.filter(task => (
    !existing.has(task.taskId) && !planned.has(task.taskId)
  ));
  let stopReason: FileDrivenPairStopReasonV1 | undefined;
  const completeAfterMemory = existing.size + planned.size === input.tasks.length;
  const fallbackChanged = (task: LoadedPactPairTaskV1): boolean => (
    input.binding.scheduler.multiTurn
      ? anyStateChangedFor(task.taskId)
      : hasStateChanged(actionStateFromContact(task, contacts.get(task.taskId)))
  );
  if (fatal) {
    for (const task of remainingAfterMemory) {
      const contact = contacts.get(task.taskId);
      const state = actionStateFromContact(task, contact);
      const status = fallbackChanged(task) ? 'side_effect_before_failure' : 'error';
      planned.set(task.taskId, await heartbeatTerminalOutcome({ task, status, contact, state }));
    }
    stopReason = 'fatal_error';
  } else if (completeAfterMemory) {
    stopReason = 'all_terminal';
  } else if (input.tick === input.maxTicks) {
    for (const task of remainingAfterMemory) {
      const contact = contacts.get(task.taskId);
      const state = actionStateFromContact(task, contact);
      const status = fallbackChanged(task) ? 'side_effect_before_failure' : 'no_response';
      planned.set(task.taskId, await heartbeatTerminalOutcome({ task, status, contact, state }));
    }
    stopReason = 'tick_exhausted';
  }
  return {
    terminalOutcomes: input.tasks.flatMap(task => {
      const outcome = planned.get(task.taskId);
      return outcome ? [outcome] : [];
    }),
    ...(stopReason ? { stopReason } : {}),
  };
}

function contactFromLiveProjection(
  native: FileWorkflowSharedOsProjectionV1,
  tick: number,
): FileDrivenPairContactV1 | undefined {
  const authority = native.currentContact?.authority;
  if (!authority) return undefined;
  const snapshot = native.retainedEvidence.actionSnapshots[0];
  const responderUsage = native.retainedEvidence.providerTelemetry.responder;
  return {
    taskId: authority.taskId,
    tick,
    status: authority.status,
    requestMessageId: authority.contactId,
    ...(authority.replyMessageId ? { replyMessageId: authority.replyMessageId } : {}),
    ...(authority.responderExecutionId
      ? { responderExecutionId: authority.responderExecutionId }
      : {}),
    ...(native.currentContact?.response === undefined
      ? {}
      : { response: native.currentContact.response }),
    ...(authority.errorCode ? { errorCode: authority.errorCode } : {}),
    responderReads: cloneReceipts(native.fileReads.filter(row => (
      row.actorId === authority.recipientId
    ))),
    ...(responderUsage ? { providerUsage: structuredClone(responderUsage) } : {}),
    ...(snapshot
      ? { actionBefore: snapshot.before, actionAfter: snapshot.after }
      : {}),
  };
}

async function heartbeatTerminalOutcome(input: {
  task: LoadedPactPairTaskV1;
  status: FileDrivenPairTerminalStatusV1;
  contact?: FileDrivenPairContactV1;
  state?: { before: PairDataStore; after: PairDataStore };
}): Promise<FileWorkflowHeartbeatTerminalOutcomeV1> {
  const evaluated = await evaluateOutcome({
    task: input.task,
    status: input.status,
    terminalTick: 0,
    ...(input.contact ? { contact: input.contact } : {}),
    ...(input.state ? { state: input.state } : {}),
  });
  const requiresError = input.status === 'error' || input.status === 'side_effect_before_failure';
  return {
    taskId: input.task.taskId,
    status: input.status,
    ...(input.contact ? { contactId: input.contact.requestMessageId } : {}),
    ...(requiresError
      ? { errorCode: input.contact?.errorCode ?? 'FILE_SESSION_FAILED' }
      : {}),
    fullEvaluation: evaluated.evaluation,
  };
}

/**
 * Only a files-single session may contain an indeterminate heartbeat as one
 * task's typed terminal error: its session holds exactly one task with its
 * own ledger and PACT workspace, so nothing else can be tainted. files-multi
 * shares both across tasks and keeps the run-level fail-closed stop.
 */
function isolatableIndeterminateSession(
  options: RunOneFileDrivenPairSessionV1Options,
): boolean {
  return options.workflowId === 'files-single' && options.tasks.length === 1;
}

async function assertCommittedWorkspaceAuthority(input: {
  binding: FileWorkflowRunBindingV1;
  state: HydratedFileWorkflowStateV1;
  requesterWorkspace: FileWorkspacePortV1;
  responderWorkspace: FileWorkspacePortV1;
}): Promise<void> {
  const [requester, responder] = await Promise.all([
    input.requesterWorkspace.snapshot(input.binding.actors.requester.actorId),
    input.responderWorkspace.snapshot(input.binding.actors.responder.actorId),
  ]);
  for (const [role, snapshot] of [
    ['requester', requester],
    ['responder', responder],
  ] as const) {
    const actor = input.binding.actors[role];
    if (!isDeepStrictEqual(snapshot.initial, { version: 0, files: actor.initial })) {
      throw new Error(`Committed ${role} workspace initial authority conflicts with run binding`);
    }
    if (!isDeepStrictEqual(snapshot.final, input.state.expectedWorkspace[role])) {
      throw new Error(`Committed ${role} workspace is ahead of or behind ledger authority`);
    }
  }
}

function restoreCommittedPactPairState(
  workspace: PactPairWorkspaceV1,
  snapshots: readonly CommittedActionSnapshotV1[],
  initialActionSha256: string,
): void {
  const initialBoundary = snapshots[0]?.before ?? workspace.snapshot();
  if (sha256JsonV1(initialBoundary as unknown as JsonValue) !== initialActionSha256) {
    throw new Error('PACT action initial state conflicts with the bound scheduler authority');
  }
  if (snapshots.length === 0) return;
  for (let index = 1; index < snapshots.length; index += 1) {
    if (!isDeepStrictEqual(snapshots[index - 1]!.after, snapshots[index]!.before)) {
      throw new Error('Committed action snapshot history is not linear');
    }
  }
  const current = workspace.snapshot();
  const boundaries = [snapshots[0]!.before, ...snapshots.map(row => row.after)];
  if (!boundaries.some(boundary => isDeepStrictEqual(boundary, current))) {
    throw new Error('PACT action workspace conflicts with committed snapshot authority');
  }
  workspace.restore(snapshots.at(-1)!.after);
}

function bindingFileSet(
  files: FileWorkspaceFileSetV1,
): FileWorkflowRunBindingV1['actors']['requester']['initial'] {
  return {
    'AGENT.md': { ...files['AGENT.md'], path: 'AGENT.md' },
    'HEARTBEAT.md': { ...files['HEARTBEAT.md'], path: 'HEARTBEAT.md' },
    'POLICY.md': { ...files['POLICY.md'], path: 'POLICY.md' },
    'MEMORY.md': { ...files['MEMORY.md'], path: 'MEMORY.md' },
  };
}

function cloneReceipts(receipts: readonly FileReadReceiptV1[]): readonly FileReadReceiptV1[] {
  return Object.freeze(receipts.map(receipt => Object.freeze(structuredClone(receipt))));
}

function normalizeCommittedEvaluation(value: unknown): PactPairEvaluationV1 {
  const evaluation = pactPairFullEvaluationV1Schema.parse(value);
  if (evaluation.kind === 'qa') return evaluation;
  const goldCheckType = (() => {
    switch (evaluation.goldCheckType) {
      case 'note_edited':
      case 'todo_edited':
      case 'todo_completed':
      case 'note_created':
      case 'todo_created':
      case 'no_change':
        return evaluation.goldCheckType;
      default:
        throw new Error('Committed action evaluation has an invalid gold check type');
    }
  })();
  return { ...evaluation, goldCheckType };
}

function actionStateFromContact(
  task: LoadedPactPairTaskV1,
  contact?: FileDrivenPairContactV1,
): { before: PairDataStore; after: PairDataStore } | undefined {
  if (task.kind !== 'action' || !contact?.actionBefore || !contact.actionAfter) return undefined;
  return { before: contact.actionBefore, after: contact.actionAfter };
}

function hasStateChanged(
  state: { before: PairDataStore; after: PairDataStore } | undefined,
): boolean {
  return state !== undefined && !isDeepStrictEqual(state.before, state.after);
}

async function evaluateOutcome(input: {
  task: LoadedPactPairTaskV1;
  status: FileDrivenPairTerminalStatusV1;
  terminalTick: number;
  contact?: FileDrivenPairContactV1;
  state?: { before: PairDataStore; after: PairDataStore };
}): Promise<FileDrivenPairTaskOutcomeV1> {
  const decision = terminalDecision(input.status, input.contact);
  let evaluationResult: PactPairRegisteredEvaluationResultV1 | null = null;
  const isSideEffectFailure = input.status === 'side_effect_before_failure';
  if (isSideEffectFailure && (input.task.kind !== 'action' || !input.state)) {
    throw new Error('A side-effect-before-failure outcome requires trusted action snapshots');
  }
  const shouldEvaluate = input.status === 'answered'
    || input.status === 'refused'
    || isSideEffectFailure;
  if (shouldEvaluate && (input.task.kind === 'qa' || input.state)) {
    const registered = await evaluateWithRegisteredEvaluator(PACT_PAIR_EVALUATION_TARGET_V1, {
      task: input.task,
      ...(decision ? { decision } : {}),
      ...(input.state
        ? { before: structuredClone(input.state.before), after: structuredClone(input.state.after) }
        : {}),
    });
    evaluationResult = isSideEffectFailure
      ? {
        ...registered,
        metrics: registered.metrics.map(metric => metric.metric === 'actionSafety'
          ? metric
          : { ...metric, numerator: 0, denominator: 0 }),
      }
      : registered;
  }
  const evaluation = evaluationResult?.details ?? null;
  return Object.freeze({
    taskId: input.task.taskId,
    kind: input.task.kind,
    status: input.status,
    terminalTick: input.terminalTick,
    ...(input.contact ? { contactStatus: input.contact.status } : {}),
    ...(decision ? { finalDecision: decision } : {}),
    evaluation: evaluation === null ? null : structuredClone(evaluation),
    evaluationResult: evaluationResult === null ? null : structuredClone(evaluationResult),
    publicEvaluation: evaluation === null ? null : toPublicEvaluation(evaluation),
  });
}

function terminalDecision(
  status: FileDrivenPairTerminalStatusV1,
  contact?: FileDrivenPairContactV1,
): PactPairTerminalDecisionV1 | undefined {
  if (status === 'answered' && contact?.response) {
    return { type: 'answer', content: contact.response };
  }
  if (status === 'refused') {
    return { type: 'refuse', reason: 'The responder declined the authorized request.' };
  }
  return undefined;
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function combinedFailure(failures: readonly unknown[], message: string): unknown {
  if (failures.length === 0) return new Error(message);
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
}

function validateSessionOptions(options: RunOneFileDrivenPairSessionV1Options): void {
  if (!['files-multi', 'files-single'].includes(options.workflowId)) {
    throw new Error('File-driven PACT-Pair workflow ID is invalid');
  }
  if (options.tasks.length === 0) {
    throw new Error('File-driven PACT-Pair session requires selected tasks');
  }
  if (
    !safeWorkspaceId.test(options.runId)
    || !safeWorkspaceId.test(options.requester.actorId)
    || !safeWorkspaceId.test(options.responder.actorId)
    || (options.sessionId !== undefined && !safeSessionId.test(options.sessionId))
  ) {
    throw new Error('File-driven run, session, and actor IDs must be safe opaque identifiers');
  }
  if (!Number.isSafeInteger(options.sessionIndex) || options.sessionIndex < 0) {
    throw new Error('File-driven session index must be a non-negative safe integer');
  }
  const taskIds = options.tasks.map(task => task.taskId);
  if (
    new Set(taskIds).size !== taskIds.length
    || options.tasks.some(task => task.publicTask.taskId !== task.taskId)
  ) {
    throw new Error('File-driven PACT-Pair selected tasks must be unique and self-consistent');
  }
  if (
    !Number.isSafeInteger(options.maxTicks)
    || options.maxTicks <= 0
    || options.maxTicks > MAX_FILE_DRIVEN_PAIR_TICKS_V1
  ) {
    throw new Error('maxTicks must be a positive safe integer up to 10000');
  }
  if (options.multiTurn) {
    if (options.workflowId !== 'files-multi') {
      throw new Error('multiTurn applies only to the files-multi workflow');
    }
    if (
      !Number.isSafeInteger(options.multiTurn.phase2StartTick)
      || !Number.isSafeInteger(options.multiTurn.finalizeTick)
      || options.multiTurn.phase2StartTick < 2
      || options.multiTurn.phase2StartTick > options.multiTurn.finalizeTick
      || options.multiTurn.finalizeTick > options.maxTicks
    ) {
      throw new Error('multiTurn phase boundaries must satisfy 2 <= phase2StartTick <= finalizeTick <= maxTicks');
    }
  }
  if (
    !positiveBoundedInteger(options.budget.deadlineMs, MAX_FILE_DRIVEN_DEADLINE_MS_V1)
    || !Number.isSafeInteger(options.budget.maxToolCalls)
    || options.budget.maxToolCalls < MIN_FILE_DRIVEN_TOOL_CALLS_V1
    || options.budget.maxToolCalls > MAX_FILE_DRIVEN_TOOL_CALLS_V1
  ) {
    throw new Error('File-driven PACT-Pair budgets are outside the supported bounds');
  }
  if (options.requester.actorId === options.responder.actorId) {
    throw new Error('File-driven requester and responder actor IDs must be distinct');
  }
  if (
    typeof options.storeRoot !== 'string'
    || options.storeRoot.length === 0
    || typeof options.createDriver !== 'function'
    || typeof options.createSharedOsSession !== 'function'
  ) {
    throw new Error('File-driven PACT-Pair requires one SharedOS session boundary');
  }
}

function positiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
