import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { SoCapabilityGrant } from '../../../src/execution/sharedos/v1/contracts.js';
import {
  buildPactPairSharedOsGrantManifestV1,
  type PactPairSharedOsGrantTaskV1,
} from '../../../src/suites/pact-pair/sharedos-grants.js';

const NAMESPACE_ID = `namespace-${'1'.repeat(40)}`;
const STARTED_AT = '2026-08-26T01:02:03.000Z';
const REQUESTER_ID = 'requester';
const RESPONDER_ID = 'responder';
const OWNER = Object.freeze({ kind: 'service', serviceId: 'sharedeval' } as const);
const PURPOSE = 'sharedeval:pact-pair';

function qaTask(
  taskId: string,
  surface: 'notes' | 'todos' | 'unknown',
  payload = 'private payload one',
): PactPairSharedOsGrantTaskV1 & { privatePayload: string } {
  return {
    taskId,
    kind: 'qa',
    publicTask: {
      taskId,
      kind: 'qa',
      surface,
      prompt: `ignored public prompt ${payload}`,
      requester: { id: 'R0' },
      target: { id: 'ALEX' },
    },
    privatePayload: payload,
  };
}

function actionTask(
  taskId: string,
  surface: 'notes' | 'todos',
  payload = 'private payload two',
): PactPairSharedOsGrantTaskV1 & { privatePayload: string } {
  return {
    taskId,
    kind: 'action',
    publicTask: {
      taskId,
      kind: 'action',
      surface,
      prompt: `ignored action prompt ${payload}`,
      operation: 'ignored-operation',
      requester: { id: 'R0' },
      target: { id: 'ALEX' },
    },
    privatePayload: payload,
  };
}

function build(overrides: Partial<Parameters<
  typeof buildPactPairSharedOsGrantManifestV1
>[0]> = {}) {
  return buildPactPairSharedOsGrantManifestV1({
    namespaceId: NAMESPACE_ID,
    runStartedAt: STARTED_AT,
    requesterId: REQUESTER_ID,
    responderId: RESPONDER_ID,
    maxTicks: 3,
    maxToolCalls: 8,
    tasks: [
      qaTask('PAIR-Q1', 'notes'),
      qaTask('PAIR-Q2', 'unknown'),
      actionTask('PAIR-A1', 'todos'),
    ],
    ...overrides,
  });
}

test('builds the exact root grant matrix with bounded uses', () => {
  const manifest = build();
  assert.equal(manifest.grants.length, 32);
  assert.equal(new Set(manifest.grants.map(grant => grant.id)).size, 32);
  assert.deepEqual(
    manifest.grants.map(grant => grant.id),
    manifest.grants.map(grant => grant.id).sort(),
  );

  for (const grant of manifest.grants) {
    assert.equal(grant.namespaceId, NAMESPACE_ID);
    assert.deepEqual(grant.issuer, OWNER);
    assert.equal(grant.issuedAt, STARTED_AT);
    assert.equal(grant.constraints.expiresAt, undefined);
    assert.equal(grant.constraints.delegationDepth, undefined);
    assert.deepEqual(grant.constraints, {
      purposes: [PURPOSE],
      notBefore: STARTED_AT,
      maxUses: grant.constraints.maxUses,
    });
    assert.equal(Number.isSafeInteger(grant.constraints.maxUses), true);
    assert.ok((grant.constraints.maxUses ?? 0) > 0);
    assert.equal(grant.parentGrantId, undefined);
    assert.equal(grant.revokedAt, undefined);
    assert.equal(grant.capabilities.length, 1);
    assert.equal(grant.capabilities[0]?.scope, 'exact');
    assert.deepEqual(grant.capabilities[0]?.resource.owner, OWNER);
    assert.ok(!grant.capabilities[0]?.actions.includes('*'));
    assert.deepEqual(
      grant.capabilities[0]?.actions,
      [...(grant.capabilities[0]?.actions ?? [])].sort(),
    );
  }

  const requester = manifest.grants.filter(grant => (
    grant.subject.kind === 'agent' && grant.subject.agentId === REQUESTER_ID
  ));
  assert.deepEqual(projectCapabilities(requester), [
    ['files', 'AGENT.md', 'read', 24],
    ['files', 'HEARTBEAT.md', 'read', 24],
    ['files', 'MEMORY.md', 'read', 24],
    ['files', 'MEMORY.md', 'replace', 3],
    ['files', 'POLICY.md', 'read', 24],
    ['sharedos.execution', `agent/${REQUESTER_ID}`, 'invoke', 3],
    ['sharedos.messaging', `agent/${RESPONDER_ID}`, 'send', 3],
  ]);

  assert.equal(
    grantFor(requester, 'sharedos.execution', ['agent', REQUESTER_ID], ['invoke']).id,
    expectedGrantId({
      subjectId: REQUESTER_ID,
      namespace: 'sharedos.execution',
      path: ['agent', REQUESTER_ID],
      actions: ['invoke'],
    }),
  );
  assert.equal(
    grantFor(requester, 'sharedos.messaging', ['agent', RESPONDER_ID], ['send']).id,
    expectedGrantId({
      subjectId: REQUESTER_ID,
      namespace: 'sharedos.messaging',
      path: ['agent', RESPONDER_ID],
      actions: ['send'],
    }),
  );
  for (const grant of requester) {
    const capability = grant.capabilities[0]!;
    assert.equal(grant.id, expectedGrantId({
      subjectId: REQUESTER_ID,
      namespace: capability.resource.namespace,
      path: capability.resource.path,
      actions: capability.actions,
    }));
  }

  assert.deepEqual(manifest.responderGrantSets.map(set => set.taskId), [
    'PAIR-A1',
    'PAIR-Q1',
    'PAIR-Q2',
  ]);
  const responderIds = new Set(manifest.responderGrantSets.flatMap(set => set.grantIds));
  assert.equal(responderIds.size, 25);
  assert.deepEqual(
    [...responderIds].sort(),
    manifest.grants
      .filter(grant => grant.subject.kind === 'agent' && grant.subject.agentId === RESPONDER_ID)
      .map(grant => grant.id)
      .sort(),
  );
  for (const set of manifest.responderGrantSets) {
    assert.deepEqual(set.grantIds, [...set.grantIds].sort());
    const grants = set.grantIds.map(id => manifest.grants.find(grant => grant.id === id)!);
    assert.ok(grants.every(grant => (
      grant.subject.kind === 'agent' && grant.subject.agentId === RESPONDER_ID
    )));
    for (const grant of grants) {
      const capability = grant.capabilities[0]!;
      assert.equal(grant.id, expectedGrantId({
        subjectId: RESPONDER_ID,
        namespace: capability.resource.namespace,
        path: capability.resource.path,
        actions: capability.actions,
        taskId: set.taskId,
      }));
    }
    assert.deepEqual(
      projectCapabilities(grants).filter(row => row[0] !== 'pact-pair'),
      [
        ['files', 'AGENT.md', 'read', 8],
        ['files', 'HEARTBEAT.md', 'read', 8],
        ['files', 'MEMORY.md', 'read', 8],
        ['files', 'MEMORY.md', 'replace', 1],
        ['files', 'POLICY.md', 'read', 8],
        ['sharedos.execution', `agent/${RESPONDER_ID}`, 'invoke', 1],
        ['sharedos.messaging', `agent/${REQUESTER_ID}`, 'send', 1],
      ],
    );
  }

  assert.deepEqual(projectPactCapabilities(manifest, 'PAIR-Q1'), [
    ['PAIR-Q1', 'notes', 'read', 8],
  ]);
  assert.deepEqual(projectPactCapabilities(manifest, 'PAIR-Q2'), [
    ['PAIR-Q2', 'notes', 'read', 8],
    ['PAIR-Q2', 'todos', 'read', 8],
  ]);
  assert.deepEqual(projectPactCapabilities(manifest, 'PAIR-A1'), [
    ['PAIR-A1', 'todos', 'create,read,update', 8],
  ]);
});

test('multiTurn scales contact-shaped use counts without changing grant identities', () => {
  const single = build({ maxTicks: 5 });
  const multi = build({ maxTicks: 5, multiTurn: { phase2StartTick: 2, finalizeTick: 5 } });

  assert.deepEqual(
    multi.grants.map(grant => grant.id),
    single.grants.map(grant => grant.id),
  );
  assert.deepEqual(multi.responderGrantSets, single.responderGrantSets);

  const singleById = new Map(single.grants.map(grant => [grant.id, grant]));
  for (const grant of multi.grants) {
    const before = singleById.get(grant.id)!;
    const capability = grant.capabilities[0]!;
    const isRequesterSubject = grant.subject.kind === 'agent'
      && grant.subject.agentId === REQUESTER_ID;
    if (isRequesterSubject && capability.resource.namespace === 'sharedos.messaging') {
      // Requester send: one contact per tick (maxTicks) instead of one per task.
      assert.equal(before.constraints.maxUses, 3);
      assert.equal(grant.constraints.maxUses, 5);
    } else if (isRequesterSubject) {
      assert.equal(grant.constraints.maxUses, before.constraints.maxUses);
    } else {
      // Every per-task responder budget scales by the tick count.
      assert.equal(grant.constraints.maxUses, (before.constraints.maxUses ?? 0) * 5);
    }
  }

  assert.throws(
    () => build({ multiTurn: { phase2StartTick: 4, finalizeTick: 3 } }),
    /phase2StartTick/,
  );
  assert.throws(
    () => build({ multiTurn: { phase2StartTick: 2, finalizeTick: 4 } }),
    /phase2StartTick|maxTicks/,
  );
});

test('uses task-discriminated responder IDs without changing canonical capabilities', () => {
  const manifest = build({
    tasks: [qaTask('PAIR-Q1', 'notes'), qaTask('PAIR-Q2', 'notes')],
  });
  const taskOne = grantsForTask(manifest, 'PAIR-Q1');
  const taskTwo = grantsForTask(manifest, 'PAIR-Q2');
  const oneRead = grantFor(taskOne, 'files', ['AGENT.md'], ['read']);
  const twoRead = grantFor(taskTwo, 'files', ['AGENT.md'], ['read']);

  assert.notEqual(oneRead.id, twoRead.id);
  assert.deepEqual(oneRead.capabilities, twoRead.capabilities);
  assert.equal(oneRead.id, expectedGrantId({
    subjectId: RESPONDER_ID,
    namespace: 'files',
    path: ['AGENT.md'],
    actions: ['read'],
    taskId: 'PAIR-Q1',
  }));
  assert.equal(twoRead.id, expectedGrantId({
    subjectId: RESPONDER_ID,
    namespace: 'files',
    path: ['AGENT.md'],
    actions: ['read'],
    taskId: 'PAIR-Q2',
  }));

  const sets = manifest.responderGrantSets.map(set => new Set(set.grantIds));
  assert.equal([...sets[0]!].some(id => sets[1]!.has(id)), false);
});

test('is sorted, deeply immutable, and independent of task order or payload', () => {
  const firstTasks = [
    qaTask('PAIR-Q2', 'unknown', 'secret-one'),
    actionTask('PAIR-A1', 'todos', 'secret-two'),
    qaTask('PAIR-Q1', 'notes', 'secret-three'),
  ];
  const secondTasks = [
    qaTask('PAIR-Q1', 'notes', 'changed-private-three'),
    qaTask('PAIR-Q2', 'unknown', 'changed-private-one'),
    actionTask('PAIR-A1', 'todos', 'changed-private-two'),
  ];
  const first = build({ tasks: firstTasks });
  const second = build({ tasks: secondTasks });

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.grants), true);
  assert.equal(Object.isFrozen(first.grants[0]), true);
  assert.equal(Object.isFrozen(first.grants[0]?.capabilities), true);
  assert.equal(Object.isFrozen(first.grants[0]?.capabilities[0]?.resource), true);
  assert.equal(Object.isFrozen(first.grants[0]?.constraints), true);
  assert.equal(Object.isFrozen(first.responderGrantSets), true);
  assert.equal(Object.isFrozen(first.responderGrantSets[0]?.grantIds), true);
  assert.throws(() => {
    (first.grants as SoCapabilityGrant[]).push(first.grants[0]!);
  }, TypeError);
});

test('rejects duplicate or foreign task authority inputs', () => {
  const duplicate = qaTask('PAIR-Q1', 'notes');
  assert.throws(() => build({ tasks: [duplicate, duplicate] }), /duplicate.*task/i);
  assert.throws(() => build({ tasks: [] }), /task/i);
  assert.throws(() => build({
    tasks: [{ ...qaTask('PAIR-Q1', 'notes'), taskId: 'PAIR-Q9' }],
  }), /task/i);
  assert.throws(() => build({
    tasks: [{ ...qaTask('PAIR-Q1', 'notes'), kind: 'action' } as PactPairSharedOsGrantTaskV1],
  }), /task/i);
  assert.throws(() => build({
    tasks: [qaTask('NET-Q1', 'notes')],
  }), /PACT-Pair|foreign/i);
  assert.throws(() => build({
    tasks: [qaTask('PAIR-A1', 'notes')],
  }), /PACT-Pair|foreign|kind/i);
  assert.throws(() => build({
    tasks: [qaTask('PAIR-Q1', 'calendar' as 'notes')],
  }), /surface|foreign/i);
  assert.throws(() => build({
    tasks: [actionTask('PAIR-A1', 'unknown' as 'notes')],
  }), /surface|foreign/i);
});

test('rejects unsafe namespace, timestamp, actor, and count inputs', () => {
  const invalid: Array<[string, Partial<Parameters<
    typeof buildPactPairSharedOsGrantManifestV1
  >[0]>]> = [
    ['namespace', { namespaceId: 'foreign-namespace' }],
    ['timestamp', { runStartedAt: '2026-08-26' }],
    ['requester actor', { requesterId: '../requester' }],
    ['responder actor', { responderId: ' responder ' }],
    ['distinct actor', { responderId: REQUESTER_ID }],
    ['tick count', { maxTicks: 0 }],
    ['tick count', { maxTicks: 10_001 }],
    ['tool count', { maxToolCalls: 5 }],
    ['tool count', { maxToolCalls: 129 }],
    ['tool count', { maxToolCalls: Number.NaN }],
  ];
  for (const [label, overrides] of invalid) {
    assert.throws(() => build(overrides), new RegExp(label, 'i'));
  }
});

type BuiltManifest = ReturnType<typeof buildPactPairSharedOsGrantManifestV1>;

function grantsForTask(manifest: BuiltManifest, taskId: string): SoCapabilityGrant[] {
  const grantIds = manifest.responderGrantSets.find(set => set.taskId === taskId)?.grantIds;
  assert.ok(grantIds);
  return grantIds.map(id => manifest.grants.find(grant => grant.id === id)!);
}

function grantFor(
  grants: readonly SoCapabilityGrant[],
  namespace: string,
  path: readonly string[],
  actions: readonly string[],
): SoCapabilityGrant {
  const match = grants.filter(grant => {
    const capability = grant.capabilities[0];
    return capability?.resource.namespace === namespace
      && JSON.stringify(capability.resource.path) === JSON.stringify(path)
      && JSON.stringify(capability.actions) === JSON.stringify(actions);
  });
  assert.equal(match.length, 1);
  return match[0]!;
}

function projectCapabilities(
  grants: readonly SoCapabilityGrant[],
): Array<[string, string, string, number]> {
  return grants.map((grant): [string, string, string, number] => {
    const capability = grant.capabilities[0]!;
    return [
      capability.resource.namespace,
      capability.resource.path.join('/'),
      capability.actions.join(','),
      grant.constraints.maxUses!,
    ];
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function projectPactCapabilities(
  manifest: BuiltManifest,
  taskId: string,
): Array<[string, string, string, number]> {
  return grantsForTask(manifest, taskId)
    .filter(grant => grant.capabilities[0]?.resource.namespace === 'pact-pair')
    .map((grant): [string, string, string, number] => {
      const capability = grant.capabilities[0]!;
      return [
        capability.resource.path[1]!,
        capability.resource.path[2]!,
        capability.actions.join(','),
        grant.constraints.maxUses!,
      ];
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectedGrantId(input: Readonly<{
  subjectId: string;
  namespace: string;
  path: readonly string[];
  actions: readonly string[];
  taskId?: string;
}>): string {
  const tuple = [
    'grant',
    NAMESPACE_ID,
    { kind: 'agent', agentId: input.subjectId },
    input.namespace,
    input.path,
    [...input.actions].sort(),
    ...(input.taskId === undefined ? [] : [['responder-task', input.taskId]]),
  ];
  return `grant-${createHash('sha256')
    .update(testCanonicalJson(tuple))
    .digest('hex')
    .slice(0, 40)}`;
}

function testCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return `{${entries.map(([key, entry]) => (
    `${JSON.stringify(key)}:${testCanonicalJson(entry)}`
  )).join(',')}}`;
}
