import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultSharedOsDirV1, loadSharedOsModulesV1 } from '../../src/execution/sharedos/v1/load-sharedos.js';
import type { ActorContextMessage } from '../../src/runner/context/actor-context.js';
import { createOpenAICompatibleFileTurnDriverV1 } from '../../src/runner/v1/file-model-driver.js';
import { pactModelConfigV1Schema } from '../../src/runner/v1/model-config.js';
import { createPreloadedSharedOsFileSessionFactoryV1 } from '../../src/runner/v1/sharedos-file-session.js';
import type { CreateSharedOsFileSessionV1Options } from '../../src/runner/v1/sharedos-file-session-contracts.js';
import { runPactPairFilesMultiV1 } from '../../src/suites/pact-pair/files-multi.js';
import { runPactPairFilesSingleV1 } from '../../src/suites/pact-pair/files-single.js';
import { createPactPairWorkspaceV1, loadCanonicalPactPairStoreV1 } from '../../src/suites/pact-pair/workspace.js';
import {
  fileSessionActorsV1, fileSessionQaTasksV1, fileSessionRegistryRootV1,
  fileSessionSingleActorsV1, fileWorkflowHostRunProvenanceFixtureV1,
} from './file-workflow-test-fixtures.js';

const files = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'];
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js'))
  ? 'Pinned SharedOS build is unavailable' : false;
const world = { protocol: 'actor-context/v1' as const, maxContextBytes: 1_048_576 };
type WireRequest = { messages: ActorContextMessage[]; tools: { function: { name: string } }[] };
type ObservedTurn = { role: 'requester' | 'responder'; ordinal: number; requests: WireRequest[] };

function scriptedProvider(options: { rejectedWrites?: number; duplicatePublication?: boolean } = {}) {
  const turns: ObservedTurn[] = [];
  const createDriver: CreateSharedOsFileSessionV1Options['createDriver'] = input => {
    const ordinal = turns.filter(turn => turn.role === input.role).length + 1;
    const turn: ObservedTurn = { role: input.role, ordinal, requests: [] };
    turns.push(turn);
    let memory: { content: string; version: string } | undefined;
    let selectedTask = '';
    const rejectedWrites = ordinal === 1 ? options.rejectedWrites ?? 0 : 0;
    const duplicatePublication = ordinal === 1 && options.duplicatePublication ? 1 : 0;
    return createOpenAICompatibleFileTurnDriverV1({
      model: pactModelConfigV1Schema.parse({ provider: 'openai-compatible',
        baseUrl: 'https://unit-test.invalid/v1', apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY', model: 'context-test' }),
      environment: { SHAREDEVAL_MODEL_API_KEY: 'fake-key-never-sent-to-network' },
      ...(input.actorContext ? { actorContext: input.actorContext } : {}),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as WireRequest;
        const step = turn.requests.length;
        turn.requests.push(body);
        const call = (name: string, args: Record<string, unknown>) => ({ content: null,
          tool_calls: [{ id: `step-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        let message: unknown;
        if (step < files.length) {
          message = call('files.read', { path: [files[step]] });
        } else if (input.role === 'responder') {
          message = { content: `responder-terminal-${ordinal}` };
        } else if (step === 4) {
          const toolResult = body.messages.at(-1);
          assert.equal(toolResult?.role, 'tool');
          memory = JSON.parse(String(toolResult?.content)).output;
          assert.ok(memory);
          selectedTask = memory.content.match(/^(PAIR-[^ ]+) \[pending\]/m)?.[1] ?? '';
          assert.ok(selectedTask, 'Current MEMORY must expose the pending task');
          message = call('messages.request', {
            recipient: { kind: 'agent', agentId: 'responder' },
            payload: { taskId: selectedTask, message: `ask-${selectedTask}` },
          });
        } else if (step <= 5 + rejectedWrites + duplicatePublication) {
          assert.ok(memory);
          const content = memory.content.split('\n').map(line => line.startsWith(`${selectedTask} `)
            ? line.replace('[pending]', '[answered]') : line).join('\n');
          message = call('files.replace', { path: ['MEMORY.md'], expectedVersion: memory.version,
            content: step < 5 + rejectedWrites ? 'invalid memory row' : content });
        } else {
          message = { content: `requester-terminal-${ordinal}` };
        }
        return new Response(JSON.stringify({ model: 'context-test', choices: [{ message }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
        { headers: { 'content-type': 'application/json' } });
      },
    });
  };
  return { turns, createDriver };
}

function commonOptions(workspaceRootDir: string, createDriver: CreateSharedOsFileSessionV1Options['createDriver']) {
  const identity = { provider: 'openai-compatible', requestedModel: 'context-test', resolvedModel: 'context-test' };
  return {
    workspaceRootDir, registryRootDir: fileSessionRegistryRootV1, world,
    runProvenance: { ...fileWorkflowHostRunProvenanceFixtureV1, models: { requester: identity, responder: identity } },
    tasks: fileSessionQaTasksV1(['PAIR-Q1', 'PAIR-Q2']),
    budget: { deadlineMs: 60_000, maxToolCalls: 24 }, createDriver,
  };
}

function assertCurrentReads(turn: ObservedTurn) {
  const current = turn.requests.at(-1)!.messages;
  const currentStart = current.map(message => message.role).lastIndexOf('user');
  const calls = current.slice(currentStart + 1).flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
  assert.deepEqual(calls.slice(0, 4).map(call => ({ name: call.function.name, path: JSON.parse(call.function.arguments).path })),
    files.map(path => ({ name: 'files.read', path: [path] })));
  const names = turn.requests[0]!.tools.map(tool => tool.function.name);
  assert.ok(names.includes('files.read'));
  assert.ok(names.includes('files.replace'));
  assert.equal(names.includes('messages.request'), turn.role === 'requester');
  assert.equal(names.includes('create_note'), false);
  assert.equal(names.includes('create_todo'), false);
}

test('native multi world retains actor history and recovers rejected MEMORY writes without exhausting later ticks', { skip }, async () => {
  const loaded = await loadSharedOsModulesV1();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  if (!loaded.ok) throw new Error('Pinned SharedOS unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'world-native-multi-'));
  const provider = scriptedProvider({ rejectedWrites: 2, duplicatePublication: true });
  try {
    const result = await runPactPairFilesMultiV1({
      ...commonOptions(directory, provider.createDriver), runId: 'native-world-multi', maxTicks: 2,
      storeRoot: join(directory, 'store'),
      requester: { ...fileSessionActorsV1.requester, actorId: 'requester' },
      responder: { ...fileSessionActorsV1.responder, actorId: 'responder' },
      pactWorkspace: createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
      createSharedOsSession: createPreloadedSharedOsFileSessionFactoryV1(loaded),
    });
    assert.deepEqual(result.outcomes.map(outcome => [outcome.taskId, outcome.status]),
      [['PAIR-Q1', 'answered'], ['PAIR-Q2', 'answered']]);
    assert.equal(result.contacts.length, 2);
    assert.equal(provider.turns.length, 4);
    for (const turn of provider.turns) assertCurrentReads(turn);
    const requester = provider.turns.filter(turn => turn.role === 'requester');
    const responder = provider.turns.filter(turn => turn.role === 'responder');
    const firstTurnResults = requester[0]!.requests.at(-1)!.messages
      .filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    assert.equal(firstTurnResults.filter(result => result.error?.code === 'file_memory_format_invalid').length, 2);
    assert.equal(firstTurnResults.filter(result => result.error?.code === 'file_publication_limit').length, 1);
    assert.equal(firstTurnResults.filter(result => result.output?.outcome === 'committed').length, 1);
    for (const turns of [requester, responder]) {
      assert.equal(turns[0]!.requests[0]!.messages.length, 1);
      assert.equal(turns[1]!.requests[0]!.messages.filter(message => message.role === 'user').length, 2);
      assert.ok(turns[1]!.requests[0]!.messages.some(message => message.content === `${turns[0]!.role}-terminal-1`));
    }
    assert.match(JSON.stringify(requester[1]!.requests[0]!.messages), /responder-terminal-1/);
    assert.doesNotMatch(JSON.stringify(responder[1]!.requests[0]!.messages), /requester-terminal-1/);
    assert.ok(result.ticks.every(tick => tick.requesterReads.length === 4));
    assert.ok(result.contacts.every(contact => contact.responderReads.length === 4));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native single worlds with identical actor IDs start from empty provider history for every task', { skip }, async () => {
  const loaded = await loadSharedOsModulesV1();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  if (!loaded.ok) throw new Error('Pinned SharedOS unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'world-native-single-'));
  const provider = scriptedProvider();
  try {
    await mkdir(join(directory, 'store'));
    const result = await runPactPairFilesSingleV1({
      ...commonOptions(directory, provider.createDriver), runId: 'native-world-single', maxTicks: 1,
      requester: { ...fileSessionSingleActorsV1.requester, actorId: 'requester' },
      responder: { ...fileSessionSingleActorsV1.responder, actorId: 'responder' },
      pactWorkspaceForTask: () => createPactPairWorkspaceV1(loadCanonicalPactPairStoreV1()),
      storeRootForTask: task => join(directory, 'store', task.taskId),
      createSharedOsSession: createPreloadedSharedOsFileSessionFactoryV1(loaded),
    });
    assert.equal(result.preparationFailures.length, 0);
    assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['answered', 'answered']);
    assert.equal(provider.turns.length, 4);
    for (const turn of provider.turns) {
      assert.equal(turn.requests[0]!.messages.length, 1);
      assert.equal(turn.requests[0]!.messages[0]!.role, 'user');
      assertCurrentReads(turn);
    }
    for (const turn of provider.turns.filter(turn => turn.ordinal === 2)) {
      assert.doesNotMatch(JSON.stringify(turn.requests), /requester-terminal-1|responder-terminal-1/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
