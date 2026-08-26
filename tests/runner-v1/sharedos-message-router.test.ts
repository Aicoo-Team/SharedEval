import assert from 'node:assert/strict';
import test from 'node:test';

import { stableIdV1 } from '../../src/contracts/json.js';
import type {
  SoAccessContext,
  SoExecutionResult,
  SoMessageDeliveryResult,
  SoMessageEnvelope,
  SoResourceOperation,
  SoResourceResult,
} from '../../src/execution/sharedos/v1/contracts.js';
import {
  createSharedOsMessageRequestRouterV1,
  SharedOsMessageRouteIndeterminateErrorV1,
  SharedOsMessageRouteFailedErrorV1,
  type ExecuteSharedOsResponderTurnV1,
  type SendSharedOsReplyV1,
  type SharedOsMessageRouterSessionPortV1,
} from '../../src/runner/v1/sharedos-message-router.js';
import type {
  SharedOsFileOperationReceiptV1,
  SharedOsFileProviderV1,
} from '../../src/runner/v1/sharedos-file-provider.js';
import { SharedOsResponderTaskAlreadyBoundErrorV1 } from '../../src/runner/v1/sharedos-session-store.js';
import type { LoadedPactPairTaskV1 } from '../../src/suites/pact-pair/task-loader.js';

const FILES = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const;
const OWNER = { kind: 'service', serviceId: 'sharedeval' } as const;
const REQUESTER = { kind: 'agent', agentId: 'requester' } as const;
const RESPONDER = { kind: 'agent', agentId: 'responder' } as const;
const NAMESPACE_ID = 'run-namespace';
const PURPOSE = 'sharedeval:pact-pair';
const TRACE_ID = 'trace-1';
const REQUEST_ID = `message-${'1'.repeat(40)}`;
const NOW = '2026-08-26T01:00:00.000Z';
const TASK = { taskId: 'task-1' } as LoadedPactPairTaskV1;
const SECOND_TASK = { taskId: 'task-2' } as LoadedPactPairTaskV1;
const TASK_GRANT_IDS = ['responder-task-1-files'];

test('routes an accepted durable request through one responder turn and one authorized durable reply', async () => {
  const harness = createHarness();
  const reply = await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );

  const responderExecutionId = stableIdV1('execution', [
    'responder-execution',
    REQUEST_ID,
    RESPONDER.agentId,
  ]);
  const replyMessageId = stableIdV1('message', ['message-reply', REQUEST_ID]);
  assert.equal(harness.store.reads, 2, 'request and reply are both re-read durably');
  assert.deepEqual(harness.store.binds, [{
    traceId: TRACE_ID,
    requestMessageId: REQUEST_ID,
    taskId: TASK.taskId,
    grantIds: TASK_GRANT_IDS,
  }]);
  assert.equal(harness.executions.length, 1);
  assert.deepEqual(harness.executions[0], {
    task: TASK,
    executionId: responderExecutionId,
    context: {
      ...context(),
      actor: RESPONDER,
      enabledToolNamespaces: ['files', 'pact-pair'],
    },
    message: harness.request,
  });
  assert.deepEqual(reply, {
    version: '1',
    id: replyMessageId,
    sender: RESPONDER,
    receiver: REQUESTER,
    purpose: PURPOSE,
    payload: {
      taskId: TASK.taskId,
      status: 'completed',
      response: 'authorized response',
    },
    traceId: TRACE_ID,
    replyTo: REQUEST_ID,
    createdAt: NOW,
  });
  assert.deepEqual(harness.sent, [{ context: {
    ...context(),
    actor: RESPONDER,
    enabledToolNamespaces: ['files', 'pact-pair'],
  }, envelope: reply }]);
  assert.deepEqual(harness.router.readContactResult({ traceId: TRACE_ID }), {
    taskId: TASK.taskId,
    requestMessageId: REQUEST_ID,
    replyMessageId,
    responderExecutionId,
    status: 'completed',
    response: 'authorized response',
    responderReads: FILES.map((path, index) => ({
      actorId: RESPONDER.agentId,
      path,
      action: 'read',
      version: index,
      sha256: `${index}`.repeat(64),
      byteLength: index + 1,
    })),
  });
});

test('turns a successful responder denial into a correlated authorized reply without leaking its reason', async () => {
  const harness = createHarness({
    executionResult: succeededExecution(
      responderExecutionId(REQUEST_ID),
      TRACE_ID,
      {
        type: 'denied',
        reason: 'private responder reasoning must not leave the turn',
        toolSteps: 4,
        contactCalls: 0,
      },
    ),
  });

  const reply = await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );

  assert.deepEqual(reply.payload, {
    taskId: TASK.taskId,
    status: 'denied',
    errorCode: 'CONTACT_RESPONDER_DENIED',
  });
  assert.doesNotMatch(JSON.stringify(reply), /private responder reasoning/);
  assert.deepEqual(harness.router.readContactResult({ traceId: TRACE_ID }), {
    taskId: TASK.taskId,
    requestMessageId: REQUEST_ID,
    replyMessageId: replyMessageId(REQUEST_ID),
    responderExecutionId: responderExecutionId(REQUEST_ID),
    status: 'denied',
    errorCode: 'CONTACT_RESPONDER_DENIED',
    responderReads: expectedReads(RESPONDER.agentId),
  });
});

test('rejects non-accepted receipts and mismatched request identity before touching durable or recipient state', async () => {
  for (const scenario of [
    {
      label: 'delivery was denied',
      request: requestEnvelope(),
      context: context(),
      delivery: {
        status: 'denied',
        messageId: REQUEST_ID,
        timestamp: NOW,
        error: { code: 'denied', message: 'denied' },
      } satisfies SoMessageDeliveryResult,
    },
    {
      label: 'delivery identifies another message',
      request: requestEnvelope(),
      context: context(),
      delivery: accepted('another-message'),
    },
    {
      label: 'sender is not the configured requester',
      request: requestEnvelope({ sender: { kind: 'agent', agentId: 'forged' } }),
      context: context(),
      delivery: accepted(REQUEST_ID),
    },
    {
      label: 'receiver is not the configured responder',
      request: requestEnvelope({ receiver: { kind: 'agent', agentId: 'other' } }),
      context: context(),
      delivery: accepted(REQUEST_ID),
    },
    {
      label: 'context trace does not match',
      request: requestEnvelope(),
      context: context({ traceId: 'another-trace' }),
      delivery: accepted(REQUEST_ID),
    },
    {
      label: 'request is itself a reply',
      request: requestEnvelope({ replyTo: 'prior-message' }),
      context: context(),
      delivery: accepted(REQUEST_ID),
    },
  ]) {
    const harness = createHarness({ request: scenario.request });
    await assert.rejects(
      () => harness.router.resolveReply(
        scenario.context,
        scenario.request,
        scenario.delivery,
        neverAbort(),
      ),
      SharedOsMessageRouteFailedErrorV1,
      scenario.label,
    );
    assert.equal(harness.store.reads, 0, scenario.label);
    assert.equal(harness.provider.reads, 0, scenario.label);
    assert.equal(harness.store.binds.length, 0, scenario.label);
    assert.equal(harness.executions.length, 0, scenario.label);
    assert.equal(harness.sent.length, 0, scenario.label);
  }
});

test('requires the exact accepted request to exist in the durable log before trusting its payload', async () => {
  const missing = createHarness();
  missing.store.messages.delete(REQUEST_ID);
  await assertRouteFailure(missing);
  assert.equal(missing.store.reads, 1);
  assertZeroRecipientWork(missing);

  const forged = createHarness();
  forged.store.messages.set(REQUEST_ID, requestEnvelope({
    payload: { taskId: TASK.taskId, message: 'forged durable bytes' },
  }));
  await assertRouteFailure(forged);
  assert.equal(forged.store.reads, 1);
  assertZeroRecipientWork(forged);
});

test('accepts only the strict selected-task request payload before reading files or binding grants', async () => {
  for (const payload of [
    { taskId: TASK.taskId, message: 'request', extra: true },
    { taskId: TASK.taskId, message: '   ' },
    { taskId: 'not-selected', message: 'request' },
    { taskId: TASK.taskId },
    ['not', 'an', 'object'],
  ]) {
    const request = requestEnvelope({ payload: payload as never });
    const harness = createHarness({ request });
    await assertRouteFailure(harness, request, context());
    assert.equal(harness.store.reads, 1);
    assertZeroRecipientWork(harness);
  }
});

test('requires requester reads of all four actor-owned files before activating responder authority', async () => {
  const harness = createHarness();
  harness.provider.receipts.set(
    `${REQUESTER.agentId}\0${TRACE_ID}`,
    readOperationReceipts(REQUESTER.agentId, TRACE_ID).slice(0, 3),
  );

  await assertRouteFailure(harness);

  assert.deepEqual(harness.router.readContactResult({ traceId: TRACE_ID }), {
    taskId: TASK.taskId,
    requestMessageId: REQUEST_ID,
    status: 'failed',
    errorCode: 'CONTACT_REQUESTER_FILE_READ_REQUIRED',
    responderReads: [],
  });
  assert.equal(harness.store.binds.length, 0);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.sent.length, 0);
});

test('requires all four responder reads to be produced by this exact responder turn', async () => {
  const harness = createHarness();
  harness.provider.setFourReads(RESPONDER.agentId, TRACE_ID);

  await assertRouteFailure(harness);

  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 0);
  assert.deepEqual(harness.router.readContactResult({ traceId: TRACE_ID }), {
    taskId: TASK.taskId,
    requestMessageId: REQUEST_ID,
    responderExecutionId: responderExecutionId(REQUEST_ID),
    status: 'failed',
    errorCode: 'CONTACT_RESPONDER_FILE_READ_REQUIRED',
    responderReads: [],
  });
});

test('classifies only the store typed duplicate-task outcome and leaves the original contact intact', async () => {
  const harness = createHarness();
  const firstReply = await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  const secondRequest = requestEnvelope({
    id: `message-${'2'.repeat(40)}`,
    traceId: 'trace-2',
  });
  harness.store.messages.set(secondRequest.id, structuredClone(secondRequest));
  harness.provider.setFourReads(REQUESTER.agentId, secondRequest.traceId);

  await assertRouteFailure(
    harness,
    secondRequest,
    context({ traceId: secondRequest.traceId }),
  );

  assert.equal(harness.executions.length, 1, 'duplicate performs no second recipient turn');
  assert.equal(harness.sent.length, 1, 'duplicate emits no second reply');
  assert.deepEqual(
    harness.store.messages.get(firstReply.id),
    firstReply,
    'the first authoritative reply remains unchanged',
  );
  assert.equal(
    harness.router.readContactResult({ traceId: TRACE_ID })?.status,
    'completed',
  );
  assert.deepEqual(harness.router.readContactResult({ traceId: secondRequest.traceId }), {
    taskId: TASK.taskId,
    requestMessageId: secondRequest.id,
    status: 'failed',
    errorCode: 'CONTACT_DUPLICATE_TASK',
    responderReads: [],
  });
});

test('returns an exact authoritative replay without executing or sending twice', async () => {
  const harness = createHarness();
  const first = await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );

  const replayed = await harness.router.resolveReply(
    context(),
    structuredClone(harness.request),
    accepted(REQUEST_ID),
    neverAbort(),
  );

  assert.deepEqual(replayed, first);
  assert.equal(harness.store.binds.length, 1);
  assert.equal(harness.executions.length, 1, 'binding replay must not re-execute recipient');
  assert.equal(harness.sent.length, 1, 'binding replay must not resend reply');
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('replays a cached structured failure or cancellation without upgrading it to fatal', async () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const harness = createHarness({ executionResult: nonSuccessExecution(status) });
    await assertRouteFailure(harness);
    const firstContact = harness.router.readContactResult({ traceId: TRACE_ID });

    await assertRouteFailure(harness);

    assert.equal(harness.executions.length, 1, `${status} replay must not re-execute`);
    assert.equal(harness.sent.length, 0, `${status} replay must not send`);
    assert.deepEqual(
      harness.router.readContactResult({ traceId: TRACE_ID }),
      firstContact,
      `${status} replay preserves the authoritative sanitized contact`,
    );
    assert.doesNotThrow(
      () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
      status,
    );
  }
});

test('fails loud instead of executing when a replayed binding has no authoritative reply', async () => {
  const harness = createHarness();
  harness.store.taskBindings.set(TASK.taskId, responderBinding());

  let fatal: unknown;
  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      neverAbort(),
    ),
    error => {
      fatal = error;
      return error instanceof Error
        && !(error instanceof SharedOsMessageRouteFailedErrorV1)
        && /replay|indeterminate|authoritative/i.test(error.message);
    },
  );

  assert.equal(harness.executions.length, 0);
  assert.equal(harness.sent.length, 0);
  assert.throws(
    () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
    error => error === fatal,
  );
});

test('fails loud when durable reply bytes drift after an authoritative contact', async () => {
  const harness = createHarness();
  const reply = await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  harness.store.messages.set(reply.id, {
    ...reply,
    replyTo: 'different-request',
  });

  let fatal: unknown;
  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      neverAbort(),
    ),
    error => {
      fatal = error;
      return error instanceof Error
        && !(error instanceof SharedOsMessageRouteFailedErrorV1);
    },
  );
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.throws(
    () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
    error => error === fatal,
  );
});

test('does not relabel durable store corruption or non-task authority conflicts as duplicates', async () => {
  for (const phase of ['read', 'bind'] as const) {
    const harness = createHarness();
    const corruption = new Error(`${phase} durable corruption sentinel`);
    if (phase === 'read') harness.store.readError = corruption;
    else harness.store.bindError = corruption;

    await assert.rejects(
      () => harness.router.resolveReply(
        context(),
        harness.request,
        accepted(REQUEST_ID),
        neverAbort(),
      ),
      error => error === corruption,
    );
    assert.equal(harness.executions.length, 0);
    assert.equal(harness.sent.length, 0);
    assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
    assert.throws(
      () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
      error => error === corruption,
    );
  }
});

test('maps executor terminal statuses and malformed successful decisions to sanitized no-reply contacts', async () => {
  const cases: Array<{
    label: string;
    result: SoExecutionResult;
    status: 'failed' | 'cancelled';
    errorCode: 'CONTACT_RESPONDER_FAILED' | 'CONTACT_CANCELLED';
  }> = [
    {
      label: 'denied execution',
      result: nonSuccessExecution('denied'),
      status: 'failed',
      errorCode: 'CONTACT_RESPONDER_FAILED',
    },
    {
      label: 'failed execution',
      result: nonSuccessExecution('failed'),
      status: 'failed',
      errorCode: 'CONTACT_RESPONDER_FAILED',
    },
    {
      label: 'escalated execution',
      result: nonSuccessExecution('escalated'),
      status: 'failed',
      errorCode: 'CONTACT_RESPONDER_FAILED',
    },
    {
      label: 'cancelled execution',
      result: nonSuccessExecution('cancelled'),
      status: 'cancelled',
      errorCode: 'CONTACT_CANCELLED',
    },
    {
      label: 'successful cancelled decision',
      result: succeededExecution(
        responderExecutionId(REQUEST_ID),
        TRACE_ID,
        { type: 'cancelled', reason: 'cancelled', toolSteps: 1, contactCalls: 0 },
      ),
      status: 'cancelled',
      errorCode: 'CONTACT_CANCELLED',
    },
    {
      label: 'malformed successful decision',
      result: succeededExecution(
        responderExecutionId(REQUEST_ID),
        TRACE_ID,
        { type: 'completed', content: '', toolSteps: -1, contactCalls: 0 },
      ),
      status: 'failed',
      errorCode: 'CONTACT_RESPONDER_FAILED',
    },
  ];

  for (const scenario of cases) {
    const harness = createHarness({ executionResult: scenario.result });
    await assertRouteFailure(harness);
    assert.equal(harness.executions.length, 1, scenario.label);
    assert.equal(harness.sent.length, 0, scenario.label);
    const contact = harness.router.readContactResult({ traceId: TRACE_ID });
    assert.equal(contact?.status, scenario.status, scenario.label);
    assert.equal(contact?.errorCode, scenario.errorCode, scenario.label);
    assert.equal(contact?.replyMessageId, undefined, scenario.label);
    assert.doesNotThrow(
      () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
      scenario.label,
    );
  }
});

test('rejects responder context and execution identity drift before authorizing a reply', async () => {
  const scenarios: Array<Parameters<typeof createHarness>[0]> = [
    {
      returnedContext: input => ({
        ...input.context,
        traceId: 'forged-responder-trace',
      }),
    },
    {
      executionResult: succeededExecution(
        'wrong-execution-id',
        TRACE_ID,
        { type: 'completed', content: 'response', toolSteps: 4, contactCalls: 0 },
      ),
    },
    {
      executionResult: succeededExecution(
        responderExecutionId(REQUEST_ID),
        'wrong-result-trace',
        { type: 'completed', content: 'response', toolSteps: 4, contactCalls: 0 },
      ),
    },
  ];
  for (const overrides of scenarios) {
    const harness = createHarness(overrides);
    await assertRouteFailure(harness);
    assert.equal(harness.sent.length, 0);
    assert.equal(
      harness.router.readContactResult({ traceId: TRACE_ID })?.errorCode,
      'CONTACT_RESPONDER_FAILED',
    );
  }
});

test('propagates and latches thrown responder infrastructure failures without a sanitized contact', async () => {
  const fatal = new Error('private responder adapter failure');
  const harness = createHarness({
    execute: async () => {
      throw fatal;
    },
  });

  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      neverAbort(),
    ),
    error => error === fatal,
  );
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
  assert.throws(
    () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
    error => error === fatal,
  );
});

test('propagates and latches a thrown reply-send failure when no durable reply committed', async () => {
  const fatal = new Error('private reply transport failure');
  const harness = createHarness({
    send: async () => {
      throw fatal;
    },
  });

  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      neverAbort(),
    ),
    error => error === fatal,
  );
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
  assert.throws(
    () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
    error => error === fatal,
  );
});

test('does not hide a non-abort send or audit failure behind a committed reply', async () => {
  const fatal = new Error('private post-commit audit failure');
  let harness: Harness;
  harness = createHarness({
    send: async (_replyContext, envelope) => {
      harness.store.messages.set(envelope.id, structuredClone(envelope));
      throw fatal;
    },
  });

  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      neverAbort(),
    ),
    error => error === fatal,
  );
  assert.deepEqual(
    harness.store.messages.get(replyMessageId(REQUEST_ID))?.replyTo,
    REQUEST_ID,
  );
  assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
  assert.throws(
    () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
    error => error === fatal,
  );
});

test('lets an exact durable reply win when cancellation races after send commit', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled after commit');
  let harness: Harness;
  harness = createHarness({
    send: async (_replyContext, envelope) => {
      harness.store.messages.set(envelope.id, structuredClone(envelope));
      controller.abort(reason);
      throw reason;
    },
  });

  const reply = await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    controller.signal,
  );

  assert.equal(reply.id, replyMessageId(REQUEST_ID));
  assert.equal(harness.router.readContactResult({ traceId: TRACE_ID })?.status, 'completed');
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('keeps a structured reply-delivery rejection sanitized and non-fatal', async () => {
  const harness = createHarness({ replyDelivery: accepted('wrong-reply-message') });
  await assertRouteFailure(harness);
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  const contact = harness.router.readContactResult({ traceId: TRACE_ID });
  assert.equal(contact?.status, 'failed');
  assert.equal(contact?.errorCode, 'CONTACT_RESPONDER_FAILED');
  assert.equal(contact?.replyMessageId, undefined);
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('fails loud when an accepted reply is missing or differs in durable storage', async () => {
  for (const overrides of [
    { persistReply: false },
    {
      mutateDurableReply: (reply: SoMessageEnvelope) => ({
        ...reply,
        payload: { taskId: TASK.taskId, status: 'completed', response: 'forged' },
      }),
    },
  ]) {
    const harness = createHarness(overrides);
    let fatal: unknown;
    await assert.rejects(
      () => harness.router.resolveReply(
        context(),
        harness.request,
        accepted(REQUEST_ID),
        neverAbort(),
      ),
      error => {
        fatal = error;
        return error instanceof Error
          && !(error instanceof SharedOsMessageRouteFailedErrorV1);
      },
    );
    assert.equal(harness.executions.length, 1);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
    assert.throws(
      () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
      error => error === fatal,
    );
  }
});

test('propagates and latches a durable reply read failure after send', async () => {
  const fatal = new Error('private durable reply read failure');
  const harness = createHarness();
  harness.store.readErrors.set(replyMessageId(REQUEST_ID), fatal);

  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      neverAbort(),
    ),
    error => error === fatal,
  );
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.throws(
    () => harness.router.assertTraceHealthy({ traceId: TRACE_ID }),
    error => error === fatal,
  );
});

test('honors cancellation before any durable or recipient work', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  controller.abort(reason);

  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      accepted(REQUEST_ID),
      controller.signal,
    ),
    error => error === reason,
  );
  assert.equal(harness.store.reads, 0);
  assertZeroRecipientWork(harness);
  assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('does not serialize independent traces behind a router-global queue', async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstHasStarted = new Promise<void>(resolve => {
    firstStarted = resolve;
  });
  let harness: Harness;
  harness = createHarness({
    execute: async input => {
      if (input.task.taskId === TASK.taskId) {
        firstStarted();
        await firstGate;
      }
      harness.provider.setFourReads(RESPONDER.agentId, input.context.traceId);
      return {
        context: structuredClone(input.context),
        execution: succeededExecution(
          input.executionId,
          input.context.traceId,
          {
            type: 'completed',
            content: `response for ${input.task.taskId}`,
            toolSteps: 4,
            contactCalls: 0,
          },
        ),
      };
    },
  });
  const secondRequest = requestEnvelope({
    id: `message-${'2'.repeat(40)}`,
    traceId: 'trace-2',
    payload: { taskId: SECOND_TASK.taskId, message: 'second selected task' },
  });
  harness.store.messages.set(secondRequest.id, structuredClone(secondRequest));
  harness.provider.setFourReads(REQUESTER.agentId, secondRequest.traceId);

  const first = harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  await firstHasStarted;
  const second = harness.router.resolveReply(
    context({ traceId: secondRequest.traceId }),
    secondRequest,
    accepted(secondRequest.id),
    neverAbort(),
  );
  await new Promise<void>(resolve => setImmediate(resolve));
  const startedCount = harness.executions.length;
  releaseFirst();

  const replies = await Promise.all([first, second]);
  assert.equal(startedCount, 2, 'the second trace starts while the first is still blocked');
  assert.deepEqual(
    replies.map(reply => reply.traceId).sort(),
    [TRACE_ID, secondRequest.traceId].sort(),
  );
});

test('deduplicates one identical in-flight trace without poisoning or re-executing it', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  let harness: Harness;
  harness = createHarness({
    execute: async input => {
      started();
      await gate;
      harness.provider.setFourReads(RESPONDER.agentId, input.context.traceId);
      return {
        context: structuredClone(input.context),
        execution: succeededExecution(
          input.executionId,
          input.context.traceId,
          {
            type: 'completed',
            content: 'deduplicated response',
            toolSteps: 4,
            contactCalls: 0,
          },
        ),
      };
    },
  });

  const first = harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  await hasStarted;
  const second = harness.router.resolveReply(
    structuredClone(context()),
    structuredClone(harness.request),
    structuredClone(accepted(REQUEST_ID)),
    neverAbort(),
  );
  await new Promise<void>(resolve => setImmediate(resolve));
  release();

  const [firstReply, secondReply] = await Promise.all([first, second]);
  assert.deepEqual(secondReply, firstReply);
  assert.notEqual(secondReply, firstReply, 'each caller receives an isolated envelope snapshot');
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('exposes an active trace as unsettled until its owner route finishes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  let harness: Harness;
  harness = createHarness({
    execute: async input => {
      started();
      await gate;
      harness.provider.setFourReads(RESPONDER.agentId, input.context.traceId);
      return {
        context: structuredClone(input.context),
        execution: succeededExecution(
          input.executionId,
          input.context.traceId,
          {
            type: 'completed',
            content: 'settled response',
            toolSteps: 4,
            contactCalls: 0,
          },
        ),
      };
    },
  });
  const owner = harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  await hasStarted;

  assert.throws(
    () => harness.router.assertTraceSettled({ traceId: TRACE_ID }),
    SharedOsMessageRouteIndeterminateErrorV1,
  );
  release();
  await owner;
  assert.doesNotThrow(() => harness.router.assertTraceSettled({ traceId: TRACE_ID }));
});

test('lets an identical waiter cancel without cancelling or poisoning the owner route', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  let harness: Harness;
  harness = createHarness({
    execute: async input => {
      started();
      await gate;
      harness.provider.setFourReads(RESPONDER.agentId, input.context.traceId);
      return {
        context: structuredClone(input.context),
        execution: succeededExecution(
          input.executionId,
          input.context.traceId,
          {
            type: 'completed',
            content: 'owner response',
            toolSteps: 4,
            contactCalls: 0,
          },
        ),
      };
    },
  });
  const owner = harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  await hasStarted;
  const waiterController = new AbortController();
  const waiterReason = new Error('waiter cancelled');
  const waiter = harness.router.resolveReply(
    structuredClone(context()),
    structuredClone(harness.request),
    structuredClone(accepted(REQUEST_ID)),
    waiterController.signal,
  );
  const waiterAssertion = assert.rejects(waiter, error => error === waiterReason);
  waiterController.abort(waiterReason);
  await waiterAssertion;
  release();

  assert.deepEqual((await owner).payload, {
    taskId: TASK.taskId,
    status: 'completed',
    response: 'owner response',
  });
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('does not treat owner cancellation observed by an identical waiter as infrastructure fatal', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  const ownerController = new AbortController();
  const ownerReason = new Error('owner cancelled');
  const harness = createHarness({
    execute: async input => {
      started();
      await gate;
      return {
        context: structuredClone(input.context),
        execution: succeededExecution(
          input.executionId,
          input.context.traceId,
          {
            type: 'completed',
            content: 'late response',
            toolSteps: 4,
            contactCalls: 0,
          },
        ),
      };
    },
  });
  const owner = harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    ownerController.signal,
  );
  await hasStarted;
  const waiter = harness.router.resolveReply(
    structuredClone(context()),
    structuredClone(harness.request),
    structuredClone(accepted(REQUEST_ID)),
    neverAbort(),
  );
  const ownerAssertion = assert.rejects(owner, error => error === ownerReason);
  const waiterAssertion = assert.rejects(waiter, error => error === ownerReason);
  ownerController.abort(ownerReason);
  release();

  await Promise.all([ownerAssertion, waiterAssertion]);
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 0);
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('rejects a conflicting in-flight call without mutating the valid owner trace', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  let harness: Harness;
  harness = createHarness({
    execute: async input => {
      started();
      await gate;
      harness.provider.setFourReads(RESPONDER.agentId, input.context.traceId);
      return {
        context: structuredClone(input.context),
        execution: succeededExecution(
          input.executionId,
          input.context.traceId,
          {
            type: 'completed',
            content: 'unpoisoned owner response',
            toolSteps: 4,
            contactCalls: 0,
          },
        ),
      };
    },
  });
  const owner = harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  await hasStarted;

  await assert.rejects(
    () => harness.router.resolveReply(
      structuredClone(context()),
      structuredClone(harness.request),
      {
        status: 'failed',
        messageId: REQUEST_ID,
        timestamp: NOW,
        error: { code: 'late_failure', message: 'conflicting delivery' },
      },
      neverAbort(),
    ),
    SharedOsMessageRouteFailedErrorV1,
  );
  assert.equal(harness.router.readContactResult({ traceId: TRACE_ID }), null);
  release();

  assert.deepEqual((await owner).payload, {
    taskId: TASK.taskId,
    status: 'completed',
    response: 'unpoisoned owner response',
  });
  assert.equal(harness.executions.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.doesNotThrow(() => harness.router.assertTraceHealthy({ traceId: TRACE_ID }));
});

test('returns immutable contact snapshots rather than mutable router state', async () => {
  const harness = createHarness();
  await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );
  const contact = harness.router.readContactResult({ traceId: TRACE_ID });
  assert.ok(contact);
  assert.ok(Object.isFrozen(contact));
  assert.ok(Object.isFrozen(contact.responderReads));
  assert.ok(contact.responderReads.every(Object.isFrozen));
  assert.throws(() => {
    (contact as { status: string }).status = 'failed';
  }, TypeError);
  assert.equal(
    harness.router.readContactResult({ traceId: TRACE_ID })?.status,
    'completed',
  );
});

test('never lets a later invalid resolution attempt overwrite an authoritative contact', async () => {
  const harness = createHarness();
  await harness.router.resolveReply(
    context(),
    harness.request,
    accepted(REQUEST_ID),
    neverAbort(),
  );

  await assert.rejects(
    () => harness.router.resolveReply(
      context(),
      harness.request,
      {
        status: 'failed',
        messageId: REQUEST_ID,
        timestamp: NOW,
        error: { code: 'late_failure', message: 'invalid replay' },
      },
      neverAbort(),
    ),
    SharedOsMessageRouteFailedErrorV1,
  );

  assert.equal(
    harness.router.readContactResult({ traceId: TRACE_ID })?.status,
    'completed',
  );
});

type ExecutionInput = Parameters<ExecuteSharedOsResponderTurnV1>[0];
type SentReply = Readonly<{ context: SoAccessContext; envelope: SoMessageEnvelope }>;

class FakeStore implements SharedOsMessageRouterSessionPortV1 {
  readonly messages = new Map<string, SoMessageEnvelope>();
  readonly binds: Array<{
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }> = [];
  readonly taskBindings = new Map<string, {
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }>();
  reads = 0;
  readError: unknown;
  readonly readErrors = new Map<string, unknown>();
  bindError: unknown;

  async readMessage(messageId: string): Promise<SoMessageEnvelope | null> {
    this.reads += 1;
    if (this.readError !== undefined) throw this.readError;
    if (this.readErrors.has(messageId)) throw this.readErrors.get(messageId);
    const message = this.messages.get(messageId);
    return message ? structuredClone(message) : null;
  }

  async bindResponderGrantSet(input: {
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }): Promise<'created' | 'replayed'> {
    if (this.bindError !== undefined) throw this.bindError;
    const existing = this.taskBindings.get(input.taskId);
    if (existing !== undefined && !isExactBinding(existing, input)) {
      throw new SharedOsResponderTaskAlreadyBoundErrorV1(input.taskId);
    }
    if (existing !== undefined) return 'replayed';
    this.taskBindings.set(input.taskId, structuredClone(input));
    this.binds.push(structuredClone(input));
    return 'created';
  }
}

class FakeFileProvider implements SharedOsFileProviderV1 {
  readonly namespace = 'files';
  readonly receipts = new Map<string, SharedOsFileOperationReceiptV1[]>();
  reads = 0;

  invoke(_operation: SoResourceOperation, _signal: AbortSignal): Promise<SoResourceResult> {
    throw new Error('router tests do not invoke the provider directly');
  }

  async readReceipts(input: { actorId: string; traceId: string }) {
    this.reads += 1;
    return structuredClone(this.receipts.get(`${input.actorId}\0${input.traceId}`) ?? []);
  }

  async close(): Promise<void> {}

  setFourReads(actorId: string, traceId: string): void {
    this.receipts.set(`${actorId}\0${traceId}`, readOperationReceipts(actorId, traceId));
  }
}

function createHarness(overrides: Partial<{
  request: SoMessageEnvelope;
  executionResult: SoExecutionResult;
  returnedContext: (input: ExecutionInput) => SoAccessContext;
  execute: ExecuteSharedOsResponderTurnV1;
  replyDelivery: SoMessageDeliveryResult;
  persistReply: boolean;
  mutateDurableReply: (reply: SoMessageEnvelope) => SoMessageEnvelope;
  send: SendSharedOsReplyV1;
}> = {}) {
  const request = overrides.request ?? requestEnvelope();
  const store = new FakeStore();
  store.messages.set(request.id, structuredClone(request));
  const provider = new FakeFileProvider();
  provider.setFourReads(REQUESTER.agentId, request.traceId);
  const executions: ExecutionInput[] = [];
  const sent: SentReply[] = [];
  const executeImplementation: ExecuteSharedOsResponderTurnV1 = overrides.execute ?? (async input => {
    provider.setFourReads(RESPONDER.agentId, input.context.traceId);
    return {
      context: overrides.returnedContext
        ? overrides.returnedContext(input)
        : structuredClone(input.context),
      execution: overrides.executionResult ?? succeededExecution(
        input.executionId,
        input.context.traceId,
        { type: 'completed', content: 'authorized response', toolSteps: 4, contactCalls: 0 },
      ),
    };
  });
  const execute: ExecuteSharedOsResponderTurnV1 = async (input, signal) => {
    executions.push(structuredClone(input));
    return executeImplementation(input, signal);
  };
  const sendImplementation: SendSharedOsReplyV1 = overrides.send ?? (async (_replyContext, envelope) => {
    if (overrides.persistReply !== false) {
      store.messages.set(
        envelope.id,
        structuredClone(overrides.mutateDurableReply?.(envelope) ?? envelope),
      );
    }
    return overrides.replyDelivery ?? accepted(envelope.id);
  });
  const send: SendSharedOsReplyV1 = async (replyContext, envelope, signal) => {
    sent.push({
      context: structuredClone(replyContext),
      envelope: structuredClone(envelope),
    });
    return sendImplementation(replyContext, envelope, signal);
  };
  const router = createSharedOsMessageRequestRouterV1({
    namespaceId: NAMESPACE_ID,
    purpose: PURPOSE,
    requesterActorId: REQUESTER.agentId,
    responderActorId: RESPONDER.agentId,
    tasks: [TASK, SECOND_TASK],
    responderGrantSets: [
      { taskId: TASK.taskId, grantIds: TASK_GRANT_IDS },
      { taskId: SECOND_TASK.taskId, grantIds: ['responder-task-2-files'] },
    ],
    store,
    fileProvider: provider,
    executeResponderTurn: execute,
    sendReply: send,
  });
  return { router, request, store, provider, executions, sent };
}

function context(overrides: Partial<SoAccessContext> = {}): SoAccessContext {
  return {
    namespaceId: NAMESPACE_ID,
    actor: REQUESTER,
    authority: OWNER,
    owner: OWNER,
    purpose: PURPOSE,
    traceId: TRACE_ID,
    enabledToolNamespaces: ['files', 'messages'],
    now: NOW,
    ...overrides,
  };
}

function requestEnvelope(overrides: Partial<SoMessageEnvelope> = {}): SoMessageEnvelope {
  return {
    version: '1',
    id: REQUEST_ID,
    sender: REQUESTER,
    receiver: RESPONDER,
    purpose: PURPOSE,
    payload: { taskId: TASK.taskId, message: 'Please handle this selected task.' },
    traceId: TRACE_ID,
    createdAt: NOW,
    ...overrides,
  };
}

function accepted(messageId: string, overrides: Partial<SoMessageDeliveryResult> = {}): SoMessageDeliveryResult {
  return {
    status: 'accepted',
    messageId,
    timestamp: NOW,
    ...overrides,
  } as SoMessageDeliveryResult;
}

function succeededExecution(
  executionId: string,
  traceId: string,
  output: unknown,
): SoExecutionResult {
  return {
    version: '1',
    status: 'succeeded',
    executionId,
    traceId,
    output: output as never,
    events: [],
    startedAt: NOW,
    completedAt: NOW,
  };
}

function nonSuccessExecution(
  status: 'denied' | 'failed' | 'cancelled' | 'escalated',
): SoExecutionResult {
  const common = {
    version: '1' as const,
    executionId: responderExecutionId(REQUEST_ID),
    traceId: TRACE_ID,
    events: [],
    startedAt: NOW,
    completedAt: NOW,
  };
  if (status === 'cancelled') return {
    ...common,
    status,
    error: { code: 'cancelled', message: 'private cancellation details' },
  };
  if (status === 'escalated') return {
    ...common,
    status,
    escalation: { private: 'escalation details' },
  };
  return {
    ...common,
    status,
    error: { code: status, message: `private ${status} details` },
  };
}

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

function responderExecutionId(requestMessageId: string): string {
  return stableIdV1('execution', [
    'responder-execution',
    requestMessageId,
    RESPONDER.agentId,
  ]);
}

function replyMessageId(requestMessageId: string): string {
  return stableIdV1('message', ['message-reply', requestMessageId]);
}

function responderBinding() {
  return {
    traceId: TRACE_ID,
    requestMessageId: REQUEST_ID,
    taskId: TASK.taskId,
    grantIds: TASK_GRANT_IDS,
  } as const;
}

function readOperationReceipts(
  actorId: string,
  traceId: string,
): SharedOsFileOperationReceiptV1[] {
  return FILES.map((path, index) => ({
    runId: 'run-1',
    actorId,
    traceId,
    operationId: `${actorId}-read-${index}`,
    path,
    action: 'read',
    outcome: 'succeeded',
    version: index,
    sha256: `${index}`.repeat(64),
    byteLength: index + 1,
  }));
}

function expectedReads(actorId: string) {
  return FILES.map((path, index) => ({
    actorId,
    path,
    action: 'read' as const,
    version: index,
    sha256: `${index}`.repeat(64),
    byteLength: index + 1,
  }));
}

function isExactBinding(
  left: Readonly<{
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }>,
  right: Readonly<{
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }>,
): boolean {
  return (
    left.traceId === right.traceId
    && left.requestMessageId === right.requestMessageId
    && left.taskId === right.taskId
    && left.grantIds.length === right.grantIds.length
    && left.grantIds.every((grantId, index) => grantId === right.grantIds[index])
  );
}

type Harness = ReturnType<typeof createHarness>;

async function assertRouteFailure(
  harness: Harness,
  request = harness.request,
  access = context({ traceId: request.traceId }),
): Promise<void> {
  await assert.rejects(
    () => harness.router.resolveReply(
      access,
      request,
      accepted(request.id),
      neverAbort(),
    ),
    SharedOsMessageRouteFailedErrorV1,
  );
}

function assertZeroRecipientWork(harness: Harness): void {
  assert.equal(harness.provider.reads, 0);
  assert.equal(harness.store.binds.length, 0);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.sent.length, 0);
}
