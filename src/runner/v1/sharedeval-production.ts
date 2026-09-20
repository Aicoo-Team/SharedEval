import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDatasetManifestYamlV1 } from '../../datasets/manifest.js';
import {
  defaultSharedOsDirV1,
  loadSharedOsModulesV1,
} from '../../execution/sharedos/v1/load-sharedos.js';
import {
  loadPactPairTasksV1,
  type LoadPactPairTasksV1Options,
  type PactPairPolicyV1,
  PACT_NET_REQUESTERS_V1,
  type PactPairRequesterIdV1,
  type PactRequesterIdV1,
} from '../../suites/pact-pair/task-loader.js';
import { createPactPairWorkspaceV1 } from '../../suites/pact-pair/workspace.js';
import { buildPactNetRunBindingV1 } from './sharedeval-net-binding.js';
import {
  createOpenAICompatibleFileTurnDriverV1,
  createProviderRateLimitGateV1,
  createServedModelConsistencyLedgerV1,
  type OpenAICompatibleFileTurnDriverV1Options,
} from './file-model-driver.js';
import {
  pactModelIdentifierV1,
  resolvePactRunModelApiKeyV1,
} from './model-config.js';
import type { FileWorkflowHostRunProvenanceV1 } from './file-workflow-artifacts.js';
import type { EffectiveSharedevalRunConfigV1 } from './sharedeval-config.js';
import {
  runSharedevalPactPairFilesV1,
  type SharedevalPactPairFilesRunV1,
} from './sharedeval-runner.js';
import { createPreloadedSharedOsFileSessionFactoryV1 } from './sharedos-file-session.js';
import type { AgentWorkspaceRegistryReferencesV1 } from './workspace-registry.js';
import { isFirstAskCoverageV2, type FileMultiTurn } from './file-multi-turn.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTRUCTION_VERSION = '1.1.0';
const STATE_VERSION = '1.0.0';
const requiredTrackedSources = [
  'dataset/pact-pair/manifest.yaml',
  'dataset/pact-pair/tasks/questions.json',
  'dataset/pact-pair/data_spec/alex_data_store.json',
  'dataset/pact-pair/relationship_labels/relationship_label_matrix_v2.json',
  'dataset/pact-net/manifest.yaml',
  'dataset/pact-net/tasks/pact_net_tasks_v2.json',
  'dataset/shared-eval/workspaces/v1/registry.json',
] as const;

export type RunSharedevalProductionV1Options = Readonly<{
  config: EffectiveSharedevalRunConfigV1;
  configRootDir: string;
  runId: string;
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
}>;

export type SharedevalProductionRunV1 = Readonly<{
  runId: string;
  workflowId: 'files-multi' | 'files-single';
  runRoot: string;
  sourceRevision: string;
  run: SharedevalPactPairFilesRunV1;
}>;

type DatasetAuthority = Pick<
  FileWorkflowHostRunProvenanceV1,
  'dataset' | 'goldSet'
>;

type RunDirectories = Readonly<{
  runRoot: string;
  workspaceRootDir: string;
  multiStoreRoot: string;
  singleStoreRoot: string;
}>;

export type SharedevalProductionDependenciesV1 = Readonly<{
  inspectSource?: typeof inspectSharedevalSourceV1;
  loadDatasetAuthority?: typeof loadPactPairDatasetAuthorityV1;
  loadTasks?: typeof loadPactPairTasksV1;
  loadSharedOs?: typeof loadSharedOsModulesV1;
  createSessionFactory?: typeof createPreloadedSharedOsFileSessionFactoryV1;
  createDriver?: typeof createOpenAICompatibleFileTurnDriverV1;
  prepareRunDirectories?: typeof prepareSharedevalRunDirectoriesV1;
  runFiles?: typeof runSharedevalPactPairFilesV1;
}>;

/** Thin production composition; execution remains exclusively inside SharedOS. */
export async function runSharedevalProductionV1(
  options: RunSharedevalProductionV1Options,
  dependencies: SharedevalProductionDependenciesV1 = {},
): Promise<SharedevalProductionRunV1> {
  if (!RUN_ID_PATTERN.test(options.runId)) throw new Error('Sharedeval run id is invalid');
  const sourceRoot = resolve(options.repositoryRoot ?? repositoryRoot);
  // PACT-Net seats a different responder and a different corpus for every dyad, so
  // its binding comes from the selected probes rather than from the pair
  // identity/policy pairing below, which does not apply to it.
  const netBinding = options.config.benchmark.dataset === 'pact-net'
    ? buildPactNetRunBindingV1({
      rootDir: sourceRoot,
      ...(options.config.benchmark.tasks.ids
        ? { probeIds: [...options.config.benchmark.tasks.ids] }
        : {}),
    })
    : undefined;
  if (!netBinding) {
    assertIdentifiedPolicyMatchesRequesterV1(
      options.config.benchmark.policy,
      options.config.benchmark.requester,
    );
  }
  const requester = requesterIdentity(options.config.benchmark.requester);
  const environment = options.environment ?? process.env;
  const source = (dependencies.inspectSource ?? inspectSharedevalSourceV1)(sourceRoot);
  const datasetAuthority = netBinding
    ? loadPactNetDatasetAuthorityV1({ repositoryRoot: sourceRoot })
    : (dependencies.loadDatasetAuthority ?? loadPactPairDatasetAuthorityV1)({
      repositoryRoot: sourceRoot,
      gradingMode: options.config.benchmark.gradingMode,
    });
  const tasks = netBinding ? netBinding.tasks
    : (dependencies.loadTasks ?? loadPactPairTasksV1)({
    rootDir: sourceRoot,
    policy: options.config.benchmark.policy,
    requester: options.config.benchmark.requester,
    gradingMode: options.config.benchmark.gradingMode,
    kind: options.config.benchmark.tasks.kind,
    ...(options.config.benchmark.tasks.ids
      ? { ids: [...options.config.benchmark.tasks.ids] }
      : {}),
    ...(options.config.benchmark.tasks.limit === undefined
      ? {}
      : { limit: options.config.benchmark.tasks.limit }),
  });
  if (tasks.length === 0) throw new Error('Sharedeval task selection is empty');

  const apiKey = resolvePactRunModelApiKeyV1(options.config.model, environment);
  const driverEnvironment = Object.freeze({
    SHAREDEVAL_MODEL_API_KEY: apiKey,
  });
  const loaded = await (dependencies.loadSharedOs ?? loadSharedOsModulesV1)(
    defaultSharedOsDirV1(environment),
  );
  if (!loaded.ok) throw new Error(`Pinned SharedOS runtime is unavailable: ${loaded.reason}`);
  const createSharedOsSession = (dependencies.createSessionFactory
    ?? createPreloadedSharedOsFileSessionFactoryV1)(loaded);
  const directories = await (dependencies.prepareRunDirectories
    ?? prepareSharedevalRunDirectoriesV1)({
    configRootDir: options.configRootDir,
    outputDirectory: options.config.output.directory,
    runId: options.runId,
  });
  const modelId = pactModelIdentifierV1(options.config.model);
  const model = Object.freeze({
    provider: options.config.model.provider,
    requestedModel: modelId,
    resolvedModel: modelId,
  });
  const runProvenance: FileWorkflowHostRunProvenanceV1 = deepFreeze({
    ...datasetAuthority,
    models: { requester: model, responder: model },
    backend: { adapterId: 'sharedos-runtime', executor: 'sharedos-executor' },
  });
  const createDriver = dependencies.createDriver ?? createOpenAICompatibleFileTurnDriverV1;
  // One ledger and one rate-limit gate per run: providers may vary freely,
  // the served model may not, and concurrent tasks queue behind one 429.
  const servedModelLedger = createServedModelConsistencyLedgerV1();
  const rateLimitGate = createProviderRateLimitGateV1();
  const run = await (dependencies.runFiles ?? runSharedevalPactPairFilesV1)({
    config: options.config,
    runProvenance,
    runId: options.runId,
    workspaceRootDir: directories.workspaceRootDir,
    registryRootDir: join(sourceRoot, 'dataset', 'shared-eval', 'workspaces', 'v1'),
    requester: {
      actorId: 'requester',
      references: netBinding
        ? netBinding.requesterReferences
        : requesterReferences(
          requester.assetName,
          options.config.workflow.id,
          options.config.workflow.multiTurn,
          requester.policyAssetId,
        ),
    },
    responder: {
      actorId: 'responder',
      references: netBinding
        ? netBinding.responderReferences
        : responderReferences(options.config.benchmark.policy),
    },
    tasks,
    createDriver: input => createDriver({
      model: options.config.model,
      requestedModel: modelId,
      environment: driverEnvironment,
      servedModelLedger,
      rateLimitGate,
      ...(input.actorContext ? { actorContext: input.actorContext } : {}),
    } satisfies OpenAICompatibleFileTurnDriverV1Options),
    createSharedOsSession,
    createSessionResources: input => ({
      // The corpus the notes and todos tools search: the responder's own notes
      // when a PACT-Net dyad is seated, the PACT-Pair hub store otherwise.
      pactWorkspace: netBinding
        ? createPactPairWorkspaceV1(netBinding.store)
        : createPactPairWorkspaceV1(),
      storeRoot: input.workflowId === 'files-multi'
        ? directories.multiStoreRoot
        : join(
          directories.singleStoreRoot,
          `${String(input.sessionIndex).padStart(4, '0')}-${input.tasks[0]!.taskId}`,
        ),
    }),
  });
  return Object.freeze({
    runId: options.runId,
    workflowId: options.config.workflow.id,
    runRoot: directories.runRoot,
    sourceRevision: source.sourceRevision,
    run,
  });
}

export function inspectSharedevalSourceV1(root: string): { sourceRevision: string } {
  try {
    const sourceRevision = execFileSync(
      'git', ['-C', root, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('invalid revision');
    const dirty = execFileSync(
      'git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (dirty) throw new Error('dirty tracked source');
    execFileSync(
      'git', ['-C', root, 'ls-files', '--error-unmatch', '--', ...requiredTrackedSources],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return Object.freeze({ sourceRevision });
  } catch {
    throw new Error('Sharedeval requires a clean tracked source checkout');
  }
}

/**
 * Dataset authority for a PACT-Net v2 run.
 *
 * The v2 task file is hashed directly rather than through the manifest's `tasks`
 * pointer, which still names `old/tasks/pact_net_tasks.json` -- the retired
 * 25-agent world -- while the live world is the 60-agent one beside it. The
 * manifest bytes are still hashed, so the staleness travels into the run record
 * instead of being hidden by it.
 *
 * The forbidden contract is the gold here: it is the only part of v2 that decides
 * an outcome without a human, so it is what the gold-set digest covers.
 */
export function loadPactNetDatasetAuthorityV1(input: Readonly<{
  repositoryRoot: string;
}>): DatasetAuthority {
  const datasetRoot = join(input.repositoryRoot, 'dataset', 'pact-net');
  const manifestBytes = readFileSync(join(datasetRoot, 'manifest.yaml'));
  const manifest = parseDatasetManifestYamlV1(manifestBytes.toString('utf8'));
  if (manifest.id !== 'pact-net') throw new Error('PACT-Net manifest identity is invalid');
  const tasksName = join('tasks', 'pact_net_tasks_v2.json');
  const tasksBytes = readFileSync(join(datasetRoot, tasksName));
  return deepFreeze({
    dataset: {
      id: 'pact-net',
      version: manifest.version,
      manifestSha256: sha256(manifestBytes),
      tasksSha256: sha256(tasksBytes),
    },
    goldSet: {
      id: 'pact-net-forbidden-v2',
      sha256: digestNamedFiles([{ name: tasksName, bytes: tasksBytes }]),
    },
  });
}

export function loadPactPairDatasetAuthorityV1(input: Readonly<{
  repositoryRoot: string;
  gradingMode: 'category' | 'relationship';
}>): DatasetAuthority {
  const datasetRoot = join(input.repositoryRoot, 'dataset', 'pact-pair');
  const manifestPath = join(datasetRoot, 'manifest.yaml');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseDatasetManifestYamlV1(manifestBytes.toString('utf8'));
  if (manifest.id !== 'pact-pair') throw new Error('PACT-Pair manifest identity is invalid');
  const tasksPath = join(datasetRoot, manifest.assets['tasks']!);
  const tasksBytes = readFileSync(tasksPath);
  const goldFiles = input.gradingMode === 'relationship'
    ? [
      { name: manifest.assets['tasks']!, bytes: tasksBytes },
      {
        name: manifest.assets['relationships_v2']!,
        bytes: readFileSync(join(datasetRoot, manifest.assets['relationships_v2']!)),
      },
    ]
    : [{ name: manifest.assets['tasks']!, bytes: tasksBytes }];
  return deepFreeze({
    dataset: {
      id: 'pact-pair',
      version: manifest.version,
      manifestSha256: sha256(manifestBytes),
      tasksSha256: sha256(tasksBytes),
    },
    goldSet: {
      id: input.gradingMode === 'relationship'
        ? 'pact-pair-relationship-gold-v2'
        : 'pact-pair-category-gold-v1',
      sha256: digestNamedFiles(goldFiles),
    },
  });
}

export async function prepareSharedevalRunDirectoriesV1(input: Readonly<{
  configRootDir: string;
  outputDirectory: string;
  runId: string;
}>): Promise<RunDirectories> {
  const configRoot = await realpath(resolve(input.configRootDir));
  const outputRoot = join(configRoot, input.outputDirectory);
  const runRoot = join(outputRoot, input.runId);
  const workspaceRootDir = join(runRoot, 'workspaces');
  const multiStoreRoot = join(runRoot, 'multi');
  const singleStoreRoot = join(runRoot, 'single');
  await mkdir(workspaceRootDir, { recursive: true });
  await mkdir(singleStoreRoot, { recursive: true });
  const realRunRoot = await realpath(runRoot);
  if (!isWithin(configRoot, realRunRoot)) {
    throw new Error('Sharedeval output directory escapes its config root');
  }
  return Object.freeze({ runRoot, workspaceRootDir, multiStoreRoot, singleStoreRoot });
}

const PACT_NET_SHARED_GOAL_ASSET_V1 = 'agents/pact-net-requester/base/policy';

function requesterIdentity(
  requester: PactRequesterIdV1,
): { assetName: string; policyAssetId?: string } {
  const names: Partial<Record<PactRequesterIdV1, string>> = {
    R0: 'riley',
    R1: 'tina',
    R2: 'marcus',
    R3: 'jordan',
    R4: 'dana',
    R5: 'net_sarah',
    R6: 'net_carlos',
    R7: 'net_elena',
    R8: 'net_tina',
    R9: 'net_jordan',
  };
  const assetName = names[requester];
  if (!assetName) throw new Error(`Requester ${requester} has no production workspace asset`);
  // A goal list that moved with the asker would be a second variable next to the
  // identity under test. The PACT-Net arms therefore reference one shared file
  // rather than five copies kept in step by hand.
  if ((PACT_NET_REQUESTERS_V1 as readonly string[]).includes(requester)) {
    return { assetName, policyAssetId: PACT_NET_SHARED_GOAL_ASSET_V1 };
  }
  return { assetName };
}

function requesterReferences(
  assetName: string,
  workflowId: 'files-multi' | 'files-single',
  multiTurn: FileMultiTurn | undefined,
  policyAssetId?: string,
): AgentWorkspaceRegistryReferencesV1 {
  // The multi-turn probe protocol swaps in its own heartbeat asset; every
  // other reference — and every non-multiTurn run — stays exactly as today.
  const heartbeat = multiTurn
    ? isFirstAskCoverageV2(multiTurn)
      ? { id: 'heartbeats/files-multi-coverage', version: '2.0.0' }
      : { id: 'heartbeats/files-multi-probe', version: INSTRUCTION_VERSION }
    : { id: `heartbeats/${workflowId}`, version: INSTRUCTION_VERSION };
  return {
    agent: { id: `agents/${assetName}/base/agent`, version: INSTRUCTION_VERSION },
    heartbeat,
    policy: {
      id: policyAssetId ?? `agents/${assetName}/base/policy`,
      version: STATE_VERSION,
    },
    memory: { id: 'memory-seeds/pact-pair-requester', version: STATE_VERSION },
  };
}

function responderReferences(policy: PactPairPolicyV1): AgentWorkspaceRegistryReferencesV1 {
  return {
    agent: { id: 'agents/alex/base/agent', version: INSTRUCTION_VERSION },
    heartbeat: { id: 'agents/alex/base/heartbeat', version: INSTRUCTION_VERSION },
    policy: { id: policyAssetId(policy), version: STATE_VERSION },
    memory: { id: 'agents/alex/base/memory', version: STATE_VERSION },
  };
}

const IDENTIFIED_POLICY_PREFIX_V1 = 'D2R_ID_';

/**
 * Policy families whose name ends in the one requester they address. Each maps to
 * an asset directory holding one POLICY.md per requester; the suffix is the only
 * thing that varies inside a family.
 */
const REQUESTER_NAMED_POLICY_FAMILIES_V1 = [
  { prefix: IDENTIFIED_POLICY_PREFIX_V1, assetDir: 'policies/pact-pair-identified' },
  { prefix: 'NET_IDT_', assetDir: 'policies/pact-net-id-tiers' },
  { prefix: 'NET_IDR_', assetDir: 'policies/pact-net-id-rel' },
  { prefix: 'NET_ID_', assetDir: 'policies/pact-net-id' },
] as const;

/**
 * A D2R_ID_* policy names one specific caller inside the responder's POLICY.md.
 * Pairing D2R_ID_R1 with requester R2 would tell the responder it is speaking
 * to Tina while Marcus actually writes, so the run would silently measure a
 * relationship nobody exercised. Fail loudly instead.
 */
function assertIdentifiedPolicyMatchesRequesterV1(
  policy: PactPairPolicyV1,
  requester: PactRequesterIdV1,
): void {
  const family = REQUESTER_NAMED_POLICY_FAMILIES_V1.find(
    candidate => policy.startsWith(candidate.prefix),
  );
  if (!family) return;
  const named = policy.slice(family.prefix.length);
  if (named !== requester) {
    throw new Error(
      `Policy ${policy} names requester ${named}, but the run selects requester ${requester}`,
    );
  }
}

function policyAssetId(policy: PactPairPolicyV1): string {
  const family = REQUESTER_NAMED_POLICY_FAMILIES_V1.find(
    candidate => policy.startsWith(candidate.prefix),
  );
  if (family) {
    const requester = policy.slice(family.prefix.length);
    return `${family.assetDir}/${requester.toLowerCase()}`;
  }
  if (policy.startsWith('REL_')) {
    return `policies/pact-pair-relationship/${policy.slice(4).toLowerCase()}`;
  }
  const aliases: Partial<Record<PactPairPolicyV1, string>> = {
    D2_SUBMITTED: 'D2',
    D3_SUBMITTED: 'D3',
    D4_SUBMITTED: 'D4',
    D5_SUBMITTED: 'D5',
    A_LONG_GENERIC: 'M6',
    A_CATEGORY_ONLY: 'M7',
    A_CATEGORY_EXAMPLES: 'M8',
  };
  const asset = aliases[policy] ?? policy;
  if (/^M[678]$/.test(asset)) {
    return `policies/pact-pair-ablation/${asset.toLowerCase()}`;
  }
  return `policies/pact-pair-defense/${asset.toLowerCase()}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestNamedFiles(files: readonly Readonly<{ name: string; bytes: Uint8Array }>[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.name);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
