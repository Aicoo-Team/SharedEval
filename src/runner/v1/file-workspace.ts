import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants, linkSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
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
const immutableLogicalFiles = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
] as const satisfies readonly AgentWorkspaceFilePathV1[];
const logicalFileSet = new Set<string>(logicalFiles);
const safeRunOrActorId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionDirectory = /^version-[a-f0-9-]{36}$/;
const commitMarker = /^commit-(0|[1-9][0-9]*)\.json$/;
const MAX_POINTER_JSON_BYTES = 64 * 1024;

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
    /** The marker is visible, but a post-publication fsync/cleanup fault occurred. */
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

/**
 * Cooperative host boundary for one workspace operation. Implementations
 * must fail closed after observing either condition and must not publish a new
 * MEMORY version. A host that mutates after observation violates this port.
 */
export type FileWorkspaceOperationControlV1 = {
  /** Cooperative cancellation for one read or MEMORY replacement. */
  signal?: AbortSignal;
  /** Absolute Unix epoch deadline in milliseconds. */
  deadlineAtMs?: number;
};

export interface FileWorkspacePortV1 {
  read(input: {
    actorId: string;
    path: AgentWorkspaceFilePathV1;
  } & FileWorkspaceOperationControlV1): Promise<{
    content: string;
    receipt: FileReadReceiptV1;
  }>;
  replaceMemory(input: {
    actorId: string;
    expectedVersion: number;
    content: string;
  } & FileWorkspaceOperationControlV1): Promise<ReplaceMemoryResultV1>;
  snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1>;
}

export type MaterializedFileWorkspaceV1 = FileWorkspacePortV1 & {
  publication: {
    /** A published workspace remains readable/reopenable after an fsync fault. */
    durability: 'synced' | 'published_unsynced';
  };
};

/** Test-only fault points. Every normal path still uses the real filesystem. */
export type FileWorkspaceFaultInjectionV1 = {
  failAfterStagingFile?: AgentWorkspaceFilePathV1;
  failInitialPostPublishSync?: boolean;
  failMemoryPostPublishSync?: boolean;
  /** Fails before the published pointer temp is removed; run-level GC owns it. */
  failMemoryPreRemovalCleanup?: boolean;
  failMemoryPostPublishCleanup?: boolean;
  /** Deterministic test seam immediately before the sole MEMORY publisher. */
  beforeMemoryPublicationForTest?: () => void | Promise<void>;
  /** Test-only ceiling used to prove the next durable version cannot overflow. */
  versionCeilingForTest?: number;
};

type FileWorkspaceFaultStateV1 = {
  failInitialPostPublishSync: boolean;
  failMemoryPostPublishSync: boolean;
  failMemoryPreRemovalCleanup: boolean;
  failMemoryPostPublishCleanup: boolean;
  beforeMemoryPublicationForTest?: () => void | Promise<void>;
  versionCeiling: number;
};

type DurablePointer = {
  version: number;
  directory: string;
  files: FileWorkspaceFileSetV1;
};

type StoredInitialSnapshot = {
  version: 0;
  directory: string;
  files: FileWorkspaceFileSetV1;
};

type ValidatedWorkspaceHistory = {
  initial: StoredInitialSnapshot;
  latest: DurablePointer;
};

type LoadedWorkspaceFile = {
  path: AgentWorkspaceFilePathV1;
  content: string;
  bytesBase64: string;
  sha256: string;
  byteLength: number;
};

type LoadedWorkspaceFileSet = Record<AgentWorkspaceFilePathV1, LoadedWorkspaceFile>;

/**
 * Creates one private workspace for one actor. The actor directory is an
 * atomic rename of a fully re-read staging tree; logical callers never receive
 * the host paths used to store it.
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
  // UUID-only staging names are not actor-derived, so one actor can never
  // confuse another actor's private bytes for cleanup work.
  const stagingDir = join(workspacesDir, `.workspace-stage-${randomUUID()}`);
  let published = false;
  let publicationDurability: 'synced' | 'published_unsynced' = 'synced';
  try {
    await mkdir(stagingDir, { mode: 0o700 });
    const versionsDir = await ensureChildDirectory(stagingDir, 'versions');
    const commitsDir = await ensureChildDirectory(stagingDir, 'commits');
    const version = `version-${randomUUID()}`;
    const stagedVersionDir = await ensureChildDirectory(versionsDir, version);
    const files = await writeTemplateVersion({
      directory: stagedVersionDir,
      template: input.template,
      faultInjection: input.faultInjection,
    });
    const pointer: DurablePointer = { version: 0, directory: version, files };
    const initial: StoredInitialSnapshot = { version: 0, directory: version, files };
    await writeJsonDurable(join(stagingDir, 'initial.json'), initial);
    await writeJsonDurable(join(commitsDir, commitMarkerName(0)), pointer);
    await syncDirectory(stagedVersionDir);
    await syncDirectory(versionsDir);
    await syncDirectory(commitsDir);
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
  }
  return new FileWorkspaceV1({
    actorDir,
    actorId: input.actorId,
    selectedTaskIds: [...input.selectedTaskIds],
    faults,
    publication: { durability: publicationDurability },
  });
}

/** Reopens a materialized workspace after a process restart from durable commit markers. */
export async function openFileWorkspaceV1(input: {
  rootDir: string;
  runId: string;
  actorId: string;
  selectedTaskIds: readonly string[];
}): Promise<FileWorkspacePortV1> {
  assertSafeId(input.runId, 'run');
  assertSafeId(input.actorId, 'actor');
  await assertRealDirectory(input.rootDir, 'workspace root');
  const runsDir = join(input.rootDir, 'runs');
  await assertRealDirectory(runsDir, 'workspace runs directory');
  const runDir = join(runsDir, input.runId);
  await assertRealDirectory(runDir, 'workspace run directory');
  const workspacesDir = join(runDir, 'workspaces');
  await assertRealDirectory(workspacesDir, 'workspace actors directory');
  const actorDir = join(workspacesDir, input.actorId);
  await assertRealDirectory(actorDir, 'actor workspace');
  const workspace = new FileWorkspaceV1({
    actorDir,
    actorId: input.actorId,
    selectedTaskIds: [...input.selectedTaskIds],
    faults: createFaultState(),
    publication: { durability: 'synced' },
  });
  // Verify every committed transition before a new process receives a port;
  // no in-memory counter participates in recovery.
  await validateWorkspaceHistory(actorDir, input.selectedTaskIds);
  return workspace;
}

/** Reports whether an actor workspace exists without creating or validating it. */
export async function inspectFileWorkspacePresenceV1(input: {
  rootDir: string;
  runId: string;
  actorId: string;
}): Promise<'absent' | 'present'> {
  assertSafeId(input.runId, 'run');
  assertSafeId(input.actorId, 'actor');
  await assertRealDirectory(input.rootDir, 'workspace root');

  let directory = input.rootDir;
  for (const [child, label] of [
    ['runs', 'workspace runs directory'],
    [input.runId, 'workspace run directory'],
    ['workspaces', 'workspace actors directory'],
    [input.actorId, 'actor workspace'],
  ] as const) {
    directory = join(directory, child);
    if (!await inspectRealDirectory(directory, label)) return 'absent';
  }
  return 'present';
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

  async read(input: {
    actorId: string;
    path: AgentWorkspaceFilePathV1;
  } & FileWorkspaceOperationControlV1): Promise<{
    content: string;
    receipt: FileReadReceiptV1;
  }> {
    assertWorkspaceOperationActive(input);
    this.assertActor(input.actorId);
    assertLogicalPath(input.path);
    const { latest: pointer } = await validateWorkspaceHistory(
      this.options.actorDir,
      this.options.selectedTaskIds,
    );
    assertWorkspaceOperationActive(input);
    const file = await loadVersionFile(this.options.actorDir, pointer, input.path);
    assertWorkspaceOperationActive(input);
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
  } & FileWorkspaceOperationControlV1): Promise<ReplaceMemoryResultV1> {
    assertWorkspaceOperationActive(input);
    this.assertActor(input.actorId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error('expected MEMORY version must be a non-negative safe integer');
    }
    assertFileMemoryV1({
      content: input.content,
      selectedTaskIds: this.options.selectedTaskIds,
    });
    const memoryBytes = strictUtf8Bytes(input.content, 'MEMORY content');

    // A private, immutable stage needs no mutable ownership protocol. The
    // append-only link below is the sole atomic publisher and CAS winner.
    const beforeStage = await validateWorkspaceHistory(
      this.options.actorDir,
      this.options.selectedTaskIds,
    );
    assertWorkspaceOperationActive(input);
    let staged: Awaited<ReturnType<typeof stageReplacement>> | undefined = await stageReplacement(
      this.options.actorDir,
      memoryBytes,
      beforeStage.latest,
    );
    let publishedVersionDirectory: string | undefined;
    let pointerTemporary: string | undefined;
    try {
      assertWorkspaceOperationActive(input);
      const { latest: current } = await validateWorkspaceHistory(
        this.options.actorDir,
        this.options.selectedTaskIds,
      );
      assertWorkspaceOperationActive(input);
      if (current.version !== input.expectedVersion) {
        await removeOwnedDirectory(staged.directory);
        staged = undefined;
        assertWorkspaceOperationActive(input);
        return conflictFor(current);
      }

      const stagedVersion = staged;
      publishedVersionDirectory = join(this.options.actorDir, 'versions', stagedVersion.name);
      await verifyVersionDirectory(stagedVersion.directory, stagedVersion.files);
      assertWorkspaceOperationActive(input);
      await rename(stagedVersion.directory, publishedVersionDirectory);
      staged = undefined;
      assertWorkspaceOperationActive(input);
      await verifyVersionDirectory(publishedVersionDirectory, stagedVersion.files);
      assertWorkspaceOperationActive(input);
      await syncDirectory(join(this.options.actorDir, 'versions'));
      assertWorkspaceOperationActive(input);

      const next: DurablePointer = {
        version: nextMemoryVersion(current.version, this.options.faults.versionCeiling),
        directory: stagedVersion.name,
        files: stagedVersion.files,
      };
      pointerTemporary = await writeCommitPointerTemporary(this.options.actorDir, next);
      assertWorkspaceOperationActive(input);
      await this.options.faults.beforeMemoryPublicationForTest?.();
      assertWorkspaceOperationActive(input);
      const marker = join(this.options.actorDir, 'commits', commitMarkerName(next.version));
      try {
        // No await may separate this final check from the sole authoritative
        // publication call. A successful link is never rolled back.
        assertWorkspaceOperationActive(input);
        linkSync(pointerTemporary, marker);
      } catch (error: unknown) {
        await rm(pointerTemporary, { force: true });
        pointerTemporary = undefined;
        assertWorkspaceOperationActive(input);
        if (!isCode(error, 'EEXIST')) throw error;
        await removeOwnedDirectory(publishedVersionDirectory);
        publishedVersionDirectory = undefined;
        assertWorkspaceOperationActive(input);
        const { latest } = await validateWorkspaceHistory(
          this.options.actorDir,
          this.options.selectedTaskIds,
        );
        assertWorkspaceOperationActive(input);
        return conflictFor(latest);
      }

      // Once linkSync() succeeds, complete pointer bytes are visible atomically.
      // All later failures are qualified as a committed, reopenable result.
      let durability: 'published_unsynced' | undefined;
      try {
        await syncDirectory(
          join(this.options.actorDir, 'commits'),
          consumeFault(this.options.faults, 'failMemoryPostPublishSync'),
        );
      } catch {
        durability = 'published_unsynced';
      }
      try {
        if (consumeFault(this.options.faults, 'failMemoryPreRemovalCleanup')) {
          throw new Error('injected pre-removal pointer cleanup failure');
        }
        await rm(pointerTemporary, { force: true });
        pointerTemporary = undefined;
        await syncDirectory(
          this.options.actorDir,
          consumeFault(this.options.faults, 'failMemoryPostPublishCleanup'),
        );
      } catch {
        durability = 'published_unsynced';
      }
      const committedMemory = next.files['MEMORY.md'];
      return {
        outcome: 'committed',
        version: next.version,
        sha256: committedMemory.sha256,
        byteLength: committedMemory.byteLength,
        ...(durability ? { durability } : {}),
      };
    } catch (error) {
      if (staged) await removeOwnedDirectory(staged.directory);
      if (publishedVersionDirectory) await removeOwnedDirectory(publishedVersionDirectory);
      if (pointerTemporary) await rm(pointerTemporary, { force: true });
      throw error;
    }
  }

  async snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1> {
    this.assertActor(actorId);
    const { initial, latest: current } = await validateWorkspaceHistory(
      this.options.actorDir,
      this.options.selectedTaskIds,
    );
    return {
      actorId,
      initial: { version: initial.version, files: initial.files },
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

async function stageReplacement(
  actorDir: string,
  memoryBytes: Buffer,
  source: DurablePointer,
): Promise<{
  directory: string;
  name: string;
  files: FileWorkspaceFileSetV1;
}> {
  const name = `version-${randomUUID()}`;
  const directory = join(actorDir, `.memory-stage-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const path of logicalFiles) {
      const currentFile = await loadVersionFile(actorDir, source, path);
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
    await removeOwnedDirectory(directory);
    throw error;
  }
}

async function readVersionFiles(directory: string): Promise<FileWorkspaceFileSetV1> {
  const rawFiles = await loadVersionFiles(directory);
  return Object.fromEntries(logicalFiles.map(path => [path, {
    path,
    sha256: rawFiles[path].sha256,
    byteLength: rawFiles[path].byteLength,
  }])) as FileWorkspaceFileSetV1;
}

async function loadVersionFiles(directory: string): Promise<LoadedWorkspaceFileSet> {
  await assertExactVersionDirectory(directory);
  const entries = await Promise.all(logicalFiles.map(async path => {
    const raw = await loadAgentWorkspaceRawFileV1({ rootDir: directory, path });
    return [path, {
      content: raw.content,
      bytesBase64: raw.bytesBase64,
      path,
      sha256: raw.sha256,
      byteLength: raw.byteLength,
    } satisfies LoadedWorkspaceFile] as const;
  }));
  return Object.fromEntries(entries) as LoadedWorkspaceFileSet;
}

async function loadVersionFile(
  actorDir: string,
  pointer: DurablePointer,
  path: AgentWorkspaceFilePathV1,
) {
  const directory = join(actorDir, 'versions', pointer.directory);
  await assertExactVersionDirectory(directory);
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

async function assertExactVersionDirectory(directory: string): Promise<void> {
  await assertRealDirectory(directory, 'workspace version');
  const names = await readdir(directory);
  if (
    names.length !== logicalFiles.length
    || names.some(name => !logicalFileSet.has(name))
  ) {
    throw new Error('workspace version must contain exactly the four logical files');
  }
}

function assertFileSetMatchesLoadedFiles(
  expected: FileWorkspaceFileSetV1,
  actual: LoadedWorkspaceFileSet,
  label: string,
): void {
  for (const path of logicalFiles) {
    if (
      actual[path].path !== expected[path].path
      || actual[path].sha256 !== expected[path].sha256
      || actual[path].byteLength !== expected[path].byteLength
    ) {
      throw new Error(`${label} ${path} does not match its published hash`);
    }
  }
}

function matchesInitialPointer(
  pointer: DurablePointer,
  initial: StoredInitialSnapshot,
): boolean {
  return pointer.version === initial.version
    && pointer.directory === initial.directory
    && sameFileSet(pointer.files, initial.files);
}

function sameFileSet(
  left: FileWorkspaceFileSetV1,
  right: FileWorkspaceFileSetV1,
): boolean {
  return logicalFiles.every(path => sameFileMetadata(left[path], right[path]));
}

function sameFileMetadata(
  left: FileWorkspaceFileMetadataV1,
  right: FileWorkspaceFileMetadataV1,
): boolean {
  return left.path === right.path
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength;
}

function assertImmutableFiles(
  pointerFiles: FileWorkspaceFileSetV1,
  rawFiles: LoadedWorkspaceFileSet,
  initialMetadata: FileWorkspaceFileSetV1,
  initialFiles: LoadedWorkspaceFileSet,
  version: number,
): void {
  for (const path of immutableLogicalFiles) {
    if (!sameFileMetadata(pointerFiles[path], initialMetadata[path])) {
      throw new Error(`${path} metadata changed in immutable workspace commit ${version}`);
    }
    if (rawFiles[path].bytesBase64 !== initialFiles[path].bytesBase64) {
      throw new Error(`${path} bytes changed in immutable workspace commit ${version}`);
    }
  }
}

async function validateWorkspaceHistory(
  actorDir: string,
  selectedTaskIds: readonly string[],
): Promise<ValidatedWorkspaceHistory> {
  await assertRealDirectory(actorDir, 'actor workspace');
  const versionsDir = join(actorDir, 'versions');
  await assertRealDirectory(versionsDir, 'workspace versions');
  const commitsDir = join(actorDir, 'commits');
  await assertRealDirectory(commitsDir, 'workspace commits');
  const initial = await readInitialSnapshot(actorDir);
  const markers = await readCommitMarkers(commitsDir);
  if (markers.length === 0 || markers[0].version !== 0) {
    throw new Error('workspace commit history must begin at version 0');
  }
  const referencedDirectories = new Set<string>();
  let immutableFiles: LoadedWorkspaceFileSet | undefined;
  let latest: DurablePointer | undefined;
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (marker.version !== index) {
      throw new Error('workspace commit history must be contiguous');
    }
    const value = await readJsonRegularFile(marker.path, `workspace commit ${marker.version}`);
    if (!isDurablePointer(value) || value.version !== marker.version) {
      throw new Error(`workspace commit ${marker.version} is invalid`);
    }
    if (referencedDirectories.has(value.directory)) {
      throw new Error('workspace commit history must reference unique version directories');
    }
    referencedDirectories.add(value.directory);
    const versionPath = join(versionsDir, value.directory);
    const rawFiles = await loadVersionFiles(versionPath);
    assertFileSetMatchesLoadedFiles(value.files, rawFiles, `workspace commit ${marker.version}`);
    if (marker.version === 0) {
      if (!matchesInitialPointer(value, initial)) {
        throw new Error('workspace commit 0 must exactly match the initial workspace snapshot');
      }
      immutableFiles = rawFiles;
    } else {
      if (!immutableFiles) throw new Error('workspace commit history is missing its initial immutable files');
      assertImmutableFiles(value.files, rawFiles, initial.files, immutableFiles, marker.version);
    }
    assertFileMemoryV1({
      content: rawFiles['MEMORY.md'].content,
      selectedTaskIds,
    });
    latest = value;
  }
  if (!latest) throw new Error('workspace commit history is empty');
  return { initial, latest };
}

async function readCommitMarkers(commitsDir: string): Promise<Array<{ version: number; path: string }>> {
  const names = await readdir(commitsDir);
  const markers = names.map(name => {
    const match = commitMarker.exec(name);
    if (!match) throw new Error('workspace commits may contain only append-only commit markers');
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) {
      throw new Error('workspace commit version must be a safe integer');
    }
    return { version, path: join(commitsDir, name) };
  });
  markers.sort((left, right) => left.version - right.version);
  return markers;
}

async function readInitialSnapshot(actorDir: string): Promise<StoredInitialSnapshot> {
  const value = await readJsonRegularFile(join(actorDir, 'initial.json'), 'initial workspace snapshot');
  if (!isInitialSnapshot(value)) throw new Error('initial workspace snapshot is invalid');
  return value;
}

function isDurablePointer(value: unknown): value is DurablePointer {
  if (
    !isObject(value)
    || !hasExactKeys(value, ['version', 'directory', 'files'])
    || typeof value.version !== 'number'
    || !Number.isSafeInteger(value.version)
    || value.version < 0
  ) return false;
  return typeof value.directory === 'string'
    && versionDirectory.test(value.directory)
    && isFileSet(value.files);
}

function isInitialSnapshot(value: unknown): value is StoredInitialSnapshot {
  return isObject(value)
    && hasExactKeys(value, ['version', 'directory', 'files'])
    && value.version === 0
    && typeof value.directory === 'string'
    && versionDirectory.test(value.directory)
    && isFileSet(value.files);
}

function isFileSet(value: unknown): value is FileWorkspaceFileSetV1 {
  if (!isObject(value) || !hasExactKeys(value, logicalFiles)) return false;
  return logicalFiles.every(path => {
    const file = value[path];
    return isObject(file)
      && hasExactKeys(file, ['path', 'sha256', 'byteLength'])
      && file.path === path
      && typeof file.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(file.sha256)
      && typeof file.byteLength === 'number'
      && Number.isSafeInteger(file.byteLength)
      && file.byteLength >= 0;
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
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

async function inspectRealDirectory(path: string, label: string): Promise<boolean> {
  try {
    await assertRealDirectory(path, label);
    return true;
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
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

async function writeCommitPointerTemporary(actorDir: string, pointer: DurablePointer): Promise<string> {
  const temporary = join(actorDir, `.commit-pointer-${randomUUID()}.json`);
  try {
    await writeJsonDurable(temporary, pointer);
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJsonRegularFile(path: string, label: string): Promise<unknown> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  let bytes: Buffer;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const after = await handle.stat();
    if (
      !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.size > MAX_POINTER_JSON_BYTES
    ) {
      throw new Error(`${label} must be an unchanged regular file`);
    }
    bytes = await handle.readFile();
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (handle) await handle.close();
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
  const versionCeiling = faultInjection?.versionCeilingForTest ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(versionCeiling) || versionCeiling < 0) {
    throw new Error('test version ceiling must be a non-negative safe integer');
  }
  return {
    failInitialPostPublishSync: faultInjection?.failInitialPostPublishSync === true,
    failMemoryPostPublishSync: faultInjection?.failMemoryPostPublishSync === true,
    failMemoryPreRemovalCleanup: faultInjection?.failMemoryPreRemovalCleanup === true,
    failMemoryPostPublishCleanup: faultInjection?.failMemoryPostPublishCleanup === true,
    ...(faultInjection?.beforeMemoryPublicationForTest
      ? { beforeMemoryPublicationForTest: faultInjection.beforeMemoryPublicationForTest }
      : {}),
    versionCeiling,
  };
}

function assertWorkspaceOperationActive(
  control: FileWorkspaceOperationControlV1,
): void {
  if (control.signal?.aborted) {
    throw new Error('File workspace operation cancelled');
  }
  if (control.deadlineAtMs === undefined) return;
  if (!Number.isSafeInteger(control.deadlineAtMs) || control.deadlineAtMs < 0) {
    throw new Error('File workspace operation deadline is invalid');
  }
  if (Date.now() >= control.deadlineAtMs) {
    throw new Error('File workspace operation deadline exceeded');
  }
}

function consumeFault(
  faults: FileWorkspaceFaultStateV1,
  key: 'failInitialPostPublishSync' | 'failMemoryPostPublishSync'
    | 'failMemoryPreRemovalCleanup' | 'failMemoryPostPublishCleanup',
): boolean {
  if (!faults[key]) return false;
  faults[key] = false;
  return true;
}

function commitMarkerName(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('workspace commit version must be a non-negative safe integer');
  }
  return `commit-${version}.json`;
}

function nextMemoryVersion(currentVersion: number, ceiling: number): number {
  if (currentVersion >= ceiling || currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw new Error('MEMORY durable version space is exhausted');
  }
  return currentVersion + 1;
}

function conflictFor(pointer: DurablePointer): ReplaceMemoryResultV1 {
  const memory = pointer.files['MEMORY.md'];
  return {
    outcome: 'conflict',
    version: pointer.version,
    sha256: memory.sha256,
    byteLength: memory.byteLength,
  };
}

async function removeOwnedDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
