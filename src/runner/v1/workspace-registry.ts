import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  AGENT_WORKSPACE_API_VERSION_V1,
  MAX_AGENT_WORKSPACE_FILE_BYTES_V1,
  loadAgentWorkspaceRawFileV1,
  type AgentWorkspaceFilePathV1,
  type AgentWorkspaceTemplateV1,
} from './agent-workspace.js';
import type { SharedevalWorkflowIdV1 } from './workflow.js';

export const WORKSPACE_REGISTRY_API_VERSION_V1 =
  'sharedeval/workspace-registry/v1' as const;

const workspaceFileNames = [
  'AGENT.md',
  'HEARTBEAT.md',
  'POLICY.md',
  'MEMORY.md',
] as const;
const workspaceFileNameSet = new Set<string>(workspaceFileNames);

const actorRoleV1Schema = z.enum(['requester', 'responder']);
const workflowIdV1Schema = z.enum([
  'files-multi',
  'files-single',
  'legacy-multi-transcript',
  'legacy-single-prompt',
]);
const statusV1Schema = z.enum(['active', 'legacy', 'draft', 'incomplete']);
const semanticVersionSchema = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
  'version must be a semantic major.minor.patch version',
);
const registryIdSchema = z.string().min(1).max(256).regex(
  /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/,
  'id must use lowercase registry path characters',
).refine(value => !value.split('/').some(part => part === '' || part === '.' || part === '..'), {
  message: 'id must not contain empty or traversal segments',
});
const safeSourcePathSchema = z.string().min(1).max(512).superRefine(
  (value, context) => {
    const segments = value.split('/');
    if (
      value.startsWith('/')
      || value.includes('\\')
      || value.includes('\0')
      || segments.some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourcePath must be a safe relative path without traversal',
      });
      return;
    }
    const fileName = segments.at(-1);
    if (!fileName || !workspaceFileNameSet.has(fileName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourcePath must end in AGENT.md, HEARTBEAT.md, POLICY.md, or MEMORY.md',
      });
    }
  },
);
const provenanceAliasSchema = z.string().min(1).max(512).refine(value => {
  const fileName = value.split('/').at(-1);
  return fileName !== 'COO.md' && fileName !== 'USER.md';
}, {
  message: 'aliases must not make legacy COO.md or USER.md a workspace asset',
});

function uniqueNonemptySortedStrings(label: string) {
  return z.array(z.string().min(1).max(512)).min(1).superRefine(
    (values, context) => addSortedUniqueIssues(label, values, context),
  );
}

function sortedUniqueEnumArray<Schema extends z.ZodTypeAny>(
  label: string,
  schema: Schema,
) {
  return z.array(schema).min(1).superRefine(
    (values, context) => addSortedUniqueIssues(label, values, context),
  );
}

function addSortedUniqueIssues(
  label: string,
  values: readonly unknown[],
  context: z.RefinementCtx,
): void {
  const strings = values.map(String);
  if (new Set(strings).size !== strings.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} must contain unique values`,
    });
  }
  const sorted = [...strings].sort();
  if (strings.some((value, index) => value !== sorted[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} must use stable lexical order`,
    });
  }
}

export const workspaceRegistryAssetV1Schema = z.object({
  id: registryIdSchema,
  version: semanticVersionSchema,
  actorRoles: sortedUniqueEnumArray('actorRoles', actorRoleV1Schema),
  sourcePath: safeSourcePathSchema,
  byteLength: z.number().int().nonnegative().max(MAX_AGENT_WORKSPACE_FILE_BYTES_V1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be a lowercase SHA-256 digest'),
  aliases: z.array(provenanceAliasSchema).min(1).superRefine(
    (values, context) => addSortedUniqueIssues('aliases', values, context),
  ),
  status: statusV1Schema,
  compatibleDatasets: uniqueNonemptySortedStrings('compatibleDatasets'),
  compatibleWorkflowIds: sortedUniqueEnumArray(
    'compatibleWorkflowIds',
    workflowIdV1Schema,
  ),
}).strict();

export type WorkspaceRegistryAssetV1 = z.infer<
  typeof workspaceRegistryAssetV1Schema
> & {
  compatibleWorkflowIds: SharedevalWorkflowIdV1[];
};

export const workspaceRegistryV1Schema = z.object({
  apiVersion: z.literal(WORKSPACE_REGISTRY_API_VERSION_V1),
  kind: z.literal('WorkspaceRegistry'),
  assets: z.array(workspaceRegistryAssetV1Schema).min(1),
}).strict().superRefine((registry, context) => {
  let previous: string | undefined;
  const seen = new Set<string>();
  for (const [index, asset] of registry.assets.entries()) {
    const key = `${asset.id}@${asset.version}`;
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets', index],
        message: `duplicate registry id@version ${key}`,
      });
    }
    if (previous !== undefined && key <= previous) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets', index],
        message: 'registry assets must use stable lexical id@version order',
      });
    }
    previous = key;
    seen.add(key);
  }
});

export type WorkspaceRegistryV1 = z.infer<typeof workspaceRegistryV1Schema>;

export type ResolvedWorkspaceRegistryAssetV1 = {
  asset: WorkspaceRegistryAssetV1;
  content: string;
  bytesBase64: string;
  byteLength: number;
  sha256: string;
};

const assetReferenceV1Schema = z.object({
  id: registryIdSchema,
  version: semanticVersionSchema,
}).strict();

export const agentWorkspaceRegistryReferencesV1Schema = z.object({
  agent: assetReferenceV1Schema,
  heartbeat: assetReferenceV1Schema,
  policy: assetReferenceV1Schema,
  memory: assetReferenceV1Schema,
}).strict();

export type AgentWorkspaceRegistryReferencesV1 = z.infer<
  typeof agentWorkspaceRegistryReferencesV1Schema
>;

export type ResolvedAgentWorkspaceRegistryV1 = {
  template: AgentWorkspaceTemplateV1;
  assets: {
    agent: ResolvedWorkspaceRegistryAssetV1;
    heartbeat: ResolvedWorkspaceRegistryAssetV1;
    policy: ResolvedWorkspaceRegistryAssetV1;
    memory: ResolvedWorkspaceRegistryAssetV1;
  };
};

export function parseWorkspaceRegistryV1(value: unknown): WorkspaceRegistryV1 {
  return workspaceRegistryV1Schema.parse(value);
}

export async function loadWorkspaceRegistryV1(options: {
  rootDir: string;
}): Promise<WorkspaceRegistryV1> {
  await assertRealDirectory(options.rootDir, 'registry root');
  const source = await readRegistryFile(join(options.rootDir, 'registry.json'));
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `registry.json must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseWorkspaceRegistryV1(value);
}

export async function resolveWorkspaceRegistryAssetV1(options: {
  rootDir: string;
  registry: WorkspaceRegistryV1;
  id: string;
  version: string;
  actorRole: 'requester' | 'responder';
  datasetId: string;
  workflowId: SharedevalWorkflowIdV1;
}): Promise<ResolvedWorkspaceRegistryAssetV1> {
  const registry = parseWorkspaceRegistryV1(options.registry);
  const asset = registry.assets.find(candidate =>
    candidate.id === options.id && candidate.version === options.version
  );
  if (!asset) {
    throw new Error(`workspace registry asset ${options.id}@${options.version} does not exist`);
  }
  if (asset.status === 'draft' || asset.status === 'incomplete') {
    throw new Error(
      `workspace registry asset ${asset.id}@${asset.version} is ${asset.status} and cannot be executed`,
    );
  }
  if (!asset.actorRoles.includes(options.actorRole)) {
    throw new Error(
      `workspace registry asset ${asset.id}@${asset.version} is not compatible with actor role ${options.actorRole}`,
    );
  }
  if (!asset.compatibleDatasets.includes(options.datasetId)) {
    throw new Error(
      `workspace registry asset ${asset.id}@${asset.version} is not compatible with dataset ${options.datasetId}`,
    );
  }
  if (!asset.compatibleWorkflowIds.includes(options.workflowId)) {
    throw new Error(
      `workspace registry asset ${asset.id}@${asset.version} is not compatible with workflow ${options.workflowId}`,
    );
  }

  await assertSafeSourceAncestors(options.rootDir, asset.sourcePath);
  const path = basename(asset.sourcePath) as AgentWorkspaceFilePathV1;
  const raw = await loadAgentWorkspaceRawFileV1({
    rootDir: dirname(join(options.rootDir, asset.sourcePath)),
    path,
  });
  if (raw.byteLength !== asset.byteLength) {
    throw new Error(
      `workspace registry asset ${asset.id}@${asset.version} byte length mismatch: expected ${asset.byteLength}, got ${raw.byteLength}`,
    );
  }
  if (raw.sha256 !== asset.sha256) {
    throw new Error(
      `workspace registry asset ${asset.id}@${asset.version} SHA-256 mismatch: expected ${asset.sha256}, got ${raw.sha256}`,
    );
  }
  return {
    asset: asset as WorkspaceRegistryAssetV1,
    content: raw.content,
    bytesBase64: raw.bytesBase64,
    byteLength: raw.byteLength,
    sha256: raw.sha256,
  };
}

export async function resolveAgentWorkspaceRegistryV1(options: {
  rootDir: string;
  registry: WorkspaceRegistryV1;
  references: AgentWorkspaceRegistryReferencesV1;
  actorRole: 'requester' | 'responder';
  datasetId: string;
  workflowId: SharedevalWorkflowIdV1;
}): Promise<ResolvedAgentWorkspaceRegistryV1> {
  const references = agentWorkspaceRegistryReferencesV1Schema.parse(
    options.references,
  );
  const common = {
    rootDir: options.rootDir,
    registry: options.registry,
    actorRole: options.actorRole,
    datasetId: options.datasetId,
    workflowId: options.workflowId,
  };
  const [agent, heartbeat, policy, memory] = await Promise.all([
    resolveWorkspaceRegistryAssetV1({ ...common, ...references.agent }),
    resolveWorkspaceRegistryAssetV1({ ...common, ...references.heartbeat }),
    resolveWorkspaceRegistryAssetV1({ ...common, ...references.policy }),
    resolveWorkspaceRegistryAssetV1({ ...common, ...references.memory }),
  ]);
  assertResolvedSlot(agent, 'AGENT.md');
  assertResolvedSlot(heartbeat, 'HEARTBEAT.md');
  assertResolvedSlot(policy, 'POLICY.md');
  assertResolvedSlot(memory, 'MEMORY.md');

  return {
    template: {
      apiVersion: AGENT_WORKSPACE_API_VERSION_V1,
      kind: 'AgentWorkspaceTemplate',
      files: {
        agent: toTemplateFile(agent, 'AGENT.md', 'read_only'),
        heartbeat: toTemplateFile(heartbeat, 'HEARTBEAT.md', 'read_only'),
        policy: toTemplateFile(policy, 'POLICY.md', 'read_only'),
        memory: toTemplateFile(memory, 'MEMORY.md', 'read_write'),
      },
    },
    assets: { agent, heartbeat, policy, memory },
  };
}

function assertResolvedSlot(
  resolved: ResolvedWorkspaceRegistryAssetV1,
  expected: AgentWorkspaceFilePathV1,
): void {
  const actual = basename(resolved.asset.sourcePath);
  if (actual !== expected) {
    throw new Error(
      `workspace slot ${expected} resolved incompatible asset path ${resolved.asset.sourcePath}`,
    );
  }
}

function toTemplateFile<
  Path extends AgentWorkspaceFilePathV1,
  Access extends 'read_only' | 'read_write',
>(
  resolved: ResolvedWorkspaceRegistryAssetV1,
  path: Path,
  access: Access,
) {
  return {
    path,
    access,
    content: resolved.content,
    sha256: resolved.sha256,
  };
}

async function assertSafeSourceAncestors(
  rootDir: string,
  sourcePath: string,
): Promise<void> {
  await assertRealDirectory(rootDir, 'registry root');
  const segments = sourcePath.split('/').slice(0, -1);
  let current = rootDir;
  for (const segment of segments) {
    current = join(current, segment);
    await assertRealDirectory(current, `${sourcePath} ancestor`);
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function readRegistryFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('registry.json must be a regular file, not a symbolic link');
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('registry.json must be a regular file');
    if (stats.dev !== before.dev || stats.ino !== before.ino) {
      throw new Error('registry.json changed while it was being opened');
    }
    if (stats.size > MAX_AGENT_WORKSPACE_FILE_BYTES_V1) {
      throw new Error(
        `registry.json exceeds ${MAX_AGENT_WORKSPACE_FILE_BYTES_V1} bytes`,
      );
    }
    bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    bytes = bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('registry.json must be valid UTF-8');
  }
}
