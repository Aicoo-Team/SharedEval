import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  sha256JsonV1,
  stableIdV1,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/json.js';
import {
  SHAREDOS_VERIFIED_REVISION_V1,
  SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
} from '../../src/execution/sharedos/v1/load-sharedos.js';
import type {
  SoToolResult,
  SoTurnDecision,
  SoTurnDriver,
  SoTurnInput,
} from '../../src/execution/sharedos/v1/contracts.js';
import type {
  FileProviderTelemetrySourceV1,
  FileProviderTelemetryV1,
} from '../../src/runner/v1/file-model-driver.js';
import { createSharedOsFileSessionV1 } from '../../src/runner/v1/sharedos-file-session.js';
import type {
  FileReadReceiptV1,
  FileWorkspacePortV1,
  FileWorkspaceSnapshotV1,
} from '../../src/runner/v1/file-workspace.js';
import { loadPactPairTasksV1 } from '../../src/suites/pact-pair/task-loader.js';
import { createPactPairWorkspaceV1 } from '../../src/suites/pact-pair/workspace.js';

const FILES = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const;
const NOW = '2026-08-26T12:00:00.000Z';

test('real SharedOS mediates both actors, files, task tools, and request/reply', async t => {
  const sharedOsDirectory = resolve(
    process.env.SHAREDEVAL_SHAREDOS_DIR
      ?? '/private/tmp/sharedos-message-foundation.NkahQk/repo',
  );
  if (!existsSync(join(sharedOsDirectory, 'packages', 'runtime', 'dist', 'index.js'))) {
    if (process.env.SHAREDEVAL_REQUIRE_SHAREDOS) {
      assert.fail(`required SharedOS build is unavailable at ${sharedOsDirectory}`);
    }
    t.skip(`SharedOS build is unavailable at ${sharedOsDirectory}`);
    return;
  }

  const previousDirectory = process.env.SHAREDEVAL_SHAREDOS_DIR;
  process.env.SHAREDEVAL_SHAREDOS_DIR = sharedOsDirectory;
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-sharedos-runtime-'));
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.SHAREDEVAL_SHAREDOS_DIR;
    else process.env.SHAREDEVAL_SHAREDOS_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  });

  const task = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
    ids: ['PAIR-Q1'],
  })[0];
  assert.ok(task);
  const requesterWorkspace = new MemoryFileWorkspace('requester', {
    'AGENT.md': 'requester agent',
    'HEARTBEAT.md': 'requester heartbeat',
    'POLICY.md': 'requester policy',
    'MEMORY.md': 'PAIR-Q1 [pending] — waiting\n',
  });
  const responderWorkspace = new MemoryFileWorkspace('responder', {
    'AGENT.md': 'responder agent',
    'HEARTBEAT.md': 'responder heartbeat',
    'POLICY.md': 'responder policy',
    'MEMORY.md': 'PAIR-Q1 [pending] — waiting\n',
  });
  const trace = new DriverTrace();
  const namespaceId = stableIdV1('namespace', ['namespace', 'run-1', 0]);
  const inputDigest = createHash('sha256').update('heartbeat input').digest('hex');
  const eventId = stableIdV1('heartbeat', [
    'heartbeat',
    namespaceId,
    1,
    inputDigest,
  ]);
  const traceId = stableIdV1('trace', ['trace', eventId]);

  const session = await createSharedOsFileSessionV1({
    runId: 'run-1',
    namespaceId,
    sessionIndex: 0,
    maxTicks: 1,
    maxToolCalls: 8,
    deadlineMs: 10_000,
    requester: { actorId: 'requester', workspace: requesterWorkspace },
    responder: { actorId: 'responder', workspace: responderWorkspace },
    tasks: [task],
    pactWorkspace: createPactPairWorkspaceV1(),
    storeRoot: join(root, 'store'),
    createDriver: input => {
      trace.createdRoles.push(input.role);
      return new ScriptedDriver(input.role, trace);
    },
  });

  await assert.rejects(
    () => session.runRequesterTurn({
      tick: 1,
      eventId: `${eventId}-forged`,
      traceId,
      inputDigest,
    }),
    /heartbeat identity/,
  );
  assert.deepEqual(trace.createdRoles, []);

  const result = await session.runRequesterTurn({
    tick: 1,
    eventId,
    traceId,
    inputDigest,
  });
  assert.equal(result.executionStatus, 'succeeded');
  assert.equal(result.executionId, stableIdV1('execution', [
    'requester-execution',
    eventId,
    'requester',
  ]));
  assert.deepEqual(result.decision, {
    type: 'completed',
    content: 'heartbeat complete',
    toolSteps: 7,
    contactCalls: 1,
  });
  assert.deepEqual(result.requesterReads.map(receipt => receipt.path), FILES);
  const requestMessageId = stableIdV1('message', [
    'message-request',
    namespaceId,
    traceId,
    trace.requestToolCallId,
    { kind: 'agent', agentId: 'responder' },
  ]);
  assert.deepEqual(result.contact, {
    taskId: 'PAIR-Q1',
    requestMessageId,
    replyMessageId: stableIdV1('message', ['message-reply', requestMessageId]),
    responderExecutionId: trace.responderExecutionId,
    status: 'completed',
    response: 'authorized response',
    responderReads: FILES.map(path => responderWorkspace.receipt(path)),
    providerUsage: telemetry('responder'),
  });
  assert.deepEqual(result.providerUsage, telemetry('requester'));
  assert.equal(result.provenance.namespaceId, namespaceId);
  const bindingAuthority = JSON.parse(await readFile(
    join(root, 'store', '.sharedeval-sharedos-session', 'binding.json'),
    'utf8',
  )) as { binding: { startedAt: string } };
  const grantAuthority = JSON.parse(await readFile(
    join(root, 'store', '.sharedeval-sharedos-session', 'grants.json'),
    'utf8',
  )) as { grantsDigest: string };
  assert.deepEqual(result.provenance, {
    runStartedAt: bindingAuthority.binding.startedAt,
    namespaceId,
    grantManifestDigest: grantAuthority.grantsDigest,
    sharedOsRevision: SHAREDOS_VERIFIED_REVISION_V1,
    sharedOsRuntimeDigest: SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
  });
  assert.deepEqual(session.provenance, result.provenance);
  assert.ok(Object.isFrozen(session.provenance));
  assert.ok(result.audit.lastSequence >= result.audit.firstSequence);
  assert.match(result.audit.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sourceEvidence.auditEvents.length > 0, true);
  assert.deepEqual(
    result.sourceEvidence.requesterFileOperations.map(receipt => receipt.action),
    ['read', 'read', 'read', 'read', 'replace'],
  );
  assert.deepEqual(
    result.sourceEvidence.responderFileOperations.map(receipt => receipt.action),
    ['read', 'read', 'read', 'read'],
  );
  const requesterReplace = result.sourceEvidence.requesterFileOperations.at(-1);
  assert.ok(requesterReplace?.action === 'replace');
  assert.equal(
    Buffer.from(requesterReplace.previousBytesBase64, 'base64').toString('utf8'),
    'PAIR-Q1 [pending] — waiting\n',
  );
  assert.equal(
    Buffer.from(requesterReplace.newBytesBase64, 'base64').toString('utf8'),
    'PAIR-Q1 [answered] — authorized response\n',
  );
  assert.deepEqual(
    result.sourceEvidence.acceptedMessages.map(message => ({
      id: message.id,
      sender: message.sender,
      receiver: message.receiver,
      replyTo: message.replyTo,
    })),
    [
      {
        id: requestMessageId,
        sender: { kind: 'agent', agentId: 'requester' },
        receiver: { kind: 'agent', agentId: 'responder' },
        replyTo: undefined,
      },
      {
        id: stableIdV1('message', ['message-reply', requestMessageId]),
        sender: { kind: 'agent', agentId: 'responder' },
        receiver: { kind: 'agent', agentId: 'requester' },
        replyTo: requestMessageId,
      },
    ],
  );
  assert.equal(
    result.sourceEvidence.auditEvents.length,
    result.audit.lastSequence - result.audit.firstSequence + 1,
  );
  assert.equal(
    sha256JsonV1(result.sourceEvidence.auditEvents as unknown as JsonValue),
    result.audit.sha256,
  );
  for (const receipt of [
    ...result.sourceEvidence.requesterFileOperations,
    ...result.sourceEvidence.responderFileOperations,
  ]) assert.equal(receipt.traceId, traceId);
  for (const message of result.sourceEvidence.acceptedMessages) {
    assert.equal(message.traceId, traceId);
  }
  for (const event of result.sourceEvidence.auditEvents) assert.equal(event.traceId, traceId);
  assert.ok(Object.isFrozen(result.sourceEvidence));
  assert.ok(Object.isFrozen(result.sourceEvidence.acceptedMessages[0]?.payload));
  assert.throws(() => {
    const payload = result.sourceEvidence?.acceptedMessages[0]?.payload;
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    payload['taskId'] = 'forged';
  }, TypeError);
  assert.deepEqual(trace.catalogs, {
    requester: ['files.read', 'files.replace', 'messages.request'],
    responder: ['files.read', 'files.replace', 'get_note', 'search_notes'],
  });
  assert.equal(trace.requesterCrossActorResult?.status, 'denied');
  assert.equal(trace.responderForgedMessageResult?.status, 'denied');
  assert.equal(trace.responderForgedMessageResult?.error?.code, 'tool_unavailable');
  assert.equal(responderWorkspace.readCalls, 4, 'cross-actor requester read did no host work');
  assert.equal((await requesterWorkspace.snapshot('requester')).final.version, 1);
  assert.match(requesterWorkspace.content('MEMORY.md'), /\[answered\]/);

  await assert.rejects(
    () => session.runRequesterTurn({ tick: 1, eventId, traceId, inputDigest }),
    /already executed/,
  );
  assert.deepEqual(trace.createdRoles, ['requester', 'responder']);

  await session.close();
  await session.close();
  await assert.rejects(
    () => session.runRequesterTurn({ tick: 1, eventId, traceId, inputDigest }),
    /closed/,
  );
});

test('an accepted request without a selected task fails the heartbeat closed', async t => {
  const fixture = await createSessionFixture(t, 'unbound-message', input => (
    new UnboundRequestDriver(input.role)
  ));

  await assert.rejects(
    () => fixture.session.runRequesterTurn(fixture.heartbeat),
    /bind one selected task/,
  );
  await fixture.session.close();
});

test('durable router corruption remains fatal across the SharedOS tool boundary', async t => {
  let fixtureRoot = '';
  const fixture = await createSessionFixture(t, 'router-corruption', input => (
    new UnboundRequestDriver(input.role, 'PAIR-Q1', async () => {
      const bindings = join(
        fixtureRoot,
        '.sharedeval-sharedos-session',
        'responder-bindings',
      );
      await mkdir(bindings, { recursive: true });
      await writeFile(join(bindings, `task-${'0'.repeat(64)}.json`), '{', 'utf8');
    })
  ));
  fixtureRoot = fixture.storeRoot;

  await assert.rejects(
    () => fixture.session.runRequesterTurn(fixture.heartbeat),
    /responder.*binding/i,
  );
});

test('a failed close never reopens the session to model work', async t => {
  let driverCreations = 0;
  const fixture = await createSessionFixture(t, 'failed-close', input => {
    driverCreations += 1;
    return new UnboundRequestDriver(input.role);
  });
  const auditDirectory = join(
    fixture.storeRoot,
    '.sharedeval-sharedos-session',
    'audit',
  );
  await mkdir(auditDirectory, { recursive: true });
  await writeFile(join(auditDirectory, 'record-000000000000.json'), '{', 'utf8');

  await assert.rejects(() => fixture.session.close(), /audit/i);
  await assert.rejects(
    () => fixture.session.runRequesterTurn(fixture.heartbeat),
    /closed/,
  );
  assert.equal(driverCreations, 0);
});

test('session reconstruction reuses byte-identical startedAt authority', async t => {
  let driverCreations = 0;
  const fixture = await createSessionFixture(t, 'restart-authority', input => {
    driverCreations += 1;
    return new UnboundRequestDriver(input.role);
  });
  const authorityDirectory = join(
    fixture.storeRoot,
    '.sharedeval-sharedos-session',
  );
  const bindingBefore = await readFile(join(authorityDirectory, 'binding.json'), 'utf8');
  const grantsBefore = await readFile(join(authorityDirectory, 'grants.json'), 'utf8');
  const firstProvenance = fixture.session.provenance;
  assert.equal(firstProvenance.namespaceId, fixture.options.namespaceId);

  const reconstructed = await createSharedOsFileSessionV1(fixture.options);

  assert.equal(await readFile(join(authorityDirectory, 'binding.json'), 'utf8'), bindingBefore);
  assert.equal(await readFile(join(authorityDirectory, 'grants.json'), 'utf8'), grantsBefore);
  assert.deepEqual(reconstructed.provenance, firstProvenance);
  assert.notEqual(reconstructed.provenance, firstProvenance);
  assert.equal(driverCreations, 0);
  await reconstructed.close();
  await fixture.session.close();
});

test('session reconstruction fails loud on malformed prior binding authority', async t => {
  let driverCreations = 0;
  const fixture = await createSessionFixture(t, 'restart-malformed', input => {
    driverCreations += 1;
    return new UnboundRequestDriver(input.role);
  });
  await writeFile(
    join(fixture.storeRoot, '.sharedeval-sharedos-session', 'binding.json'),
    '{',
    'utf8',
  );

  await assert.rejects(
    () => createSharedOsFileSessionV1(fixture.options),
    /binding.*malformed|malformed.*binding/i,
  );
  assert.equal(driverCreations, 0);
});

class DriverTrace {
  readonly catalogs: Partial<Record<'requester' | 'responder', string[]>> = {};
  readonly createdRoles: Array<'requester' | 'responder'> = [];
  requestToolCallId = '';
  responderExecutionId = '';
  requesterCrossActorResult?: SoToolResult;
  responderForgedMessageResult?: SoToolResult;
}

class ScriptedDriver implements SoTurnDriver, FileProviderTelemetrySourceV1 {
  constructor(
    private readonly role: 'requester' | 'responder',
    private readonly trace: DriverTrace,
  ) {}

  async open(request: Parameters<SoTurnDriver['open']>[0]) {
    this.trace.catalogs[this.role] = request.tools.map(tool => tool.name).sort();
    if (this.role === 'responder') {
      this.trace.responderExecutionId = request.executionId;
    }
    let step = 0;
    return {
      next: async (input: SoTurnInput): Promise<SoTurnDecision> => {
        const current = step;
        step += 1;
        return this.role === 'requester'
          ? this.requesterDecision(request, current, input)
          : this.responderDecision(request, current, input);
      },
    };
  }

  getFileProviderTelemetryV1(): FileProviderTelemetryV1 {
    return telemetry(this.role);
  }

  private requesterDecision(
    request: Parameters<SoTurnDriver['open']>[0],
    step: number,
    input: SoTurnInput,
  ): SoTurnDecision {
    if (step >= 1) assert.equal(input.type, 'tool_result');
    if (step < 4) return call(request, step, 'files.read', {
      path: [FILES[step]],
    });
    if (step === 4) return call(request, step, 'files.read', {
      path: ['responder', 'AGENT.md'],
    });
    if (step === 5) {
      assert.equal(input.type, 'tool_result');
      this.trace.requesterCrossActorResult = structuredClone(input.result);
      const decision = call(request, step, 'messages.request', {
        recipient: { kind: 'agent', agentId: 'responder' },
        payload: { taskId: 'PAIR-Q1', message: 'Please answer the selected task.' },
      });
      this.trace.requestToolCallId = decision.type === 'tool_call' ? decision.call.id : '';
      return decision;
    }
    if (step === 6) {
      assert.equal(input.type, 'tool_result');
      assert.equal(input.result.status, 'succeeded');
      const output = input.result.output as { status?: unknown };
      assert.equal(output.status, 'completed');
      return call(request, step, 'files.replace', {
        path: ['MEMORY.md'],
        content: 'PAIR-Q1 [answered] — authorized response\n',
        expectedVersion: '0',
      });
    }
    assert.equal(step, 7);
    assert.equal(input.type, 'tool_result');
    assert.equal(input.result.status, 'succeeded');
    return {
      type: 'complete',
      output: {
        type: 'completed',
        content: 'heartbeat complete',
        toolSteps: 7,
        contactCalls: 1,
      },
    };
  }

  private responderDecision(
    request: Parameters<SoTurnDriver['open']>[0],
    step: number,
    input: SoTurnInput,
  ): SoTurnDecision {
    if (step >= 1) assert.equal(input.type, 'tool_result');
    if (step < 4) return call(request, step, 'files.read', {
      path: [FILES[step]],
    });
    if (step === 4) return call(request, step, 'messages.request', {
      recipient: { kind: 'agent', agentId: 'requester' },
      payload: { taskId: 'PAIR-Q1', message: 'recursive request must be unavailable' },
    });
    if (step === 5) {
      assert.equal(input.type, 'tool_result');
      this.trace.responderForgedMessageResult = structuredClone(input.result);
      return call(request, step, 'search_notes', { query: 'Project Alpha' });
    }
    assert.equal(step, 6);
    assert.equal(input.type, 'tool_result');
    assert.equal(input.result.status, 'succeeded');
    return {
      type: 'complete',
      output: {
        type: 'completed',
        content: 'authorized response',
        toolSteps: 6,
        contactCalls: 0,
      },
    };
  }
}

class UnboundRequestDriver implements SoTurnDriver, FileProviderTelemetrySourceV1 {
  constructor(
    private readonly role: 'requester' | 'responder',
    private readonly taskId = 'PAIR-UNKNOWN',
    private readonly beforeRequest?: () => Promise<void>,
  ) {}

  async open(request: Parameters<SoTurnDriver['open']>[0]) {
    assert.equal(this.role, 'requester', 'an unbound request never starts a responder');
    let step = 0;
    return {
      next: async (input: SoTurnInput): Promise<SoTurnDecision> => {
        const current = step;
        step += 1;
        if (current >= 1) assert.equal(input.type, 'tool_result');
        if (current < 4) return call(request, current, 'files.read', {
          path: [FILES[current]],
        });
        if (current === 4) {
          await this.beforeRequest?.();
          return call(request, current, 'messages.request', {
            recipient: { kind: 'agent', agentId: 'responder' },
            payload: { taskId: this.taskId, message: 'Route this authorized request.' },
          });
        }
        assert.equal(input.type, 'tool_result');
        assert.equal(input.result.status, 'failed');
        return {
          type: 'complete',
          output: {
            type: 'completed',
            content: 'must not be accepted',
            toolSteps: 5,
            contactCalls: 1,
          },
        };
      },
    };
  }

  getFileProviderTelemetryV1(): FileProviderTelemetryV1 {
    return telemetry(this.role);
  }
}

function call(
  request: Parameters<SoTurnDriver['open']>[0],
  step: number,
  tool: string,
  arguments_: JsonObject,
): SoTurnDecision {
  return {
    type: 'tool_call',
    call: {
      id: stableIdV1('call', ['scripted-call', request.executionId, step, tool]),
      tool,
      arguments: arguments_,
      traceId: request.context.traceId,
      requestedAt: request.context.now,
    },
  };
}

function telemetry(role: 'requester' | 'responder'): FileProviderTelemetryV1 {
  return {
    requestedModel: `${role}-scripted`,
    resolvedModel: `${role}-scripted`,
    requests: [],
    totals: { requests: 0 },
  };
}

async function createSessionFixture(
  t: TestContext,
  name: string,
  createDriver: Parameters<typeof createSharedOsFileSessionV1>[0]['createDriver'],
) {
  const sharedOsDirectory = resolve(
    process.env.SHAREDEVAL_SHAREDOS_DIR
      ?? '/private/tmp/sharedos-message-foundation.NkahQk/repo',
  );
  assert.ok(
    existsSync(join(sharedOsDirectory, 'packages', 'runtime', 'dist', 'index.js')),
    'the pinned SharedOS build is required for runtime conformance',
  );
  const previousDirectory = process.env.SHAREDEVAL_SHAREDOS_DIR;
  process.env.SHAREDEVAL_SHAREDOS_DIR = sharedOsDirectory;
  const root = await mkdtemp(join(tmpdir(), `sharedeval-${name}-`));
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.SHAREDEVAL_SHAREDOS_DIR;
    else process.env.SHAREDEVAL_SHAREDOS_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  });
  const task = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R0',
    gradingMode: 'category',
    ids: ['PAIR-Q1'],
  })[0];
  assert.ok(task);
  const requesterWorkspace = new MemoryFileWorkspace('requester', {
    'AGENT.md': 'requester agent',
    'HEARTBEAT.md': 'requester heartbeat',
    'POLICY.md': 'requester policy',
    'MEMORY.md': 'PAIR-Q1 [pending] — waiting\n',
  });
  const responderWorkspace = new MemoryFileWorkspace('responder', {
    'AGENT.md': 'responder agent',
    'HEARTBEAT.md': 'responder heartbeat',
    'POLICY.md': 'responder policy',
    'MEMORY.md': 'PAIR-Q1 [pending] — waiting\n',
  });
  const runId = `run-${name}`;
  const namespaceId = stableIdV1('namespace', ['namespace', runId, 0]);
  const inputDigest = createHash('sha256').update(`${name} heartbeat`).digest('hex');
  const eventId = stableIdV1('heartbeat', [
    'heartbeat',
    namespaceId,
    1,
    inputDigest,
  ]);
  const traceId = stableIdV1('trace', ['trace', eventId]);
  const storeRoot = join(root, 'store');
  const options = {
    runId,
    namespaceId,
    sessionIndex: 0,
    maxTicks: 1,
    maxToolCalls: 8,
    deadlineMs: 10_000,
    requester: { actorId: 'requester', workspace: requesterWorkspace },
    responder: { actorId: 'responder', workspace: responderWorkspace },
    tasks: [task],
    pactWorkspace: createPactPairWorkspaceV1(),
    storeRoot,
    createDriver,
  } satisfies Parameters<typeof createSharedOsFileSessionV1>[0];
  const session = await createSharedOsFileSessionV1(options);
  return {
    session,
    options,
    storeRoot,
    heartbeat: { tick: 1, eventId, traceId, inputDigest },
  };
}

class MemoryFileWorkspace implements FileWorkspacePortV1 {
  private version = 0;
  private readonly files: Record<(typeof FILES)[number], string>;
  readCalls = 0;

  constructor(
    private readonly actorId: string,
    files: Record<(typeof FILES)[number], string>,
  ) {
    this.files = structuredClone(files);
  }

  async read(input: Parameters<FileWorkspacePortV1['read']>[0]) {
    assert.equal(input.actorId, this.actorId);
    input.signal?.throwIfAborted();
    this.readCalls += 1;
    return {
      content: this.files[input.path],
      receipt: this.receipt(input.path),
    };
  }

  async replaceMemory(input: Parameters<FileWorkspacePortV1['replaceMemory']>[0]) {
    assert.equal(input.actorId, this.actorId);
    input.signal?.throwIfAborted();
    if (input.expectedVersion !== this.version) {
      return {
        outcome: 'conflict' as const,
        version: this.version,
        sha256: sha256(this.files['MEMORY.md']),
        byteLength: Buffer.byteLength(this.files['MEMORY.md']),
      };
    }
    this.version += 1;
    this.files['MEMORY.md'] = input.content;
    return {
      outcome: 'committed' as const,
      version: this.version,
      sha256: sha256(input.content),
      byteLength: Buffer.byteLength(input.content),
    };
  }

  async snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1> {
    assert.equal(actorId, this.actorId);
    const files = Object.fromEntries(FILES.map(path => [path, {
      path,
      sha256: sha256(this.files[path]),
      byteLength: Buffer.byteLength(this.files[path]),
    }])) as FileWorkspaceSnapshotV1['initial']['files'];
    return {
      actorId,
      initial: { version: 0, files: structuredClone(files) },
      final: { version: this.version, files },
    };
  }

  receipt(path: (typeof FILES)[number]): FileReadReceiptV1 {
    return {
      actorId: this.actorId,
      path,
      action: 'read',
      version: this.version,
      sha256: sha256(this.files[path]),
      byteLength: Buffer.byteLength(this.files[path]),
    };
  }

  content(path: (typeof FILES)[number]): string {
    return this.files[path];
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
