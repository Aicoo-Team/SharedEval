import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
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

export type MaterializedFileWorkspaceV1 = FileWorkspacePortV1;

/** Test-only fault point that still writes the real staged filesystem. */
export type FileWorkspaceFaultInjectionV1 = {
  failAfterStagingFile?: AgentWorkspaceFilePathV1;
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

  const lock = await acquireLock(join(workspacesDir, `.lock-${input.actorId}`));
  const stagingDir = join(workspacesDir, `.staging-${input.actorId}-${randomUUID()}`);
  try {
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
    await syncDirectory(workspacesDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.close();
    await rm(lock.path, { force: true });
  }
  return new FileWorkspaceV1({
    actorDir,
    actorId: input.actorId,
    selectedTaskIds: [...input.selectedTaskIds],
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
  });
  // Verify both version state and canonical selection before the port is handed
  // to a new process; no in-memory counter participates in recovery.
  const memory = await workspace.read({ actorId: input.actorId, path: 'MEMORY.md' });
  assertFileMemoryV1({ content: memory.content, selectedTaskIds: input.selectedTaskIds });
  return workspace;
}

class FileWorkspaceV1 implements FileWorkspacePortV1 {
  constructor(private readonly options: {
    actorDir: string;
    actorId: string;
    selectedTaskIds: string[];
  }) {}

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

    // Stage before obtaining the per-actor lock.  The subsequent pointer read
    // is the durable compare point, so an old writer cannot publish this tree.
    const staged = await stageReplacement(this.options.actorDir, memoryBytes);
    const lock = await acquireLock(join(this.options.actorDir, '.memory.lock'));
    try {
      const current = await readPointer(this.options.actorDir);
      const currentMemory = current.files['MEMORY.md'];
      if (current.version !== input.expectedVersion) {
        await rm(staged.directory, { recursive: true, force: true });
        return {
          outcome: 'conflict',
          version: current.version,
          sha256: currentMemory.sha256,
          byteLength: currentMemory.byteLength,
        };
      }

      await verifyVersionDirectory(staged.directory, staged.files);
      const nextDirectory = join(this.options.actorDir, 'versions', staged.name);
      await rename(staged.directory, nextDirectory);
      await verifyVersionDirectory(nextDirectory, staged.files);
      await syncDirectory(join(this.options.actorDir, 'versions'));
      const next: DurablePointer = {
        version: current.version + 1,
        directory: staged.name,
        files: staged.files,
      };
      await atomicJsonReplace(join(this.options.actorDir, 'current.json'), next);
      await syncDirectory(this.options.actorDir);
      const committedMemory = next.files['MEMORY.md'];
      return {
        outcome: 'committed',
        version: next.version,
        sha256: committedMemory.sha256,
        byteLength: committedMemory.byteLength,
      };
    } catch (error) {
      await rm(staged.directory, { recursive: true, force: true });
      throw error;
    } finally {
      await lock.close();
      await rm(lock.path, { force: true });
    }
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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acquireLock(path: string): Promise<{ path: string; close(): Promise<void> }> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      return { path, close: () => handle.close() };
    } catch (error: unknown) {
      if (!isCode(error, 'EEXIST')) throw error;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  }
  throw new Error('workspace lock did not become available');
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
