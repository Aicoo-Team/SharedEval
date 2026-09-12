import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createAssignedProcurementProfile, loadAssignedProcurementProfile } from '../../../src/suites/pact-net/pilot/profile.js';
import { applyEvent, buildEvent, initialState } from '../../../src/suites/pact-net/pilot/state.js';

test('assigned approval expiry compares instants across valid ISO timestamp precisions', async () => {
  const fixture = await loadAssignedProcurementProfile(join(import.meta.dirname, 'fixtures/assigned-procurement.json'));
  const profile = createAssignedProcurementProfile({ ...fixture, evidence: { ...fixture.evidence,
    budget: { ...fixture.evidence.budget, valid_until: '2026-09-12T12:00:00Z' },
    contract: { ...fixture.evidence.contract, valid_until: '2026-09-13T12:00:00.000Z' },
  } });
  let state = initialState(profile);
  for (const [index, [action, actor]] of [
    ['match_records', profile.roles.requester], ['approve_budget', profile.roles.budget], ['verify_signed_contract', profile.roles.legal],
  ].entries()) {
    const event = buildEvent(profile, state, action as 'match_records' | 'approve_budget' | 'verify_signed_contract', actor!, `before-${index}`, 'trace', '2026-09-12T11:59:59.000Z', index + 1);
    state = applyEvent(profile, state, event);
  }
  assert.equal(state.status, 'controls_verified');
  assert.throws(() => buildEvent(profile, state, 'release_po', profile.roles.requester, 'late-release', 'trace', '2026-09-12T12:00:00.500Z', 4), /release_controls_missing/);
  const held = applyEvent(profile, state, buildEvent(profile, state, 'write_audit_record', profile.roles.requester, 'held-audit', 'trace', '2026-09-12T12:00:00.500Z', 4));
  assert.deepEqual(held.blockers, [{ control: 'budget_approval', owner: profile.roles.budget }]);
});

test('assigned receipt validity includes its start and excludes its end across supported precisions', async () => {
  const fixture = await loadAssignedProcurementProfile(join(import.meta.dirname, 'fixtures/assigned-procurement.json'));
  for (const fraction of ['', '.0', '.00', '.000']) {
    const profile = createAssignedProcurementProfile({ ...fixture, evidence: { ...fixture.evidence,
      budget: { ...fixture.evidence.budget, valid_from: `2026-09-12T12:00:00${fraction}Z`, valid_until: `2026-09-12T12:00:01${fraction}Z` },
    } });
    const state = applyEvent(profile, initialState(profile), buildEvent(profile, initialState(profile), 'match_records', profile.roles.requester, 'match', 'trace', '2026-09-12T11:59:59.000Z', 1));
    const approve = (at: string) => buildEvent(profile, state, 'approve_budget', profile.roles.budget, 'approve', 'trace', at, 2);
    assert.throws(() => approve('2026-09-12T11:59:59.999Z'), /budget_evidence_invalid/);
    assert.doesNotThrow(() => approve('2026-09-12T12:00:00.000Z'));
    assert.doesNotThrow(() => approve('2026-09-12T12:00:00.999Z'));
    assert.throws(() => approve('2026-09-12T12:00:01.000Z'), /budget_evidence_invalid/);
  }
});
