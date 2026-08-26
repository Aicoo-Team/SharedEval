import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  SHAREDOS_RUNTIME_PACKAGES_V1,
  SHAREDOS_VERIFIED_REVISION_V1,
  SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
  digestSharedOsRuntimeV1,
  loadSharedOsModulesV1,
  parseSharedOsModulesV1,
} from '../../src/execution/sharedos/v1/load-sharedos.js';
import type { SoMessageEnvelope } from '../../src/execution/sharedos/v1/contracts.js';

const REQUIRED_EXPORTS = {
  contracts: [
    'AccessContextSchema',
    'CapabilityGrantSchema',
    'ExecutionRequestSchema',
    'ExecutionResultSchema',
    'MessageDeliveryResultSchema',
    'MessageEnvelopeSchema',
    'ResourceOperationSchema',
    'ResourceResultSchema',
    'ToolCallSchema',
    'ToolDefinitionSchema',
    'ToolResultSchema',
  ],
  core: [
    'SharedOSKernel',
    'CapabilityAuthorizer',
    'RecipientScopedMessageCapabilityResolver',
    'agentExecutionCapability',
    'messageSendCapability',
    'MESSAGE_REQUEST_TOOL_DEFINITION',
  ],
  os: ['createFileTools'],
  runtime: ['StandardRuntime', 'SharedOSExecutor'],
} as const;

function validModules(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(REQUIRED_EXPORTS).map(([packageName, names]) => [
      packageName,
      Object.fromEntries(names.map(name => [
        name,
        name.endsWith('Schema')
          ? { parse: (value: unknown) => value }
          : name === 'MESSAGE_REQUEST_TOOL_DEFINITION'
            ? { name: 'messages.request' }
            : function RequiredExport() {},
      ])),
    ]),
  );
}

test('loader pins exactly the four production SharedOS packages', () => {
  assert.deepEqual(SHAREDOS_RUNTIME_PACKAGES_V1, [
    'contracts',
    'core',
    'os',
    'runtime',
  ]);
  assert.equal(SHAREDOS_VERIFIED_REVISION_V1, 'a303d97fe974c149d4575b1f5d6426aee6f37367');
  assert.equal(
    SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1,
    'faefbf2ae61ffdcaf57f76e0c5b9b3f1438790213c0f16b3e02905bdbcba37cb',
  );
});

test('module parsing rejects every missing production export before execution', () => {
  const complete = validModules();
  assert.deepEqual(Object.keys(parseSharedOsModulesV1(complete)).sort(), [
    'contracts',
    'core',
    'os',
    'runtime',
  ]);

  for (const [packageName, names] of Object.entries(REQUIRED_EXPORTS)) {
    for (const name of names) {
      const candidate = validModules();
      delete candidate[packageName]?.[name];
      assert.throws(
        () => parseSharedOsModulesV1(candidate),
        new RegExp(`${packageName}.*${name}`),
      );
    }
  }
});

test('module parsing rejects the production testkit as a runtime dependency', () => {
  assert.throws(
    () => parseSharedOsModulesV1({ ...validModules(), testkit: {} }),
    /unexpected SharedOS module testkit/,
  );
});

test('the pinned real build has the expected package names, digest, and exports', async t => {
  const directory = resolve(
    process.env.SHAREDEVAL_SHAREDOS_DIR
      ?? '/private/tmp/sharedos-message-foundation.NkahQk/repo',
  );
  if (!existsSync(join(directory, 'packages', 'core', 'dist', 'index.js'))) {
    if (process.env.SHAREDEVAL_REQUIRE_SHAREDOS) {
      assert.fail(`required SharedOS build is unavailable at ${directory}`);
    }
    t.skip(`SharedOS build is unavailable at ${directory}`);
    return;
  }

  const packageNames = Object.fromEntries(
    SHAREDOS_RUNTIME_PACKAGES_V1.map(packageName => {
      const manifest = JSON.parse(
        readFileSync(join(directory, 'packages', packageName, 'package.json'), 'utf8'),
      ) as { name?: unknown };
      return [packageName, manifest.name];
    }),
  );
  assert.deepEqual(packageNames, {
    contracts: '@aicoo/sharedos-contracts',
    core: '@aicoo/sharedos-core',
    os: '@aicoo/sharedos-os',
    runtime: '@aicoo/sharedos-runtime',
  });
  assert.equal(digestSharedOsRuntimeV1(directory), SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1);

  const loaded = await loadSharedOsModulesV1(directory);
  assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.reason);
  if (!loaded.ok) return;
  assert.equal(loaded.revision, SHAREDOS_VERIFIED_REVISION_V1);
  assert.equal(loaded.runtimeDigest, SHAREDOS_VERIFIED_RUNTIME_DIGEST_V1);
  assert.equal(loaded.modules.core.MESSAGE_REQUEST_TOOL_DEFINITION.name, 'messages.request');

  const envelope: SoMessageEnvelope = {
    version: '1',
    id: 'message-provenance-check',
    sender: { kind: 'agent', agentId: 'requester' },
    receiver: { kind: 'agent', agentId: 'responder' },
    purpose: 'sharedeval:pact-pair',
    payload: { taskId: 'PAIR-Q1' },
    traceId: 'trace-provenance-check',
    createdAt: '2026-08-26T00:00:00.000Z',
    provenance: {
      source: 'sharedeval',
      parentIds: ['heartbeat-provenance-check'],
      metadata: { phase: 'request' },
    },
  };
  assert.deepEqual(
    loaded.modules.contracts.MessageEnvelopeSchema.parse(envelope),
    envelope,
  );
});
