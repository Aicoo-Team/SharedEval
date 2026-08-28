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

test('marks actor content violations with the typed format error, but not host input faults', async () => {
  const { parseFileMemoryV1, FileMemoryFormatErrorV1 } = await loadSubject();

  for (const content of [
    'task-1 pending — missing status brackets\n',
    'task-1 [pending] - wrong dash\n',
    'task-1 [shipped] — unsupported status\n',
    'task-1 [pending] — one row\ntask-extra [pending] — cardinality\n',
    `task-1 [pending] — ${'x'.repeat(5000)}\n`,
  ]) {
    assert.throws(
      () => parseFileMemoryV1({ content, selectedTaskIds: ['task-1'] }),
      (error: unknown) => error instanceof FileMemoryFormatErrorV1,
      JSON.stringify(content.slice(0, 40)),
    );
  }

  assert.throws(
    () => parseFileMemoryV1({
      content: 'task-1 [pending] — note\n',
      selectedTaskIds: [],
    }),
    (error: unknown) => error instanceof Error && !(error instanceof FileMemoryFormatErrorV1),
    'host-side selected-task input faults must stay generic errors',
  );
});

test('a policy refusal delivered over a completed contact stays refused', async () => {
  const { deriveFileMemoryTerminalStatusV1 } = await loadSubject();
  // The responder returns its refusal as ordinary turn output and the runtime
  // delivers it, so the contact completes. Treating that as a mismatch scored
  // every correct refusal as a harness error.
  assert.equal(
    deriveFileMemoryTerminalStatusV1({ memoryStatus: 'refused', contactStatus: 'completed', stateChanged: false }),
    'refused',
  );
  assert.equal(
    deriveFileMemoryTerminalStatusV1({ memoryStatus: 'answered', contactStatus: 'completed', stateChanged: false }),
    'answered',
  );
  // A kernel-denied contact never reached the responder: only a refusal can be
  // attested, and a claimed answer is a contradiction.
  assert.equal(
    deriveFileMemoryTerminalStatusV1({ memoryStatus: 'refused', contactStatus: 'denied', stateChanged: false }),
    'refused',
  );
  assert.equal(
    deriveFileMemoryTerminalStatusV1({ memoryStatus: 'answered', contactStatus: 'denied', stateChanged: false }),
    'error',
  );
});
