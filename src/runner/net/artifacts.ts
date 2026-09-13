import { mkdir, open, readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../../suites/pact-net/pilot/profile.js';
import { atomicJson } from '../../suites/pact-net/pilot/runtime.js';
import { SHAREDOS_VERIFIED_REVISION_V1, SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 } from '../../execution/sharedos/v1/load-sharedos.js';
import { nativeNetWorkflowId, type ResolvedNativeNetConfig } from './config.js';

const envelopeSchema = z.object({
  version: z.literal('pact-net-execution/v1'), configDigest: z.string(), checkpointDigest: z.string(),
  evidenceDigest: z.string(), evidence: z.record(z.unknown()),
}).strict();
export type NativeNetExecution = z.infer<typeof envelopeSchema>;

function manifestBody(config: ResolvedNativeNetConfig) {
  return { version: 'pact-net-command-run/v1', runId: config.runId, workflowId: nativeNetWorkflowId(config),
    kind: config.kind, configDigest: config.configDigest, profileDigest: config.profileDigest, provider: config.provider,
    sharedos: { revision: SHAREDOS_VERIFIED_REVISION_V1, runtimeDigest: SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 } };
}
async function readChecked(path: string): Promise<Record<string, unknown>> {
  let parsed: Record<string, unknown>;
  try { parsed = z.record(z.unknown()).parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (cause) { throw new Error('native_net_artifact_invalid', { cause }); }
  const { checksum, ...body } = parsed;
  if (checksum !== digest(body)) throw new Error('native_net_artifact_integrity_error');
  return body;
}
async function checkpointDigest(directory: string): Promise<string> {
  const checkpoint = await readChecked(join(directory, 'checkpoint.json'));
  if (checkpoint.pending !== null) throw new Error('native_net_pending_turn_incomplete');
  return digest(checkpoint);
}
async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Serialize command-level manifest, export and scoring publication around native ownership. */
export async function withNativeNetArtifacts<T>(config: ResolvedNativeNetConfig, create: boolean,
  operation: (artifacts: {
    publishExecution(evidence: unknown): Promise<NativeNetExecution>;
    readExecution(): Promise<NativeNetExecution>;
    publishEvaluation(value: unknown): Promise<void>;
  }) => Promise<T>): Promise<T> {
  const directory = config.directory;
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('native_net_directory_invalid');
  const lockPath = join(directory, 'command.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let nativeLock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await lock.writeFile(randomUUID()); await lock.sync();
    // Direct adapter invocations use writer.lock; never score around their owner.
    if (await exists(join(directory, 'writer.lock'))) throw new Error('native_net_writer_active');
    // Manifest publication and post-hoc reads both require native ownership.
    // A one-time absence check would race a direct adapter creating its checkpoint.
    nativeLock = await open(join(directory, 'writer.lock'), 'wx', 0o600);
    await nativeLock.writeFile(randomUUID()); await nativeLock.sync();
    const expected = manifestBody(config);
    const manifestPath = join(directory, 'run-manifest.json');
    if (await exists(manifestPath)) {
      if (digest(await readChecked(manifestPath)) !== digest(expected)) throw new Error('native_net_run_binding_mismatch');
    } else {
      if (!create || (await readdir(directory)).some(name => !['command.lock', 'writer.lock'].includes(name))) throw new Error('native_net_run_manifest_missing');
      await atomicJson(directory, 'run-manifest.json', { ...expected, checksum: digest(expected) });
    }
    if (create) {
      // The native session acquires its own writer token and verifies checkpoint
      // binding before any turn. Losing this handoff race fails closed in open().
      await nativeLock.close(); await unlink(join(directory, 'writer.lock'));
      nativeLock = undefined;
    }
    const checkEvidence = (evidence: Record<string, unknown>) => {
      const kind = config.kind === 'procurement-world' ? 'scripted-native-runtime-world' : 'scripted-native-runtime-pilot';
      if (evidence.evidence_kind !== kind || evidence.profile_digest !== config.profileDigest || evidence.commit_status !== 'committed' || evidence.pending !== null || evidence.indeterminate !== false) {
        throw new Error('native_net_execution_binding_mismatch');
      }
    };
    return await operation({
      async publishExecution(input) {
        const evidence = z.record(z.unknown()).parse(input);
        checkEvidence(evidence);
        const body: NativeNetExecution = { version: 'pact-net-execution/v1', configDigest: config.configDigest,
          checkpointDigest: await checkpointDigest(directory), evidenceDigest: digest(evidence), evidence };
        await atomicJson(directory, 'execution.json', { ...body, checksum: digest(body) });
        return body;
      },
      async readExecution() {
        const execution = envelopeSchema.parse(await readChecked(join(directory, 'execution.json')));
        if (execution.configDigest !== config.configDigest || execution.evidenceDigest !== digest(execution.evidence)
          || execution.checkpointDigest !== await checkpointDigest(directory)) throw new Error('native_net_execution_integrity_error');
        checkEvidence(execution.evidence);
        return execution;
      },
      async publishEvaluation(value) { await atomicJson(directory, 'evaluation.json', value); },
    });
  } finally {
    try {
      if (nativeLock) { await nativeLock.close(); await unlink(join(directory, 'writer.lock')); }
    } finally { await lock.close(); await unlink(lockPath); }
  }
}
