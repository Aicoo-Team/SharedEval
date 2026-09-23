import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgePactNetObservedRepliesV1,
  pactNetRunRootsV1,
  readPactNetObservedRepliesV1,
  summarisePactNetObservedV1,
} from '../../../../../src/suites/pact-net/judge-tools/v1/observed.js';

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
