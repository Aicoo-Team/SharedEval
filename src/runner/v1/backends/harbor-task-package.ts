import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  PACT_MODEL_API_KEY_ENV_V1,
  selectedPactExecutionAdapterV1,
  type PactModelConfigV1,
  type PactRunConfigV1,
} from '../config.js';
import type { LoadedPactPairTaskV1 } from '../task-loader.js';
import { mapWithConcurrencyV1 } from './concurrency.js';
import {
  PACT_SHAREDOS_COMMIT_V1,
  PACT_SHAREDOS_RUNTIME_DIGEST_V1,
} from './harbor-sharedos.js';

// Bound how many task directories are copied/token-replaced at once so a
// full-dataset selection does not open thousands of files concurrently.
const HARBOR_MATERIALIZE_CONCURRENCY_V1 = 16;

export type MaterializeHarborDatasetV1Options = {
  datasetDirectory: string;
  templateDirectory: string;
  imageName: string;
  config: PactRunConfigV1;
  tasks: LoadedPactPairTaskV1[];
  /**
   * SharedOS source and executable-bundle provenance recorded in every task
   * package. Defaults to the verified pair; the Harbor backend passes the
   * identity of the checkout it actually staged.
   */
  sharedOsCommit?: string;
  /** Executable SharedOS bundle digest recorded beside the commit. */
  sharedOsRuntimeDigest?: string;
};

/**
 * Whether a run config selects the deterministic scripted parity harness
 * rather than a real model. The scripted convention is a model endpoint under
 * the RFC 2606-reserved `.invalid` TLD (see examples/pact-run.harbor-smoke.yaml
 * and container-entrypoint.ts): such an endpoint can never resolve, so it can
 * never be a real provider. Scripted task packages stay strictly no-network.
 */
export function pactHarborScriptedModelV1(model: PactModelConfigV1): boolean {
  return pactModelEndpointUrlV1(model).hostname
    .toLocaleLowerCase('en-US')
    .endsWith('.invalid');
}

function pactModelEndpointUrlV1(model: PactModelConfigV1): URL {
  return new URL(model.provider === 'azure-openai' ? model.endpoint : model.baseUrl);
}

/**
 * O-003 decision 2: real-model Harbor trials narrow egress from no-network to
 * exactly the configured model endpoint host over HTTPS 443 — derived from the
 * run config, never hardcoded. Anything else (plain HTTP, a non-default port)
 * is rejected outright instead of being silently widened.
 */
export function pactHarborAllowedEgressV1(model: PactModelConfigV1): string {
  const url = pactModelEndpointUrlV1(model);
  if (url.protocol !== 'https:') {
    throw new Error(
      'Harbor real-model trials only permit HTTPS egress to the configured '
      + `model endpoint (O-003); got ${url.protocol}//${url.host}`,
    );
  }
  if (url.port !== '' && url.port !== '443') {
    throw new Error(
      'Harbor real-model trials only permit egress on port 443 to the '
      + `configured model endpoint (O-003); got port ${url.port}`,
    );
  }
  return `https://${url.hostname.toLocaleLowerCase('en-US')}:443`;
}

export async function materializeHarborDatasetV1(
  options: MaterializeHarborDatasetV1Options,
): Promise<void> {
  const scripted = pactHarborScriptedModelV1(options.config.model);
  // Computed once, before any file is written: an endpoint that violates the
  // O-003 egress contract must fail the whole materialization.
  const allowedEgress = scripted
    ? ''
    : pactHarborAllowedEgressV1(options.config.model);
  const modelEnvironmentSection = scripted
    ? ''
    : modelEnvironmentSectionV1(
        options.config.model,
        selectedPactExecutionAdapterV1(options.config),
      );
  await mkdir(options.datasetDirectory, { recursive: true });
  await mapWithConcurrencyV1(
    options.tasks,
    HARBOR_MATERIALIZE_CONCURRENCY_V1,
    async task => {
      const taskDirectory = join(
        options.datasetDirectory,
        task.taskId.toLocaleLowerCase('en-US'),
      );
      await copyTemplateDirectory(options.templateDirectory, taskDirectory);
      const taskImageName = harborTaskImageName(options.imageName, task.taskId);
      const replacements: Record<string, string> = {
        TASK_ID: task.taskId,
        TASK_SLUG: task.taskId.toLocaleLowerCase('en-US'),
        IMAGE_NAME: taskImageName,
        POLICY: options.config.benchmark.policy,
        REQUESTER: options.config.benchmark.requester,
        GRADING_MODE: options.config.benchmark.gradingMode,
        MAX_TURNS: String(options.config.budget.maxTurns),
        MAX_TOOL_CALLS: String(options.config.budget.maxToolCalls),
        MAX_RUNTIME_MS: String(options.config.budget.maxRuntimeMs),
        AGENT_TIMEOUT_SEC: String(
          Math.ceil(options.config.budget.maxRuntimeMs / 1_000) + 30,
        ),
        SHAREDOS_COMMIT: options.sharedOsCommit ?? PACT_SHAREDOS_COMMIT_V1,
        SHAREDOS_RUNTIME_DIGEST:
          options.sharedOsRuntimeDigest ?? PACT_SHAREDOS_RUNTIME_DIGEST_V1,
        ALLOW_INTERNET: scripted ? 'false' : 'true',
        NETWORK_POLICY: scripted ? 'no-network' : 'model-endpoint-only',
        ALLOWED_EGRESS: allowedEgress,
        MODEL_ENV_SECTION: modelEnvironmentSection,
      };
      await replaceTokensRecursively(taskDirectory, replacements);
    },
  );
}

/**
 * The task-package [environment.env] section for real-model trials.
 *
 * O-003 decision 1: the credential is runtime-only. The section carries the
 * `${PACT_MODEL_API_KEY}` template that Harbor 0.5.0 resolves from the HOST
 * environment at trial start and injects into exec'd container processes
 * (`docker compose exec -e`) — the secret value itself never appears in the
 * task package, the image, logs, traces, or artifacts. Non-secret model
 * configuration (endpoint, deployment, sampling controls) travels in the task
 * package as one literal JSON blob that round-trips through
 * pactModelConfigV1Schema; it names the credential's env alias but never its
 * value.
 */
function modelEnvironmentSectionV1(
  model: PactModelConfigV1,
  executionAdapter: string,
): string {
  return [
    '',
    '# O-003 decision 1: the model credential is runtime-only. Harbor resolves',
    '# the template below from the HOST environment when the trial starts and',
    '# injects it into container processes only; the secret never enters this',
    '# task package, the image, logs, traces, or artifacts. Non-secret model',
    '# configuration travels here as a literal, as does the execution adapter',
    '# the host run selected (provenance for the in-container config digest).',
    '[environment.env]',
    `PACT_MODEL_CONFIG_JSON = ${tomlBasicStringV1(JSON.stringify(model))}`,
    `PACT_EXECUTION_ADAPTER = ${tomlBasicStringV1(executionAdapter)}`,
    `${PACT_MODEL_API_KEY_ENV_V1} = "\${${PACT_MODEL_API_KEY_ENV_V1}}"`,
    '',
  ].join('\n');
}

/**
 * TOML basic strings share JSON's escape rules for quotes, backslashes,
 * control characters, and \uXXXX, so JSON.stringify emits a valid TOML basic
 * string for any input (config-supplied values can contain quotes).
 */
function tomlBasicStringV1(value: string): string {
  return JSON.stringify(value);
}

export function harborTaskImageName(baseImageName: string, taskId: string): string {
  return `${baseImageName}-${taskId.toLocaleLowerCase('en-US')}`;
}

async function copyTemplateDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTemplateDirectory(sourcePath, targetPath);
      return;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported Harbor template entry: ${sourcePath}`);
    }
    await copyFile(sourcePath, targetPath);
  }));
}

async function replaceTokensRecursively(
  directory: string,
  replacements: Record<string, string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await replaceTokensRecursively(entryPath, replacements);
      return;
    }
    if (!entry.isFile()) return;
    let source = await readFile(entryPath, 'utf8');
    for (const [name, value] of Object.entries(replacements)) {
      source = source.split(`{{${name}}}`).join(value);
    }
    if (/\{\{[A-Z_]+\}\}/.test(source)) {
      throw new Error(`Unresolved token in Harbor task template ${entryPath}`);
    }
    await writeFile(entryPath, source, 'utf8');
  }));
}
