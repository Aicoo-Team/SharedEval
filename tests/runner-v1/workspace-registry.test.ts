import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const canonicalRoot = join(
  repoRoot,
  'dataset',
  'shared-eval',
  'workspaces',
  'v1',
);

type RegistryModule = typeof import('../../src/runner/v1/workspace-registry.js');

function loadSubject(): Promise<RegistryModule> {
  return import('../../src/runner/v1/workspace-registry.js');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixtureAsset(overrides: Record<string, unknown> = {}) {
  const bytes = Buffer.from('fixture\n');
  return {
    id: 'fixture/agent',
    version: '1.0.0',
    actorRoles: ['requester'],
    sourcePath: 'agents/fixture/base/AGENT.md',
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    aliases: ['legacy/fixture/AGENT.md'],
    status: 'active',
    compatibleDatasets: ['pact-pair'],
    compatibleWorkflowIds: ['files-multi'],
    ...overrides,
  };
}

function fixtureRegistry(assets: unknown[]) {
  return {
    apiVersion: 'sharedeval/workspace-registry/v1',
    kind: 'WorkspaceRegistry',
    assets,
  };
}

test('loads the canonical registry in stable lexical order with exactly four base slots per PACT-Pair agent', async () => {
  const { loadWorkspaceRegistryV1 } = await loadSubject();
  const registry = await loadWorkspaceRegistryV1({ rootDir: canonicalRoot });

  const keys = registry.assets.map(asset => `${asset.id}@${asset.version}`);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);

  for (const agent of ['alex', 'dana', 'jordan', 'marcus', 'tina']) {
    const prefix = `agents/${agent}/base/`;
    const slots = registry.assets
      .filter(asset => asset.sourcePath.startsWith(prefix))
      .map(asset => asset.sourcePath.slice(prefix.length))
      .sort();
    assert.deepEqual(slots, [
      'AGENT.md',
      'HEARTBEAT.md',
      'MEMORY.md',
      'POLICY.md',
    ]);
    assert.ok(!slots.includes('COO.md'));
    assert.ok(!slots.includes('USER.md'));
  }
});

test('resolves every executable canonical asset with exact UTF-8 bytes, byte count, and SHA-256', async () => {
  const { loadWorkspaceRegistryV1, resolveWorkspaceRegistryAssetV1 } =
    await loadSubject();
  const registry = await loadWorkspaceRegistryV1({ rootDir: canonicalRoot });

  let resolved = 0;
  for (const asset of registry.assets) {
    if (asset.status === 'draft' || asset.status === 'incomplete') continue;
    const result = await resolveWorkspaceRegistryAssetV1({
      rootDir: canonicalRoot,
      registry,
      id: asset.id,
      version: asset.version,
      actorRole: asset.actorRoles[0]!,
      datasetId: asset.compatibleDatasets[0]!,
      workflowId: asset.compatibleWorkflowIds[0]!,
    });
    const bytes = Buffer.from(result.bytesBase64, 'base64');
    assert.equal(bytes.toString('utf8'), result.content);
    assert.equal(bytes.byteLength, result.byteLength);
    assert.equal(result.byteLength, asset.byteLength);
    assert.equal(sha256(bytes), result.sha256);
    assert.equal(result.sha256, asset.sha256);
    resolved += 1;
  }
  assert.ok(resolved >= 20, 'the five four-file templates must be executable');
});

test('keeps PACT canonical paths and Pulse provenance aliases without collapsing same-basename policies', async () => {
  const { loadWorkspaceRegistryV1 } = await loadSubject();
  const registry = await loadWorkspaceRegistryV1({ rootDir: canonicalRoot });

  const pulseAliases = registry.assets.flatMap(asset => asset.aliases)
    .filter(alias => alias.startsWith('pulse:'));
  assert.ok(pulseAliases.length > 0);
  assert.ok(registry.assets.every(asset => !asset.sourcePath.startsWith('pulse:')));

  const legacyPolicyEntries = registry.assets.filter(asset =>
    asset.aliases.some(alias => alias.split('/').at(-1) === 'POLICY.md')
  );
  assert.ok(legacyPolicyEntries.length >= 2);
  assert.ok(new Set(legacyPolicyEntries.map(asset => asset.id)).size >= 2);
});

test('preserves the active D0 policy as an exact executable zero-byte asset', async () => {
  const { loadWorkspaceRegistryV1, resolveWorkspaceRegistryAssetV1 } =
    await loadSubject();
  const registry = await loadWorkspaceRegistryV1({ rootDir: canonicalRoot });
  const asset = registry.assets.find(candidate =>
    candidate.id === 'policies/pact-pair-defense/d0'
  );
  assert.ok(asset);
  const resolved = await resolveWorkspaceRegistryAssetV1({
    rootDir: canonicalRoot,
    registry,
    id: asset.id,
    version: asset.version,
    actorRole: 'responder',
    datasetId: 'pact-pair',
    workflowId: 'files-single',
  });
  assert.equal(resolved.content, '');
  assert.equal(resolved.bytesBase64, '');
  assert.equal(resolved.byteLength, 0);
  assert.equal(
    resolved.sha256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('strict registry parsing rejects unsafe, ambiguous, unordered, or incomplete metadata', async t => {
  const { parseWorkspaceRegistryV1 } = await loadSubject();
  const cases: Array<[string, unknown, RegExp]> = [
    [
      'path traversal',
      fixtureRegistry([fixtureAsset({ sourcePath: '../AGENT.md' })]),
      /sourcePath|relative|traversal/i,
    ],
    [
      'absolute path',
      fixtureRegistry([fixtureAsset({ sourcePath: '/tmp/AGENT.md' })]),
      /sourcePath|relative/i,
    ],
    [
      'Windows separator',
      fixtureRegistry([fixtureAsset({ sourcePath: 'agents\\fixture\\AGENT.md' })]),
      /sourcePath|relative/i,
    ],
    [
      'legacy COO slot',
      fixtureRegistry([fixtureAsset({ sourcePath: 'agents/fixture/base/COO.md' })]),
      /AGENT|HEARTBEAT|POLICY|MEMORY|sourcePath/i,
    ],
    [
      'legacy USER slot',
      fixtureRegistry([fixtureAsset({ sourcePath: 'agents/fixture/base/USER.md' })]),
      /AGENT|HEARTBEAT|POLICY|MEMORY|sourcePath/i,
    ],
    [
      'legacy COO alias',
      fixtureRegistry([fixtureAsset({ aliases: ['legacy/fixture/COO.md'] })]),
      /alias|COO/i,
    ],
    [
      'legacy USER alias',
      fixtureRegistry([fixtureAsset({ aliases: ['legacy/fixture/USER.md'] })]),
      /alias|USER/i,
    ],
    [
      'invalid role',
      fixtureRegistry([fixtureAsset({ actorRoles: ['owner'] })]),
      /actorRoles|requester|responder/i,
    ],
    [
      'missing explicit status',
      fixtureRegistry([(() => {
        const asset = fixtureAsset();
        delete (asset as { status?: unknown }).status;
        return asset;
      })()]),
      /status/i,
    ],
    [
      'duplicate id and version',
      fixtureRegistry([fixtureAsset(), fixtureAsset()]),
      /duplicate|unique|id.*version/i,
    ],
    [
      'unstable entry order',
      fixtureRegistry([
        fixtureAsset({ id: 'fixture/z' }),
        fixtureAsset({ id: 'fixture/a', sourcePath: 'agents/fixture/base/MEMORY.md' }),
      ]),
      /lexical|order|sorted/i,
    ],
    [
      'unknown registry field',
      { ...fixtureRegistry([fixtureAsset()]), signature: 'not-part-of-v1' },
      /unrecognized|signature/i,
    ],
    [
      'unknown asset field',
      fixtureRegistry([fixtureAsset({ publicKey: 'not-part-of-v1' })]),
      /unrecognized|publicKey/i,
    ],
  ];

  for (const [name, value, error] of cases) {
    await t.test(name, () => {
      assert.throws(() => parseWorkspaceRegistryV1(value), error);
    });
  }
});

test('raw workspace byte loading rejects runtime path traversal outside the four slots', async () => {
  const { loadAgentWorkspaceRawFileV1 } = await import(
    '../../src/runner/v1/agent-workspace.js'
  );
  const containerDir = await mkdtemp(join(tmpdir(), 'sharedeval-raw-file-'));
  const rootDir = join(containerDir, 'workspace');
  try {
    await mkdir(rootDir);
    await writeFile(join(containerDir, 'AGENT.md'), 'outside\n');
    await assert.rejects(
      () => loadAgentWorkspaceRawFileV1({
        rootDir,
        path: '../AGENT.md' as never,
      }),
      /path|AGENT\.md|four workspace files/i,
    );
  } finally {
    await rm(containerDir, { recursive: true, force: true });
  }
});

test('resolves an exact four-slot workspace without changing the existing template return shape', async () => {
  const {
    parseWorkspaceRegistryV1,
    resolveAgentWorkspaceRegistryV1,
  } = await loadSubject();
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-registry-'));
  try {
    const contents = {
      agent: 'agent\n',
      heartbeat: 'heartbeat\n',
      policy: 'policy\n',
      memory: 'memory\n',
    } as const;
    const slots = {
      agent: 'AGENT.md',
      heartbeat: 'HEARTBEAT.md',
      policy: 'POLICY.md',
      memory: 'MEMORY.md',
    } as const;
    const assets = Object.entries(slots).map(([slot, fileName]) => {
      const content = contents[slot as keyof typeof contents];
      const bytes = Buffer.from(content);
      return fixtureAsset({
        id: `fixture/${slot}`,
        sourcePath: `agents/fixture/base/${fileName}`,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    await mkdir(join(rootDir, 'agents', 'fixture', 'base'), { recursive: true });
    await Promise.all(Object.entries(slots).map(([slot, fileName]) =>
      writeFile(
        join(rootDir, 'agents', 'fixture', 'base', fileName),
        contents[slot as keyof typeof contents],
      )
    ));
    const registry = parseWorkspaceRegistryV1(fixtureRegistry(assets));
    const references = {
      agent: { id: 'fixture/agent', version: '1.0.0' },
      heartbeat: { id: 'fixture/heartbeat', version: '1.0.0' },
      policy: { id: 'fixture/policy', version: '1.0.0' },
      memory: { id: 'fixture/memory', version: '1.0.0' },
    };

    const resolved = await resolveAgentWorkspaceRegistryV1({
      rootDir,
      registry,
      references,
      actorRole: 'requester',
      datasetId: 'pact-pair',
      workflowId: 'files-multi',
    });
    assert.deepEqual(resolved.template, {
      apiVersion: 'sharedeval/agent-workspace/v1',
      kind: 'AgentWorkspaceTemplate',
      files: {
        agent: {
          path: 'AGENT.md',
          access: 'read_only',
          content: 'agent\n',
          sha256: sha256(Buffer.from('agent\n')),
        },
        heartbeat: {
          path: 'HEARTBEAT.md',
          access: 'read_only',
          content: 'heartbeat\n',
          sha256: sha256(Buffer.from('heartbeat\n')),
        },
        policy: {
          path: 'POLICY.md',
          access: 'read_only',
          content: 'policy\n',
          sha256: sha256(Buffer.from('policy\n')),
        },
        memory: {
          path: 'MEMORY.md',
          access: 'read_write',
          content: 'memory\n',
          sha256: sha256(Buffer.from('memory\n')),
        },
      },
    });
    assert.deepEqual(Object.keys(resolved.assets).sort(), [
      'agent',
      'heartbeat',
      'memory',
      'policy',
    ]);

    await assert.rejects(
      () => resolveAgentWorkspaceRegistryV1({
        rootDir,
        registry,
        references: { ...references, COO: references.agent } as never,
        actorRole: 'requester',
        datasetId: 'pact-pair',
        workflowId: 'files-multi',
      }),
      /unrecognized|COO|exactly four/i,
    );
    await assert.rejects(
      () => resolveAgentWorkspaceRegistryV1({
        rootDir,
        registry,
        references: { ...references, USER: references.agent } as never,
        actorRole: 'requester',
        datasetId: 'pact-pair',
        workflowId: 'files-multi',
      }),
      /unrecognized|USER|exactly four/i,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects draft ablations and incomplete PACT-Net profiles before execution', async () => {
  const { loadWorkspaceRegistryV1, resolveWorkspaceRegistryAssetV1 } =
    await loadSubject();
  const registry = await loadWorkspaceRegistryV1({ rootDir: canonicalRoot });
  const drafts = registry.assets.filter(asset => asset.status === 'draft');
  assert.deepEqual(
    drafts.map(asset => asset.id),
    ['policies/pact-pair-ablation/m6', 'policies/pact-pair-ablation/m7', 'policies/pact-pair-ablation/m8'],
  );
  const incomplete = registry.assets.filter(asset => asset.status === 'incomplete');
  assert.ok(incomplete.some(asset => asset.id.startsWith('policies/pact-net-profile/')));

  for (const asset of [...drafts, ...incomplete]) {
    await assert.rejects(
      () => resolveWorkspaceRegistryAssetV1({
        rootDir: canonicalRoot,
        registry,
        id: asset.id,
        version: asset.version,
        actorRole: asset.actorRoles[0]!,
        datasetId: asset.compatibleDatasets[0]!,
        workflowId: asset.compatibleWorkflowIds[0]!,
      }),
      new RegExp(asset.status, 'i'),
    );
  }
});

test('fails closed on incompatible selection and unsafe asset filesystem objects', async t => {
  const {
    parseWorkspaceRegistryV1,
    resolveWorkspaceRegistryAssetV1,
  } = await loadSubject();
  const makeRegistry = (overrides: Record<string, unknown> = {}) =>
    parseWorkspaceRegistryV1(fixtureRegistry([fixtureAsset(overrides)]));

  await t.test('actor role, dataset, and workflow incompatibility', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-registry-'));
    try {
      await mkdir(join(rootDir, 'agents', 'fixture', 'base'), { recursive: true });
      await writeFile(join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md'), 'fixture\n');
      const registry = makeRegistry();
      const base = {
        rootDir,
        registry,
        id: 'fixture/agent',
        version: '1.0.0',
        actorRole: 'requester' as const,
        datasetId: 'pact-pair',
        workflowId: 'files-multi' as const,
      };
      await assert.rejects(
        () => resolveWorkspaceRegistryAssetV1({ ...base, actorRole: 'responder' }),
        /role|responder/i,
      );
      await assert.rejects(
        () => resolveWorkspaceRegistryAssetV1({ ...base, datasetId: 'pact-net' }),
        /dataset|pact-net/i,
      );
      await assert.rejects(
        () => resolveWorkspaceRegistryAssetV1({ ...base, workflowId: 'files-single' }),
        /workflow|files-single/i,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  const filesystemCases: Array<[
    string,
    (rootDir: string) => Promise<Record<string, unknown> | void>,
    RegExp,
  ]> = [
    ['missing file', async () => undefined, /missing|ENOENT|AGENT\.md/i],
    ['symbolic link', async rootDir => {
      await writeFile(join(rootDir, 'outside.md'), 'fixture\n');
      await symlink('../../../outside.md', join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md'));
    }, /symbolic link|regular file/i],
    ['FIFO', async rootDir => {
      execFileSync('mkfifo', [join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md')]);
    }, /regular file/i],
    ['oversized file', async rootDir => {
      await writeFile(
        join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md'),
        'a'.repeat(1_048_577),
      );
    }, /exceeds 1048576 bytes/i],
    ['invalid UTF-8', async rootDir => {
      await writeFile(
        join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md'),
        Buffer.from([0xff, 0xfe]),
      );
    }, /valid UTF-8/i],
    ['wrong byte length', async rootDir => {
      await writeFile(join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md'), 'fixture\n');
      return { byteLength: 999 };
    }, /byte length|byteLength/i],
    ['wrong SHA-256', async rootDir => {
      await writeFile(join(rootDir, 'agents', 'fixture', 'base', 'AGENT.md'), 'fixture\n');
      return { sha256: '0'.repeat(64) };
    }, /SHA-256|sha256|digest/i],
  ];

  for (const [name, setup, error] of filesystemCases) {
    await t.test(name, { skip: name === 'FIFO' && process.platform === 'win32' }, async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-registry-'));
      try {
        await mkdir(join(rootDir, 'agents', 'fixture', 'base'), { recursive: true });
        const overrides = await setup(rootDir) ?? {};
        const registry = makeRegistry(overrides);
        await assert.rejects(
          () => resolveWorkspaceRegistryAssetV1({
            rootDir,
            registry,
            id: 'fixture/agent',
            version: '1.0.0',
            actorRole: 'requester',
            datasetId: 'pact-pair',
            workflowId: 'files-multi',
          }),
          error,
        );
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  }
});
