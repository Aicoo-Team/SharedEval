import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  loadAgentWorkspaceRawFileV1,
  type AgentWorkspaceFilePathV1,
  type AgentWorkspaceTemplateV1,
} from './agent-workspace.js';
import { assertFileMemoryV1 } from './file-memory.js';

const logicalFiles = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];
const logicalFileSet = new Set<string>(logicalFiles);
const safeRunOrActorId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionDirectory = /^version-[a-f0-9-]{36}$/;
const DEFAULT_LOCK_LEASE_MS_V1 = 30_000;
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS_V1 = 5_000;
const LOCK_RETRY_DELAY_MS_V1 = 5;
const LOCK_INITIALIZATION_GRACE_MS_V1 = 1_000;

export type FileWorkspaceFileMetadataV1 = {
  path: AgentWorkspaceFilePathV1;
  sha256: string;
  byteLength: number;
};

export type FileWorkspaceFileSetV1 = Record<AgentWorkspaceFilePathV1, FileWorkspaceFileMetadataV1>;

export type FileReadReceiptV1 = {
  actorId: string;
  path: AgentWorkspaceFilePathV1;
  action: 'read';
  version: number;
  sha256: string;
  byteLength: number;
};

export type ReplaceMemoryResultV1 =
  | {
    outcome: 'committed';
    version: number;
    sha256: string;
    byteLength: number;
    /** The pointer was atomically published, but its parent fsync failed. */
    durability?: 'published_unsynced';
  }
  | {
    outcome: 'conflict';
    version: number;
    sha256: string;
    byteLength: number;
  };

export type FileWorkspaceSnapshotV1 = {
  actorId: string;
  initial: {
    version: number;
    files: FileWorkspaceFileSetV1;
  };
  final: {
    version: number;
    files: FileWorkspaceFileSetV1;
  };
};

export interface FileWorkspacePortV1 {
  read(input: { actorId: string; path: AgentWorkspaceFilePathV1 }): Promise<{
    content: string;
    receipt: FileReadReceiptV1;
  }>;
  replaceMemory(input: {
    actorId: string;
    expectedVersion: number;
    content: string;
  }): Promise<ReplaceMemoryResultV1>;
  snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1>;
}

export type MaterializedFileWorkspaceV1 = FileWorkspacePortV1 & {
  publication: {
    /** A published workspace remains readable/reopenable after an fsync fault. */
    durability: 'synced' | 'published_unsynced';
  };
};

/** Test-only fault point that still writes the real staged filesystem. */
export type FileWorkspaceFaultInjectionV1 = {
  failAfterStagingFile?: AgentWorkspaceFilePathV1;
  failLockAcquisition?: boolean;
  lockAcquireTimeoutMs?: number;
  failInitialPostPublishSync?: boolean;
  failMemoryPostPublishSync?: boolean;
  failInitialLockRelease?: boolean;
  failMemoryLockRelease?: boolean;
};

type FileWorkspaceFaultStateV1 = {
  failLockAcquisition: boolean;
  lockAcquireTimeoutMs: number | undefined;
  failInitialPostPublishSync: boolean;
  failMemoryPostPublishSync: boolean;
  failInitialLockRelease: boolean;
  failMemoryLockRelease: boolean;
};

type DurablePointer = {
  version: number;
  directory: string;
  files: FileWorkspaceFileSetV1;
};

type StoredInitialSnapshot = {
  version: 0;
  files: FileWorkspaceFileSetV1;
};

type FileWorkspaceLockOwnerV1 = {
  ownerId: string;
  pid: number;
  leaseExpiresAt: number;
  released?: boolean;
};

type FileWorkspaceLockV1 = {
  path: string;
  owner: FileWorkspaceLockOwnerV1;
  recovered: boolean;
  release(): Promise<{ cleaned: boolean }>;
};

type FileWorkspaceLockInspectionV1 =
  | { kind: 'missing' }
  | { kind: 'owner'; owner: FileWorkspaceLockOwnerV1 }
  | { kind: 'initializing'; mtimeMs: number };

/**
 * Creates one private workspace for one actor.  The published actor directory
 * is an atomic rename of a fully re-read staging tree; logical callers never
 * receive the host paths used to store it.
 */
export async function materializeFileWorkspaceV1(input: {
  rootDir: string;
  runId: string;
  actorId: string;
  template: AgentWorkspaceTemplateV1;
  selectedTaskIds: readonly string[];
  faultInjection?: FileWorkspaceFaultInjectionV1;
}): Promise<MaterializedFileWorkspaceV1> {
  assertSafeId(input.runId, 'run');
  assertSafeId(input.actorId, 'actor');
  assertFileMemoryV1({
    content: input.template.files.memory.content,
    selectedTaskIds: input.selectedTaskIds,
  });

  await assertRealDirectory(input.rootDir, 'workspace root');
  const runsDir = await ensureChildDirectory(input.rootDir, 'runs');
  const runDir = await ensureChildDirectory(runsDir, input.runId);
  const workspacesDir = await ensureChildDirectory(runDir, 'workspaces');
  const actorDir = join(workspacesDir, input.actorId);
  await assertDoesNotExist(actorDir, 'actor workspace');

  const faults = createFaultState(input.faultInjection);
  const lock = await acquireLock({
    path: join(workspacesDir, `.lock-${input.actorId}`),
    timeoutMs: faults.lockAcquireTimeoutMs,
    failRelease: consumeFault(faults, 'failInitialLockRelease'),
  });
  const stagingDir = join(workspacesDir, `.staging-${input.actorId}-${randomUUID()}`);
  let published = false;
  let publicationDurability: 'synced' | 'published_unsynced' = 'synced';
  try {
    if (lock.recovered) {
      await cleanupOrphanStages(workspacesDir, `.staging-${input.actorId}-`);
    }
    await assertDoesNotExist(actorDir, 'actor workspace');
    await mkdir(stagingDir, { mode: 0o700 });
    const version = `version-${randomUUID()}`;
    const stagedVersionDir = await ensureChildDirectory(
      await ensureChildDirectory(stagingDir, 'versions'),
      version,
    );
    const files = await writeTemplateVersion({
      directory: stagedVersionDir,
      template: input.template,
      faultInjection: input.faultInjection,
    });
    await writeJsonDurable(join(stagingDir, 'initial.json'), { version: 0, files });
    await writeJsonDurable(join(stagingDir, 'current.json'), {
      version: 0,
      directory: version,
      files,
    } satisfies DurablePointer);
    await syncDirectory(stagedVersionDir);
    await syncDirectory(join(stagingDir, 'versions'));
    await syncDirectory(stagingDir);
    await rename(stagingDir, actorDir);
    published = true;
    try {
      await syncDirectory(workspacesDir, consumeFault(faults, 'failInitialPostPublishSync'));
    } catch {
      publicationDurability = 'published_unsynced';
    }
  } catch (error) {
    if (!published) await rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    const release = await lock.release();
    if (published && !release.cleaned) {
      publicationDurability = 'published_unsynced';
    }
  }
  return new FileWorkspaceV1({
    actorDir,
    actorId: input.actorId,
    selectedTaskIds: [...input.selectedTaskIds],
    faults,
    publication: { durability: publicationDurability },
  });
}

/** Reopens a materialized workspace after a process restart from its durable pointer. */
export async function openFileWorkspaceV1(input: {
  rootDir: string;
  runId: string;
  actorId: string;
  selectedTaskIds: readonly string[];
}): Promise<FileWorkspacePortV1> {
  assertSafeId(input.runId, 'run');
  assertSafeId(input.actorId, 'actor');
  await assertRealDirectory(input.rootDir, 'workspace root');
  const actorDir = join(input.rootDir, 'runs', input.runId, 'workspaces', input.actorId);
  await assertRealDirectory(actorDir, 'actor workspace');
  const workspace = new FileWorkspaceV1({
    actorDir,
    actorId: input.actorId,
    selectedTaskIds: [...input.selectedTaskIds],
    faults: createFaultState(),
    publication: { durability: 'synced' },
  });
  // Verify both version state and canonical selection before the port is handed
  // to a new process; no in-memory counter participates in recovery.
  const memory = await workspace.read({ actorId: input.actorId, path: 'MEMORY.md' });
  assertFileMemoryV1({ content: memory.content, selectedTaskIds: input.selectedTaskIds });
  return workspace;
}

class FileWorkspaceV1 implements MaterializedFileWorkspaceV1 {
  readonly publication: { durability: 'synced' | 'published_unsynced' };

  constructor(private readonly options: {
    actorDir: string;
    actorId: string;
    selectedTaskIds: string[];
    faults: FileWorkspaceFaultStateV1;
    publication: { durability: 'synced' | 'published_unsynced' };
  }) {
    this.publication = options.publication;
  }

  async read(input: { actorId: string; path: AgentWorkspaceFilePathV1 }): Promise<{
    content: string;
    receipt: FileReadReceiptV1;
  }> {
    this.assertActor(input.actorId);
    assertLogicalPath(input.path);
    const pointer = await readPointer(this.options.actorDir);
    const file = await loadVersionFile(this.options.actorDir, pointer, input.path);
    return {
      content: file.content,
      receipt: {
        actorId: input.actorId,
        path: input.path,
        action: 'read',
        version: pointer.version,
        sha256: file.sha256,
        byteLength: file.byteLength,
      },
    };
  }

  async replaceMemory(input: {
    actorId: string;
    expectedVersion: number;
    content: string;
  }): Promise<ReplaceMemoryResultV1> {
    this.assertActor(input.actorId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error('expected MEMORY version must be a non-negative safe integer');
    }
    assertFileMemoryV1({
      content: input.content,
      selectedTaskIds: this.options.selectedTaskIds,
    });
    const memoryBytes = strictUtf8Bytes(input.content, 'MEMORY content');

    const lock = await acquireLock({
      path: join(this.options.actorDir, '.memory.lock'),
      timeoutMs: this.options.faults.lockAcquireTimeoutMs,
      failAcquisition: consumeFault(this.options.faults, 'failLockAcquisition'),
      failRelease: consumeFault(this.options.faults, 'failMemoryLockRelease'),
    });
    let staged: Awaited<ReturnType<typeof stageReplacement>> | undefined;
    let result: ReplaceMemoryResultV1 | undefined;
    try {
      if (lock.recovered) {
        await cleanupOrphanStages(this.options.actorDir, '.staging-version-');
      }
      // Stage only while holding this actor's lock.  The durable pointer is
      // deliberately re-read after staging for the CAS comparison.
      staged = await stageReplacement(this.options.actorDir, memoryBytes);
      const current = await readPointer(this.options.actorDir);
      const currentMemory = current.files['MEMORY.md'];
      if (current.version !== input.expectedVersion) {
        await rm(staged.directory, { recursive: true, force: true });
        staged = undefined;
        result = {
          outcome: 'conflict',
          version: current.version,
          sha256: currentMemory.sha256,
          byteLength: currentMemory.byteLength,
        };
      } else {
        const stagedVersion = staged;
        await verifyVersionDirectory(stagedVersion.directory, stagedVersion.files);
        const nextDirectory = join(this.options.actorDir, 'versions', stagedVersion.name);
        await rename(stagedVersion.directory, nextDirectory);
        staged = undefined;
        await verifyVersionDirectory(nextDirectory, stagedVersion.files);
        await syncDirectory(join(this.options.actorDir, 'versions'));
        const next: DurablePointer = {
          version: current.version + 1,
          directory: stagedVersion.name,
          files: stagedVersion.files,
        };
        await atomicJsonReplace(join(this.options.actorDir, 'current.json'), next);
        let durability: 'published_unsynced' | undefined;
        try {
          await syncDirectory(
            this.options.actorDir,
            consumeFault(this.options.faults, 'failMemoryPostPublishSync'),
          );
        } catch {
          durability = 'published_unsynced';
        }
        const committedMemory = next.files['MEMORY.md'];
        result = {
          outcome: 'committed',
          version: next.version,
          sha256: committedMemory.sha256,
          byteLength: committedMemory.byteLength,
          ...(durability ? { durability } : {}),
        };
      }
    } catch (error) {
      if (staged) await rm(staged.directory, { recursive: true, force: true });
      throw error;
    } finally {
      const release = await lock.release();
      if (!release.cleaned && result?.outcome === 'committed') {
        result = { ...result, durability: 'published_unsynced' };
      }
    }
    if (!result) throw new Error('MEMORY replacement did not produce a result');
    return result;
  }

  async snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1> {
    this.assertActor(actorId);
    const [initial, current] = await Promise.all([
      readInitialSnapshot(this.options.actorDir),
      readPointer(this.options.actorDir),
    ]);
    await verifyVersionDirectory(
      join(this.options.actorDir, 'versions', current.directory),
      current.files,
    );
    return {
      actorId,
      initial,
      final: { version: current.version, files: current.files },
    };
  }

  private assertActor(actorId: string): void {
    assertSafeId(actorId, 'actor');
    if (actorId !== this.options.actorId) {
      throw new Error('actor is not authorized for this file workspace');
    }
  }
}

async function writeTemplateVersion(input: {
  directory: string;
  template: AgentWorkspaceTemplateV1;
  faultInjection?: FileWorkspaceFaultInjectionV1;
}): Promise<FileWorkspaceFileSetV1> {
  const sourceByPath: Record<AgentWorkspaceFilePathV1, { content: string; sha256: string }> = {
    'AGENT.md': input.template.files.agent,
    'HEARTBEAT.md': input.template.files.heartbeat,
    'POLICY.md': input.template.files.policy,
    'MEMORY.md': input.template.files.memory,
  };
  for (const path of logicalFiles) {
    const source = sourceByPath[path];
    const bytes = strictUtf8Bytes(source.content, path);
    if (digest(bytes) !== source.sha256) {
      throw new Error(`${path} source SHA-256 does not match its resolved exact bytes`);
    }
    await writeBytesDurable(join(input.directory, path), bytes);
    if (input.faultInjection?.failAfterStagingFile === path) {
      throw new Error(`injected staging failure after ${path}`);
    }
  }
  return readVersionFiles(input.directory);
}

async function stageReplacement(actorDir: string, memoryBytes: Buffer): Promise<{
  directory: string;
  name: string;
  files: FileWorkspaceFileSetV1;
}> {
  const current = await readPointer(actorDir);
  const name = `version-${randomUUID()}`;
  const directory = join(actorDir, `.staging-${name}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const path of logicalFiles) {
      const currentFile = await loadVersionFile(actorDir, current, path);
      const bytes = path === 'MEMORY.md'
        ? memoryBytes
        : Buffer.from(currentFile.bytesBase64, 'base64');
      await writeBytesDurable(join(directory, path), bytes);
    }
    const files = await readVersionFiles(directory);
    await verifyVersionDirectory(directory, files);
    await syncDirectory(directory);
    return { directory, name, files };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readVersionFiles(directory: string): Promise<FileWorkspaceFileSetV1> {
  const entries = await Promise.all(logicalFiles.map(async path => {
    const raw = await loadAgentWorkspaceRawFileV1({ rootDir: directory, path });
    return [path, {
      path,
      sha256: raw.sha256,
      byteLength: raw.byteLength,
    }] as const;
  }));
  return Object.fromEntries(entries) as FileWorkspaceFileSetV1;
}

async function loadVersionFile(
  actorDir: string,
  pointer: DurablePointer,
  path: AgentWorkspaceFilePathV1,
) {
  const directory = join(actorDir, 'versions', pointer.directory);
  const raw = await loadAgentWorkspaceRawFileV1({ rootDir: directory, path });
  const expected = pointer.files[path];
  if (raw.sha256 !== expected.sha256 || raw.byteLength !== expected.byteLength) {
    throw new Error(`durable workspace ${path} does not match its published hash`);
  }
  return raw;
}

async function verifyVersionDirectory(
  directory: string,
  expected: FileWorkspaceFileSetV1,
): Promise<void> {
  const actual = await readVersionFiles(directory);
  for (const path of logicalFiles) {
    if (
      actual[path].sha256 !== expected[path].sha256
      || actual[path].byteLength !== expected[path].byteLength
    ) {
      throw new Error(`staged ${path} changed before publication`);
    }
  }
}

async function readPointer(actorDir: string): Promise<DurablePointer> {
  const value = await readJsonRegularFile(join(actorDir, 'current.json'), 'workspace pointer');
  if (!isDurablePointer(value)) throw new Error('workspace pointer is invalid');
  await assertRealDirectory(join(actorDir, 'versions'), 'workspace versions');
  await assertRealDirectory(join(actorDir, 'versions', value.directory), 'workspace version');
  return value;
}

async function readInitialSnapshot(actorDir: string): Promise<StoredInitialSnapshot> {
  const value = await readJsonRegularFile(join(actorDir, 'initial.json'), 'initial workspace snapshot');
  if (!isInitialSnapshot(value)) throw new Error('initial workspace snapshot is invalid');
  return value;
}

function isDurablePointer(value: unknown): value is DurablePointer {
  if (
    !isObject(value)
    || typeof value.version !== 'number'
    || !Number.isSafeInteger(value.version)
    || value.version < 0
  ) return false;
  return typeof value.directory === 'string'
    && versionDirectory.test(value.directory)
    && isFileSet(value.files);
}

function isInitialSnapshot(value: unknown): value is StoredInitialSnapshot {
  return isObject(value) && value.version === 0 && isFileSet(value.files);
}

function isFileSet(value: unknown): value is FileWorkspaceFileSetV1 {
  if (!isObject(value)) return false;
  return logicalFiles.every(path => {
    const file = value[path];
    return isObject(file)
      && file.path === path
      && typeof file.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(file.sha256)
      && typeof file.byteLength === 'number'
      && Number.isSafeInteger(file.byteLength)
      && file.byteLength >= 0;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertLogicalPath(path: unknown): asserts path is AgentWorkspaceFilePathV1 {
  if (typeof path !== 'string' || !logicalFileSet.has(path)) {
    throw new Error('workspace file path must be one of AGENT.md, HEARTBEAT.md, POLICY.md, or MEMORY.md');
  }
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !safeRunOrActorId.test(value)) {
    throw new Error(`${label} ID must be a safe non-traversing identifier`);
  }
}

function strictUtf8Bytes(content: string, label: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== content) {
    throw new Error(`${label} must be valid UTF-8`);
  }
  return bytes;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function ensureChildDirectory(parent: string, child: string): Promise<string> {
  const path = join(parent, child);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isCode(error, 'EEXIST')) throw error;
  }
  await assertRealDirectory(path, `${child} directory`);
  return path;
}

async function assertDoesNotExist(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

async function writeBytesDurable(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonDurable(path: string, value: unknown): Promise<void> {
  await writeBytesDurable(path, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
}

async function atomicJsonReplace(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.staging-${randomUUID()}`;
  try {
    await writeJsonDurable(temporary, value);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJsonRegularFile(path: string, label: string): Promise<unknown> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must contain JSON`);
  }
}

async function syncDirectory(path: string, failBeforeSync = false): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    if (failBeforeSync) {
      throw new Error('injected post-publication directory sync failure');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function createFaultState(
  faultInjection: FileWorkspaceFaultInjectionV1 | undefined = undefined,
): FileWorkspaceFaultStateV1 {
  const timeout = faultInjection?.lockAcquireTimeoutMs;
  if (
    timeout !== undefined
    && (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
  ) {
    throw new Error('lock acquisition timeout must be a positive safe millisecond value');
  }
  return {
    failLockAcquisition: faultInjection?.failLockAcquisition === true,
    lockAcquireTimeoutMs: timeout,
    failInitialPostPublishSync: faultInjection?.failInitialPostPublishSync === true,
    failMemoryPostPublishSync: faultInjection?.failMemoryPostPublishSync === true,
    failInitialLockRelease: faultInjection?.failInitialLockRelease === true,
    failMemoryLockRelease: faultInjection?.failMemoryLockRelease === true,
  };
}

function consumeFault(
  faults: FileWorkspaceFaultStateV1,
  key:
    | 'failLockAcquisition'
    | 'failInitialPostPublishSync'
    | 'failMemoryPostPublishSync'
    | 'failInitialLockRelease'
    | 'failMemoryLockRelease',
): boolean {
  if (!faults[key]) return false;
  faults[key] = false;
  return true;
}

async function cleanupOrphanStages(parent: string, prefix: string): Promise<void> {
  for (const name of await readdir(parent)) {
    if (!name.startsWith(prefix)) continue;
    await rm(join(parent, name), { recursive: true, force: true });
  }
}

async function acquireLock(input: {
  path: string;
  timeoutMs?: number;
  failAcquisition?: boolean;
  failRelease?: boolean;
}): Promise<FileWorkspaceLockV1> {
  if (input.failAcquisition) {
    throw new Error('injected lock acquisition failure');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS_V1;
  const deadline = Date.now() + timeoutMs;
  let lastInspection: FileWorkspaceLockInspectionV1 = { kind: 'missing' };

  while (Date.now() <= deadline) {
    const owner = newLockOwner();
    const created = await createLock(input.path, owner, false, input.failRelease);
    if (created) return created;

    const observed = await inspectLock(input.path);
    lastInspection = observed;
    let reclaimed = false;
    if (observed.kind === 'owner' && isReclaimableLock(observed.owner)) {
      reclaimed = await reclaimStaleLock(input.path, observed.owner);
    } else if (
      observed.kind === 'initializing'
      && isExpiredInitialization(observed)
    ) {
      reclaimed = await reclaimInitializingLock(input.path, observed);
    }
    if (reclaimed) {
      const replacement = await createLock(
        input.path,
        newLockOwner(),
        true,
        input.failRelease,
      );
      if (replacement) return replacement;
    }
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS_V1));
  }

  if (lastInspection.kind === 'owner' && isProcessAlive(lastInspection.owner.pid)) {
    throw new Error('live lock owner did not become available before the acquisition timeout');
  }
  if (lastInspection.kind === 'initializing') {
    throw new Error('workspace lock initialization is still in progress');
  }
  throw new Error('workspace lock acquisition timed out');
}

async function createLock(
  path: string,
  owner: FileWorkspaceLockOwnerV1,
  recovered = false,
  failRelease = false,
): Promise<FileWorkspaceLockV1 | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error: unknown) {
    if (isCode(error, 'EEXIST')) return undefined;
    throw error;
  }
  try {
    await writeLockOwner(handle, owner);
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  return {
    path,
    owner,
    recovered,
    release: async () => {
      let cleaned = false;
      try {
        const current = await readLockOwner(path);
        if (current && sameLockOwner(current, owner)) {
          await writeLockOwner(handle, { ...owner, released: true });
          await rm(path, { force: true });
          await syncDirectory(dirname(path), failRelease);
          cleaned = true;
        } else {
          cleaned = true;
        }
      } catch {
        // A published workspace must not be reported as an ambiguous failure
        // because lock cleanup failed.  The release marker makes this lock
        // safely reclaimable even while this process remains alive.
        try {
          await writeLockOwner(handle, { ...owner, released: true });
        } catch {
          // The caller receives published_unsynced; a later host restart can
          // still inspect/recover a lock whose marker did reach disk.
        }
      } finally {
        await handle.close();
      }
      return { cleaned };
    },
  };
}

async function writeLockOwner(
  handle: Awaited<ReturnType<typeof open>>,
  owner: FileWorkspaceLockOwnerV1,
): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8'));
  await handle.sync();
}

function newLockOwner(): FileWorkspaceLockOwnerV1 {
  return {
    ownerId: randomUUID(),
    pid: process.pid,
    leaseExpiresAt: Date.now() + DEFAULT_LOCK_LEASE_MS_V1,
  };
}

async function readLockOwner(path: string): Promise<FileWorkspaceLockOwnerV1 | undefined> {
  const inspection = await inspectLock(path);
  return inspection.kind === 'owner' ? inspection.owner : undefined;
}

async function inspectLock(path: string): Promise<FileWorkspaceLockInspectionV1> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return { kind: 'missing' };
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('workspace lock must be a regular file');
  }
  try {
    const bytes = await readFile(path);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(source) as unknown;
    if (isLockOwner(value)) return { kind: 'owner', owner: value };
  } catch {
    // An O_EXCL creator may have crashed after creating the file but before
    // syncing owner JSON.  Treat it as brief initialization, not a permanent
    // malformed lock.
  }
  return { kind: 'initializing', mtimeMs: stats.mtimeMs };
}

function isLockOwner(value: unknown): value is FileWorkspaceLockOwnerV1 {
  return isObject(value)
    && typeof value.ownerId === 'string'
    && /^[a-f0-9-]{36}$/.test(value.ownerId)
    && typeof value.pid === 'number'
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.leaseExpiresAt === 'number'
    && Number.isSafeInteger(value.leaseExpiresAt)
    && (value.released === undefined || typeof value.released === 'boolean');
}

function sameLockOwner(
  left: FileWorkspaceLockOwnerV1,
  right: FileWorkspaceLockOwnerV1,
): boolean {
  return left.ownerId === right.ownerId
    && left.pid === right.pid
    && left.leaseExpiresAt === right.leaseExpiresAt;
}

function isReclaimableLock(owner: FileWorkspaceLockOwnerV1 | undefined): owner is FileWorkspaceLockOwnerV1 {
  return owner !== undefined
    && (owner.released === true || (
      owner.leaseExpiresAt <= Date.now()
      && !isProcessAlive(owner.pid)
    ));
}

function isExpiredInitialization(
  inspection: Extract<FileWorkspaceLockInspectionV1, { kind: 'initializing' }>,
): boolean {
  return Date.now() - inspection.mtimeMs >= LOCK_INITIALIZATION_GRACE_MS_V1;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isCode(error, 'ESRCH');
  }
}

async function reclaimStaleLock(
  path: string,
  expected: FileWorkspaceLockOwnerV1,
): Promise<boolean> {
  const quarantined = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, quarantined);
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
  const moved = await inspectLock(quarantined);
  if (moved.kind !== 'owner' || !sameLockOwner(moved.owner, expected)) {
    await restoreQuarantinedLock(quarantined, path);
    return false;
  }
  await rm(quarantined, { force: true });
  return true;
}

async function reclaimInitializingLock(
  path: string,
  expected: Extract<FileWorkspaceLockInspectionV1, { kind: 'initializing' }>,
): Promise<boolean> {
  const quarantined = `${path}.initializing-${randomUUID()}`;
  try {
    await rename(path, quarantined);
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
  const moved = await inspectLock(quarantined);
  if (
    moved.kind !== 'initializing'
    || moved.mtimeMs !== expected.mtimeMs
    || !isExpiredInitialization(moved)
  ) {
    await restoreQuarantinedLock(quarantined, path);
    return false;
  }
  // The old file has only ever been visible as an incomplete initializer.  It
  // is safe to remove now; the caller creates a new owner record before stage
  // cleanup or any mutable write.
  await rm(quarantined, { force: true });
  return true;
}

async function restoreQuarantinedLock(quarantined: string, path: string): Promise<void> {
  try {
    await link(quarantined, path);
    await rm(quarantined, { force: true });
  } catch (error: unknown) {
    if (!isCode(error, 'EEXIST')) throw error;
    throw new Error('workspace lock changed during stale recovery; refusing to steal it');
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
