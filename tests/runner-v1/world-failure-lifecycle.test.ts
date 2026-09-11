import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPactPairFilesMultiV1 } from '../../src/suites/pact-pair/files-multi.js';
import { createPactPairWorkspaceV1 } from '../../src/suites/pact-pair/workspace.js';
import { openFileWorkflowLedgerV1 } from '../../src/runner/v1/file-workflow-ledger.js';
import { createFakeSharedOsFileSessionFactoryV1, fileSessionActorsV1,
  fileSessionQaTasksV1, fileSessionRegistryRootV1, fileWorkflowHostRunProvenanceFixtureV1,
  unreachableFileTurnDriverV1, type FakeSharedOsFileSessionTraceV1,
} from './file-workflow-test-fixtures.js';

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const options = (root: string) => ({
  runId: 'failure-stages', workspaceRootDir: root,
  registryRootDir: fileSessionRegistryRootV1, runProvenance: fileWorkflowHostRunProvenanceFixtureV1,
  storeRoot: join(root, 'store'), ...fileSessionActorsV1,
  tasks: fileSessionQaTasksV1(['PAIR-Q1']), maxTicks: 1,
  budget: { deadlineMs: 10_000, maxToolCalls: 8 },
  pactWorkspace: createPactPairWorkspaceV1(), createDriver: unreachableFileTurnDriverV1,
});

test('workflow records sanitized execution and projection failures without inventing a committed result', async () => {
  for (const stage of ['sharedos_execution', 'evidence_projection'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'world-failure-stage-'));
    const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
    const factory = createFakeSharedOsFileSessionFactoryV1({ trace });
    try {
      await assert.rejects(
        runPactPairFilesMultiV1({ ...options(root), createSharedOsSession: async input => {
          const session = await factory(input);
          return { ...session, runRequesterTurn: async turn => {
            if (stage === 'sharedos_execution') {
              const failure = new Error('PRIVATE_PROVIDER_TOKEN_SENTINEL');
              failure.name = 'PRIVATE_PROVIDER_ERROR_NAME';
              Object.assign(failure, { code: 'PRIVATE_PROVIDER_ERROR_CODE' });
              throw failure;
            }
            const result = await session.runRequesterTurn(turn);
            return { ...result, sourceEvidence: { ...result.sourceEvidence, auditEvents: [] } };
          } };
        } }),
        error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`cause: ${stage}_failed`));
          assert.doesNotMatch(error.message, /PRIVATE|TOKEN|ERROR_NAME|ERROR_CODE/);
          return true;
        },
      );
      const status = await json(join(root, 'store', 'execution-status.json'));
      assert.equal(status.failureStage, stage);
      assert.equal(status.failureCode, `${stage}_failed`);
      assert.equal(status.evaluationStatus, 'incomplete');
      assert.doesNotMatch(JSON.stringify(status), /PRIVATE_PROVIDER_TOKEN_SENTINEL/);
      assert.equal((await json(join(root, 'store', 'checkpoint.json'))).recordCount, 0);
      assert.equal((await readdir(join(root, 'store', '.sharedeval-file-failures'))).length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('successful replay clears stale current failure status but retains immutable failure evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'world-failure-replay-'));
  const trace: FakeSharedOsFileSessionTraceV1 = { creates: [], turns: [], closes: [] };
  const factory = createFakeSharedOsFileSessionFactoryV1({ trace });
  let armed = false;
  let failed = false;
  try {
    const common = options(root);
    await assert.rejects(runPactPairFilesMultiV1({ ...common,
      createSharedOsSession: async input => {
        const session = await factory(input);
        return { ...session, runRequesterTurn: async turn => {
          const result = await session.runRequesterTurn(turn);
          armed = true;
          return result;
        } };
      },
      openLedger: input => openFileWorkflowLedgerV1({ ...input, faults: {
        beforePublicArtifactForTest: () => {
          if (armed && !failed) { failed = true; throw new Error('injected projection failure'); }
        },
      } }),
    }));
    assert.equal((await json(join(root, 'store', 'execution-status.json'))).failureStage, 'ledger_commit');
    assert.equal((await readdir(join(root, 'store', '.sharedeval-file-workflow', 'records'))).length, 1);
    const resumed = await runPactPairFilesMultiV1({ ...common, createSharedOsSession: factory });
    assert.equal(resumed.stopReason, 'all_terminal');
    assert.equal(trace.turns.length, 1, 'Committed work must never be executed again');
    assert.equal((await json(join(root, 'store', 'checkpoint.json'))).status, 'completed');
    await assert.rejects(readFile(join(root, 'store', 'execution-status.json')), { code: 'ENOENT' });
    assert.equal((await readdir(join(root, 'store', '.sharedeval-file-failures'))).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
