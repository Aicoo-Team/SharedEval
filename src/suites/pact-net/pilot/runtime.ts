import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../../contracts/json.js';
import type { SoAccessContext, SoAddress, SoCapabilityRequirement, SoKernel, SoToolCall, SoToolDefinition, SoToolResult, SoToolHandler } from '../../../execution/sharedos/v1/contracts.js';
import type { WorldSession } from '../../../runner/world/session.js';
import { NAMESPACE, actionOwners, actorAddress, profileActors, profileRoles, privateProjection, requirement, type PilotActor, type ExecutionProfile, type PilotAction } from './profile.js';
import { buildEvent, type PilotEvent, type PilotState } from './state.js';
import type { PilotTurnDriver } from './session.js';

export type NativeKernel = SoKernel & {
  authorize(context: SoAccessContext, requirement: SoCapabilityRequirement): Promise<{ allowed: boolean }>;
  admitTurn(context: SoAccessContext, agent: SoAddress, options?: { signal?: AbortSignal }): Promise<unknown>;
  listTools(context: SoAccessContext, options?: { signal?: AbortSignal }): Promise<readonly SoToolDefinition[]>;
  invokeTool(context: SoAccessContext, call: SoToolCall, options?: { signal?: AbortSignal }): Promise<SoToolResult>;
  recordEscalation(context: SoAccessContext, reason: string, options?: { signal?: AbortSignal }): Promise<JsonObject>;
};

export function publicState(state: PilotState): JsonObject {
  return { case_id: state.case_id, resource_version: state.resource_version, status: state.status,
    records_matched: state.records_matched, budget_verified: state.budget_approval !== null,
    contract_verified: state.contract_approval !== null, budget_receipt: state.budget_approval, contract_receipt: state.contract_approval, blockers: state.blockers, audit_written: state.audit_record !== null };
}
export function journalDriver(world: WorldSession, actor: PilotActor, turnId: string, delegate: PilotTurnDriver) {
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
export function makeHandlers(options: { profile: ExecutionProfile; kernel: NativeKernel; context(actor: PilotActor, trace: string): SoAccessContext; state(): PilotState; sequence(): number; commit(event: PilotEvent): void; messageId?(context: SoAccessContext, callId: string): string }): SoToolHandler[] {
  const { profile, kernel } = options;
  const actors = profileActors(profile);
  const roles = profileRoles(profile);
  const caseId = profile.initial.case_id;
  const scope = z.object({ case_id: z.literal(caseId), resource_version: z.literal(profile.resourceVersion) }).strict();
  const scopeInput: JsonObject = { type: 'object', properties: { case_id: { const: caseId, type: 'string' }, resource_version: { const: profile.resourceVersion, type: 'string' } }, required: ['case_id', 'resource_version'], additionalProperties: false };
  function handler(name: string, surface: string, action: string, readWrite: 'read' | 'write', fn: (ctx: SoAccessContext, callId: string, args: JsonObject) => Promise<JsonValue>): SoToolHandler {
    return { definition: { name: `net.${name}`, description: `${profile.mode === 'assigned' ? 'Assigned procurement pilot' : 'P-01 synthetic pilot'} ${name}`, namespace: NAMESPACE, source: 'sharedeval-net-pilot', readWrite, inputSchema: scopeInput, requiredCapability: requirement(surface, action, profile) },
      parseArguments: args => scope.parse(args),
      invoke: async (ctx, call, signal) => {
        signal.throwIfAborted();
        try { return { status: 'succeeded', callId: call.id, tool: call.tool, output: await fn(ctx, call.id, call.arguments), completedAt: ctx.now }; }
        catch (error) { return { status: 'failed', callId: call.id, tool: call.tool, error: { code: 'pilot_action_rejected', message: error instanceof Error ? error.message : 'pilot_action_rejected' }, completedAt: ctx.now }; }
      },
    };
  }
  const tools: SoToolHandler[] = [handler('read_case', 'public', 'read', 'read', async () => publicState(options.state()))];
  for (const actor of actors) tools.push(handler(`read_private_${actor}`, `private-${actor}`, 'read', 'read', async () => privateProjection(profile, actor)));
  for (const action of Object.keys(actionOwners(profile)) as PilotAction[]) tools.push(handler(action, action, action, 'write', async (ctx, callId) => {
    if (ctx.actor.kind !== 'agent' || !actors.includes(ctx.actor.agentId)) throw new Error('pilot_actor_invalid');
    if (action === 'release_po') {
      // Recheck current owner authority through SharedOS, alongside version-bound evidence in the reducer.
      for (const [actor, approvalAction] of [[roles.budget, 'approve_budget'], [roles.legal, 'verify_signed_contract']] as const) {
        const decision = await kernel.authorize(options.context(actor, ctx.traceId), requirement(approvalAction, approvalAction, profile));
        if (!decision.allowed) throw new Error('pilot_approval_authority_revoked');
      }
    }
    const event = buildEvent(profile, options.state(), action, ctx.actor.agentId as PilotActor, callId, ctx.traceId, ctx.now, options.sequence());
    options.commit(event);
    return { committed: true, action, receipt: event.approval ?? null, sequence: event.sequence, public_state: publicState(options.state()) };
  }));
  const send = handler('send_message', 'messaging', 'send', 'write', async (ctx, callId, args) => {
    const result = await kernel.sendMessage(ctx, { version: '1', id: options.messageId?.(ctx, callId) ?? `message-${callId}`, sender: ctx.actor, receiver: actorAddress(String(args.recipient)), purpose: ctx.purpose, payload: args.payload!, traceId: ctx.traceId, createdAt: ctx.now });
    return result as unknown as JsonValue;
  });
  const sendSchema = z.object({ recipient: z.string().min(1).max(128), payload: z.object({ stage: z.string().min(1).max(40), case_id: z.literal(caseId), receipt: z.record(z.union([z.string(), z.number()])).optional() }).strict() }).strict();
  const sendHandler: SoToolHandler = { ...send, parseArguments: (args: JsonObject) => sendSchema.parse(args) };
  send.definition.inputSchema = { type: 'object', properties: { recipient: { type: 'string' }, payload: { type: 'object', properties: { stage: { type: 'string' }, case_id: { type: 'string', const: caseId }, receipt: { type: 'object' } }, required: ['stage', 'case_id'], additionalProperties: false } }, required: ['recipient', 'payload'], additionalProperties: false };
  tools.push(sendHandler);
  return tools;
}
export async function atomicJson(directory: string, name: string, value: unknown) {
  const staged = join(directory, `.stage-${randomUUID()}`);
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(staged, join(directory, name));
  const dirHandle = await open(directory, 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}
