import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { sharedevalRunConfigV2Schema } from '../../src/runner/v1/sharedeval-config.js';
import { acceptanceConfig, FROZEN_SOURCE, PREFLIGHT_IDS, SPLIT_IDS } from './prepare-pair-acceptance.js';

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const splitManifestName = 'pair-split-02.manifest.json';
const nativeManifestName = 'codex-pair-config.manifest.json';

export function codexAcceptanceConfig(ids: string[], preflight = false) {
  const baseline = acceptanceConfig(ids, preflight);
  if (baseline.model.provider !== 'openai-compatible') throw new Error('Unexpected acceptance model provider');
  const { providerRouting: _routing, ...model } = baseline.model;
  return sharedevalRunConfigV2Schema.parse({
    ...baseline,
    model: { ...model, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-5.5', apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY' },
  });
}

async function writeImmutable(path: string, content: string) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8') !== content) {
      throw new Error(`Refusing to replace a different acceptance artifact: ${path}`);
    }
  }
}

export async function prepareCodexAcceptance(outputDirectory: string) {
  const out = resolve(outputDirectory);
  const splitManifestBytes = await readFile(join(out, splitManifestName), 'utf8');
  const frozen = JSON.parse(splitManifestBytes) as {
    sourceRevision?: unknown; selectedTaskIds?: unknown; preflightTaskIds?: unknown;
    selectedIdsSha256?: unknown; configurationSha256?: Record<string, unknown>;
  } | null;
  const selectedIdsSha256 = sha256(JSON.stringify(SPLIT_IDS));
  if (frozen?.sourceRevision !== FROZEN_SOURCE
    || JSON.stringify(frozen.selectedTaskIds) !== JSON.stringify(SPLIT_IDS)
    || JSON.stringify(frozen.preflightTaskIds) !== JSON.stringify(PREFLIGHT_IDS)
    || frozen.selectedIdsSha256 !== selectedIdsSha256) {
    throw new Error('Frozen split manifest mismatch');
  }

  const configurations = [
    { baselineName: 'deepseek-pair-preflight.yaml', nativeName: 'codex-pair-preflight.yaml', ids: PREFLIGHT_IDS, preflight: true },
    { baselineName: 'deepseek-pair-60x300.yaml', nativeName: 'codex-pair-60x300.yaml', ids: SPLIT_IDS, preflight: false },
  ];
  const baselineConfigurationSha256: Record<string, string> = {};
  const configurationSha256: Record<string, string> = {};
  const artifacts: { name: string; content: string }[] = [];
  for (const { baselineName, nativeName, ids, preflight } of configurations) {
    const expectedBaseline = stringify(acceptanceConfig(ids, preflight), { lineWidth: 0 });
    const baselineHash = sha256(expectedBaseline);
    if (await readFile(join(out, baselineName), 'utf8') !== expectedBaseline
      || frozen.configurationSha256?.[baselineName] !== baselineHash) {
      throw new Error(`Frozen baseline configuration mismatch: ${baselineName}`);
    }
    baselineConfigurationSha256[baselineName] = baselineHash;
    const content = stringify(codexAcceptanceConfig(ids, preflight), { lineWidth: 0 });
    configurationSha256[nativeName] = sha256(content);
    artifacts.push({ name: nativeName, content });
  }

  const manifest = {
    version: 'codex-pair-acceptance-config/v1', sourceRevision: FROZEN_SOURCE,
    frozenSplitManifest: { path: splitManifestName, sha256: sha256(splitManifestBytes) },
    selectedTaskIds: SPLIT_IDS, preflightTaskIds: PREFLIGHT_IDS, selectedIdsSha256,
    baselineConfigurationSha256, configurationSha256,
    nativeBridge: {
      status: 'experimental', harness: 'codex', selectedModel: 'gpt-5.5', reasoningEffort: 'medium',
      transport: 'Codex app-server; the OpenAI-compatible loopback URL is an intercepted placeholder, not an HTTP model endpoint.',
      requiredRunner: 'scripts/experiments/run-pair-acceptance.ts --harness codex',
      dummyEnvironment: { SHAREDEVAL_MODEL_API_KEY: 'native-codex-no-http-key' },
      credentials: 'Dummy API key only for the existing driver interface. Native authentication is managed externally by Codex; no credentials are read or generated here.',
      requestedMaxOutputTokens: 4096, outputTokenLimitEnforced: false,
      requestedTemperature: 0, temperatureEnforcement: 'not-guaranteed',
      modelIdentity: 'Selected model is recorded; the upstream served model is not independently verified.',
    },
    interpretation: 'Same frozen tasks, policy, requester, grading, workflow and budgets as the DeepSeek configs. Native output-token and temperature enforcement differ; results are experimental and are not a claim of identical provider execution.',
  };
  artifacts.push({ name: nativeManifestName, content: `${JSON.stringify(manifest, null, 2)}\n` });
  // Detect conflicts before creating any new artifact; exclusive writes also protect against races.
  for (const { name, content } of artifacts) {
    try {
      if (await readFile(join(out, name), 'utf8') !== content) {
        throw new Error(`Refusing to replace a different acceptance artifact: ${join(out, name)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const { name, content } of artifacts) await writeImmutable(join(out, name), content);
  return { outputDirectory: out, manifest, manifestPath: join(out, nativeManifestName),
    configPaths: configurations.map(({ nativeName }) => join(out, nativeName)) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf('--output-dir');
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error('Usage: prepare-codex-acceptance.ts --output-dir <existing-configs-directory>');
  }
  prepareCodexAcceptance(process.argv[index + 1]).then(result => {
    console.log(JSON.stringify({ ...result, manifest: result.manifestPath }, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
