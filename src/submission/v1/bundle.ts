import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  parsePactManifestYamlV1,
  MAX_PACT_MANIFEST_BYTES_V1,
  safeRelativePathSchema,
  type PactSubmissionManifestV1,
} from '../../protocol/v1/index.js';

export type ValidatePactSubmissionBundleV1Options = {
  rootDir: string;
  manifestPath: string;
  runtimePolicy?: 'development' | 'official';
};

export type ValidatedPactSubmissionRuntimeV1 =
  | { kind: 'local-ts'; entrypointPath: string }
  | { kind: 'docker'; contextPath: string; dockerfilePath: string };

export type ValidatedPactSubmissionBundleV1 = {
  rootDir: string;
  manifestPath: string;
  manifest: PactSubmissionManifestV1;
  runtime: ValidatedPactSubmissionRuntimeV1;
};

export async function validatePactSubmissionBundleV1(
  options: ValidatePactSubmissionBundleV1Options,
): Promise<ValidatedPactSubmissionBundleV1> {
  const rootDir = await realpath(resolve(options.rootDir));
  const manifestRelativePath = safeRelativePathSchema.parse(options.manifestPath);
  const manifestPath = await requireFileWithin(rootDir, manifestRelativePath, 'manifest');
  const manifest = parsePactManifestYamlV1(await readBoundedManifest(manifestPath));

  let runtime: ValidatedPactSubmissionRuntimeV1;
  if (manifest.runtime.kind === 'local-ts') {
    if (options.runtimePolicy === 'official') {
      throw new Error('official submissions must use the isolated Docker runtime');
    }
    runtime = {
      kind: 'local-ts',
      entrypointPath: await requireFileWithin(
        rootDir,
        manifest.runtime.entrypoint,
        'local TypeScript entrypoint',
      ),
    };
  } else {
    const contextPath = await requireDirectoryWithin(
      rootDir,
      manifest.runtime.source.context,
      'Docker build context',
    );
    const dockerfilePath = await requireFileWithin(
      rootDir,
      manifest.runtime.source.dockerfile,
      'Dockerfile',
    );
    assertContained(contextPath, dockerfilePath, 'Dockerfile must be inside the build context');
    runtime = { kind: 'docker', contextPath, dockerfilePath };
  }

  return {
    rootDir,
    manifestPath,
    manifest,
    runtime,
  };
}

async function readBoundedManifest(path: string): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('manifest must be a regular file');
    }
    if (stats.size > MAX_PACT_MANIFEST_BYTES_V1) {
      throw new Error(`PACT manifest exceeds ${MAX_PACT_MANIFEST_BYTES_V1} bytes`);
    }
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function requireFileWithin(rootDir: string, path: string, label: string): Promise<string> {
  const resolved = await resolveWithin(rootDir, path, label);
  const stats = await lstat(resolved);
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return resolved;
}

async function requireDirectoryWithin(rootDir: string, path: string, label: string): Promise<string> {
  const resolved = await resolveWithin(rootDir, path, label);
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
  return resolved;
}

async function resolveWithin(rootDir: string, path: string, label: string): Promise<string> {
  const safePath = safeRelativePathSchema.parse(path);
  const lexicalPath = resolve(rootDir, safePath);
  assertContained(rootDir, lexicalPath, `${label} escapes the submission root`);

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(lexicalPath);
  } catch {
    throw new Error(`${label} does not exist: ${safePath}`);
  }
  assertContained(rootDir, resolvedPath, `${label} resolves outside the submission root`);
  return resolvedPath;
}

function assertContained(rootDir: string, candidate: string, message: string): void {
  const relativePath = relative(rootDir, candidate);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(message);
  }
}
