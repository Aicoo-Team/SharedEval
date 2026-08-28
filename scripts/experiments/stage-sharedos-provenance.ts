/**
 * Stamps a staged SharedOS build with sharedos-provenance.json
 * (commit + runtime digest) using the repository's own loader code, then
 * re-verifies the staged directory through the exact verification path the
 * runner will take inside the image. Invoked by
 * scripts/experiments/build-image.sh; fails closed on any mismatch.
 *
 * Usage: npx tsx scripts/experiments/stage-sharedos-provenance.ts <staged-dir>
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SHAREDOS_PROVENANCE_FILE_V1,
  SHAREDOS_VERIFIED_REVISION_V1,
  SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
  digestSharedOsRuntimeV1,
  verifySharedOsBuildV1,
} from '../../src/execution/sharedos/v1/load-sharedos.js';

function fail(message: string): never {
  process.stderr.write(`stage-sharedos-provenance: ${message}\n`);
  process.exit(1);
}

const stagedArgument = process.argv[2];
if (!stagedArgument) fail('usage: stage-sharedos-provenance.ts <staged-dir>');
const staged = resolve(stagedArgument);
if (!existsSync(staged)) fail(`staged directory not found: ${staged}`);
if (existsSync(join(staged, '.git'))) {
  fail('staged SharedOS must not contain .git; the image carries provenance, not history');
}

const runtimeDigest = digestSharedOsRuntimeV1(staged);
if (runtimeDigest === undefined) {
  fail('staged SharedOS has no complete runtime bundle to digest');
}
if (runtimeDigest !== SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1) {
  fail(
    `staged SharedOS runtime digest ${runtimeDigest} does not match the pinned `
    + `${SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1}`,
  );
}

// wx: never overwrite an existing provenance stamp.
writeFileSync(
  join(staged, SHAREDOS_PROVENANCE_FILE_V1),
  `${JSON.stringify(
    { commit: SHAREDOS_VERIFIED_REVISION_V1, runtimeDigest },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);

const verification = verifySharedOsBuildV1(staged);
if (!verification.ok) fail(`staged SharedOS failed verification: ${verification.reason}`);
if (verification.source !== 'provenance') {
  fail('staged SharedOS unexpectedly verified via git rather than packaged provenance');
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    dir: staged,
    commit: verification.revision,
    runtimeDigest: verification.runtimeDigest,
  })}\n`,
);
