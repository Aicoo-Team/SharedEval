import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

type WorkspaceModule = typeof import('../../src/runner/v1/file-workspace.js');

function loadSubject(): Promise<WorkspaceModule> {
  return import('../../src/runner/v1/file-workspace.js');
}

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex');
}

function template(memory = 'task-1 [pending] — not started\n') {
  const files = {
    agent: ['AGENT.md', 'agent identity\n', 'read_only'],
    heartbeat: ['HEARTBEAT.md', 'heartbeat instructions\n', 'read_only'],
    policy: ['POLICY.md', 'policy constraints\n', 'read_only'],
    memory: ['MEMORY.md', memory, 'read_write'],
  } as const;
  return {
    apiVersion: 'sharedeval/agent-workspace/v1' as const,
    kind: 'AgentWorkspaceTemplate' as const,
    files: Object.fromEntries(Object.entries(files).map(([slot, [path, content, access]]) => [
      slot,
      { path, content, access, sha256: sha256(content) },
    ])),
  } as never;
}

async function materialize(
  rootDir: string,
  runId = 'run-1',
  actorId = 'actor-1',
  faultInjection?: unknown,
) {
  const { materializeFileWorkspaceV1 } = await loadSubject();
  return materializeFileWorkspaceV1({
    rootDir,
    runId,
    actorId,
    template: template(),
    selectedTaskIds: ['task-1'],
    faultInjection: faultInjection as never,
  });
}

test('materializes four exact files, exposes logical receipts only, and makes MEMORY the sole write operation', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir);
    const agent = await workspace.read({ actorId: 'actor-1', path: 'AGENT.md' });
    const memory = await workspace.read({ actorId: 'actor-1', path: 'MEMORY.md' });
    assert.equal(agent.content, 'agent identity\n');
    assert.deepEqual(agent.receipt, {
      actorId: 'actor-1', path: 'AGENT.md', action: 'read', version: 0,
      sha256: sha256('agent identity\n'), byteLength: 15,
    });
    assert.equal(memory.receipt.version, 0);
    assert.ok(!JSON.stringify(agent.receipt).includes(rootDir));

    await assert.rejects(
      () => workspace.read({ actorId: 'actor-1', path: '../AGENT.md' as never }),
      /path|workspace file/i,
    );
    await assert.rejects(
      () => workspace.read({ actorId: '../actor-1', path: 'MEMORY.md' }),
      /actor/i,
    );

    const committed = await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0,
      content: 'task-1 [answered] — done\n',
    });
    assert.deepEqual(committed, {
      outcome: 'committed', version: 1,
      sha256: sha256('task-1 [answered] — done\n'), byteLength: 27,
    });
    assert.equal((await workspace.read({ actorId: 'actor-1', path: 'AGENT.md' })).content, 'agent identity\n');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects invalid full MEMORY replacements before publishing any bytes or version', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir);
    const before = await workspace.snapshot('actor-1');
    await assert.rejects(
      () => workspace.replaceMemory({
        actorId: 'actor-1', expectedVersion: 0,
        content: 'task-2 [answered] — wrong selected task\n',
      }),
      /selected|task|MEMORY/i,
    );
    assert.deepEqual(await workspace.snapshot('actor-1'), before);
    assert.equal((await workspace.read({ actorId: 'actor-1', path: 'MEMORY.md' })).content, 'task-1 [pending] — not started\n');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('returns a stale CAS conflict without changing the durable bytes or version', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir);
    const first = await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — first writer\n',
    });
    assert.equal(first.outcome, 'committed');
    const beforeConflict = await workspace.snapshot('actor-1');
    const stale = await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — stale writer\n',
    });
    assert.deepEqual(stale, {
      outcome: 'conflict', version: 1,
      sha256: sha256('task-1 [answered] — first writer\n'), byteLength: 35,
    });
    assert.deepEqual(await workspace.snapshot('actor-1'), beforeConflict);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('does not delete a prefix-colliding actor stage while another actor materializes', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspacesDir = join(rootDir, 'runs', 'run-prefix', 'workspaces');
    await mkdir(workspacesDir, { recursive: true });
    // This is a real in-progress stage owned by actor `a-b`.  A recovery for
    // actor `a` must never infer ownership from a shared string prefix.
    const otherActorStage = join(workspacesDir, '.staging-a-b-live');
    await mkdir(otherActorStage);
    await writeFile(join(otherActorStage, 'sentinel'), 'actor a-b still writing\n');
    await writeFile(join(workspacesDir, '.lock-a'), JSON.stringify({
      ownerId: '00000000-0000-4000-8000-000000000001', pid: 999_999_999, leaseExpiresAt: 0,
    }));

    await materialize(rootDir, 'run-prefix', 'a');
    assert.equal(await readFile(join(otherActorStage, 'sentinel'), 'utf8'), 'actor a-b still writing\n');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('uses append-only CAS instead of stealing a delayed legacy lock initializer', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir, 'run-1', 'actor-1', {
      lockAcquireTimeoutMs: 20,
    });
    const actorDir = join(rootDir, 'runs', 'run-1', 'workspaces', 'actor-1');
    const legacyLock = join(actorDir, '.memory.lock');
    await writeFile(legacyLock, '');
    const replacement = workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — marker wins\n',
    });
    // Simulate the old O_EXCL creator resuming after a competing writer has
    // observed its empty canonical file.  This must not become authority.
    await new Promise(resolve => setTimeout(resolve, 5));
    const delayedOwner = {
      ownerId: '00000000-0000-4000-8000-000000000002', pid: process.pid, leaseExpiresAt: Date.now() + 60_000,
    };
    await writeFile(legacyLock, JSON.stringify(delayedOwner));
    const result = await replacement;
    assert.equal(result.outcome, 'committed');
    assert.deepEqual(JSON.parse(await readFile(legacyLock, 'utf8')), delayedOwner);
    assert.deepEqual(
      (await readdir(actorDir)).filter(name => name.includes('.stale-') || name.includes('.initializing-')),
      [],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('three concurrent stale writers elect one append-only commit without recovery-file leaks', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir, 'run-1', 'actor-1', {
      lockAcquireTimeoutMs: 20,
    });
    const actorDir = join(rootDir, 'runs', 'run-1', 'workspaces', 'actor-1');
    await writeFile(join(actorDir, '.memory.lock'), '');
    const results = await Promise.all([
      workspace.replaceMemory({ actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — left\n' }),
      workspace.replaceMemory({ actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — middle\n' }),
      workspace.replaceMemory({ actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — right\n' }),
    ]);
    assert.equal(results.filter(result => result.outcome === 'committed').length, 1);
    assert.equal(results.filter(result => result.outcome === 'conflict').length, 2);
    assert.equal((await workspace.snapshot('actor-1')).final.version, 1);
    assert.deepEqual(
      (await readdir(actorDir)).filter(name => name.includes('.stale-') || name.includes('.initializing-')),
      [],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('does not write a release marker or report an ambiguous result after a post-publication cleanup close fault', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir, 'run-1', 'actor-1', {
      failMemoryPostPublishCleanup: true,
    });
    const actorDir = join(rootDir, 'runs', 'run-1', 'workspaces', 'actor-1');
    const result = await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — cleanup result\n',
    });
    assert.deepEqual(result, {
      outcome: 'committed', version: 1,
      sha256: sha256('task-1 [answered] — cleanup result\n'), byteLength: 37,
      durability: 'published_unsynced',
    });
    await assert.rejects(() => access(join(actorDir, '.memory.lock')));
    const marker = JSON.parse(await readFile(join(actorDir, 'commits', 'commit-1.json'), 'utf8'));
    assert.equal(marker.version, 1);
    assert.match(marker.directory, /^version-[a-f0-9-]{36}$/);
    assert.deepEqual(marker.files['MEMORY.md'], {
      path: 'MEMORY.md',
      sha256: sha256('task-1 [answered] — cleanup result\n'),
      byteLength: 37,
    });
    assert.equal(
      await readFile(join(actorDir, 'versions', marker.directory, 'MEMORY.md'), 'utf8'),
      'task-1 [answered] — cleanup result\n',
    );
    assert.deepEqual(
      (await readdir(actorDir)).filter(name => name.startsWith('.commit-pointer-')),
      [],
    );
    const { openFileWorkspaceV1 } = await loadSubject();
    const reopened = await openFileWorkspaceV1({
      rootDir, runId: 'run-1', actorId: 'actor-1', selectedTaskIds: ['task-1'],
    });
    assert.equal((await reopened.replaceMemory({
      actorId: 'actor-1', expectedVersion: 1, content: 'task-1 [answered] — reopened\n',
    })).outcome, 'committed');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('does not let a live reused-PID legacy lock prevent a durable CAS', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir, 'run-1', 'actor-1', {
      lockAcquireTimeoutMs: 20,
    });
    const actorDir = join(rootDir, 'runs', 'run-1', 'workspaces', 'actor-1');
    const lockPath = join(actorDir, '.memory.lock');
    await writeFile(lockPath, JSON.stringify({
      ownerId: '00000000-0000-4000-8000-000000000003', pid: process.pid, leaseExpiresAt: 0,
    }));
    assert.equal((await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — no pid lock\n',
    })).outcome, 'committed');
    assert.equal((await workspace.snapshot('actor-1')).final.version, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('returns a published workspace after an initial post-rename sync failure', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir, 'run-1', 'actor-1', {
      failInitialPostPublishSync: true,
    });
    assert.equal(workspace.publication.durability, 'published_unsynced');
    assert.equal((await workspace.read({ actorId: 'actor-1', path: 'MEMORY.md' })).receipt.version, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('returns the committed MEMORY version after a post-rename pointer sync failure', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir, 'run-1', 'actor-1', {
      failMemoryPostPublishSync: true,
    });
    const result = await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — published\n',
    });
    assert.deepEqual(result, {
      outcome: 'committed', version: 1,
      sha256: sha256('task-1 [answered] — published\n'), byteLength: 32,
      durability: 'published_unsynced',
    });
    const { openFileWorkspaceV1 } = await loadSubject();
    const reopened = await openFileWorkspaceV1({
      rootDir, runId: 'run-1', actorId: 'actor-1', selectedTaskIds: ['task-1'],
    });
    assert.equal((await reopened.read({ actorId: 'actor-1', path: 'MEMORY.md' })).content, 'task-1 [answered] — published\n');
    assert.equal((await reopened.snapshot('actor-1')).final.version, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('recovers the MEMORY version and digest from disk in a newly opened port', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir);
    await workspace.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — persisted\n',
    });
    const { openFileWorkspaceV1 } = await loadSubject();
    const recovered = await openFileWorkspaceV1({
      rootDir,
      runId: 'run-1',
      actorId: 'actor-1',
      selectedTaskIds: ['task-1'],
    });
    assert.equal((await recovered.snapshot('actor-1')).final.version, 1);
    assert.deepEqual(await recovered.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — stale\n',
    }), {
      outcome: 'conflict', version: 1,
      sha256: sha256('task-1 [answered] — persisted\n'), byteLength: 32,
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('serializes two concurrent stale writers through the durable CAS state', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const workspace = await materialize(rootDir);
    const [left, right] = await Promise.all([
      workspace.replaceMemory({ actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — left\n' }),
      workspace.replaceMemory({ actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — right\n' }),
    ]);
    const results = [left, right];
    assert.equal(results.filter(result => result.outcome === 'committed').length, 1);
    assert.equal(results.filter(result => result.outcome === 'conflict').length, 1);
    const finalMemory = await workspace.read({ actorId: 'actor-1', path: 'MEMORY.md' });
    assert.ok(['task-1 [answered] — left\n', 'task-1 [answered] — right\n'].includes(finalMemory.content));
    assert.equal(finalMemory.receipt.version, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('leaves no published workspace when staging fails before atomic publication', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const { materializeFileWorkspaceV1 } = await loadSubject();
    await assert.rejects(() => materializeFileWorkspaceV1({
      rootDir,
      runId: 'run-failure',
      actorId: 'actor-1',
      template: template(),
      selectedTaskIds: ['task-1'],
      faultInjection: { failAfterStagingFile: 'POLICY.md' },
    }), /injected|stage|materializ/i);
    const workspaceRoot = join(rootDir, 'runs', 'run-failure', 'workspaces');
    await assert.rejects(() => access(join(workspaceRoot, 'actor-1')));
    assert.deepEqual(await readdir(workspaceRoot), []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('keeps run and actor workspaces isolated in bytes and durable versions', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-file-workspace-'));
  try {
    const runOneActorOne = await materialize(rootDir, 'run-1', 'actor-1');
    const runOneActorTwo = await materialize(rootDir, 'run-1', 'actor-2');
    const runTwoActorOne = await materialize(rootDir, 'run-2', 'actor-1');
    await runOneActorOne.replaceMemory({
      actorId: 'actor-1', expectedVersion: 0, content: 'task-1 [answered] — run one actor one\n',
    });
    assert.equal((await runOneActorTwo.read({ actorId: 'actor-2', path: 'MEMORY.md' })).content, 'task-1 [pending] — not started\n');
    assert.equal((await runTwoActorOne.read({ actorId: 'actor-1', path: 'MEMORY.md' })).content, 'task-1 [pending] — not started\n');
    assert.equal((await runOneActorTwo.snapshot('actor-2')).final.version, 0);
    assert.equal((await runTwoActorOne.snapshot('actor-1')).final.version, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
