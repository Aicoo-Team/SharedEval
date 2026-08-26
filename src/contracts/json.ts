import { createHash } from 'node:crypto';
import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const RESERVED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const jsonObjectKeySchema = z.string().refine(
  key => !RESERVED_JSON_KEYS.has(key),
  'reserved JSON object keys are not allowed',
);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonObjectKeySchema, jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  jsonObjectKeySchema,
  jsonValueSchema,
);

export const MAX_JSON_DEPTH_V1 = 64;
export const MAX_JSON_NODES_V1 = 100_000;

export function assertJsonComplexityV1(value: unknown, label: string): void {
  const stack: Array<
    | { kind: 'visit'; value: unknown; depth: number }
    | { kind: 'leave'; value: object }
  > = [{ kind: 'visit', value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.kind === 'leave') {
      ancestors.delete(current.value);
      continue;
    }

    nodes += 1;
    if (nodes > MAX_JSON_NODES_V1) {
      throw new Error(`${label} exceeds ${MAX_JSON_NODES_V1} JSON nodes`);
    }
    if (current.depth > MAX_JSON_DEPTH_V1) {
      throw new Error(`${label} exceeds JSON depth ${MAX_JSON_DEPTH_V1}`);
    }
    if (typeof current.value !== 'object' || current.value === null) continue;
    if (ancestors.has(current.value)) {
      throw new Error(`${label} must not contain cyclic references`);
    }

    ancestors.add(current.value);
    stack.push({ kind: 'leave', value: current.value });
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ kind: 'visit', value: child, depth: current.depth + 1 });
    }
  }
}

export const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => !value.includes('\0'), 'NUL is not allowed')
  .refine(value => !value.startsWith('/'), 'path must be relative')
  .refine(value => !/^[A-Za-z]:/.test(value), 'path must be relative')
  .refine(value => !value.includes('\\'), 'use POSIX path separators')
  .refine(value => !value.split('/').includes('..'), 'path cannot escape the root')
  .refine(
    value => value === '.' || /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value),
    'path contains unsupported characters',
  )
  .refine(
    value => value === '.' || value.split('/').every(segment => segment !== '.'),
    'dot path segments are not allowed',
  );

export function sha256JsonV1(value: JsonValue): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

export function stableIdV1(prefix: string, tuple: JsonValue[]): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(prefix)) {
    throw new Error('stable ID prefix must use lowercase domain characters');
  }
  return `${prefix}-${sha256JsonV1(tuple).slice(0, 40)}`;
}

function canonicalJsonV1(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return `{${entries.map(([key, entry]) => (
    `${JSON.stringify(key)}:${canonicalJsonV1(entry)}`
  )).join(',')}}`;
}
