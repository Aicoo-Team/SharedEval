import assert from 'node:assert/strict';
import test from 'node:test';

type MemoryModule = typeof import('../../src/runner/v1/file-memory.js');

function loadSubject(): Promise<MemoryModule> {
  return import('../../src/runner/v1/file-memory.js');
}

test('parses canonical MEMORY rows without changing the selected task IDs or order', async () => {
  const { parseFileMemoryV1 } = await loadSubject();
  const content = [
    'task-17 [pending] — waiting for the first contact',
    'task-2 [answered] — requester confirmed the date',
    'task-9 [refused] — responder declined to disclose it',
    'task-4 [error] — transport timed out',
  ].join('\n') + '\n';

  assert.deepEqual(parseFileMemoryV1({
    content,
    selectedTaskIds: ['task-17', 'task-2', 'task-9', 'task-4'],
  }), [
    { taskId: 'task-17', status: 'pending', note: 'waiting for the first contact' },
    { taskId: 'task-2', status: 'answered', note: 'requester confirmed the date' },
    { taskId: 'task-9', status: 'refused', note: 'responder declined to disclose it' },
    { taskId: 'task-4', status: 'error', note: 'transport timed out' },
  ]);
});

test('rejects malformed, reordered, duplicate, missing, and non-selected MEMORY task rows', async t => {
  const { parseFileMemoryV1 } = await loadSubject();
  const selectedTaskIds = ['task-a', 'task-b'];
  const cases: Array<[string, string]> = [
    ['missing em dash', 'task-a [pending] - note\ntask-b [pending] — note\n'],
    ['unknown status', 'task-a [complete] — note\ntask-b [pending] — note\n'],
    ['reordered rows', 'task-b [pending] — note\ntask-a [pending] — note\n'],
    ['duplicate task', 'task-a [pending] — note\ntask-a [answered] — done\n'],
    ['missing selected task', 'task-a [pending] — note\n'],
    ['unselected task', 'task-a [pending] — note\ntask-c [pending] — note\n'],
  ];

  for (const [name, content] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseFileMemoryV1({ content, selectedTaskIds }),
        /MEMORY|task|status|order|selected|canonical/i,
      );
    });
  }
});

test('enforces a 4096 UTF-8-byte note bound without counting JavaScript characters', async () => {
  const { MAX_FILE_MEMORY_NOTE_BYTES_V1, parseFileMemoryV1 } = await loadSubject();
  assert.equal(MAX_FILE_MEMORY_NOTE_BYTES_V1, 4096);

  const accepted = 'a'.repeat(4096);
  assert.doesNotThrow(() => parseFileMemoryV1({
    content: `task-1 [pending] — ${accepted}\n`,
    selectedTaskIds: ['task-1'],
  }));

  const rejected = '😀'.repeat(1025);
  assert.equal(Buffer.byteLength(rejected, 'utf8'), 4100);
  assert.throws(
    () => parseFileMemoryV1({
      content: `task-1 [pending] — ${rejected}\n`,
      selectedTaskIds: ['task-1'],
    }),
    /4096|byte|note/i,
  );
});

