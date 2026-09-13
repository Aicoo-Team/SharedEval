import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest, type AssignedProcurementProfile } from '../../../src/suites/pact-net/pilot/profile.js';
import {
  createProcurementWorldProfile, loadProcurementWorldProfile, procurementWorldProfileSchema,
  worldActors, type ProcurementWorldProfile,
} from '../../../src/suites/pact-net/world/profile.js';

const fixturePath = (mode: 'multi' | 'single') => join(import.meta.dirname, `fixtures/procurement-world-${mode}.json`);
async function fixture(): Promise<ProcurementWorldProfile> {
  return JSON.parse(await readFile(fixturePath('multi'), 'utf8'));
}

function bindInitial(profile: AssignedProcurementProfile): void {
  profile.resourceVersion = digest(profile.initial);
  for (const evidence of Object.values(profile.evidence)) {
    evidence.case_id = profile.initial.case_id;
    evidence.resource_version = profile.resourceVersion;
  }
}

function assertInvalid(input: unknown, reason?: RegExp): void {
  assert.equal(procurementWorldProfileSchema.safeParse(input).success, false);
  assert.throws(() => createProcurementWorldProfile(input), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'procurement_world_profile_invalid');
    if (reason) assert.match(String(error.cause), reason);
    return true;
  });
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('world fixtures bind distinct synthetic resources to the same ordered cases in both modes', async () => {
  const multi = await loadProcurementWorldProfile(fixturePath('multi'));
  const single = await loadProcurementWorldProfile(fixturePath('single'));
  assert.equal(multi.mode, 'multi');
  assert.equal(single.mode, 'single');
  assert.deepEqual({ ...multi, mode: single.mode }, single);
  assert.deepEqual(multi.cases.map(profile => profile.initial.case_id), ['SYN-PO-002', 'SYN-PO-003']);
  assert.deepEqual(multi.publicState, {
    caseIds: ['SYN-PO-002', 'SYN-PO-003'], readers: ['marina_procurement'],
  });
  const [first, second] = multi.cases;
  assert.ok(first && second);
  assert.deepEqual(first, JSON.parse(await readFile(join(import.meta.dirname, 'fixtures/assigned-procurement.json'), 'utf8')));
  assert.deepEqual(second.roles, first.roles);
  assert.equal(second.initial.requisition.amount, 27500);
  assert.equal(second.initial.vendor_master.vendor_id, 'SYN-VEN-903');
  assert.equal(second.initial.contract.id, 'SYN-CON-003');
  assert.equal(second.resourceVersion, 'a6488a7e0bb8db061eb3e335304be451c6c9cd1d2fc97275b85cd56ac770221b');
  for (const role of ['requester', 'budget', 'contract'] as const) {
    assert.notEqual(second.evidence[role].private_canary, first.evidence[role].private_canary);
    assert.equal(second.evidence[role].case_id, 'SYN-PO-003');
    assert.equal(second.evidence[role].resource_version, second.resourceVersion);
  }
});

test('world parsing freezes an independent snapshot so later input mutation cannot alter any bound resource', async () => {
  const input = await fixture();
  const original = structuredClone(input);
  for (const parse of [createProcurementWorldProfile, procurementWorldProfileSchema.parse.bind(procurementWorldProfileSchema)]) {
    const parsed = parse(input);
    assert.deepEqual(parsed, original);
    assert.notEqual(parsed, input);
    assertDeepFrozen(parsed);
    assert.throws(() => { parsed.cases[1]!.initial.requisition.amount = 1; }, TypeError);
    assert.throws(() => { parsed.publicState.readers.push('outside_actor'); }, TypeError);
    assert.deepEqual(input, original);
  }
  const parsed = createProcurementWorldProfile(input);
  input.cases[1]!.initial.requisition.amount = 1;
  input.cases[1]!.evidence.budget.private_canary = 'changed evidence';
  input.publicState.readers.push('outside_actor');
  input.context = { protocol: 'actor-context/v1', maxContextBytes: 2048 };
  assert.deepEqual(parsed, original);
});

test('world actors are the frozen sorted union of every case and can explicitly read across their world', async () => {
  const input = await fixture();
  const second = input.cases[1]!;
  const previous = second.roles.requester;
  second.roles.requester = 'zoe_procurement';
  second.initial.requisition.requester = 'zoe_procurement';
  second.evidence.requester.owner = 'zoe_procurement';
  second.topology.edges = second.topology.edges.map(edge => ({
    from: edge.from === previous ? 'zoe_procurement' : edge.from,
    to: edge.to === previous ? 'zoe_procurement' : edge.to,
  }));
  bindInitial(second);
  input.publicState.readers = ['zoe_procurement', 'lina_legal'];
  const profile = createProcurementWorldProfile(input);
  const actors = worldActors(profile);
  assert.deepEqual(actors, ['lina_legal', 'marina_procurement', 'owen_budget', 'zoe_procurement']);
  assert.ok(Object.isFrozen(actors));
  assert.throws(() => actors.push('outside_actor'), TypeError);
  input.cases.reverse();
  assert.deepEqual(worldActors(createProcurementWorldProfile(input)), actors);
});

test('world rejects empty and excessive case sets while accepting both bounds', async () => {
  for (const count of [0, 1, 8, 9]) {
    const input = await fixture();
    const base = input.cases[0]!;
    input.cases = Array.from({ length: count }, (_, index) => {
      const profile = structuredClone(base);
      profile.initial.case_id = `SYN-BOUND-${index}`;
      bindInitial(profile);
      return profile;
    });
    input.publicState = { caseIds: [], readers: [] };
    if (count === 1 || count === 8) assert.equal(createProcurementWorldProfile(input).cases.length, count);
    else assertInvalid(input);
  }
});

test('world rejects duplicate case bindings even when each case independently validates', async () => {
  const input = await fixture();
  input.cases[1]!.initial.case_id = input.cases[0]!.initial.case_id;
  bindInitial(input.cases[1]!);
  input.publicState.caseIds = [input.cases[0]!.initial.case_id];
  assertInvalid(input, /case IDs must be unique/);
});

test('world requires explicit disclosure lists and permits empty lists to deny disclosure', async () => {
  for (const publicState of [
    { caseIds: [], readers: [] },
    { caseIds: ['SYN-PO-002'], readers: [] },
    { caseIds: [], readers: ['marina_procurement'] },
  ]) {
    const input = await fixture();
    input.publicState = publicState;
    assert.deepEqual(createProcurementWorldProfile(input).publicState, publicState);
  }
  for (const key of ['caseIds', 'readers']) {
    const input = await fixture();
    Reflect.deleteProperty(input.publicState, key);
    assertInvalid(input);
  }
  const input = await fixture();
  Reflect.deleteProperty(input, 'publicState');
  assertInvalid(input);
});

test('world rejects duplicate, foreign or malformed disclosed cases and readers', async () => {
  for (const [key, values] of [
    ['caseIds', ['SYN-PO-002', 'SYN-PO-002']],
    ['caseIds', ['SYN-PO-FOREIGN']],
    ['caseIds', ['../SYN-PO-002']],
    ['readers', ['marina_procurement', 'marina_procurement']],
    ['readers', ['outside_actor']],
    ['readers', ['Marina']],
  ] as const) {
    const input = await fixture();
    input.publicState[key] = [...values];
    assertInvalid(input);
  }
});

test('world validates every assigned case against its digest, owners, topology and evidence', async () => {
  const mutations: Array<(profile: AssignedProcurementProfile) => void> = [
    profile => { profile.initial.requisition.amount += 1; },
    profile => { profile.evidence.budget.amount += 1; },
    profile => { profile.evidence.contract.contract_version = 'foreign-version'; },
    profile => { profile.evidence.requester.owner = 'outside_actor'; },
    profile => { profile.evidence.contract.case_id = 'SYN-PO-002'; },
    profile => { profile.topology.edges.push({ from: profile.roles.requester, to: 'outside_actor' }); },
    profile => { profile.evidence.budget.valid_until = profile.evidence.budget.valid_from; },
    profile => { profile.roles.budget = profile.roles.requester; },
  ];
  for (const mutate of mutations) {
    const input = await fixture();
    mutate(input.cases[1]!);
    assertInvalid(input);
  }
});

test('world rejects unknown fields and unsupported protocols without silently dropping authority', async () => {
  for (const target of [
    (input: ProcurementWorldProfile) => input,
    (input: ProcurementWorldProfile) => input.context,
    (input: ProcurementWorldProfile) => input.publicState,
    (input: ProcurementWorldProfile) => input.cases[1]!,
    (input: ProcurementWorldProfile) => input.cases[1]!.evidence.contract,
  ]) {
    const input = await fixture();
    Object.assign(target(input), { unexpected_authority: true });
    assertInvalid(input, /unrecognized_keys/);
  }
  for (const change of [
    { version: 'pact-net-procurement-world/v2' }, { mode: 'assigned' },
    { context: { protocol: 'actor-context/v2', maxContextBytes: 1048576 } },
    { context: { protocol: 'actor-context/v1', maxContextBytes: 1023 } },
    { context: { protocol: 'actor-context/v1', maxContextBytes: 16777217 } },
  ]) {
    assertInvalid({ ...await fixture(), ...change });
  }
  for (const input of [null, [], {}, { mode: 'multi' }]) assertInvalid(input);
});

test('world file loading enforces the same disclosure validation as direct parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'procurement-world-profile-'));
  try {
    const input = await fixture();
    input.publicState.readers.push('outside_actor');
    const path = join(directory, 'invalid.json');
    await writeFile(path, JSON.stringify(input));
    await assert.rejects(loadProcurementWorldProfile(path), /procurement_world_profile_invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
