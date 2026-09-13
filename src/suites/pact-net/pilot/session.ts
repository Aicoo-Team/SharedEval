import { mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject } from '../../../contracts/json.js';
import type { SoAccessContext, SoAuditEvent, SoExecutionResult, SoMessageEnvelope, SoTurnDecision, SoTurnDriver } from '../../../execution/sharedos/v1/contracts.js';
import { loadSharedOsModulesV1 } from '../../../execution/sharedos/v1/load-sharedos.js';
import { openWorldSession, type WorldSession } from '../../../runner/world/session.js';
import { worldContextFrontiersSchema, type WorldContextFrontiers } from '../../../runner/world/profile.js';
import { OWNER, NAMESPACE, actorAddress, actorIdSchema, assignedActorView, profileActors, profileRoles, profilePurpose, validateExecutionProfile, digest, grantsFor, privateProjection, type PilotActor, type ExecutionProfile } from './profile.js';
import { applyEvent, eventSchema, replayEvents, type PilotEvent } from './state.js';

import { atomicJson, journalDriver, makeHandlers, publicState, type NativeKernel } from './runtime.js';

const deliverySchema = z.object({ id: z.string(), actor: actorIdSchema, envelope: z.unknown() }).strict();
const checkpointSchema = z.object({ version: z.literal('net-pilot-checkpoint/v1'), binding: z.string(), startedAt: z.string().datetime(), pending: z.string().nullable(), queue: z.array(deliverySchema), processed: z.array(z.string()), events: z.array(eventSchema), audit: z.array(z.unknown()), executions: z.array(z.unknown()), revoked: z.array(z.string()), frontiers: worldContextFrontiersSchema, checksum: z.string() }).strict();
type Delivery = { id: string; actor: PilotActor; envelope: SoMessageEnvelope };
type Checkpoint = { version: 'net-pilot-checkpoint/v1'; binding: string; startedAt: string; pending: string | null; queue: Delivery[]; processed: string[]; events: PilotEvent[]; audit: SoAuditEvent[]; executions: SoExecutionResult[]; revoked: string[]; frontiers: WorldContextFrontiers };
type BaseDriverSession = Awaited<ReturnType<SoTurnDriver['open']>>;
// The verified pin supports escalate; the older shared loader declaration lacks
// that decision variant. Keep this supplement local to the bounded pilot adapter.
export type PilotTurnDriver = {
  open(...args: Parameters<SoTurnDriver['open']>): Promise<Omit<BaseDriverSession, 'next'> & {
    next(...args: Parameters<BaseDriverSession['next']>): Promise<SoTurnDecision | {
      type: 'escalate'; reason: string; metadata?: JsonObject;
    }>;
  }>;
};
export type PilotDriverFactory = (actor: PilotActor) => PilotTurnDriver;
export type PilotSessionOptions = { directory: string; runId: string; profile: ExecutionProfile; createDriver: PilotDriverFactory; sharedOsDir?: string };

/** One host-owned local transaction per actor turn; uncertain turns are never replayed. */
export async function openNetPilot(options: PilotSessionOptions) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.runId)) throw new Error('pilot_run_id_invalid');
  const profile = validateExecutionProfile(options.profile);
  const actors = profileActors(profile);
  const roles = profileRoles(profile);
  const caseId = profile.initial.case_id;
  const purpose = profilePurpose(profile);
  const loaded = await loadSharedOsModulesV1(options.sharedOsDir);
  if (!loaded.ok) throw new Error(loaded.reason);
  const namespaceId = `net-pilot-${options.runId}`;
  const binding = digest({ profile, namespaceId, revision: loaded.revision, runtimeDigest: loaded.runtimeDigest });
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('pilot_directory_invalid');
  const lock = await open(join(directory, 'writer.lock'), 'wx', 0o600);
  let world: WorldSession | undefined;
  let closed = false;
  let poisoned = false;
  let active = false;
  try {
    await lock.writeFile(randomUUID()); await lock.sync();
    let saved: Checkpoint | undefined;
    try {
      const parsed = checkpointSchema.parse(JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8')));
      const { checksum, ...body } = parsed;
      if (checksum !== digest(body) || parsed.binding !== binding) throw new Error('pilot_checkpoint_integrity_error');
      if (body.pending !== null) throw new Error('pilot_pending_turn_incomplete');
      saved = body as Checkpoint;
      for (const delivery of saved.queue) loaded.modules.contracts.MessageEnvelopeSchema.parse(delivery.envelope);
      if (new Set(saved.processed).size !== saved.processed.length || new Set(saved.queue.map(item => item.id)).size !== saved.queue.length || saved.queue.some(item => !actors.includes(item.actor) || saved!.processed.includes(item.id) || item.envelope.id !== item.id || item.envelope.receiver.kind !== 'agent' || item.envelope.receiver.agentId !== item.actor)) throw new Error('pilot_queue_integrity_error');
      replayEvents(profile, saved.events);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    world = await openWorldSession({ directory: join(directory, 'contexts'), worldId: namespaceId, bindingDigest: binding, actorIds: actors, profile: { protocol: 'actor-context/v1', maxContextBytes: 1_048_576 } });
    await world.assertCommittedFrontiers(saved?.frontiers);
    const startedAt = saved?.startedAt ?? new Date().toISOString();
    const initialEnvelope: SoMessageEnvelope = { version: '1', id: 'pilot-seed', sender: OWNER, receiver: actorAddress(roles.requester), purpose, payload: { stage: 'start', case_id: caseId }, traceId: 'pilot-seed-trace', createdAt: startedAt };
    let checkpoint: Checkpoint = saved ?? { version: 'net-pilot-checkpoint/v1', binding, startedAt, pending: null, queue: [{ id: initialEnvelope.id, actor: roles.requester, envelope: initialEnvelope }], processed: [], events: [], audit: [], executions: [], revoked: [], frontiers: await world.frontiers() };
    let committedCheckpoint = structuredClone(checkpoint);
    let state = replayEvents(profile, checkpoint.events);
    let writeTail = Promise.resolve();
    function persist(): Promise<void> {
      // Capture all mutable collections before yielding. Writes publish in request
      // order, so a revocation can neither corrupt a checksum nor replace a later commit.
      const body = structuredClone(checkpoint);
      const contents = { ...body, checksum: digest(body) };
      const write = writeTail.then(async () => {
        if (poisoned) throw new Error('pilot_session_unavailable');
        await atomicJson(directory, 'checkpoint.json', contents);
        if (body.pending === null) committedCheckpoint = body;
      });
      writeTail = write;
      return write.catch(error => { poisoned = true; throw error; });
    }
    if (!saved) await persist();
    const context = (actor: PilotActor, traceId: string): SoAccessContext => ({ namespaceId, actor: actorAddress(actor), authority: OWNER, owner: OWNER, purpose, traceId, enabledToolNamespaces: [NAMESPACE], now: new Date().toISOString() });
    // A private, freshly constructed kernel belongs to this session. It is never
    // exposed, and no host path opens a turn-authority lease on it.
    const kernel = new loaded.modules.core.SharedOSKernel({
      grantSource: { load: async ctx => structuredClone(grantsFor(namespaceId, startedAt, checkpoint.revoked, profile).filter(grant => digest(grant.subject) === digest(ctx.actor))) },
      audit: { record: async event => { checkpoint.audit.push(structuredClone(event)); } },
      messageTransport: { deliver: async (ctx, envelope, signal) => {
        signal.throwIfAborted();
        const recipient = envelope.receiver.kind === 'agent' ? envelope.receiver.agentId : '';
        if (!actors.includes(recipient)) throw new Error('pilot_recipient_outside_profile');
        if (checkpoint.queue.some(item => item.id === envelope.id) || checkpoint.processed.includes(envelope.id)) throw new Error('pilot_duplicate_delivery');
        checkpoint.queue.push({ id: envelope.id, actor: recipient as PilotActor, envelope: structuredClone(envelope) });
        return { status: 'accepted', messageId: envelope.id, timestamp: ctx.now };
      } },
    }) as NativeKernel;
    const handlers = makeHandlers({ profile, kernel, context,
      state: () => structuredClone(state),
      commit: event => { if (checkpoint.events.some(prior => prior.operation_id === event.operation_id)) throw new Error('pilot_duplicate_operation'); state = applyEvent(profile, state, event); checkpoint.events.push(event); },
      sequence: () => checkpoint.events.length + 1,
    });
    for (const handler of handlers) kernel.registerTool(handler);
    // Pinned executor's documented minimal TurnKernel port keeps authority resolution
    // per operation. Do not forward openTurnAuthority: its optional lease freezes
    // revocations until the next turn. Every method here still calls the real kernel.
    const executorKernel = {
      registerResourceProvider: kernel.registerResourceProvider.bind(kernel),
      registerTool: kernel.registerTool.bind(kernel), sendMessage: kernel.sendMessage.bind(kernel),
      admitTurn: kernel.admitTurn.bind(kernel), listTools: kernel.listTools.bind(kernel),
      invokeTool: kernel.invokeTool.bind(kernel),
      recordEscalation: kernel.recordEscalation.bind(kernel),
    };
    const snapshot = () => {
      const committedState = replayEvents(profile, committedCheckpoint.events);
      const indeterminate = poisoned || checkpoint.pending !== null;
      return structuredClone({ evidence_kind: 'scripted-native-runtime-pilot', case_id: caseId,
        mode: profile.mode, authority_lifecycle: profile.authorityLifecycle,
        ...(profile.mode === 'assigned' ? { profile_version: profile.version } : {}),
        profile_digest: digest(profile), initial_resource_digest: profile.resourceVersion,
        owner_evidence_digests: { budget: digest(profile.evidence.budget), contract: digest(profile.evidence.contract) },
        synthetic_owner_evidence: true, task_privacy_claim: false,
        sharedos: { revision: loaded.revision, runtime_digest: loaded.runtimeDigest },
        final_state: committedState,
        commit_status: !active && !indeterminate ? 'committed' as const : 'indeterminate' as const,
        terminal_success: !active && !indeterminate && committedCheckpoint.queue.length === 0 && committedState.status === 'released' && committedState.audit_record?.status === 'released',
        indeterminate, uncommitted_event_count: checkpoint.events.length - committedCheckpoint.events.length,
        pending: checkpoint.pending, queue: committedCheckpoint.queue, processed: committedCheckpoint.processed,
        event_log: committedCheckpoint.events, authorization_audit: committedCheckpoint.audit,
        executions: committedCheckpoint.executions, context_frontiers: committedCheckpoint.frontiers,
        revoked: committedCheckpoint.revoked,
      });
    };
    return {
      snapshot,
      /** Trusted host administration; never exposed as a runtime tool or driver argument. */
      async revoke(actor: PilotActor, key: string) {
        if (closed || poisoned) throw new Error('pilot_session_unavailable');
        const id = `${actor}:${key}`;
        if (!grantsFor(namespaceId, startedAt, [], profile).some(grant => grant.id === id)) throw new Error('pilot_grant_unknown');
        if (!checkpoint.revoked.includes(id)) checkpoint.revoked.push(id);
        await persist();
      },
      async runNext(createDriver: PilotDriverFactory = options.createDriver) {
        if (closed || poisoned || active) throw new Error('pilot_session_unavailable');
        const delivery = checkpoint.queue[0];
        if (!delivery) return null;
        active = true;
        checkpoint.pending = delivery.id;
        try {
          await persist(); // WAL marker is durable before any driver or local side effect.
          // The committed delivery count advances exactly once per turn, including
          // after reopen. Together with the private kernel this prevents lease reuse.
          const executionId = `turn-${checkpoint.processed.length + 1}-${delivery.actor}`;
          const ctx = context(delivery.actor, `trace-${executionId}`);
          const journal = journalDriver(world!, delivery.actor, executionId, createDriver(delivery.actor));
          const StandardRuntime = loaded.modules.runtime.StandardRuntime as new (driver: PilotTurnDriver) => unknown;
          const executor = new loaded.modules.runtime.SharedOSExecutor(executorKernel, new StandardRuntime(journal.driver));
          const result = await executor.execute({ version: '1', executionId, agent: { kind: 'agent', agentId: delivery.actor }, context: ctx,
            message: { ...delivery.envelope, traceId: ctx.traceId }, tools: handlers.map(handler => handler.definition),
            state: { actor_view: privateProjection(profile, delivery.actor), public_state: publicState(state),
              ...(profile.mode === 'assigned' ? { assignment: assignedActorView(profile, delivery.actor) } : {}) },
            options: { maxSteps: 20, maxToolCalls: 12, timeoutMs: 30000 },
          });
          if (!journal.isComplete()) throw new Error('pilot_pending_turn_incomplete');
          checkpoint.executions.push(result);
          checkpoint.queue.shift();
          checkpoint.processed.push(delivery.id);
          checkpoint.frontiers = await world!.frontiers();
          checkpoint.pending = null;
          await persist();
          return structuredClone(result);
        } catch (error) { poisoned = true; throw error; }
        finally { active = false; }
      },
      async close() {
        if (closed) return;
        if (active) throw new Error('pilot_turn_active');
        closed = true;
        await writeTail.catch(() => undefined);
        try { await world!.close(); } finally { await lock.close(); await unlink(join(directory, 'writer.lock')); }
      },
    };
  } catch (error) {
    await world?.close().catch(() => undefined);
    await lock.close(); await unlink(join(directory, 'writer.lock'));
    throw error;
  }
}
export type NetPilotSession = Awaited<ReturnType<typeof openNetPilot>>;
