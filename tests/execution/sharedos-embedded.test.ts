/**
 * Integration tests for the `sharedos-embedded` binding. These exercise
 * the REAL SharedOS permission kernel and TurnExecutor from a locally
 * built checkout. When no build is available (e.g. CI without repo
 * access) every test is skipped with an explicit reason — never
 * silently.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  digestObjectV1,
  EmbeddedSharedOsAdapterV1,
  loadSharedOsModulesV1,
  SharedOsWorldGateErrorV1,
  type EmbeddedWorldV1,
  type SharedOsModulesV1,
  type SharedOsTurnRequestV1,
  type SharedOsWorldInitV1,
  type SoAgentTurnRequest,
  type SoTurnDriver,
} from '../../src/execution/sharedos/v1/index.js';

const loaded = await loadSharedOsModulesV1();
if (!loaded.ok && process.env.PACT_REQUIRE_SHAREDOS === '1') {
  throw new Error(`SharedOS integration is required but unavailable: ${loaded.reason}`);
}
const skip = loaded.ok ? false : loaded.reason;
if (!loaded.ok) {
  console.log(`[sharedos-embedded] skipping integration tests: ${loaded.reason}`);
}

const CANONICAL_WORLD = {
  taskId: 'qa:127',
  memory: { 'project-x': ['SharedOS keeps authority outside the message.'] },
};
const WORLD_DIGEST = digestObjectV1(CANONICAL_WORLD);
const PROVENANCE = { requestedId: 'scripted', resolvedId: 'scripted-v1', servedId: 'scripted-v1' };

const owner = { kind: 'human', userId: 'owner-1' } as const;
const requester = { kind: 'agent', agentId: 'agent-requester' } as const;
const responder = { kind: 'agent', agentId: 'agent-responder' } as const;

function worldInit(overrides: Partial<SharedOsWorldInitV1> = {}): SharedOsWorldInitV1 {
  return {
    worldId: 'world-1',
    taskId: 'qa:127',
    namespaceId: 'run-0001',
    recipient: { kind: 'agent', agentId: responder.agentId },
    workspaceDigest: WORLD_DIGEST,
    expectedVisibleTools: ['memory.search'],
    ...overrides,
  };
}

function turnRequest(turnId: string, overrides: Partial<SharedOsTurnRequestV1> = {}): SharedOsTurnRequestV1 {
  return {
    turnId,
    message: { intent: 'answer-question', purpose: 'benchmark-task' },
    options: { timeoutMs: 5_000 },
    ...overrides,
  };
}

function makeWorld(
  modules: SharedOsModulesV1,
  overrides: Partial<EmbeddedWorldV1> = {},
): EmbeddedWorldV1 {
  return {
    owner,
    sender: requester,
    canonicalWorld: CANONICAL_WORLD,
    async setup(kernel) {
      const memory = new modules.testkit.InMemoryResourceProvider(
        'memory',
        async operation => ({
          operationId: operation.operationId,
          status: 'succeeded',
          output: { hits: CANONICAL_WORLD.memory['project-x'] },
          completedAt: (operation.context as { now: string }).now,
        }),
      );
      for (const handler of modules.os.createMemoryTools(memory)) {
        kernel.registerTool(handler);
      }
    },
    senderGrants: (m, namespaceId) => [
      m.testkit.createTestGrant({
        id: 'grant-search-memory',
        namespaceId,
        subject: requester,
        issuer: owner,
        capabilities: [{
          resource: { namespace: 'memory', path: ['project-x'], owner },
          actions: ['search'],
          scope: 'descendants',
        }],
        purposes: ['benchmark-task'],
      }),
    ],
    ...overrides,
  };
}

/** Scripted agent: search memory once, then complete with what it found. */
function searchingDriver(capture?: { request?: SoAgentTurnRequest }): SoTurnDriver {
  return {
    async open(request) {
      if (capture) capture.request = request;
      const traceId = (request.context as { traceId: string }).traceId;
      const now = (request.context as { now: string }).now;
      return {
        async next(input) {
          if (input.type === 'start') {
            return {
              type: 'tool_call',
              call: {
                id: 'call-1',
                tool: 'memory.search',
                arguments: { path: ['project-x'], query: 'authority' },
                traceId,
                requestedAt: now,
              },
            };
          }
          return {
            type: 'complete',
            output:
              input.result.status === 'succeeded'
                ? `found: ${JSON.stringify(input.result.output)}`
                : `tool ${input.result.tool} unavailable`,
          };
        },
      };
    },
  };
}

function makeAdapter(
  modules: SharedOsModulesV1,
  driver: SoTurnDriver,
  worldOverrides: Partial<EmbeddedWorldV1> = {},
) {
  // The fixture's resource grant defaults to 2026-01-01.
  let tick = Date.UTC(2026, 7, 5);
  return new EmbeddedSharedOsAdapterV1({
    modules,
    worldFactory: (_init, m) => makeWorld(m, worldOverrides),
    driver,
    provenance: PROVENANCE,
    clock: { nowMs: () => (tick += 10) },
  });
}

test('an authorized turn runs through the production kernel and succeeds', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver());
  const handle = await adapter.initWorld(worldInit());
  assert.equal(handle.worldDigestAtInit, WORLD_DIGEST);

  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.adapterId, 'sharedos-embedded');
  assert.match(result.output ?? '', /authority outside the message/);
  assert.deepEqual(result.toolCalls, [
    { callId: 'call-1', name: 'memory.search', publicStatus: 'ok' },
  ]);
  const types = result.events.map(event => event.type);
  assert.ok(types.includes('turn.started'), `events: ${types.join(',')}`);
  assert.ok(types.includes('tool.requested'));
  assert.ok(types.includes('tool.completed'));
  assert.ok(types.includes('turn.completed'));
});

test('resolves model provenance after the driver finishes the turn', { skip }, async () => {
  assert.ok(loaded.ok);
  let provenanceReads = 0;
  let tick = Date.UTC(2026, 7, 5);
  const adapter = new EmbeddedSharedOsAdapterV1({
    modules: loaded.modules,
    worldFactory: (_init, modules) => makeWorld(modules),
    driver: searchingDriver(),
    provenance: () => {
      provenanceReads += 1;
      return {
        requestedId: 'requested-model',
        resolvedId: 'resolved-model',
        servedId: 'provider-served-model',
      };
    },
    clock: { nowMs: () => (tick += 10) },
  });
  const handle = await adapter.initWorld(worldInit());
  assert.equal(provenanceReads, 0);

  const [result] = await adapter.runTurn(handle, turnRequest('turn-provenance'));

  assert.equal(provenanceReads, 1);
  assert.deepEqual(result.provenance, {
    requestedId: 'requested-model',
    resolvedId: 'resolved-model',
    servedId: 'provider-served-model',
  });
});

test('issues the per-turn execution grant against the injected clock', { skip }, async () => {
  assert.ok(loaded.ok);
  let tick = Date.UTC(2024, 0, 1);
  const adapter = new EmbeddedSharedOsAdapterV1({
    modules: loaded.modules,
    worldFactory: (_init, modules) => makeWorld(modules, {
      setup: () => undefined,
      senderGrants: () => [],
    }),
    driver: {
      async open() {
        return {
          async next() {
            return { type: 'complete', output: 'completed under replay clock' };
          },
        };
      },
    },
    provenance: PROVENANCE,
    clock: { nowMs: () => (tick += 10) },
  });
  const handle = await adapter.initWorld(worldInit({ expectedVisibleTools: [] }));

  const [result] = await adapter.runTurn(handle, turnRequest('turn-replay-clock'));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 'completed under replay clock');
});

test('one tick maps to exactly one bounded turn', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver());
  const handle = await adapter.initWorld(worldInit());
  const results = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(results.length, 1, 'one tick yields one result row');
  const starts = results[0].events.filter(event => event.type === 'turn.started');
  assert.equal(starts.length, 1, 'exactly one turn.started per tick');
});

test('worlds are isolated: another world sees neither tools nor state of the first', { skip }, async () => {
  assert.ok(loaded.ok);
  let tick = Date.UTC(2026, 7, 5);
  const adapter = new EmbeddedSharedOsAdapterV1({
    modules: loaded.modules,
    // world-a is the fully provisioned world; world-b registers no tools
    // and passes no sender grants — a fresh kernel with nothing in it.
    worldFactory: (init, m) =>
      init.worldId === 'world-a'
        ? makeWorld(m)
        : makeWorld(m, { setup: () => undefined, senderGrants: () => [] }),
    driver: searchingDriver(),
    provenance: PROVENANCE,
    clock: { nowMs: () => (tick += 10) },
  });
  const handleA = await adapter.initWorld(worldInit({ worldId: 'world-a', namespaceId: 'run-a' }));
  const handleB = await adapter.initWorld(worldInit({
    worldId: 'world-b',
    namespaceId: 'run-b',
    expectedVisibleTools: [],
  }));
  assert.notEqual(handleA.namespaceId, handleB.namespaceId);

  const [resultA] = await adapter.runTurn(handleA, turnRequest('turn-a'));
  const [resultB] = await adapter.runTurn(handleB, turnRequest('turn-b'));

  assert.equal(resultA.toolCalls[0].publicStatus, 'ok');
  assert.match(resultA.output ?? '', /authority outside the message/);
  assert.equal(
    resultB.toolCalls[0].publicStatus,
    'tool_unavailable',
    "world-a's registered tools must not exist in world-b's kernel",
  );
  assert.doesNotMatch(resultB.output ?? '', /authority outside the message/);
});

test('audit events reconstruct the admission decision: allowed turns carry the matched grant', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver());
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));

  const checks = result.events.filter(event => event.type === 'audit.authorization.checked');
  assert.ok(checks.length > 0, 'kernel authorization decisions must appear in the transcript');
  const admission = checks
    .map(event => event.data as { outcome: string; grantId?: string; namespaceId: string })
    .find(data => data.outcome === 'allowed' && data.grantId?.startsWith('grant-exec'));
  assert.ok(admission, 'the turn admission must be traceable to the per-tick execution grant');
  assert.equal(admission.namespaceId, 'run-0001');
});

test('audit events reconstruct a denial: withheld grant leaves a denied authorization record', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver(), { executionGrant: 'withheld' });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(result.status, 'denied');

  const denials = result.events
    .filter(event => event.type === 'audit.authorization.checked')
    .map(event => event.data as { outcome: string; reason?: string });
  assert.ok(
    denials.some(data => data.outcome === 'denied'),
    'the denied admission must be reconstructable from audit events',
  );
});

test('withholding the execution grant yields a denied turn — an experimental outcome', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver(), { executionGrant: 'withheld' });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(result.status, 'denied');
  assert.equal(result.output, null);
  assert.ok(result.events.some(event => event.type === 'turn.denied'));
});

test('a tool outside the grant surface returns public tool_unavailable, and the turn still completes', { skip }, async () => {
  assert.ok(loaded.ok);
  const greedyDriver: SoTurnDriver = {
    async open(request) {
      const traceId = (request.context as { traceId: string }).traceId;
      const now = (request.context as { now: string }).now;
      return {
        async next(input) {
          if (input.type === 'start') {
            return {
              type: 'tool_call',
              call: {
                id: 'call-forbidden',
                tool: 'memory.write',
                arguments: { path: ['project-x'], content: 'exfil' },
                traceId,
                requestedAt: now,
              },
            };
          }
          return { type: 'complete', output: `write status: ${input.result.status}` };
        },
      };
    },
  };
  const adapter = makeAdapter(loaded.modules, greedyDriver);
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].publicStatus, 'tool_unavailable');
});

test('an exhausted bounded grant is opaque to the model-facing driver', { skip }, async () => {
  assert.ok(loaded.ok);
  const observedCodes: Array<string | undefined> = [];
  let requested = 0;
  const boundedDriver: SoTurnDriver = {
    async open(request) {
      const traceId = (request.context as { traceId: string }).traceId;
      const requestedAt = (request.context as { now: string }).now;
      return {
        async next(input) {
          if (input.type === 'tool_result') {
            observedCodes.push(input.result.error?.code);
          }
          if (requested < 2) {
            requested += 1;
            return {
              type: 'tool_call',
              call: {
                id: `call-${requested}`,
                tool: 'memory.search',
                arguments: { path: ['project-x'], query: 'authority' },
                traceId,
                requestedAt,
              },
            };
          }
          return { type: 'complete', output: 'done' };
        },
      };
    },
  };
  const adapter = makeAdapter(loaded.modules, boundedDriver, {
    senderGrants: (modules, namespaceId) => {
      const grant = modules.testkit.createTestGrant({
        id: 'grant-search-once',
        namespaceId,
        subject: requester,
        issuer: owner,
        capabilities: [{
          resource: { namespace: 'memory', path: ['project-x'], owner },
          actions: ['search'],
          scope: 'descendants',
        }],
        purposes: ['benchmark-task'],
      }) as { constraints: Record<string, unknown> } & Record<string, unknown>;
      return [{
        ...grant,
        constraints: { ...grant.constraints, maxUses: 1 },
      }];
    },
  });
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(handle, turnRequest('turn-1'));

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.toolCalls.map(call => call.publicStatus), [
    'ok',
    'tool_unavailable',
  ]);
  assert.deepEqual(observedCodes, [undefined, 'tool_unavailable']);
  assert.doesNotMatch(result.output ?? '', /grant_exhausted/);
});

test('the model-facing request is sanitized: no grants, no authority, no gold', { skip }, async () => {
  assert.ok(loaded.ok);
  const capture: { request?: SoAgentTurnRequest } = {};
  const adapter = makeAdapter(loaded.modules, searchingDriver(capture));
  const handle = await adapter.initWorld(worldInit());
  await adapter.runTurn(handle, turnRequest('turn-1'));

  assert.ok(capture.request, 'driver must have received the turn request');
  const context = capture.request.context;
  assert.equal('grants' in context, false, 'grants must not reach the model');
  assert.equal('authority' in context, false, 'issuing authority must not reach the model');
  assert.equal(
    JSON.stringify(capture.request).includes('gold'),
    false,
    'nothing gold-shaped may appear in the model-facing request',
  );
  const visibleTools = capture.request.tools.map(tool => tool.name);
  assert.deepEqual(visibleTools, ['memory.search'], 'only granted tools are visible');
});

test('world gate fails closed on digest mismatch before any kernel is built', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver());
  await assert.rejects(
    () => adapter.initWorld(worldInit({ workspaceDigest: 'f'.repeat(64) })),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'digest_mismatch',
  );
});

test('world gate rejects duplicate initialization and tampered handles', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver());
  const init = worldInit();
  const handle = await adapter.initWorld(init);

  await assert.rejects(
    () => adapter.initWorld(init),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'duplicate_world',
  );
  await assert.rejects(
    () => adapter.runTurn(
      { ...handle, namespaceId: 'another-namespace' },
      turnRequest('turn-1'),
    ),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'stale_handle',
  );
  await assert.rejects(
    () => adapter.runTurn(
      { ...handle, worldDigestAtInit: 'f'.repeat(64) },
      turnRequest('turn-2'),
    ),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'stale_handle',
  );
  await assert.rejects(
    () => adapter.closeWorld({ ...handle, namespaceId: 'another-namespace' }),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1 && error.reason === 'stale_handle',
  );
  const [result] = await adapter.runTurn(handle, turnRequest('turn-3'));
  assert.equal(result.status, 'succeeded', 'a forged close must not release the real world');
});

test('world gate verifies the permission-filtered tool surface', { skip }, async () => {
  assert.ok(loaded.ok);
  const adapter = makeAdapter(loaded.modules, searchingDriver());
  const handle = await adapter.initWorld(worldInit({ expectedVisibleTools: [] }));
  await assert.rejects(
    () => adapter.runTurn(handle, turnRequest('turn-1')),
    (error: unknown) =>
      error instanceof SharedOsWorldGateErrorV1
      && error.reason === 'tool_surface_mismatch',
  );
});

test('a hanging driver is cancelled at the bounded timeout', { skip }, async () => {
  assert.ok(loaded.ok);
  const hangingDriver: SoTurnDriver = {
    async open() {
      return { next: () => new Promise(() => undefined) };
    },
  };
  const adapter = makeAdapter(loaded.modules, hangingDriver);
  const handle = await adapter.initWorld(worldInit());
  const [result] = await adapter.runTurn(
    handle,
    turnRequest('turn-1', { options: { timeoutMs: 200 } }),
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.output, null);
});
