/**
 * Runtime loader for a pinned, locally built SharedOS checkout.
 *
 * The `@sharedos/*` packages are private and unpublished, so they cannot be
 * package.json dependencies yet. Until packaging is decided, the adapter
 * loads a sibling build only after checking the exact Git revision, clean
 * tracked source, and a digest over every executable dist JavaScript file.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SharedOsModulesV1 } from './embedded-types.js';

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
);

const RUNTIME_PACKAGES = ['core', 'runtime', 'os', 'testkit'] as const;
const DIGEST_PACKAGES = ['contracts', ...RUNTIME_PACKAGES] as const;
export const SHAREDOS_VERIFIED_REVISION_V1 =
  '373b6347559e39e00b2a4f6bc934373833b40266' as const;
export const SHAREDOS_VERIFIED_DIST_DIGEST_V1 =
  '10cc06d6ba787fc61de43546470ac0622357b4768d38f8bf5083184f600fa5fb' as const;

export function defaultSharedOsDirV1(): string {
  if (process.env.PACT_SHAREDOS_DIR) return process.env.PACT_SHAREDOS_DIR;
  const candidates = [
    resolve(repositoryRoot, '..', 'SharedOS'),
    resolve(repositoryRoot, '..', 'sharedos-repo'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

export type LoadSharedOsResultV1 =
  | {
      ok: true;
      dir: string;
      revision: typeof SHAREDOS_VERIFIED_REVISION_V1;
      modules: SharedOsModulesV1;
    }
  | { ok: false; dir: string; reason: string };

export async function loadSharedOsModulesV1(
  dir: string = defaultSharedOsDirV1(),
): Promise<LoadSharedOsResultV1> {
  const revision = readSharedOsRevision(dir);
  if (revision !== SHAREDOS_VERIFIED_REVISION_V1) {
    return {
      ok: false,
      dir,
      reason:
        `SharedOS revision mismatch: expected ${SHAREDOS_VERIFIED_REVISION_V1}, `
        + `found ${revision ?? 'no Git revision'}.`,
    };
  }
  if (!sharedOsCheckoutIsClean(dir)) {
    return {
      ok: false,
      dir,
      reason: 'SharedOS checkout has tracked local changes; refusing an unverified runtime.',
    };
  }
  const entryPoints = RUNTIME_PACKAGES.map(name =>
    join(dir, 'packages', name, 'dist', 'index.js'),
  );
  const missing = entryPoints.filter(entry => !existsSync(entry));
  if (missing.length > 0) {
    return {
      ok: false,
      dir,
      reason:
        `SharedOS build not found (missing ${missing[0]}). Clone `
        + 'Aicoo-Team/SharedOS and run "pnpm install --frozen-lockfile && '
        + 'pnpm build", or point PACT_SHAREDOS_DIR at that checkout.',
    };
  }
  const distDigest = digestSharedOsDist(dir);
  if (distDigest !== SHAREDOS_VERIFIED_DIST_DIGEST_V1) {
    return {
      ok: false,
      dir,
      reason:
        `SharedOS build digest mismatch: expected ${SHAREDOS_VERIFIED_DIST_DIGEST_V1}, `
        + `found ${distDigest ?? 'no complete dist tree'}. Run "pnpm clean && pnpm build".`,
    };
  }
  let loaded: unknown[];
  try {
    loaded = await Promise.all(
      entryPoints.map(entry => import(pathToFileURL(entry).href)),
    );
  } catch (error) {
    return {
      ok: false,
      dir,
      reason:
        'SharedOS source could not be loaded. Run "pnpm install --frozen-lockfile" '
        + `in the checkout (${error instanceof Error ? error.message : 'unknown error'}).`,
    };
  }
  const [core, runtime, os, testkit] = loaded;
  return {
    ok: true,
    dir,
    revision: SHAREDOS_VERIFIED_REVISION_V1,
    modules: { core, runtime, os, testkit } as SharedOsModulesV1,
  };
}

function readSharedOsRevision(dir: string): string | undefined {
  try {
    const revision = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function sharedOsCheckoutIsClean(dir: string): boolean {
  try {
    return execFileSync(
      'git',
      ['-C', dir, 'status', '--porcelain', '--untracked-files=no'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().length === 0;
  } catch {
    return false;
  }
}

function digestSharedOsDist(dir: string): string | undefined {
  try {
    const files = DIGEST_PACKAGES.flatMap(packageName => {
      const dist = join(dir, 'packages', packageName, 'dist');
      return readdirSync(dist, { recursive: true })
        .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.js'))
        .map(entry => join(dist, entry));
    }).sort();
    if (files.length === 0) return undefined;
    const hash = createHash('sha256');
    for (const file of files) {
      const normalized = relative(dir, file).split(sep).join('/');
      hash.update(normalized);
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}
