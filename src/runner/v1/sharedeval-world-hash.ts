import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256JsonV1, type JsonValue } from '../../contracts/json.js';
import { loadPactPairTasksV1 } from '../../suites/pact-pair/task-loader.js';
import { parseWorkspaceRegistryV1 } from './workspace-registry.js';
import { loadPactPairDatasetAuthorityV1 } from './sharedeval-production.js';
import type { EffectiveSharedevalRunConfigV1 } from './sharedeval-config.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const SHAREDEVAL_WORLD_HASH_SCHEMA_V1 = 'sharedeval-world-hash/v1' as const;

export type SharedevalWorldHashV1 = Readonly<{
  schema: typeof SHAREDEVAL_WORLD_HASH_SCHEMA_V1;
  /** One digest over everything below it. Two runs are comparable when it matches. */
  worldHash: string;
  taskCount: number;
  benchmark: Readonly<{
    dataset: string;
    policy: string;
    requester: string;
    gradingMode: string;
    tasks: JsonValue;
  }>;
  dataset: Readonly<{ id: string; version: string; manifestSha256: string; tasksSha256: string }>;
  goldSet: Readonly<{ id: string; sha256: string }>;
  workspaceRegistrySha256: string;
}>;

export type ComputeSharedevalWorldHashV1Options = Readonly<{
  config: EffectiveSharedevalRunConfigV1;
  repositoryRoot?: string;
}>;

export type SharedevalWorldHashDependenciesV1 = Readonly<{
  loadTasks?: typeof loadPactPairTasksV1;
  loadDatasetAuthority?: typeof loadPactPairDatasetAuthorityV1;
  readRegistry?: (path: string) => string;
}>;

/**
 * Digest the world one Sharedeval configuration declares, without running it.
 *
 * The hash covers the loaded task material (questions, actions, expectations,
 * and gold labels, exactly as the runner would select and compose them for the
 * configured policy, requester, and grading mode), the dataset authority
 * digests the run would record as provenance, and the workspace-asset registry
 * the run would materialise agent workspaces from. It deliberately covers the
 * loader's *output* rather than only its input bytes: two machines whose
 * checkouts match but whose loaders compose different worlds must hash apart.
 *
 * No model, no SharedOS, and no filesystem writes are involved, so the hash
 * can be taken anywhere the repository checks out — which is the point: a
 * matching `worldHash` on two machines is the evidence that the same declared
 * seed reconstructs the same world on both.
 */
export function computeSharedevalWorldHashV1(
  options: ComputeSharedevalWorldHashV1Options,
  dependencies: SharedevalWorldHashDependenciesV1 = {},
): SharedevalWorldHashV1 {
  const sourceRoot = resolve(options.repositoryRoot ?? repositoryRoot);
  const benchmark = options.config.benchmark;

  const datasetAuthority = (dependencies.loadDatasetAuthority ?? loadPactPairDatasetAuthorityV1)({
    repositoryRoot: sourceRoot,
    gradingMode: benchmark.gradingMode,
  });

  const tasks = (dependencies.loadTasks ?? loadPactPairTasksV1)({
    rootDir: sourceRoot,
    policy: benchmark.policy,
    requester: benchmark.requester,
    gradingMode: benchmark.gradingMode,
    kind: benchmark.tasks.kind,
    ...(benchmark.tasks.ids ? { ids: [...benchmark.tasks.ids] } : {}),
    ...(benchmark.tasks.limit === undefined ? {} : { limit: benchmark.tasks.limit }),
  });
  if (tasks.length === 0) throw new Error('Sharedeval task selection is empty');

  const registryPath = join(
    sourceRoot,
    'dataset',
    'shared-eval',
    'workspaces',
    'v1',
    'registry.json',
  );
  const registrySource = (dependencies.readRegistry
    ?? ((path: string) => readFileSync(path, 'utf8')))(registryPath);
  const registry = parseWorkspaceRegistryV1(JSON.parse(registrySource));
  const workspaceRegistrySha256 = sha256JsonV1(registry as unknown as JsonValue);

  const summary = {
    schema: SHAREDEVAL_WORLD_HASH_SCHEMA_V1,
    taskCount: tasks.length,
    benchmark: {
      dataset: benchmark.dataset,
      policy: benchmark.policy,
      requester: benchmark.requester,
      gradingMode: benchmark.gradingMode,
      tasks: benchmark.tasks as unknown as JsonValue,
    },
    dataset: datasetAuthority.dataset,
    goldSet: datasetAuthority.goldSet,
    workspaceRegistrySha256,
  };

  const worldHash = sha256JsonV1({
    ...summary,
    tasks: tasks as unknown as JsonValue,
  } as unknown as JsonValue);

  return Object.freeze({ ...summary, worldHash });
}
