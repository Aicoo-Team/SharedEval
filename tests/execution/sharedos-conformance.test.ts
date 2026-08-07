/**
 * Differential conformance tests: PACT's mirrored schemas versus the
 * REAL `@sharedos/contracts` schemas from a pinned SharedOS checkout.
 *
 * Every fixture is parsed by both sides and the accept/reject decision
 * must agree — "PACT accepts, SharedOS rejects at runtime" is exactly
 * the drift class these fixtures exist to catch. The seed fixtures are
 * the three drift cases found in review of the original mirror:
 *
 *   1. a human execution recipient (SharedOS `ExecutionRequestSchema.agent`
 *      is agent-only),
 *   2. a bigint turn payload (SharedOS requires JSON-safe `JsonValueSchema`),
 *   3. a whitespace-only identifier (SharedOS `IdentifierSchema` trims
 *      and requires 1–256 chars).
 *
 * Long-term these tests disappear into consuming `@sharedos/contracts`
 * directly; that packaging decision belongs to the lead (see
 * docs/sharedos-execution-adapter.md, "Package consumption").
 *
 * When no SharedOS build is available the tests skip with a logged
 * reason — unless PACT_REQUIRE_SHAREDOS is set (the pinned CI job),
 * where unavailability is a hard failure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultSharedOsDirV1,
  sharedOsAgentAddressV1Schema,
  sharedOsIdentifierV1Schema,
  sharedOsTurnMessageV1Schema,
  sharedOsTurnRequestV1Schema,
  sharedOsWorldInitV1Schema,
  MAX_TURN_TIMEOUT_MS_V1,
  MAX_TURN_STEPS_V1,
  SHAREDOS_PROTOCOL_VERSION_V1,
} from '../../src/execution/sharedos/v1/index.js';

type ZodLike = {
  safeParse(value: unknown): { success: boolean; data?: unknown };
};

const sharedOsDir = defaultSharedOsDirV1();
const contractsEntry = join(sharedOsDir, 'packages', 'contracts', 'dist', 'index.js');

let so: Record<string, unknown> | null = null;
if (existsSync(contractsEntry)) {
  so = (await import(pathToFileURL(contractsEntry).href)) as Record<string, unknown>;
}
const skip = so
  ? false
  : `SharedOS contracts build not found at ${contractsEntry}. Clone `
    + 'Aicoo-Team/SharedOS, run "pnpm install --frozen-lockfile && pnpm build", '
    + 'or point PACT_SHAREDOS_DIR at a built checkout.';
if (!so) {
  // In the pinned-SharedOS conformance CI job, an unavailable SharedOS
  // build is a failure, never a green skip.
  if (process.env.PACT_REQUIRE_SHAREDOS) {
    throw new Error(`PACT_REQUIRE_SHAREDOS is set but ${skip}`);
  }
  console.log(`[sharedos-conformance] skipping differential tests: ${skip}`);
}

function soSchema(name: string): ZodLike {
  assert.ok(so, 'SharedOS contracts must be loaded');
  const schema = so[name];
  assert.ok(schema, `@sharedos/contracts must export ${name}`);
  return schema as ZodLike;
}

/** Assert one fixture parses to the same accept/reject decision on both sides. */
function assertParity(
  label: string,
  pactSide: ZodLike,
  sharedOsSide: ZodLike,
  value: unknown,
  accepted: boolean,
): void {
  const pact = pactSide.safeParse(value);
  const shared = sharedOsSide.safeParse(value);
  assert.equal(pact.success, accepted, `PACT side: ${label} (expected accepted=${accepted})`);
  assert.equal(shared.success, accepted, `SharedOS side: ${label} (expected accepted=${accepted})`);
  assert.equal(
    pact.success,
    shared.success,
    `divergence on ${label}: PACT ${pact.success ? 'accepts' : 'rejects'}, `
    + `SharedOS ${shared.success ? 'accepts' : 'rejects'}`,
  );
}

test('recipient addresses: PACT agent-address mirror matches SharedOS AgentAddressSchema', { skip }, () => {
  const agentAddress = soSchema('AgentAddressSchema');
  const fixtures: Array<{ label: string; value: unknown; accepted: boolean }> = [
    {
      label: 'plain agent address',
      value: { kind: 'agent', agentId: 'agent-responder' },
      accepted: true,
    },
    {
      label: 'human recipient (review repro 1)',
      value: { kind: 'human', userId: 'owner-1' },
      accepted: false,
    },
    {
      label: 'whitespace-only agent id (review repro 3)',
      value: { kind: 'agent', agentId: '   ' },
      accepted: false,
    },
    {
      label: 'over-long agent id (257 chars)',
      value: { kind: 'agent', agentId: 'a'.repeat(257) },
      accepted: false,
    },
    {
      label: 'agent id at the 256-char boundary',
      value: { kind: 'agent', agentId: 'a'.repeat(256) },
      accepted: true,
    },
    {
      label: 'extra key on the address',
      value: { kind: 'agent', agentId: 'agent-responder', grants: [] },
      accepted: false,
    },
  ];
  for (const fixture of fixtures) {
    assertParity(fixture.label, sharedOsAgentAddressV1Schema, agentAddress, fixture.value, fixture.accepted);
  }
  // And end-to-end through the world init: the human recipient that the
  // pre-fix mirror accepted must now fail on the PACT side too.
  const init = sharedOsWorldInitV1Schema.safeParse({
    worldId: 'world-1',
    taskId: 'qa:127',
    namespaceId: 'run-0001',
    recipient: { kind: 'human', userId: 'owner-1' },
    workspaceDigest: 'a'.repeat(64),
    expectedVisibleTools: [],
  });
  assert.equal(init.success, false);
});

test('turn payload: PACT JSON-safety mirror matches SharedOS JsonValueSchema', { skip }, () => {
  const jsonValue = soSchema('JsonValueSchema');
  const pactPayload: ZodLike = {
    safeParse: (payload: unknown) =>
      sharedOsTurnMessageV1Schema.safeParse({ intent: 'go', purpose: 'benchmark', payload }),
  };
  const fixtures: Array<{ label: string; value: unknown; accepted: boolean }> = [
    { label: 'plain object payload', value: { taskId: 'qa:127' }, accepted: true },
    {
      label: 'nested arrays and primitives',
      value: { steps: [1, 'two', null, { done: false }] },
      accepted: true,
    },
    { label: 'top-level bigint (review repro 2)', value: 1n, accepted: false },
    { label: 'nested bigint', value: { budget: { tokens: 128n } }, accepted: false },
    { label: 'NaN', value: Number.NaN, accepted: false },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY, accepted: false },
    { label: 'Date instance', value: new Date('2026-08-07T00:00:00Z'), accepted: false },
  ];
  for (const fixture of fixtures) {
    assertParity(fixture.label, pactPayload, jsonValue, fixture.value, fixture.accepted);
  }
});

test('identifiers: PACT identifier mirror matches SharedOS IdentifierSchema', { skip }, () => {
  const identifier = soSchema('IdentifierSchema');
  const fixtures: Array<{ label: string; value: unknown; accepted: boolean }> = [
    { label: 'plain identifier', value: 'run-0001', accepted: true },
    { label: 'whitespace-only identifier (review repro 3)', value: ' \t ', accepted: false },
    { label: 'empty identifier', value: '', accepted: false },
    { label: '256-char identifier', value: 'x'.repeat(256), accepted: true },
    { label: '257-char identifier', value: 'x'.repeat(257), accepted: false },
    { label: 'padded identifier (trimmed on both sides)', value: '  turn-1  ', accepted: true },
  ];
  for (const fixture of fixtures) {
    assertParity(fixture.label, sharedOsIdentifierV1Schema, identifier, fixture.value, fixture.accepted);
  }
  // Trimming must normalize to the same value on both sides.
  const pact = sharedOsIdentifierV1Schema.safeParse('  turn-1  ');
  const shared = identifier.safeParse('  turn-1  ');
  assert.ok(pact.success && shared.success);
  assert.equal(pact.data, 'turn-1');
  assert.equal(pact.data, shared.data);
});

test('a PACT-accepted turn maps to a SharedOS-accepted ExecutionRequest', { skip }, () => {
  const executionRequest = soSchema('ExecutionRequestSchema');
  const owner = { kind: 'human', userId: 'owner-1' } as const;
  const sender = { kind: 'agent', agentId: 'agent-requester' } as const;
  const recipient = { kind: 'agent', agentId: 'agent-responder' } as const;

  const parsedTurn = sharedOsTurnRequestV1Schema.parse({
    turnId: 'turn-1',
    message: { intent: 'answer-question', purpose: 'benchmark-task', payload: { taskId: 'qa:127' } },
    options: { timeoutMs: 5_000 },
  });

  // Exactly the mapping the embedded adapter performs per tick.
  const request = {
    version: SHAREDOS_PROTOCOL_VERSION_V1,
    executionId: parsedTurn.turnId,
    agent: recipient,
    context: {
      namespaceId: 'run-0001',
      actor: sender,
      authority: owner,
      owner,
      purpose: parsedTurn.message.purpose,
      traceId: 'trace-0001',
      grants: [],
      now: '2026-08-07T00:00:00.000Z',
    },
    message: {
      version: SHAREDOS_PROTOCOL_VERSION_V1,
      id: 'message-0001',
      sender,
      receiver: recipient,
      intent: parsedTurn.message.intent,
      purpose: parsedTurn.message.purpose,
      payload: parsedTurn.message.payload ?? null,
      traceId: 'trace-0001',
      createdAt: '2026-08-07T00:00:00.000Z',
    },
    tools: [],
    options: { timeoutMs: parsedTurn.options.timeoutMs },
  };
  const parsed = executionRequest.safeParse(request);
  assert.equal(
    parsed.success,
    true,
    'a request that passed the PACT mirror must be accepted by the SharedOS runtime schema',
  );
});

test('protocol bounds stay equal to the SharedOS source of truth', { skip }, () => {
  assert.ok(so);
  assert.equal(so.MAX_EXECUTION_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS_V1);
  const options = soSchema('ExecutionOptionsSchema');
  assert.equal(options.safeParse({ maxSteps: MAX_TURN_STEPS_V1 }).success, true);
  assert.equal(options.safeParse({ maxSteps: MAX_TURN_STEPS_V1 + 1 }).success, false);
  assert.equal(options.safeParse({ timeoutMs: MAX_TURN_TIMEOUT_MS_V1 }).success, true);
  assert.equal(options.safeParse({ timeoutMs: MAX_TURN_TIMEOUT_MS_V1 + 1 }).success, false);
});
