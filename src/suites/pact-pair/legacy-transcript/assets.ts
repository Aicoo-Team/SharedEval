import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { safeRelativePathSchema } from '../../../protocol/v1/index.js';
import type {
  LegacyAgentConfigV1,
  LegacyMultiConfigV1,
} from './config.js';

export const MAX_LEGACY_ASSET_BYTES_V1 = 1_048_576;
export const CANONICAL_LEGACY_SCRIPT_SHA256_V1 =
  'b7debe7e21e4d62cb3595e428a78b0a128028cb980f9ffe19afada04a4997510' as const;

export type LegacyAssetKindV1 = 'coo' | 'policy' | 'memory' | 'script';
export type LegacyAssetProvenanceV1 = {
  kind: LegacyAssetKindV1;
  path: string;
  rawSha256: string;
  bytes: number;
  status: 'legacy';
};
export type FrozenLegacyAssetV1 = Readonly<{
  bytes: Uint8Array;
  content: string;
  provenance: Readonly<LegacyAssetProvenanceV1>;
}>;

export type FreezeLegacyAssetHooksV1 = {
  afterRead?: (absolutePath: string) => void | Promise<void>;
};

export type FrozenLegacyAgentAssetsV1 = Readonly<{
  persona: LegacyAgentConfigV1['persona'];
  coo: FrozenLegacyAssetV1;
  policy: FrozenLegacyAssetV1;
  memory: FrozenLegacyAssetV1;
}>;

export type FrozenLegacyMultiAssetsV1 = Readonly<{
  responder: FrozenLegacyAgentAssetsV1;
  requester:
    | Readonly<{ kind: 'scripted'; script: FrozenLegacyAssetV1 }>
    | Readonly<{
        kind: 'model';
        agent: FrozenLegacyAgentAssetsV1;
      }>;
}>;

export async function freezeLegacyAssetV1(
  rootDirectory: string,
  relativePath: string,
  kind: LegacyAssetKindV1,
  hooks: FreezeLegacyAssetHooksV1 = {},
): Promise<FrozenLegacyAssetV1> {
  const safePath = safeRelativePathSchema.parse(relativePath);
  const rootStats = await lstat(rootDirectory).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Legacy asset root must be a real directory, not a symbolic link');
  }
  const root = await realpath(rootDirectory);
  const absolutePath = path.resolve(root, safePath);
  if (!isInsideRoot(root, absolutePath)) {
    throw new Error('Legacy asset path must be relative and cannot escape its root');
  }
  await rejectSymbolicComponents(root, safePath);

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    validateRegularAsset(before);
    if (before.size > MAX_LEGACY_ASSET_BYTES_V1) {
      throw new Error(`Legacy asset size exceeds ${MAX_LEGACY_ASSET_BYTES_V1} bytes`);
    }
    const raw = await handle.readFile();
    if (raw.byteLength > MAX_LEGACY_ASSET_BYTES_V1) {
      throw new Error(`Legacy asset size exceeds ${MAX_LEGACY_ASSET_BYTES_V1} bytes`);
    }
    await hooks.afterRead?.(absolutePath);
    const after = await handle.stat();
    if (!sameFileVersion(before, after) || after.size !== raw.byteLength) {
      throw new Error('Legacy asset changed while being read');
    }

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new Error('Legacy asset must contain valid UTF-8');
    }
    if (!content.trim()) throw new Error('Legacy asset must not be empty');
    const provenance = Object.freeze({
      kind,
      path: safePath.split(path.sep).join('/'),
      rawSha256: createHash('sha256').update(raw).digest('hex'),
      bytes: raw.byteLength,
      status: 'legacy' as const,
    });
    return Object.freeze({
      bytes: Uint8Array.from(raw),
      content,
      provenance,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function freezeLegacyMultiAssetsV1(
  rootDirectory: string,
  config: Pick<LegacyMultiConfigV1, 'benchmark'>,
): Promise<FrozenLegacyMultiAssetsV1> {
  const responder = await freezeAgent(rootDirectory, config.benchmark.agentConfig);
  const requesterConfig = config.benchmark.trajectory.requesterDriver;
  const requester = requesterConfig.kind === 'scripted'
    ? Object.freeze({
        kind: 'scripted' as const,
        script: await freezeLegacyAssetV1(
          rootDirectory,
          requesterConfig.script,
          'script',
        ),
      })
    : Object.freeze({
        kind: 'model' as const,
        agent: await freezeAgent(rootDirectory, requesterConfig.agentConfig),
      });
  return Object.freeze({ responder, requester });
}

async function freezeAgent(
  rootDirectory: string,
  config: LegacyAgentConfigV1,
): Promise<FrozenLegacyAgentAssetsV1> {
  const [coo, policy, memory] = await Promise.all([
    freezeLegacyAssetV1(rootDirectory, config.coo, 'coo'),
    freezeLegacyAssetV1(rootDirectory, config.policy, 'policy'),
    freezeLegacyAssetV1(rootDirectory, config.memory, 'memory'),
  ]);
  return Object.freeze({ persona: config.persona, coo, policy, memory });
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function rejectSymbolicComponents(root: string, safePath: string): Promise<void> {
  let current = root;
  for (const component of safePath.split('/')) {
    current = path.join(current, component);
    const stats = await lstat(current).catch(() => undefined);
    if (!stats) throw new Error(`Legacy asset is missing: ${safePath}`);
    if (stats.isSymbolicLink()) {
      throw new Error(`Legacy asset path contains a symbolic link: ${safePath}`);
    }
  }
}

function validateRegularAsset(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Legacy asset must be a regular file');
  }
}

function sameFileVersion(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}
