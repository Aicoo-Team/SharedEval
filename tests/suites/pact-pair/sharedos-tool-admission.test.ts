import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type {
  SoAccessContext,
  SoCapabilityGrant,
  SoToolDefinition,
} from '../../../src/execution/sharedos/v1/contracts.js';
import {
  defaultSharedOsDirV1,
  loadSharedOsModulesV1,
} from '../../../src/execution/sharedos/v1/load-sharedos.js';
import {
  SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
  SHAREDEVAL_SERVICE_ADDRESS_V1,
} from '../../../src/runner/v1/sharedos-file-session-contracts.js';
import { buildPactPairSharedOsGrantManifestV1 } from '../../../src/suites/pact-pair/sharedos-grants.js';
import { createPactPairSharedOsToolHandlersV1 } from '../../../src/suites/pact-pair/sharedos-tools.js';
import {
  loadPactPairTasksV1,
  type LoadedPactPairTaskV1,
} from '../../../src/suites/pact-pair/task-loader.js';
import { createPactPairWorkspaceV1 } from '../../../src/suites/pact-pair/workspace.js';

/**
 * The responder's tool surface, asserted where it is now actually decided.
 *
 * SharedEval used to narrow the surface itself: createPactPairSharedOsToolHandlersV1
 * dropped every tool outside a task's own surface and every write tool on a QA
 * task, and a unit test pinned the resulting handler list. Both filters were
 * removed, so the handler list is all nine tools for every task, and the unit
 * test that pinned the narrow list was replaced by one asserting all nine.
 *
 * The narrowing did not disappear — it moved. Under 'strict' the grant manifest
 * still issues a QA task read on one surface only, and the kernel's listTools
 * filters the catalogue by canDiscover before a model ever sees it. That is the
 * SharedOS the runner pins, not SharedEval's own code, and nothing asserted the
 * seam. These tests assert it, at the admitted catalogue rather than the handler
 * list, because that is where the decision is: the handler list is deliberately
 * wide, and a test asserting it is narrow would now be wrong.
 *
 * If SharedOS ever stops filtering the catalogue, or the strict manifest stops
 * narrowing per task, this goes red instead of a strict run quietly handing the
 * responder nine tools.
 */

const NAMESPACE_ID = `namespace-${'2'.repeat(40)}`;
const STARTED_AT = '2026-08-26T01:02:03.000Z';
const NOW = '2026-08-26T10:00:00.000Z';
const REQUESTER_ID = 'requester';
const RESPONDER_ID = 'responder';

const skip = !process.env.SHAREDEVAL_REQUIRE_SHAREDOS
  && !existsSync(join(defaultSharedOsDirV1(), 'packages/core/dist/index.js'))
  ? 'Pinned SharedOS build is unavailable'
  : false;

const notesQa = loadTask('Q1');
const todosQa = loadTask('Q201');
const notesAction = loadTask('A1');

const NARROW_BY_TASK = new Map<string, readonly string[]>([
  [notesQa.taskId, ['search_notes', 'get_note']],
  [todosQa.taskId, ['search_todos', 'get_todo']],
  [notesAction.taskId, ['search_notes', 'get_note', 'create_note', 'edit_note']],
]);
const ALL_TOOLS = [
  'search_notes', 'get_note', 'create_note', 'edit_note',
  'search_todos', 'get_todo', 'create_todo', 'edit_todo', 'complete_todo',
];

test('strict admits only a QA task\'s own read surface, not the nine tools it registers', { skip }, async () => {
  for (const task of [notesQa, todosQa, notesAction]) {
    const { registered, admitted } = await admit(task, undefined);
    // SharedEval hands the kernel every tool on purpose.
    assert.deepEqual(registered, ALL_TOOLS, task.taskId);
    // The kernel hands the model back only what the task's capability covers.
    assert.deepEqual(
      [...admitted].sort(),
      [...NARROW_BY_TASK.get(task.taskId)!].sort(),
      task.taskId,
    );
  }
});

test('an absent profile and an explicit strict profile admit the same narrow surface', { skip }, async () => {
  const absent = await admit(notesQa, undefined);
  const strict = await admit(notesQa, 'strict');
  assert.deepEqual(strict.admitted, absent.admitted);
  // The kernel returns the catalogue in its own canonical order, not the order
  // SharedEval registered the handlers in.
  assert.deepEqual(strict.admitted, ['get_note', 'search_notes']);
});

test('simple admits all nine, and that is the standing reach it was granted', { skip }, async () => {
  for (const task of [notesQa, todosQa, notesAction]) {
    const { registered, admitted } = await admit(task, 'simple');
    assert.deepEqual(registered, ALL_TOOLS, task.taskId);
    assert.deepEqual([...admitted].sort(), [...ALL_TOOLS].sort(), task.taskId);
  }
});

test('narrowing survives loading the whole manifest, not just one bound grant set', { skip }, async () => {
  // A bound strict run holds one task's grant set. This loads every grant the
  // manifest issues for all three tasks at once — strictly more authority than
  // any real turn has — and the admitted surface is still the task's own.
  const { admitted } = await admit(notesQa, undefined, [notesQa, todosQa, notesAction]);
  assert.deepEqual([...admitted].sort(), ['get_note', 'search_notes'].sort());
});

async function admit(
  task: LoadedPactPairTaskV1,
  pairProfile: 'strict' | 'simple' | undefined,
  manifestTasks: readonly LoadedPactPairTaskV1[] = [task],
): Promise<{ registered: string[]; admitted: string[] }> {
  const loaded = await loadSharedOsModulesV1();
  assert.ok(loaded.ok, loaded.ok ? undefined : loaded.reason);

  const manifest = buildPactPairSharedOsGrantManifestV1({
    namespaceId: NAMESPACE_ID,
    runStartedAt: STARTED_AT,
    requesterId: REQUESTER_ID,
    responderId: RESPONDER_ID,
    maxTicks: 3,
    maxToolCalls: 8,
    ...(pairProfile === undefined ? {} : { pairProfile }),
    tasks: manifestTasks.map(entry => ({
      taskId: entry.taskId,
      kind: entry.kind,
      publicTask: entry.publicTask,
    })),
  });
  // Only the responder's own grants. The authority resolver rejects a grant set
  // holding a grant for another subject outright (grant_scope_mismatch), which
  // denies the whole catalogue rather than one tool — so handing it the
  // requester's grants would make this test pass for the wrong reason, or rather
  // fail for one.
  const grants: readonly SoCapabilityGrant[] = manifest.grants.filter(grant => (
    grant.subject.kind === 'agent' && grant.subject.agentId === RESPONDER_ID
  ));
  assert.ok(grants.length > 0);

  const handlers = createPactPairSharedOsToolHandlersV1({
    task,
    owner: { ...SHAREDEVAL_SERVICE_ADDRESS_V1 },
    workspace: createPactPairWorkspaceV1(),
  });
  // Every grant this manifest issues carries maxUses, and discovery of a bounded
  // grant reads the usage store. Without one the authorizer denies every tool
  // with usage_store_unavailable — fail-closed, and indistinguishable at the
  // catalogue from a capability that does not cover the tool. The production
  // session passes its own store here; this is that store's contract, nothing
  // more.
  const usage = new Map<string, number>();
  const kernel = new loaded.modules.core.SharedOSKernel({
    grantSource: { load: async () => grants.map(grant => structuredClone(grant)) },
    authorizer: new loaded.modules.core.CapabilityAuthorizer({
      usageStore: {
        getUsage: async (_namespaceId: string, grantId: string) => usage.get(grantId) ?? 0,
        tryConsume: async (_namespaceId: string, grantId: string, maxUses: number) => {
          const used = usage.get(grantId) ?? 0;
          if (used >= maxUses) return false;
          usage.set(grantId, used + 1);
          return true;
        },
      },
    }),
  });
  for (const handler of handlers) kernel.registerTool(handler);

  const context: SoAccessContext = {
    namespaceId: NAMESPACE_ID,
    actor: { kind: 'agent', agentId: RESPONDER_ID },
    authority: { ...SHAREDEVAL_SERVICE_ADDRESS_V1 },
    owner: { ...SHAREDEVAL_SERVICE_ADDRESS_V1 },
    purpose: SHAREDEVAL_PACT_PAIR_PURPOSE_V1,
    traceId: 'trace-admission',
    // What the router gives a responder turn.
    enabledToolNamespaces: ['files', 'pact-pair'],
    now: NOW,
  };
  // SharedEval's own SoKernel facade declares registerResourceProvider,
  // registerTool and sendMessage — not listTools. The harness never asks the
  // kernel what the model may see; the SharedOS executor does, on its way to
  // turn.started.visibleTools. That absence is part of what this file is about,
  // so the cast stays local to the test rather than widening the facade.
  const catalogue = kernel as unknown as {
    listTools(context: SoAccessContext): Promise<readonly SoToolDefinition[]>;
  };
  const definitions = await catalogue.listTools(context);
  return {
    registered: handlers.map(handler => handler.definition.name),
    admitted: definitions.map(definition => definition.name),
  };
}

function loadTask(id: string): LoadedPactPairTaskV1 {
  const task = loadPactPairTasksV1({
    policy: 'D2',
    requester: 'R1',
    gradingMode: 'category',
    ids: [id],
  })[0];
  assert.ok(task);
  return task;
}
