import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultSharedOsDirV1, loadSharedOsModulesV1 } from '../../src/execution/sharedos/v1/load-sharedos.js';
import type { ActorContextMessage } from '../../src/runner/context/actor-context.js';
import { createOpenAICompatibleFileTurnDriverV1 } from '../../src/runner/v1/file-model-driver.js';
import { pactModelConfigV1Schema } from '../../src/runner/v1/model-config.js';
import {
  createPreloadedSharedOsFileSessionFactoryV1,
  responderTurnTimeoutMsV1,
} from '../../src/runner/v1/sharedos-file-session.js';
import type { CreateSharedOsFileSessionV1Options } from '../../src/runner/v1/sharedos-file-session-contracts.js';
import { runPactPairFilesMultiV1 } from '../../src/suites/pact-pair/files-multi.js';
import { createPactPairWorkspaceV1 } from '../../src/suites/pact-pair/workspace.js';
import { fileSessionActorsV1, fileSessionQaTasksV1, fileSessionRegistryRootV1,
  fileWorkflowHostRunProvenanceFixtureV1 } from '../runner-v1/file-workflow-test-fixtures.js';

const files = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'];
const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/runtime/dist/index.js'))
  ? 'Pinned SharedOS build is unavailable' : false;
// Long enough that the requester's reserve is the floor rather than a fraction
// of a toy budget: the responder stalls for the rest, so this also sets how long
// this test takes.
const DEADLINE_MS = 12_000;

async function records(directory: string) {
  const names = (await readdir(directory)).filter(name => /^record-.*\.json$/.test(name)).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}

test('a nested responder turn expires before the requester turn waiting on it', () => {
  // The ordering is the whole contract: the requester must still be alive when
  // its responder is cancelled, or the kernel rethrows the shared abort instead
  // of returning a failed tool result and the contact call is left dangling.
  for (const remainingMs of [100, 1_000, 12_000, 60_000, 600_000, 3_600_000]) {
    const timeoutMs = responderTurnTimeoutMsV1({ turnDeadlineAtMs: remainingMs, nowMs: 0 });
    const label = `${remainingMs}ms remaining -> ${timeoutMs}ms`;
    assert.ok(timeoutMs < remainingMs, label);
    assert.ok(timeoutMs >= 1, label);
    // The reserve is a real amount of time at every budget, not a fraction that
    // shrinks with it: a close that has to re-enter the provider and the file
    // store does not fit in the 300ms a bare 10% share leaves at 3s.
    assert.ok(remainingMs - timeoutMs >= Math.min(remainingMs - 1, 5_000), label);
  }
  // At the production budget the requester keeps an order of magnitude more
  // than the ~16s (four model calls) a measured close costs it.
  assert.ok(600_000 - responderTurnTimeoutMsV1({ turnDeadlineAtMs: 600_000, nowMs: 0 }) >= 50_000);
  // A turn already past its deadline yields a responder that is cancelled at
  // once — an outcome the requester can record, unlike an abort.
  for (const nowMs of [600_000, 600_001, 9_999_999]) {
    assert.equal(responderTurnTimeoutMsV1({ turnDeadlineAtMs: 600_000, nowMs }), 1, String(nowMs));
  }
});

test('a responder that never replies costs its own contact, not the run', { skip }, async t => {
  const loaded = await loadSharedOsModulesV1();
  assert.ok(loaded.ok, loaded.ok ? undefined : loaded.reason);
  const directory = await mkdtemp(join(tmpdir(), 'pair-responder-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let hangs = 0;
  let contactResultStatus: string | undefined;
  const createDriver: CreateSharedOsFileSessionV1Options['createDriver'] = input => {
    let step = 0;
    return createOpenAICompatibleFileTurnDriverV1({
      model: pactModelConfigV1Schema.parse({ provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY', model: 'scripted' }),
      environment: { SHAREDEVAL_MODEL_API_KEY: 'not-a-secret' },
      ...(input.actorContext ? { actorContext: input.actorContext } : {}),
      fetch: async (_url, init) => {
        const current = step++;
        const body = JSON.parse(String(init?.body)) as { messages: ActorContextMessage[] };
        const call = (name: string, args: Record<string, unknown>) => ({ content: null,
          tool_calls: [{ id: `${input.role}-${current}`, type: 'function',
            function: { name, arguments: JSON.stringify(args) } }] });
        let message: unknown;
        if (current < files.length) message = call('files.read', { path: [files[current]] });
        else if (input.role === 'responder') {
          // The failure this run really hit: the responder is still thinking
          // when its budget runs out. It never refuses and never replies.
          hangs += 1;
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        } else if (current === 4) {
          message = call('messages.request', { recipient: { kind: 'agent', agentId: 'responder' },
            payload: { taskId: 'PAIR-Q1', message: 'local scripted question' } });
        } else {
          contactResultStatus = JSON.parse(String(body.messages.at(-1)?.content)).status;
          message = { content: 'no reply came back; leaving the task open' };
        }
        return new Response(JSON.stringify({ model: 'scripted', choices: [{ message }] }), { status: 200 });
      },
    });
  };
  const storeRoot = join(directory, 'store');
  const identity = { provider: 'openai-compatible', requestedModel: 'scripted', resolvedModel: 'scripted' };

  await runPactPairFilesMultiV1({
    runId: 'responder-deadline', workspaceRootDir: directory, storeRoot,
    registryRootDir: fileSessionRegistryRootV1,
    world: { protocol: 'actor-context/v1' as const, maxContextBytes: 1_048_576 },
    runProvenance: { ...fileWorkflowHostRunProvenanceFixtureV1, models: { requester: identity, responder: identity } },
    requester: { ...fileSessionActorsV1.requester, actorId: 'requester' },
    responder: { ...fileSessionActorsV1.responder, actorId: 'responder' },
    tasks: fileSessionQaTasksV1(['PAIR-Q1']), maxTicks: 1,
    budget: { deadlineMs: DEADLINE_MS, maxToolCalls: 24 },
    pactWorkspace: createPactPairWorkspaceV1(), createDriver,
    createSharedOsSession: createPreloadedSharedOsFileSessionFactoryV1(loaded),
  });

  assert.equal(hangs, 1, 'the responder turn must have been the one that stalled');
  // The requester was told, in band, that its contact failed.
  assert.equal(contactResultStatus, 'failed');
  const journal = await records(join(storeRoot, '.sharedeval-actor-context', 'actors',
    createHash('sha256').update('requester').digest('hex')));
  const contactCall = journal.find(record => record.message?.role === 'tool'
    && record.message.tool_call_id === 'requester-4');
  assert.ok(contactCall, 'the contact call must have a tool result, or its turn can never settle');
  assert.equal(journal.filter(record => record.kind === 'finish').length, 1);
  assert.equal(journal.at(-1)?.status, 'succeeded', 'the requester turn settles despite the dead contact');
  // And the run committed: a stalled responder is one lost contact, not a lost run.
  assert.equal(existsSync(join(storeRoot, '.sharedeval-file-failures')), false);
  const committed = await records(join(storeRoot, '.sharedeval-file-workflow', 'records'));
  assert.equal(committed.length, 1);
});
