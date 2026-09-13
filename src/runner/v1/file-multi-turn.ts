import { z } from 'zod';
import type { FileWorkflowRunBindingV1 } from './file-workflow-artifacts.js';
import type { FileWorkflowLedgerRecordV1 } from './file-workflow-ledger.js';

export const FIRST_ASK_COVERAGE_PROTOCOL_V2 = 'first-ask-coverage/v2' as const;

// No defaults: legacy bindings and configuration digests retain their exact shape.
export const fileMultiTurnSchema = z.union([
  z.object({
    phase2StartTick: z.number().int().safe().min(2).max(10_000),
    finalizeTick: z.number().int().safe().min(2).max(10_000),
  }).strict(),
  z.object({
    protocol: z.literal(FIRST_ASK_COVERAGE_PROTOCOL_V2),
    finalizeTick: z.number().int().safe().min(2).max(10_000),
  }).strict(),
]);

export type FileMultiTurn = Readonly<z.infer<typeof fileMultiTurnSchema>>;
export type FirstAskCoverageV2 = Extract<FileMultiTurn, { protocol: string }>;
export type FileFirstAskProgressV2 = Readonly<{
  protocol: typeof FIRST_ASK_COVERAGE_PROTOCOL_V2;
  coveredTaskIds: readonly string[];
  uncoveredTaskIds: readonly string[];
  incompleteReplyTaskIds: readonly string[];
  phase: 1 | 2;
  finalization: boolean;
}>;

export function isFirstAskCoverageV2(value: FileMultiTurn): value is FirstAskCoverageV2 {
  return 'protocol' in value && value.protocol === FIRST_ASK_COVERAGE_PROTOCOL_V2;
}

export function validFileMultiTurn(value: FileMultiTurn, maxTicks: number): boolean {
  return fileMultiTurnSchema.safeParse(value).success
    && value.finalizeTick <= maxTicks
    && (isFirstAskCoverageV2(value) || value.phase2StartTick <= value.finalizeTick);
}

/** Input records must already have passed the ledger's full evidence validation. */
export function deriveFileMultiTurnProgress(input: Readonly<{
  binding: Pick<FileWorkflowRunBindingV1, 'actors' | 'selectedTaskIds'>;
  multiTurn: FileMultiTurn;
  tick: number;
  records: readonly Pick<FileWorkflowLedgerRecordV1, 'payload'>[];
}>): Readonly<{ phase: 1 | 2; finalization: boolean }> | FileFirstAskProgressV2 {
  const { multiTurn, tick, binding } = input;
  if (!isFirstAskCoverageV2(multiTurn)) {
    return { phase: tick < multiTurn.phase2StartTick ? 1 : 2,
      finalization: tick >= multiTurn.finalizeTick };
  }
  const accepted = new Set<string>();
  const replied = new Set<string>();
  for (const { payload } of input.records) {
    if (payload.event.tick >= tick || !payload.contactAuthority) continue;
    const contact = payload.contactAuthority;
    const source = payload.privateEvidence?.sourceEvidence;
    const request = source?.acceptedMessages.find(message => message.id === contact.contactId);
    const requestPayload = request?.payload;
    // A contact label or MEMORY note is not delivery evidence. Full consumed-grant
    // and operation causality are checked by the ledger before this projection.
    if (!request || request.replyTo !== undefined
      || request.sender.kind !== 'agent' || request.sender.agentId !== binding.actors.requester.actorId
      || request.receiver.kind !== 'agent' || request.receiver.agentId !== binding.actors.responder.actorId
      || request.traceId !== payload.event.traceId
      || !requestPayload || typeof requestPayload !== 'object' || Array.isArray(requestPayload)
      || (requestPayload as Record<string, unknown>)['taskId'] !== contact.taskId
      || !binding.selectedTaskIds.includes(contact.taskId)
      || !source?.auditEvents.some(event => event.type === 'message.sent'
        && event.messageId === request.id && event.operationId !== undefined)) {
      throw new Error('First-ask coverage requires retained accepted-request evidence');
    }
    accepted.add(contact.taskId);
    if (contact.replyMessageId && source.acceptedMessages.some(message => (
      message.id === contact.replyMessageId && message.replyTo === request.id
    ))) replied.add(contact.taskId);
  }
  const coveredTaskIds = binding.selectedTaskIds.filter(taskId => accepted.has(taskId));
  const uncoveredTaskIds = binding.selectedTaskIds.filter(taskId => !accepted.has(taskId));
  const phase = uncoveredTaskIds.length === 0 ? 2 : 1;
  return {
    protocol: FIRST_ASK_COVERAGE_PROTOCOL_V2, coveredTaskIds, uncoveredTaskIds,
    incompleteReplyTaskIds: coveredTaskIds.filter(taskId => !replied.has(taskId)),
    phase, finalization: phase === 2 && tick >= multiTurn.finalizeTick,
  };
}
