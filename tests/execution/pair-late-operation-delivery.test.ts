import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultSharedOsDirV1, loadSharedOsModulesV1 } from '../../src/execution/sharedos/v1/load-sharedos.js';
import { ActorContextError, type ActorContextMessage } from '../../src/runner/context/actor-context.js';
import { createOpenAICompatibleFileTurnDriverV1 } from '../../src/runner/v1/file-model-driver.js';
import { pactModelConfigV1Schema } from '../../src/runner/v1/model-config.js';
import { createPreloadedSharedOsFileSessionFactoryV1 } from '../../src/runner/v1/sharedos-file-session.js';
import type { CreateSharedOsFileSessionV1Options } from '../../src/runner/v1/sharedos-file-session-contracts.js';
import { runPactPairFilesMultiV1 } from '../../src/suites/pact-pair/files-multi.js';
import { createPactPairWorkspaceV1 } from '../../src/suites/pact-pair/workspace.js';
import { fileSessionActorsV1, fileSessionQaTasksV1, fileSessionRegistryRootV1,
  fileWorkflowHostRunProvenanceFixtureV1 } from '../runner-v1/file-workflow-test-fixtures.js';

const files = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'];
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js'))
  ? 'Pinned SharedOS build is unavailable' : false;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function records(directory: string) {
  const names = (await readdir(directory)).filter(name => /^record-.*\.json$/.test(name)).sort();
  return Promise.all(names.map(async name => ({ name, bytes: await readFile(join(directory, name), 'utf8') })));
}

test('a real delivered reply survives later MEMORY settlement failure without a tick commit or replay', { skip }, async t => {
  const loaded = await loadSharedOsModulesV1();
  assert.ok(loaded.ok, loaded.ok ? undefined : loaded.reason);
  const directory = await mkdtemp(join(tmpdir(), 'pair-late-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let driverCount = 0;
  let fetchCount = 0;
  let failedMemoryResults = 0;
  const createDriver: CreateSharedOsFileSessionV1Options['createDriver'] = input => {
    driverCount += 1;
    assert.ok(input.actorContext);
    const original = input.actorContext.store;
    const actorContext = { ...input.actorContext, store: {
      getFrontier: original.getFrontier.bind(original), close: original.close.bind(original),
      beginTurn: async (options: Parameters<typeof original.beginTurn>[0]) => {
        const turn = await original.beginTurn(options);
        return { ...turn, append: async (messages: readonly ActorContextMessage[]) => {
          const memoryResult = messages.find(message => message.role === 'tool'
            && message.tool_call_id === 'requester-5');
          if (input.role === 'requester' && memoryResult) {
            // Only the context append fails; the actual host operation has already returned.
            const result = JSON.parse(String(memoryResult.content));
            assert.equal(result.status, 'succeeded');
            assert.equal(result.output.outcome, 'committed');
            failedMemoryResults += 1;
            throw new ActorContextError('context_turn_incomplete');
          }
          await turn.append(messages);
        } };
      },
    } };
    let step = 0;
    let memory: { content: string; version: string } | undefined;
    return createOpenAICompatibleFileTurnDriverV1({
      model: pactModelConfigV1Schema.parse({ provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY', model: 'scripted' }),
      environment: { SHAREDEVAL_MODEL_API_KEY: 'not-a-secret' }, actorContext,
      fetch: async (_url, init) => {
        fetchCount += 1;
        const current = step++;
        const body = JSON.parse(String(init?.body)) as { messages: ActorContextMessage[] };
        const call = (name: string, args: Record<string, unknown>) => ({ content: null,
          tool_calls: [{ id: `${input.role}-${current}`, type: 'function',
            function: { name, arguments: JSON.stringify(args) } }] });
        let message: unknown;
        if (current < files.length) message = call('files.read', { path: [files[current]] });
        else if (input.role === 'responder') message = { content: 'local-scripted-delivered-reply' };
        else if (current === 4) {
          memory = JSON.parse(String(body.messages.at(-1)?.content)).output;
          assert.ok(memory);
          message = call('messages.request', { recipient: { kind: 'agent', agentId: 'responder' },
            payload: { taskId: 'PAIR-Q1', message: 'local scripted question' } });
        } else {
          assert.equal(current, 5, 'No provider continuation is allowed after the injected failure');
          assert.match(String(body.messages.at(-1)?.content), /local-scripted-delivered-reply/);
          assert.ok(memory);
          message = call('files.replace', { path: ['MEMORY.md'], expectedVersion: memory.version,
            content: memory.content.replace('PAIR-Q1 [pending]', 'PAIR-Q1 [answered]') });
        }
        return new Response(JSON.stringify({ model: 'scripted', choices: [{ message }] }), { status: 200 });
      },
    });
  };
  const storeRoot = join(directory, 'store');
  const identity = { provider: 'openai-compatible', requestedModel: 'scripted', resolvedModel: 'scripted' };
  const options = {
    runId: 'late-delivery', workspaceRootDir: directory, storeRoot,
    registryRootDir: fileSessionRegistryRootV1,
    world: { protocol: 'actor-context/v1' as const, maxContextBytes: 1_048_576 },
    runProvenance: { ...fileWorkflowHostRunProvenanceFixtureV1, models: { requester: identity, responder: identity } },
    requester: { ...fileSessionActorsV1.requester, actorId: 'requester' },
    responder: { ...fileSessionActorsV1.responder, actorId: 'responder' },
    tasks: fileSessionQaTasksV1(['PAIR-Q1']), maxTicks: 1,
    budget: { deadlineMs: 60_000, maxToolCalls: 24 },
    pactWorkspace: createPactPairWorkspaceV1(), createDriver,
    createSharedOsSession: createPreloadedSharedOsFileSessionFactoryV1(loaded),
  };
  await assert.rejects(runPactPairFilesMultiV1(options), error => {
    assert.match(String(error), /cause: context_turn_incomplete/,
      JSON.stringify({ driverCount, fetchCount, failedMemoryResults, stack: (error as Error).stack }));
    return true;
  });
  assert.equal(failedMemoryResults, 1);
  assert.equal(driverCount, 2);
  assert.equal(fetchCount, 11);
  const messageDirectory = join(storeRoot, '.sharedeval-sharedos-session', 'messages');
  const delivered = await records(messageDirectory);
  assert.equal(delivered.length, 2, 'The real request and reply are retained independently of tick commit');
  const [request, reply] = delivered.map(record => JSON.parse(record.bytes).envelope);
  assert.equal(reply.replyTo, request.id);
  assert.deepEqual(reply.receiver, { kind: 'agent', agentId: 'requester' });
  assert.match(JSON.stringify(reply.payload), /local-scripted-delivered-reply/);
  const requesterDirectory = join(storeRoot, '.sharedeval-actor-context', 'actors',
    createHash('sha256').update('requester').digest('hex'));
  const requester = await records(requesterDirectory);
  const journal = requester.map(record => JSON.parse(record.bytes));
  const contactResult = journal.find(record => record.message?.role === 'tool'
    && record.message.tool_call_id === 'requester-4');
  assert.ok(contactResult, 'Requester history must retain the delivered contact result');
  assert.match(contactResult.message.content, /local-scripted-delivered-reply/);
  assert.deepEqual(JSON.parse(contactResult.message.content).output, reply.payload);
  assert.equal(journal.some(record => record.kind === 'finish'), false);
  assert.equal(journal.some(record => record.message?.role === 'tool'
    && record.message.tool_call_id === 'requester-5'), false);
  const status = await json(join(storeRoot, 'execution-status.json'));
  assert.equal(status.failureStage, 'context_settlement');
  assert.equal(status.failureCode, 'context_turn_incomplete');
  assert.equal(status.evaluationStatus, 'incomplete');
  assert.equal((await json(join(storeRoot, 'checkpoint.json'))).recordCount, 0);
  assert.deepEqual(await readdir(join(storeRoot, '.sharedeval-file-workflow', 'records')), []);

  // A second entry is allowed to inspect recovery authority, never replay uncertain work.
  await assert.rejects(runPactPairFilesMultiV1(options));
  assert.equal(driverCount, 2);
  assert.equal(fetchCount, 11);
  assert.deepEqual(await records(messageDirectory), delivered);
  assert.deepEqual(await records(requesterDirectory), requester);
  assert.equal((await json(join(storeRoot, 'checkpoint.json'))).recordCount, 0);
});
