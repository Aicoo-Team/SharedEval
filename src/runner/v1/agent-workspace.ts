import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const AGENT_WORKSPACE_API_VERSION_V1 =
  'sharedeval/agent-workspace/v1' as const;
export const MAX_AGENT_WORKSPACE_FILE_BYTES_V1 = 1024 * 1024;

const agentWorkspaceFilePathsV1 = new Set<string>([
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
]);

export type AgentWorkspaceFileAccessV1 = 'read_only' | 'read_write';
export type AgentWorkspaceFilePathV1 =
  | 'AGENT.md'
  | 'HEARTBEAT.md'
  | 'POLICY.md'
  | 'MEMORY.md';

export type AgentWorkspaceFileV1<
  Path extends AgentWorkspaceFilePathV1,
  Access extends AgentWorkspaceFileAccessV1,
> = {
  path: Path;
  access: Access;
  content: string;
  sha256: string;
};

export type AgentWorkspaceRawFileV1<Path extends AgentWorkspaceFilePathV1> = {
  path: Path;
  content: string;
  bytesBase64: string;
  byteLength: number;
  sha256: string;
};

export type AgentWorkspaceTemplateV1 = {
  apiVersion: typeof AGENT_WORKSPACE_API_VERSION_V1;
  kind: 'AgentWorkspaceTemplate';
  files: {
    agent: AgentWorkspaceFileV1<'AGENT.md', 'read_only'>;
    heartbeat: AgentWorkspaceFileV1<'HEARTBEAT.md', 'read_only'>;
    policy: AgentWorkspaceFileV1<'POLICY.md', 'read_only'>;
    memory: AgentWorkspaceFileV1<'MEMORY.md', 'read_write'>;
  };
};

export async function loadAgentWorkspaceTemplateV1(options: {
  rootDir: string;
}): Promise<AgentWorkspaceTemplateV1> {
  const rootStats = await lstat(options.rootDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('workspace root must be a real directory');
  }

  const [agent, heartbeat, policy, memory] = await Promise.all([
    loadFile(options.rootDir, 'AGENT.md', 'read_only'),
    loadFile(options.rootDir, 'HEARTBEAT.md', 'read_only'),
    loadFile(options.rootDir, 'POLICY.md', 'read_only'),
    loadFile(options.rootDir, 'MEMORY.md', 'read_write'),
  ]);

  return {
    apiVersion: AGENT_WORKSPACE_API_VERSION_V1,
    kind: 'AgentWorkspaceTemplate',
    files: { agent, heartbeat, policy, memory },
  };
}

export async function loadAgentWorkspaceRawFileV1<
  Path extends AgentWorkspaceFilePathV1,
>(options: {
  rootDir: string;
  path: Path;
}): Promise<AgentWorkspaceRawFileV1<Path>> {
  if (!agentWorkspaceFilePathsV1.has(options.path)) {
    throw new Error(
      `workspace file path must be one of the four workspace files, got ${JSON.stringify(options.path)}`,
    );
  }
  const rootStats = await lstat(options.rootDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('workspace root must be a real directory');
  }

  const absolutePath = join(options.rootDir, options.path);
  const pathStats = await lstat(absolutePath);
  if (pathStats.isSymbolicLink()) {
    throw new Error(
      `${options.path} must be a regular file, not a symbolic link`,
    );
  }
  if (!pathStats.isFile()) {
    throw new Error(`${options.path} must be a regular file`);
  }

  const handle = await open(
    absolutePath,
    constants.O_RDONLY
      | constants.O_NONBLOCK
      | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`${options.path} must be a regular file`);
    }
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) {
      throw new Error(`${options.path} changed while it was being opened`);
    }
    if (stats.size > MAX_AGENT_WORKSPACE_FILE_BYTES_V1) {
      throw new Error(
        `${options.path} exceeds ${MAX_AGENT_WORKSPACE_FILE_BYTES_V1} bytes`,
      );
    }
    bytes = await readBoundedBytes(handle, options.path);
  } finally {
    await handle.close();
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${options.path} must be valid UTF-8`);
  }
  return {
    path: options.path,
    content,
    bytesBase64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function loadFile<
  Path extends AgentWorkspaceFilePathV1,
  Access extends AgentWorkspaceFileAccessV1,
>(
  rootDir: string,
  path: Path,
  access: Access,
): Promise<AgentWorkspaceFileV1<Path, Access>> {
  const raw = await loadAgentWorkspaceRawFileV1({ rootDir, path });
  return {
    path,
    access,
    content: raw.content,
    sha256: raw.sha256,
  };
}

async function readBoundedBytes(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_AGENT_WORKSPACE_FILE_BYTES_V1 + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_AGENT_WORKSPACE_FILE_BYTES_V1) {
    throw new Error(
      `${path} exceeds ${MAX_AGENT_WORKSPACE_FILE_BYTES_V1} bytes`,
    );
  }
  return buffer.subarray(0, offset);
}
