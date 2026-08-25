import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  summarizeLegacyTrajectoriesV1,
  writeLegacyMultiArtifactsV1,
  type LegacyPublicRunManifestV1,
} from '../../../src/suites/pact-pair/legacy-transcript/artifacts.js';
import {
  LEGACY_MULTI_METRIC_FAMILY_ID_V1,
  LEGACY_MULTI_PROTOCOL_ID_V1,
  LEGACY_MULTI_WORKFLOW_ID_V1,
} from '../../../src/suites/pact-pair/legacy-transcript/config.js';
import type {
  LegacyPublicTickV1,
  LegacyTrajectoryRunV1,
} from '../../../src/suites/pact-pair/legacy-transcript/engine.js';

function tick(overrides: Partial<LegacyPublicTickV1> & Pick<LegacyPublicTickV1, 'tick' | 'taskId'>): LegacyPublicTickV1 {
  return {
    workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
    protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    trajectoryId: 'trajectory-1',
    tickId: `trajectory-1:tick-${overrides.tick}`,
    phase: 1,
    kind: 'qa',
    requesterStrategy: 'first_ask',
    decisionType: 'refuse',
    terminalReceived: true,
    substrateStatus: 'succeeded',
    evaluation: {
      taskId: overrides.taskId, kind: 'qa', actualDecision: 'refuse',
      scorable: true, correct: true, factMatch: false, leaked: false, noLeak: true,
      benchmarkLeaked: false, benchmarkNoLeak: true,
    },
    sideEffectBeforeFailure: false,
    grantedAccessDigest: 'd'.repeat(64),
    budgetUsed: { turns: 1, toolCalls: 0, runtimeMs: 1 },
    toolCalls: [],
    execution: {
      adapterId: 'pact-public-runner',
      adapterProtocolVersion: 'pact-public-runner/v1',
      sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
    },
    ...overrides,
  };
}

function run(
  trajectoryId: string,
  ticks: LegacyPublicTickV1[],
  checklist: Array<{ taskId: string; status: 'pending' | 'answered' | 'refused' | 'error'; asks: number }>,
): LegacyTrajectoryRunV1 {
  const publicTicks = ticks.map(entry => ({
    ...entry,
    trajectoryId,
    tickId: `${trajectoryId}:tick-${entry.tick}`,
  }));
  return {
    public: {
      workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
      protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
      metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
      runId: 'run-1', trajectoryId,
      requesterDriver: {
        kind: 'scripted', id: 'driver', version: 1,
        scriptPath: 'dataset/script.json', scriptRawSha256: 'a'.repeat(64),
        scriptBytes: 100, strategyTaxonomyVersion: 1,
      },
      responderProvider: {
        requestedModel: 'responder-v1', servedModels: ['served-v1'],
        promptRawSha256: 'b'.repeat(64), requests: [],
      },
      tickCount: publicTicks.length,
      phase1Ticks: publicTicks.filter(entry => entry.phase === 1).length,
      phase2Ticks: publicTicks.filter(entry => entry.phase === 2).length,
      endReason: 'driver_stop',
      hasInfrastructureError: publicTicks.some(entry => entry.substrateStatus === 'provider_error'),
      checklist,
      ticks: publicTicks,
    },
    private: {
      runId: 'run-1', trajectoryId,
      initialSnapshot: {} as never,
      finalSnapshot: {} as never,
      ticks: [],
      responderTranscript: [{ role: 'system', content: 'PRIVATE_SENTINEL' }],
      error: 'PRIVATE_SENTINEL',
    },
  };
}

test('trajectory-only metrics expose exact denominators for answers, leaks, retries, and infra', () => {
  const first = run('trajectory-1', [
    tick({ tick: 1, taskId: 'PAIR-Q1' }),
    tick({
      tick: 2, taskId: 'PAIR-Q2', decisionType: 'answer',
      evaluation: {
        taskId: 'PAIR-Q2', kind: 'qa', actualDecision: 'answer', scorable: true,
        correct: false, factMatch: true, leaked: true, noLeak: false,
        benchmarkLeaked: true, benchmarkNoLeak: false,
      },
    }),
    tick({
      tick: 3, taskId: 'PAIR-Q1', phase: 2, requesterStrategy: 'repeat',
      retryOfTick: 1, decisionType: 'answer',
    }),
  ], [
    { taskId: 'PAIR-Q1', status: 'answered', asks: 2 },
    { taskId: 'PAIR-Q2', status: 'answered', asks: 1 },
  ]);
  const second = run('trajectory-2', [
    tick({
      tick: 1, taskId: 'PAIR-Q1', substrateStatus: 'provider_error',
      terminalReceived: false, decisionType: 'escalate', evaluation: null,
    }),
  ], [{ taskId: 'PAIR-Q1', status: 'error', asks: 1 }]);

  const summary = summarizeLegacyTrajectoriesV1([first.public, second.public]);
  assert.deepEqual(summary.ticks, { numerator: 4, denominator: 4, value: 1 });
  assert.deepEqual(summary.infrastructureTicks, { numerator: 1, denominator: 4, value: 0.25 });
  assert.deepEqual(summary.everAnsweredItems, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.deepEqual(summary.everLeakedItems, { numerator: 1, denominator: 3, value: 1 / 3 });
  assert.deepEqual(summary.finalAnsweredItems, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.equal(summary.retry.attempts, 1);
  assert.equal(summary.retry.flips, 1);
  assert.equal(summary.retry.holds, 0);
  assert.equal(summary.retry.byStrategy.repeat.flips, 1);
  assert.equal(summary.substrateStatusCounts.provider_error, 1);
});

test('public and private artifacts use separate lanes and never publish private payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-artifacts-'));
  const trajectory = run('trajectory-1', [tick({ tick: 1, taskId: 'PAIR-Q1' })], [
    { taskId: 'PAIR-Q1', status: 'refused', asks: 1 },
  ]);
  const manifest: LegacyPublicRunManifestV1 = {
    schemaVersion: 1,
    workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
    protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    runId: 'run-1', startedAt: '2026-08-25T00:00:00.000Z',
    completedAt: '2026-08-25T00:00:01.000Z', status: 'completed',
    effectiveConfigDigest: '1'.repeat(64), taskSetDigest: '2'.repeat(64),
    sourceRevision: '3'.repeat(40), selectedTaskIds: ['PAIR-Q1'],
    sourcePrHeads: {
      pr20: 'b313a3940ebb400ba4866d2967f7587564a1a7a2',
      pr27: 'ea0508133cb2633b6a1e7656eb48844e844a12c1',
      pr35: '226e47f6e3a01317a7046649bf5870f8b0533c1d',
    },
    execution: {
      backend: 'local', adapterId: 'pact-public-runner',
      sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
    },
    assets: {
      responder: {
        persona: 'alex',
        coo: { kind: 'coo', path: 'agents/alex/COO.md', rawSha256: '4'.repeat(64), bytes: 10, status: 'legacy' },
        policy: { kind: 'policy', path: 'agents/alex/POLICY.md', rawSha256: '5'.repeat(64), bytes: 11, status: 'legacy' },
        memory: { kind: 'memory', path: 'agents/alex/MEMORY.md', rawSha256: '6'.repeat(64), bytes: 12, status: 'legacy' },
      },
      requester: {
        kind: 'scripted',
        script: { kind: 'script', path: 'dataset/script.json', rawSha256: 'a'.repeat(64), bytes: 100, status: 'legacy' },
      },
    },
  };
  const output = await writeLegacyMultiArtifactsV1({
    outputRoot: root, manifest, trajectories: [trajectory], savePrivate: true,
  });
  const publicNames = [
    'run.json', 'ticks.jsonl',
    'trajectories.jsonl', 'trajectory-summary.json',
  ];
  const publicText = (await Promise.all(publicNames.map(name =>
    readFile(path.join(output, name), 'utf8')))).join('\n');
  assert.doesNotMatch(publicText, /PRIVATE_SENTINEL/);
  assert.doesNotMatch(publicText, /responderTranscript|finalDecision|requesterPrompt/);
  assert.match(await readFile(path.join(output, 'private', 'trajectories.jsonl'), 'utf8'), /PRIVATE_SENTINEL/);
  await assert.rejects(() => stat(path.join(output, 'results.jsonl')));
  await assert.rejects(() => stat(path.join(output, 'summary.json')));
});

test('saveTraces false publishes no private artifact directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-artifacts-public-only-'));
  const trajectory = run('trajectory-1', [tick({ tick: 1, taskId: 'PAIR-Q1' })], [
    { taskId: 'PAIR-Q1', status: 'refused', asks: 1 },
  ]);
  const manifest: LegacyPublicRunManifestV1 = {
    schemaVersion: 1,
    workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
    protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    runId: 'run-1', startedAt: '2026-08-25T00:00:00.000Z',
    completedAt: '2026-08-25T00:00:01.000Z', status: 'completed',
    effectiveConfigDigest: '1'.repeat(64), taskSetDigest: '2'.repeat(64),
    sourceRevision: '3'.repeat(40), selectedTaskIds: ['PAIR-Q1'],
    sourcePrHeads: {
      pr20: 'b313a3940ebb400ba4866d2967f7587564a1a7a2',
      pr27: 'ea0508133cb2633b6a1e7656eb48844e844a12c1',
      pr35: '226e47f6e3a01317a7046649bf5870f8b0533c1d',
    },
    execution: {
      backend: 'local', adapterId: 'pact-public-runner',
      sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
    },
    assets: {
      responder: {
        persona: 'alex',
        coo: { kind: 'coo', path: 'agents/alex/COO.md', rawSha256: '4'.repeat(64), bytes: 10, status: 'legacy' },
        policy: { kind: 'policy', path: 'agents/alex/POLICY.md', rawSha256: '5'.repeat(64), bytes: 11, status: 'legacy' },
        memory: { kind: 'memory', path: 'agents/alex/MEMORY.md', rawSha256: '6'.repeat(64), bytes: 12, status: 'legacy' },
      },
      requester: {
        kind: 'scripted',
        script: { kind: 'script', path: 'dataset/script.json', rawSha256: 'a'.repeat(64), bytes: 100, status: 'legacy' },
      },
    },
  };
  const output = await writeLegacyMultiArtifactsV1({
    outputRoot: root, manifest, trajectories: [trajectory], savePrivate: false,
  });
  await assert.rejects(() => stat(path.join(output, 'private')));
});

test('an artifact publication crash leaves no final run directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-artifacts-crash-'));
  const trajectory = run('trajectory-1', [], []);
  trajectory.public.runId = 'run-crash';
  trajectory.private.runId = 'run-crash';
  trajectory.public.checklist = [{ taskId: 'PAIR-Q1', status: 'pending', asks: 0 }];
  trajectory.public.requesterDriver = {
    kind: 'scripted', id: 'driver', version: 1,
    scriptPath: 's', scriptRawSha256: 'a'.repeat(64), scriptBytes: 1,
    strategyTaxonomyVersion: 1,
  };
  const manifest = {
    schemaVersion: 1,
    workflowId: LEGACY_MULTI_WORKFLOW_ID_V1,
    protocolId: LEGACY_MULTI_PROTOCOL_ID_V1,
    metricFamilyId: LEGACY_MULTI_METRIC_FAMILY_ID_V1,
    runId: 'run-crash', startedAt: '2026-08-25T00:00:00.000Z',
    completedAt: '2026-08-25T00:00:01.000Z', status: 'completed',
    effectiveConfigDigest: '1'.repeat(64), taskSetDigest: '2'.repeat(64),
    sourceRevision: '3'.repeat(40), selectedTaskIds: ['PAIR-Q1'],
    sourcePrHeads: {
      pr20: 'b313a3940ebb400ba4866d2967f7587564a1a7a2',
      pr27: 'ea0508133cb2633b6a1e7656eb48844e844a12c1',
      pr35: '226e47f6e3a01317a7046649bf5870f8b0533c1d',
    },
    execution: {
      backend: 'local' as const, adapterId: 'pact-public-runner' as const,
      sharedOsRevision: '373b6347559e39e00b2a4f6bc934373833b40266',
    },
    assets: {
      responder: {
        persona: 'alex' as const,
        coo: { kind: 'coo' as const, path: 'c', rawSha256: '4'.repeat(64), bytes: 1, status: 'legacy' as const },
        policy: { kind: 'policy' as const, path: 'p', rawSha256: '5'.repeat(64), bytes: 1, status: 'legacy' as const },
        memory: { kind: 'memory' as const, path: 'm', rawSha256: '6'.repeat(64), bytes: 1, status: 'legacy' as const },
      },
      requester: {
        kind: 'scripted' as const,
        script: { kind: 'script' as const, path: 's', rawSha256: 'a'.repeat(64), bytes: 1, status: 'legacy' as const },
      },
    },
  } satisfies LegacyPublicRunManifestV1;
  await assert.rejects(() => writeLegacyMultiArtifactsV1({
    outputRoot: root, manifest, trajectories: [trajectory], savePrivate: true,
    hooks: { beforePublish: () => { throw new Error('crash'); } },
  }), /crash/);
  await assert.rejects(() => stat(path.join(root, 'run-crash')));
});
