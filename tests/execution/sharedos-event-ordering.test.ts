import assert from 'node:assert/strict';
import test from 'node:test';
import * as embeddedAdapter from '../../src/execution/sharedos/v1/embedded-adapter.js';

test('orders merged SharedOS diagnostics deterministically for display only', () => {
  const orderForDisplay = (
    embeddedAdapter as unknown as {
      orderSharedOsEventsForDisplayV1?: (
        runtime: Array<{ type: string; data: unknown; occurredAt: string }>,
        audit: Array<{ type: string; data: unknown; occurredAt: string }>,
      ) => Array<{ sequence: number; type: string }>;
    }
  ).orderSharedOsEventsForDisplayV1;
  assert.equal(typeof orderForDisplay, 'function');
  assert.ok(orderForDisplay);

  const runtime = [
    { type: 'turn.completed', data: {}, occurredAt: '2026-08-25T00:00:02.000Z' },
    { type: 'turn.started', data: {}, occurredAt: '2026-08-25T00:00:00.000Z' },
  ];
  const audit = [
    { type: 'audit.authorization.checked', data: {}, occurredAt: '2026-08-25T00:00:01.000Z' },
    { type: 'audit.tool.invoked', data: {}, occurredAt: '2026-08-25T00:00:02.000Z' },
  ];

  const ordered = orderForDisplay(runtime, audit);
  assert.deepEqual(ordered.map(event => event.type), [
    'turn.started',
    'audit.authorization.checked',
    'turn.completed',
    'audit.tool.invoked',
  ]);
  assert.deepEqual(ordered.map(event => event.sequence), [0, 1, 2, 3]);
  assert.deepEqual(runtime.map(event => event.type), ['turn.completed', 'turn.started']);
  assert.deepEqual(audit.map(event => event.type), [
    'audit.authorization.checked',
    'audit.tool.invoked',
  ]);
});
