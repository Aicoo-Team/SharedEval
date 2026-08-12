/**
 * Runtime loader for the verified SharedOS build.
 *
 * SharedOS is still private and unpublished, so PACT cannot consume
 * `@sharedos/*` from npm yet. The interim loader accepts either a clean source
 * checkout at the exact verified revision or the provenance-bearing bundle
 * staged into the Harbor image. Both paths must match the same digest over the
 * loader-critical package manifests and executable `dist` JavaScript.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SharedOsModulesV1 } from './embedded-types.js';

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
);

export const SHAREDOS_RUNTIME_PACKAGES_V1 = [
  'contracts',
  'core',
  'os',
  'runtime',
  'testkit',
] as const;
const IMPORTED_PACKAGES = ['core', 'runtime', 'os', 'testkit'] as const;

export const SHAREDOS_VERIFIED_REVISION_V1 =
  '373b6347559e39e00b2a4f6bc934373833b40266' as const;
export const SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 =
  'c272f97ebd2052074d325d271678ef2fa15935104f2c096c1b52dee0cae70984' as const;
export const SHAREDOS_PROVENANCE_FILE_V1 = 'sharedos-provenance.json' as const;

export function defaultSharedOsDirV1(): string {
  if (process.env.PACT_SHAREDOS_DIR) return resolve(process.env.PACT_SHAREDOS_DIR);
  const candidates = [
    resolve(repositoryRoot, '..', 'SharedOS'),
    resolve(repositoryRoot, '..', 'sharedos-repo'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

export type SharedOsBuildVerificationV1 =
  | { ok: true; revision: string; runtimeDigest: string; source: 'git' | 'provenance' }
  | { ok: false; reason: string };

export type VerifySharedOsBuildOptionsV1 = {
  expectedRevision?: string;
  expectedRuntimeDigest?: string;
};

/** Verify executable identity before importing any SharedOS code. */
export function verifySharedOsBuildV1(
  dir: string,
  options: VerifySharedOsBuildOptionsV1 = {},
): SharedOsBuildVerificationV1 {
  const expectedRevision =
    options.expectedRevision ?? SHAREDOS_VERIFIED_REVISION_V1;
  const expectedRuntimeDigest =
    options.expectedRuntimeDigest ?? SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1;

  const revision = readSharedOsRevision(dir);
  const provenance = revision === undefined ? readSharedOsProvenance(dir) : undefined;
  const actualRevision = revision ?? provenance?.commit;
  if (actualRevision !== expectedRevision) {
    return {
      ok: false,
      reason:
        `SharedOS revision mismatch: expected ${expectedRevision}, `
        + `found ${actualRevision ?? 'no Git revision or staged provenance'}.`,
    };
  }
  if (revision !== undefined && !sharedOsCheckoutIsClean(dir)) {
    return {
      ok: false,
      reason: 'SharedOS checkout has tracked local changes; refusing an unverified runtime.',
    };
  }

  const missing = SHAREDOS_RUNTIME_PACKAGES_V1.flatMap(name => {
    const packageDirectory = join(dir, 'packages', name);
    return [
      join(packageDirectory, 'package.json'),
      join(packageDirectory, 'dist', 'index.js'),
    ].filter(entry => !existsSync(entry));
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `SharedOS build not found (missing ${missing[0]}). Clone `
        + 'Aicoo-Team/SharedOS and run "pnpm install --frozen-lockfile && '
        + 'pnpm build", or point PACT_SHAREDOS_DIR at that checkout.',
    };
  }

  const runtimeDigest = digestSharedOsRuntimeV1(dir);
  if (runtimeDigest !== expectedRuntimeDigest) {
    return {
      ok: false,
      reason:
        `SharedOS runtime digest mismatch: expected ${expectedRuntimeDigest}, `
        + `found ${runtimeDigest ?? 'no complete runtime bundle'}. `
        + 'Run "pnpm clean && pnpm build" from the verified revision.',
    };
  }
  if (
    provenance !== undefined
    && provenance.runtimeDigest !== runtimeDigest
  ) {
    return {
      ok: false,
      reason:
        `SharedOS staged provenance digest ${provenance.runtimeDigest ?? 'is missing'} `
        + `but the runtime bundle digest is ${runtimeDigest}.`,
    };
  }

  return {
    ok: true,
    revision: actualRevision,
    runtimeDigest,
    source: revision === undefined ? 'provenance' : 'git',
  };
}

export type LoadSharedOsResultV1 =
  | {
      ok: true;
      dir: string;
      revision: string;
      runtimeDigest: string;
      modules: SharedOsModulesV1;
    }
  | { ok: false; dir: string; reason: string };

export async function loadSharedOsModulesV1(
  dir: string = defaultSharedOsDirV1(),
): Promise<LoadSharedOsResultV1> {
  const verification = verifySharedOsBuildV1(dir);
  if (!verification.ok) return { ok: false, dir, reason: verification.reason };

  const entryPoints = IMPORTED_PACKAGES.map(name =>
    join(dir, 'packages', name, 'dist', 'index.js'),
  );
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
        'SharedOS runtime could not be loaded. Run "pnpm install --frozen-lockfile" '
        + `in the checkout (${error instanceof Error ? error.message : 'unknown error'}).`,
    };
  }
  const [core, runtime, os, testkit] = loaded;
  return {
    ok: true,
    dir,
    revision: verification.revision,
    runtimeDigest: verification.runtimeDigest,
    modules: { core, runtime, os, testkit } as SharedOsModulesV1,
  };
}

/**
 * Canonical digest shared by local loading and Harbor staging.
 *
 * Test bundles are excluded because package publication and Harbor staging
 * intentionally omit them. Paths are normalized to the staged bundle layout,
 * so the same bytes produce the same digest before and after staging.
 */
export function digestSharedOsRuntimeV1(dir: string): string | undefined {
  try {
    const files = SHAREDOS_RUNTIME_PACKAGES_V1.flatMap(packageName => {
      const packageDirectory = join(dir, 'packages', packageName);
      const dist = join(packageDirectory, 'dist');
      const executable = readdirSync(dist, { recursive: true })
        .filter(
          (entry): entry is string =>
            typeof entry === 'string'
            && /\.(?:c|m)?js$/.test(entry)
            && !entry.endsWith('.test.js'),
        )
        .map(entry => join(dist, entry))
        .filter(file => statSync(file).isFile());
      return [
        { key: `packages/${packageName}/package.json`, file: join(packageDirectory, 'package.json') },
        ...executable.map(file => ({
          key: `packages/${packageName}/dist/${relative(dist, file).split(sep).join('/')}`,
          file,
        })),
      ];
    });
    const zodDirectory = resolveStagedDependencyDir(dir, 'zod');
    // SharedOS imports the default Zod ESM entry, which re-exports v3. Hash
    // exactly that executable closure plus the package manifest. Excluding v4,
    // CJS, declarations, and cloud-sync duplicates keeps clean installs and
    // staged bundles byte-identical without weakening loaded-code coverage.
    const zodRelativeFiles = [
      'package.json',
      'index.js',
      ...readdirSync(join(zodDirectory, 'v3'), { recursive: true })
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.endsWith('.js'),
        )
        .map(entry => `v3/${entry}`),
    ];
    const zodFiles = zodRelativeFiles
      .map(entry => ({
        key: `node_modules/zod/${entry.split(sep).join('/')}`,
        file: join(zodDirectory, entry),
      }))
      .filter(entry => statSync(entry.file).isFile());
    const entries = [...files, ...zodFiles]
      .sort((left, right) => left.key.localeCompare(right.key));
    if (entries.length === 0) return undefined;
    const hash = createHash('sha256');
    for (const entry of entries) {
      hash.update(entry.key);
      hash.update('\0');
      hash.update(readFileSync(entry.file));
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function resolveStagedDependencyDir(dir: string, name: string): string {
  const candidates = [
    join(dir, 'node_modules', name),
    join(dir, 'packages', 'contracts', 'node_modules', name),
    join(dir, 'packages', 'os', 'node_modules', name),
  ];
  const found = candidates.find(candidate => existsSync(join(candidate, 'package.json')));
  if (!found) throw new Error(`SharedOS dependency ${name} is not installed`);
  return found;
}

function readSharedOsRevision(dir: string): string | undefined {
  // Do not let Git walk upward and mistake a parent repository (for example,
  // PACT around harbor/environment/sharedos-stage) for the SharedOS checkout.
  if (!existsSync(join(dir, '.git'))) return undefined;
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

function readSharedOsProvenance(dir: string): {
  commit?: string;
  runtimeDigest?: string;
} | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, SHAREDOS_PROVENANCE_FILE_V1), 'utf8'),
    ) as Record<string, unknown>;
    return {
      ...(typeof parsed.commit === 'string' ? { commit: parsed.commit } : {}),
      ...(typeof parsed.runtimeDigest === 'string'
        ? { runtimeDigest: parsed.runtimeDigest }
        : {}),
    };
  } catch {
    return undefined;
  }
}
