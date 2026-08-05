/**
 * Runtime loader for a locally built SharedOS checkout.
 *
 * The `@sharedos/*` packages are private and unpublished, so they cannot
 * be package.json dependencies yet (that packaging decision belongs to
 * the lead). Until then the embedded adapter loads the built workspace
 * from `PACT_SHAREDOS_DIR` (default: a `sharedos-repo` checkout beside
 * this repository). Callers must handle the unavailable case explicitly —
 * integration tests skip with the returned reason, never silently.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SharedOsModulesV1 } from './embedded-types.js';

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
);

const PACKAGES = ['core', 'runtime', 'os', 'testkit'] as const;

export function defaultSharedOsDirV1(): string {
  return process.env.PACT_SHAREDOS_DIR ?? resolve(repositoryRoot, '..', 'sharedos-repo');
}

export type LoadSharedOsResultV1 =
  | { ok: true; dir: string; modules: SharedOsModulesV1 }
  | { ok: false; dir: string; reason: string };

export async function loadSharedOsModulesV1(
  dir: string = defaultSharedOsDirV1(),
): Promise<LoadSharedOsResultV1> {
  const entryPoints = PACKAGES.map(name =>
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
        + 'pnpm build" there, or point PACT_SHAREDOS_DIR at a built checkout.',
    };
  }
  const [core, runtime, os, testkit] = await Promise.all(
    entryPoints.map(entry => import(pathToFileURL(entry).href)),
  );
  return {
    ok: true,
    dir,
    modules: { core, runtime, os, testkit } as SharedOsModulesV1,
  };
}
