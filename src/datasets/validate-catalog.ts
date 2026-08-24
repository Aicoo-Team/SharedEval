import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseDatasetManifestYamlV1,
  type DatasetManifestV1,
} from './manifest.js';

export const SHARED_EVAL_INFRASTRUCTURE_MARKER_V1 =
  'dataset/shared-eval/workspaces/v1/registry.json' as const;

export function validateDatasetCatalogV1(options: {
  repoRoot: string;
  log?: (message: string) => void;
}): Map<string, DatasetManifestV1> {
  const datasetDirectory = join(options.repoRoot, 'dataset');
  const manifests = new Map<string, DatasetManifestV1>();
  const entries = readdirSync(datasetDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const relativeRoot = `dataset/${entry.name}`;
    const manifestPath = `${relativeRoot}/manifest.yaml`;
    if (!existsSync(join(options.repoRoot, manifestPath))) {
      if (isSharedEvalInfrastructureRegistry(options.repoRoot, entry.name)) {
        continue;
      }
      throw new Error(`Dataset directory ${entry.name} is missing manifest.yaml`);
    }
    const manifest = parseDatasetManifestYamlV1(
      readFileSync(join(options.repoRoot, manifestPath), 'utf8'),
    );
    if (manifest.id !== entry.name) {
      throw new Error(
        `Dataset directory ${entry.name} contains manifest id ${manifest.id}`,
      );
    }
    const identity = `${manifest.id}@${manifest.version}`;
    if (manifests.has(identity)) {
      throw new Error(`Duplicate dataset identity ${identity}`);
    }
    for (const [name, asset] of Object.entries(manifest.assets)) {
      if (!existsSync(join(options.repoRoot, relativeRoot, asset))) {
        throw new Error(`Dataset ${identity} asset ${name} does not exist: ${asset}`);
      }
    }
    manifests.set(identity, manifest);
  }

  const log = options.log ?? console.log;
  log(
    `Dataset catalog validation passed (${manifests.size} manifest${
      manifests.size === 1 ? '' : 's'
    })`,
  );
  return manifests;
}

function isSharedEvalInfrastructureRegistry(
  repoRoot: string,
  directoryName: string,
): boolean {
  if (directoryName !== 'shared-eval') return false;
  const markerPath = join(repoRoot, SHARED_EVAL_INFRASTRUCTURE_MARKER_V1);
  if (!existsSync(markerPath)) return false;
  const marker = lstatSync(markerPath);
  return marker.isFile() && !marker.isSymbolicLink();
}
