import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jsonValueSchema,
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  pactRuntimeV1Schema,
  pactSubmissionManifestV1Schema,
  pactTaskIntroV1Schema,
  toPublicPactTaskIntroV1,
} from '../../src/protocol/v1/index.js';
import { deniedAccessV1, validManifestV1, validRunInitV1, validTaskV1 } from './fixtures.js';

test('accepts the canonical PACT-Pair v1 manifest', () => {
  assert.deepEqual(pactSubmissionManifestV1Schema.parse(validManifestV1), validManifestV1);
});

test('enforces Semantic Versioning 2.0.0 identifiers', () => {
  for (const version of ['0.0.0', '1.2.3-alpha.1', '1.2.3-alpha-01+build.007']) {
    assert.doesNotThrow(() =>
      pactSubmissionManifestV1Schema.parse({ ...validManifestV1, version }),
    );
  }
  for (const version of ['1.0.0-.', '1.0.0-01', '1.0.0+a..b']) {
    assert.throws(() =>
      pactSubmissionManifestV1Schema.parse({ ...validManifestV1, version }),
    );
  }
});

test('rejects unsupported tracks and unknown manifest fields', () => {
  assert.throws(() =>
    pactSubmissionManifestV1Schema.parse({
      ...validManifestV1,
      track: 'pact-net',
    }),
  );
  assert.throws(() =>
    pactSubmissionManifestV1Schema.parse({
      ...validManifestV1,
      privileged: true,
    }),
  );
});

test('rejects manifest paths that escape the submission root', () => {
  assert.throws(() =>
    pactSubmissionManifestV1Schema.parse({
      ...validManifestV1,
      runtime: {
        kind: 'local-ts',
        entrypoint: '../../pulse/lib/secrets.ts',
      },
    }),
  );
  assert.throws(() =>
    pactSubmissionManifestV1Schema.parse({
      ...validManifestV1,
      runtime: {
        kind: 'local-ts',
        entrypoint: '/tmp/submission.ts',
      },
    }),
  );
  assert.throws(() =>
    pactSubmissionManifestV1Schema.parse({
      ...validManifestV1,
      runtime: {
        kind: 'local-ts',
        entrypoint: '$(cat-secret)/index.ts',
      },
    }),
  );
  assert.throws(() =>
    pactSubmissionManifestV1Schema.parse({
      ...validManifestV1,
      runtime: {
        kind: 'local-ts',
        entrypoint: 'src\nindex.ts',
      },
    }),
  );
});

test('accepts source builds and rejects prebuilt images in protocol v1', () => {
  assert.doesNotThrow(() =>
    pactRuntimeV1Schema.parse({
      kind: 'docker',
      protocol: 'jsonrpc-stdio/v1',
      source: {
        kind: 'build',
        context: '.',
        dockerfile: 'Dockerfile',
      },
      network: 'disabled',
    }),
  );
  assert.throws(() =>
    pactRuntimeV1Schema.parse({
      kind: 'docker',
      protocol: 'jsonrpc-stdio/v1',
      source: {
        kind: 'image',
        image: `ghcr.io/example/pact-agent@sha256:${'a'.repeat(64)}`,
      },
      network: 'disabled',
    }),
  );
});

test('accepts JSON values and rejects non-JSON values', () => {
  assert.deepEqual(jsonValueSchema.parse({ nested: [true, null, 3, 'ok'] }), {
    nested: [true, null, 3, 'ok'],
  });
  assert.throws(() => jsonValueSchema.parse({ missing: undefined }));
  assert.throws(() => jsonValueSchema.parse({ value: Number.NaN }));
  assert.throws(() => jsonValueSchema.parse({ value: Number.POSITIVE_INFINITY }));
  assert.throws(() => jsonValueSchema.parse({ value: 1n }));
  assert.throws(() => jsonValueSchema.parse({ value: new Date() }));
});

test('rejects reserved JSON object keys instead of silently dropping them', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = JSON.parse(`{"${key}": {"private": true}}`) as unknown;
    assert.throws(() => jsonValueSchema.parse(value), /reserved JSON object keys/);
  }
});

test('rejects private benchmark fields at the adapter task boundary', () => {
  const privateCanary = 'PACT_PRIVATE_CANARY_DO_NOT_EXPOSE';
  assert.throws(() =>
    pactTaskIntroV1Schema.parse({
      ...validTaskV1,
      gold_key_facts: [privateCanary],
      expected_verdict: 'refuse',
      relational_labels: { requester: 'P' },
    }),
  );
});

test('projects private task records through an explicit public allowlist', () => {
  const privateCanary = 'PACT_PRIVATE_CANARY_DO_NOT_EXPOSE';
  const privateTask = {
    ...validTaskV1,
    requester: {
      ...validTaskV1.requester,
      relationalLabel: privateCanary,
    },
    target: {
      ...validTaskV1.target,
      sourceNotes: [privateCanary],
    },
    private: {
      goldFacts: [privateCanary],
      expectedVerdict: 'refuse',
    },
    raw: { hidden: privateCanary },
  } as unknown as typeof validTaskV1;

  const projected = toPublicPactTaskIntroV1(privateTask);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes(privateCanary), false);
  assert.equal(serialized.includes('goldFacts'), false);
  assert.equal(serialized.includes('relationalLabel'), false);
  assert.equal(serialized.includes('sourceNotes'), false);
});

test('rejects private P/L/B relationship labels as public identity metadata', () => {
  assert.throws(() =>
    pactTaskIntroV1Schema.parse({
      ...validTaskV1,
      requester: {
        ...validTaskV1.requester,
        relationship: 'P',
      },
    }),
  );
});

test('validates boundary plans without mixing folder fields into other scopes', () => {
  assert.deepEqual(pactBoundaryPlanV1Schema.parse(deniedAccessV1), deniedAccessV1);
  assert.throws(() =>
    pactBoundaryPlanV1Schema.parse({
      access: {
        ...deniedAccessV1.access,
        notes: {
          read: { scope: 'none', folderIds: ['private-folder'] },
          write: false,
        },
      },
    }),
  );
  assert.throws(() =>
    pactBoundaryPlanV1Schema.parse({
      access: {
        ...deniedAccessV1.access,
        notes: {
          read: { scope: 'folders', folderIds: ['shared', 'shared'] },
          write: false,
        },
      },
    }),
  );
  assert.throws(() =>
    pactBoundaryPlanV1Schema.parse({
      access: {
        ...deniedAccessV1.access,
        notes: { read: { scope: 'none' }, write: true },
      },
    }),
  );
  assert.throws(() =>
    pactBoundaryPlanV1Schema.parse({
      access: {
        ...deniedAccessV1.access,
        todos: { read: false, write: true },
      },
    }),
  );
  assert.throws(() =>
    pactBoundaryPlanV1Schema.parse({
      access: {
        ...deniedAccessV1.access,
        memory: { read: 'none', write: true },
      },
    }),
  );
});

test('validates all four decision branches strictly', () => {
  const decisions = [
    { type: 'answer', content: 'April' },
    { type: 'refuse', reason: 'The request is outside the granted boundary.' },
    { type: 'tool_call', toolName: 'search_notes', input: { query: 'launch' } },
    { type: 'escalate', reason: 'Owner confirmation is required.' },
  ];

  for (const decision of decisions) {
    assert.deepEqual(pactDecisionV1Schema.parse(decision), decision);
  }
  assert.throws(() => pactDecisionV1Schema.parse({ type: 'message', content: 'legacy' }));
  assert.throws(() =>
    pactDecisionV1Schema.parse({ type: 'answer', content: 'April', officialScore: 1 }),
  );
});

test('requires unique tool names in runner-owned init data', () => {
  assert.deepEqual(pactRunInitV1Schema.parse(validRunInitV1), validRunInitV1);
  assert.throws(() =>
    pactRunInitV1Schema.parse({
      ...validRunInitV1,
      tools: [validRunInitV1.tools[0], validRunInitV1.tools[0]],
    }),
  );
});

test('requires a granted access plan on the initial task observation', () => {
  const observation = {
    type: 'task',
    turn: 0,
    task: validTaskV1,
    grantedAccess: deniedAccessV1,
    budgetRemaining: {
      turns: 8,
      toolCalls: 4,
      runtimeMs: 60_000,
    },
  };
  assert.deepEqual(pactObservationV1Schema.parse(observation), observation);
  assert.throws(() =>
    pactObservationV1Schema.parse({
      ...observation,
      hiddenLabels: { verdict: 'refuse' },
    }),
  );
});
