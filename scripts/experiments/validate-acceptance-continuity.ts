import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { sha256JsonV1, type JsonValue } from '../../src/contracts/json.js';
import { parseActorContextMessage, type ActorContextMessage } from '../../src/runner/context/actor-context.js';
import { assertWorldContextCommit, type WorldContextFrontiers } from '../../src/runner/world/profile.js';
import { fileWorkflowHeartbeatPayloadV1Schema, fileWorkflowQuarantinePayloadV1Schema,
  fileWorkflowRunBindingV1Schema, type FileWorkflowHeartbeatPayloadV1 } from '../../src/runner/v1/file-workflow-artifacts.js';
import { parseFileMemoryV1 } from '../../src/runner/v1/file-memory.js';
import { createAcceptanceTurnContextProjector } from './acceptance-context-projection.js';

const digest = (value: unknown) => sha256JsonV1(value as JsonValue);
const bytesHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const wireHash = (value: unknown) => bytesHash(JSON.stringify(value));
const object = z.record(z.unknown());
const captureSchema = z.object({ actorId: z.string(), driverId: z.number().int().positive(),
  requestId: z.number().int().positive(), rawMessagesSha256: z.string(), projectedMessagesSha256: z.string(),
  rawBodyBytes: z.number(), bodyBytes: z.number(), projection: object,
  body: z.object({ messages: z.array(z.unknown()) }).passthrough(),
}).passthrough();
export type ContinuityCapture = z.infer<typeof captureSchema>;
export type ContinuityTurn = { turnId: string; messages: ActorContextMessage[];
  beginSequence: number; finishSequence?: number; status?: string };
type Issue = { code: string; tick?: number; actorId?: string; driverId?: number; requestId?: number };
const requireTrue = (condition: unknown, code: string): void => { if (!condition) throw new Error(code); };
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const names = async (path: string, expression: RegExp) => (await readdir(path)).filter(name => expression.test(name)).sort();
const maybeNames = async (path: string, expression: RegExp) => {
  try { return await names(path, expression); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

function successfulTools(turn: ContinuityTurn | undefined, name: string) {
  return (turn?.messages ?? []).flatMap((message, index) => {
    if (message.role !== 'assistant') return [];
    return (message.tool_calls ?? []).filter(call => call.function.name === name).flatMap(call => {
      const result = turn!.messages.slice(index + 1).find(row => row.role === 'tool' && row.tool_call_id === call.id);
      if (result?.role !== 'tool') return [];
      try {
        const parsed = object.parse(JSON.parse(result.content));
        return parsed.status === 'succeeded'
          ? [{ args: object.parse(JSON.parse(call.function.arguments)), output: object.parse(parsed.output) }] : [];
      } catch { return []; }
    });
  });
}

// actor-context/v1 keeps original IDs on disk and deterministically renames each prior turn.
// The runtime's projection is private; use its canonical hash and message parser here.
export function projectContinuityHistory(turns: readonly ContinuityTurn[]): ActorContextMessage[] {
  return turns.flatMap(turn => {
    const pending = new Map<string, string>();
    const projected = turn.messages.map((message, index) => {
      const copy = parseActorContextMessage(message);
      if (copy.role !== 'tool') requireTrue(pending.size === 0, 'journal_pending_tool_calls');
      if (copy.role === 'assistant' && copy.tool_calls) {
        copy.tool_calls = copy.tool_calls.map(call => {
          requireTrue(!pending.has(call.id), 'journal_duplicate_tool_id');
          const id = `ctx_${digest([turn.turnId, index, call.id]).slice(0, 48)}`;
          pending.set(call.id, id);
          return { ...call, id };
        });
      } else if (copy.role === 'tool') {
        const id = pending.get(copy.tool_call_id);
        requireTrue(id, 'journal_tool_linkage');
        pending.delete(copy.tool_call_id);
        copy.tool_call_id = id!;
      }
      return copy;
    });
    requireTrue(pending.size === 0, 'journal_unresolved_tool_calls');
    return projected;
  });
}

export function validateContinuityCaptures(input: {
  prior: ActorContextMessage[]; turn: ContinuityTurn;
  captures: ContinuityCapture[]; projection: 'raw' | 'deduplicate';
}) {
  const projector = createAcceptanceTurnContextProjector();
  let previous: unknown[] = [], modifiedMessages = 0, maxSavedBytes = 0;
  const issues: Issue[] = [];
  const expectedCounts = new Set(input.turn.messages.flatMap((message, index) => message.role === 'assistant' ? [index] : []));
  if (input.turn.status !== 'succeeded') expectedCounts.add(input.turn.messages.length);
  for (const [index, capture] of input.captures.entries()) {
    const fail = (condition: unknown, code: string) => {
      if (!condition) issues.push({ code, actorId: capture.actorId, driverId: capture.driverId,
        requestId: capture.requestId });
    };
    const count = capture.body.messages.length - input.prior.length;
    fail(index > 0 || count === 1, 'capture_first_request_boundary');
    fail(count >= 1 && count <= input.turn.messages.length, 'capture_journal_boundary');
    fail(expectedCounts.has(count), 'capture_not_model_input_boundary');
    const raw = [...input.prior, ...input.turn.messages.slice(0, count)];
    fail(wireHash(raw) === capture.rawMessagesSha256, 'capture_raw_hash');
    fail(wireHash(capture.body.messages) === capture.projectedMessagesSha256, 'capture_projected_hash');
    fail(Buffer.byteLength(JSON.stringify(capture.body)) === capture.bodyBytes, 'capture_body_bytes');
    fail(Buffer.byteLength(JSON.stringify({ ...capture.body, messages: raw })) === capture.rawBodyBytes,
      'capture_raw_body_bytes');
    fail(isDeepStrictEqual(capture.body.messages.slice(0, previous.length), previous), 'capture_frozen_prefix');
    fail(isDeepStrictEqual(capture.body.messages.slice(input.prior.length), raw.slice(input.prior.length)),
      'capture_current_turn_changed');
    try {
      const expected = input.projection === 'raw' ? { messages: raw, metadata: { protocol: 'raw' } }
        : projector(raw);
      fail(isDeepStrictEqual(capture.body.messages, expected.messages), 'capture_projected_body');
      fail(isDeepStrictEqual(capture.projection, expected.metadata), 'capture_projection_metadata');
      if ('savedBytes' in expected.metadata) {
        maxSavedBytes = Math.max(maxSavedBytes, expected.metadata.savedBytes);
        modifiedMessages = Math.max(modifiedMessages, expected.metadata.modifiedMessageCount);
      }
    } catch { fail(false, 'capture_projection_reconstruction'); }
    previous = capture.body.messages;
  }
  const capturedLengths = new Set(input.captures.map(capture => capture.body.messages.length));
  for (const [index, message] of input.turn.messages.entries()) {
    if (message.role === 'assistant' && !capturedLengths.has(input.prior.length + index)) {
      issues.push({ code: 'capture_model_input_missing', actorId: input.captures[0]?.actorId,
        driverId: input.captures[0]?.driverId });
    }
  }
  return { issues, requests: input.captures.length, priorMessages: input.prior.length,
    modifiedMessages, maxSavedBytes };
}

export async function validateAcceptanceContinuity(options: { runRoot: string; outputDirectory: string }) {
  const requestedRoot = resolve(options.runRoot);
  const root = basename(requestedRoot) === 'multi' ? dirname(requestedRoot) : requestedRoot;
  const lane = join(root, 'multi'), ledger = join(lane, '.sharedeval-file-workflow');
  const context = join(lane, '.sharedeval-actor-context');
  const issues: Issue[] = [], limitations: Issue[] = [];
  const check = (condition: unknown, code: string, details: Omit<Issue, 'code'> = {}) => {
    if (!condition) issues.push({ code, ...details });
  };
  const bindingEnvelope = object.parse(await readJson(join(ledger, 'binding.json')));
  const binding = fileWorkflowRunBindingV1Schema.parse(bindingEnvelope.binding);
  check(digest(bindingEnvelope.binding) === bindingEnvelope.bindingDigest, 'binding_digest');
  const manifest = object.parse(await readJson(join(context, 'manifest.json')));
  const actorIds = [binding.actors.requester.actorId, binding.actors.responder.actorId].sort();
  check(manifest.version === 'actor-context/v1' && manifest.bindingDigest === bindingEnvelope.bindingDigest
    && manifest.worldId === binding.sharedOs.namespaceId && isDeepStrictEqual(manifest.actorIds, actorIds)
    && manifest.maxContextBytes === binding.scheduler.world?.maxContextBytes, 'context_manifest_binding');
  const acceptance = object.parse(await readJson(join(root, 'acceptance-manifest.json')));
  requireTrue(acceptance.projection === 'raw' || acceptance.projection === 'deduplicate', 'unsupported_projection');
  const projection = acceptance.projection as 'raw' | 'deduplicate';
  check(isDeepStrictEqual(acceptance.taskIds, binding.selectedTaskIds)
    && acceptance.configDigest === binding.scheduler.configurationDigest, 'acceptance_manifest_binding');
  const overlay = object.parse(acceptance.overlaySha256);
  const projectorHash = bytesHash(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'acceptance-context-projection.ts')));
  check(overlay['acceptance-context-projection.ts'] === projectorHash, 'projection_source_hash');

  // Snapshot immutable ledger names first. Everything beyond this cut is explicitly excluded.
  const recordNames = await names(join(ledger, 'records'), /^record-\d{12}\.json$/);
  const records: FileWorkflowHeartbeatPayloadV1[] = [];
  let previousDigest: unknown = null;
  let frontiers: WorldContextFrontiers = actorIds.map(actorId => ({ actorId, sequence: 0,
    hash: digest([digest(manifest), actorId]) }));
  const frontierHistory: WorldContextFrontiers[] = [frontiers];
  for (const [sequence, file] of recordNames.entries()) {
    const record = object.parse(await readJson(join(ledger, 'records', file)));
    const payloadValue = object.parse(record.payload);
    const material = structuredClone(record);
    delete material.recordDigest;
    delete (material.payload as Record<string, unknown>).privateEvidence;
    check(record.apiVersion === 'sharedeval-file-heartbeat-record/v1' && record.sequence === sequence
      && file === `record-${String(sequence).padStart(12, '0')}.json`
      && record.bindingDigest === bindingEnvelope.bindingDigest && record.previousRecordDigest === previousDigest
      && record.recordDigest === digest(material), 'ledger_hash_chain');
    previousDigest = record.recordDigest;
    if (fileWorkflowQuarantinePayloadV1Schema.safeParse(payloadValue).success) {
      limitations.push({ code: 'quarantined_record' });
      continue;
    }
    const payload = fileWorkflowHeartbeatPayloadV1Schema.parse(payloadValue);
    const tick = payload.event.tick;
    check(payload.event.runId === binding.runId && payload.event.sessionId === binding.scheduler.sessionId,
      'heartbeat_binding', { tick });
    check(!records.some(row => row.event.tick === tick), 'duplicate_tick', { tick });
    check(Boolean(payload.privateEvidence)
      && digest(payloadValue.privateEvidence) === payload.privateEvidenceDigest, 'private_evidence_digest', { tick });
    if (payload.worldContext) {
      try { assertWorldContextCommit(actorIds, payload.worldContext, frontiers); }
      catch { check(false, 'world_frontier_continuity', { tick }); }
      frontiers = payload.worldContext.after;
      frontierHistory.push(frontiers);
    } else check(false, 'world_frontier_missing', { tick });
    records.push(payload);
  }

  const turnsByActor = new Map<string, ContinuityTurn[]>();
  const excludedJournalRecords: { actorId: string; records: number; committedSequence: number }[] = [];
  for (const frontier of frontiers) {
    const directory = join(context, 'actors', bytesHash(frontier.actorId));
    const journalNames = await names(directory, /^record-\d{12}\.json$/);
    const committed = journalNames.filter(file => Number(file.slice(7, 19)) <= frontier.sequence);
    excludedJournalRecords.push({ actorId: frontier.actorId, records: journalNames.length - committed.length,
      committedSequence: frontier.sequence });
    const turns: ContinuityTurn[] = [];
    const hashes = new Map<number, string>([[0, digest([digest(manifest), frontier.actorId])]]);
    for (const [index, file] of committed.entries()) {
      const row = object.parse(await readJson(join(directory, file)));
      const material = { ...row }; delete material.hash;
      const sequence = index + 1;
      check(row.version === 'actor-context-record/v1' && row.actorId === frontier.actorId
        && row.sequence === sequence && file === `record-${String(sequence).padStart(12, '0')}.json`
        && row.previousHash === hashes.get(sequence - 1) && row.hash === digest(material),
      'journal_hash_chain', { actorId: frontier.actorId });
      hashes.set(sequence, String(row.hash));
      const last = turns.at(-1);
      if (row.kind === 'begin') {
        check(!last || Boolean(last.status), 'journal_unfinished_prior_turn', { actorId: frontier.actorId });
        const input = parseActorContextMessage(row.input);
        check(row.inputHash === digest([...projectContinuityHistory(turns), input]), 'journal_begin_input_hash',
          { actorId: frontier.actorId });
        check(typeof row.turnId === 'string' && !turns.some(turn => turn.turnId === row.turnId), 'journal_turn_id');
        turns.push({ turnId: String(row.turnId), messages: [input], beginSequence: sequence });
      } else {
        requireTrue(last && !last.status && row.turnId === last.turnId, 'journal_turn_order');
        if (row.kind === 'message') last!.messages.push(parseActorContextMessage(row.message));
        else {
          requireTrue(row.kind === 'finish' && ['succeeded', 'failed', 'cancelled'].includes(String(row.status)),
            'journal_record_kind');
          last!.status = String(row.status); last!.finishSequence = sequence;
        }
      }
    }
    check(committed.length === frontier.sequence && hashes.get(frontier.sequence) === frontier.hash,
      'journal_committed_frontier', { actorId: frontier.actorId });
    for (const values of frontierHistory) {
      const point = values.find(row => row.actorId === frontier.actorId)!;
      check(hashes.get(point.sequence) === point.hash, 'journal_intermediate_frontier', { actorId: frontier.actorId });
      check(point.sequence === 0 || turns.some(turn => turn.finishSequence === point.sequence),
        'frontier_not_turn_boundary', { actorId: frontier.actorId });
    }
    check(turns.every(turn => turn.status), 'committed_turn_unfinished', { actorId: frontier.actorId });
    projectContinuityHistory(turns);
    turnsByActor.set(frontier.actorId, turns);
  }

  const memory = new Map(Object.values(binding.actors).map(actor => [actor.actorId,
    { version: 0, sha256: actor.initial['MEMORY.md'].sha256 }]));
  const contacts: { tick: number; taskId: string; contactId: string; status: string;
    memoryTiming: 'after_reply' | 'before_reply' | 'no_same_tick_commit' | 'contact_incomplete' }[] = [];
  const executionIds = new Set<string>();
  let memoryCommits = 0;
  for (const payload of records) {
    const { tick } = payload.event, source = payload.privateEvidence?.sourceEvidence;
    if (!source) continue;
    const authority = payload.sharedOsAuthority;
    const requester = turnsByActor.get(binding.actors.requester.actorId)!.find(turn => turn.turnId === authority.requesterExecutionId);
    const responder = turnsByActor.get(binding.actors.responder.actorId)!.find(turn => turn.turnId === authority.responderExecutionId);
    for (const [actor, executionId, turn] of [
      [binding.actors.requester.actorId, authority.requesterExecutionId, requester],
      [binding.actors.responder.actorId, authority.responderExecutionId, responder],
    ] as const) {
      if (!executionId) continue;
      executionIds.add(executionId);
      check(turn, 'execution_journal_missing', { tick, actorId: actor });
      if (turn && payload.worldContext) {
        const before = payload.worldContext.before.find(row => row.actorId === actor)!;
        const after = payload.worldContext.after.find(row => row.actorId === actor)!;
        check(turn.beginSequence > before.sequence && (turn.finishSequence ?? Infinity) <= after.sequence,
          'execution_outside_tick_frontier', { tick, actorId: actor });
      }
      if (turn?.status === 'succeeded') {
        check(source.auditEvents.some(event => event.type === 'tool.catalog.listed' && event.outcome === 'succeeded'
          && event.actor.kind === 'agent' && event.actor.agentId === actor), 'tool_catalog_missing', { tick, actorId: actor });
        check(['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'].every(path =>
          payload.fileReads.some(read => read.actorId === actor && read.path === path)),
        'four_file_read_missing', { tick, actorId: actor });
      }
    }
    if (authority.requesterExecutionStatus !== 'succeeded') limitations.push({ code: 'failed_or_cancelled_tick', tick });
    check(!requester || requester.status === authority.requesterExecutionStatus, 'execution_status', { tick });
    check(digest(source.auditEvents) === authority.audit.sha256, 'audit_digest', { tick });
    const operations = [...source.requesterFileOperations, ...source.responderFileOperations];
    for (const read of payload.fileReads) {
      const actor = Object.values(binding.actors).find(row => row.actorId === read.actorId)!;
      const state = memory.get(read.actorId)!;
      check(actor && state && read.version === state.version
        && read.sha256 === (read.path === 'MEMORY.md' ? state.sha256 : actor.initial[read.path].sha256),
      'fresh_file_read', { tick, actorId: read.actorId });
      const turn = read.actorId === binding.actors.requester.actorId ? requester : responder;
      check(successfulTools(turn, 'files.read').some(({ args, output }) => isDeepStrictEqual(args.path, [read.path])
        && Number(output.version) === read.version && output.sha256 === read.sha256 && output.byteLength === read.byteLength
        && typeof output.content === 'string' && bytesHash(output.content) === read.sha256),
      'file_read_journal', { tick, actorId: read.actorId });
    }
    for (const transition of payload.memoryTransitions) {
      const state = memory.get(transition.actorId);
      const operation = operations.find(op => op.action === 'replace' && op.outcome === 'committed'
        && op.actorId === transition.actorId && op.version === transition.newVersion);
      check(state?.version === transition.previousVersion && state.sha256 === transition.previousSha256
        && transition.newVersion === transition.previousVersion + 1, 'memory_chain', { tick, actorId: transition.actorId });
      if (operation?.action === 'replace' && operation.outcome === 'committed') {
        const previous = Buffer.from(operation.previousBytesBase64, 'base64'), next = Buffer.from(operation.newBytesBase64, 'base64');
        check(bytesHash(previous) === transition.previousSha256 && bytesHash(next) === transition.newSha256
          && next.length === transition.byteLength && operation.sha256 === transition.newSha256,
        'memory_committed_bytes', { tick, actorId: transition.actorId });
        const turn = transition.actorId === binding.actors.requester.actorId ? requester : responder;
        check(successfulTools(turn, 'files.replace').some(({ args, output }) => isDeepStrictEqual(args.path, ['MEMORY.md'])
          && Number(args.expectedVersion) === transition.previousVersion && typeof args.content === 'string'
          && args.content === next.toString('utf8') && Number(output.version) === transition.newVersion
          && output.sha256 === transition.newSha256), 'memory_replace_journal', { tick, actorId: transition.actorId });
        const rows = payload.memoryAuthorities.find(row => row.actorId === transition.actorId && row.newVersion === transition.newVersion);
        try {
          const project = (bytes: Buffer) => parseFileMemoryV1({ content: bytes.toString('utf8'),
            selectedTaskIds: binding.selectedTaskIds }).map(({ taskId, status }) => ({ taskId, status }));
          check(rows && isDeepStrictEqual(project(previous), rows.previousRows)
            && isDeepStrictEqual(project(next), rows.newRows), 'memory_row_authority', { tick, actorId: transition.actorId });
        } catch { check(false, 'memory_row_parse', { tick, actorId: transition.actorId }); }
      } else check(false, 'memory_operation_missing', { tick, actorId: transition.actorId });
      memory.set(transition.actorId, { version: transition.newVersion, sha256: transition.newSha256 });
      memoryCommits += 1;
    }
    const contact = payload.contactAuthority;
    if (!contact) {
      check(source.acceptedMessages.length === 0, 'unattributed_contact', { tick });
      continue;
    }
    const contactRow: typeof contacts[number] = { tick, taskId: contact.taskId, contactId: contact.contactId,
      status: contact.status, memoryTiming: 'contact_incomplete' };
    contacts.push(contactRow);
    const request = source.acceptedMessages.find(row => row.id === contact.contactId);
    const reply = source.acceptedMessages.find(row => row.id === contact.replyMessageId);
    const requestPayload = object.safeParse(request?.payload).data;
    const replyPayload = object.safeParse(reply?.payload).data;
    check(request && request.sender.kind === 'agent' && request.sender.agentId === contact.senderId
      && requestPayload?.taskId === contact.taskId && typeof requestPayload?.message === 'string', 'contact_request_envelope', { tick });
    check(source.acceptedMessages.length === (reply ? 2 : 1), 'contact_envelope_cardinality', { tick });
    const calls = requester?.messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : [])
      .filter(call => call.function.name === 'messages.request') ?? [];
    const matchingCalls = calls.filter(call => {
      try { return isDeepStrictEqual(JSON.parse(call.function.arguments).payload, request?.payload); }
      catch { return false; }
    });
    check(matchingCalls.length === 1, 'contact_request_journal', { tick });
    if (typeof requestPayload?.message === 'string' && responder) {
      check(responder.messages[0]?.role === 'user' && responder.messages[0].content.includes(requestPayload.message),
        'contact_responder_input', { tick });
    }
    if (contact.status === 'completed' || contact.status === 'denied') {
      check(reply?.replyTo === request?.id && replyPayload?.status === contact.status
        && reply?.sender.kind === 'agent' && reply.sender.agentId === contact.recipientId, 'contact_reply_envelope', { tick });
      const results = requester?.messages.filter(message => message.role === 'tool'
        && matchingCalls.some(call => call.id === message.tool_call_id)) ?? [];
      check(results.some(message => {
        try { return message.role === 'tool' && isDeepStrictEqual(JSON.parse(message.content).output, reply?.payload); }
        catch { return false; }
      }), 'contact_reply_journal', { tick });
      if (typeof replyPayload?.response === 'string') {
        check(responder?.messages.some(message => message.role === 'assistant' && message.content === replyPayload.response),
          'contact_responder_reply_journal', { tick });
      }
      const requestIndex = source.auditEvents.findIndex(event => event.type === 'message.sent' && event.messageId === request?.id);
      const replyIndex = source.auditEvents.findIndex(event => event.type === 'message.sent' && event.messageId === reply?.id);
      const memoryIndex = source.auditEvents.findIndex(event => event.type === 'tool.invoked' && event.tool === 'files.replace'
        && event.outcome === 'succeeded' && event.actor.kind === 'agent' && event.actor.agentId === contact.senderId);
      check(requestIndex >= 0 && replyIndex > requestIndex, 'contact_audit_order', { tick });
      if (payload.memoryTransitions.some(row => row.actorId === contact.senderId)) {
        contactRow.memoryTiming = memoryIndex > replyIndex ? 'after_reply' : 'before_reply';
        // A prior turn's delayed MEMORY repair can precede this tick's new contact.
        if (memoryIndex <= replyIndex) limitations.push({ code: 'contact_memory_before_reply', tick });
      } else contactRow.memoryTiming = 'no_same_tick_commit';
    } else limitations.push({ code: 'failed_or_cancelled_contact', tick });
  }
  for (const [actorId, turns] of turnsByActor) for (const turn of turns) {
    check(executionIds.has(turn.turnId), 'unattributed_committed_turn', { actorId });
  }

  const captureFiles = await maybeNames(join(root, 'private-provider'), /^\d{6}-.+\.request\.json\.gz$/);
  const groups = new Map<string, { actorId: string; driverId: number; files: string[] }>();
  for (const file of captureFiles) {
    const match = /^\d{6}-(.+)-(\d+)\.request\.json\.gz$/.exec(file)!;
    const key = `${match[1]}:${match[2]}`;
    const group = groups.get(key) ?? { actorId: match[1]!, driverId: Number(match[2]), files: [] };
    group.files.push(file); groups.set(key, group);
  }
  const drivers: { actorId: string; driverId: number; turnId: string; tick: number | null;
    requests: number; telemetryAttempts: number | null; priorMessages: number; modifiedMessages: number; maxSavedBytes: number }[] = [];
  const excludedCaptures: { actorId: string; driverId: number; requests: number; reason: string }[] = [];
  const coveredTurns = new Set<string>();
  for (const group of groups.values()) {
    const readCapture = async (file: string) => captureSchema.parse(JSON.parse(gunzipSync(
      await readFile(join(root, 'private-provider', file)), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')));
    const turns = turnsByActor.get(group.actorId);
    if (!turns) { check(false, 'capture_foreign_actor', { actorId: group.actorId }); continue; }
    let first: ContinuityCapture;
    try { first = await readCapture(group.files[0]!); }
    catch {
      // Capture publication is not atomic. An unbound partial file cannot be labeled committed or validated.
      excludedCaptures.push({ actorId: group.actorId, driverId: group.driverId, requests: group.files.length,
        reason: 'unreadable_unbound_capture' });
      limitations.push({ code: 'unreadable_unbound_capture', actorId: group.actorId, driverId: group.driverId });
      continue;
    }
    let prior: ActorContextMessage[] = [], matched: ContinuityTurn | undefined;
    for (const turn of turns) {
      if (first.body.messages.length === prior.length + 1) { matched = turn; break; }
      prior.push(...projectContinuityHistory([turn]));
    }
    if (!matched) {
      const beyond = first.body.messages.length >= prior.length + 1;
      check(beyond, 'capture_unmatched_committed_boundary', { actorId: group.actorId, driverId: group.driverId });
      excludedCaptures.push({ actorId: group.actorId, driverId: group.driverId, requests: group.files.length,
        reason: beyond ? 'beyond_committed_frontier' : 'unmatched_boundary' });
      continue;
    }
    const captures: ContinuityCapture[] = [];
    for (const file of group.files) {
      let capture: ContinuityCapture;
      try { capture = await readCapture(file); }
      catch { check(false, 'committed_capture_unreadable', { actorId: group.actorId, driverId: group.driverId }); continue; }
      check(capture.actorId === group.actorId && capture.driverId === group.driverId
        && capture.requestId === Number(file.slice(0, 6)), 'capture_filename_identity',
      { actorId: group.actorId, driverId: group.driverId });
      captures.push(capture);
    }
    check(!coveredTurns.has(matched.turnId), 'duplicate_capture_driver_for_turn', { actorId: group.actorId, driverId: group.driverId });
    coveredTurns.add(matched.turnId);
    const result = validateContinuityCaptures({ prior, turn: matched, captures, projection });
    issues.push(...result.issues);
    const heartbeat = records.find(record => [record.sharedOsAuthority.requesterExecutionId,
      record.sharedOsAuthority.responderExecutionId].includes(matched.turnId));
    const tick = heartbeat?.event.tick ?? null;
    const telemetry = heartbeat?.privateEvidence?.providerTelemetry[group.actorId === binding.actors.requester.actorId ? 'requester' : 'responder'];
    const telemetryAttempts = telemetry?.requests.reduce((sum, row) => sum + row.attempts, 0) ?? null;
    if (matched.status !== 'succeeded' && telemetryAttempts !== null && result.requests > telemetryAttempts) {
      // A cancelled dispatch may have a durable request capture but no completed telemetry row.
      limitations.push({ code: 'failed_turn_unreconciled_capture_attempts', actorId: group.actorId, driverId: group.driverId,
        ...(tick === null ? {} : { tick }) });
    } else check(telemetryAttempts === result.requests, 'capture_telemetry_attempt_count',
      { actorId: group.actorId, driverId: group.driverId });
    drivers.push({ actorId: group.actorId, driverId: group.driverId, turnId: matched.turnId, tick,
      requests: result.requests, telemetryAttempts, priorMessages: result.priorMessages,
      modifiedMessages: result.modifiedMessages, maxSavedBytes: result.maxSavedBytes });
  }
  for (const [actorId, turns] of turnsByActor) for (const turn of turns) {
    if (!coveredTurns.has(turn.turnId)) {
      if (turn.status === 'succeeded') check(false, 'committed_turn_capture_missing', { actorId });
      else limitations.push({ code: 'failed_turn_without_capture', actorId });
    }
  }
  if (acceptance.harness === 'codex') limitations.push({ code: 'native_sidecars_not_verified' });
  const report = { protocol: 'pair-acceptance-continuity/v1', runId: binding.runId,
    checkedAt: new Date().toISOString(), harness: acceptance.harness, projection, projectorHash,
    passed: issues.length === 0, committedOnly: true, completeEvidence: limitations.length === 0,
    committedRecords: recordNames.length, committedTicks: records.length, lastCommittedTick: records.at(-1)?.event.tick ?? null,
    lastRecordDigest: previousDigest, frontiers, contacts, memoryCommits,
    memoryFrontiers: [...memory].map(([actorId, value]) => ({ actorId, ...value })),
    committedCaptures: drivers.reduce((sum, driver) => sum + driver.requests, 0), drivers,
    excludedCaptures, excludedJournalRecords, issues, limitations,
    scope: 'Local evidence continuity at the SharedEval driver -> transport boundary only. In-flight captures are not verified or scored. Captures are upstream attempts for DeepSeek and bridge exchanges, not model-call counts, for Codex. Native sidecars, app-server injection mapping, host/provider prompt assembly, and internal reasoning are not validated. No behavioral or statistical causality claim.' };
  const output = resolve(options.outputDirectory);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'continuity.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, 'continuity.md'), [
    '# Acceptance Continuity', '', `- Run: ${binding.runId}`,
    `- Integrity checks: ${report.passed ? 'PASS' : 'FAIL'} (${issues.length} issues).`,
    `- Committed ledger records: ${report.committedRecords}; heartbeat ticks: ${report.committedTicks}.`,
    `- Committed actor turns: ${drivers.length}; driver-to-transport captures checked: ${report.committedCaptures}.`,
    `- Contacts: ${contacts.length}; MEMORY commits: ${memoryCommits}.`,
    `- Drivers with actual projection omissions: ${drivers.filter(row => row.modifiedMessages > 0).length}.`,
    `- Excluded or unbound captures: ${excludedCaptures.reduce((sum, row) => sum + row.requests, 0)}.`,
    `- Excluded journal records: ${excludedJournalRecords.reduce((sum, row) => sum + row.records, 0)}.`,
    `- Evidence limitations: ${limitations.length}.`, '', report.scope, '',
    ...issues.map(issue => `- ${issue.code}${issue.tick ? ` (tick ${issue.tick})` : ''}`), '',
  ].join('\n'), { mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const runRoot = process.argv.includes('--run-root') ? flag('--run-root') : undefined;
  const outputDirectory = process.argv.includes('--output-dir') ? flag('--output-dir') : undefined;
  if (!runRoot || !outputDirectory) {
    process.stderr.write('Usage: validate-acceptance-continuity.ts --run-root <run-root> --output-dir <report-directory>\n');
    process.exitCode = 2;
  } else validateAcceptanceContinuity({ runRoot, outputDirectory }).then(report => {
    process.stdout.write(`${JSON.stringify({ passed: report.passed, committedTicks: report.committedTicks,
      committedCaptures: report.committedCaptures, issues: report.issues.length,
      limitations: report.limitations.length, outputDirectory: resolve(outputDirectory) })}\n`);
    if (!report.passed) process.exitCode = 1;
  }).catch(async () => {
    // Never print parser errors: malformed evidence can contain private corpus or model text.
    try {
      await mkdir(resolve(outputDirectory), { recursive: true });
      await writeFile(join(resolve(outputDirectory), 'continuity.json'), `${JSON.stringify({
        protocol: 'pair-acceptance-continuity/v1', checkedAt: new Date().toISOString(), passed: false,
        aborted: true, issues: [{ code: 'invalid_or_unavailable_local_evidence' }],
        scope: 'Validation aborted; no continuity or behavior claim is supported by this report.',
      }, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(resolve(outputDirectory), 'continuity.md'),
        '# Acceptance Continuity\n\nValidation aborted: invalid or unavailable local evidence. No continuity or behavior claim.\n',
        { mode: 0o600 });
    } catch { /* A read-only or unavailable report directory cannot receive a failure artifact. */ }
    process.stderr.write('continuity_validation_aborted: invalid or unavailable local evidence\n');
    process.exitCode = 2;
  });
}
