import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ACCEPTANCE_CONTEXT_PROJECTION_VERSION,
  projectAcceptanceContext,
} from '../../scripts/experiments/acceptance-context-projection.js';

type Message = Record<string, any>;
const text = (label: string, count = 180) => `${label}\n`.repeat(count);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const files = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'];

function call(id: string, name: string, args: unknown): Message {
  return { role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function result(id: string, output: unknown): Message {
  return { role: 'tool', tool_call_id: id, content: JSON.stringify({ status: 'succeeded', output }) };
}

function read(id: string, path: string, content: string, version: number): Message[] {
  return [call(id, 'files.read', { path: [path] }),
    result(id, { content, version: String(version), sha256: hash(content), byteLength: bytes(content) })];
}

function write(id: string, content: string, expectedVersion: number): Message[] {
  return [call(id, 'files.replace', { path: ['MEMORY.md'], expectedVersion: String(expectedVersion), content }),
    result(id, { outcome: 'committed', version: String(expectedVersion + 1),
      sha256: hash(content), byteLength: bytes(content) })];
}

function contact(id: string, tick: number): Message[] {
  return [call(id, 'messages.request', { recipient: { kind: 'agent', agentId: 'responder' },
    payload: { taskId: `PAIR-Q-${tick}`, message: `Real draft ${tick}: please reconsider.` } }),
  result(id, { status: 'completed', output: { type: 'refused', content: `Actual responder reply ${tick}: no.` } })];
}

function output(message: Message): Message {
  return JSON.parse(message.content).output;
}

function args(message: Message): Message {
  return JSON.parse(message.tool_calls[0].function.arguments);
}

function toolIds(messages: Message[]): unknown[] {
  return messages.flatMap((message, index) => message.role === 'assistant'
    ? (message.tool_calls ?? []).map((tool: Message) => ['call', index, tool.id, tool.function.name])
    : message.role === 'tool' ? [['result', index, message.tool_call_id]] : []);
}

test('deduplicates identical static bytes while keeping every workspace version and changed POLICY content', () => {
  const first = text('policy-v1');
  const second = text('policy-v2');
  const messages = [
    { role: 'user', content: 'tick 1' }, ...read('p1', 'POLICY.md', first, 0),
    { role: 'user', content: 'tick 2' }, ...read('p2', 'POLICY.md', first, 1),
    { role: 'user', content: 'tick 3' }, ...read('p3', 'POLICY.md', second, 2),
    { role: 'user', content: 'tick 4' }, ...read('p4', 'POLICY.md', second, 3),
  ];
  const projected = projectAcceptanceContext(messages);
  assert.equal(projected.metadata.duplicateFileReads, 2);
  for (const index of [2, 8]) {
    const old = output(messages[index]);
    const next = output(projected.messages[index]);
    assert.match(next.content, /acceptance-context-projection\/v1/);
    assert.deepEqual({ ...next, content: old.content }, old);
  }
  assert.equal(output(projected.messages[5]).content, first);
  assert.equal(output(projected.messages[11]).content, second);
  assert.deepEqual(projected.metadata.omissions.map(item => [item.version, item.retainedContentAt.version]),
    [['0', '1'], ['2', '3']]);
  assert.deepEqual(projected.metadata.informationLoss, []);
});

test('keeps latest four reads and entire current turn verbatim, including earlier duplicate reads', () => {
  const messages: Message[] = [{ role: 'user', content: 'old turn' }];
  for (const file of files) messages.push(...read(`old-${file}`, file, text(file), 0));
  const boundary = messages.length;
  messages.push({ role: 'user', content: 'current turn' });
  for (const file of files) messages.push(...read(`current-${file}`, file, text(file), 1));
  messages.push(...read('current-policy-repeat', 'POLICY.md', text('POLICY.md'), 1));
  messages.push(...write('current-memory-write', text('new complete memory'), 1));
  const projected = projectAcceptanceContext(messages);
  assert.equal(projected.metadata.currentTurnStartIndex, boundary);
  assert.deepEqual(projected.messages.slice(boundary), messages.slice(boundary));
  assert.equal(projected.metadata.duplicateFileReads, 3);
  assert.equal(projected.metadata.historicalMemoryReads, 1);
  assert.ok(projected.metadata.omissions.every(item => item.messageIndex < boundary));
});

test('compacts old successful MEMORY snapshots with explicit loss markers, preserving latest read and complete write', () => {
  const initial = text('PAIR-Q-1 [pending] old private plan');
  const earlier = text('PAIR-Q-1 [refused] old reasoning');
  const latest = text('PAIR-Q-1 [answered] current note');
  const messages: Message[] = [
    { role: 'user', content: 'old turn' },
    ...read('m0', 'MEMORY.md', initial, 0),
    ...write('w0', earlier, 0),
    ...read('m1', 'MEMORY.md', earlier, 1),
    ...write('w1', latest, 1),
    { role: 'user', content: 'new turn has not read yet' },
  ];
  const projected = projectAcceptanceContext(messages);
  assert.match(output(projected.messages[2]).content, /historical MEMORY snapshot content/);
  assert.match(args(projected.messages[3]).content, /not original model text/);
  assert.equal(args(projected.messages[3]).expectedVersion, '0');
  assert.deepEqual(projected.messages[4], messages[4]);
  assert.equal(output(projected.messages[6]).content, earlier);
  assert.equal(args(projected.messages[7]).content, latest);
  assert.deepEqual(projected.messages[8], messages[8]);
  assert.equal(projected.metadata.historicalMemoryReads, 1);
  assert.equal(projected.metadata.historicalMemoryWrites, 1);
  assert.match(projected.metadata.informationLoss[0], /raw journal retains/);
  assert.equal(projected.metadata.omissions[1].expectedVersion, '0');
  assert.equal(projected.metadata.omissions[1].version, '1');
});

test('preserves failed writes, conflicts, malformed/unknown shapes and non-file resource observations', () => {
  const memory = text('original MEMORY');
  const error = write('error', text('invalid memory proposal'), 0);
  error[1].content = JSON.stringify({ status: 'denied', error: { code: 'file_memory_format_invalid', message: 'Correct each row.' } });
  const conflict = write('conflict', text('conflicting proposal'), 0);
  conflict[1].content = JSON.stringify({ status: 'succeeded', output: { outcome: 'conflict', version: '1',
    sha256: hash(memory), byteLength: bytes(memory) } });
  const wrongHash = read('wrong-hash', 'POLICY.md', text('policy'), 0);
  const wrongOutput = output(wrongHash[1]);
  wrongHash[1] = result('wrong-hash', { ...wrongOutput, sha256: '0'.repeat(64) });
  const unknownOutput = read('unknown', 'AGENT.md', text('agent'), 0);
  unknownOutput[1] = result('unknown', { ...output(unknownOutput[1]), futureMetadata: 'do not interpret' });
  const malformed = read('malformed', 'AGENT.md', text('agent'), 0);
  malformed[0].tool_calls[0].function.arguments = '{bad JSON';
  const resource = read('resource', 'secret-notes.json', text('valuable observation'), 0);
  const taskTool = [call('task-observation', 'notes.read', { id: 'note-1' }),
    result('task-observation', { content: text('task resource content') })];
  const messages = [{ role: 'user', content: 'old' }, ...error, ...conflict, ...wrongHash,
    ...unknownOutput, ...malformed, ...resource, ...taskTool, { role: 'user', content: 'new' },
    ...read('latest-memory', 'MEMORY.md', memory, 1),
    ...read('latest-policy', 'POLICY.md', text('policy'), 1),
    ...read('latest-agent', 'AGENT.md', text('agent'), 1)];
  const projected = projectAcceptanceContext(messages);
  assert.deepEqual(projected.messages, messages);
  assert.equal(projected.metadata.modifiedMessageCount, 0);
});

test('preserves first/last contact drafts and real replies, refusals, reasoning, corrections and tool linkage', () => {
  const messages: Message[] = [{ role: 'user', content: 'old tick' },
    ...contact('contact-first', 1),
    ...read('old-policy', 'POLICY.md', text('policy'), 0),
    ...write('old-write', text('old MEMORY'), 0),
    { role: 'assistant', content: 'I refuse that request.', refusal: 'No private disclosure.',
      reasoning_details: [{ type: 'reasoning.text', text: 'Historical reasoning stays intact.' }] },
    { role: 'tool', tool_call_id: 'parallel-denial', content: 'None of the calls executed; issue one call.' },
    { role: 'user', content: 'current tick' },
    ...read('new-policy', 'POLICY.md', text('policy'), 1),
    ...read('new-memory', 'MEMORY.md', text('new MEMORY'), 1),
    ...contact('contact-last', 300)];
  messages[5].content = 'Actual assistant explanation of its MEMORY update.';
  messages[5].refusal = 'A prior private request remains refused.';
  const projected = projectAcceptanceContext(messages);
  assert.equal(projected.messages.length, messages.length);
  assert.deepEqual(toolIds(projected.messages), toolIds(messages));
  const modified = new Set(projected.metadata.omissions.map(item => item.messageIndex));
  for (const [index, message] of messages.entries()) {
    if (!modified.has(index)) assert.deepEqual(projected.messages[index], message);
  }
  assert.equal(projected.messages[5].content, messages[5].content);
  assert.equal(projected.messages[5].refusal, messages[5].refusal);
  assert.equal(projected.metadata.contactCallCount, 2);
  assert.match(JSON.stringify(projected.messages), /Real draft 1:/);
  assert.match(JSON.stringify(projected.messages), /Actual responder reply 300:/);
});

test('unknown current boundary protects all input; explicit boundary can include a correction user message', () => {
  const noUser = [...read('a', 'AGENT.md', text('agent'), 0), ...read('b', 'AGENT.md', text('agent'), 1)];
  assert.deepEqual(projectAcceptanceContext(noUser).messages, noUser);
  const messages = [{ role: 'user', content: 'start' }, ...noUser,
    { role: 'user', content: 'correction within this same turn' }];
  assert.deepEqual(projectAcceptanceContext(messages, { currentTurnStartIndex: 0 }).messages, messages);
  assert.throws(() => projectAcceptanceContext(messages, { currentTurnStartIndex: -1 }), RangeError);
  assert.throws(() => projectAcceptanceContext(messages, { currentTurnStartIndex: 1.5 }), RangeError);
});

test('ambiguous duplicate IDs, parallel calls and incomplete calls pass through', () => {
  const first = read('duplicate', 'AGENT.md', text('agent'), 0);
  const duplicate = read('duplicate', 'AGENT.md', text('agent'), 1);
  const parallel = read('parallel-a', 'POLICY.md', text('policy'), 0);
  parallel[0].tool_calls.push(call('parallel-b', 'messages.request', {}).tool_calls[0]);
  const messages = [{ role: 'user', content: 'old' }, ...first, ...parallel,
    ...duplicate, call('pending', 'files.replace', { path: ['MEMORY.md'], expectedVersion: '1', content: text('pending') }),
    { role: 'user', content: 'new' }, ...read('latest', 'POLICY.md', text('policy'), 2)];
  assert.deepEqual(projectAcceptanceContext(messages).messages, messages);
});

test('projection and audit metadata are deterministic and never mutate or share objects with raw journal input', () => {
  const messages = [{ role: 'user', content: 'old' }, ...read('old', 'AGENT.md', text('agent'), 0),
    { role: 'user', content: 'new' }, ...read('latest', 'AGENT.md', text('agent'), 1)];
  const original = JSON.stringify(messages);
  freezeDeep(messages);
  const first = projectAcceptanceContext(messages);
  const second = projectAcceptanceContext(messages);
  assert.deepEqual(first, second);
  assert.equal(first.metadata.version, ACCEPTANCE_CONTEXT_PROJECTION_VERSION);
  assert.equal(first.metadata.inputSha256, hash(original));
  assert.equal(first.metadata.projectedSha256, hash(JSON.stringify(first.messages)));
  assert.equal(first.metadata.orderedToolLinkageSha256, hash(JSON.stringify(toolIds(messages))));
  assert.equal(first.metadata.inputBytes, bytes(original));
  assert.equal(first.metadata.projectedBytes, bytes(JSON.stringify(first.messages)));
  first.messages[4].tool_calls[0].function.name = 'local mutation';
  assert.equal(JSON.stringify(messages), original);
});

test('300 synthetic ticks retain all contacts and ordered IDs while eliminating repeated snapshot bulk', () => {
  const messages: Message[] = [];
  const immutable = new Map(files.slice(0, 3).map(file => [file, text(`${file} immutable instructions`, 360)]));
  for (let tick = 0; tick < 300; tick += 1) {
    messages.push({ role: 'user', content: `tick ${tick}` });
    for (const file of files.slice(0, 3)) messages.push(...read(`${tick}-${file}`, file, immutable.get(file)!, tick));
    messages.push(...read(`${tick}-memory`, 'MEMORY.md', text(`status at ${tick}`, 600), tick));
    messages.push(...contact(`${tick}-contact`, tick));
    messages.push(...write(`${tick}-write`, text(`status at ${tick + 1}`, 600), tick));
    messages.push({ role: 'assistant', content: `Actual terminal ${tick}` });
  }
  const projected = projectAcceptanceContext(messages);
  assert.equal(projected.metadata.contactCallCount, 300);
  assert.equal(projected.metadata.duplicateFileReads, 299 * 3);
  assert.equal(projected.metadata.historicalMemoryReads, 299);
  assert.equal(projected.metadata.historicalMemoryWrites, 299);
  assert.deepEqual(toolIds(projected.messages), toolIds(messages));
  for (const [index, message] of messages.entries()) {
    const name = message.tool_calls?.[0]?.function.name;
    if (name === 'messages.request') {
      assert.deepEqual(projected.messages[index], message);
      assert.deepEqual(projected.messages[index + 1], messages[index + 1]);
    }
  }
  assert.deepEqual(projected.messages.slice(-14), messages.slice(-14));
  assert.ok(projected.metadata.projectedBytes < projected.metadata.inputBytes * 0.15,
    `expected at least 85% reduction, got ${JSON.stringify({ before: projected.metadata.inputBytes, after: projected.metadata.projectedBytes })}`);
});

function freezeDeep(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}
