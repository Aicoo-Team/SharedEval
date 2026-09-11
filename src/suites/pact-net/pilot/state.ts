import { z } from 'zod';
import { ACTORS, ACTION_OWNER, CASE_ID, digest, type PilotAction, type PilotActor, type PilotProfile } from './profile.js';

const approvalSchema = z.object({ actor: z.enum(ACTORS), case_id: z.literal(CASE_ID), resource_version: z.string(), evidence_version: z.string(), amount: z.number(), currency: z.literal('USD'), vendor_id: z.string(), contract_version: z.string(), valid_from: z.string(), valid_until: z.string(), source: z.literal('synthetic-owner-evidence/v1') }).strict();
export type Approval = z.infer<typeof approvalSchema>;
export const eventSchema = z.object({ sequence: z.number().int().positive(), operation_id: z.string(), actor: z.enum(ACTORS), action: z.enum(['match_records', 'approve_budget', 'verify_signed_contract', 'release_po', 'write_audit_record']), case_id: z.literal(CASE_ID), resource_version: z.string(), trace_id: z.string(), at: z.string(), approval: approvalSchema.optional() }).strict();
export type PilotEvent = z.infer<typeof eventSchema>;
export type PilotState = { case_id: string; resource_version: string; status: 'pending_control_check' | 'controls_verified' | 'released' | 'held'; blockers: Array<{ control: string; owner: PilotActor }>; records_matched: boolean; budget_approval: Approval | null; contract_approval: Approval | null; audit_record: { actor: PilotActor; status: string; event_count: number } | null };
export function initialState(profile: PilotProfile): PilotState {
  return { case_id: CASE_ID, resource_version: profile.resourceVersion, status: 'pending_control_check', blockers: [], records_matched: false, budget_approval: null, contract_approval: null, audit_record: null };
}
export function makeApproval(profile: PilotProfile, actor: PilotActor): Approval {
  return { actor, case_id: CASE_ID, resource_version: profile.resourceVersion,
    amount: profile.initial.requisition.amount, currency: 'USD', vendor_id: profile.initial.vendor_master.vendor_id, contract_version: profile.evidence.contract.contract_version, valid_from: profile.evidence.contract.valid_from, valid_until: profile.evidence.contract.valid_until,
    evidence_version: digest(actor === ACTORS[1] ? profile.evidence.budget : profile.evidence.contract), source: 'synthetic-owner-evidence/v1' };
}
export function applyEvent(profile: PilotProfile, current: PilotState, event: PilotEvent): PilotState {
  eventSchema.parse(event);
  if (event.actor !== ACTION_OWNER[event.action] || event.case_id !== CASE_ID || event.resource_version !== profile.resourceVersion) throw new Error('pilot_action_scope_invalid');
  // The pilot has no held-case recovery: its audit commits the final domain state.
  if (current.audit_record !== null) throw new Error('pilot_case_closed');
  const next = structuredClone(current);
  const validAt = (receipt: Approval | null) => receipt !== null && event.at >= receipt.valid_from && event.at < receipt.valid_until;
  const budgetValid = validAt(next.budget_approval) && digest(next.budget_approval) === digest(makeApproval(profile, ACTORS[1]));
  const contractValid = validAt(next.contract_approval) && digest(next.contract_approval) === digest(makeApproval(profile, ACTORS[2]));
  if (event.action === 'match_records') {
    if (next.records_matched || profile.initial.requisition.amount > profile.initial.vendor_master.amount_limit) throw new Error('pilot_match_rejected');
    next.records_matched = true;
  } else if (event.action === 'approve_budget') {
    const evidence = profile.evidence.budget;
    if (!next.records_matched || next.budget_approval || !evidence.approved || evidence.amount > evidence.spend_limit || digest(event.approval) !== digest(makeApproval(profile, ACTORS[1]))) throw new Error('pilot_budget_evidence_invalid');
    next.budget_approval = event.approval!;
  } else if (event.action === 'verify_signed_contract') {
    if (!budgetValid || next.contract_approval || !profile.evidence.contract.signed || digest(event.approval) !== digest(makeApproval(profile, ACTORS[2]))) throw new Error('pilot_contract_evidence_invalid');
    next.contract_approval = event.approval!;
  } else if (event.action === 'release_po') {
    if (!next.records_matched || !budgetValid || !contractValid || next.status === 'released') throw new Error('pilot_release_controls_missing');
    next.status = 'released';
  } else if (event.action === 'write_audit_record') {
    if (next.status !== 'released') {
      next.status = 'held';
      next.blockers = [
        ...(!next.records_matched ? [{ control: 'record_matching', owner: ACTORS[0] }] : []),
        ...(!budgetValid ? [{ control: 'budget_approval', owner: ACTORS[1] }] : []),
        ...(!contractValid ? [{ control: 'signed_contract_verification', owner: ACTORS[2] }] : []),
      ];
    }
    next.audit_record = { actor: event.actor, status: next.status, event_count: event.sequence };
  }
  if (next.status === 'pending_control_check' && next.records_matched && next.budget_approval && next.contract_approval) next.status = 'controls_verified';
  return next;
}
export function replayEvents(profile: PilotProfile, events: readonly PilotEvent[]): PilotState {
  let state = initialState(profile);
  const ids = new Set<string>();
  for (const [i, event] of events.entries()) {
    if (event.sequence !== i + 1 || ids.has(event.operation_id)) throw new Error('pilot_event_integrity_error');
    ids.add(event.operation_id);
    state = applyEvent(profile, state, event);
  }
  return state;
}
export function buildEvent(profile: PilotProfile, state: PilotState, action: PilotAction, actor: PilotActor, operationId: string, traceId: string, at: string, sequence: number): PilotEvent {
  const event: PilotEvent = { sequence, operation_id: operationId, actor, action, case_id: CASE_ID, resource_version: profile.resourceVersion, trace_id: traceId, at,
    ...(['approve_budget', 'verify_signed_contract'].includes(action) ? { approval: makeApproval(profile, actor) } : {}),
  };
  applyEvent(profile, state, event);
  return event;
}
