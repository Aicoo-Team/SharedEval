import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  SHAREDOS_PROVENANCE_FILE_V1,
  SHAREDOS_RUNTIME_PACKAGES_V1,
  SHAREDOS_VERIFIED_REVISION_V1,
  SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
  verifySharedOsBuildV1,
} from '../../../execution/sharedos/v1/load-sharedos.js';

/**
 * Host-side staging of a locally BUILT SharedOS checkout into the Harbor
 * Docker build context.
 *
 * O-003 packaging decision: the Harbor image carries the SharedOS build
 * artifacts (the per-package `dist` outputs) via a plain Dockerfile COPY. The
 * container
 * never clones or builds SharedOS — doing either would require network access
 * and break the no-network principle the task packages are built on. The
 * loader contract is src/execution/sharedos/v1/load-sharedos.ts: it imports
 * `packages/<name>/dist/index.js` for core/runtime/os/testkit from
 * `PACT_SHAREDOS_DIR`, and those modules resolve `@sharedos/*` and `zod` as
 * bare specifiers, so the stage also materializes the workspace links and the
 * checkout's own zod copy.
 */

/**
 * The only SharedOS revision the embedded adapter is verified against (see
 * src/execution/sharedos/v1/contracts.ts and SHAREDOS_PIN in
 * .github/workflows/ci.yml). Staging fails closed when the local checkout is
 * at any other commit: image provenance must be truthful, never aspirational.
 */
export const PACT_SHAREDOS_COMMIT_V1 =
  SHAREDOS_VERIFIED_REVISION_V1;

export const PACT_SHAREDOS_RUNTIME_DIGEST_V1 =
  SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1;

export const PACT_SHAREDOS_REPOSITORY_V1 = 'Aicoo-Team/SharedOS' as const;

/**
 * Packages the runtime loader depends on (core/runtime/os/testkit are
 * imported directly; contracts is their shared dependency). Staging requires
 * a built dist for each of these and fails otherwise. Only this verified
 * runtime closure is staged; unrelated workspace packages cannot silently
 * expand the executable bundle.
 */
export const PACT_SHAREDOS_LOADER_PACKAGES_V1 = SHAREDOS_RUNTIME_PACKAGES_V1;

/** Where the staged checkout lands inside the image (PACT_SHAREDOS_DIR). */
export const PACT_CONTAINER_SHAREDOS_DIR_V1 = '/opt/pact/sharedos' as const;

export const PACT_SHAREDOS_PROVENANCE_FILE_V1 = SHAREDOS_PROVENANCE_FILE_V1;

/**
 * Host-side SharedOS checkout resolution: `PACT_SHAREDOS_DIR` wins, otherwise
 * prefer a `SharedOS` sibling and fall back to CI's `sharedos-repo` sibling —
 * the exact convention of src/execution/sharedos/v1/load-sharedos.ts.
 */
export function defaultHostSharedOsDirV1(
  repositoryRoot: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment.PACT_SHAREDOS_DIR?.trim();
  if (configured) return resolve(configured);
  const candidates = [
    resolve(repositoryRoot, '..', 'SharedOS'),
    resolve(repositoryRoot, '..', 'sharedos-repo'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

/** The staging directory inside the Docker build context (gitignored). */
export function pactHarborSharedOsStageDirV1(repositoryRoot: string): string {
  return join(repositoryRoot, 'harbor', 'environment', 'sharedos-stage');
}

/**
 * Resolves the commit of a SharedOS checkout by reading its git metadata
 * directly (HEAD, loose ref, packed-refs, and linked-worktree `gitdir`
 * pointers). Returns null when the commit cannot be determined.
 */
export async function resolveSharedOsCommitV1(
  sharedOsDir: string,
): Promise<string | null> {
  try {
    let gitDir = join(sharedOsDir, '.git');
    const gitStat = await stat(gitDir).catch(() => null);
    if (!gitStat) return null;
    if (gitStat.isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(gitDir, 'utf8'));
      if (!pointer?.[1]) return null;
      gitDir = resolve(sharedOsDir, pointer[1].trim());
    }
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref || ref.includes('..')) return null;
    for (const candidateDir of [gitDir, join(gitDir, '..', '..')]) {
      const loose = await readFile(join(candidateDir, ...ref.split('/')), 'utf8')
        .catch(() => null);
      const commit = loose?.trim();
      if (commit && /^[0-9a-f]{40}$/.test(commit)) return commit;
      const packed = await readFile(join(candidateDir, 'packed-refs'), 'utf8')
        .catch(() => null);
      if (!packed) continue;
      for (const line of packed.split('\n')) {
        const match = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
        if (match && match[2] === ref) return match[1] ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type StageSharedOsBuildV1Options = {
  /** A locally built SharedOS checkout (see defaultHostSharedOsDirV1). */
  sharedOsDir: string;
  /** Destination inside the Docker build context; recreated on every call. */
  stageDirectory: string;
  /** Commit the checkout must be at. Defaults to the verified pin. */
  expectedCommit?: string;
  /** Runtime digest the checkout must match. Defaults to the verified digest. */
  expectedRuntimeDigest?: string;
};

export type StagedSharedOsBuildV1 = {
  commit: string;
  runtimeDigest: string;
  packages: string[];
  stageDirectory: string;
};

export type SharedOsProvenanceV1 = {
  repository: string;
  commit: string;
  runtimeDigest: string;
  packages: string[];
  containerDir: string;
};

/**
 * Stages the loader-critical `dist` outputs (+ package.json manifests) of a
 * built SharedOS checkout into the Docker build context, so the Dockerfile can
 * COPY them and point `PACT_SHAREDOS_DIR` at the result.
 *
 * Layout of the stage (mirrors what load-sharedos.ts expects):
 *
 *   packages/<name>/package.json
 *   packages/<name>/dist/**            (build outputs, tests excluded)
 *   node_modules/@sharedos/<name>  ->  ../../packages/<name>   (relative link,
 *       so `@sharedos/*` bare imports and the loader's direct dist imports
 *       resolve to the same realpath — one module instance per package)
 *   node_modules/zod                   (the checkout's own resolved copy)
 *   sharedos-provenance.json           (repository + pinned commit/digest provenance)
 *
 * Fails closed when a loader-critical dist is missing, the checkout is dirty,
 * or its commit/runtime digest drifts; it never falls back to cloning or
 * building.
 */
export async function stageSharedOsBuildV1(
  options: StageSharedOsBuildV1Options,
): Promise<StagedSharedOsBuildV1> {
  const expectedCommit = options.expectedCommit ?? PACT_SHAREDOS_COMMIT_V1;
  const expectedRuntimeDigest =
    options.expectedRuntimeDigest ?? PACT_SHAREDOS_RUNTIME_DIGEST_V1;
  const packagesDirectory = join(options.sharedOsDir, 'packages');

  let entries;
  try {
    entries = await readdir(packagesDirectory, { withFileTypes: true });
  } catch {
    throw new Error(
      `SharedOS checkout not found at ${options.sharedOsDir} (no packages/ `
      + 'directory). Clone Aicoo-Team/SharedOS beside this repository and run '
      + '"pnpm install --frozen-lockfile && pnpm build" there, or point '
      + 'PACT_SHAREDOS_DIR at a built checkout.',
    );
  }
  const builtPackages = entries
    .filter(entry => entry.isDirectory()
      && existsSync(join(packagesDirectory, entry.name, 'package.json'))
      && existsSync(join(packagesDirectory, entry.name, 'dist', 'index.js')))
    .map(entry => entry.name)
    .sort();
  const missing = PACT_SHAREDOS_LOADER_PACKAGES_V1
    .filter(name => !builtPackages.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `SharedOS build artifacts are missing for ${missing.join(', ')} under `
      + `${packagesDirectory}. Run "pnpm install --frozen-lockfile && pnpm build" `
      + 'in the SharedOS checkout; the Harbor image only ever COPYs prebuilt '
      + 'dist output and never builds SharedOS in-container.',
    );
  }
  const runtimePackages = [...PACT_SHAREDOS_LOADER_PACKAGES_V1];

  const commit = await resolveSharedOsCommitV1(options.sharedOsDir);
  if (!commit) {
    throw new Error(
      `Unable to resolve the SharedOS commit from ${options.sharedOsDir}. `
      + `Image provenance requires a git checkout pinned to ${expectedCommit}.`,
    );
  }
  if (commit !== expectedCommit) {
    throw new Error(
      `SharedOS checkout at ${options.sharedOsDir} is at commit ${commit}, but `
      + `the embedded adapter and Harbor image are verified against `
      + `${expectedCommit}. Check out the pinned commit (or update the pin `
      + 'deliberately, together with the adapter conformance suite).',
    );
  }

  const verification = verifySharedOsBuildV1(options.sharedOsDir, {
    expectedRevision: expectedCommit,
    expectedRuntimeDigest,
  });
  if (!verification.ok) {
    throw new Error(verification.reason);
  }

  const zodSource = ['contracts', 'os']
    .map(name => join(packagesDirectory, name, 'node_modules', 'zod'))
    .find(candidate => existsSync(join(candidate, 'package.json')));
  if (!zodSource) {
    throw new Error(
      `SharedOS dependency install is incomplete under ${packagesDirectory} `
      + '(no resolved zod package). Run "pnpm install --frozen-lockfile" in '
      + 'the checkout before staging.',
    );
  }

  await rm(options.stageDirectory, { recursive: true, force: true });
  const scopedLinkDirectory = join(options.stageDirectory, 'node_modules', '@sharedos');
  await mkdir(scopedLinkDirectory, { recursive: true });
  for (const name of runtimePackages) {
    const source = join(packagesDirectory, name);
    const target = join(options.stageDirectory, 'packages', name);
    await mkdir(target, { recursive: true });
    await cp(join(source, 'package.json'), join(target, 'package.json'));
    await cp(join(source, 'dist'), join(target, 'dist'), {
      recursive: true,
      dereference: true,
      filter: entry => !isExcludedDistEntryV1(entry),
    });
    // Relative link inside the staged tree: Docker COPY preserves it, and
    // Node resolves both the link and the loader's direct dist import to the
    // same realpath, so each package loads exactly once.
    await symlink(`../../packages/${name}`, join(scopedLinkDirectory, name), 'dir');
  }
  await cp(zodSource, join(options.stageDirectory, 'node_modules', 'zod'), {
    recursive: true,
    dereference: true,
  });

  const provenance: SharedOsProvenanceV1 = {
    repository: PACT_SHAREDOS_REPOSITORY_V1,
    commit,
    runtimeDigest: verification.runtimeDigest,
    packages: runtimePackages,
    containerDir: PACT_CONTAINER_SHAREDOS_DIR_V1,
  };
  await writeFile(
    join(options.stageDirectory, PACT_SHAREDOS_PROVENANCE_FILE_V1),
    `${JSON.stringify(provenance, null, 2)}\n`,
    'utf8',
  );
  const stagedVerification = verifySharedOsBuildV1(options.stageDirectory, {
    expectedRevision: commit,
    expectedRuntimeDigest: verification.runtimeDigest,
  });
  if (!stagedVerification.ok) {
    throw new Error(`Staged SharedOS verification failed: ${stagedVerification.reason}`);
  }
  return {
    commit,
    runtimeDigest: stagedVerification.runtimeDigest,
    packages: runtimePackages,
    stageDirectory: options.stageDirectory,
  };
}

function isExcludedDistEntryV1(entryPath: string): boolean {
  const name = basename(entryPath);
  // Mirrors the packages' own publish contract ("files" globs): build info
  // and test bundles (which import vitest) never ship.
  return /\.test\./.test(name) || name === '.tsbuildinfo';
}
