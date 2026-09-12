import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createAssignedProcurementProfile, digest, loadPilotProfile, validateExecutionProfile,
  type AssignedProcurementProfile,
} from '../../../src/suites/pact-net/pilot/profile.js';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = join(import.meta.dirname, 'fixtures/assigned-procurement.json');
async function fixture(): Promise<AssignedProcurementProfile> {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}
function assertInvalid(input: unknown, reason: RegExp, label: string) {
  for (const parse of [createAssignedProcurementProfile, validateExecutionProfile]) {
    assert.throws(() => parse(input), error => {
      assert.ok(error instanceof Error, label);
      assert.equal(error.message, 'pilot_profile_invalid', label);
      assert.match(String(error.cause), reason, label);
      return true;
    });
  }
}

test('assigned profile parses into an independent JSON value without changing the input', async () => {
  const input = await fixture();
  const original = structuredClone(input);
  for (const parse of [createAssignedProcurementProfile, validateExecutionProfile]) {
    const profile = parse(input);
    assert.deepEqual(profile, original);
    assert.notEqual(profile, input);
    assert.equal(profile.mode, 'assigned');
    if (profile.mode !== 'assigned') throw new Error('assigned profile expected');
    profile.roles.requester = 'changed_actor';
    profile.initial.requisition.amount = 1;
    profile.topology.edges[0]!.to = 'changed_actor';
    profile.evidence.budget.private_canary = 'changed evidence';
    assert.deepEqual(input, original);
  }
});

test('assigned profile rejects colliding roles and initial resources owned by another actor', async () => {
  for (const role of ['budget', 'legal'] as const) {
    const input = await fixture();
    input.roles[role] = input.roles.requester;
    assertInvalid(input, /three distinct actors/, role);
  }
  for (const role of ['requester', 'budget', 'legal'] as const) {
    const input = await fixture();
    if (role === 'requester') input.initial.requisition.requester = 'outside_actor';
    else if (role === 'budget') input.initial.budget.owner = 'outside_actor';
    else input.initial.contract.owner = 'outside_actor';
    input.resourceVersion = digest(input.initial);
    for (const evidence of Object.values(input.evidence)) evidence.resource_version = input.resourceVersion;
    assertInvalid(input, /initial resource owner mismatch/, role);
  }
});

test('assigned profile binds its resource digest to the actual initial state', async () => {
  const input = await fixture();
  input.resourceVersion = '0'.repeat(64);
  for (const evidence of Object.values(input.evidence)) evidence.resource_version = input.resourceVersion;
  assertInvalid(input, /initial resource digest mismatch/, 'forged resource digest');
});

test('assigned profile rejects evidence with a different resource digest, case or owner for every role', async () => {
  for (const role of ['requester', 'budget', 'contract'] as const) {
    for (const [key, value] of [['resource_version', '0'.repeat(64)], ['case_id', 'SYN-PO-OTHER'], ['owner', 'outside_actor']] as const) {
      const input = await fixture();
      input.evidence[role][key] = value;
      assertInvalid(input, new RegExp(`${role} evidence scope mismatch`), `${role}.${key}`);
    }
  }
});

test('assigned profile rejects control evidence for a different amount, currency, vendor or contract revision', async () => {
  for (const role of ['budget', 'contract'] as const) {
    for (const change of [
      { amount: 42001 }, { currency: 'USD' }, { vendor_id: 'SYN-VEN-OTHER' },
      { contract_id: 'SYN-CON-OTHER' }, { contract_version: 'revision-8' },
    ]) {
      const input = await fixture();
      Object.assign(input.evidence[role], change);
      assertInvalid(input, /control evidence resource mismatch/, `${role}.${Object.keys(change)[0]}`);
    }
  }
});

test('assigned profile rejects duplicate, self-directed and out-of-profile topology edges', async () => {
  const mutations: Array<[string, (input: AssignedProcurementProfile) => void]> = [
    ['duplicate', input => { input.topology.edges.push({ ...input.topology.edges[0]! }); }],
    ['self', input => { input.topology.edges[0]!.to = input.topology.edges[0]!.from; }],
    ['outside sender', input => { input.topology.edges[0]!.from = 'outside_actor'; }],
    ['outside recipient', input => { input.topology.edges[0]!.to = 'outside_actor'; }],
  ];
  for (const [label, mutate] of mutations) {
    const input = await fixture();
    mutate(input);
    assertInvalid(input, /invalid assigned topology/, label);
  }
});

test('assigned profile rejects unknown JSON fields throughout its configuration and evidence', async () => {
  const targets: Array<(input: AssignedProcurementProfile) => object> = [
    input => input, input => input.roles, input => input.topology, input => input.topology.edges[0]!,
    input => input.initial, input => input.initial.requisition, input => input.initial.budget,
    input => input.initial.contract, input => input.initial.vendor_master, input => input.evidence,
    input => input.evidence.requester, input => input.evidence.budget, input => input.evidence.contract,
  ];
  for (const [index, target] of targets.entries()) {
    const input = await fixture();
    Object.assign(target(input), { unexpected_authority: true });
    assertInvalid(input, /unrecognized_keys/, `unknown field at object ${index}`);
  }
});

test('assigned profile rejects empty, reversed and malformed control-evidence validity intervals', async () => {
  for (const role of ['budget', 'contract'] as const) {
    for (const [from, until, reason] of [
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', /invalid evidence validity interval/],
      ['2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', /invalid evidence validity interval/],
      ['invalid-date', '2027-01-01T00:00:00.000Z', /Invalid datetime/],
      ['2026-01-01T00:00:00.000Z', 'invalid-date', /Invalid datetime/],
      ['2026-01-01T00:00:00.0001Z', '2027-01-01T00:00:00Z', /millisecond precision/],
      ['2026-01-01T00:00:00Z', '2027-01-01T00:00:00.9999Z', /millisecond precision/],
    ] as const) {
      const input = await fixture();
      input.evidence[role].valid_from = from;
      input.evidence[role].valid_until = until;
      assertInvalid(input, reason, `${role}: ${from} to ${until}`);
    }
  }
});

test('legacy success profile retains the recorded native pilot digest and passes execution validation', async () => {
  const profile = await loadPilotProfile(join(root, 'dataset/pact-net/tasks/executable_core/P-01/initial_state.json'), 'success');
  // Recorded by the prior P-01 native acceptance run, before assigned-profile support.
  assert.equal(digest(profile), '0ed9bb9555e23867df794f7f4be492549615cd41ac6d1468f111f44c2df50a52');
  assert.deepEqual(validateExecutionProfile(profile), profile);
  const forged = structuredClone(profile);
  forged.evidence.budget.approved = false;
  assert.throws(() => validateExecutionProfile(forged), /pilot_profile_invalid/);
});

test('execution profile validation fails closed on missing or unsupported profile modes', () => {
  for (const input of [null, [], {}, { mode: 'unknown' }, { mode: 'success' }]) {
    assert.throws(() => validateExecutionProfile(input), /pilot_profile_invalid/);
  }
});
