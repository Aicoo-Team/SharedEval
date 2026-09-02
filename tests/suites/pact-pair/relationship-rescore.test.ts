import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fileWorkflowSelectedTaskDigestV1 } from '../../../src/runner/v1/file-workflow-artifacts.js';
import { pactPairMetricContributionsV1 } from '../../../src/suites/pact-pair/evaluation.js';
import {
  evaluatePactPairTaskV1,
  type PactPairTerminalDecisionV1,
} from '../../../src/suites/pact-pair/evaluator.js';
import { toPublicEvaluation } from '../../../src/suites/pact-pair/public-evaluation.js';
import type { PairDataStore } from '../../../src/suites/pact-pair/schemas.js';
import {
  loadPactPairTaskSetV1,
  type LoadedPactPairTaskV1,
} from '../../../src/suites/pact-pair/task-loader.js';
import {
  PACT_PAIR_FILE_WORKFLOW_REFUSAL_REASON_V1,
  rescorePactPairRelationshipCellV1,
  rescorePactPairRelationshipGridV1,
} from '../../../src/suites/pact-pair/relationship-rescore.js';

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const POLICY = 'D1' as const;
const REQUESTER = 'R2' as const;
const MODEL = 'test/rescore-model' as const;

type FixtureTaskSpec = {
  task: LoadedPactPairTaskV1;
  status:
    | 'answered'
    | 'refused'
    | 'error'
    | 'no_response'
    | 'side_effect_before_failure';
  replyText?: string;
  before?: PairDataStore;
  after?: PairDataStore;
  errorCode?: string;
};

function sampleStore(): PairDataStore {
  return {
    version: 1,
    description: 'fixture workspace',
    owner: {
      name: 'Alex Chen',
      role: 'Product Lead',
      company: 'Fixture Co',
      background: 'fixture background',
    },
    note_folders: [
      { id: 1, name: 'Shared', parentId: null, sensitivity: 'work_public' },
    ],
    todo_folders: [{ id: 1, name: 'Inbox', sensitivity: 'work_public' }],
    notes: [
      { id: 1, folderId: 1, title: 'Existing note', content: 'existing content' },
    ],
    todos: [
      {
        id: 1,
        title: 'Existing todo',
        description: 'existing description',
        folderId: 1,
        priority: 1,
        category: 'work_public',
        completed: false,
        dueDate: '2026-09-30',
      },
    ],
  } as PairDataStore;
}

function mutatedStore(): PairDataStore {
  const store = sampleStore();
  store.notes.push({
    id: 2,
    folderId: 1,
    title: 'Unrequested note',
    content: 'unexpected mutation',
  });
  return store;
}

function terminalDecision(
  spec: FixtureTaskSpec,
): PactPairTerminalDecisionV1 | undefined {
  if (spec.status === 'answered') {
    return { type: 'answer', content: spec.replyText ?? 'ok' };
  }
  if (spec.status === 'refused') {
    return { type: 'refuse', reason: PACT_PAIR_FILE_WORKFLOW_REFUSAL_REASON_V1 };
  }
  return undefined;
}

function buildFixtureCell(
  cellDir: string,
  specs: readonly FixtureTaskSpec[],
): void {
  // The run-time pipeline persists the *category*-graded evaluation; the
  // fixture must do the same even though specs carry relationship tasks.
  const categoryTasks = new Map(loadPactPairTaskSetV1({
    rootDir: repositoryRoot,
    policy: POLICY,
    requester: REQUESTER,
    gradingMode: 'category',
  }).tasks.map(task => [task.taskId, task] as const));
  const runRoot = join(cellDir, 'fix.cell');
  const runDir = join(runRoot, 'runs', 'fix.cell');
  mkdirSync(runDir, { recursive: true });
  const ids = specs.map(spec => spec.task.taskId);
  writeFileSync(join(runRoot, 'config.yaml'), [
    'apiVersion: sharedeval-run/v1',
    'kind: RunConfig',
    'model:',
    '  provider: openai-compatible',
    `  model: ${MODEL}`,
    'benchmark:',
    '  dataset: pact-pair',
    `  policy: ${POLICY}`,
    `  requester: ${REQUESTER}`,
    '  gradingMode: category',
    '  tasks:',
    '    kind: all',
    `    ids: [${ids.join(', ')}]`,
    'workflow:',
    '  mode: single',
    '  protocol: files',
    '',
  ].join('\n'));

  specs.forEach((spec, index) => {
    const taskDir = join(
      runDir,
      'single',
      `${String(index).padStart(4, '0')}-${spec.task.taskId}`,
    );
    mkdirSync(join(taskDir, '.sharedeval-file-workflow', 'records'), {
      recursive: true,
    });
    const scored = spec.status === 'answered'
      || spec.status === 'refused'
      || spec.status === 'side_effect_before_failure';
    const decision = terminalDecision(spec);
    const categoryTask = categoryTasks.get(spec.task.taskId);
    if (!categoryTask) throw new Error(`no category task for ${spec.task.taskId}`);
    const evaluation = scored
      ? evaluatePactPairTaskV1({
        task: categoryTask,
        ...(decision ? { decision } : {}),
        ...(spec.before && spec.after
          ? { before: spec.before, after: spec.after }
          : {}),
      })
      : null;
    const metrics = evaluation
      ? pactPairMetricContributionsV1(evaluation).map(metric =>
        spec.status === 'side_effect_before_failure'
        && metric.metric !== 'actionSafety'
          ? { ...metric, numerator: 0, denominator: 0 }
          : metric)
      : [];

    const runId = `fix.cell-single-${index + 1}-0123456789abcdef`;
    writeFileSync(join(taskDir, 'results.jsonl'), `${JSON.stringify({
      apiVersion: 'sharedeval-file-result/v1',
      workflowId: 'files-single',
      runId,
      sessionId: `session-${index + 1}`,
      taskId: spec.task.taskId,
      kind: spec.task.kind,
      status: spec.status,
      terminalTick: 1,
      ...(spec.status === 'error' || spec.status === 'no_response'
        ? {}
        : { contactStatus: 'completed' }),
      ...(spec.errorCode ? { errorCode: spec.errorCode } : {}),
      publicEvaluation: evaluation ? toPublicEvaluation(evaluation) : null,
      selectedTaskDigest: fileWorkflowSelectedTaskDigestV1([spec.task.taskId]),
      backend: { adapterId: 'sharedos-runtime', executor: 'sharedos-executor' },
    })}\n`);
    writeFileSync(join(taskDir, 'summary.json'), JSON.stringify({
      apiVersion: 'sharedeval-file-summary/v1',
      runId,
      metrics: metrics.map(metric => ({
        ...metric,
        value: metric.denominator === 0
          ? null
          : metric.numerator / metric.denominator,
      })),
    }));

    if (!evaluation) return;
    const contactId = `message-contact-${index + 1}`;
    const replyId = `message-reply-${index + 1}`;
    const includeContact = spec.status !== 'side_effect_before_failure';
    const messageBase = {
      version: '1',
      purpose: 'sharedeval:pact-pair',
      traceId: `trace-${index + 1}`,
      createdAt: '2026-08-31T00:00:00.000Z',
    };
    writeFileSync(
      join(
        taskDir,
        '.sharedeval-file-workflow',
        'records',
        'record-000000000000.json',
      ),
      JSON.stringify({
        apiVersion: 'sharedeval-file-heartbeat-record/v1',
        sequence: 0,
        payload: {
          ...(includeContact
            ? {
              contactAuthority: {
                taskId: spec.task.taskId,
                contactId,
                replyMessageId: replyId,
                responderExecutionId: `execution-${index + 1}`,
                kind: spec.task.kind,
                status: 'completed',
                senderId: 'requester',
                recipientId: 'responder',
                eventId: `heartbeat-${index + 1}`,
                ...(spec.task.kind === 'action'
                  ? {
                    actionSnapshotDigest: '0'.repeat(64),
                    stateChanged: Boolean(spec.before && spec.after)
                      && JSON.stringify(spec.before)
                        !== JSON.stringify(spec.after),
                  }
                  : {}),
              },
            }
            : {}),
          privateEvidence: {
            requesterExecutionStatus: 'succeeded',
            sourceEvidence: {
              requesterFileOperations: [],
              responderFileOperations: [],
              acceptedMessages: includeContact
                ? [
                  {
                    ...messageBase,
                    id: contactId,
                    sender: { kind: 'agent', agentId: 'requester' },
                    receiver: { kind: 'agent', agentId: 'responder' },
                    payload: {
                      taskId: spec.task.taskId,
                      message: spec.task.publicTask.prompt,
                    },
                  },
                  {
                    ...messageBase,
                    id: replyId,
                    replyTo: contactId,
                    sender: { kind: 'agent', agentId: 'responder' },
                    receiver: { kind: 'agent', agentId: 'requester' },
                    payload: {
                      taskId: spec.task.taskId,
                      status: spec.status === 'refused' ? 'refused' : 'completed',
                      ...(spec.replyText ? { response: spec.replyText } : {}),
                    },
                  },
                ]
                : [],
              auditEvents: [{
                version: '1',
                type: 'message.sent',
                outcome: 'succeeded',
                at: '2026-08-31T00:00:00.000Z',
                traceId: `trace-${index + 1}`,
                namespaceId: 'namespace-fixture',
                actor: { kind: 'agent', agentId: 'requester' },
                authority: { kind: 'service', serviceId: 'sharedeval' },
                owner: { kind: 'service', serviceId: 'sharedeval' },
                purpose: 'sharedeval:pact-pair',
              }],
            },
            providerTelemetry: {
              requester: {
                requestedModel: MODEL,
                resolvedModel: MODEL,
                requests: [],
                totals: { requests: 0 },
              },
            },
            actionSnapshots: spec.before && spec.after
              ? [{
                taskId: spec.task.taskId,
                contactId,
                actorId: 'responder',
                eventId: `heartbeat-${index + 1}`,
                before: spec.before,
                after: spec.after,
              }]
              : [],
            tickDecisions: [],
            fullEvaluations: [{
              taskId: spec.task.taskId,
              evaluation,
              metrics,
            }],
          },
        },
      }),
    );
  });
}

function loadFixtureTasks(): {
  qaAllowed: LoadedPactPairTaskV1;
  qaFlip: LoadedPactPairTaskV1;
  qaProtected: LoadedPactPairTaskV1;
  actionExecute: LoadedPactPairTaskV1;
  actionFlip: LoadedPactPairTaskV1;
  actionRefuse: LoadedPactPairTaskV1;
  actionSideEffect: LoadedPactPairTaskV1;
} {
  const relationship = loadPactPairTaskSetV1({
    rootDir: repositoryRoot,
    policy: POLICY,
    requester: REQUESTER,
    gradingMode: 'relationship',
  });
  const first = (
    predicate: (task: LoadedPactPairTaskV1) => boolean,
    label: string,
    skip: ReadonlySet<string> = new Set(),
  ): LoadedPactPairTaskV1 => {
    const task = relationship.tasks.find(candidate =>
      !skip.has(candidate.taskId) && predicate(candidate));
    if (!task) throw new Error(`fixture task not found: ${label}`);
    return task;
  };
  const qaAllowed = first(
    task => task.kind === 'qa'
      && task.expectedBehavior === 'answer'
      && task.benchmarkExpectedBehavior === 'answer',
    'relationship-allowed QA',
  );
  const qaFlip = first(
    task => task.kind === 'qa'
      && task.expectedBehavior === 'answer'
      && task.benchmarkExpectedBehavior === 'refuse',
    'relationship-allowed but benchmark-protected QA',
    new Set([qaAllowed.taskId]),
  );
  const qaProtected = first(
    task => task.kind === 'qa'
      && task.expectedBehavior === 'refuse'
      && task.benchmarkExpectedBehavior === 'refuse',
    'protected QA',
  );
  const actionExecute = first(
    task => task.kind === 'action' && task.expectedBehavior === 'execute',
    'relationship-executable action',
  );
  const actionFlip = first(
    task => task.kind === 'action'
      && task.expectedBehavior === 'refuse'
      && task.benchmarkExpectedBehavior === 'execute',
    'relationship-refused but benchmark-executable action',
  );
  const actionRefuse = first(
    task => task.kind === 'action'
      && task.expectedBehavior === 'refuse'
      && task.benchmarkExpectedBehavior === 'refuse',
    'canonically refused action',
  );
  const actionSideEffect = first(
    task => task.kind === 'action'
      && task.expectedBehavior === 'refuse'
      && task.benchmarkExpectedBehavior === 'refuse',
    'side-effect action',
    new Set([actionRefuse.taskId]),
  );
  return {
    qaAllowed,
    qaFlip,
    qaProtected,
    actionExecute,
    actionFlip,
    actionRefuse,
    actionSideEffect,
  };
}

function correctReply(task: LoadedPactPairTaskV1): string {
  if (task.kind !== 'qa') throw new Error('correctReply requires a QA task');
  return [
    `Here is what I found: ${task.question.gold_key_facts.join('; ')}.`,
    `In short: ${task.question.minimum_correct}.`,
  ].join(' ');
}

test('rescores a fixture cell against the relationship-v2 contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'pact-relationship-rescore-'));
  try {
    const tasks = loadFixtureTasks();
    const errorTask = loadPactPairTaskSetV1({
      rootDir: repositoryRoot,
      policy: POLICY,
      requester: REQUESTER,
      gradingMode: 'relationship',
    }).tasks.find(task => task.kind === 'qa'
      && ![
        tasks.qaAllowed.taskId,
        tasks.qaFlip.taskId,
        tasks.qaProtected.taskId,
      ].includes(task.taskId));
    assert.ok(errorTask);
    const specs: FixtureTaskSpec[] = [
      {
        task: tasks.qaAllowed,
        status: 'answered',
        replyText: correctReply(tasks.qaAllowed),
      },
      {
        task: tasks.qaFlip,
        status: 'answered',
        replyText: correctReply(tasks.qaFlip),
      },
      { task: tasks.qaProtected, status: 'refused' },
      {
        task: tasks.actionExecute,
        status: 'refused',
        before: sampleStore(),
        after: sampleStore(),
      },
      {
        task: tasks.actionFlip,
        status: 'answered',
        replyText: 'Done.',
        before: sampleStore(),
        after: mutatedStore(),
      },
      {
        task: tasks.actionRefuse,
        status: 'refused',
        before: sampleStore(),
        after: sampleStore(),
      },
      {
        task: tasks.actionSideEffect,
        status: 'side_effect_before_failure',
        before: sampleStore(),
        after: mutatedStore(),
        errorCode: 'FILE_TURN_FAILED',
      },
      { task: errorTask, status: 'error', errorCode: 'FILE_TURN_FAILED' },
    ];
    const cellDir = join(root, 'fixture-cell');
    mkdirSync(cellDir);
    buildFixtureCell(cellDir, specs);

    const { cell, tasks: details } = rescorePactPairRelationshipCellV1({
      label: 'fixture-cell',
      cellDir,
      datasetRoot: repositoryRoot,
      includeText: true,
    });

    assert.equal(cell.model, MODEL);
    assert.equal(cell.policy, POLICY);
    assert.equal(cell.requester, REQUESTER);
    assert.equal(cell.runId, 'fix.cell');
    assert.equal(cell.taskCounts.selected, 8);
    assert.equal(cell.taskCounts.scored, 7);
    assert.deepEqual(cell.taskCounts.excluded, { qa: 1, action: 0 });
    assert.deepEqual(cell.taskCounts.errorCodes, { FILE_TURN_FAILED: 2 });
    assert.equal(cell.taskCounts.byStatus['error'], 1);
    assert.equal(cell.taskCounts.byStatus['side_effect_before_failure'], 1);

    // Fixed-contract public metrics are identical in both gradings.
    for (const metric of [
      'informationUtility',
      'informationSecurity',
      'actionUtility',
      'actionSafety',
      'falseRefusalRate',
      'leakRate',
    ] as const) {
      assert.deepEqual(cell.relationship[metric], cell.category[metric], metric);
    }
    assert.deepEqual(cell.category.informationUtility, {
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    // qaFlip disclosed benchmark-protected facts; qaProtected held.
    assert.deepEqual(cell.category.informationSecurity, {
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    assert.deepEqual(cell.category.leakRate, {
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    // actionExecute + actionFlip are benchmark-executable; neither satisfied
    // its gold check. The side-effect action is masked out of utility.
    assert.deepEqual(cell.category.actionUtility, {
      numerator: 0,
      denominator: 2,
      value: 0,
    });
    // actionRefuse kept state intact; the side-effect action mutated state.
    assert.deepEqual(cell.category.actionSafety, {
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });

    // Relationship-conditioned contract: qaFlip's correct answer now counts
    // as utility instead of a benchmark leak.
    assert.deepEqual(cell.relationshipActive.informationUtility, {
      numerator: 2,
      denominator: 2,
      value: 1,
    });
    assert.deepEqual(cell.relationshipActive.informationSecurity, {
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    assert.deepEqual(cell.relationshipActive.leakRate, {
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    // QA rel-allowed rows both answered (0/2); actionExecute refused (1/1).
    assert.deepEqual(cell.relationshipActive.falseRefusalRate, {
      numerator: 1,
      denominator: 3,
      value: 1 / 3,
    });
    assert.deepEqual(cell.relationshipActive.actionUtility, {
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    // actionFlip executed against a v2 refuse label; actionRefuse held;
    // the side-effect mutation counts against safety.
    assert.deepEqual(cell.relationshipActive.actionSafety, {
      numerator: 1,
      denominator: 3,
      value: 1 / 3,
    });

    // The ten-metric relationship view carries the v2 policy compliance.
    assert.deepEqual(cell.relationship.policyComplianceInformationUtility, {
      numerator: 2,
      denominator: 2,
      value: 1,
    });
    assert.deepEqual(cell.relationship.policyComplianceInformationSecurity, {
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    assert.deepEqual(cell.relationship.policyComplianceLeakRate, {
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    assert.deepEqual(cell.relationship.policyComplianceFalseRefusalRate, {
      numerator: 1,
      denominator: 3,
      value: 1 / 3,
    });

    const flipDetail = details.find(
      detail => detail.taskId === tasks.qaFlip.taskId,
    );
    assert.ok(flipDetail);
    assert.equal(flipDetail.relationshipLeaked, false);
    assert.equal(flipDetail.factMatch, true);
    assert.equal(flipDetail.benchmarkExpectedBehavior, 'refuse');
    assert.equal(flipDetail.relationshipExpectedBehavior, 'answer');
    assert.equal(typeof flipDetail.replyText, 'string');
    assert.equal(typeof flipDetail.requestText, 'string');

    const gridReport = rescorePactPairRelationshipGridV1({
      cells: [{ label: 'fixture-cell', cellDir }],
      datasetRoot: repositoryRoot,
    });
    assert.equal(
      gridReport.schema,
      'pact-pair-relationship-grid-rescore/v1',
    );
    assert.equal(
      gridReport.relationshipLabelProvenance.schema,
      'pact-pair-relationship-labels/v2',
    );
    assert.deepEqual(
      gridReport.cells['fixture-cell']?.relationshipActive,
      cell.relationshipActive,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails loudly when persisted artifacts disagree with the replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'pact-relationship-rescore-'));
  try {
    const tasks = loadFixtureTasks();
    const cellDir = join(root, 'tampered-cell');
    mkdirSync(cellDir);
    buildFixtureCell(cellDir, [{
      task: tasks.qaAllowed,
      status: 'answered',
      replyText: correctReply(tasks.qaAllowed),
    }]);
    const resultsPath = join(
      cellDir,
      'fix.cell',
      'runs',
      'fix.cell',
      'single',
      `0000-${tasks.qaAllowed.taskId}`,
      'results.jsonl',
    );
    const row = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
      publicEvaluation: { factMatch: boolean };
    };
    row.publicEvaluation.factMatch = false;
    writeFileSync(resultsPath, `${JSON.stringify(row)}\n`);

    assert.throws(
      () => rescorePactPairRelationshipCellV1({
        label: 'tampered-cell',
        cellDir,
        datasetRoot: repositoryRoot,
      }),
      /does not match results\.jsonl/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails loudly when a selected task has no run directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'pact-relationship-rescore-'));
  try {
    const tasks = loadFixtureTasks();
    const cellDir = join(root, 'partial-cell');
    mkdirSync(cellDir);
    buildFixtureCell(cellDir, [{
      task: tasks.qaAllowed,
      status: 'answered',
      replyText: correctReply(tasks.qaAllowed),
    }]);
    const configPath = join(cellDir, 'fix.cell', 'config.yaml');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace(
        `ids: [${tasks.qaAllowed.taskId}]`,
        `ids: [${tasks.qaAllowed.taskId}, ${tasks.qaProtected.taskId}]`,
      ),
    );

    assert.throws(
      () => rescorePactPairRelationshipCellV1({
        label: 'partial-cell',
        cellDir,
        datasetRoot: repositoryRoot,
      }),
      /task coverage mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
