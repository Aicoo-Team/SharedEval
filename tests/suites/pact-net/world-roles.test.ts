import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { JsonObject } from '../../../src/contracts/json.js';
import type { SoToolResult, SoTurnInput } from '../../../src/execution/sharedos/v1/contracts.js';
import { defaultSharedOsDirV1 } from '../../../src/execution/sharedos/v1/load-sharedos.js';
import { scriptedPilotDriver, type DriverObservation } from '../../../src/suites/pact-net/pilot/driver.js';
import { digest } from '../../../src/suites/pact-net/pilot/profile.js';
import type { PilotDriverFactory } from '../../../src/suites/pact-net/pilot/session.js';
import { createProcurementWorldProfile, loadProcurementWorldProfile } from '../../../src/suites/pact-net/world/profile.js';
import { openNetWorld } from '../../../src/suites/pact-net/world/session.js';

const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js'))
  ? 'Pinned SharedOS is unavailable' : false;

async function rotatedProfile(mode: 'multi' | 'single') {
  const input = structuredClone(await loadProcurementWorldProfile(
    join(import.meta.dirname, `fixtures/procurement-world-${mode}.json`),
  ));
  const second = input.cases[1]!;
  const previousRoles = { ...second.roles };
  second.roles = {
    requester: previousRoles.budget,
    budget: previousRoles.legal,
    legal: previousRoles.requester,
  };
  const replacement = new Map(Object.entries(previousRoles).map(([role, actor]) => [
    actor, second.roles[role as keyof typeof second.roles],
  ]));
  second.topology.edges = second.topology.edges.map(edge => ({
    from: replacement.get(edge.from)!, to: replacement.get(edge.to)!,
  }));
  second.initial.requisition.requester = second.roles.requester;
  second.initial.budget.owner = second.roles.budget;
  second.initial.contract.owner = second.roles.legal;
  second.resourceVersion = digest(second.initial);
  for (const [key, role] of [['requester', 'requester'], ['budget', 'budget'], ['contract', 'legal']] as const) {
    const evidence = second.evidence[key];
    evidence.owner = second.roles[role];
    evidence.case_id = second.initial.case_id;
    evidence.resource_version = second.resourceVersion;
    evidence.private_canary = `${evidence.owner.toUpperCase()}-PRIVATE-SYN003-ROTATED`;
  }
  return createProcurementWorldProfile(input);
}

function probeFormerBudgetOwner(caseId: string, formerBudgetOwner: string, observations: DriverObservation[]) {
  const results: Array<{ actor: string; caseId: string; probe: boolean; result: SoToolResult }> = [];
  const base = scriptedPilotDriver(request => observations.push(request));
  const createDriver: PilotDriverFactory = actor => ({
    open: async (request, signal) => {
      const delegate = await base(actor).open(request, signal);
      const view = request.state!.actor_view as JsonObject;
      const shouldProbe = view.case_id === caseId && actor === formerBudgetOwner
        && (request.message.payload as JsonObject).stage === 'start';
      let firstInput: SoTurnInput | undefined;
      let awaitingProbe = false;
      return {
        next: async (input, nextSignal) => {
          if (shouldProbe && !firstInput) {
            firstInput = input;
            awaitingProbe = true;
            return {
              type: 'tool_call',
              call: {
                id: `${request.executionId}-former-budget-owner-probe`, tool: 'net.approve_budget',
                arguments: { case_id: view.case_id, resource_version: view.resource_version },
                traceId: request.context.traceId, requestedAt: request.context.now,
              },
            };
          }
          if (awaitingProbe) {
            assert.equal(input.type, 'tool_result');
            if (input.type === 'tool_result') {
              results.push({ actor, caseId, probe: true, result: structuredClone(input.result) });
            }
            awaitingProbe = false;
            return delegate.next(firstInput!, nextSignal);
          }
          if (input.type === 'tool_result' && input.result.tool === 'net.approve_budget') {
            results.push({ actor, caseId: String(view.case_id), probe: false, result: structuredClone(input.result) });
          }
          return delegate.next(input, nextSignal);
        },
        close: delegate.close?.bind(delegate),
      };
    },
  });
  return { createDriver, results };
}

for (const mode of ['multi', 'single'] as const) {
  test(`${mode} preserves actor history ownership while rotated case roles receive fresh action grants`, { skip }, async () => {
    const profile = await rotatedProfile(mode);
    const [firstCase, secondCase] = profile.cases;
    assert.ok(firstCase && secondCase);
    assert.deepEqual(secondCase.roles, {
      requester: 'owen_budget', budget: 'lina_legal', legal: 'marina_procurement',
    });
    const observations: DriverObservation[] = [];
    const driver = probeFormerBudgetOwner(secondCase.initial.case_id, firstCase.roles.budget, observations);
    const directory = await mkdtemp(join(tmpdir(), 'net-world-roles-'));
    try {
      const session = await openNetWorld({
        directory, runId: 'world-role-regression', profile, createDriver: driver.createDriver,
      });
      try {
        let drained = false;
        for (let turn = 0; turn < 40; turn++) {
          if (!await session.runNext()) { drained = true; break; }
        }
        assert.ok(drained, 'the rotated case must finish within the bounded turn budget');
        const final = session.snapshot();
        assert.equal(final.world_complete, true);
        assert.equal(final.terminal_success, true);
        assert.deepEqual(final.cases.map(entry => entry.final_state.status), ['released', 'released']);

        for (const [role, actor] of Object.entries(secondCase.roles)) {
          const firstRequest = observations.find(request => request.agent.agentId === actor
            && (request.state!.actor_view as JsonObject).case_id === secondCase.initial.case_id);
          assert.ok(firstRequest, `missing first case B request for ${actor}`);
          const assignment = firstRequest.state!.assignment as JsonObject;
          assert.equal(assignment.role, role);
          assert.deepEqual(assignment.roles, secondCase.roles);
          const tools = new Set(firstRequest.tools.map(tool => tool.name));
          assert.equal(tools.has('net.match_records'), role === 'requester');
          assert.equal(tools.has('net.approve_budget'), role === 'budget');
          assert.equal(tools.has('net.verify_signed_contract'), role === 'legal');
          assert.equal(tools.has('net.release_po'), role === 'requester');
          assert.equal(tools.has('net.write_audit_record'), role === 'requester');

          const history = firstRequest.state!.history as unknown[];
          assert.ok(Array.isArray(history));
          assert.equal(history.length > 1, mode === 'multi');
          if (mode === 'single') assert.equal(history.length, 1, 'Single starts with only the current turn input');
          const previous = JSON.stringify(history.slice(0, -1));
          const actorEvidence = Object.values(firstCase.evidence).find(evidence => evidence.owner === actor)!;
          assert.equal(previous.includes(actorEvidence.private_canary), mode === 'multi', `${actor} must retain only its own prior role evidence`);
          const currentEvidence = Object.values(secondCase.evidence).find(evidence => evidence.owner === actor)!;
          assert.equal((firstRequest.state!.actor_view as JsonObject).private_canary, currentEvidence.private_canary);
          const visibleRequest = JSON.stringify(firstRequest);
          for (const caseProfile of profile.cases) {
            for (const evidence of Object.values(caseProfile.evidence)) {
              if (evidence.owner !== actor) {
                assert.ok(!visibleRequest.includes(evidence.private_canary), `foreign evidence crossed the role change into ${actor}`);
              }
            }
          }
        }

        const priorOwnerAttempts = driver.results.filter(entry => entry.probe);
        assert.equal(priorOwnerAttempts.length, 1);
        assert.equal(priorOwnerAttempts[0]!.actor, firstCase.roles.budget);
        assert.equal(priorOwnerAttempts[0]!.result.status, 'denied');
        const currentOwnerApprovals = driver.results.filter(entry => !entry.probe && entry.caseId === secondCase.initial.case_id);
        assert.equal(currentOwnerApprovals.length, 1);
        assert.equal(currentOwnerApprovals[0]!.actor, secondCase.roles.budget);
        assert.equal(currentOwnerApprovals[0]!.result.status, 'succeeded');
        const budgetEvents = final.cases[1]!.event_log.filter(event => event.action === 'approve_budget');
        assert.equal(budgetEvents.length, 1);
        assert.equal(budgetEvents[0]!.actor, secondCase.roles.budget);
        assert.equal(budgetEvents[0]!.case_id, secondCase.initial.case_id);
        assert.equal(budgetEvents[0]!.resource_version, secondCase.resourceVersion);
      } finally { await session.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
