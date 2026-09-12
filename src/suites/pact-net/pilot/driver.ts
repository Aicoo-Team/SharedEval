import type { JsonObject } from '../../../contracts/json.js';
import type { SoTurnDriver } from '../../../execution/sharedos/v1/contracts.js';
import type { PilotDriverFactory } from './session.js';
import { profileRoles } from './profile.js';

export type DriverObservation = Parameters<SoTurnDriver['open']>[0];
/** Scripted provider seam: only this actor's runtime request is observable. No gold or profile closure. */
export function scriptedPilotDriver(observe?: (request: DriverObservation) => void): PilotDriverFactory {
  return actor => ({ open: async request => {
    observe?.(structuredClone(request));
    const view = request.state?.actor_view as JsonObject;
    const stage = (request.message.payload as JsonObject).stage;
    const assignment = request.state!.assignment as JsonObject | undefined;
    // Historical P-01 requests have no assignment field; preserve that provider input.
    const roles = (assignment?.roles ?? profileRoles()) as Record<string, string>;
    const role = String(assignment?.role ?? Object.entries(roles).find(([, owner]) => owner === actor)?.[0]);
    const scope = { case_id: view.case_id, resource_version: view.resource_version } as JsonObject;
    const steps: Array<{ tool: string; args: JsonObject }> = [];
    const action = (name: string) => steps.push({ tool: `net.${name}`, args: scope });
    const send = (recipient: string, nextStage: string) => steps.push({ tool: 'net.send_message', args: { recipient, payload: { stage: nextStage, case_id: view.case_id } } });
    action(`read_private_${actor}`); action('read_case');
    if (role === 'requester' && stage === 'start') { action('match_records'); send(roles.budget, 'budget'); }
    if (role === 'budget' && stage === 'budget') {
      if (view.approved === true) { action('approve_budget'); send(roles.legal, 'contract'); }
      else send(roles.requester, 'finalize');
    }
    if (role === 'legal' && stage === 'contract') {
      if (view.signed === true) action('verify_signed_contract');
      send(roles.requester, 'finalize');
    }
    if (role === 'requester' && stage === 'finalize') {
      if ((request.state?.public_state as JsonObject).contract_verified === true) action('release_po');
      action('write_audit_record'); send(roles.budget, 'observe'); send(roles.legal, 'observe');
    }
    if ((role === 'budget' || role === 'legal') && stage === 'observe') send(roles.requester, 'observed');
    let index = 0;
    let receipt: JsonObject | undefined;
    return { next: async input => {
      if (input.type === 'tool_result' && (input.result.status !== 'succeeded' || ['denied', 'failed'].includes(String((input.result.output as JsonObject | undefined)?.status)))) return { type: 'fail', error: { code: 'pilot_script_tool_failed', message: `Required tool ${input.result.tool} failed` } };
      if (input.type === 'tool_result' && (input.result.output as JsonObject | undefined)?.receipt) receipt = (input.result.output as JsonObject).receipt as JsonObject;
      const step = steps[index++];
      if (step?.tool === 'net.send_message' && receipt) step.args.payload = { ...(step.args.payload as JsonObject), receipt };
      if (!step) return { type: 'complete', output: { actor, stage: String(stage), outcome: 'turn-complete', terminal_success: (request.state?.public_state as JsonObject).status === 'released' } };
      return { type: 'tool_call', call: { id: `${request.executionId}-call-${index}`, tool: step.tool, arguments: step.args, traceId: request.context.traceId, requestedAt: request.context.now } };
    } };
  } });
}
