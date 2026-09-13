import { createHash } from 'node:crypto';

export const ACCEPTANCE_CONTEXT_PROJECTION_VERSION = 'acceptance-context-projection/v1';

export type AcceptanceContextProjectionOptions = {
  /** Everything at and after this raw message index remains byte-for-byte intact. */
  currentTurnStartIndex?: number;
};

export type AcceptanceContextOmission = {
  kind: 'duplicate-file-read' | 'historical-memory-read' | 'historical-memory-write';
  messageIndex: number;
  toolCallId: string;
  path: string;
  contentSha256: string;
  contentBytes: number;
  version: string;
  expectedVersion?: string;
  retainedContentAt: { messageIndex: number; toolCallId: string; version: string };
};

export type AcceptanceContextProjectionMetadata = {
  version: typeof ACCEPTANCE_CONTEXT_PROJECTION_VERSION;
  inputSha256: string;
  projectedSha256: string;
  inputBytes: number;
  projectedBytes: number;
  savedBytes: number;
  messageCount: number;
  modifiedMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  contactCallCount: number;
  orderedToolLinkageSha256: string;
  currentTurnStartIndex: number;
  duplicateFileReads: number;
  historicalMemoryReads: number;
  historicalMemoryWrites: number;
  omissions: AcceptanceContextOmission[];
  informationLoss: string[];
};

type JsonRecord = Record<string, unknown>;
type Snapshot = {
  callIndex: number;
  resultIndex: number;
  id: string;
  operation: 'files.read' | 'files.replace';
  path: string;
  args: JsonRecord;
  result: JsonRecord;
  output: JsonRecord;
  content: string;
  version: string;
  sha256: string;
  byteLength: number;
};

/**
 * Experiment-only model view. Call with raw journal messages on every request;
 * never persist the returned messages back into an actor journal. No messages,
 * tool IDs, contact drafts/replies, refusals or non-file observations are dropped.
 *
 * MEMORY compaction intentionally loses superseded full notes/status snapshots
 * from the model view. Hashes are audit references, not recoverable summaries.
 * The latest complete snapshot and latest/current-turn reads remain verbatim.
 * Static-file versions are workspace pointer versions: a MEMORY commit advances
 * them too. Identical bytes can share one full copy while every version receipt
 * stays in place; different POLICY content always retains a complete copy.
 */
export function projectAcceptanceContext<T>(
  messages: readonly T[],
  options: AcceptanceContextProjectionOptions = {},
): { messages: T[]; metadata: AcceptanceContextProjectionMetadata } {
  const inputText = JSON.stringify(messages);
  const projected = structuredClone(messages) as T[];
  let inferredStart = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (record(messages[index])?.role === 'user') inferredStart = index;
  }
  const currentStart = options.currentTurnStartIndex ?? Math.max(0, inferredStart);
  if (!Number.isSafeInteger(currentStart) || currentStart < 0 || currentStart > messages.length) {
    throw new RangeError('currentTurnStartIndex must be a raw message index within the input');
  }

  const linkage: unknown[] = [];
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let contactCallCount = 0;
  for (const [index, value] of messages.entries()) {
    const message = record(value);
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const value of message.tool_calls) {
        const call = record(value);
        toolCallCount += 1;
        if (typeof call?.id === 'string') increment(callCounts, call.id);
        const name = record(call?.function)?.name;
        if (name === 'messages.request') contactCallCount += 1;
        linkage.push(['call', index, call?.id ?? null, name ?? null]);
      }
    } else if (message?.role === 'tool') {
      toolResultCount += 1;
      if (typeof message.tool_call_id === 'string') increment(resultCounts, message.tool_call_id);
      linkage.push(['result', index, message.tool_call_id ?? null]);
    }
  }

  // Only the exact single-call, adjacent-result protocol emitted by this driver
  // is recognized. Ambiguous IDs, parallel calls and evolving schemas pass through.
  const snapshots: Snapshot[] = [];
  for (let index = 0; index + 1 < messages.length; index += 1) {
    const snapshot = recognizeSnapshot(messages[index], messages[index + 1], index);
    if (snapshot && callCounts.get(snapshot.id) === 1 && resultCounts.get(snapshot.id) === 1) {
      snapshots.push(snapshot);
    }
  }

  const latestStatic = new Map<string, Snapshot>();
  const latestRead = new Map<string, Snapshot>();
  let latestMemory: Snapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.operation === 'files.read') latestRead.set(snapshot.path, snapshot);
    if (snapshot.path === 'MEMORY.md') latestMemory = snapshot;
    else latestStatic.set(staticKey(snapshot), snapshot);
  }

  const omissions: AcceptanceContextOmission[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.resultIndex >= currentStart) continue;
    let kind: AcceptanceContextOmission['kind'];
    let retained: Snapshot | undefined;
    if (snapshot.path !== 'MEMORY.md') {
      kind = 'duplicate-file-read';
      retained = latestStatic.get(staticKey(snapshot));
      if (!retained || retained.content !== snapshot.content) continue;
    } else {
      kind = snapshot.operation === 'files.read' ? 'historical-memory-read' : 'historical-memory-write';
      if (snapshot === latestRead.get('MEMORY.md')) continue;
      retained = latestMemory;
    }
    if (!retained || retained.resultIndex <= snapshot.resultIndex) continue;
    const omission: AcceptanceContextOmission = {
      kind,
      messageIndex: snapshot.operation === 'files.read' ? snapshot.resultIndex : snapshot.callIndex,
      toolCallId: snapshot.id,
      path: snapshot.path,
      contentSha256: snapshot.sha256,
      contentBytes: snapshot.byteLength,
      version: snapshot.version,
      ...(snapshot.operation === 'files.replace'
        ? { expectedVersion: snapshot.args.expectedVersion as string } : {}),
      retainedContentAt: {
        messageIndex: retained.operation === 'files.read' ? retained.resultIndex : retained.callIndex,
        toolCallId: retained.id,
        version: retained.version,
      },
    };
    const marker = `[${ACCEPTANCE_CONTEXT_PROJECTION_VERSION}] ${JSON.stringify({
      hostProjection: true,
      omitted: kind === 'duplicate-file-read' ? 'exact duplicate file content' : 'historical MEMORY snapshot content',
      originalSha256: snapshot.sha256,
      originalBytes: snapshot.byteLength,
      retainedContentAt: omission.retainedContentAt,
      ...(kind === 'duplicate-file-read' ? {} : {
        informationLoss: 'Old notes/statuses may differ from latest MEMORY. Omitted content remains only in the raw journal; this marker is not original model text or file content.',
      }),
    })}`;
    if (Buffer.byteLength(marker, 'utf8') >= snapshot.byteLength) continue;
    if (snapshot.operation === 'files.read') {
      record(projected[snapshot.resultIndex])!.content = JSON.stringify({
        ...snapshot.result, output: { ...snapshot.output, content: marker },
      });
    } else {
      const assistant = record(projected[snapshot.callIndex])!;
      const call = record((assistant.tool_calls as unknown[])[0])!;
      record(call.function)!.arguments = JSON.stringify({ ...snapshot.args, content: marker });
    }
    omissions.push(omission);
  }

  const projectedText = JSON.stringify(projected);
  const inputBytes = Buffer.byteLength(inputText, 'utf8');
  const projectedBytes = Buffer.byteLength(projectedText, 'utf8');
  const memoryLoss = omissions.some(item => item.kind !== 'duplicate-file-read');
  return {
    messages: projected,
    metadata: {
      version: ACCEPTANCE_CONTEXT_PROJECTION_VERSION,
      inputSha256: sha256(inputText),
      projectedSha256: sha256(projectedText),
      inputBytes, projectedBytes, savedBytes: inputBytes - projectedBytes,
      messageCount: messages.length,
      modifiedMessageCount: new Set(omissions.map(item => item.messageIndex)).size,
      toolCallCount, toolResultCount, contactCallCount,
      orderedToolLinkageSha256: sha256(JSON.stringify(linkage)),
      currentTurnStartIndex: currentStart,
      duplicateFileReads: omissions.filter(item => item.kind === 'duplicate-file-read').length,
      historicalMemoryReads: omissions.filter(item => item.kind === 'historical-memory-read').length,
      historicalMemoryWrites: omissions.filter(item => item.kind === 'historical-memory-write').length,
      omissions,
      informationLoss: memoryLoss
        ? ['Superseded complete MEMORY notes/status snapshots are absent from the model view. Latest MEMORY does not reconstruct them; the raw journal retains them.'] : [],
    },
  };
}

function recognizeSnapshot(assistantValue: unknown, toolValue: unknown, callIndex: number): Snapshot | undefined {
  const assistant = record(assistantValue);
  const tool = record(toolValue);
  if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls)
    || assistant.tool_calls.length !== 1 || tool?.role !== 'tool') return;
  if (!exactKeys(assistant, ['role', 'content', 'tool_calls'], ['reasoning_details', 'refusal'])
    || (assistant.content !== null && typeof assistant.content !== 'string')
    || !exactKeys(tool, ['role', 'tool_call_id', 'content'])) return;
  const call = record(assistant.tool_calls[0]);
  const fn = record(call?.function);
  if (!call || !exactKeys(call, ['id', 'type', 'function']) || call.type !== 'function'
    || typeof call.id !== 'string' || tool.tool_call_id !== call.id
    || !fn || !exactKeys(fn, ['name', 'arguments'])) return;
  if (fn.name !== 'files.read' && fn.name !== 'files.replace') return;
  const args = parseRecord(fn.arguments);
  const result = parseRecord(tool.content);
  if (!args || !result || !exactKeys(result, ['status', 'output']) || result.status !== 'succeeded') return;
  const output = record(result.output);
  if (!output || !Array.isArray(args.path) || args.path.length !== 1) return;
  const path = args.path[0];
  if (!['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'].includes(path)) return;
  if (!canonicalVersion(output.version) || typeof output.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(output.sha256) || !Number.isSafeInteger(output.byteLength)) return;
  let content: unknown;
  if (fn.name === 'files.read') {
    if (!exactKeys(args, ['path']) || !exactKeys(output, ['content', 'version', 'sha256', 'byteLength'])) return;
    content = output.content;
  } else {
    if (path !== 'MEMORY.md' || !exactKeys(args, ['path', 'expectedVersion', 'content'])
      || !canonicalVersion(args.expectedVersion) || output.outcome !== 'committed'
      || Number(output.version) !== Number(args.expectedVersion) + 1
      || !exactKeys(output, ['outcome', 'version', 'sha256', 'byteLength'], ['durability'])
      || (output.durability !== undefined && output.durability !== 'published_unsynced')) return;
    content = args.content;
  }
  if (typeof content !== 'string' || sha256(content) !== output.sha256
    || Buffer.byteLength(content, 'utf8') !== output.byteLength) return;
  return {
    callIndex, resultIndex: callIndex + 1, id: call.id, operation: fn.name,
    path, args, result, output, content, version: output.version,
    sha256: output.sha256, byteLength: output.byteLength as number,
  };
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : undefined;
}

function parseRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'string') return;
  try { return record(JSON.parse(value)); } catch { return; }
}

function exactKeys(value: JsonRecord, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function canonicalVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
    && Number.isSafeInteger(Number(value));
}

function staticKey(snapshot: Snapshot): string {
  return `${snapshot.path}\0${snapshot.sha256}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
