import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type {
  SoAccessContext,
  SoResourceOperation,
} from '../../src/execution/sharedos/v1/contracts.js';
import {
  createSharedOsFileProviderV1,
  decodeFileVersionV1,
  encodeFileVersionV1,
  type SharedOsFileProviderV1,
} from '../../src/runner/v1/sharedos-file-provider.js';
import { FileMemoryFormatErrorV1 } from '../../src/runner/v1/file-memory.js';
import type {
  FileReadReceiptV1,
  FileWorkspacePortV1,
  FileWorkspaceSnapshotV1,
  ReplaceMemoryResultV1,
} from '../../src/runner/v1/file-workspace.js';
import type { AgentWorkspaceFilePathV1 } from '../../src/runner/v1/agent-workspace.js';

const FILES = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];
const OWNER = { kind: 'service', serviceId: 'sharedeval' } as const;
const TURN_NOW = '2099-08-26T00:00:00.000Z';
const DEADLINE_MS = 60_000;

test('encodes and decodes only canonical non-negative safe-integer file versions', () => {
  for (const [version, encoded] of [
    [0, '0'],
    [1, '1'],
    [42, '42'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ] as const) {
    assert.equal(encodeFileVersionV1(version), encoded);
    assert.equal(decodeFileVersionV1(encoded), version);
  }

  for (const value of [
    '',
    ' ',
    ' 1',
    '1 ',
    '+1',
    '-0',
    '-1',
    '01',
    '00',
    '1.0',
    '1e0',
    '9007199254740992',
    1,
    null,
  ]) {
    assert.throws(() => decodeFileVersionV1(value), /canonical file version/i);
  }

  for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeFileVersionV1(value), /non-negative safe integer/i);
  }
});

test('routes both trusted actors to exactly their four files without enforcing grants again', async () => {
  const requester = new FakeWorkspace('requester');
  const responder = new FakeWorkspace('responder');
  const provider = createProvider(requester, responder);

  assert.equal(provider.namespace, 'files');
  for (const [actorId, workspace] of [
    ['requester', requester],
    ['responder', responder],
  ] as const) {
    for (const [index, path] of FILES.entries()) {
      const result = await provider.invoke(operation({
        actorId,
        traceId: `trace-${actorId}`,
        operationId: `read-${actorId}-${index}`,
        path: [path],
        action: 'read',
        context: {
          authority: { kind: 'agent', agentId: 'not-a-provider-policy-input' },
          purpose: 'purpose-authorized-by-sharedos-upstream',
          enabledToolNamespaces: [],
        },
      }), neverAbort());

      assert.deepEqual(result, {
        status: 'succeeded',
        operationId: `read-${actorId}-${index}`,
        output: {
          content: `${actorId}:${path}:v0`,
          version: '0',
          sha256: sha256Text(`${actorId}:${path}:v0`),
          byteLength: Buffer.byteLength(`${actorId}:${path}:v0`),
        },
        completedAt: TURN_NOW,
      });
    }

    assert.equal(workspace.reads.length, 4);
    assert.ok(workspace.reads.every(read => read.actorId === actorId));
    assert.ok(workspace.reads.every(read => read.signal instanceof AbortSignal));
    assert.deepEqual(
      [...new Set(workspace.reads.map(read => read.deadlineAtMs))],
      [Date.parse(TURN_NOW) + DEADLINE_MS],
      'every operation in the frozen turn context receives one absolute deadline',
    );

    const receipts = await provider.readReceipts({
      actorId,
      traceId: `trace-${actorId}`,
    });
    assert.deepEqual(receipts, FILES.map((path, index) => ({
      runId: 'run-1',
      actorId,
      traceId: `trace-${actorId}`,
      operationId: `read-${actorId}-${index}`,
      path,
      action: 'read',
      outcome: 'succeeded',
      version: 0,
      sha256: sha256Text(`${actorId}:${path}:v0`),
      byteLength: Buffer.byteLength(`${actorId}:${path}:v0`),
    })));
    assert.equal(JSON.stringify(receipts).includes(`${actorId}:AGENT.md:v0`), false);
  }

  assert.deepEqual(await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-responder',
  }), []);
  assert.equal('authorize' in provider, false);
  assert.equal('grant' in provider, false);
});

test('rejects malformed, foreign, traversal, special, and unsupported resources before workspace work', async () => {
  const requester = new FakeWorkspace('requester');
  const responder = new FakeWorkspace('responder');
  const provider = createProvider(requester, responder);
  const valid = operation({
    actorId: 'requester',
    operationId: 'invalid',
    path: ['AGENT.md'],
    action: 'read',
  });
  const cases: SoResourceOperation[] = [
    { ...valid, resource: { ...valid.resource, namespace: 'memory' } },
    { ...valid, resource: { ...valid.resource, path: [] } },
    { ...valid, resource: { ...valid.resource, path: ['requester', 'AGENT.md'] } },
    { ...valid, resource: { ...valid.resource, path: ['AGENT.md', 'extra'] } },
    { ...valid, resource: { ...valid.resource, path: ['..'] } },
    { ...valid, resource: { ...valid.resource, path: ['.'] } },
    { ...valid, resource: { ...valid.resource, path: ['/etc/passwd'] } },
    { ...valid, resource: { ...valid.resource, path: ['COO.md'] } },
    { ...valid, resource: { ...valid.resource, path: ['MEMORY.md\0'] } },
    { ...valid, resource: { namespace: 'files', path: ['AGENT.md'] } },
    {
      ...valid,
      resource: {
        ...valid.resource,
        owner: { kind: 'service', serviceId: 'somewhere-else' },
      },
    },
    { ...valid, action: 'list' },
    { ...valid, action: 'replace' },
    { ...valid, input: {} },
    {
      ...valid,
      context: { ...valid.context, actor: { kind: 'human', userId: 'requester' } },
    },
    {
      ...valid,
      context: { ...valid.context, actor: { kind: 'agent', agentId: 'unknown' } },
    },
    { ...valid, context: { ...valid.context, traceId: '' } },
  ];

  for (const [index, candidate] of cases.entries()) {
    const result = await provider.invoke({
      ...candidate,
      operationId: `invalid-${index}`,
    }, neverAbort());
    assert.equal(result.status, 'denied', `invalid case ${index}`);
  }
  assert.equal(requester.reads.length, 0);
  assert.equal(requester.replacements.length, 0);
  assert.equal(responder.reads.length, 0);
  assert.equal(responder.replacements.length, 0);
});

test('requires a same-turn MEMORY read and permits at most one committed publication', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));

  const beforeRead = await provider.invoke(replaceOperation({
    traceId: 'trace-1',
    operationId: 'replace-before-read',
    expectedVersion: '0',
    content: 'requester memory v1',
  }), neverAbort());
  assert.equal(beforeRead.status, 'denied');
  assert.equal(requester.replacements.length, 0);

  await provider.invoke(readMemoryOperation('trace-1', 'read-memory-0'), neverAbort());
  const committed = await provider.invoke(replaceOperation({
    traceId: 'trace-1',
    operationId: 'replace-0-1',
    expectedVersion: '0',
    content: 'requester memory v1',
  }), neverAbort());
  assert.deepEqual(committed, {
    status: 'succeeded',
    operationId: 'replace-0-1',
    output: {
      outcome: 'committed',
      version: '1',
      sha256: sha256Text('requester memory v1'),
      byteLength: Buffer.byteLength('requester memory v1'),
    },
    completedAt: TURN_NOW,
  });

  await provider.invoke(readMemoryOperation('trace-1', 'read-memory-1'), neverAbort());
  const second = await provider.invoke(replaceOperation({
    traceId: 'trace-1',
    operationId: 'replace-1-2',
    expectedVersion: '1',
    content: 'requester memory v2',
  }), neverAbort());
  assert.equal(second.status, 'denied');
  assert.equal(requester.replacements.length, 1);

  const receipts = await provider.readReceipts({ actorId: 'requester', traceId: 'trace-1' });
  assert.deepEqual(receipts.at(1), {
    runId: 'run-1',
    actorId: 'requester',
    traceId: 'trace-1',
    operationId: 'replace-0-1',
    path: 'MEMORY.md',
    action: 'replace',
    outcome: 'committed',
    expectedVersion: 0,
    previousVersion: 0,
    previousSha256: sha256Text('requester:MEMORY.md:v0'),
    previousByteLength: Buffer.byteLength('requester:MEMORY.md:v0'),
    previousBytesBase64: Buffer.from('requester:MEMORY.md:v0').toString('base64'),
    newBytesBase64: Buffer.from('requester memory v1').toString('base64'),
    version: 1,
    sha256: sha256Text('requester memory v1'),
    byteLength: Buffer.byteLength('requester memory v1'),
  });

  await provider.invoke(readMemoryOperation('trace-2', 'read-memory-next-turn'), neverAbort());
  const nextTurn = await provider.invoke(replaceOperation({
    traceId: 'trace-2',
    operationId: 'replace-next-turn',
    expectedVersion: '1',
    content: 'requester memory v2',
  }), neverAbort());
  assertSucceededOutcome(nextTurn, 'committed');
  assert.equal(requester.replacements.length, 2);
});

test('returns a versioned conflict, then allows one fresh-read retry in the same turn', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));

  await provider.invoke(readMemoryOperation('trace-conflict', 'read-v0'), neverAbort());
  requester.externalReplace('external memory v1');
  const conflict = await provider.invoke(replaceOperation({
    traceId: 'trace-conflict',
    operationId: 'replace-conflict',
    expectedVersion: '0',
    content: 'candidate memory v1',
  }), neverAbort());
  assert.deepEqual(conflict, {
    status: 'succeeded',
    operationId: 'replace-conflict',
    output: {
      outcome: 'conflict',
      version: '1',
      sha256: sha256Text('external memory v1'),
      byteLength: Buffer.byteLength('external memory v1'),
    },
    completedAt: TURN_NOW,
  });

  const staleRetry = await provider.invoke(replaceOperation({
    traceId: 'trace-conflict',
    operationId: 'replace-without-fresh-read',
    expectedVersion: '0',
    content: 'stale retry',
  }), neverAbort());
  assert.equal(staleRetry.status, 'denied');
  assert.equal(requester.replacements.length, 1);

  await provider.invoke(readMemoryOperation('trace-conflict', 'read-v1'), neverAbort());
  const retry = await provider.invoke(replaceOperation({
    traceId: 'trace-conflict',
    operationId: 'replace-v1-v2',
    expectedVersion: '1',
    content: 'requester memory v2',
  }), neverAbort());
  assertSucceededOutcome(retry, 'committed');
  assert.equal(requester.replacements.length, 2);

  const receipts = await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-conflict',
  });
  assert.deepEqual(receipts.filter(receipt => receipt.action === 'replace').map(receipt => ({
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    version: receipt.version,
  })), [
    { operationId: 'replace-conflict', outcome: 'conflict', version: 1 },
    { operationId: 'replace-v1-v2', outcome: 'committed', version: 2 },
  ]);
});

test('decodes expectedVersion and validates exact replacement input before workspace work', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));
  await provider.invoke(readMemoryOperation('trace-invalid-input', 'read-first'), neverAbort());

  const invalidInputs: unknown[] = [
    { content: 'next' },
    { expectedVersion: '0' },
    { content: 'next', expectedVersion: 0 },
    { content: 'next', expectedVersion: '00' },
    { content: 'next', expectedVersion: '+0' },
    { content: 'next', expectedVersion: '0.0' },
    { content: 'next', expectedVersion: '0', extra: true },
    ['next', '0'],
    null,
  ];
  for (const [index, input] of invalidInputs.entries()) {
    const result = await provider.invoke({
      ...replaceOperation({
        traceId: 'trace-invalid-input',
        operationId: `invalid-input-${index}`,
        expectedVersion: '0',
        content: 'next',
      }),
      input: input as SoResourceOperation['input'],
    }, neverAbort());
    assert.equal(result.status, 'denied', `input case ${index}`);
  }
  assert.equal(requester.replacements.length, 0);

  const guessed = await provider.invoke(replaceOperation({
    traceId: 'trace-invalid-input',
    operationId: 'guessed-version',
    expectedVersion: '1',
    content: 'next',
  }), neverAbort());
  assert.equal(guessed.status, 'denied');
  assert.equal(requester.replacements.length, 0);
});

test('serializes same-turn replacements so concurrent calls cannot publish twice', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));
  await provider.invoke(readMemoryOperation('trace-race', 'read-race'), neverAbort());

  const [first, second] = await Promise.all([
    provider.invoke(replaceOperation({
      traceId: 'trace-race',
      operationId: 'race-1',
      expectedVersion: '0',
      content: 'first winner',
    }), neverAbort()),
    provider.invoke(replaceOperation({
      traceId: 'trace-race',
      operationId: 'race-2',
      expectedVersion: '0',
      content: 'second winner',
    }), neverAbort()),
  ]);

  assert.deepEqual([first.status, second.status], ['succeeded', 'denied']);
  assert.equal(requester.replacements.length, 1);
  assert.equal(requester.version, 1);
});

test('propagates cancellation, preserves authoritative commits, and enforces the turn deadline', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));

  const before = new AbortController();
  before.abort(new Error('cancel-before-read'));
  await assert.rejects(
    provider.invoke(readMemoryOperation('trace-cancel-before', 'cancel-before'), before.signal),
    /cancel-before-read/,
  );
  assert.equal(requester.reads.length, 0);

  const duringRead = new AbortController();
  requester.afterNextRead = () => duringRead.abort(new Error('cancel-during-read'));
  await assert.rejects(
    provider.invoke(readMemoryOperation('trace-cancel-read', 'cancel-read'), duringRead.signal),
    /cancel-during-read/,
  );
  assert.deepEqual(await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-cancel-read',
  }), []);

  await provider.invoke(readMemoryOperation('trace-cancel-replace', 'read-for-replace'), neverAbort());
  const duringReplace = new AbortController();
  requester.afterNextReplace = () => duringReplace.abort(new Error('cancel-after-publication'));
  const committed = await provider.invoke(replaceOperation({
    traceId: 'trace-cancel-replace',
    operationId: 'committed-before-cancel-observed',
    expectedVersion: '0',
    content: 'published despite late cancellation',
  }), duringReplace.signal);
  assertSucceededOutcome(committed, 'committed');
  assert.equal((await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-cancel-replace',
  })).at(-1)?.outcome, 'committed');

  const expired = await provider.invoke(operation({
    actorId: 'requester',
    traceId: 'trace-expired',
    operationId: 'expired',
    path: ['AGENT.md'],
    action: 'read',
    context: { now: '2000-01-01T00:00:00.000Z' },
  }), neverAbort());
  assert.equal(expired.status, 'failed');
  assert.equal(expired.status === 'failed' && expired.error.code, 'file_deadline_exceeded');
  assert.equal(requester.reads.filter(read => read.path === 'AGENT.md').length, 0);
});

test('sanitizes workspace failures and never records them as successful evidence', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));
  requester.failNextRead = new Error('private filesystem path /secret/workspace');

  const result = await provider.invoke(readMemoryOperation('trace-failed', 'failed-read'), neverAbort());
  assert.deepEqual(result, {
    status: 'failed',
    operationId: 'failed-read',
    error: {
      code: 'file_workspace_failed',
      message: 'The actor file workspace operation failed.',
    },
    completedAt: TURN_NOW,
  });
  assert.deepEqual(await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-failed',
  }), []);
  assert.doesNotMatch(JSON.stringify(result), /secret|filesystem path/i);
});

test('surfaces actor-authored MEMORY contract violations as correctable denials, not workspace faults', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));

  await provider.invoke(readMemoryOperation('trace-format', 'read-memory'), neverAbort());
  requester.failNextReplace = new FileMemoryFormatErrorV1(
    'MEMORY row 2 must use TASK-ID [status] — note',
  );
  const denied = await provider.invoke(replaceOperation({
    traceId: 'trace-format',
    operationId: 'replace-malformed',
    expectedVersion: '0',
    content: 'malformed memory content',
  }), neverAbort());
  assert.equal(denied.status, 'denied');
  assert.equal(
    denied.status === 'denied' && denied.error.code,
    'file_memory_format_invalid',
  );
  assert.match(
    denied.status === 'denied' ? denied.error.message : '',
    /MEMORY row 2 must use TASK-ID \[status\] — note/,
  );
  assert.match(
    denied.status === 'denied' ? denied.error.message : '',
    /pending, answered, refused, or error/,
  );

  const corrected = await provider.invoke(replaceOperation({
    traceId: 'trace-format',
    operationId: 'replace-corrected',
    expectedVersion: '0',
    content: 'corrected memory content',
  }), neverAbort());
  assertSucceededOutcome(corrected, 'committed');
  assert.equal((await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-format',
  })).filter(receipt => receipt.action === 'replace').length, 1);
});

test('still sanitizes genuine workspace replace faults as failures', async () => {
  const requester = new FakeWorkspace('requester');
  const provider = createProvider(requester, new FakeWorkspace('responder'));

  await provider.invoke(readMemoryOperation('trace-fault', 'read-memory'), neverAbort());
  requester.failNextReplace = new Error('private filesystem path /secret/workspace');
  const failed = await provider.invoke(replaceOperation({
    traceId: 'trace-fault',
    operationId: 'replace-fault',
    expectedVersion: '0',
    content: 'candidate memory',
  }), neverAbort());
  assert.deepEqual(failed, {
    status: 'failed',
    operationId: 'replace-fault',
    error: {
      code: 'file_workspace_failed',
      message: 'The actor file workspace operation failed.',
    },
    completedAt: TURN_NOW,
  });
  assert.doesNotMatch(JSON.stringify(failed), /secret|filesystem path/i);
});

test('fails closed on malformed workspace results instead of forging file evidence', async () => {
  const candidate = 'candidate memory';
  const malformedResults: unknown[] = [
    null,
    1,
    Object.defineProperty({}, 'outcome', {
      enumerable: true,
      get() {
        throw new Error('private hostile workspace getter');
      },
    }),
    {
      outcome: 'committed',
      version: 2,
      sha256: sha256Text(candidate),
      byteLength: Buffer.byteLength(candidate),
    },
    {
      outcome: 'committed',
      version: 1,
      sha256: 'not-a-sha256',
      byteLength: Buffer.byteLength(candidate),
    },
    {
      outcome: 'committed',
      version: 1,
      sha256: sha256Text(candidate),
      byteLength: Buffer.byteLength(candidate) + 1,
    },
    {
      outcome: 'conflict',
      version: 0,
      sha256: 'f'.repeat(64),
      byteLength: 1,
    },
    {
      outcome: 'conflict',
      version: 1,
      sha256: 'not-a-sha256',
      byteLength: 1,
    },
    {
      outcome: 'conflict',
      version: 1,
      sha256: 'f'.repeat(64),
      byteLength: 1,
      durability: 'published_unsynced',
    },
  ];

  for (const [index, malformed] of malformedResults.entries()) {
    const requester = new FakeWorkspace('requester');
    const provider = createProvider(requester, new FakeWorkspace('responder'));
    const traceId = `trace-malformed-${index}`;
    await provider.invoke(readMemoryOperation(traceId, `read-${index}`), neverAbort());
    requester.nextReplaceResult = { value: malformed };
    const result = await provider.invoke(replaceOperation({
      traceId,
      operationId: `replace-${index}`,
      expectedVersion: '0',
      content: candidate,
    }), neverAbort());
    assert.equal(result.status, 'failed', `malformed result ${index}`);
    assert.equal(
      result.status === 'failed' && result.error.code,
      'file_workspace_invalid_result',
      `malformed result ${index}`,
    );
    assert.equal((await provider.readReceipts({
      actorId: 'requester',
      traceId,
    })).filter(receipt => receipt.action === 'replace').length, 0);
    await provider.close();
  }

  const malformedRead = new FakeWorkspace('requester');
  malformedRead.nextReadResult = { value: null };
  const readProvider = createProvider(malformedRead, new FakeWorkspace('responder'));
  const readResult = await readProvider.invoke(
    readMemoryOperation('trace-malformed-read', 'malformed-read'),
    neverAbort(),
  );
  assert.equal(readResult.status, 'failed');
  assert.equal(
    readResult.status === 'failed' && readResult.error.code,
    'file_workspace_invalid_result',
  );
});

test('snapshots construction bindings so caller mutation cannot reroute work or evidence', async () => {
  const requester = new FakeWorkspace('requester');
  const responder = new FakeWorkspace('responder');
  const rerouted = new FakeWorkspace('requester');
  const options = {
    runId: 'run-1',
    deadlineMs: DEADLINE_MS,
    requester: { actorId: 'requester', workspace: requester as FileWorkspacePortV1 },
    responder: { actorId: 'responder', workspace: responder as FileWorkspacePortV1 },
  };
  const provider = createSharedOsFileProviderV1(options);
  options.runId = 'mutated-run';
  options.deadlineMs = 1;
  options.requester.actorId = 'mutated-actor';
  options.requester.workspace = rerouted;

  const result = await provider.invoke(
    readMemoryOperation('trace-snapshot', 'read-snapshot'),
    neverAbort(),
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(requester.reads.length, 1);
  assert.equal(rerouted.reads.length, 0);
  assert.equal(
    requester.reads[0]?.deadlineAtMs,
    Date.parse(TURN_NOW) + DEADLINE_MS,
  );
  assert.equal((await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-snapshot',
  }))[0]?.runId, 'run-1');
});

test('close invalidates ephemeral evidence and fails closed without claiming recovery authority', async () => {
  const requester = new FakeWorkspace('requester');
  const responder = new FakeWorkspace('responder');
  const provider = createProvider(requester, responder);
  await provider.invoke(readMemoryOperation('trace-close', 'read-before-close'), neverAbort());
  assert.equal((await provider.readReceipts({
    actorId: 'requester',
    traceId: 'trace-close',
  })).length, 1);

  await provider.close();
  await provider.close();
  await assert.rejects(
    provider.readReceipts({ actorId: 'requester', traceId: 'trace-close' }),
    /file provider is closed/i,
  );
  const afterClose = await provider.invoke(
    readMemoryOperation('trace-close', 'read-after-close'),
    neverAbort(),
  );
  assert.equal(afterClose.status, 'failed');
  assert.equal(afterClose.status === 'failed' && afterClose.error.code, 'file_provider_closed');
  assert.equal(requester.reads.length, 1);

  const reopenedProcessView = createProvider(requester, responder);
  assert.deepEqual(await reopenedProcessView.readReceipts({
    actorId: 'requester',
    traceId: 'trace-close',
  }), []);
  await reopenedProcessView.close();
});

test('rejects ambiguous construction before exposing a provider', () => {
  const requester = new FakeWorkspace('same');
  const responder = new FakeWorkspace('same');
  assert.throws(() => createSharedOsFileProviderV1({
    runId: 'run-1',
    deadlineMs: DEADLINE_MS,
    requester: { actorId: 'same', workspace: requester },
    responder: { actorId: 'same', workspace: responder },
  }), /distinct actor/i);
  assert.throws(() => createSharedOsFileProviderV1({
    runId: '',
    deadlineMs: DEADLINE_MS,
    requester: { actorId: 'requester', workspace: new FakeWorkspace('requester') },
    responder: { actorId: 'responder', workspace: new FakeWorkspace('responder') },
  }), /run id/i);
  assert.throws(() => createSharedOsFileProviderV1({
    runId: 'run-1',
    deadlineMs: 0,
    requester: { actorId: 'requester', workspace: new FakeWorkspace('requester') },
    responder: { actorId: 'responder', workspace: new FakeWorkspace('responder') },
  }), /deadline/i);
});

function createProvider(
  requester: FakeWorkspace,
  responder: FakeWorkspace,
): SharedOsFileProviderV1 {
  return createSharedOsFileProviderV1({
    runId: 'run-1',
    deadlineMs: DEADLINE_MS,
    requester: { actorId: 'requester', workspace: requester },
    responder: { actorId: 'responder', workspace: responder },
  });
}

function readMemoryOperation(traceId: string, operationId: string): SoResourceOperation {
  return operation({
    actorId: 'requester',
    traceId,
    operationId,
    path: ['MEMORY.md'],
    action: 'read',
  });
}

function replaceOperation(input: {
  traceId: string;
  operationId: string;
  expectedVersion: string;
  content: string;
}): SoResourceOperation {
  return operation({
    actorId: 'requester',
    traceId: input.traceId,
    operationId: input.operationId,
    path: ['MEMORY.md'],
    action: 'replace',
    input: {
      content: input.content,
      expectedVersion: input.expectedVersion,
    },
  });
}

function operation(input: {
  actorId: string;
  traceId?: string;
  operationId: string;
  path: string[];
  action: string;
  input?: SoResourceOperation['input'];
  context?: Partial<SoAccessContext>;
}): SoResourceOperation {
  const baseContext: SoAccessContext = {
    namespaceId: 'namespace-1',
    actor: { kind: 'agent', agentId: input.actorId },
    authority: OWNER,
    owner: OWNER,
    purpose: 'sharedeval:pact-pair',
    traceId: input.traceId ?? 'trace-1',
    enabledToolNamespaces: ['files'],
    now: TURN_NOW,
  };
  const context = { ...baseContext, ...input.context } as SoAccessContext;
  return {
    operationId: input.operationId,
    context,
    resource: { namespace: 'files', path: input.path, owner: context.owner },
    action: input.action,
    ...(input.input === undefined ? {} : { input: input.input }),
  };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

function assertSucceededOutcome(
  result: Awaited<ReturnType<SharedOsFileProviderV1['invoke']>>,
  outcome: 'committed' | 'conflict',
): void {
  assert.equal(result.status, 'succeeded');
  assert.ok(
    result.status === 'succeeded'
    && typeof result.output === 'object'
    && result.output !== null
    && !Array.isArray(result.output),
  );
  assert.equal(result.output['outcome'], outcome);
}

type WorkspaceControl = {
  actorId: string;
  path: AgentWorkspaceFilePathV1;
  signal?: AbortSignal;
  deadlineAtMs?: number;
};

class FakeWorkspace implements FileWorkspacePortV1 {
  readonly reads: WorkspaceControl[] = [];
  readonly replacements: Array<{
    actorId: string;
    expectedVersion: number;
    content: string;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }> = [];
  version = 0;
  afterNextRead?: () => void;
  afterNextReplace?: () => void;
  failNextRead?: Error;
  failNextReplace?: Error;
  nextReadResult?: { value: unknown };
  nextReplaceResult?: { value: unknown };
  private memory: string;

  constructor(readonly actorId: string) {
    this.memory = `${actorId}:MEMORY.md:v0`;
  }

  async read(input: WorkspaceControl): Promise<{
    content: string;
    receipt: FileReadReceiptV1;
  }> {
    this.reads.push({ ...input });
    if (this.nextReadResult) {
      const result = this.nextReadResult.value;
      this.nextReadResult = undefined;
      return result as Awaited<ReturnType<FileWorkspacePortV1['read']>>;
    }
    if (this.failNextRead) {
      const error = this.failNextRead;
      this.failNextRead = undefined;
      throw error;
    }
    const content = input.path === 'MEMORY.md'
      ? this.memory
      : `${this.actorId}:${input.path}:v${this.version}`;
    const result = {
      content,
      receipt: this.receipt(input.path, content),
    };
    const after = this.afterNextRead;
    this.afterNextRead = undefined;
    after?.();
    return result;
  }

  async replaceMemory(input: {
    actorId: string;
    expectedVersion: number;
    content: string;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }): Promise<ReplaceMemoryResultV1> {
    this.replacements.push({ ...input });
    if (this.failNextReplace) {
      const error = this.failNextReplace;
      this.failNextReplace = undefined;
      throw error;
    }
    if (this.nextReplaceResult) {
      const result = this.nextReplaceResult.value;
      this.nextReplaceResult = undefined;
      return result as ReplaceMemoryResultV1;
    }
    if (input.expectedVersion !== this.version) {
      return {
        outcome: 'conflict',
        version: this.version,
        sha256: sha256Text(this.memory),
        byteLength: Buffer.byteLength(this.memory),
      };
    }
    this.version += 1;
    this.memory = input.content;
    const result: ReplaceMemoryResultV1 = {
      outcome: 'committed',
      version: this.version,
      sha256: sha256Text(this.memory),
      byteLength: Buffer.byteLength(this.memory),
    };
    const after = this.afterNextReplace;
    this.afterNextReplace = undefined;
    after?.();
    return result;
  }

  async snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1> {
    assert.equal(actorId, this.actorId);
    const files = Object.fromEntries(FILES.map(path => {
      const content = path === 'MEMORY.md'
        ? this.memory
        : `${this.actorId}:${path}:v${this.version}`;
      return [path, {
        path,
        sha256: sha256Text(content),
        byteLength: Buffer.byteLength(content),
      }];
    })) as FileWorkspaceSnapshotV1['final']['files'];
    return {
      actorId,
      initial: { version: 0, files },
      final: { version: this.version, files },
    };
  }

  externalReplace(content: string): void {
    this.version += 1;
    this.memory = content;
  }

  private receipt(path: AgentWorkspaceFilePathV1, content: string): FileReadReceiptV1 {
    return {
      actorId: this.actorId,
      path,
      action: 'read',
      version: this.version,
      sha256: sha256Text(content),
      byteLength: Buffer.byteLength(content),
    };
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
