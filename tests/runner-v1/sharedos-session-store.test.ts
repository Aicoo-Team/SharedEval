import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';

import type {
  SoAccessContext,
  SoAddress,
  SoAuditEvent,
  SoCapabilityGrant,
  SoMessageEnvelope,
} from '../../src/execution/sharedos/v1/contracts.js';
import {
  openSharedOsSessionStoreV1,
  readSharedOsSessionStartedAtV1,
  SharedOsResponderTaskAlreadyBoundErrorV1,
  type OpenSharedOsSessionStoreV1Options,
  type SharedOsSessionBindingV1,
} from '../../src/runner/v1/sharedos-session-store.js';
import { buildPactPairSharedOsGrantManifestV1 } from '../../src/suites/pact-pair/sharedos-grants.js';
import { loadPactPairTasksV1 } from '../../src/suites/pact-pair/task-loader.js';

const SESSION_DIRECTORY = '.sharedeval-sharedos-session';
const OWNER = Object.freeze({ kind: 'service', serviceId: 'sharedeval' } as const);
const REQUESTER = Object.freeze({ kind: 'agent', agentId: 'requester' } as const);
const RESPONDER = Object.freeze({ kind: 'agent', agentId: 'responder' } as const);
const PURPOSE = 'sharedeval:pact-pair';
const STARTED_AT = '2026-08-26T01:00:00.000Z';
const NAMESPACE_ID = `namespace-${'1'.repeat(40)}`;
const REQUESTER_GRANT_ID = `grant-${'1'.repeat(40)}`;
const RESPONDER_BASE_GRANT_ID = `grant-${'2'.repeat(40)}`;
const RESPONDER_TASK_GRANT_ID = `grant-${'3'.repeat(40)}`;
const RESPONDER_TASK_TWO_GRANT_ID = `grant-${'a'.repeat(40)}`;
const REQUEST_ID = `message-${'4'.repeat(40)}`;
const REPLY_ID = `message-${'5'.repeat(40)}`;
const TRACE_ID = `trace-${'6'.repeat(40)}`;

const execFileAsync = promisify(execFile);

function binding(
  overrides: Partial<SharedOsSessionBindingV1> = {},
): SharedOsSessionBindingV1 {
  return {
    apiVersion: 'sharedeval-sharedos-session-binding/v1',
    runId: 'run-1',
    namespaceId: NAMESPACE_ID,
    owner: OWNER,
    authority: OWNER,
    purpose: PURPOSE,
    startedAt: STARTED_AT,
    toolSurface: 'sharedos-runtime',
    responderGrantSets: [{
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }],
    ...overrides,
  };
}

function capabilityGrant(input: {
  id: string;
  subject: Extract<SoAddress, { kind: 'agent' }>;
  resourceNamespace?: string;
  path?: string[];
  maxUses?: number;
}): SoCapabilityGrant {
  return {
    id: input.id,
    namespaceId: NAMESPACE_ID,
    subject: input.subject,
    issuer: OWNER,
    capabilities: [{
      resource: {
        namespace: input.resourceNamespace ?? 'sharedos.execution',
        path: input.path ?? [input.subject.agentId],
        owner: OWNER,
      },
      actions: ['invoke'],
      scope: 'exact',
    }],
    constraints: {
      purposes: [PURPOSE],
      notBefore: STARTED_AT,
      maxUses: input.maxUses ?? 7,
    },
    issuedAt: STARTED_AT,
  };
}

function grants(): SoCapabilityGrant[] {
  return [
    capabilityGrant({ id: REQUESTER_GRANT_ID, subject: REQUESTER }),
    capabilityGrant({ id: RESPONDER_BASE_GRANT_ID, subject: RESPONDER }),
    capabilityGrant({
      id: RESPONDER_TASK_GRANT_ID,
      subject: RESPONDER,
      resourceNamespace: 'pact-pair',
      path: ['task', 'task-1', 'notes'],
    }),
  ];
}

function context(
  actor: Extract<SoAddress, { kind: 'agent' }> = REQUESTER,
  overrides: Partial<SoAccessContext> = {},
): SoAccessContext {
  return {
    namespaceId: NAMESPACE_ID,
    actor,
    authority: OWNER,
    owner: OWNER,
    purpose: PURPOSE,
    traceId: TRACE_ID,
    enabledToolNamespaces: ['files', 'messages'],
    now: '2026-08-26T01:00:01.000Z',
    ...overrides,
  };
}

function requestEnvelope(
  overrides: Partial<SoMessageEnvelope> & Record<string, unknown> = {},
): SoMessageEnvelope {
  return {
    version: '1',
    id: REQUEST_ID,
    sender: REQUESTER,
    receiver: RESPONDER,
    purpose: PURPOSE,
    payload: { taskId: 'task-1', message: 'private request payload' },
    traceId: TRACE_ID,
    createdAt: '2026-08-26T01:00:02.000Z',
    provenance: {
      source: 'messages.request',
      parentIds: [`call-${'7'.repeat(40)}`],
      metadata: { retained: true },
    },
    ...overrides,
  } as unknown as SoMessageEnvelope;
}

function replyEnvelope(
  overrides: Partial<SoMessageEnvelope> & Record<string, unknown> = {},
): SoMessageEnvelope {
  const reply = requestEnvelope({
    id: REPLY_ID,
    sender: RESPONDER,
    receiver: REQUESTER,
    payload: { taskId: 'task-1', status: 'completed', response: 'done' },
    replyTo: REQUEST_ID,
    createdAt: '2026-08-26T01:00:03.000Z',
    ...overrides,
  });
  if (!Object.hasOwn(overrides, 'provenance')) {
    delete (reply as SoMessageEnvelope & { provenance?: unknown }).provenance;
  }
  return reply;
}

function auditEvent(
  overrides: Partial<SoAuditEvent> = {},
): SoAuditEvent {
  return {
    version: '1',
    type: 'authorization.checked',
    outcome: 'allowed',
    at: '2026-08-26T01:00:01.000Z',
    traceId: TRACE_ID,
    namespaceId: NAMESPACE_ID,
    actor: REQUESTER,
    authority: OWNER,
    owner: OWNER,
    purpose: PURPOSE,
    resource: { namespace: 'files', path: ['requester', 'AGENT.md'], owner: OWNER },
    action: 'read',
    grantId: REQUESTER_GRANT_ID,
    metadata: { decision: 'exact' },
    ...overrides,
  };
}

async function temporaryOptions(
  t: TestContext,
  label: string,
  overrides: Partial<OpenSharedOsSessionStoreV1Options> = {},
): Promise<OpenSharedOsSessionStoreV1Options> {
  const parent = await mkdtemp(join(tmpdir(), `sharedeval-session-${label}-`));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return {
    runDirectory: join(parent, 'run'),
    binding: binding(),
    grants: grants(),
    ...overrides,
  };
}

function sessionPath(runDirectory: string, ...parts: string[]): string {
  return join(runDirectory, SESSION_DIRECTORY, ...parts);
}

async function directoryText(directory: string): Promise<string> {
  const names = await readdir(directory);
  return (await Promise.all(names.sort().map(name => readFile(join(directory, name), 'utf8'))))
    .join('\n');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function abortOnThrowCheck(check: number): AbortSignal {
  const controller = new AbortController();
  let calls = 0;
  return new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'throwIfAborted') {
        return () => {
          calls += 1;
          if (calls === check) controller.abort();
          target.throwIfAborted();
        };
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

test('loads only open-session grants matching namespace, subject, issuer, owner, and purpose', async t => {
  const options = await temporaryOptions(t, 'scope');
  const store = await openSharedOsSessionStoreV1(options);

  assert.deepEqual(
    (await store.load(context(), new AbortController().signal)).map(grant => grant.id),
    [REQUESTER_GRANT_ID],
  );
  assert.deepEqual(
    (await store.load(context(RESPONDER), new AbortController().signal)).map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID],
  );

  const mismatches: Partial<SoAccessContext>[] = [
    { namespaceId: `namespace-${'9'.repeat(40)}` },
    { actor: { kind: 'agent', agentId: 'foreign' } },
    { authority: { kind: 'service', serviceId: 'foreign' } },
    { owner: { kind: 'service', serviceId: 'foreign' } },
    { purpose: 'foreign:purpose' },
  ];
  for (const mismatch of mismatches) {
    assert.deepEqual(
      await store.load(context(REQUESTER, mismatch), new AbortController().signal),
      [],
    );
  }

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => store.load(context(), aborted.signal), /abort/i);
  await assert.rejects(
    () => store.load(
      context(REQUESTER, { enabledToolNamespaces: ['files', 'files'] }),
      new AbortController().signal,
    ),
    /namespace.*unique|unique.*namespace/i,
  );
});

test('rechecks cancellation after grant scans before returning authority', async t => {
  const options = await temporaryOptions(t, 'load-cancel');
  const store = await openSharedOsSessionStoreV1(options);
  await assert.rejects(
    () => store.load(context(), abortOnThrowCheck(3)),
    /abort/i,
  );
});

test('publishes one immutable binding and grant manifest and reopens only identical authority', async t => {
  const options = await temporaryOptions(t, 'manifest');
  await openSharedOsSessionStoreV1(options);

  await openSharedOsSessionStoreV1({ ...options, grants: [...options.grants].reverse() });
  const foreignPurpose = 'sharedeval:foreign';
  await assert.rejects(
    () => openSharedOsSessionStoreV1({
      ...options,
      binding: binding({ purpose: foreignPurpose }),
      grants: grants().map(grant => ({
        ...grant,
        constraints: { ...grant.constraints, purposes: [foreignPurpose] },
      })),
    }),
    /binding.*conflict|conflict.*binding/i,
  );
  const changedGrants = grants();
  changedGrants[0] = {
    ...changedGrants[0]!,
    constraints: { ...changedGrants[0]!.constraints, maxUses: 8 },
  };
  await assert.rejects(
    () => openSharedOsSessionStoreV1({ ...options, grants: changedGrants }),
    /grant.*conflict|conflict.*grant/i,
  );

  assert.equal(
    (await readFile(sessionPath(options.runDirectory, 'binding.json'), 'utf8')).includes(options.runDirectory),
    false,
  );
});

test('reads verified immutable startedAt without creating or locking an absent session', async t => {
  const options = await temporaryOptions(t, 'read-started-at');

  assert.equal(await readSharedOsSessionStartedAtV1(options.runDirectory), null);
  await assert.rejects(
    () => readFile(options.runDirectory, 'utf8'),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );

  await openSharedOsSessionStoreV1(options);
  assert.equal(await readSharedOsSessionStartedAtV1(options.runDirectory), STARTED_AT);
  await assert.rejects(
    () => readFile(sessionPath(options.runDirectory, 'mutation.lock'), 'utf8'),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

test('startedAt recovery waits only for a live writer between binding and grant publication', async t => {
  const sourceOptions = await temporaryOptions(t, 'read-started-at-live-source');
  await openSharedOsSessionStoreV1(sourceOptions);
  const bindingSource = await readFile(
    sessionPath(sourceOptions.runDirectory, 'binding.json'),
    'utf8',
  );
  const grantSource = await readFile(
    sessionPath(sourceOptions.runDirectory, 'grants.json'),
    'utf8',
  );

  const targetOptions = await temporaryOptions(t, 'read-started-at-live-target');
  const internal = sessionPath(targetOptions.runDirectory);
  const mutationLock = join(internal, 'mutation.lock');
  await mkdir(mutationLock, { recursive: true });
  await writeFile(join(mutationLock, 'owner.json'), `${JSON.stringify({
    apiVersion: 'sharedeval-sharedos-mutation-lock/v1',
    pid: process.pid,
    token: '00000000-0000-4000-8000-000000000000',
  })}\n`, 'utf8');
  await writeFile(join(internal, 'binding.json'), bindingSource, 'utf8');

  let settled = false;
  const reading = readSharedOsSessionStartedAtV1(targetOptions.runDirectory)
    .finally(() => { settled = true; });
  await delay(25);
  assert.equal(settled, false, 'reader remains fenced between the two immutable links');

  await writeFile(join(internal, 'grants.json'), grantSource, 'utf8');
  await rm(mutationLock, { recursive: true });
  assert.equal(await reading, STARTED_AT);

  const incompleteOptions = await temporaryOptions(t, 'read-started-at-incomplete');
  await mkdir(sessionPath(incompleteOptions.runDirectory), { recursive: true });
  await writeFile(
    sessionPath(incompleteOptions.runDirectory, 'binding.json'),
    bindingSource,
    'utf8',
  );
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(incompleteOptions.runDirectory),
    /authority.*incomplete|incomplete.*authority/i,
  );

  const staleOptions = await temporaryOptions(t, 'read-started-at-stale');
  const staleInternal = sessionPath(staleOptions.runDirectory);
  const staleLock = join(staleInternal, 'mutation.lock');
  await mkdir(staleLock, { recursive: true });
  await writeFile(join(staleInternal, 'binding.json'), bindingSource, 'utf8');
  await writeFile(join(staleLock, 'owner.json'), `${JSON.stringify({
    apiVersion: 'sharedeval-sharedos-mutation-lock/v1',
    pid: 2_147_483_647,
    token: '00000000-0000-4000-8000-000000000000',
  })}\n`, 'utf8');
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(staleOptions.runDirectory),
    /stale.*lock|lock.*indeterminate/i,
  );
});

test('startedAt recovery refuses symlinked, special, malformed, or digest-conflicting authority', async t => {
  const symlinkOptions = await temporaryOptions(t, 'read-started-at-symlink');
  const target = join(dirname(symlinkOptions.runDirectory), 'started-at-target');
  await mkdir(target);
  await symlink(target, symlinkOptions.runDirectory);
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(symlinkOptions.runDirectory),
    /symlink|directory/i,
  );

  const symlinkAuthorityOptions = await temporaryOptions(t, 'read-started-at-authority-symlink');
  await openSharedOsSessionStoreV1(symlinkAuthorityOptions);
  const bindingPath = sessionPath(symlinkAuthorityOptions.runDirectory, 'binding.json');
  const savedBindingPath = join(dirname(bindingPath), 'saved-binding.json');
  await writeFile(savedBindingPath, await readFile(bindingPath));
  await rm(bindingPath);
  await symlink(savedBindingPath, bindingPath);
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(symlinkAuthorityOptions.runDirectory),
    /binding.*symlink|symlink.*binding/i,
  );

  const specialOptions = await temporaryOptions(t, 'read-started-at-special');
  await openSharedOsSessionStoreV1(specialOptions);
  await rm(sessionPath(specialOptions.runDirectory, 'grants.json'));
  await mkdir(sessionPath(specialOptions.runDirectory, 'grants.json'));
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(specialOptions.runDirectory),
    /grant.*regular|regular.*grant/i,
  );

  const malformedOptions = await temporaryOptions(t, 'read-started-at-malformed');
  await openSharedOsSessionStoreV1(malformedOptions);
  await writeFile(sessionPath(malformedOptions.runDirectory, 'binding.json'), '{', 'utf8');
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(malformedOptions.runDirectory),
    /binding.*malformed|malformed.*binding/i,
  );

  const conflictingOptions = await temporaryOptions(t, 'read-started-at-digest');
  await openSharedOsSessionStoreV1(conflictingOptions);
  const grantPath = sessionPath(conflictingOptions.runDirectory, 'grants.json');
  const manifest = JSON.parse(await readFile(grantPath, 'utf8')) as Record<string, unknown>;
  manifest.grantsDigest = createHash('sha256').update('conflicting').digest('hex');
  await writeFile(grantPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  await assert.rejects(
    () => readSharedOsSessionStartedAtV1(conflictingOptions.runDirectory),
    /grant.*digest|digest.*grant/i,
  );
});

test('accepts the complete 600-task PACT-Pair authority without weakening grant isolation', async t => {
  const tasks = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
  });
  assert.equal(tasks.length, 600);
  const manifest = buildPactPairSharedOsGrantManifestV1({
    namespaceId: NAMESPACE_ID,
    runStartedAt: STARTED_AT,
    requesterId: REQUESTER.agentId,
    responderId: RESPONDER.agentId,
    maxTicks: 600,
    maxToolCalls: 8,
    tasks,
  });
  assert.equal(manifest.grants.length, 4_807);

  const options = await temporaryOptions(t, 'full-authority', {
    binding: binding({
      responderGrantSets: manifest.responderGrantSets.map(set => ({
        taskId: set.taskId,
        grantIds: [...set.grantIds],
      })),
    }),
    grants: manifest.grants,
  });
  const store = await openSharedOsSessionStoreV1(options);
  assert.deepEqual(
    (await store.load(context(), new AbortController().signal)).map(grant => grant.id),
    manifest.grants
      .filter(grant => grant.subject.kind === 'agent' && grant.subject.agentId === 'requester')
      .map(grant => grant.id),
  );

  const excessive = await temporaryOptions(t, 'excessive-authority', {
    grants: Array.from({ length: 10_001 }, () => grants()[0]!),
  });
  await assert.rejects(
    () => openSharedOsSessionStoreV1(excessive),
    /exceeds 10000 grants/,
  );
});

test('rejects delegated, foreign, duplicate, or unclassified deferred grant manifests', async t => {
  const cases: Array<[string, (value: SoCapabilityGrant[]) => SoCapabilityGrant[]]> = [
    ['delegated', value => [{ ...value[0]!, parentGrantId: `grant-${'8'.repeat(40)}` }, ...value.slice(1)]],
    ['delegation-depth', value => [{
      ...value[0]!,
      constraints: { ...value[0]!.constraints, delegationDepth: 0 },
    }, ...value.slice(1)]],
    ['namespace', value => [{ ...value[0]!, namespaceId: `namespace-${'8'.repeat(40)}` }, ...value.slice(1)]],
    ['issuer', value => [{
      ...value[0]!,
      issuer: { kind: 'service', serviceId: 'foreign' },
    }, ...value.slice(1)]],
    ['resource-path', value => [{
      ...value[0]!,
      capabilities: [{
        ...value[0]!.capabilities[0]!,
        resource: { ...value[0]!.capabilities[0]!.resource, path: ['..'] },
      }],
    }, ...value.slice(1)]],
    ['duplicate', value => [...value, { ...value[0]! }]],
  ];

  for (const [label, mutate] of cases) {
    const options = await temporaryOptions(t, `invalid-${label}`);
    await assert.rejects(
      () => openSharedOsSessionStoreV1({ ...options, grants: mutate(grants()) }),
      /grant|delegat|namespace|issuer|duplicate/i,
    );
  }

  const missing = await temporaryOptions(t, 'invalid-deferred');
  await assert.rejects(
    () => openSharedOsSessionStoreV1({
      ...missing,
      binding: binding({
        responderGrantSets: [{ taskId: 'task-1', grantIds: [`grant-${'9'.repeat(40)}`] }],
      }),
    }),
    /grant/i,
  );
});

test('activates exact responder task grants only from an immutable accepted-request binding', async t => {
  const options = await temporaryOptions(t, 'responder-binding');
  const store = await openSharedOsSessionStoreV1(options);
  const signal = new AbortController().signal;
  await store.deliver(context(), requestEnvelope({
    payload: { taskId: 'forged-task', message: 'payload is never authority' },
  }), signal);

  assert.deepEqual(
    (await store.load(context(RESPONDER), signal)).map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID],
  );
  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: TRACE_ID,
      requestMessageId: REQUEST_ID,
      taskId: 'task-1',
      grantIds: [RESPONDER_BASE_GRANT_ID],
    }),
    /grant/i,
  );

  const accepted = {
    traceId: TRACE_ID,
    requestMessageId: REQUEST_ID,
    taskId: 'task-1',
    grantIds: [RESPONDER_TASK_GRANT_ID],
  } as const;
  assert.equal(await store.bindResponderGrantSet(accepted), 'created');
  assert.equal(await store.bindResponderGrantSet(accepted), 'replayed');
  assert.deepEqual(
    (await store.load(context(RESPONDER), signal)).map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID, RESPONDER_TASK_GRANT_ID],
  );
  assert.deepEqual(
    (await store.load(context(RESPONDER, { traceId: `trace-${'8'.repeat(40)}` }), signal))
      .map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID],
  );

  const reopened = await openSharedOsSessionStoreV1(options);
  assert.equal(await reopened.bindResponderGrantSet(accepted), 'replayed');
  assert.deepEqual(
    (await reopened.load(context(RESPONDER), signal)).map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID, RESPONDER_TASK_GRANT_ID],
  );

  const otherTrace = `trace-${'8'.repeat(40)}`;
  const otherRequestId = `message-${'8'.repeat(40)}`;
  await reopened.deliver(
    context(REQUESTER, { traceId: otherTrace }),
    requestEnvelope({ id: otherRequestId, traceId: otherTrace }),
    signal,
  );
  await assert.rejects(
    () => reopened.bindResponderGrantSet({
      traceId: otherTrace,
      requestMessageId: otherRequestId,
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    error => (
      error instanceof SharedOsResponderTaskAlreadyBoundErrorV1
      && error.taskId === 'task-1'
      && error.message === 'Responder task already has an authoritative request'
    ),
  );
});

test('allowRepeatContacts binds one immutable responder grant set per accepted request', async t => {
  const options = await temporaryOptions(t, 'repeat-contacts', {
    binding: binding({ allowRepeatContacts: true }),
  });
  const store = await openSharedOsSessionStoreV1(options);
  const signal = new AbortController().signal;

  await store.deliver(context(), requestEnvelope(), signal);
  const first = {
    traceId: TRACE_ID,
    requestMessageId: REQUEST_ID,
    taskId: 'task-1',
    grantIds: [RESPONDER_TASK_GRANT_ID],
  } as const;
  assert.equal(await store.bindResponderGrantSet(first), 'created');
  assert.equal(await store.bindResponderGrantSet(first), 'replayed');

  // A later tick re-contacts the same task on a fresh trace and request.
  const otherTrace = `trace-${'8'.repeat(40)}`;
  const otherRequestId = `message-${'8'.repeat(40)}`;
  await store.deliver(
    context(REQUESTER, { traceId: otherTrace }),
    requestEnvelope({ id: otherRequestId, traceId: otherTrace }),
    signal,
  );
  const second = {
    traceId: otherTrace,
    requestMessageId: otherRequestId,
    taskId: 'task-1',
    grantIds: [RESPONDER_TASK_GRANT_ID],
  } as const;
  assert.equal(await store.bindResponderGrantSet(second), 'created');
  assert.equal(await store.bindResponderGrantSet(second), 'replayed');

  // Trace and request identities stay unique even under the gate.
  await assert.rejects(
    () => store.bindResponderGrantSet({ ...second, requestMessageId: REQUEST_ID }),
    /trace|request/i,
  );

  // Reopen re-validates both committed contact bindings.
  const reopened = await openSharedOsSessionStoreV1(options);
  assert.equal(await reopened.bindResponderGrantSet(first), 'replayed');
  assert.equal(await reopened.bindResponderGrantSet(second), 'replayed');

  // The deferred grant set stays trace-scoped.
  assert.deepEqual(
    (await reopened.load(context(RESPONDER, { traceId: otherTrace }), signal))
      .map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID, RESPONDER_TASK_GRANT_ID],
  );
});

test('loads only the deferred grant set bound to the current responder trace', async t => {
  const options = await temporaryOptions(t, 'trace-isolation', {
    binding: binding({
      responderGrantSets: [
        { taskId: 'task-1', grantIds: [RESPONDER_TASK_GRANT_ID] },
        { taskId: 'task-2', grantIds: [RESPONDER_TASK_TWO_GRANT_ID] },
      ],
    }),
    grants: [
      ...grants(),
      capabilityGrant({
        id: RESPONDER_TASK_TWO_GRANT_ID,
        subject: RESPONDER,
        resourceNamespace: 'pact-pair',
        path: ['task', 'task-2', 'todos'],
      }),
    ],
  });
  const store = await openSharedOsSessionStoreV1(options);
  const signal = new AbortController().signal;
  const secondTrace = `trace-${'8'.repeat(40)}`;
  const secondRequestId = `message-${'8'.repeat(40)}`;
  await store.deliver(context(), requestEnvelope(), signal);
  await store.bindResponderGrantSet({
    traceId: TRACE_ID,
    requestMessageId: REQUEST_ID,
    taskId: 'task-1',
    grantIds: [RESPONDER_TASK_GRANT_ID],
  });
  await store.deliver(
    context(REQUESTER, { traceId: secondTrace }),
    requestEnvelope({ id: secondRequestId, traceId: secondTrace }),
    signal,
  );
  await store.bindResponderGrantSet({
    traceId: secondTrace,
    requestMessageId: secondRequestId,
    taskId: 'task-2',
    grantIds: [RESPONDER_TASK_TWO_GRANT_ID],
  });

  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: secondTrace,
      requestMessageId: secondRequestId,
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    error => (
      error instanceof Error
      && !(error instanceof SharedOsResponderTaskAlreadyBoundErrorV1)
      && /trace|request/i.test(error.message)
    ),
  );

  assert.deepEqual(
    (await store.load(context(RESPONDER), signal)).map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID, RESPONDER_TASK_GRANT_ID],
  );
  assert.deepEqual(
    (await store.load(context(RESPONDER, { traceId: secondTrace }), signal))
      .map(grant => grant.id),
    [RESPONDER_BASE_GRANT_ID, RESPONDER_TASK_TWO_GRANT_ID],
  );
});

test('never activates a responder binding whose durable request has disappeared', async t => {
  const options = await temporaryOptions(t, 'binding-request-loss');
  const store = await openSharedOsSessionStoreV1(options);
  const signal = new AbortController().signal;
  await store.deliver(context(), requestEnvelope(), signal);
  await store.bindResponderGrantSet({
    traceId: TRACE_ID,
    requestMessageId: REQUEST_ID,
    taskId: 'task-1',
    grantIds: [RESPONDER_TASK_GRANT_ID],
  });
  const messagesDirectory = sessionPath(options.runDirectory, 'messages');
  const requestRecord = (await readdir(messagesDirectory))
    .find(name => name.startsWith('record-'));
  assert.ok(requestRecord);
  await rm(join(messagesDirectory, requestRecord));

  await assert.rejects(
    () => store.load(context(RESPONDER), signal),
    /binding.*request|request.*(?:missing|durable)/i,
  );
  await assert.rejects(
    () => openSharedOsSessionStoreV1(options),
    /binding.*request|request.*(?:missing|durable)/i,
  );
});

test('binds deferred grants only when every grant subject is the request receiver', async t => {
  const foreignSubjectGrant = capabilityGrant({
    id: RESPONDER_TASK_GRANT_ID,
    subject: REQUESTER,
    resourceNamespace: 'pact-pair',
    path: ['task', 'task-1', 'notes'],
  });
  const options = await temporaryOptions(t, 'binding-subject', {
    grants: [
      capabilityGrant({ id: REQUESTER_GRANT_ID, subject: REQUESTER }),
      capabilityGrant({ id: RESPONDER_BASE_GRANT_ID, subject: RESPONDER }),
      foreignSubjectGrant,
    ],
  });
  const store = await openSharedOsSessionStoreV1(options);
  await store.deliver(context(), requestEnvelope(), new AbortController().signal);
  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: TRACE_ID,
      requestMessageId: REQUEST_ID,
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    /grant.*subject|request.*receiver|receiver.*grant/i,
  );
});

test('fails closed on missing, reply, mismatched, or conflicting responder bindings', async t => {
  const options = await temporaryOptions(t, 'binding-conflict', {
    binding: binding({
      responderGrantSets: [
        { taskId: 'task-1', grantIds: [RESPONDER_TASK_GRANT_ID] },
        { taskId: 'task-2', grantIds: [RESPONDER_TASK_GRANT_ID] },
      ],
    }),
  });
  await assert.rejects(() => openSharedOsSessionStoreV1(options), /grant.*set|multiple|duplicate/i);

  const validOptions = await temporaryOptions(t, 'binding-conflict-valid');
  const store = await openSharedOsSessionStoreV1(validOptions);
  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: TRACE_ID,
      requestMessageId: REQUEST_ID,
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    /request/i,
  );

  await store.deliver(context(RESPONDER), replyEnvelope(), new AbortController().signal);
  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: TRACE_ID,
      requestMessageId: REPLY_ID,
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    /request|reply/i,
  );

  await store.deliver(context(), requestEnvelope(), new AbortController().signal);
  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: `trace-${'8'.repeat(40)}`,
      requestMessageId: REQUEST_ID,
      taskId: 'task-1',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    /trace/i,
  );
  await assert.rejects(
    () => store.bindResponderGrantSet({
      traceId: TRACE_ID,
      requestMessageId: REQUEST_ID,
      taskId: 'task-2',
      grantIds: [RESPONDER_TASK_GRANT_ID],
    }),
    /task/i,
  );
});

test('atomically consumes exact manifest limits and preserves usage across restart', async t => {
  const options = await temporaryOptions(t, 'usage');
  const store = await openSharedOsSessionStoreV1(options);
  assert.equal(await store.getUsage(NAMESPACE_ID, REQUESTER_GRANT_ID), 0);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(await store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7), true);
  }
  assert.equal(await store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7), false);
  assert.equal(await store.getUsage(NAMESPACE_ID, REQUESTER_GRANT_ID), 7);

  const reopened = await openSharedOsSessionStoreV1(options);
  assert.equal(await reopened.getUsage(NAMESPACE_ID, REQUESTER_GRANT_ID), 7);
  assert.equal(await reopened.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7), false);
  await assert.rejects(
    () => reopened.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 8),
    /maximum|maxUses|manifest/i,
  );
  await assert.rejects(
    () => reopened.getUsage(`namespace-${'9'.repeat(40)}`, REQUESTER_GRANT_ID),
    /namespace/i,
  );
  await assert.rejects(
    () => reopened.getUsage(NAMESPACE_ID, `grant-${'9'.repeat(40)}`),
    /grant/i,
  );
});

test('serializes grant consumption across independent processes without overspending', async t => {
  const options = await temporaryOptions(t, 'cross-process');
  await openSharedOsSessionStoreV1(options);
  const subjectUrl = pathToFileURL(join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/runner/v1/sharedos-session-store.ts',
  )).href;
  const encoded = Buffer.from(JSON.stringify(options)).toString('base64url');
  const child = `
    import { openSharedOsSessionStoreV1 } from ${JSON.stringify(subjectUrl)};
    const options = JSON.parse(Buffer.from(process.env.SESSION_OPTIONS_B64, 'base64url').toString());
    const store = await openSharedOsSessionStoreV1(options);
    let consumed = 0;
    for (let index = 0; index < 12; index += 1) {
      if (await store.tryConsume(${JSON.stringify(NAMESPACE_ID)}, ${JSON.stringify(REQUESTER_GRANT_ID)}, 7)) consumed += 1;
    }
    process.stdout.write(String(consumed));
  `;
  const runChild = () => execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', child,
  ], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, SESSION_OPTIONS_B64: encoded },
  });
  const results = await Promise.all([runChild(), runChild(), runChild()]);
  assert.equal(
    results.reduce((total, result) => total + Number(result.stdout), 0),
    7,
  );
  const reopened = await openSharedOsSessionStoreV1(options);
  assert.equal(await reopened.getUsage(NAMESPACE_ID, REQUESTER_GRANT_ID), 7);
});

test('durably replays identical messages, rejects ID conflicts, and limits only requests per trace', async t => {
  const options = await temporaryOptions(t, 'messages');
  const store = await openSharedOsSessionStoreV1(options);
  const signal = new AbortController().signal;
  const request = requestEnvelope();
  const first = await store.deliver(context(), request, signal);
  assert.deepEqual(first, {
    status: 'accepted',
    messageId: REQUEST_ID,
    timestamp: request.createdAt,
  });
  assert.deepEqual(await store.deliver(context(), structuredClone(request), signal), first);

  const conflict = await store.deliver(context(), requestEnvelope({
    payload: { taskId: 'task-1', message: 'conflicting bytes' },
  }), signal);
  assert.deepEqual(conflict, {
    status: 'failed',
    messageId: REQUEST_ID,
    timestamp: request.createdAt,
    error: {
      code: 'MESSAGE_ID_CONFLICT',
      message: 'Message ID conflicts with the durable envelope',
      retryable: false,
    },
  });

  const secondRequest = requestEnvelope({
    id: `message-${'8'.repeat(40)}`,
    createdAt: '2026-08-26T01:00:04.000Z',
  });
  assert.deepEqual(await store.deliver(context(), secondRequest, signal), {
    status: 'failed',
    messageId: secondRequest.id,
    timestamp: secondRequest.createdAt,
    error: {
      code: 'MESSAGE_TRACE_ALREADY_HAS_REQUEST',
      message: 'The trace already has an accepted request',
      retryable: false,
    },
  });

  const reply = replyEnvelope();
  assert.deepEqual(await store.deliver(context(RESPONDER), reply, signal), {
    status: 'accepted',
    messageId: REPLY_ID,
    timestamp: reply.createdAt,
  });
  assert.deepEqual(await store.readMessage(REQUEST_ID), request);
  assert.deepEqual(await store.readMessage(REPLY_ID), reply);
  assert.equal(await store.readMessage(`message-${'9'.repeat(40)}`), null);

  const noProvenance = requestEnvelope({
    id: `message-${'9'.repeat(40)}`,
    traceId: `trace-${'9'.repeat(40)}`,
    createdAt: '2026-08-26T01:00:05.000Z',
  }) as SoMessageEnvelope & { provenance?: unknown };
  delete noProvenance.provenance;
  assert.equal((await store.deliver(
    context(REQUESTER, { traceId: noProvenance.traceId }),
    noProvenance,
    signal,
  )).status, 'accepted');
  assert.deepEqual(await store.readMessage(noProvenance.id), noProvenance);

  const reopened = await openSharedOsSessionStoreV1(options);
  assert.deepEqual(await reopened.readMessage(REQUEST_ID), request);
});

test('rechecks cancellation immediately before publishing a message', async t => {
  const options = await temporaryOptions(t, 'message-cancel');
  const store = await openSharedOsSessionStoreV1(options);
  await assert.rejects(
    () => store.deliver(context(), requestEnvelope(), abortOnThrowCheck(3)),
    /abort/i,
  );
  assert.equal(await store.readMessage(REQUEST_ID), null);
});

test('persists digest-chained audit windows without copying message payloads', async t => {
  const options = await temporaryOptions(t, 'audit');
  const store = await openSharedOsSessionStoreV1(options);
  await store.deliver(context(), requestEnvelope(), new AbortController().signal);
  const first = auditEvent();
  const second = auditEvent({
    type: 'resource.invoked',
    outcome: 'succeeded',
    operationId: `call-${'8'.repeat(40)}`,
  });

  assert.deepEqual(await store.snapshotAudit(), { nextSequence: 0 });
  await store.record(first);
  const middle = await store.snapshotAudit();
  await store.record(first);
  await store.record(second);
  const end = await store.snapshotAudit();
  assert.deepEqual(middle, { nextSequence: 1 });
  assert.deepEqual(end, { nextSequence: 3 });
  assert.deepEqual(
    await store.readAuditWindow({
      fromSequence: middle.nextSequence,
      toSequenceExclusive: end.nextSequence,
    }),
    [first, second],
  );
  await assert.rejects(
    () => store.readAuditWindow({ fromSequence: 0, toSequenceExclusive: 4 }),
    /window|sequence/i,
  );

  const auditBytes = await directoryText(sessionPath(options.runDirectory, 'audit'));
  assert.equal(auditBytes.includes('private request payload'), false);
  const reopened = await openSharedOsSessionStoreV1(options);
  assert.deepEqual(
    await reopened.readAuditWindow({ fromSequence: 0, toSequenceExclusive: 3 }),
    [first, first, second],
  );
});

test('grant loading participates in the mutation fence', async t => {
  const options = await temporaryOptions(t, 'load-fence');
  const store = await openSharedOsSessionStoreV1(options);
  const lockDirectory = sessionPath(options.runDirectory, 'mutation.lock');
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
    apiVersion: 'sharedeval-sharedos-mutation-lock/v1',
    pid: process.pid,
    token: '11111111-1111-4111-8111-111111111111',
  })}\n`);

  let settled = false;
  const loading = store.load(context(), new AbortController().signal)
    .then(result => {
      settled = true;
      return result;
    });
  await delay(30);
  assert.equal(settled, false);
  await rm(lockDirectory, { recursive: true, force: false });
  assert.deepEqual((await loading).map(grant => grant.id), [REQUESTER_GRANT_ID]);
});

test('an aborted grant load stops waiting for a live mutation fence', async t => {
  const options = await temporaryOptions(t, 'load-fence-cancel');
  const store = await openSharedOsSessionStoreV1(options);
  const lockDirectory = sessionPath(options.runDirectory, 'mutation.lock');
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
    apiVersion: 'sharedeval-sharedos-mutation-lock/v1',
    pid: process.pid,
    token: '33333333-3333-4333-8333-333333333333',
  })}\n`);
  const controller = new AbortController();
  const loading = store.load(context(), controller.signal).then(
    () => 'resolved',
    error => error instanceof Error ? error.message : String(error),
  );
  setTimeout(() => controller.abort(), 20);
  const early = await Promise.race([
    loading,
    delay(300).then(() => 'timed out'),
  ]);
  await rm(lockDirectory, { recursive: true, force: false });
  await loading;
  assert.match(early, /abort/i);
});

test('fails loud without mutation when a stale lock makes the boundary indeterminate', async t => {
  const options = await temporaryOptions(t, 'stale-lock');
  const store = await openSharedOsSessionStoreV1(options);
  const lockDirectory = sessionPath(options.runDirectory, 'mutation.lock');
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, 'owner.json'), `${JSON.stringify({
    apiVersion: 'sharedeval-sharedos-mutation-lock/v1',
    pid: 2_147_483_647,
    token: '22222222-2222-4222-8222-222222222222',
  })}\n`);

  await assert.rejects(
    () => store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7),
    /stale.*lock|lock.*indeterminate/i,
  );
  assert.deepEqual(await readdir(sessionPath(options.runDirectory, 'usage')), []);
  assert.deepEqual((await readdir(lockDirectory)).sort(), ['owner.json']);
});

test('durable close fences queued and future mutations while preserving host reads', async t => {
  const options = await temporaryOptions(t, 'close');
  const store = await openSharedOsSessionStoreV1(options);
  const beforeClose = store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7);
  const closing = store.close();
  const afterClose = store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7);
  assert.equal(await beforeClose, true);
  await closing;
  assert.equal(await afterClose, false);
  await store.close();

  assert.deepEqual(await store.load(context(), new AbortController().signal), []);
  assert.equal(await store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7), false);
  const delivery = await store.deliver(
    context(),
    requestEnvelope(),
    new AbortController().signal,
  );
  assert.equal(delivery.status, 'failed');
  if (delivery.status === 'failed') assert.equal(delivery.error.code, 'SESSION_CLOSED');
  await assert.rejects(() => store.record(auditEvent()), /closed/i);

  const reopened = await openSharedOsSessionStoreV1(options);
  assert.deepEqual(await reopened.load(context(), new AbortController().signal), []);
  assert.equal(await reopened.getUsage(NAMESPACE_ID, REQUESTER_GRANT_ID), 1);
});

test('refuses to publish close over a malformed durable lane', async t => {
  const options = await temporaryOptions(t, 'close-malformed');
  const store = await openSharedOsSessionStoreV1(options);
  await store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7);
  const usageDirectory = sessionPath(options.runDirectory, 'usage');
  const record = (await readdir(usageDirectory)).find(name => name.startsWith('record-'));
  assert.ok(record);
  await writeFile(join(usageDirectory, record), '{"malformed":true}\n');

  await assert.rejects(() => store.close(), /usage.*(?:malformed|record)|malformed.*usage/i);
  await assert.rejects(
    () => readFile(sessionPath(options.runDirectory, 'closed.json'), 'utf8'),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

test('fails loud on malformed or digest-conflicting usage, message, audit, and binding records', async t => {
  const options = await temporaryOptions(t, 'malformed');
  const store = await openSharedOsSessionStoreV1(options);
  await store.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7);
  await store.deliver(context(), requestEnvelope(), new AbortController().signal);
  await store.record(auditEvent());

  for (const lane of ['usage', 'messages', 'audit'] as const) {
    const laneDirectory = sessionPath(options.runDirectory, lane);
    const record = (await readdir(laneDirectory)).find(name => name.startsWith('record-'));
    assert.ok(record);
    const original = await readFile(join(laneDirectory, record), 'utf8');
    await writeFile(join(laneDirectory, record), '{"malformed":true}\n');
    await assert.rejects(
      () => openSharedOsSessionStoreV1(options),
      /malformed|digest|record/i,
    );
    await writeFile(join(laneDirectory, record), original);
  }

  const bindingPath = sessionPath(options.runDirectory, 'binding.json');
  const authority = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
  authority.bindingDigest = createHash('sha256').update('foreign').digest('hex');
  await writeFile(bindingPath, `${JSON.stringify(authority)}\n`);
  await assert.rejects(
    () => openSharedOsSessionStoreV1(options),
    /binding.*(?:digest|conflict)|(?:digest|conflict).*binding/i,
  );
});

test('rejects symlinked roots, symlinked authority, special records, and lock substitution', async t => {
  const symlinkOptions = await temporaryOptions(t, 'symlink-root');
  const target = join(dirname(symlinkOptions.runDirectory), 'target');
  await mkdir(target);
  await symlink(target, symlinkOptions.runDirectory);
  await assert.rejects(() => openSharedOsSessionStoreV1(symlinkOptions), /symlink|directory/i);

  const authorityOptions = await temporaryOptions(t, 'symlink-authority');
  const authorityStore = await openSharedOsSessionStoreV1(authorityOptions);
  const bindingPath = sessionPath(authorityOptions.runDirectory, 'binding.json');
  const savedBinding = `${bindingPath}.saved`;
  await writeFile(savedBinding, await readFile(bindingPath));
  await rm(bindingPath);
  await symlink(savedBinding, bindingPath);
  await assert.rejects(
    () => authorityStore.load(context(), new AbortController().signal),
    /symlink|regular/i,
  );

  const recordOptions = await temporaryOptions(t, 'special-record');
  const recordStore = await openSharedOsSessionStoreV1(recordOptions);
  await mkdir(sessionPath(recordOptions.runDirectory, 'messages', 'record-000000000000.json'));
  await assert.rejects(
    () => recordStore.readMessage(REQUEST_ID),
    /regular|record/i,
  );

  const lockOptions = await temporaryOptions(t, 'lock-substitution');
  const lockStore = await openSharedOsSessionStoreV1(lockOptions);
  await symlink(
    dirname(lockOptions.runDirectory),
    sessionPath(lockOptions.runDirectory, 'mutation.lock'),
  );
  await assert.rejects(
    () => lockStore.tryConsume(NAMESPACE_ID, REQUESTER_GRANT_ID, 7),
    /lock|symlink|unsafe/i,
  );
});

test('rejects FIFO records without blocking the operation lane', { timeout: 3_000 }, async t => {
  const options = await temporaryOptions(t, 'fifo-record');
  await openSharedOsSessionStoreV1(options);
  const fifo = sessionPath(options.runDirectory, 'messages', 'record-000000000000.json');
  await execFileAsync('mkfifo', [fifo]);
  const subjectUrl = pathToFileURL(join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/runner/v1/sharedos-session-store.ts',
  )).href;
  const child = `
    import { openSharedOsSessionStoreV1 } from ${JSON.stringify(subjectUrl)};
    const options = JSON.parse(Buffer.from(process.env.SESSION_OPTIONS_B64, 'base64url').toString());
    try {
      await openSharedOsSessionStoreV1(options);
      process.stdout.write('unexpected success');
    } catch (error) {
      process.stdout.write(error instanceof Error ? error.message : String(error));
    }
  `;
  const result = await execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', child,
  ], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      SESSION_OPTIONS_B64: Buffer.from(JSON.stringify(options)).toString('base64url'),
    },
    timeout: 1_000,
  });
  assert.match(result.stdout, /regular|special|fifo/i);
});
