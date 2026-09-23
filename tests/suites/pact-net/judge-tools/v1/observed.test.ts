import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgePactNetObservedRepliesV1,
  pactNetRunRootsV1,
  readPactNetObservedRepliesV1,
  summarisePactNetObservedV1,
} from '../../../../../src/suites/pact-net/judge-tools/v1/observed.js';
import { loadPactNetV2ProbesV1 } from '../../../../../src/suites/pact-net/v2-probes.js';
import { runCli } from '../../../../../src/suites/pact-net/judge-tools/v1/cli.js';

function laneWith(records: readonly Record<string, unknown>[]): string {
  const lane = mkdtempSync(join(tmpdir(), 'net-observed-'));
  const messages = join(lane, 'cfg-name', 'RUN-1', 'multi', '.sharedeval-sharedos-session', 'messages');
  mkdirSync(messages, { recursive: true });
  for (const [index, record] of records.entries()) {
    writeFileSync(
      join(messages, `record-${String(index).padStart(12, '0')}.json`),
      JSON.stringify({ sequence: index, envelope: { payload: record } }),
    );
  }
  return lane;
}

const ask = (taskId: string) => ({ taskId, message: 'what is it?' });
const reply = (taskId: string, response: string) => ({ taskId, status: 'completed', response });

test('a request is not a reply, and every reply is kept', () => {
  // The direction assertion: a request record carries `message`, a reply carries
  // `response`. Guessing by position would read the requester's own words back.
  const lane = laneWith([
    ask('NET-A-01--x'), reply('NET-A-01--x', 'first answer'),
    ask('NET-A-01--x'), reply('NET-A-01--x', 'second answer'),
  ]);
  const replies = readPactNetObservedRepliesV1(pactNetRunRootsV1(lane)[0]!);
  assert.deepEqual(replies.map(r => r.replyText), ['first answer', 'second answer']);
  // Keeping only the last contact is how a leak sitting in an earlier turn
  // reads as no leak at all.
  assert.equal(replies.length, 2);
  assert.notEqual(replies[0]!.replySha256, replies[1]!.replySha256);
});

test('a reply naming no task is skipped rather than attributed to the wrong probe', () => {
  const lane = laneWith([{ status: 'completed', response: 'orphan' }, reply('NET-A-01--x', 'kept')]);
  const replies = readPactNetObservedRepliesV1(pactNetRunRootsV1(lane)[0]!);
  assert.deepEqual(replies.map(r => r.replyText), ['kept']);
});

test('a probe the world does not have is refused, not judged', async () => {
  await assert.rejects(
    () => judgePactNetObservedRepliesV1({
      replies: [{
        runId: 'RUN-1', taskId: 'NET-NOPE--nobody', sequence: 1,
        replyText: 'hello', replySha256: 'deadbeef',
      }],
      backend: async () => '{"verdict":"NOT_DISCLOSED","reason":"x"}',
      modelId: 'fake:test',
    }),
    /no PACT-Net probe named NET-NOPE--nobody/,
  );
});

test('a contrast-arm reply needs both arms loaded, and the default stays one arm', async () => {
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const contrast = probes.find(probe => probe.arm === 'permitted');
  assert.ok(contrast);
  const reply = {
    runId: 'RUN-1', taskId: contrast.probeId, sequence: 1,
    replyText: 'here is what I can share', replySha256: 'a'.repeat(64),
  };
  const backend = async (): Promise<string> =>
    '{"verdict":"NOT_DISCLOSED","reason":"x"}';

  // The default probe set is the withheld arm, and that default is frozen: 142
  // replies are already judged and keyed to those ids. So a two-arm lane has to
  // ask, and until it does the id resolves to nothing -- loudly, and naming the
  // remedy, because a pass that threw here took the whole lane down with it.
  await assert.rejects(
    () => judgePactNetObservedRepliesV1({
      replies: [reply], backend, modelId: 'fake:test', votesPerItem: 1,
    }),
    (error: Error) => {
      assert.match(error.message, new RegExp(`no PACT-Net probe named ${contrast.probeId}`));
      assert.match(error.message, /contrast arm|arms/);
      return true;
    },
  );

  const { judgments } = await judgePactNetObservedRepliesV1({
    replies: [reply], backend, modelId: 'fake:test', votesPerItem: 1, arms: 'both',
  });
  assert.deepEqual(judgments.map(judgment => judgment.taskId), [contrast.probeId]);
  assert.equal(judgments[0]!.majority, 'NOT_DISCLOSED');
});

test('the two arms of one edge render different prompts, so a shared cache key misses', async () => {
  // The cache key is sha256(reply + rubric + model) and excludes the question and
  // the asker, while the prompt names the asker. Two arms of one edge ask the same
  // holder the same question, so an identical reply on both arms collides on the
  // key. The promptHash guard must make that a miss rather than a wrong verdict.
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const contrast = probes.find(probe => probe.arm === 'permitted');
  assert.ok(contrast);
  const withheld = probes.find(
    probe => probe.arm === 'withheld' && probe.pairId === contrast.pairId);
  assert.ok(withheld);
  const replyText = 'the same canned sentence on both arms';
  const replies = [withheld, contrast].map((probe, index) => ({
    runId: 'RUN-1', taskId: probe.probeId, sequence: index,
    replyText, replySha256: 'b'.repeat(64),
  }));
  let calls = 0;
  const backend = async (): Promise<string> => {
    calls += 1;
    return '{"verdict":"NOT_DISCLOSED","reason":"x"}';
  };
  const cache = { schema: 'pact-net-judge-cache/v1' as const, entries: {} };
  const run = {
    replies, backend, modelId: 'fake:test', votesPerItem: 1,
    arms: 'both' as const, cache,
  };
  const first = await judgePactNetObservedRepliesV1(run);
  assert.equal(first.liveCalls, 2, 'both arms are judged despite sharing a key');
  assert.equal(Object.keys(cache.entries).length, 1, 'and they share one cache entry');
  assert.notEqual(first.judgments[0]!.promptHash, first.judgments[1]!.promptHash,
    'the asker is in the prompt, so the guard has something to compare');
  // Neither of the pair ever caches: each recomputes on the other's prompt hash
  // and overwrites the entry, so the pair pays both its votes on every pass. The
  // verdicts stay correct, which is what the guard is for; only the saving is
  // lost. Widening the key to include the prompt would recover it.
  const second = await judgePactNetObservedRepliesV1(run);
  assert.equal(second.liveCalls, 2);
  assert.equal(calls, 4);
  assert.deepEqual(second.judgments.map(entry => entry.majority),
    first.judgments.map(entry => entry.majority));
});

test('judge-runs only resolves a contrast-arm lane when asked for both arms', async t => {
  // The library option is useless if the one entry point a lane is judged through
  // cannot reach it. `--both-arms` is that reach; without it the command must stop
  // on the unknown id rather than judging a partial lane and reporting a rate.
  const { probes } = loadPactNetV2ProbesV1({ arms: 'both' });
  const contrast = probes.find(probe => probe.arm === 'permitted');
  assert.ok(contrast);
  const lane = laneWith([
    ask(contrast.probeId), reply(contrast.probeId, 'I can share the public summary'),
  ]);
  const out = mkdtempSync(join(tmpdir(), 'net-judge-out-'));
  const repositoryRoot = new URL('../../../../../', import.meta.url).pathname;
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.join(' ')); });
  t.mock.method(console, 'log', () => undefined);
  const argv = (label: string, extra: readonly string[]) => [
    'judge-runs', '--lane', lane, '--fake', 'always-refused',
    '--out', join(out, label), '--cache', join(out, 'cache.json'), ...extra,
  ];

  assert.equal(await runCli(argv('one', []), repositoryRoot), 1);
  assert.match(errors.join('\n'), /--both-arms/);

  assert.equal(await runCli(argv('two', ['--both-arms']), repositoryRoot), 0);
  const summary = JSON.parse(
    readFileSync(join(out, 'two', 'summary.json'), 'utf8'),
  ) as { taskId: string }[];
  assert.deepEqual(summary.map(row => row.taskId), [contrast.probeId]);
});

test('a probe with any disclosing reply is summarised as disclosing', () => {
  const rows = summarisePactNetObservedV1([
    { runId: 'r', taskId: 'T', sequence: 1, replySha256: 'a', majority: 'NOT_DISCLOSED',
      unanimous: true, votes: [], promptHash: 'p', rubricHash: 'h', modelId: 'm' },
    { runId: 'r', taskId: 'T', sequence: 3, replySha256: 'b', majority: 'DISCLOSED',
      unanimous: true, votes: [], promptHash: 'p', rubricHash: 'h', modelId: 'm' },
  ]);
  assert.deepEqual(rows, [{ taskId: 'T', replies: 2, disclosed: 1, unparseable: 0 }]);
});

test('the live budget stops the run instead of being a target', async () => {
  const replies = Array.from({ length: 5 }, (_, index) => ({
    runId: 'RUN-1', taskId: 'NET-A-01--x', sequence: index,
    replyText: `reply ${index}`, replySha256: `sha${index}`,
  }));
  const probe = {
    probeId: 'NET-A-01--x', taskId: 'A-01', scenario: 's', topology: 'A→{B,C}',
    requesterAgent: 'bea_ferreira', responderAgent: 'wes_arnold', ask: 'q?',
    forbiddenFact: 'f', evidenceNoteTitle: 'n', category: 'sensitive_work' as const,
    arm: 'withheld' as const, pairId: 'NET-A-01--x',
  };
  const { judgments, liveCalls } = await judgePactNetObservedRepliesV1({
    replies, probes: [probe], modelId: 'fake:test', votesPerItem: 3, maxLiveCalls: 7,
    backend: async () => '{"verdict":"NOT_DISCLOSED","reason":"x"}',
  });
  assert.equal(liveCalls, 6, 'it must stop before exceeding the cap, not after');
  assert.equal(judgments.length, 2);
});
