import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { AgentWorkspaceFilePathV1, AgentWorkspaceTemplateV1 } from '../../runner/v1/agent-workspace.js';
import {
  CONTACT_AGENT_ERROR_CODES_V1,
  createInProcessContactAgentPortV1,
  type ContactAgentPortV1,
  type ContactResponderHarnessFactoryInputV1,
} from '../../runner/v1/contact-agent.js';
import {
  runFreshFileTurnV1,
  type FileTurnDecisionV1,
  type FreshFileHarnessFactoryV1,
} from '../../runner/v1/file-harness.js';
import { parseFileMemoryV1, type FileMemoryRowV1 } from '../../runner/v1/file-memory.js';
import {
  materializeFileWorkspaceV1,
  type FileReadReceiptV1,
  type FileWorkspacePortV1,
  type FileWorkspaceSnapshotV1,
  type MaterializedFileWorkspaceV1,
  type ReplaceMemoryResultV1,
} from '../../runner/v1/file-workspace.js';
import {
  loadWorkspaceRegistryV1,
  resolveAgentWorkspaceRegistryV1,
  type AgentWorkspaceRegistryReferencesV1,
  type WorkspaceRegistryV1,
} from '../../runner/v1/workspace-registry.js';
import { evaluateWithRegisteredEvaluator } from '../../evaluation/index.js';
import { PACT_PAIR_EVALUATION_TARGET_V1, type PactPairRegisteredEvaluationResultV1 } from './evaluation.js';
import {
  toPublicEvaluation,
  type PactPairPublicEvaluationV1,
} from './environment.js';
import type {
  PactPairEvaluationV1,
  PactPairTerminalDecisionV1,
} from './evaluator.js';
import { dataStoreSchema, type PairDataStore } from './schemas.js';
import type { LoadedPactPairTaskV1 } from './task-loader.js';

const logicalPaths = Object.freeze([
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[]);
const MAX_FILE_DRIVEN_PAIR_TICKS_V1 = 10_000;
const safeWorkspaceId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type FileDrivenPairWorkflowIdV1 = 'files-multi' | 'files-single';

export type FileDrivenPairActorV1 = Readonly<{
  actorId: string;
  references: AgentWorkspaceRegistryReferencesV1;
}>;

export type FileDrivenPairBudgetV1 = Readonly<{
  deadlineMs: number;
  requesterMaxToolSteps: number;
  responderMaxToolSteps: number;
}>;

export type FileDrivenPairRequesterHarnessFactoryInputV1 = Readonly<{
  workspace: FileWorkspacePortV1;
  readablePaths: readonly AgentWorkspaceFilePathV1[];
  allowMemoryReplacement: true;
  contact: ContactAgentPortV1;
}>;

export type FileDrivenPairHarnessDependenciesV1 = Readonly<{
  createRequesterHarnessFactory: (
    input: FileDrivenPairRequesterHarnessFactoryInputV1,
  ) => FreshFileHarnessFactoryV1;
  createResponderHarnessFactory: (
    input: ContactResponderHarnessFactoryInputV1,
  ) => FreshFileHarnessFactoryV1;
  /** Exact PACT data-state snapshot used only for action evaluation evidence. */
  snapshotResponderState?: () => PairDataStore;
  materializeWorkspace?: typeof materializeFileWorkspaceV1;
  loadRegistry?: typeof loadWorkspaceRegistryV1;
  now?: () => Date;
}>;

export type RunOneFileDrivenPairSessionV1Options = Readonly<{
  workflowId: FileDrivenPairWorkflowIdV1;
  runId: string;
  sessionId?: string;
  workspaceRootDir: string;
  registryRootDir: string;
  registry?: WorkspaceRegistryV1;
  requester: FileDrivenPairActorV1;
  responder: FileDrivenPairActorV1;
  tasks: readonly LoadedPactPairTaskV1[];
  maxTicks: number;
  budget: FileDrivenPairBudgetV1;
  cancellationSignal?: AbortSignal;
  dependencies: FileDrivenPairHarnessDependenciesV1;
}>;

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
  traceId: string;
  status: 'completed' | 'failed';
  decision?: FileTurnDecisionV1;
  errorCode?: 'FILE_TURN_FAILED';
  requesterReads: readonly FileReadReceiptV1[];
  requesterMemoryVersion?: number;
}>;

export type FileDrivenPairContactV1 = Readonly<{
  taskId: string;
  tick: number;
  status: 'completed' | 'denied' | 'failed' | 'cancelled';
  recipientTraceId: string;
  response?: string;
  errorCode?: string;
  responderReads: readonly FileReadReceiptV1[];
  actionBefore?: PairDataStore;
  actionAfter?: PairDataStore;
}>;

export type FileDrivenPairTerminalStatusV1 =
  | 'answered'
  | 'refused'
  | 'error'
  | 'no_response';

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
  fatalErrorCode?: 'FILE_SESSION_FAILED';
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
  fatalErrorCode?: 'FILE_SESSION_FAILED';
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
 * The one shared file-driven session scheduler. Multi executes it once over an
 * ordered task set; single executes it once per isolated task.
 */
export async function runOneFileDrivenPairSessionV1(
  options: RunOneFileDrivenPairSessionV1Options,
): Promise<FileDrivenPairSessionV1> {
  validateSessionOptions(options);
  const taskIds = options.tasks.map(task => task.taskId);
  const taskById = new Map(options.tasks.map(task => [task.taskId, task] as const));
  const registry = options.registry ?? await (options.dependencies.loadRegistry
    ?? loadWorkspaceRegistryV1)({ rootDir: options.registryRootDir });
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

  const requesterTemplate = renderRequesterTemplate(
    resolvedRequester.template,
    options.tasks,
  );
  const responderTemplate = renderResponderTemplate(
    resolvedResponder.template,
    taskIds,
  );
  // These immutable raw bytes and hashes exist before materialization, factory
  // creation, model work, or contact authorization/spend.
  const initialPrivateBytes = Object.freeze({
    requester: freezeTemplateBytes(requesterTemplate),
    responder: freezeTemplateBytes(responderTemplate),
  });
  const materialize = options.dependencies.materializeWorkspace
    ?? materializeFileWorkspaceV1;
  const [requesterWorkspace, responderWorkspace] = await Promise.all([
    materialize({
      rootDir: options.workspaceRootDir,
      runId: options.runId,
      actorId: options.requester.actorId,
      template: requesterTemplate,
      selectedTaskIds: taskIds,
    }),
    materialize({
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
  const initial = Object.freeze({
    requester: structuredClone(requesterInitialSnapshot.initial),
    responder: structuredClone(responderInitialSnapshot.initial),
  });

  const requesterEvidence = new EvidenceWorkspaceV1(requesterWorkspace);
  const responderEvidence = new EvidenceWorkspaceV1(responderWorkspace);
  const contacts: FileDrivenPairContactV1[] = [];
  const authoritativeByTask = new Map<string, FileDrivenPairContactV1>();
  let activeTick = 0;

  const baseContact = createInProcessContactAgentPortV1({
    recipients: new Map([[options.responder.actorId, responderEvidence]]),
    grants: taskIds.map(taskId => ({
      senderId: options.requester.actorId,
      recipientId: options.responder.actorId,
      purpose: taskId,
    })),
    budgets: {
      maxContacts: taskIds.length,
      remainingDepth: 1,
      maxToolSteps: options.budget.responderMaxToolSteps,
    },
    createResponderHarnessFactory: input => {
      responderEvidence.beginTurn(activeTick);
      return options.dependencies.createResponderHarnessFactory(input);
    },
    ...(options.cancellationSignal
      ? { cancellationSignal: options.cancellationSignal }
      : {}),
  });
  const correlatedContact: ContactAgentPortV1 = {
    contact: async input => {
      const task = taskById.get(input.purpose);
      if (
        !task
        || input.senderId !== options.requester.actorId
        || input.recipientId !== options.responder.actorId
      ) {
        return blockedContactResult(
          options.runId,
          activeTick,
          CONTACT_AGENT_ERROR_CODES_V1.purposeDenied,
        );
      }
      if (!requesterEvidence.readAllLogicalFilesInCurrentTurn()) {
        return blockedContactResult(
          options.runId,
          activeTick,
          'CONTACT_REQUESTER_FILE_READ_REQUIRED',
        );
      }
      if (authoritativeByTask.has(task.taskId)) {
        return blockedContactResult(
          options.runId,
          activeTick,
          'CONTACT_DUPLICATE_TASK',
        );
      }

      const before = task.kind === 'action'
        ? snapshotResponderState(options.dependencies)
        : undefined;
      const rawResult = await baseContact.contact(input);
      const after = task.kind === 'action'
        ? snapshotResponderState(options.dependencies)
        : undefined;
      const result = (
        (rawResult.status === 'completed' || rawResult.status === 'denied')
        && !responderEvidence.readAllLogicalFilesInCurrentTurn()
      )
        ? {
          status: 'failed' as const,
          errorCode: 'CONTACT_RESPONDER_FILE_READ_REQUIRED',
          recipientTraceId: rawResult.recipientTraceId,
        }
        : rawResult;
      const contact = Object.freeze({
        taskId: task.taskId,
        tick: activeTick,
        status: result.status,
        recipientTraceId: result.recipientTraceId,
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        responderReads: responderEvidence.currentReads(),
        ...(before === undefined ? {} : { actionBefore: before }),
        ...(after === undefined ? {} : { actionAfter: after }),
      }) satisfies FileDrivenPairContactV1;
      authoritativeByTask.set(task.taskId, contact);
      contacts.push(contact);
      return result;
    },
  };

  // Factory construction happens only after exact initial bytes and both
  // materialized initial snapshots are frozen above.
  const requesterHarnessFactory = options.dependencies.createRequesterHarnessFactory({
    workspace: requesterEvidence,
    readablePaths: logicalPaths,
    allowMemoryReplacement: true,
    contact: correlatedContact,
  });
  const ticks: FileDrivenPairTickV1[] = [];
  const outcomeByTask = new Map<string, FileDrivenPairTaskOutcomeV1>();
  let stopReason: FileDrivenPairStopReasonV1 = 'tick_exhausted';
  let fatal = false;

  for (let tick = 1; tick <= options.maxTicks; tick += 1) {
    activeTick = tick;
    requesterEvidence.beginTurn(tick);
    const traceId = opaqueTraceId(
      options.runId,
      options.sessionId ?? options.runId,
      tick,
    );
    let attemptedDecision: FileTurnDecisionV1 | undefined;
    let requesterMemoryVersion: number | undefined;
    try {
      const decision = await runFreshFileTurnV1(requesterHarnessFactory, {
        actorId: options.requester.actorId,
        traceId,
        deadlineMs: options.budget.deadlineMs,
        maxToolSteps: options.budget.requesterMaxToolSteps,
        maxContactCalls: 1,
        ...(options.cancellationSignal?.aborted ? { cancelled: true } : {}),
      });
      attemptedDecision = decision;
      if (decision.type === 'cancelled' || options.cancellationSignal?.aborted) {
        throw new Error('File-driven session cancelled');
      }
      const memory = await requesterWorkspace.read({
        actorId: options.requester.actorId,
        path: 'MEMORY.md',
      });
      requesterMemoryVersion = memory.receipt.version;
      const rows = parseFileMemoryV1({ content: memory.content, selectedTaskIds: taskIds });
      ticks.push(Object.freeze({
        tick,
        traceId,
        status: 'completed' as const,
        decision: structuredClone(decision),
        requesterReads: requesterEvidence.currentReads(),
        requesterMemoryVersion: memory.receipt.version,
      }));
      await reconcileTerminalRows({
        rows,
        tasks: options.tasks,
        contacts: authoritativeByTask,
        outcomes: outcomeByTask,
        tick,
      });
      if (outcomeByTask.size === options.tasks.length) {
        stopReason = 'all_terminal';
        break;
      }
    } catch {
      ticks.push(Object.freeze({
        tick,
        traceId,
        status: 'failed' as const,
        ...(attemptedDecision
          ? { decision: structuredClone(attemptedDecision) }
          : {}),
        errorCode: 'FILE_TURN_FAILED' as const,
        requesterReads: requesterEvidence.currentReads(),
        ...(requesterMemoryVersion === undefined
          ? {}
          : { requesterMemoryVersion }),
      }));
      fatal = true;
      stopReason = 'fatal_error';
      break;
    }
  }

  if (fatal) {
    for (const task of options.tasks) {
      if (!outcomeByTask.has(task.taskId)) {
        outcomeByTask.set(task.taskId, await evaluateOutcome({
          task,
          status: 'error',
          terminalTick: Math.max(1, activeTick),
          state: task.kind === 'action'
            ? unchangedResponderState(options.dependencies)
            : undefined,
        }));
      }
    }
  } else if (outcomeByTask.size < options.tasks.length) {
    stopReason = 'tick_exhausted';
    for (const task of options.tasks) {
      if (!outcomeByTask.has(task.taskId)) {
        outcomeByTask.set(task.taskId, await evaluateOutcome({
          task,
          status: 'no_response',
          terminalTick: options.maxTicks,
          state: task.kind === 'action'
            ? unchangedResponderState(options.dependencies)
            : undefined,
        }));
      }
    }
  }

  const [requesterFinalSnapshot, responderFinalSnapshot] = await Promise.all([
    requesterWorkspace.snapshot(options.requester.actorId),
    responderWorkspace.snapshot(options.responder.actorId),
  ]);
  const outcomes = options.tasks.map(task => {
    const outcome = outcomeByTask.get(task.taskId);
    if (!outcome) throw new Error('File-driven session lost a selected task outcome');
    return outcome;
  });
  return Object.freeze({
    workflowId: options.workflowId,
    runId: options.runId,
    sessionId: options.sessionId ?? options.runId,
    selectedTaskIds: Object.freeze([...taskIds]),
    registryReferences: Object.freeze({
      requester: structuredClone(options.requester.references),
      responder: structuredClone(options.responder.references),
    }),
    stopReason,
    ...(fatal ? { fatalErrorCode: 'FILE_SESSION_FAILED' as const } : {}),
    ticks: Object.freeze([...ticks]),
    contacts: Object.freeze([...contacts]),
    outcomes: Object.freeze(outcomes),
    initial,
    final: Object.freeze({
      requester: structuredClone(requesterFinalSnapshot.final),
      responder: structuredClone(responderFinalSnapshot.final),
    }),
    initialPrivateBytes,
  });
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

export function renderRequesterPolicyV1(
  tasks: readonly LoadedPactPairTaskV1[],
): string {
  if (tasks.length === 0) throw new Error('Requester policy requires at least one public task');
  const lines = tasks.map((task, index) =>
    `${index + 1}. ${JSON.stringify(structuredClone(task.publicTask))}`
  );
  return [
    '# Ordered Public Task Queue',
    '',
    ...lines,
    '',
  ].join('\n');
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
  const memory = renderInitialFileMemoryV1(tasks.map(task => task.taskId));
  return replaceTemplateFiles(template, {
    'POLICY.md': renderRequesterPolicyV1(tasks),
    'MEMORY.md': memory,
  });
}

function renderResponderTemplate(
  template: AgentWorkspaceTemplateV1,
  taskIds: readonly string[],
): AgentWorkspaceTemplateV1 {
  return replaceTemplateFiles(template, {
    'MEMORY.md': renderInitialFileMemoryV1(taskIds),
  });
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
    return {
      ...file,
      content,
      sha256: sha256(content),
    };
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

function freezeTemplateBytes(
  template: AgentWorkspaceTemplateV1,
): FrozenInitialWorkspaceBytesV1 {
  const byPath = Object.fromEntries(Object.values(template.files).map(file => {
    const bytes = Buffer.from(file.content, 'utf8');
    const frozen = Object.freeze({
      path: file.path,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      bytesBase64: bytes.toString('base64'),
    });
    return [file.path, frozen];
  })) as Record<AgentWorkspaceFilePathV1, FrozenInitialFileBytesV1>;
  return Object.freeze(byPath);
}

async function reconcileTerminalRows(input: {
  rows: readonly FileMemoryRowV1[];
  tasks: readonly LoadedPactPairTaskV1[];
  contacts: ReadonlyMap<string, FileDrivenPairContactV1>;
  outcomes: Map<string, FileDrivenPairTaskOutcomeV1>;
  tick: number;
}): Promise<void> {
  for (const [index, task] of input.tasks.entries()) {
    if (input.outcomes.has(task.taskId)) continue;
    const row = input.rows[index];
    if (!row || row.status === 'pending') continue;
    const contact = input.contacts.get(task.taskId);
    // MEMORY alone is not a terminal event. A model cannot manufacture an
    // answered/refused/error result without one host-correlated contact.
    if (!contact) continue;
    const contactStatus = contactOutcomeStatus(contact.status);
    const status = row.status === contactStatus ? contactStatus : 'error';
    input.outcomes.set(task.taskId, await evaluateOutcome({
      task,
      status,
      terminalTick: input.tick,
      contact,
      state: contact.actionBefore && contact.actionAfter
        ? { before: contact.actionBefore, after: contact.actionAfter }
        : undefined,
    }));
  }
}

function contactOutcomeStatus(
  status: FileDrivenPairContactV1['status'],
): Exclude<FileDrivenPairTerminalStatusV1, 'no_response'> {
  if (status === 'completed') return 'answered';
  if (status === 'denied') return 'refused';
  return 'error';
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
  if (input.task.kind === 'qa' || input.state) {
    evaluationResult = await evaluateWithRegisteredEvaluator(
      PACT_PAIR_EVALUATION_TARGET_V1,
      {
        task: input.task,
        ...(decision ? { decision } : {}),
        ...(input.state
          ? {
            before: structuredClone(input.state.before),
            after: structuredClone(input.state.after),
          }
          : {}),
      },
    );
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

function snapshotResponderState(
  dependencies: FileDrivenPairHarnessDependenciesV1,
): PairDataStore | undefined {
  if (!dependencies.snapshotResponderState) return undefined;
  return structuredClone(dataStoreSchema.parse(dependencies.snapshotResponderState()));
}

function unchangedResponderState(
  dependencies: FileDrivenPairHarnessDependenciesV1,
): { before: PairDataStore; after: PairDataStore } | undefined {
  const state = snapshotResponderState(dependencies);
  return state ? { before: state, after: structuredClone(state) } : undefined;
}

function blockedContactResult(runId: string, tick: number, errorCode: string) {
  return {
    status: 'denied' as const,
    errorCode,
    recipientTraceId: `blocked:${createHash('sha256')
      .update(`${runId}:${tick}:${errorCode}`)
      .digest('hex')
      .slice(0, 32)}`,
  };
}

function opaqueTraceId(runId: string, sessionId: string, tick: number): string {
  return `heartbeat:${createHash('sha256')
    .update(`${runId}:${sessionId}:${tick}`)
    .digest('hex')
    .slice(0, 32)}`;
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
  if (
    !positiveBoundedInteger(options.budget.deadlineMs, 3_600_000)
    || !positiveBoundedInteger(options.budget.requesterMaxToolSteps, 128)
    || !positiveBoundedInteger(options.budget.responderMaxToolSteps, 128)
  ) {
    throw new Error('File-driven PACT-Pair budgets must be positive bounded integers');
  }
  if (options.requester.actorId === options.responder.actorId) {
    throw new Error('File-driven requester and responder actor IDs must be distinct');
  }
}

function positiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

class EvidenceWorkspaceV1 implements FileWorkspacePortV1 {
  private turn = 0;
  private reads: FileReadReceiptV1[] = [];
  private observedMemoryVersions = new Set<number>();

  constructor(private readonly inner: MaterializedFileWorkspaceV1) {}

  beginTurn(turn: number): void {
    this.turn = turn;
    this.reads = [];
    this.observedMemoryVersions.clear();
  }

  async read(input: Parameters<FileWorkspacePortV1['read']>[0]) {
    const loaded = await this.inner.read(input);
    if (this.turn > 0) this.reads.push(structuredClone(loaded.receipt));
    if (input.path === 'MEMORY.md') {
      this.observedMemoryVersions.add(loaded.receipt.version);
    }
    return loaded;
  }

  async replaceMemory(
    input: Parameters<FileWorkspacePortV1['replaceMemory']>[0],
  ): Promise<ReplaceMemoryResultV1> {
    if (!this.observedMemoryVersions.has(input.expectedVersion)) {
      throw new Error('MEMORY replacement requires a version observed in this fresh turn');
    }
    this.observedMemoryVersions.clear();
    const result = await this.inner.replaceMemory(input);
    if (result.outcome === 'committed') {
      this.observedMemoryVersions.add(result.version);
    }
    return result;
  }

  snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1> {
    return this.inner.snapshot(actorId);
  }

  currentReads(): readonly FileReadReceiptV1[] {
    return Object.freeze(this.reads.map(receipt => Object.freeze({ ...receipt })));
  }

  readAllLogicalFilesInCurrentTurn(): boolean {
    const seen = new Set(this.reads.map(receipt => receipt.path));
    return logicalPaths.every(path => seen.has(path));
  }
}
