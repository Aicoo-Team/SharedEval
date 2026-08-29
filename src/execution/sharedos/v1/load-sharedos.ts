/**
 * Runtime loader for the verified SharedOS build.
 *
 * SharedOS is loaded from a verified local build rather than linked as a
 * compile-time dependency. The loader accepts either a clean source
 * checkout at the exact verified revision or a provenance-bearing packaged
 * runtime. Both paths must match the same digest over the loader-critical
 * package manifests and executable `dist` JavaScript.
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
import type { SharedOsModulesV1 } from './contracts.js';

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
);

export const SHAREDOS_RUNTIME_PACKAGES_V1 = [
  'contracts',
  'core',
  'os',
  'runtime',
] as const;
const IMPORTED_PACKAGES = SHAREDOS_RUNTIME_PACKAGES_V1;

export const SHAREDOS_VERIFIED_REVISION_V1 =
  '3aa07e33999b656a10ace294fd4e41df8cbc318e' as const;
export const SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 =
  '4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d' as const;
export const SHAREDOS_PROVENANCE_FILE_V1 = 'sharedos-provenance.json' as const;
export const SHAREDEVAL_SHAREDOS_DIR_ENV_V1 = 'SHAREDEVAL_SHAREDOS_DIR' as const;
export const SHAREDEVAL_REQUIRE_SHAREDOS_ENV_V1 = 'SHAREDEVAL_REQUIRE_SHAREDOS' as const;

export function defaultSharedOsDirV1(
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment[SHAREDEVAL_SHAREDOS_DIR_ENV_V1];
  if (configured) return resolve(configured);
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
        + `found ${actualRevision ?? 'no Git revision or packaged provenance'}.`,
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
        + 'pnpm build", or point SHAREDEVAL_SHAREDOS_DIR at that checkout.',
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
        `SharedOS packaged provenance digest ${provenance.runtimeDigest ?? 'is missing'} `
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
  const [contracts, core, os, runtime] = loaded;
  let modules: SharedOsModulesV1;
  try {
    modules = parseSharedOsModulesV1({ contracts, core, os, runtime });
  } catch (error) {
    return {
      ok: false,
      dir,
      reason:
        'SharedOS runtime exports do not match the pinned production boundary '
        + `(${error instanceof Error ? error.message : 'invalid module shape'}).`,
    };
  }
  return {
    ok: true,
    dir,
    revision: verification.revision,
    runtimeDigest: verification.runtimeDigest,
    modules,
  };
}

const REQUIRED_MODULE_EXPORTS_V1 = {
  contracts: [
    'AccessContextSchema',
    'CapabilityGrantSchema',
    'ExecutionRequestSchema',
    'ExecutionResultSchema',
    'MessageDeliveryResultSchema',
    'MessageEnvelopeSchema',
    'ResourceOperationSchema',
    'ResourceResultSchema',
    'ToolCallSchema',
    'ToolDefinitionSchema',
    'ToolResultSchema',
  ],
  core: [
    'SharedOSKernel',
    'CapabilityAuthorizer',
    'RecipientScopedMessageCapabilityResolver',
    'agentExecutionCapability',
    'messageSendCapability',
    'MESSAGE_REQUEST_TOOL_DEFINITION',
  ],
  os: ['createFileTools'],
  runtime: ['StandardRuntime', 'SharedOSExecutor'],
} as const;

/** Fail before a model call when the dynamically loaded API has drifted. */
export function parseSharedOsModulesV1(value: unknown): SharedOsModulesV1 {
  if (!isRecord(value)) throw new Error('SharedOS modules must be an object');
  const allowedModules = Object.keys(REQUIRED_MODULE_EXPORTS_V1);
  for (const moduleName of Object.keys(value)) {
    if (!allowedModules.includes(moduleName)) {
      throw new Error(`unexpected SharedOS module ${moduleName}`);
    }
  }
  for (const moduleName of allowedModules) {
    if (!isRecord(value[moduleName])) {
      throw new Error(`SharedOS ${moduleName} module is missing`);
    }
  }

  for (const [moduleName, exportNames] of Object.entries(REQUIRED_MODULE_EXPORTS_V1)) {
    const module = value[moduleName] as Record<string, unknown>;
    for (const exportName of exportNames) {
      const exported = module[exportName];
      const expectedSchema = moduleName === 'contracts' && exportName.endsWith('Schema');
      const expectedDefinition = exportName === 'MESSAGE_REQUEST_TOOL_DEFINITION';
      const valid = expectedSchema
        ? isRecord(exported) && typeof exported.parse === 'function'
        : expectedDefinition
          ? isRecord(exported) && exported.name === 'messages.request'
          : typeof exported === 'function';
      if (!valid) {
        throw new Error(`SharedOS ${moduleName} module is missing ${exportName}`);
      }
    }
  }
  return value as unknown as SharedOsModulesV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical digest shared by local loading and packaged runtimes.
 *
 * Test bundles are excluded because production packages intentionally omit
 * them. Paths are normalized to the packaged layout, so the same bytes produce
 * the same digest before and after packaging.
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
    const zodDirectory = resolveRuntimeDependencyDir(dir, 'zod');
    // SharedOS imports the default Zod ESM entry, which re-exports v3. Hash
    // exactly that executable closure plus the package manifest. Excluding v4,
    // CJS, declarations, and cloud-sync duplicates keeps clean installs and
    // packaged runtimes byte-identical without weakening loaded-code coverage.
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

function resolveRuntimeDependencyDir(dir: string, name: string): string {
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
  // Do not let Git walk upward and mistake a parent repository for the
  // SharedOS checkout.
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
