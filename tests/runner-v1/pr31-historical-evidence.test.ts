import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const evidenceRoot = resolve(repositoryRoot, 'rebuttal/evidence/pr31-ds-grid');
const tsxCli = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');

function runEvidenceCli(script: 'validate.ts' | 'launch.ts', args: string[] = []) {
  const environment = { ...process.env };
  delete environment.PACT_MODEL_API_KEY;
  return spawnSync(
    process.execPath,
    [tsxCli, resolve(evidenceRoot, script), ...args],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
    },
  );
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

test('validates the bounded PR 31 successor with deterministic exact counts', () => {
  const first = runEvidenceCli('validate.ts', ['--json']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = runEvidenceCli('validate.ts', ['--json']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(JSON.parse(first.stdout), {
    aggregateRecords: 16,
    completeness: 'incomplete',
    configurations: 49,
    executableConfigurations: 32,
    historicalOnlyConfigurations: 17,
    protocol: 'legacy-single-prompt',
    sourceHead: 'c86dc8a49cae12129d4d991b9691142a3357f463',
    status: 'historical',
  });
});

test('accounts for all 106 source files while preserving exactly 49 configs', () => {
  const manifestPath = join(evidenceRoot, 'manifest.json');
  assert.equal(existsSync(manifestPath), true, 'manifest.json must exist');
  const manifest = readJson(manifestPath);

  assert.equal(manifest.schemaVersion, 'pact-pr31-historical-evidence/v1');
  assert.equal(manifest.protocol, 'legacy-single-prompt');
  assert.equal(manifest.status, 'historical');
  assert.equal(manifest.completeness, 'incomplete');
  assert.deepEqual(manifest.source, {
    repository: 'xisen-w/PACT',
    pullRequest: 31,
    url: 'https://github.com/xisen-w/PACT/pull/31',
    head: 'c86dc8a49cae12129d4d991b9691142a3357f463',
    base: 'd195d4529966ecf32ee734abe35d90cf191c6967',
    reviewedAgainstMain: '514dd9c535481b3c4521f4871b082c8a1ca6d9e6',
    changedFiles: 106,
    sourceFileSetSha256:
      '14b837cf401e2b33e1c183538c5fd0a4eced9a58d17b216a4ef7575856f2e369',
    preservedConfigurationsSha256:
      '1ac16d62e5339c02551ade52ecf086c40f12495b394313b02bcf70e66e11747d',
  });
  assert.deepEqual(manifest.reportedRuntime, {
    protocol: 'legacy-single-prompt',
    status: 'historical',
    completeness: 'incomplete',
    sharedOsRevision: '846cbf6',
    revisionForm: 'abbreviated-as-reported',
    verification: 'not-independently-verified',
  });

  const configurations = manifest.configurations as any[];
  assert.equal(configurations.length, 49);
  assert.deepEqual(
    configurations.map(row => row.id),
    [...configurations.map(row => row.id)].sort(),
  );
  assert.equal(configurations.some(row => row.id === 'smoke_R1'), false);
  assert.equal(
    configurations.filter(row => row.disposition === 'executable-current-main').length,
    32,
  );
  assert.equal(
    configurations.filter(row => row.disposition === 'historical-only').length,
    17,
  );
  assert.equal(
    configurations.filter(row => row.policy.startsWith('REL_')).every(
      row => row.disposition === 'executable-current-main',
    ),
    true,
  );
  for (const row of configurations) {
    assert.equal(row.protocol, 'legacy-single-prompt');
    assert.equal(row.status, 'historical');
    assert.equal(row.completeness, 'incomplete');
    assert.match(row.sourceBlobSha, /^[a-f0-9]{40}$/);
    assert.match(row.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(row.taskSelectionSha256, /^[a-f0-9]{64}$/);
    if (row.disposition === 'historical-only') {
      assert.match(row.policy, /^(?:D2R_PRINCIPLES|D6_PRINCIPLES_TIGHT)$/);
    }
  }

  const exclusions = manifest.exclusions as Array<{ count: number; paths: string[] }>;
  const excludedPaths = exclusions.flatMap(group => {
    assert.equal(group.paths.length, group.count);
    return group.paths;
  });
  assert.equal(excludedPaths.length, 56);
  assert.equal(new Set(excludedPaths).size, 56);
  assert.equal(configurations.length + 1 + excludedPaths.length, 106);
  assert.ok(excludedPaths.includes('rebuttal/runs/configs_ds_grid/smoke_R1.yaml'));
  assert.ok(excludedPaths.includes(
    'rebuttal/runs/judge_agreement_out/agreement_report.json',
  ));
  assert.ok(excludedPaths.includes(
    'rebuttal/runs/judge_agreement_out/verdicts_gpt-5.6-luna.jsonl',
  ));
});

test('keeps only sanitized aggregate rows with explicit historical labels', () => {
  const aggregatesPath = join(evidenceRoot, 'aggregates.json');
  assert.equal(existsSync(aggregatesPath), true, 'aggregates.json must exist');
  const aggregates = readJson(aggregatesPath);
  assert.equal(aggregates.records.length, 16);
  assert.deepEqual(aggregates.source, {
    path: 'rebuttal/runs/configs_ds_grid/rescore_v2_3arms.json',
    gitBlobSha: '4c8a187721c85fecc203bf6af4214930467acf02',
    sha256: 'cb77e31192b5e60ca7f914a0b66664fe31b664eeacb523044bac5719a595b11d',
  });
  const forbiddenKeys = new Set([
    'question',
    'response',
    'gold',
    'goldAnswer',
    'expected_verdict',
    'labels',
  ]);
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden aggregate key ${key}`);
      inspect(child);
    }
  };
  inspect(aggregates);
  for (const row of aggregates.records) {
    assert.equal(row.protocol, 'legacy-single-prompt');
    assert.equal(row.status, 'historical');
    assert.equal(row.completeness, 'incomplete');
  }
});

test('rejects malformed provenance and historical-label drift', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pact-pr31-evidence-test-'));
  try {
    const privateSentinel = 'PRIVATE-GOLD-SENTINEL-DO-NOT-ECHO';
    const manifest = readJson(join(evidenceRoot, 'manifest.json'));
    manifest.configurations[0].protocol = 'current-default';
    manifest.configurations[1].sourceSha256 = 'not-a-digest';
    manifest.configurations[2].gold = privateSentinel;
    const mutated = join(temporary, 'manifest.json');
    writeFileSync(mutated, `${JSON.stringify(manifest)}\n`, 'utf8');
    const result = runEvidenceCli('validate.ts', ['--manifest', mutated, '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest validation failed/i);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(privateSentinel));

    const aggregates = readJson(join(evidenceRoot, 'aggregates.json'));
    aggregates.records[0].status = 'current';
    aggregates.records[0].response = privateSentinel;
    const mutatedAggregates = join(temporary, 'aggregates.json');
    writeFileSync(mutatedAggregates, `${JSON.stringify(aggregates)}\n`, 'utf8');
    const aggregateResult = runEvidenceCli('validate.ts', [
      '--aggregates', mutatedAggregates, '--json',
    ]);
    assert.notEqual(aggregateResult.status, 0);
    assert.match(aggregateResult.stderr, /manifest validation failed/i);
    assert.doesNotMatch(
      `${aggregateResult.stdout}${aggregateResult.stderr}`,
      new RegExp(privateSentinel),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('portable launcher is explicit, deterministic, and refuses historical-only configs', () => {
  const missingMode = runEvidenceCli('launch.ts');
  assert.equal(missingMode.status, 2);
  assert.match(missingMode.stderr, /choose --list or provide --mode/i);

  const firstList = runEvidenceCli('launch.ts', ['--list']);
  const secondList = runEvidenceCli('launch.ts', ['--list']);
  assert.equal(firstList.status, 0, firstList.stderr);
  assert.equal(secondList.status, 0, secondList.stderr);
  assert.equal(secondList.stdout, firstList.stdout);
  const listed = JSON.parse(firstList.stdout);
  assert.equal(listed.length, 32);
  assert.equal(listed.some((row: any) => row.id === 'smoke_R1'), false);

  const checked = runEvidenceCli('launch.ts', [
    '--mode', 'check',
    '--config', 'smoke_R1_pinned',
    '--repo-root', repositoryRoot,
    '--sharedos-dir', resolve(repositoryRoot, '..', 'SharedOS'),
  ]);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout), {
    config: 'smoke_R1_pinned',
    mode: 'check',
    taskCount: 3,
  });

  const historical = runEvidenceCli('launch.ts', [
    '--mode', 'check',
    '--config', 'd2r_R0',
  ]);
  assert.equal(historical.status, 2);
  assert.match(historical.stderr, /historical-only.*D2R_PRINCIPLES/i);

  const noCredential = runEvidenceCli('launch.ts', [
    '--mode', 'run',
    '--config', 'smoke_R1_pinned',
  ]);
  assert.equal(noCredential.status, 2);
  assert.match(noCredential.stderr, /PACT_MODEL_API_KEY must be set/i);
});

test('committed evidence contains no personal paths, secrets, or raw artifacts', () => {
  const trackedAssetNames = [
    'README.md',
    'aggregates.json',
    'launch.ts',
    'manifest.json',
    'schema.ts',
    'validate.ts',
  ];
  assert.deepEqual(readdirSync(evidenceRoot).sort(), trackedAssetNames);
  for (const name of trackedAssetNames) {
    const path = join(evidenceRoot, name);
    assert.equal(existsSync(path), true, `${name} must exist`);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\/Users\//);
    assert.doesNotMatch(source, /\/home\/[^/]+\//);
    assert.doesNotMatch(source, /(?:^|\W)OPENROUTER_API_KEY(?:\W|$)/);
    assert.doesNotMatch(source, /(?:^|\W)source\s+[^\n]*\.env/);
    assert.doesNotMatch(source, /\bsk-[A-Za-z0-9_-]{8,}\b/);
  }

  const forbiddenCommittedPaths = [
    'smoke_R1.yaml',
    'agreement_report.json',
    'sample.jsonl',
    'verdicts_gpt-5-mini.jsonl',
    'verdicts_gpt-5.6-luna.jsonl',
  ];
  for (const relative of forbiddenCommittedPaths) {
    assert.equal(existsSync(join(evidenceRoot, relative)), false);
  }
});
