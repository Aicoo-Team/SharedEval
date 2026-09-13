import { join, resolve } from 'node:path';
import { SHAREDOS_VERIFIED_REVISION_V1, SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 } from '../../execution/sharedos/v1/load-sharedos.js';
import { profileActors } from '../../suites/pact-net/pilot/profile.js';
import { worldActors } from '../../suites/pact-net/world/profile.js';
import { nativeNetWorkflowId, resolveNativeNetConfig } from './config.js';
import { withNativeNetArtifacts } from './artifacts.js';

const USAGE = 'Usage: npm run sharedeval -- net check|run|score --config FILE [--max-turns N (run only)]';
export function parseNativeNetArgs(argv: readonly string[]): { command: 'check' | 'run' | 'score'; configPath: string; turns: number } {
  const [command, ...args] = argv;
  if (command !== 'check' && command !== 'run' && command !== 'score') throw new Error(USAGE);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--config', '--max-turns'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error(USAGE);
    values.set(key, value);
  }
  const configPath = values.get('--config'); const raw = values.get('--max-turns') ?? '40';
  if (!configPath || command !== 'run' && values.has('--max-turns') || !/^(?:0|[1-9][0-9]{0,3})$/.test(raw) || Number(raw) > 1000) throw new Error(USAGE);
  return { command, configPath, turns: Number(raw) };
}

export async function mainSharedevalNetV1(argv: readonly string[], dependencies: { writeOutput?: (source: string) => void } = {}): Promise<number> {
  const args = parseNativeNetArgs(argv);
  const config = await resolveNativeNetConfig(args.configPath);
  const output = dependencies.writeOutput ?? (source => process.stdout.write(source));
  const identity = { runId: config.runId, workflowId: nativeNetWorkflowId(config), kind: config.kind,
    configDigest: config.configDigest, profileDigest: config.profileDigest, directory: config.directory };
  if (args.command === 'check') {
    output(`${JSON.stringify({ ...identity, provider: config.provider,
      cases: config.kind === 'procurement-world' ? config.profile.cases.map(item => item.initial.case_id) : [config.profile.initial.case_id],
      actors: config.kind === 'procurement-world' ? worldActors(config.profile) : profileActors(config.profile),
      scoringRegistered: config.kind === 'p01-pilot',
      requiredSharedos: { revision: SHAREDOS_VERIFIED_REVISION_V1, runtimeDigest: SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1 },
      note: 'Configuration check does not call a model or SharedOS, or create run artifacts.' }, null, 2)}\n`);
    return 0;
  }
  if (args.command === 'score') {
    if (config.kind !== 'p01-pilot') throw new Error('native_net_evaluator_not_registered');
    const result = await withNativeNetArtifacts(config, false, async artifacts => {
      const execution = await artifacts.readExecution();
      // Evaluator code/material is loaded only for the explicit post-hoc command.
      const { evaluatePilotEvidence } = await import('../../suites/pact-net/pilot/score.js');
      const scored = await evaluatePilotEvidence({ profile: config.profile, evidence: execution.evidence,
        dataDirectory: resolve(import.meta.dirname, '../../../dataset/pact-net') });
      const value = { version: 'pact-net-evaluation/v1', configDigest: config.configDigest, evidenceDigest: execution.evidenceDigest,
        evaluator: { taskId: 'P-01', executionContract: 'pact-net-p01-pilot/v1' }, ...scored };
      await artifacts.publishEvaluation(value);
      return scored.evaluation;
    });
    output(`${JSON.stringify({ ...identity, evaluation: join(config.directory, 'evaluation.json'), result }, null, 2)}\n`);
    return 0;
  }
  // Verify the exact runtime before creating any output or invoking a provider.
  const { loadSharedOsModulesV1 } = await import('../../execution/sharedos/v1/load-sharedos.js');
  const loaded = await loadSharedOsModulesV1();
  if (!loaded.ok) throw new Error(loaded.reason);
  const result = await withNativeNetArtifacts(config, true, async artifacts => {
    const { scriptedPilotDriver } = await import('../../suites/pact-net/pilot/driver.js');
    const { openNetPilot } = await import('../../suites/pact-net/pilot/session.js');
    const { openNetWorld } = await import('../../suites/pact-net/world/session.js');
    const options = { directory: config.directory, runId: config.runId, createDriver: scriptedPilotDriver() };
    const session = config.kind === 'procurement-world'
      ? await openNetWorld({ ...options, profile: config.profile })
      : await openNetPilot({ ...options, profile: config.profile });
    try {
      for (let i = 0; i < args.turns; i++) if (!await session.runNext()) break;
      return await artifacts.publishExecution(session.snapshot());
    } finally { await session.close(); }
  });
  output(`${JSON.stringify({ ...identity, execution: join(config.directory, 'execution.json'),
    evidenceKind: result.evidence.evidence_kind, terminalSuccess: result.evidence.terminal_success,
    worldComplete: result.evidence.world_complete ?? null, turns: (result.evidence.processed as unknown[]).length,
    pendingDeliveries: (result.evidence.queue as unknown[]).length }, null, 2)}\n`);
  return 0;
}
