import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../../contracts/json.js';
import type { SoAccessContext, SoAddress, SoAuditEvent, SoCapabilityRequirement, SoExecutionResult, SoKernel, SoMessageEnvelope, SoToolCall, SoToolDefinition, SoToolResult, SoToolHandler, SoTurnDecision, SoTurnDriver } from '../../../execution/sharedos/v1/contracts.js';
import { loadSharedOsModulesV1 } from '../../../execution/sharedos/v1/load-sharedos.js';
import { openWorldSession, type WorldSession } from '../../../runner/world/session.js';
import { worldContextFrontiersSchema, type WorldContextFrontiers } from '../../../runner/world/profile.js';
import { ACTORS, ACTION_OWNER, CASE_ID, PURPOSE, OWNER, NAMESPACE, actorAddress, createPilotProfile, digest, grantsFor, privateProjection, requirement, type PilotActor, type PilotProfile, type PilotAction } from './profile.js';
import { applyEvent, buildEvent, eventSchema, replayEvents, type PilotEvent, type PilotState } from './state.js';

const deliverySchema = z.object({ id: z.string(), actor: z.enum(ACTORS), envelope: z.unknown() }).strict();
const checkpointSchema = z.object({ version: z.literal('net-pilot-checkpoint/v1'), binding: z.string(), startedAt: z.string().datetime(), pending: z.string().nullable(), queue: z.array(deliverySchema), processed: z.array(z.string()), events: z.array(eventSchema), audit: z.array(z.unknown()), executions: z.array(z.unknown()), revoked: z.array(z.string()), frontiers: worldContextFrontiersSchema, checksum: z.string() }).strict();
type Delivery = { id: string; actor: PilotActor; envelope: SoMessageEnvelope };
type Checkpoint = { version: 'net-pilot-checkpoint/v1'; binding: string; startedAt: string; pending: string | null; queue: Delivery[]; processed: string[]; events: PilotEvent[]; audit: SoAuditEvent[]; executions: SoExecutionResult[]; revoked: string[]; frontiers: WorldContextFrontiers };
type NativeKernel = SoKernel & {
  authorize(context: SoAccessContext, requirement: SoCapabilityRequirement): Promise<{ allowed: boolean }>;
  admitTurn(context: SoAccessContext, agent: SoAddress, options?: { signal?: AbortSignal }): Promise<unknown>;
  listTools(context: SoAccessContext, options?: { signal?: AbortSignal }): Promise<readonly SoToolDefinition[]>;
  invokeTool(context: SoAccessContext, call: SoToolCall, options?: { signal?: AbortSignal }): Promise<SoToolResult>;
  recordEscalation(context: SoAccessContext, reason: string, options?: { signal?: AbortSignal }): Promise<JsonObject>;
};
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
export type PilotSessionOptions = { directory: string; runId: string; profile: PilotProfile; createDriver: PilotDriverFactory; sharedOsDir?: string };

/** One host-owned local transaction per actor turn; uncertain turns are never replayed. */
export async function openNetPilot(options: PilotSessionOptions) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.runId)) throw new Error('pilot_run_id_invalid');
  const loaded = await loadSharedOsModulesV1(options.sharedOsDir);
  if (!loaded.ok) throw new Error(loaded.reason);
  const profile = structuredClone(options.profile);
  if (!['success', 'safe-partial'].includes(profile.mode) || digest(profile) !== digest(createPilotProfile(profile.initial, profile.mode))) throw new Error('pilot_profile_invalid');
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
      if (new Set(saved.processed).size !== saved.processed.length || new Set(saved.queue.map(item => item.id)).size !== saved.queue.length || saved.queue.some(item => saved!.processed.includes(item.id) || item.envelope.id !== item.id || item.envelope.receiver.kind !== 'agent' || item.envelope.receiver.agentId !== item.actor)) throw new Error('pilot_queue_integrity_error');
      replayEvents(profile, saved.events);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    world = await openWorldSession({ directory: join(directory, 'contexts'), worldId: namespaceId, bindingDigest: binding, actorIds: ACTORS, profile: { protocol: 'actor-context/v1', maxContextBytes: 1_048_576 } });
    await world.assertCommittedFrontiers(saved?.frontiers);
    const startedAt = saved?.startedAt ?? new Date().toISOString();
    const initialEnvelope: SoMessageEnvelope = { version: '1', id: 'pilot-seed', sender: OWNER, receiver: actorAddress(ACTORS[0]), purpose: PURPOSE, payload: { stage: 'start', case_id: CASE_ID }, traceId: 'pilot-seed-trace', createdAt: startedAt };
    let checkpoint: Checkpoint = saved ?? { version: 'net-pilot-checkpoint/v1', binding, startedAt, pending: null, queue: [{ id: initialEnvelope.id, actor: ACTORS[0], envelope: initialEnvelope }], processed: [], events: [], audit: [], executions: [], revoked: [], frontiers: await world.frontiers() };
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
    const context = (actor: PilotActor, traceId: string): SoAccessContext => ({ namespaceId, actor: actorAddress(actor), authority: OWNER, owner: OWNER, purpose: PURPOSE, traceId, enabledToolNamespaces: [NAMESPACE], now: new Date().toISOString() });
    // A private, freshly constructed kernel belongs to this session. It is never
    // exposed, and no host path opens a turn-authority lease on it.
    const kernel = new loaded.modules.core.SharedOSKernel({
      grantSource: { load: async ctx => structuredClone(grantsFor(namespaceId, startedAt, checkpoint.revoked).filter(grant => digest(grant.subject) === digest(ctx.actor))) },
      audit: { record: async event => { checkpoint.audit.push(structuredClone(event)); } },
      messageTransport: { deliver: async (ctx, envelope, signal) => {
        signal.throwIfAborted();
        const recipient = envelope.receiver.kind === 'agent' ? envelope.receiver.agentId : '';
        if (!ACTORS.includes(recipient as PilotActor)) throw new Error('pilot_recipient_outside_profile');
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
      return structuredClone({ evidence_kind: 'scripted-native-runtime-pilot', case_id: CASE_ID,
        mode: profile.mode, authority_lifecycle: profile.authorityLifecycle,
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
        if (!grantsFor(namespaceId, startedAt, []).some(grant => grant.id === id)) throw new Error('pilot_grant_unknown');
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
            state: { actor_view: privateProjection(profile, delivery.actor), public_state: publicState(state) },
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
function publicState(state: PilotState): JsonObject {
  return { case_id: state.case_id, resource_version: state.resource_version, status: state.status,
    records_matched: state.records_matched, budget_verified: state.budget_approval !== null,
    contract_verified: state.contract_approval !== null, budget_receipt: state.budget_approval, contract_receipt: state.contract_approval, blockers: state.blockers, audit_written: state.audit_record !== null };
}
function journalDriver(world: WorldSession, actor: PilotActor, turnId: string, delegate: PilotTurnDriver) {
  let opened = false;
  let finished = false;
  const driver: PilotTurnDriver = { open: async (request, signal) => {
    const input = { role: 'user' as const, content: JSON.stringify({ message: request.message.payload, state: request.state }) };
    opened = true;
    const turn = await world.actorContext(actor).store.beginTurn({ actorId: actor, turnId, input });
    const session = await delegate.open({ ...request, state: { ...request.state, history: [...turn.priorMessages, input] as unknown as JsonValue } }, signal);
    return { next: async (value, nextSignal) => {
      if (value.type === 'tool_result') await turn.append([{ role: 'tool', tool_call_id: value.result.callId, content: JSON.stringify(value.result) }]);
      const decision = await session.next(value, nextSignal);
      if (decision.type === 'tool_call') await turn.append([{ role: 'assistant', content: null, tool_calls: [{ id: decision.call.id, type: 'function', function: { name: decision.call.tool, arguments: JSON.stringify(decision.call.arguments) } }] }]);
      else await turn.append([{ role: 'assistant', content: JSON.stringify(decision) }]);
      return decision;
    }, close: async (outcome, closeSignal) => {
      await session.close?.(outcome, closeSignal);
      await turn.finish(outcome === 'succeeded' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed');
      finished = true;
    } };
  } };
  return { driver, isComplete: () => !opened || finished };
}
function makeHandlers(options: { profile: PilotProfile; kernel: NativeKernel; context(actor: PilotActor, trace: string): SoAccessContext; state(): PilotState; sequence(): number; commit(event: PilotEvent): void }): SoToolHandler[] {
  const { profile, kernel } = options;
  const scope = z.object({ case_id: z.literal(CASE_ID), resource_version: z.literal(profile.resourceVersion) }).strict();
  const scopeInput: JsonObject = { type: 'object', properties: { case_id: { const: CASE_ID, type: 'string' }, resource_version: { const: profile.resourceVersion, type: 'string' } }, required: ['case_id', 'resource_version'], additionalProperties: false };
  function handler(name: string, surface: string, action: string, readWrite: 'read' | 'write', fn: (ctx: SoAccessContext, callId: string, args: JsonObject) => Promise<JsonValue>): SoToolHandler {
    return { definition: { name: `net.${name}`, description: `P-01 synthetic pilot ${name}`, namespace: NAMESPACE, source: 'sharedeval-net-pilot', readWrite, inputSchema: scopeInput, requiredCapability: requirement(surface, action) },
      parseArguments: args => scope.parse(args),
      invoke: async (ctx, call, signal) => {
        signal.throwIfAborted();
        try { return { status: 'succeeded', callId: call.id, tool: call.tool, output: await fn(ctx, call.id, call.arguments), completedAt: ctx.now }; }
        catch (error) { return { status: 'failed', callId: call.id, tool: call.tool, error: { code: 'pilot_action_rejected', message: error instanceof Error ? error.message : 'pilot_action_rejected' }, completedAt: ctx.now }; }
      },
    };
  }
  const tools: SoToolHandler[] = [handler('read_case', 'public', 'read', 'read', async () => publicState(options.state()))];
  for (const actor of ACTORS) tools.push(handler(`read_private_${actor}`, `private-${actor}`, 'read', 'read', async () => privateProjection(profile, actor)));
  for (const action of Object.keys(ACTION_OWNER) as PilotAction[]) tools.push(handler(action, action, action, 'write', async (ctx, callId) => {
    if (ctx.actor.kind !== 'agent' || !ACTORS.includes(ctx.actor.agentId as PilotActor)) throw new Error('pilot_actor_invalid');
    if (action === 'release_po') {
      // Recheck current owner authority through SharedOS, alongside version-bound evidence in the reducer.
      for (const [actor, approvalAction] of [[ACTORS[1], 'approve_budget'], [ACTORS[2], 'verify_signed_contract']] as const) {
        const decision = await kernel.authorize(options.context(actor, ctx.traceId), requirement(approvalAction, approvalAction));
        if (!decision.allowed) throw new Error('pilot_approval_authority_revoked');
      }
    }
    const event = buildEvent(profile, options.state(), action, ctx.actor.agentId as PilotActor, callId, ctx.traceId, ctx.now, options.sequence());
    options.commit(event);
    return { committed: true, action, receipt: event.approval ?? null, sequence: event.sequence, public_state: publicState(options.state()) };
  }));
  const send = handler('send_message', 'messaging', 'send', 'write', async (ctx, callId, args) => {
    const result = await kernel.sendMessage(ctx, { version: '1', id: `message-${callId}`, sender: ctx.actor, receiver: actorAddress(String(args.recipient)), purpose: ctx.purpose, payload: args.payload!, traceId: ctx.traceId, createdAt: ctx.now });
    return result as unknown as JsonValue;
  });
  const sendSchema = z.object({ recipient: z.string().min(1).max(128), payload: z.object({ stage: z.string().min(1).max(40), case_id: z.literal(CASE_ID), receipt: z.record(z.union([z.string(), z.number()])).optional() }).strict() }).strict();
  const sendHandler: SoToolHandler = { ...send, parseArguments: (args: JsonObject) => sendSchema.parse(args) };
  send.definition.inputSchema = { type: 'object', properties: { recipient: { type: 'string' }, payload: { type: 'object', properties: { stage: { type: 'string' }, case_id: { type: 'string', const: CASE_ID }, receipt: { type: 'object' } }, required: ['stage', 'case_id'], additionalProperties: false } }, required: ['recipient', 'payload'], additionalProperties: false };
  tools.push(sendHandler);
  return tools;
}
async function atomicJson(directory: string, name: string, value: unknown) {
  const staged = join(directory, `.stage-${randomUUID()}`);
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(staged, join(directory, name));
  const dirHandle = await open(directory, 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}
