import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { SHAREDOS_VERIFIED_REVISION_V1, SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 } from '../../execution/sharedos/v1/load-sharedos.js';
import { digest, loadAssignedProcurementProfile, loadPilotProfile, type AssignedProcurementProfile, type PilotProfile } from '../../suites/pact-net/pilot/profile.js';
import { loadProcurementWorldProfile, type ProcurementWorldProfile } from '../../suites/pact-net/world/profile.js';
import { inspectSharedevalRunConfigV1Yaml } from '../v1/sharedeval-config.js';

const pathSchema = z.string().min(1).max(4096);
export const nativeNetConfigSchema = z.object({
  version: z.literal('pact-net-native-run/v1'),
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  outputDirectory: pathSchema,
  provider: z.object({ type: z.literal('scripted-procurement/v1') }).strict(),
  execution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('p01-pilot'), mode: z.enum(['success', 'safe-partial']) }).strict(),
    z.object({ kind: z.literal('assigned-pilot'), profileFile: pathSchema }).strict(),
    z.object({ kind: z.literal('procurement-world'), profileFile: pathSchema }).strict(),
  ]),
}).strict();
export type NativeNetConfig = z.infer<typeof nativeNetConfigSchema>;
export type ResolvedNativeNetConfig = {
  runId: string;
  directory: string;
  configDigest: string;
  profileDigest: string;
  provider: NativeNetConfig['provider'];
} & (
  | { kind: 'p01-pilot'; profile: PilotProfile }
  | { kind: 'assigned-pilot'; profile: AssignedProcurementProfile }
  | { kind: 'procurement-world'; profile: ProcurementWorldProfile }
);

/** Parse declarative JSON/YAML and materialize profile contents without opening a run. */
export async function resolveNativeNetConfig(path: string): Promise<ResolvedNativeNetConfig> {
  const configPath = resolve(path);
  let config: NativeNetConfig;
  try { config = nativeNetConfigSchema.parse(inspectSharedevalRunConfigV1Yaml(await readFile(configPath, 'utf8'))); }
  catch (cause) { throw new Error('native_net_config_invalid', { cause }); }
  const base = dirname(configPath);
  const data = resolve(import.meta.dirname, '../../../dataset/pact-net');
  let execution: Pick<ResolvedNativeNetConfig, 'kind' | 'profile'>;
  try {
    if (config.execution.kind === 'p01-pilot') execution = { kind: 'p01-pilot', profile: await loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), config.execution.mode) };
    else if (config.execution.kind === 'assigned-pilot') execution = { kind: 'assigned-pilot', profile: await loadAssignedProcurementProfile(resolve(base, config.execution.profileFile)) };
    else execution = { kind: 'procurement-world', profile: await loadProcurementWorldProfile(resolve(base, config.execution.profileFile)) };
  } catch (cause) { throw new Error('native_net_profile_invalid', { cause }); }
  const profileDigest = digest(execution.profile);
  // Paths locate artifacts; they are not experiment conditions. Copying an intact
  // run to a new location preserves its identity; changing materialized input does not.
  const configDigest = digest({ version: config.version, runId: config.runId, provider: config.provider,
    kind: execution.kind, profileDigest, sharedos: { revision: SHAREDOS_VERIFIED_REVISION_V1, runtimeDigest: SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 } });
  return { runId: config.runId, directory: resolve(base, config.outputDirectory), provider: config.provider,
    configDigest, profileDigest, ...execution } as ResolvedNativeNetConfig;
}

export function nativeNetWorkflowId(config: ResolvedNativeNetConfig): 'net-single' | 'net-multi' {
  return config.kind === 'procurement-world' && config.profile.mode === 'multi' ? 'net-multi' : 'net-single';
}
