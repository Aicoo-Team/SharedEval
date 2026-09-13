import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sha256JsonV1, type JsonValue } from '../../src/contracts/json.js';
import type { ActorContextMessage } from '../../src/runner/context/actor-context.js';
import { openActorContextStore } from '../../src/runner/context/actor-context-store.js';
import { createAcceptanceTurnContextProjector } from '../../scripts/experiments/acceptance-context-projection.js';
import { projectContinuityHistory, validateAcceptanceContinuity, validateContinuityCaptures,
  type ContinuityCapture, type ContinuityTurn } from '../../scripts/experiments/validate-acceptance-continuity.js';
import { binding, heartbeatPayloadFor, memoryContent } from '../runner-v1/file-workflow-test-fixtures.js';

const sha = (value: unknown) => sha256JsonV1(value as JsonValue);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
const json = async (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`);
const call = (id: string, name: string, args: unknown): ActorContextMessage => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id: string, output: unknown): ActorContextMessage => ({ role: 'tool', tool_call_id: id,
  content: JSON.stringify({ status: 'succeeded', output }) });
const fileRead = (id: string, path: string, content: string, version = 0) => [
  call(id, 'files.read', { path: [path] }), result(id, { content, version: String(version), sha256: hash(content),
    byteLength: Buffer.byteLength(content) }),
];

function captureSeries(prior: ActorContextMessage[], turn: ContinuityTurn, actorId = 'requester', driverId = 1,
  mode: 'raw' | 'deduplicate' = 'deduplicate') {
  const projector = createAcceptanceTurnContextProjector();
  const captures: ContinuityCapture[] = [];
  for (let count = 1; count <= turn.messages.length; count += 1) {
    const last = turn.messages[count - 1]!;
    if (last.role !== 'user' && last.role !== 'tool') continue;
    const rawMessages = [...prior, ...turn.messages.slice(0, count)];
    const projected = mode === 'raw' ? { messages: rawMessages, metadata: { protocol: 'raw' } } : projector(rawMessages);
    const rawBody = { model: 'fixture', messages: rawMessages, tools: [] };
    const body = { ...rawBody, messages: projected.messages };
    captures.push({ actorId, driverId, requestId: captures.length + 1, body,
      rawMessagesSha256: jsonHash(rawMessages), projectedMessagesSha256: jsonHash(projected.messages),
      rawBodyBytes: Buffer.byteLength(JSON.stringify(rawBody)), bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      projection: projected.metadata });
  }
  return captures;
}

test('raw and frozen projected captures preserve complete own history and current contacts', () => {
  const previous: ContinuityTurn[] = [1, 2].map(index => ({ turnId: `prior-${index}`, beginSequence: 1,
    messages: [{ role: 'user', content: 'heartbeat' }, ...fileRead(`read-${index}`, 'POLICY.md', 'static policy '.repeat(100)),
      call(`contact-${index}`, 'messages.request', { payload: { message: `request ${index}` } }),
      result(`contact-${index}`, { response: `real reply ${index}` }), { role: 'assistant', content: 'done' }], status: 'succeeded' }));
  const prior = projectContinuityHistory(previous);
  const turn: ContinuityTurn = { turnId: 'current', beginSequence: 1,
    messages: [{ role: 'user', content: 'next heartbeat' }, ...fileRead('new-read', 'POLICY.md', 'static policy'),
      call('new-contact', 'messages.request', { payload: { message: 'new request' } }),
      result('new-contact', { response: 'real new reply' }), { role: 'assistant', content: 'done' }] };
  for (const projection of ['raw', 'deduplicate'] as const) {
    const captures = captureSeries(prior, turn, 'requester', 3, projection);
    const report = validateContinuityCaptures({ prior, turn, captures, projection });
    assert.deepEqual(report.issues, []);
    assert.equal(report.modifiedMessages > 0, projection === 'deduplicate');
    assert.equal(report.priorMessages, prior.length);
    assert.ok(JSON.stringify(captures.at(-1)!.body.messages).includes('real reply 1'));
    assert.ok(JSON.stringify(captures.at(-1)!.body.messages).includes('real new reply'));
  }
});

test('detects altered raw hash, projected body, frozen prefix, and current-turn text even with recomputed wire hash', () => {
  const turn: ContinuityTurn = { turnId: 'turn', beginSequence: 1, messages: [
    { role: 'user', content: 'PRIVATE_SENTINEL' }, ...fileRead('read', 'POLICY.md', 'policy'),
    { role: 'assistant', content: 'done' },
  ] };
  const captures = captureSeries([], turn);
  captures[1]!.rawMessagesSha256 = '0'.repeat(64);
  (captures[1]!.body.messages[0] as { content: string }).content = 'altered';
  captures[1]!.projectedMessagesSha256 = jsonHash(captures[1]!.body.messages);
  const codes = validateContinuityCaptures({ prior: [], turn, captures, projection: 'deduplicate' }).issues.map(row => row.code);
  for (const code of ['capture_raw_hash', 'capture_frozen_prefix', 'capture_current_turn_changed', 'capture_projected_body']) {
    assert.ok(codes.includes(code), code);
  }
});

async function fixture(inflight = false, requesterStatus: 'succeeded' | 'failed' = 'succeeded') {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-continuity-'));
  const lane = join(root, 'multi'), ledger = join(lane, '.sharedeval-file-workflow');
  await mkdir(join(ledger, 'records'), { recursive: true });
  await mkdir(join(root, 'private-provider'));
  const runBinding = binding('files-multi', 'continuity-fixture', ['PAIR-Q11']);
  runBinding.scheduler.world = { protocol: 'actor-context/v1', maxContextBytes: 16 * 1024 * 1024 };
  const bindingDigest = sha(runBinding);
  await json(join(ledger, 'binding.json'), { apiVersion: 'sharedeval-file-ledger-binding/v1', binding: runBinding,
    bindingDigest, retainPrivate: true });
  const projectorSource = await readFile(new URL('../../scripts/experiments/acceptance-context-projection.ts', import.meta.url));
  await json(join(root, 'acceptance-manifest.json'), { harness: 'fixture', projection: 'deduplicate',
    taskIds: runBinding.selectedTaskIds, configDigest: runBinding.scheduler.configurationDigest,
    overlaySha256: { 'acceptance-context-projection.ts': hash(projectorSource) } });
  const payload = heartbeatPayloadFor(runBinding, 1, [], {
    requesterExecutionStatus: requesterStatus,
    contact: { taskId: 'PAIR-Q11', kind: 'qa', status: 'completed', message: 'PRIVATE_SENTINEL request',
      response: 'PRIVATE_SENTINEL real reply' },
  });
  const audit = payload.privateEvidence.sourceEvidence.auditEvents;
  const replaceIndex = audit.findIndex((event: { type: string; tool?: string }) => event.type === 'tool.invoked' && event.tool === 'files.replace');
  audit.push(...audit.splice(replaceIndex, 1));
  payload.sharedOsAuthority.audit.sha256 = sha(audit);
  const store = await openActorContextStore({ directory: join(lane, '.sharedeval-actor-context'),
    worldId: runBinding.sharedOs.namespaceId, bindingDigest, actorIds: ['requester', 'responder'], maxContextBytes: 16 * 1024 * 1024 });
  const points = async () => {
    const rows = [];
    for (const actorId of ['requester', 'responder']) rows.push({ actorId, ...await store.getFrontier(actorId) });
    return rows;
  };
  const before = await points();
  const turns: Record<string, ContinuityTurn> = {};
  const replacement = payload.privateEvidence.sourceEvidence.requesterFileOperations.find((row: { action: string }) => row.action === 'replace');
  let requestId = 0;
  for (const [index, actorId] of ['requester', 'responder'].entries()) {
    const input: ActorContextMessage = { role: 'user', content: actorId === 'requester' ? 'heartbeat'
      : `Incoming request: ${payload.privateEvidence.sourceEvidence.acceptedMessages[0].payload.message}` };
    const turnId = actorId === 'requester' ? payload.sharedOsAuthority.requesterExecutionId : payload.sharedOsAuthority.responderExecutionId;
    const messages: ActorContextMessage[] = [input];
    for (const [path, suffix] of [['AGENT.md', 'agent'], ['HEARTBEAT.md', 'heartbeat'], ['POLICY.md', 'policy'], ['MEMORY.md', 'memory']]) {
      messages.push(...fileRead(`${actorId}-${suffix}`, path!, path === 'MEMORY.md'
        ? memoryContent(runBinding.selectedTaskIds, 0) : `${actorId}-${suffix}`));
    }
    if (actorId === 'requester') {
      messages.push(call('contact', 'messages.request', { recipient: { kind: 'agent', agentId: 'responder' },
        payload: payload.privateEvidence.sourceEvidence.acceptedMessages[0].payload }),
      result('contact', payload.privateEvidence.sourceEvidence.acceptedMessages[1].payload),
      call('memory-write', 'files.replace', { path: ['MEMORY.md'], expectedVersion: '0',
        content: Buffer.from(replacement.newBytesBase64, 'base64').toString('utf8') }),
      result('memory-write', { version: '1', sha256: replacement.sha256 }),
      { role: 'assistant', content: 'done' });
    } else messages.push({ role: 'assistant', content: 'PRIVATE_SENTINEL real reply' });
    const turn = await store.beginTurn({ actorId, turnId, input });
    const status = actorId === 'requester' ? requesterStatus : 'succeeded';
    await turn.append(messages.slice(1)); await turn.finish(status);
    turns[actorId] = { turnId, messages, beginSequence: 1, status };
    const captures = captureSeries([], turns[actorId]!, actorId, index + 1);
    const telemetry = payload.privateEvidence.providerTelemetry[actorId];
    telemetry.requests = captures.map(() => structuredClone(payload.privateEvidence.providerTelemetry.requester.requests[0]));
    telemetry.totals.requests = captures.length;
    for (const capture of captures) {
      capture.requestId = ++requestId;
      await writeFile(join(root, 'private-provider', `${String(requestId).padStart(6, '0')}-${actorId}-${index + 1}.request.json.gz`),
        gzipSync(JSON.stringify(capture)));
    }
  }
  payload.worldContext = { before, after: await points() };
  payload.privateEvidenceDigest = sha(payload.privateEvidence);
  const material = { apiVersion: 'sharedeval-file-heartbeat-record/v1', sequence: 0,
    bindingDigest, previousRecordDigest: null, payload };
  const publicMaterial = structuredClone(material); delete publicMaterial.payload.privateEvidence;
  const recordPath = join(ledger, 'records', 'record-000000000000.json');
  await json(recordPath, { ...material, recordDigest: sha(publicMaterial) });
  if (inflight) {
    const input: ActorContextMessage = { role: 'user', content: 'UNCOMMITTED_PRIVATE_SENTINEL' };
    await store.beginTurn({ actorId: 'requester', turnId: 'inflight-turn', input });
    const capture = captureSeries(projectContinuityHistory([turns.requester!]),
      { turnId: 'inflight-turn', beginSequence: 1, messages: [input] }, 'requester', 3)[0]!;
    capture.requestId = ++requestId;
    await writeFile(join(root, 'private-provider', `${String(requestId).padStart(6, '0')}-requester-3.request.json.gz`),
      gzipSync(JSON.stringify(capture)));
  }
  await store.close();
  return { root, recordPath, outputDirectory: join(root, 'report') };
}

test('validates committed journal, contact, MEMORY and captures while excluding in-flight evidence without raw text', async () => {
  const f = await fixture(true);
  try {
    const report = await validateAcceptanceContinuity({ runRoot: f.root, outputDirectory: f.outputDirectory });
    assert.deepEqual(report.issues, []);
    assert.equal(report.passed, true);
    assert.equal(report.contacts.length, 1);
    assert.equal(report.memoryCommits, 1);
    assert.equal(report.committedCaptures, 12);
    assert.equal(report.excludedCaptures[0]?.requests, 1);
    assert.equal(report.excludedCaptures[0]?.reason, 'beyond_committed_frontier');
    assert.equal(report.excludedJournalRecords.reduce((sum, row) => sum + row.records, 0), 1);
    for (const file of ['continuity.json', 'continuity.md']) {
      assert.doesNotMatch(await readFile(join(f.outputDirectory, file), 'utf8'), /PRIVATE_SENTINEL|real reply/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('missing committed driver cannot be misclassified as defended or in-flight', async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, 'private-provider');
    for (const file of await readdir(directory)) if (file.includes('-responder-')) await rm(join(directory, file));
    const report = await validateAcceptanceContinuity({ runRoot: f.root, outputDirectory: f.outputDirectory });
    assert.equal(report.passed, false);
    assert.ok(report.issues.some(issue => issue.code === 'committed_turn_capture_missing'));
    assert.deepEqual(report.excludedCaptures, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('detects rehashed MEMORY evidence that disagrees with journal and committed frontier tampering', async () => {
  const f = await fixture();
  try {
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    const operation = record.payload.privateEvidence.sourceEvidence.requesterFileOperations.find((row: { action: string }) => row.action === 'replace');
    const newBytes = Buffer.from(Buffer.from(operation.newBytesBase64, 'base64').toString('utf8').replace('memory 1', 'changed'));
    operation.newBytesBase64 = newBytes.toString('base64');
    operation.sha256 = hash(newBytes); operation.byteLength = newBytes.length;
    record.payload.memoryTransitions[0].newSha256 = hash(newBytes);
    record.payload.memoryTransitions[0].byteLength = newBytes.length;
    record.payload.memoryAuthorities[0].newSha256 = hash(newBytes);
    record.payload.worldContext.after[0].hash = 'f'.repeat(64);
    record.payload.privateEvidenceDigest = sha(record.payload.privateEvidence);
    const material = structuredClone(record); delete material.recordDigest; delete material.payload.privateEvidence;
    record.recordDigest = sha(material);
    await json(f.recordPath, record);
    const report = await validateAcceptanceContinuity({ runRoot: f.root, outputDirectory: f.outputDirectory });
    for (const code of ['memory_replace_journal', 'journal_committed_frontier']) {
      assert.ok(report.issues.some(issue => issue.code === code), code);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('deleting an interior or final model-input capture is detected even if all remaining prefixes match', () => {
  const turn: ContinuityTurn = { turnId: 'turn', beginSequence: 1, messages: [
    { role: 'user', content: 'heartbeat' }, ...fileRead('a', 'AGENT.md', 'agent'),
    ...fileRead('p', 'POLICY.md', 'policy'), { role: 'assistant', content: 'done' },
  ] };
  for (const removed of [1, 2]) {
    const captures = captureSeries([], turn);
    captures.splice(removed, 1);
    const report = validateContinuityCaptures({ prior: [], turn, captures, projection: 'deduplicate' });
    assert.ok(report.issues.some(issue => issue.code === 'capture_model_input_missing'));
  }
});

test('rejects extra capture at a non-model boundary and malformed finished tool linkage', () => {
  const turn: ContinuityTurn = { turnId: 'turn', beginSequence: 1, status: 'succeeded', messages: [
    { role: 'user', content: 'heartbeat' }, ...fileRead('a', 'AGENT.md', 'agent'), { role: 'assistant', content: 'done' },
  ] };
  const captures = captureSeries([], turn);
  const extra = structuredClone(captures[0]!);
  extra.body.messages = turn.messages.slice(0, 2);
  captures.splice(1, 0, extra);
  assert.ok(validateContinuityCaptures({ prior: [], turn, captures, projection: 'deduplicate' })
    .issues.some(issue => issue.code === 'capture_not_model_input_boundary'));
  assert.throws(() => projectContinuityHistory([{ ...turn, messages: turn.messages.slice(0, 2) }]), /journal_unresolved_tool_calls/);
  assert.throws(() => projectContinuityHistory([{ ...turn, messages: [turn.messages[0]!, turn.messages[1]!,
    { role: 'assistant', content: 'done' }] }]), /journal_pending_tool_calls/);
});

test('later-than-next and partially written unbound captures stay explicitly excluded from a frozen ledger snapshot', async () => {
  const f = await fixture(true);
  try {
    const directory = join(f.root, 'private-provider');
    const file = (await readdir(directory)).find(name => name.includes('-requester-3.'))!;
    const capture = JSON.parse(gunzipSync(await readFile(join(directory, file))).toString('utf8'));
    capture.body.messages.push({ role: 'assistant', content: 'future turn' }, { role: 'user', content: 'later turn' });
    await writeFile(join(directory, file), gzipSync(JSON.stringify(capture)));
    await writeFile(join(directory, '999999-requester-4.request.json.gz'), Buffer.from([31, 139]));
    const report = await validateAcceptanceContinuity({ runRoot: f.root, outputDirectory: f.outputDirectory });
    assert.equal(report.passed, true);
    assert.equal(report.committedCaptures, 12);
    assert.deepEqual(report.excludedCaptures.map(row => row.reason), ['beyond_committed_frontier', 'unreadable_unbound_capture']);
    assert.ok(report.limitations.some(row => row.code === 'unreadable_unbound_capture'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('capture contents do not become trusted by recomputing their declared projected hash', async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, 'private-provider');
    const file = (await readdir(directory)).sort()[1]!;
    const capture = JSON.parse(gunzipSync(await readFile(join(directory, file))).toString('utf8'));
    capture.body.messages[0].content = 'tampered private data';
    capture.projectedMessagesSha256 = jsonHash(capture.body.messages);
    await writeFile(join(directory, file), gzipSync(JSON.stringify(capture)));
    const report = await validateAcceptanceContinuity({ runRoot: f.root, outputDirectory: f.outputDirectory });
    assert.equal(report.passed, false);
    assert.ok(report.issues.some(issue => issue.code === 'capture_projected_body'));
    assert.ok(report.issues.some(issue => issue.code === 'capture_frozen_prefix'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('CLI persists a sanitized machine-readable failure report when evidence parsing aborts', async () => {
  const f = await fixture();
  try {
    await writeFile(f.recordPath, 'PRIVATE_SENTINEL invalid JSON');
    const script = new URL('../../scripts/experiments/validate-acceptance-continuity.ts', import.meta.url);
    const execution = spawnSync(process.execPath, ['--import', 'tsx', script.pathname,
      '--run-root', f.root, '--output-dir', f.outputDirectory], { encoding: 'utf8' });
    assert.equal(execution.status, 2);
    assert.doesNotMatch(execution.stdout + execution.stderr, /PRIVATE_SENTINEL/);
    const report = JSON.parse(await readFile(join(f.outputDirectory, 'continuity.json'), 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.aborted, true);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SENTINEL/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed-turn captures without telemetry stay explicitly unreconciled; successful turns require exact attempt counts', async () => {
  for (const status of ['succeeded', 'failed'] as const) {
    const f = await fixture(false, status);
    try {
      const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
      record.payload.privateEvidence.providerTelemetry.requester.requests.pop();
      record.payload.privateEvidence.providerTelemetry.requester.totals.requests -= 1;
      record.payload.privateEvidenceDigest = sha(record.payload.privateEvidence);
      const material = structuredClone(record); delete material.recordDigest; delete material.payload.privateEvidence;
      record.recordDigest = sha(material); await json(f.recordPath, record);
      const report = await validateAcceptanceContinuity({ runRoot: f.root, outputDirectory: f.outputDirectory });
      if (status === 'failed') {
        assert.equal(report.passed, true);
        assert.ok(report.limitations.some(row => row.code === 'failed_turn_unreconciled_capture_attempts'));
      } else assert.ok(report.issues.some(row => row.code === 'capture_telemetry_attempt_count'));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
