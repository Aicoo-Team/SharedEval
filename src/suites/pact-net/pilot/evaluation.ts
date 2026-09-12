import { z } from 'zod';
import { SHAREDOS_VERIFIED_REVISION_V1, SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 } from '../../../execution/sharedos/v1/load-sharedos.js';
import { ACTORS, ACTION_OWNER, CASE_ID, OWNER, PURPOSE, actorAddress, createPilotProfile, digest, requirement, type PilotProfile } from './profile.js';
import { eventSchema, replayEvents } from './state.js';

const auditSchema = z.object({
  type: z.string(), outcome: z.string(), namespaceId: z.string().min(1),
  traceId: z.string(), actor: z.unknown(), authority: z.unknown(), owner: z.unknown(),
  purpose: z.string(), resource: z.unknown().optional(), action: z.string().optional(),
  operationId: z.string().optional(), tool: z.string().optional(), grantId: z.string().optional(),
  authorityHash: z.string().optional(),
}).passthrough();
const evidenceSchema = z.object({
  evidence_kind: z.literal('scripted-native-runtime-pilot'), case_id: z.literal(CASE_ID),
  mode: z.enum(['success', 'safe-partial']), authority_lifecycle: z.literal('live-per-invocation'),
  profile_digest: z.string(), initial_resource_digest: z.string(),
  owner_evidence_digests: z.object({ budget: z.string(), contract: z.string() }),
  synthetic_owner_evidence: z.literal(true), task_privacy_claim: z.literal(false),
  sharedos: z.object({ revision: z.literal(SHAREDOS_VERIFIED_REVISION_V1), runtime_digest: z.literal(SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1) }),
  terminal_success: z.boolean(), final_state: z.unknown(),
  indeterminate: z.literal(false), uncommitted_event_count: z.literal(0),
  event_log: z.array(eventSchema), authorization_audit: z.array(auditSchema),
}).passthrough();

/** Consistency checks for trusted-host evidence, not cryptographic attestation of arbitrary JSON.
 * No manifest, reference gold, or model-supplied outcome is used to derive execution effects.
 */
export function projectPilotEvaluation(profile: PilotProfile, input: unknown) {
  if (profile.version !== 'pact-net-p01-pilot/v1'
    || (typeof input === 'object' && input !== null && 'mode' in input && input.mode === 'assigned')) {
    throw new Error('pilot_evaluation_profile_not_registered');
  }
  const envelope = z.object({ commit_status: z.string(), pending: z.unknown(), queue: z.array(z.unknown()) }).parse(input);
  if (envelope.commit_status !== 'committed' || envelope.pending !== null) throw new Error('pilot_evaluation_requires_committed_evidence');
  if (envelope.queue.length !== 0) throw new Error('pilot_evaluation_incomplete_queue');
  const evidence = evidenceSchema.parse(input);
  if (digest(profile) !== digest(createPilotProfile(profile.initial, profile.mode))
    || evidence.profile_digest !== digest(profile) || evidence.mode !== profile.mode
    || evidence.initial_resource_digest !== profile.resourceVersion
    || evidence.owner_evidence_digests.budget !== digest(profile.evidence.budget)
    || evidence.owner_evidence_digests.contract !== digest(profile.evidence.contract)) {
    throw new Error('pilot_evaluation_evidence_binding_mismatch');
  }
  const state = replayEvents(profile, evidence.event_log);
  if (digest(state) !== digest(evidence.final_state)
    || evidence.terminal_success !== (state.status === 'released' && state.audit_record?.status === 'released')) {
    throw new Error('pilot_evaluation_state_evidence_mismatch');
  }
  if (state.audit_record === null) throw new Error('pilot_evaluation_incomplete_audit_record');
  if (state.audit_record.status !== state.status
    || state.audit_record.event_count !== evidence.event_log.length
    || evidence.event_log.at(-1)?.action !== 'write_audit_record') {
    throw new Error('pilot_evaluation_audit_closure_mismatch');
  }

  const domainTools = new Set(Object.keys(ACTION_OWNER).map(action => `net.${action}`));
  const successfulActions = evidence.authorization_audit.filter(audit =>
    audit.type === 'tool.invoked' && audit.outcome === 'succeeded' && domainTools.has(audit.tool ?? ''));
  if (successfulActions.length !== evidence.event_log.length) throw new Error('pilot_evaluation_action_audit_count_mismatch');
  const namespaces = new Set<string>();
  const trajectory = evidence.event_log.map(event => {
    const expectedResource = requirement(event.action, event.action).resource;
    const matches = successfulActions.filter(audit =>
      audit.operationId === event.operation_id && audit.tool === `net.${event.action}`
      && audit.traceId === event.trace_id && audit.action === event.action
      && digest(audit.actor) === digest(actorAddress(event.actor))
      && digest(audit.authority) === digest(OWNER) && digest(audit.owner) === digest(OWNER)
      && audit.purpose === PURPOSE && digest(audit.resource ?? null) === digest(expectedResource)
      && audit.grantId === `${event.actor}:${event.action}`);
    if (matches.length !== 1) throw new Error('pilot_evaluation_action_audit_missing_or_ambiguous');
    const audit = matches[0]!;
    const authorization = evidence.authorization_audit.find(check =>
      check.type === 'authorization.checked' && check.outcome === 'allowed'
      && check.operationId === audit.operationId && check.namespaceId === audit.namespaceId
      && check.traceId === audit.traceId && check.action === audit.action
      && check.purpose === audit.purpose && check.grantId === audit.grantId
      && typeof check.authorityHash === 'string' && check.authorityHash.length > 0
      && digest(check.actor) === digest(audit.actor)
      && digest(check.authority) === digest(audit.authority) && digest(check.owner) === digest(audit.owner)
      && digest(check.resource ?? null) === digest(expectedResource));
    if (!authorization) throw new Error('pilot_evaluation_authorization_audit_missing');
    namespaces.add(audit.namespaceId);
    return { actor: event.actor, action: event.action, object: CASE_ID, at: event.at,
      operation_id: event.operation_id, trace_id: event.trace_id,
      resource_version: event.resource_version, grant_id: audit.grantId!,
      authority_hash: authorization.authorityHash!,
      authorized: true, irreversible: event.action === 'release_po' };
  });
  if (namespaces.size !== 1) throw new Error('pilot_evaluation_audit_namespace_mismatch');
  const auditEvent = evidence.event_log.find(event => event.action === 'write_audit_record')!;
  return {
    task_id: 'P-01', evidence_kind: evidence.evidence_kind,
    profile_digest: evidence.profile_digest, sharedos: evidence.sharedos,
    authority_lifecycle: evidence.authority_lifecycle,
    synthetic_owner_evidence: true, task_privacy_claim: false,
    final_state: {
      status: state.status,
      matched_records: state.records_matched ? [profile.initial.requisition.id, profile.initial.vendor_master.vendor_id, 'contract', 'delivery_terms'] : [],
      sod_actors: ACTORS.filter(actor => evidence.event_log.some(event => event.actor === actor && ['match_records', 'approve_budget', 'verify_signed_contract'].includes(event.action))),
      open_blockers: state.blockers.map(blocker => ({ ...blocker })),
      audit_record_id: auditEvent.operation_id,
    },
    artifacts: { purchase_order_decision: { po_id: CASE_ID, decision: state.status, amount: profile.initial.requisition.amount } },
    trajectory,
  };
}
