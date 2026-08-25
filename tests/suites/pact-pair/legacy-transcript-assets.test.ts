import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CANONICAL_LEGACY_SCRIPT_SHA256_V1,
  freezeLegacyAssetV1,
  freezeLegacyMultiAssetsV1,
} from '../../../src/suites/pact-pair/legacy-transcript/assets.js';
import { parseLegacyMultiConfigV1Yaml } from '../../../src/suites/pact-pair/legacy-transcript/config.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pact-legacy-assets-'));
  await mkdir(join(root, 'agents', 'alex'), { recursive: true });
  await writeFile(join(root, 'agents', 'alex', 'COO.md'), 'coo\n');
  await writeFile(join(root, 'agents', 'alex', 'POLICY.md'), 'policy\n');
  await writeFile(join(root, 'agents', 'alex', 'MEMORY.md'), 'memory\n');
  await writeFile(join(root, 'script.json'), '{"id":"fixture","version":1,"description":"fixture","strategyTemplates":{"repeat":"again {{prompt}}","business_justification":"business {{prompt}}","urgency":"urgent {{prompt}}","social_appeal":"please {{prompt}}","decomposition":"narrow {{prompt}}"},"strategyRotation":["repeat"]}\n');
  return root;
}

function configForAssets(): ReturnType<typeof parseLegacyMultiConfigV1Yaml> {
  return parseLegacyMultiConfigV1Yaml(`
apiVersion: pact-run/v1
kind: RunConfig
backend: { kind: local }
model: { provider: openai-compatible, baseUrl: https://example.test/v1, apiKeyEnv: PACT_MODEL_API_KEY, model: responder, maxOutputTokens: 100 }
benchmark:
  dataset: pact-pair
  policy: D2
  requester: R4
  gradingMode: category
  tasks: { kind: qa, ids: [Q156] }
  execution: { adapter: pact-public-runner }
  agentConfig: { persona: alex, coo: agents/alex/COO.md, policy: agents/alex/POLICY.md, memory: agents/alex/MEMORY.md }
  trajectory:
    maxTicks: 1
    count: 1
    maxRuntimeMs: 1000
    requesterDriver: { kind: scripted, script: script.json }
budget: { maxTurns: 1, maxToolCalls: 1, maxRuntimeMs: 1000 }
output: { directory: runs, saveTraces: false }
`);
}

test('asset freezing preserves raw bytes, hash, length, relative path, and legacy status', async () => {
  const root = await fixtureRoot();
  const asset = await freezeLegacyAssetV1(root, 'agents/alex/COO.md', 'coo');
  assert.equal(decoder.decode(asset.bytes), 'coo\n');
  assert.deepEqual(asset.provenance, {
    kind: 'coo',
    path: 'agents/alex/COO.md',
    rawSha256: 'f2e160c43d334218332c98d64b80dd52f1ce1054882fe89aeb236a1c01f70c08',
    bytes: 4,
    status: 'legacy',
  });
  assert.equal(Object.isFrozen(asset), true);
});

test('canonical legacy scripted requester bytes retain the reviewed PR 35 digest', async () => {
  const repositoryRoot = process.cwd();
  const asset = await freezeLegacyAssetV1(
    repositoryRoot,
    'dataset/pact-pair/legacy-transcript/scripted_driver_v1.json',
    'script',
  );
  assert.equal(asset.provenance.rawSha256, CANONICAL_LEGACY_SCRIPT_SHA256_V1);
  assert.equal(asset.provenance.rawSha256, 'b7debe7e21e4d62cb3595e428a78b0a128028cb980f9ffe19afada04a4997510');
  assert.equal(asset.provenance.bytes, 1140);
});

test('asset freezing rejects symlinks, root symlinks, path escape, oversized bytes, invalid UTF-8, and FIFO', async () => {
  const root = await fixtureRoot();
  await symlink(join(root, 'agents', 'alex', 'COO.md'), join(root, 'coo-link.md'));
  await writeFile(join(root, 'oversized.md'), Buffer.alloc(1_048_577, 0x61));
  await writeFile(join(root, 'invalid.md'), Buffer.from([0xc3, 0x28]));
  const fifo = join(root, 'named-pipe');
  execFileSync('mkfifo', [fifo]);
  const rootLink = `${root}-link`;
  await symlink(root, rootLink);

  await assert.rejects(() => freezeLegacyAssetV1(root, 'coo-link.md', 'coo'), /symbolic link|regular file/i);
  await assert.rejects(() => freezeLegacyAssetV1(rootLink, 'agents/alex/COO.md', 'coo'), /root|symbolic link/i);
  await assert.rejects(() => freezeLegacyAssetV1(root, '../outside.md', 'coo'), /relative|escape/i);
  await assert.rejects(() => freezeLegacyAssetV1(root, 'oversized.md', 'coo'), /1048576|size/i);
  await assert.rejects(() => freezeLegacyAssetV1(root, 'invalid.md', 'coo'), /UTF-8/i);
  await assert.rejects(() => freezeLegacyAssetV1(root, 'named-pipe', 'coo'), /regular file/i);
});

test('asset freezing detects a descriptor mutation between read and final fstat', async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    () => freezeLegacyAssetV1(root, 'agents/alex/COO.md', 'coo', {
      afterRead: async path => {
        await chmod(path, 0o600);
        await writeFile(path, 'changed\n');
      },
    }),
    /changed while being read/i,
  );
});

test('one preflight freezes responder and scripted requester assets exactly once', async () => {
  const root = await fixtureRoot();
  const assets = await freezeLegacyMultiAssetsV1(root, configForAssets());
  assert.equal(assets.responder.coo.provenance.bytes, 4);
  assert.equal(assets.responder.policy.provenance.bytes, 7);
  assert.equal(assets.responder.memory.provenance.bytes, 7);
  assert.equal(assets.requester.kind, 'scripted');
  if (assets.requester.kind !== 'scripted') assert.fail('expected scripted requester');
  assert.equal(assets.requester.script.provenance.kind, 'script');
  assert.equal(Object.isFrozen(assets), true);
});
