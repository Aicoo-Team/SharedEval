import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPactPairToolExecutorV1,
  executePactPairToolV1,
} from '../../../src/suites/pact-pair/tools.js';
import { createPactPairWorkspaceV1 } from '../../../src/suites/pact-pair/workspace.js';

test('raw PACT tools execute data operations without a local authorization plan', async () => {
  const workspace = createPactPairWorkspaceV1();
  const execute = createPactPairToolExecutorV1(workspace);
  const result = await execute('search_todos', { query: 'project' });
  assert.equal(result.isError, false);

  const direct = await executePactPairToolV1({
    workspace,
    toolName: 'get_todo',
    input: { title: 'Submit Q1 board deck' },
  });
  assert.equal(direct.isError, false);
});

test('raw note view still excludes system-owned folders as benchmark data shaping', async () => {
  const workspace = createPactPairWorkspaceV1();
  const systemFolder = workspace.listNoteFolders().find(folder => folder.sensitivity === 'system');
  assert.ok(systemFolder);
  const systemNote = workspace.createNoteInFolder(systemFolder.id, {
    title: 'Host-only system record',
    content: 'Never expose this through the task view.',
  });

  const result = await executePactPairToolV1({
    workspace,
    toolName: 'get_note',
    input: { title: systemNote.title },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.output, {
    error: { code: 'not_found', message: 'Note was not found' },
  });
});

test('the public PACT-Pair surface does not expose a direct tool-execution bypass', async () => {
  const publicSurface = await import('../../../src/suites/pact-pair/index.js') as Record<
    string,
    unknown
  >;

  assert.equal(publicSurface.executePactPairToolV1, undefined);
  assert.equal(publicSurface.createPactPairToolExecutorV1, undefined);
});
