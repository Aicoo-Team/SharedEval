import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { sha256JsonV1, type JsonValue } from '../../src/contracts/json.js';
import type { ActorContextMessage } from '../../src/runner/context/actor-context.js';

export type ReadMetrics = {
  readCalls: number; readBytes: number; recordReadCalls: number; recordReadBytes: number;
  recordOpens: number; recordJsonParses: number; elapsedMs: number;
};

// Observe real filesystem operations, including the store's EOF reads. No data is mocked.
export async function measureActorContextIo<T>(directory: string, operation: () => Promise<T>) {
  const metrics: ReadMetrics = {
    readCalls: 0, readBytes: 0, recordReadCalls: 0, recordReadBytes: 0,
    recordOpens: 0, recordJsonParses: 0, elapsedMs: 0,
  };
  const originalOpen = fs.open;
  const originalParse = JSON.parse;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const path = String(args[0]);
    if (path.startsWith(`${directory}/`)) {
      const record = /^record-[0-9]{12}\.json$/.test(basename(path));
      if (record) metrics.recordOpens += 1;
      const read = handle.read;
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(read, handle, readArgs) as { bytesRead: number };
        metrics.readCalls += 1;
        metrics.readBytes += result.bytesRead;
        if (record) {
          metrics.recordReadCalls += 1;
          metrics.recordReadBytes += result.bytesRead;
        }
        return result;
      }) as typeof handle.read;
    }
    return handle;
  };
  JSON.parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value = originalParse(text, reviver);
    if (value?.version === 'actor-context-record/v1') metrics.recordJsonParses += 1;
    return value;
  };
  syncBuiltinESMExports();
  const start = performance.now();
  try {
    const value = await operation();
    return { value, metrics };
  } finally {
    metrics.elapsedMs = Number((performance.now() - start).toFixed(3));
    fs.open = originalOpen;
    JSON.parse = originalParse;
    syncBuiltinESMExports();
  }
}

function syntheticMessages(tick: number): ActorContextMessage[] {
  const messages: ActorContextMessage[] = [];
  const tools = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md', 'contact', 'replace'];
  for (const [index, tool] of tools.entries()) {
    const id = `call-${index}`;
    const name = tool === 'contact' ? 'messages.request' : tool === 'replace' ? 'files.replace' : 'files.read';
    const content = tool === 'contact' ? `Synthetic responder reply ${tick}`
      : tool === 'replace' ? JSON.stringify({ version: tick + 1, status: 'published' })
        : JSON.stringify({ path: tool, version: tick, content: `${tool}\n${'synthetic document text '.repeat(280)}` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{
      id, type: 'function', function: { name, arguments: JSON.stringify({ target: tool, tick }) },
    }] }, { role: 'tool', tool_call_id: id, content });
  }
  messages.push({ role: 'assistant', content: `Synthetic final reply ${tick}` });
  return messages;
}

async function main(): Promise<void> {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('Expected --output <new JSON path>');
  const output = resolve(process.argv[outputIndex + 1]);
  const { openActorContextStore } = await import('../../src/runner/context/actor-context-store.js');
  const samples = [];
  for (const priorTurns of [0, 8, 24]) {
    const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'context-io-bench-'));
    const options = { directory, worldId: 'synthetic-io-benchmark', bindingDigest: 'b'.repeat(64),
      actorIds: ['requester', 'responder'], maxContextBytes: 64 * 1024 * 1024 };
    const store = await openActorContextStore(options);
    try {
      for (let tick = 1; tick <= priorTurns; tick += 1) {
        const turn = await store.beginTurn({ actorId: 'requester', turnId: `tick-${tick}`, input: { role: 'user', content: `Synthetic tick ${tick}` } });
        await turn.append(syntheticMessages(tick));
        await turn.finish('succeeded');
      }
      const probes = [];
      for (let repeat = 0; repeat < 5; repeat += 1) {
        const measured = await measureActorContextIo(directory, () => store.getFrontier('requester'));
        probes.push({ operation: 'getFrontier', repeat, ...measured.metrics });
      }
      const begin = await measureActorContextIo(directory, () => store.beginTurn({
        actorId: 'requester', turnId: 'probe', input: { role: 'user', content: 'Synthetic probe' },
      }));
      const historyHash = sha256JsonV1([...begin.value.priorMessages] as JsonValue);
      probes.push({ operation: 'beginTurn', repeat: 0, ...begin.metrics });
      for (const message of syntheticMessages(priorTurns + 1)) {
        const append = await measureActorContextIo(directory, () => begin.value.append([message]));
        probes.push({ operation: 'append', repeat: probes.filter(probe => probe.operation === 'append').length, ...append.metrics });
      }
      const finish = await measureActorContextIo(directory, () => begin.value.finish('succeeded'));
      probes.push({ operation: 'finish', repeat: 0, ...finish.metrics });
      samples.push({ priorTurns, priorMessages: begin.value.priorMessages.length,
        historyHash, inputHash: begin.value.inputHash, finalFrontier: await store.getFrontier('requester'), probes });
    } finally {
      await store.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  const source = await fs.readFile(new URL('../../src/runner/context/actor-context-store.ts', import.meta.url));
  const result = { version: 'actor-context-io-benchmark/v1', node: process.version,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    fixture: { syntheticOnly: true, recordMessagesPerTurn: 13, documentBytesPerTurnApproximate: 26000,
      contactsPerTurn: 1, priorTurns: [0, 8, 24], allRecordsRereadRequired: true }, samples };
  await fs.mkdir(dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
