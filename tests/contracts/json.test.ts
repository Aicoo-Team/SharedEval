import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertJsonComplexityV1,
  sha256JsonV1,
  stableIdV1,
  jsonObjectSchema,
  jsonValueSchema,
  safeRelativePathSchema,
} from '../../src/contracts/json.js';

test('JSON contracts accept only finite, prototype-safe JSON values', () => {
  assert.deepEqual(jsonValueSchema.parse({ ok: [1, true, null] }), {
    ok: [1, true, null],
  });
  assert.throws(() => jsonValueSchema.parse(Number.NaN));
  assert.throws(() => jsonValueSchema.parse(Number.POSITIVE_INFINITY));
  assert.throws(() => jsonObjectSchema.parse({ constructor: 'forged' }));
  assert.throws(() => jsonObjectSchema.parse(JSON.parse('{"__proto__":{"admin":true}}')));
});

test('JSON complexity rejects cycles and excessive depth', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => assertJsonComplexityV1(cyclic, 'fixture'), /cyclic/);

  let deep: unknown = null;
  for (let index = 0; index < 66; index += 1) deep = [deep];
  assert.throws(() => assertJsonComplexityV1(deep, 'fixture'), /depth/);
});

test('safe relative paths cannot escape or depend on platform separators', () => {
  assert.equal(safeRelativePathSchema.parse('runs/session-1'), 'runs/session-1');
  for (const candidate of ['/tmp/run', '../run', 'a/../run', 'a\\run', 'C:run']) {
    assert.throws(() => safeRelativePathSchema.parse(candidate), candidate);
  }
});

test('canonical JSON identities are domain-separated and host-neutral', () => {
  assert.equal(
    stableIdV1('namespace', ['namespace', 'run-1', 0]),
    'namespace-cf23a7b9ef512290a8dbdc850775bbdacb8429ae',
  );
  assert.equal(
    sha256JsonV1({ z: 1, a: ['two', true] }),
    '47de6ce993f85eb02090f6f16fd1b61a50455c289fc8dfe7ca1f0918817fc8b0',
  );
  assert.equal(
    sha256JsonV1({ a: ['two', true], z: 1 }),
    '47de6ce993f85eb02090f6f16fd1b61a50455c289fc8dfe7ca1f0918817fc8b0',
  );
  assert.throws(() => stableIdV1('../trace', ['trace']), /prefix/i);
});
