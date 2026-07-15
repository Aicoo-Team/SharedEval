import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PACT_JSON_DEPTH_V1,
  MAX_PACT_WIRE_LINE_BYTES_V1,
  parsePactRunnerRequestLineV1,
  parsePactSubmissionResponseLineV1,
  serializePactWireMessageV1,
} from '../../src/protocol/v1/index.js';
import { deniedAccessV1, validRunInitV1, validTaskV1 } from './fixtures.js';

test('parses a JSON-RPC initialize request', () => {
  const request = {
    jsonrpc: '2.0',
    id: 'request-1',
    method: 'pact.initialize',
    params: validRunInitV1,
  };
  assert.deepEqual(parsePactRunnerRequestLineV1(JSON.stringify(request)), request);
});

test('validates a success response against the originating method', () => {
  const response = {
    jsonrpc: '2.0',
    id: 'request-1',
    result: {
      ready: true,
      protocolVersion: 'pact-adapter/v1',
    },
  };
  assert.deepEqual(
    parsePactSubmissionResponseLineV1(JSON.stringify(response), {
      id: 'request-1',
      method: 'pact.initialize',
    }),
    response,
  );
  assert.throws(() =>
    parsePactSubmissionResponseLineV1(JSON.stringify(response), {
      id: 'request-1',
      method: 'pact.step',
    }),
  );
  assert.throws(() =>
    parsePactSubmissionResponseLineV1(JSON.stringify(response), {
      id: 'stale-request',
      method: 'pact.initialize',
    }),
  );
});

test('accepts structured JSON-RPC errors and rejects extra fields', () => {
  const errorResponse = {
    jsonrpc: '2.0',
    id: 'request-1',
    error: {
      code: -32_000,
      message: 'Adapter failed safely',
    },
  };
  assert.deepEqual(
    parsePactSubmissionResponseLineV1(JSON.stringify(errorResponse), {
      id: 'request-1',
      method: 'pact.step',
    }),
    errorResponse,
  );
  assert.throws(() =>
    parsePactSubmissionResponseLineV1(
      JSON.stringify({ ...errorResponse, id: 'wrong-request' }),
      { id: 'request-1', method: 'pact.step' },
    ),
  );
  assert.throws(() =>
    parsePactRunnerRequestLineV1(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'request-1',
        method: 'pact.initialize',
        params: validRunInitV1,
        hiddenLabels: ['private'],
      }),
    ),
  );
});

test('validates planBoundary, step, and finalize method results', () => {
  const cases = [
    {
      method: 'pact.planBoundary' as const,
      result: { plan: deniedAccessV1 },
    },
    {
      method: 'pact.step' as const,
      result: { decision: { type: 'refuse', reason: 'Outside granted access.' } },
    },
    {
      method: 'pact.finalize' as const,
      result: { report: { status: 'completed', summary: 'Finished safely.' } },
    },
  ];

  for (const entry of cases) {
    const response = {
      jsonrpc: '2.0',
      id: 'request-2',
      result: entry.result,
    };
    assert.deepEqual(
      parsePactSubmissionResponseLineV1(JSON.stringify(response), {
        id: 'request-2',
        method: entry.method,
      }),
      response,
    );
  }
});

test('parses all runner request methods strictly', () => {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 'request-plan',
      method: 'pact.planBoundary',
      params: { task: validTaskV1 },
    },
    {
      jsonrpc: '2.0',
      id: 'request-step',
      method: 'pact.step',
      params: {
        observation: {
          type: 'task',
          turn: 0,
          task: validTaskV1,
          grantedAccess: deniedAccessV1,
          budgetRemaining: { turns: 8, toolCalls: 4, runtimeMs: 60_000 },
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 'request-finalize',
      method: 'pact.finalize',
      params: { reason: 'completed' },
    },
  ];

  for (const request of requests) {
    assert.deepEqual(parsePactRunnerRequestLineV1(JSON.stringify(request)), request);
  }
});

test('enforces output byte and JSON depth limits symmetrically', () => {
  assert.throws(() =>
    serializePactWireMessageV1({ content: 'x'.repeat(MAX_PACT_WIRE_LINE_BYTES_V1) }),
  );

  let nested: unknown = 'leaf';
  for (let depth = 0; depth < MAX_PACT_JSON_DEPTH_V1 + 2; depth += 1) {
    nested = [nested];
  }
  assert.throws(() =>
    parsePactSubmissionResponseLineV1(
      JSON.stringify({ jsonrpc: '2.0', id: 'request-depth', result: nested }),
      { id: 'request-depth', method: 'pact.step' },
    ),
  );
});

test('serializes exactly one JSON value per line', () => {
  assert.equal(serializePactWireMessageV1({ ok: true }), '{"ok":true}\n');
  assert.throws(() => serializePactWireMessageV1({ value: undefined }));
  assert.throws(() => parsePactRunnerRequestLineV1('{}\n{}'));
});

test('allows shared JSON references while still rejecting cycles', () => {
  const shared = { ok: true };
  assert.equal(
    serializePactWireMessageV1({ left: shared, right: shared }),
    '{"left":{"ok":true},"right":{"ok":true}}\n',
  );

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => serializePactWireMessageV1(cyclic), /cyclic references/);
});
