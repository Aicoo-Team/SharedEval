import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject } from '../../../contracts/json.js';
import type { SoAccessContext, SoAuditEvent, SoCapabilityGrant, SoExecutionResult, SoMessageEnvelope, SoToolHandler } from '../../../execution/sharedos/v1/contracts.js';
import { loadSharedOsModulesV1 } from '../../../execution/sharedos/v1/load-sharedos.js';
import { openWorldSession, type WorldSession } from '../../../runner/world/session.js';
import { assertWorldContextCommit, worldContextCommitSchema, worldContextFrontiersSchema, type WorldContextFrontiers } from '../../../runner/world/profile.js';
import { OWNER, NAMESPACE, actorAddress, actorIdSchema, assignedActorView, digest, grantsFor, privateProjection, profileActors, profilePurpose, requirement } from '../pilot/profile.js';
import { applyEvent, eventSchema, replayEvents, type PilotState } from '../pilot/state.js';
import { atomicJson, journalDriver, makeHandlers, publicState, type NativeKernel } from '../pilot/runtime.js';
import type { PilotDriverFactory, PilotTurnDriver } from '../pilot/session.js';
import { createProcurementWorldProfile, worldActors, type ProcurementWorldProfile } from './profile.js';

const deliverySchema = z.object({ id: z.string(), actor: actorIdSchema, envelope: z.unknown() }).strict();
const caseSchema = z.object({
  caseId: z.string(), binding: z.string(), startedAt: z.string().datetime().nullable(), epoch: z.number().int().nonnegative(),
  events: z.array(eventSchema), audit: z.array(z.unknown()), executions: z.array(z.unknown()),
  processed: z.array(z.string()), revoked: z.array(z.string()), complete: z.boolean(),
  contextCommit: worldContextCommitSchema.nullable(),
}).strict();
const checkpointSchema = z.object({
  version: z.literal('net-world-checkpoint/v1'), binding: z.string(), currentCaseIndex: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(), epochReady: z.boolean(), pending: z.string().nullable(), queue: z.array(deliverySchema),
  processed: z.array(z.string()), frontiers: worldContextFrontiersSchema, cases: z.array(caseSchema), checksum: z.string(),
}).strict();
type Delivery = { id: string; actor: string; envelope: SoMessageEnvelope };
type CaseCheckpoint = Omit<z.infer<typeof caseSchema>, 'audit' | 'executions'> & { audit: SoAuditEvent[]; executions: SoExecutionResult[] };
type Checkpoint = Omit<z.infer<typeof checkpointSchema>, 'checksum' | 'queue' | 'cases'> & { queue: Delivery[]; cases: CaseCheckpoint[] };
export type NetWorldOptions = { directory: string; runId: string; profile: ProcurementWorldProfile; createDriver: PilotDriverFactory; sharedOsDir?: string };

/** Serialized host coordinator; each native kernel executes only its current case. */
export async function openNetWorld(options: NetWorldOptions) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.runId)) throw new Error('net_world_run_id_invalid');
  const profile = createProcurementWorldProfile(options.profile);
  const actors = worldActors(profile);
  const loaded = await loadSharedOsModulesV1(options.sharedOsDir);
  if (!loaded.ok) throw new Error(loaded.reason);
  const { modules } = loaded;
  const namespace = `net-world-${options.runId}`;
  const binding = digest({ profile, actors, namespace, revision: loaded.revision, runtimeDigest: loaded.runtimeDigest });
  const caseBinding = (index: number) => digest({ world: binding, index, profile: profile.cases[index] });
  const emptyFrontiers = (): WorldContextFrontiers => actors.map(actorId => ({ actorId, sequence: 0, hash: '0'.repeat(64) }));
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('net_world_directory_invalid');
  const lock = await open(join(directory, 'writer.lock'), 'wx', 0o600);
  let world: WorldSession | undefined;
  let closed = false; let active = false; let poisoned = false;
  try {
    await lock.writeFile(randomUUID()); await lock.sync();
    let saved: Checkpoint | undefined;
    try {
      const { checksum, ...body } = checkpointSchema.parse(JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8')));
      if (checksum !== digest(body) || body.binding !== binding) throw new Error('net_world_checkpoint_integrity_error');
      if (body.pending !== null) throw new Error('net_world_pending_turn_incomplete');
      saved = body as Checkpoint;
      validateCheckpoint(saved);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const checkpoint: Checkpoint = saved ?? {
      version: 'net-world-checkpoint/v1', binding, currentCaseIndex: 0, epoch: 0, epochReady: false, pending: null, queue: [], processed: [], frontiers: emptyFrontiers(),
      cases: profile.cases.map((item, index) => ({ caseId: item.initial.case_id, binding: caseBinding(index), startedAt: null,
        epoch: profile.mode === 'single' ? index : 0, events: [], audit: [], executions: [], processed: [], revoked: [], complete: false, contextCommit: null })),
    };
    if (!saved) initializeCase(0);
    let committed = structuredClone(checkpoint);
    let writeTail = Promise.resolve();
    function persist(): Promise<void> {
      const body = structuredClone(checkpoint);
      const write = writeTail.then(async () => {
        if (poisoned) throw new Error('net_world_session_unavailable');
        await atomicJson(directory, 'checkpoint.json', { ...body, checksum: digest(body) });
        if (body.pending === null) committed = body;
      });
      writeTail = write;
      return write.catch(error => { poisoned = true; throw error; });
    }
    async function openEpoch() {
      world = await openWorldSession({ directory: join(directory, 'contexts', `epoch-${checkpoint.epoch}`),
        worldId: `${namespace}-epoch-${checkpoint.epoch}`, bindingDigest: binding, actorIds: actors, profile: profile.context });
      if (checkpoint.epochReady) await world.assertCommittedFrontiers(checkpoint.frontiers);
      else {
        // The store owns its genesis hashes. A prepared epoch may adopt them only
        // while every actor is empty; an orphaned nonzero journal fails closed.
        await world.assertCommittedFrontiers(undefined);
        checkpoint.frontiers = await world.frontiers();
        checkpoint.cases[checkpoint.currentCaseIndex]!.contextCommit = { before: structuredClone(checkpoint.frontiers), after: structuredClone(checkpoint.frontiers) };
        checkpoint.epochReady = true;
        await persist();
      }
    }
    // Publish the empty identity before creating the store. A crash in between can
    // reopen that exact empty epoch, never an older case's nonempty history.
    if (!saved) await persist();
    await openEpoch();

    function initializeCase(index: number) {
      const item = checkpoint.cases[index]!;
      const current = profile.cases[index]!;
      item.startedAt = new Date().toISOString();
      item.contextCommit = { before: structuredClone(checkpoint.frontiers), after: structuredClone(checkpoint.frontiers) };
      const id = `${namespace}-case-${index}-seed`;
      checkpoint.queue = [{ id, actor: current.roles.requester, envelope: { version: '1', id, sender: OWNER,
        receiver: actorAddress(current.roles.requester), purpose: profilePurpose(current), payload: { stage: 'start', case_id: item.caseId },
        traceId: `${id}-trace`, createdAt: item.startedAt } }];
    }
    function resourceState(source: Checkpoint, index: number): PilotState {
      // Archives are retained for host evidence, but Single starts ALL partitions
      // from the declared initial world. Only the current epoch can change them.
      return replayEvents(profile.cases[index]!, profile.mode === 'multi' || index === source.currentCaseIndex ? source.cases[index]!.events : []);
    }
    function validateCheckpoint(value: Checkpoint) {
      const fail = () => { throw new Error('net_world_checkpoint_integrity_error'); };
      if (value.cases.length !== profile.cases.length || value.currentCaseIndex >= value.cases.length || value.epoch !== (profile.mode === 'single' ? value.currentCaseIndex : 0)) fail();
      let previous: WorldContextFrontiers | undefined;
      const expectedProcessed: string[] = [];
      const executionIds = new Set<string>();
      for (const [index, item] of value.cases.entries()) {
        const current = profile.cases[index]!;
        if (item.caseId !== current.initial.case_id || item.binding !== caseBinding(index) || item.epoch !== (profile.mode === 'single' ? index : 0)) fail();
        const state = replayEvents(current, item.events);
        if (index > value.currentCaseIndex) {
          if (item.startedAt !== null || item.contextCommit !== null || item.events.length || item.audit.length || item.executions.length || item.processed.length || item.revoked.length || item.complete) fail();
          continue;
        }
        if (!item.startedAt || !item.contextCommit || item.processed.length !== item.executions.length || index < value.currentCaseIndex && !item.complete || item.complete && !state.audit_record) fail();
        assertWorldContextCommit(actors, item.contextCommit!, profile.mode === 'multi' ? previous : undefined);
        previous = item.contextCommit!.after;
        expectedProcessed.push(...item.processed);
        for (const result of item.executions) {
          if (!result || typeof result.executionId !== 'string' || executionIds.has(result.executionId)) fail();
          executionIds.add(result.executionId);
        }
        const available = caseGrants(index, item.startedAt!, []);
        if (new Set(item.revoked).size !== item.revoked.length || item.revoked.some(id => !available.some(grant => grant.id === id))) fail();
      }
      if (digest(expectedProcessed) !== digest(value.processed) || new Set(value.processed).size !== value.processed.length || digest(previous) !== digest(value.frontiers)) fail();
      const current = profile.cases[value.currentCaseIndex]!;
      const caseActors = profileActors(current);
      if (!value.epochReady) {
        const item = value.cases[value.currentCaseIndex]!;
        if (profile.mode === 'multi' && value.currentCaseIndex !== 0 || item.processed.length || item.events.length || item.audit.length || item.revoked.length || value.frontiers.some(frontier => frontier.sequence !== 0)) fail();
      }
      const ids = value.queue.map(item => item.id);
      if (new Set(ids).size !== ids.length || value.cases[value.currentCaseIndex]!.complete && value.queue.length) fail();
      for (const delivery of value.queue) {
        modules.contracts.MessageEnvelopeSchema.parse(delivery.envelope);
        if (!caseActors.includes(delivery.actor) || value.processed.includes(delivery.id) || delivery.id !== delivery.envelope.id || delivery.envelope.receiver.kind !== 'agent' || delivery.envelope.receiver.agentId !== delivery.actor || delivery.envelope.purpose !== profilePurpose(current) || (delivery.envelope.payload as JsonObject).case_id !== current.initial.case_id) fail();
      }
    }
    function caseGrants(index: number, startedAt: string, revoked: readonly string[]): SoCapabilityGrant[] {
      const current = profile.cases[index]!;
      const grants = grantsFor(`${namespace}-case-${index}`, startedAt, revoked, current);
      for (const actor of profileActors(current).filter(actor => profile.publicState.readers.includes(actor))) {
        const template = grants.find(grant => grant.id === `${actor}:read_case`)!;
        const id = `${actor}:world_read_public`;
        const { revokedAt: _revokedAt, ...base } = template;
        grants.push({ ...base, id, capabilities: [{ resource: requirement('world-public', 'read', current).resource, actions: ['read'], scope: 'exact' }],
          ...(revoked.includes(id) ? { revokedAt: startedAt } : {}) });
      }
      return grants;
    }

    function caseExecutor(index: number) {
      const current = profile.cases[index]!;
      const item = checkpoint.cases[index]!;
      const namespaceId = `${namespace}-case-${index}`;
      const context = (actor: string, traceId: string): SoAccessContext => ({ namespaceId, actor: actorAddress(actor), authority: OWNER, owner: OWNER,
        purpose: profilePurpose(current), traceId, enabledToolNamespaces: [NAMESPACE], now: new Date().toISOString() });
      const assertActive = () => { if (!active || poisoned || checkpoint.pending === null || checkpoint.currentCaseIndex !== index) throw new Error('net_world_session_unavailable'); };
      const kernel = new modules.core.SharedOSKernel({
        grantSource: { load: async ctx => structuredClone(caseGrants(index, item.startedAt!, item.revoked).filter(grant => digest(grant.subject) === digest(ctx.actor))) },
        audit: { record: async event => { assertActive(); item.audit.push(structuredClone(event)); } },
        messageTransport: { deliver: async (ctx, envelope, signal) => {
          signal.throwIfAborted(); assertActive();
          const recipient = envelope.receiver.kind === 'agent' ? envelope.receiver.agentId : '';
          if (!profileActors(current).includes(recipient)) throw new Error('net_world_recipient_outside_case');
          if (checkpoint.processed.includes(envelope.id) || checkpoint.queue.some(delivery => delivery.id === envelope.id)) throw new Error('net_world_duplicate_delivery');
          checkpoint.queue.push({ id: envelope.id, actor: recipient, envelope: structuredClone(envelope) });
          return { status: 'accepted', messageId: envelope.id, timestamp: ctx.now };
        } },
      }) as NativeKernel;
      const handlers = makeHandlers({ profile: current, kernel, context, state: () => replayEvents(current, item.events), sequence: () => item.events.length + 1,
        commit: event => {
          assertActive();
          if (item.events.some(prior => prior.operation_id === event.operation_id)) throw new Error('net_world_duplicate_operation');
          applyEvent(current, replayEvents(current, item.events), event); item.events.push(event);
        },
        messageId: (_ctx, callId) => `${namespaceId}-message-${callId}`,
      });
      const worldRead: SoToolHandler = {
        definition: { name: 'net.world_read_public', description: 'Read explicitly shared case status in the active world epoch', namespace: NAMESPACE,
          source: 'sharedeval-net-world', readWrite: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          requiredCapability: requirement('world-public', 'read', current) },
        parseArguments: args => z.object({}).strict().parse(args),
        invoke: async (ctx, call, signal) => {
          signal.throwIfAborted(); assertActive();
          const cases = profile.publicState.caseIds.map(caseId => {
            const state = resourceState(checkpoint, profile.cases.findIndex(caseProfile => caseProfile.initial.case_id === caseId));
            return { case_id: state.case_id, resource_version: state.resource_version, status: state.status,
              records_matched: state.records_matched, budget_verified: state.budget_approval !== null,
              contract_verified: state.contract_approval !== null, audit_written: state.audit_record !== null };
          });
          return { status: 'succeeded', callId: call.id, tool: call.tool, output: { cases }, completedAt: ctx.now };
        },
      };
      handlers.push(worldRead);
      for (const handler of handlers) kernel.registerTool(handler);
      const executorKernel = { registerResourceProvider: kernel.registerResourceProvider.bind(kernel), registerTool: kernel.registerTool.bind(kernel),
        sendMessage: kernel.sendMessage.bind(kernel), admitTurn: kernel.admitTurn.bind(kernel), listTools: kernel.listTools.bind(kernel),
        invokeTool: kernel.invokeTool.bind(kernel), recordEscalation: kernel.recordEscalation.bind(kernel) };
      return { context, handlers, executorKernel };
    }

    const snapshot = () => {
      const indeterminate = poisoned || checkpoint.pending !== null;
      const complete = committed.cases.every(item => item.complete);
      return structuredClone({ evidence_kind: 'scripted-native-runtime-world', mode: profile.mode,
        profile_version: profile.version, profile_digest: digest(profile), world_binding: binding,
        sharedos: { revision: loaded.revision, runtime_digest: loaded.runtimeDigest },
        synthetic_owner_evidence: true, task_privacy_claim: false,
        commit_status: !active && !indeterminate ? 'committed' as const : 'indeterminate' as const,
        indeterminate, pending: checkpoint.pending, current_case_index: committed.currentCaseIndex,
        context_epoch: committed.epoch, world_complete: !active && !indeterminate && complete,
        blocked: !active && !indeterminate && !complete && committed.queue.length === 0,
        terminal_success: !active && !indeterminate && complete && committed.cases.every((item, index) => replayEvents(profile.cases[index]!, item.events).status === 'released'),
        processed: committed.processed, queue: committed.queue, context_frontiers: committed.frontiers,
        cases: committed.cases.map((item, index) => ({ case_id: item.caseId, case_binding: item.binding, complete: item.complete,
          final_state: replayEvents(profile.cases[index]!, item.events), resource_state: resourceState(committed, index),
          event_log: item.events, authorization_audit: item.audit, executions: item.executions, processed: item.processed, revoked: item.revoked,
          context_commit: item.contextCommit, context_epoch: item.epoch })),
      });
    };
    return {
      snapshot,
      async revoke(actor: string, key: string) {
        if (closed || poisoned || !checkpoint.epochReady) throw new Error('net_world_session_unavailable');
        const item = checkpoint.cases[checkpoint.currentCaseIndex]!;
        const id = `${actor}:${key}`;
        if (!caseGrants(checkpoint.currentCaseIndex, item.startedAt!, []).some(grant => grant.id === id)) throw new Error('net_world_grant_unknown');
        if (!item.revoked.includes(id)) item.revoked.push(id);
        await persist();
      },
      async runNext(createDriver: PilotDriverFactory = options.createDriver) {
        if (closed || poisoned || active) throw new Error('net_world_session_unavailable');
        const delivery = checkpoint.queue[0];
        if (!delivery) return null;
        active = true;
        checkpoint.pending = delivery.id;
        try {
          await persist();
          const index = checkpoint.currentCaseIndex;
          const current = profile.cases[index]!;
          const item = checkpoint.cases[index]!;
          const { context, handlers, executorKernel } = caseExecutor(index);
          const executionId = `case-${index}-turn-${checkpoint.processed.length + 1}-${delivery.actor}`;
          const ctx = context(delivery.actor, `${namespace}-${executionId}`);
          const journal = journalDriver(world!, delivery.actor, executionId, createDriver(delivery.actor));
          const StandardRuntime = loaded.modules.runtime.StandardRuntime as new (driver: PilotTurnDriver) => unknown;
          const executor = new loaded.modules.runtime.SharedOSExecutor(executorKernel, new StandardRuntime(journal.driver));
          const result = await executor.execute({ version: '1', executionId, agent: { kind: 'agent', agentId: delivery.actor }, context: ctx,
            message: { ...delivery.envelope, traceId: ctx.traceId }, tools: handlers.map(handler => handler.definition),
            state: { actor_view: privateProjection(current, delivery.actor), public_state: publicState(replayEvents(current, item.events)), assignment: assignedActorView(current, delivery.actor) },
            options: { maxSteps: 20, maxToolCalls: 12, timeoutMs: 30000 } });
          if (!journal.isComplete()) throw new Error('net_world_pending_turn_incomplete');
          item.executions.push(result); item.processed.push(delivery.id);
          checkpoint.processed.push(delivery.id); checkpoint.queue.shift();
          checkpoint.frontiers = await world!.frontiers();
          item.contextCommit!.after = structuredClone(checkpoint.frontiers);
          checkpoint.pending = null;
          const state = replayEvents(current, item.events);
          if (checkpoint.queue.length === 0 && state.audit_record !== null) {
            item.complete = true;
            if (index + 1 < profile.cases.length) {
              checkpoint.currentCaseIndex++;
              if (profile.mode === 'single') { checkpoint.epoch++; checkpoint.epochReady = false; checkpoint.frontiers = emptyFrontiers(); }
              initializeCase(checkpoint.currentCaseIndex);
            }
          }
          await persist();
          if (profile.mode === 'single' && checkpoint.currentCaseIndex !== index) {
            await world!.close(); await openEpoch();
          }
          return structuredClone(result);
        } catch (error) { poisoned = true; throw error; }
        finally { active = false; }
      },
      async close() {
        if (closed) return;
        if (active) throw new Error('net_world_turn_active');
        closed = true; await writeTail.catch(() => undefined);
        try { await world?.close(); } finally { await lock.close(); await unlink(join(directory, 'writer.lock')); }
      },
    };
  } catch (error) {
    await world?.close().catch(() => undefined);
    await lock.close(); await unlink(join(directory, 'writer.lock')); throw error;
  }
}
export type NetWorldSession = Awaited<ReturnType<typeof openNetWorld>>;
export type NetWorldSnapshot = ReturnType<NetWorldSession['snapshot']>;
