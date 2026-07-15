export const MAX_PACT_MANIFEST_BYTES_V1 = 256 * 1024;
export const MAX_PACT_WIRE_LINE_BYTES_V1 = 1024 * 1024;
export const MAX_PACT_JSON_DEPTH_V1 = 64;
export const MAX_PACT_JSON_NODES_V1 = 100_000;

export function assertPactJsonComplexityV1(value: unknown, label: string): void {
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
    if (nodes > MAX_PACT_JSON_NODES_V1) {
      throw new Error(`${label} exceeds ${MAX_PACT_JSON_NODES_V1} JSON nodes`);
    }
    if (current.depth > MAX_PACT_JSON_DEPTH_V1) {
      throw new Error(`${label} exceeds JSON depth ${MAX_PACT_JSON_DEPTH_V1}`);
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
