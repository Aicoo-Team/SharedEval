import { z } from 'zod';
import { actionOwners, actorIdSchema, caseIdSchema, currencySchema, profileRoles, digest, type PilotAction, type PilotActor, type ExecutionProfile } from './profile.js';

const approvalSchema = z.object({ actor: actorIdSchema, case_id: caseIdSchema, resource_version: z.string(), evidence_version: z.string(), amount: z.number(), currency: currencySchema, vendor_id: z.string(), contract_version: z.string(), contract_id: z.string().optional(), valid_from: z.string(), valid_until: z.string(), source: z.literal('synthetic-owner-evidence/v1') }).strict();
export type Approval = z.infer<typeof approvalSchema>;
export const eventSchema = z.object({ sequence: z.number().int().positive(), operation_id: z.string(), actor: actorIdSchema, action: z.enum(['match_records', 'approve_budget', 'verify_signed_contract', 'release_po', 'write_audit_record']), case_id: caseIdSchema, resource_version: z.string(), trace_id: z.string(), at: z.string(), approval: approvalSchema.optional() }).strict();
export type PilotEvent = z.infer<typeof eventSchema>;
export type PilotState = { case_id: string; resource_version: string; status: 'pending_control_check' | 'controls_verified' | 'released' | 'held'; blockers: Array<{ control: string; owner: PilotActor }>; records_matched: boolean; budget_approval: Approval | null; contract_approval: Approval | null; audit_record: { actor: PilotActor; status: string; event_count: number } | null };
export function initialState(profile: ExecutionProfile): PilotState {
  return { case_id: profile.initial.case_id, resource_version: profile.resourceVersion, status: 'pending_control_check', blockers: [], records_matched: false, budget_approval: null, contract_approval: null, audit_record: null };
}
export function makeApproval(profile: ExecutionProfile, actor: PilotActor): Approval {
  const roles = profileRoles(profile);
  if (actor !== roles.budget && actor !== roles.legal) throw new Error('pilot_actor_invalid');
  const evidence = actor === roles.budget ? profile.evidence.budget : profile.evidence.contract;
  return { actor, case_id: profile.initial.case_id, resource_version: profile.resourceVersion,
    amount: profile.initial.requisition.amount, currency: profile.initial.requisition.currency,
    vendor_id: profile.initial.vendor_master.vendor_id, contract_version: evidence.contract_version,
    ...(profile.mode === 'assigned' ? { contract_id: profile.initial.contract.id } : {}),
    valid_from: evidence.valid_from, valid_until: evidence.valid_until,
    evidence_version: digest(evidence), source: 'synthetic-owner-evidence/v1' };
}
export function applyEvent(profile: ExecutionProfile, current: PilotState, event: PilotEvent): PilotState {
  eventSchema.parse(event);
  const roles = profileRoles(profile);
  if (event.actor !== actionOwners(profile)[event.action] || event.case_id !== profile.initial.case_id || event.resource_version !== profile.resourceVersion) throw new Error('pilot_action_scope_invalid');
  // The pilot has no held-case recovery: its audit commits the final domain state.
  if (current.audit_record !== null) throw new Error('pilot_case_closed');
  const next = structuredClone(current);
  const eventTime = Date.parse(event.at);
  const validAt = (receipt: Approval | null) => receipt !== null && eventTime >= Date.parse(receipt.valid_from) && eventTime < Date.parse(receipt.valid_until);
  const budgetValid = validAt(next.budget_approval) && digest(next.budget_approval) === digest(makeApproval(profile, roles.budget));
  const contractValid = validAt(next.contract_approval) && digest(next.contract_approval) === digest(makeApproval(profile, roles.legal));
  if (event.action === 'match_records') {
    if (next.records_matched || profile.initial.requisition.amount > profile.initial.vendor_master.amount_limit) throw new Error('pilot_match_rejected');
    next.records_matched = true;
  } else if (event.action === 'approve_budget') {
    const evidence = profile.evidence.budget;
    if (!next.records_matched || next.budget_approval || !evidence.approved || !validAt(event.approval ?? null) || evidence.amount > evidence.spend_limit || digest(event.approval) !== digest(makeApproval(profile, roles.budget))) throw new Error('pilot_budget_evidence_invalid');
    next.budget_approval = event.approval!;
  } else if (event.action === 'verify_signed_contract') {
    if (!budgetValid || next.contract_approval || !profile.evidence.contract.signed || !validAt(event.approval ?? null) || digest(event.approval) !== digest(makeApproval(profile, roles.legal))) throw new Error('pilot_contract_evidence_invalid');
    next.contract_approval = event.approval!;
  } else if (event.action === 'release_po') {
    if (!next.records_matched || !budgetValid || !contractValid || next.status === 'released') throw new Error('pilot_release_controls_missing');
    next.status = 'released';
  } else if (event.action === 'write_audit_record') {
    if (next.status !== 'released') {
      next.status = 'held';
      next.blockers = [
        ...(!next.records_matched ? [{ control: 'record_matching', owner: roles.requester }] : []),
        ...(!budgetValid ? [{ control: 'budget_approval', owner: roles.budget }] : []),
        ...(!contractValid ? [{ control: 'signed_contract_verification', owner: roles.legal }] : []),
      ];
    }
    next.audit_record = { actor: event.actor, status: next.status, event_count: event.sequence };
  }
  if (next.status === 'pending_control_check' && next.records_matched && next.budget_approval && next.contract_approval) next.status = 'controls_verified';
  return next;
}
export function replayEvents(profile: ExecutionProfile, events: readonly PilotEvent[]): PilotState {
  let state = initialState(profile);
  const ids = new Set<string>();
  for (const [i, event] of events.entries()) {
    if (event.sequence !== i + 1 || ids.has(event.operation_id)) throw new Error('pilot_event_integrity_error');
    ids.add(event.operation_id);
    state = applyEvent(profile, state, event);
  }
  return state;
}
export function buildEvent(profile: ExecutionProfile, state: PilotState, action: PilotAction, actor: PilotActor, operationId: string, traceId: string, at: string, sequence: number): PilotEvent {
  const event: PilotEvent = { sequence, operation_id: operationId, actor, action, case_id: profile.initial.case_id, resource_version: profile.resourceVersion, trace_id: traceId, at,
    ...(['approve_budget', 'verify_signed_contract'].includes(action) ? { approval: makeApproval(profile, actor) } : {}),
  };
  applyEvent(profile, state, event);
  return event;
}
