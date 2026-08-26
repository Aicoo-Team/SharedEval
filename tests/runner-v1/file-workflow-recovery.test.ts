import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  FileWorkflowHeartbeatMarkerAuthorityErrorV1,
  runFileWorkflowHeartbeatV1,
} from '../../src/runner/v1/file-workflow-recovery.js';
import { openFileWorkflowLedgerV1 } from '../../src/runner/v1/file-workflow-ledger.js';
import {
  binding,
  finalFilesFor,
  heartbeatPayloadFor,
  transition,
} from './file-workflow-test-fixtures.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('publishes durable start authority before executing a fresh heartbeat', async t => {
  const fixture = await opened(t, 'fresh');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  let calls = 0;

  const result = await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start: startFor(payload),
    execute: async () => {
      calls += 1;
      assert.match(
        await readFile(markerPath(fixture.runDirectory, 1), 'utf8'),
        /sharedeval-file-heartbeat-start\/v1/,
      );
      return payload;
    },
  });

  assert.equal(result.kind, 'committed');
  assert.equal(result.kind === 'committed' && result.replayed, false);
  assert.equal(calls, 1);
  assert.equal((await fixture.store.readRecords()).length, 1);
  await fixture.store.close();
});

test('replays exact committed identity and repairs projections without executing', async t => {
  const fixture = await opened(t, 'committed-replay');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  const start = startFor(payload);
  await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start,
    execute: async () => payload,
  });
  await rm(join(fixture.runDirectory, 'events.jsonl'));
  await fixture.store.close();
  const resumed = await openFileWorkflowLedgerV1(fixture.options);

  let calls = 0;
  const replay = await runFileWorkflowHeartbeatV1({
    ledger: resumed,
    start,
    execute: async () => {
      calls += 1;
      return payload;
    },
  });

  assert.equal(replay.kind, 'committed');
  assert.equal(replay.kind === 'committed' && replay.replayed, true);
  assert.equal(calls, 0);
  assert.match(await readFile(join(fixture.runDirectory, 'events.jsonl'), 'utf8'), /event-1/);
  await resumed.close();
});

test('returns stable indeterminate for an exact start-only replay and never executes', async t => {
  const fixture = await opened(t, 'start-only');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  const start = startFor(payload);
  assert.deepEqual(await fixture.store.beginHeartbeat(start), { kind: 'execute' });
  await fixture.store.close();
  const resumed = await openFileWorkflowLedgerV1(fixture.options);

  let calls = 0;
  const result = await runFileWorkflowHeartbeatV1({
    ledger: resumed,
    start,
    execute: async () => {
      calls += 1;
      return payload;
    },
  });

  assert.deepEqual(result, indeterminate());
  assert.equal(calls, 0);
  await resumed.close();
});

test('inspects unresolved start authority without constructing a replacement heartbeat', async t => {
  const fixture = await opened(t, 'inspect-start-only');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  assert.deepEqual(await fixture.store.beginHeartbeat(startFor(payload)), { kind: 'execute' });
  await fixture.store.close();
  const resumed = await openFileWorkflowLedgerV1(fixture.options);

  assert.deepEqual(await (resumed as any).inspectRecovery(), indeterminate());
  await resumed.close();
});

test('fails loud on conflicting same-tick event, trace, or input identity', async t => {
  for (const field of ['eventId', 'traceId', 'inputDigest'] as const) {
    await t.test(field, async t => {
      const fixture = await opened(t, `same-tick-${field}`);
      const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
      const start = startFor(payload);
      await fixture.store.beginHeartbeat(start);
      const conflicting = structuredClone(start);
      if (field === 'inputDigest') conflicting.inputDigest = sha256('different-input');
      else conflicting.event[field] = `different-${field}`;
      let calls = 0;

      await assert.rejects(
        runFileWorkflowHeartbeatV1({
          ledger: fixture.store,
          start: conflicting,
          execute: async () => {
            calls += 1;
            return payload;
          },
        }),
        /heartbeat|start|identity|conflict/i,
      );
      assert.equal(calls, 0);
      await fixture.store.close();
    });
  }
});

test('fails loud on duplicate prior event or trace before executing', async t => {
  for (const field of ['eventId', 'traceId'] as const) {
    await t.test(field, async t => {
      const fixture = await opened(t, `prior-${field}`, ['PAIR-Q-1', 'PAIR-Q-2']);
      const first = payloadFor(fixture, 1, 'PAIR-Q-1');
      await runFileWorkflowHeartbeatV1({
        ledger: fixture.store,
        start: startFor(first),
        execute: async () => first,
      });
      const second = payloadFor(fixture, 2, 'PAIR-Q-2');
      second.event[field] = first.event[field];
      let calls = 0;

      await assert.rejects(
        runFileWorkflowHeartbeatV1({
          ledger: fixture.store,
          start: startFor(second),
          execute: async () => {
            calls += 1;
            return second;
          },
        }),
        /event|trace|identity|unique|duplicate/i,
      );
      assert.equal(calls, 0);
      await fixture.store.close();
    });
  }
});

test('requires an exact start marker before every direct commit', async t => {
  const fixture = await opened(t, 'commit-marker');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  await assert.rejects(
    fixture.store.commitHeartbeat(payload),
    /start|marker|required/i,
  );

  await fixture.store.beginHeartbeat(startFor(payload));
  const changed = structuredClone(payload);
  changed.inputDigest = sha256('changed-after-start');
  await assert.rejects(
    fixture.store.commitHeartbeat(changed),
    /start|marker|input|identity|conflict/i,
  );
  assert.equal((await fixture.store.readRecords()).length, 0);
  await fixture.store.close();
});

test('sanitizes only malformed marker authority and prevents re-execution', async t => {
  const fixture = await opened(t, 'malformed-marker');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  const start = startFor(payload);
  await fixture.store.beginHeartbeat(start);
  await writeFile(
    markerPath(fixture.runDirectory, 1),
    '{"private":"PRIVATE_MARKER /Users/alice credential=SECRET"',
    'utf8',
  );

  let calls = 0;
  const result = await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start,
    execute: async () => {
      calls += 1;
      return payload;
    },
  });

  assert.deepEqual(result, indeterminate());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Users|credential|SECRET|marker/i);
  assert.equal(calls, 0);
  await fixture.store.close();
});

test('maps execute and callback validation failures to stable indeterminate after start', async t => {
  await t.test('malformed start', async t => {
    const fixture = await opened(t, 'malformed-start');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
    let calls = 0;
    const result = await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start: { ...startFor(payload), inputDigest: 'PRIVATE_SECRET_INVALID' },
      execute: async () => {
        calls += 1;
        return payload;
      },
    });
    assert.deepEqual(result, indeterminate());
    assert.equal(calls, 0);
    await assert.rejects(readFile(markerPath(fixture.runDirectory, 1), 'utf8'), {
      code: 'ENOENT',
    });
    await fixture.store.close();
  });

  await t.test('execute throws', async t => {
    const fixture = await opened(t, 'execute-throws');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
    const start = startFor(payload);
    let calls = 0;
    const result = await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start,
      execute: async () => {
        calls += 1;
        throw new Error('PRIVATE_PROVIDER credential=SECRET');
      },
    });
    assert.deepEqual(result, indeterminate());
    assert.match(await readFile(markerPath(fixture.runDirectory, 1), 'utf8'), /markerDigest/);
    assert.deepEqual(await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start,
      execute: async () => {
        calls += 1;
        return payload;
      },
    }), indeterminate());
    assert.equal(calls, 1);
    await fixture.store.close();
  });

  for (const kind of ['malformed', 'wrong-event', 'wrong-input'] as const) {
    await t.test(kind, async t => {
      const fixture = await opened(t, `callback-${kind}`);
      const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
      const callback = structuredClone(payload);
      if (kind === 'malformed') delete callback.usage;
      if (kind === 'wrong-event') callback.event.traceId = 'wrong-trace';
      if (kind === 'wrong-input') callback.inputDigest = sha256('wrong-input');
      let commitCalls = 0;
      const result = await runFileWorkflowHeartbeatV1({
        ledger: {
          beginHeartbeat: value => fixture.store.beginHeartbeat(value),
          commitHeartbeat: value => {
            commitCalls += 1;
            return fixture.store.commitHeartbeat(value);
          },
        },
        start: startFor(payload),
        execute: async () => callback,
      });
      assert.deepEqual(result, indeterminate());
      assert.equal(commitCalls, 0);
      await fixture.store.close();
    });
  }
});

test('replays an exact committed heartbeat after finalization but rejects a new tick', async t => {
  const fixture = await opened(t, 'finalized', ['PAIR-Q-1']);
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1', 'no_response');
  const start = startFor(payload);
  await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start,
    execute: async () => payload,
  });
  await fixture.store.finalize({
    stopReason: 'tick_exhausted',
    finalFiles: finalFilesFor(fixture.runBinding, 1),
  });
  await rm(join(fixture.runDirectory, 'results.jsonl'));

  let calls = 0;
  const replay = await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start,
    execute: async () => {
      calls += 1;
      return payload;
    },
  });
  assert.equal(replay.kind, 'committed');
  assert.equal(replay.kind === 'committed' && replay.replayed, true);
  assert.equal(calls, 0);
  assert.match(await readFile(join(fixture.runDirectory, 'results.jsonl'), 'utf8'), /PAIR-Q-1/);

  const next = structuredClone(payload);
  next.event = {
    ...next.event,
    eventId: 'event-2',
    tick: 2,
    traceId: 'trace-2',
  };
  next.inputDigest = sha256('finalized-next-input');
  await assert.rejects(
    runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start: startFor(next),
      execute: async () => {
        calls += 1;
        return next;
      },
    }),
    /final|complete|another heartbeat/i,
  );
  assert.equal(calls, 0);
  await assert.rejects(readFile(markerPath(fixture.runDirectory, 2), 'utf8'), { code: 'ENOENT' });
  await fixture.store.close();
});

test('finalize rejects an unresolved start marker but accepts fully committed marker history', async t => {
  await t.test('start-only marker', async t => {
    const fixture = await opened(t, 'finalize-start-only');
    const committed = heartbeatPayloadFor(fixture.runBinding, 1, []);
    await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start: startFor(committed),
      execute: async () => committed,
    });
    const unresolved = heartbeatPayloadFor(fixture.runBinding, 2, []);
    assert.deepEqual(
      await fixture.store.beginHeartbeat(startFor(unresolved)),
      { kind: 'execute' },
    );

    await assert.rejects(
      fixture.store.finalize({
        stopReason: 'tick_exhausted',
        finalFiles: finalFilesFor(fixture.runBinding, 1),
      }),
      /heartbeat|start|unresolved|final/i,
    );
    await assert.rejects(
      readFile(join(fixture.runDirectory, '.sharedeval-file-workflow', 'final.json'), 'utf8'),
      { code: 'ENOENT' },
    );
    await fixture.store.close();
  });

  await t.test('fully committed markers', async t => {
    const fixture = await opened(t, 'finalize-committed');
    const committed = payloadFor(fixture, 1, 'PAIR-Q-1', 'no_response');
    await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start: startFor(committed),
      execute: async () => committed,
    });
    await assert.doesNotReject(fixture.store.finalize({
      stopReason: 'tick_exhausted',
      finalFiles: finalFilesFor(fixture.runBinding, 1),
    }));
    assert.match(
      await readFile(
        join(fixture.runDirectory, '.sharedeval-file-workflow', 'final.json'),
        'utf8',
      ),
      /sharedeval-file-final-authority\/v1/,
    );
    await fixture.store.close();
  });
});

test('propagates ordinary record, marker-lane, and commit storage failures', async t => {
  await t.test('record corruption', async t => {
    const fixture = await opened(t, 'record-corrupt', ['PAIR-Q-1', 'PAIR-Q-2']);
    const first = payloadFor(fixture, 1, 'PAIR-Q-1');
    await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start: startFor(first),
      execute: async () => first,
    });
    await writeFile(recordPath(fixture.runDirectory, 0), '{"private":"CORRUPT"', 'utf8');
    const second = payloadFor(fixture, 2, 'PAIR-Q-2');
    let calls = 0;
    await assert.rejects(
      runFileWorkflowHeartbeatV1({
        ledger: fixture.store,
        start: startFor(second),
        execute: async () => {
          calls += 1;
          return second;
        },
      }),
      /ledger record 0 is malformed/i,
    );
    assert.equal(calls, 0);
    await fixture.store.close();
  });

  await t.test('final authority corruption', async t => {
    const fixture = await opened(t, 'final-corrupt');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1', 'no_response');
    const start = startFor(payload);
    await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start,
      execute: async () => payload,
    });
    await fixture.store.finalize({
      stopReason: 'tick_exhausted',
      finalFiles: finalFilesFor(fixture.runBinding, 1),
    });
    await writeFile(
      join(fixture.runDirectory, '.sharedeval-file-workflow', 'final.json'),
      '{"private":"CORRUPT_FINAL"',
      'utf8',
    );
    let calls = 0;
    await assert.rejects(
      runFileWorkflowHeartbeatV1({
        ledger: fixture.store,
        start,
        execute: async () => {
          calls += 1;
          return payload;
        },
      }),
      /final authority.*malformed/i,
    );
    assert.equal(calls, 0);
    await fixture.store.close();
  });

  await t.test('unexpected marker lane entry', async t => {
    const fixture = await opened(t, 'marker-lane-corrupt');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
    await writeFile(join(markerDirectory(fixture.runDirectory), 'foreign.json'), '{}\n', 'utf8');
    await assert.rejects(
      runFileWorkflowHeartbeatV1({
        ledger: fixture.store,
        start: startFor(payload),
        execute: async () => payload,
      }),
      /unexpected|heartbeat starts|entry/i,
    );
    await fixture.store.close();
  });

  await t.test('ordinary commit failure', async t => {
    const fixture = await opened(t, 'commit-storage');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
    const failure = new Error('PRIVATE_COMMIT_STORAGE path=/private/ledger');
    await assert.rejects(
      runFileWorkflowHeartbeatV1({
        ledger: {
          beginHeartbeat: value => fixture.store.beginHeartbeat(value),
          commitHeartbeat: async () => { throw failure; },
        },
        start: startFor(payload),
        execute: async () => payload,
      }),
      error => error === failure,
    );
    await fixture.store.close();
  });
});

test('catches only typed marker-authority errors from commit', async t => {
  const fixture = await opened(t, 'typed-marker-commit');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  const result = await runFileWorkflowHeartbeatV1({
    ledger: {
      beginHeartbeat: value => fixture.store.beginHeartbeat(value),
      commitHeartbeat: async () => {
        throw new FileWorkflowHeartbeatMarkerAuthorityErrorV1();
      },
    },
    start: startFor(payload),
    execute: async () => payload,
  });
  assert.deepEqual(result, indeterminate());
  await fixture.store.close();
});

test('sanitizes marker corruption that occurs after external execution begins', async t => {
  const fixture = await opened(t, 'marker-corrupt-during-execute');
  const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
  const start = startFor(payload);
  let calls = 0;
  const result = await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start,
    execute: async () => {
      calls += 1;
      await writeFile(
        markerPath(fixture.runDirectory, 1),
        '{"private":"PRIVATE_MARKER /Users/alice credential=SECRET"',
        'utf8',
      );
      return payload;
    },
  });
  assert.deepEqual(result, indeterminate());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Users|credential|SECRET|marker/i);
  assert.equal(calls, 1);

  assert.deepEqual(await runFileWorkflowHeartbeatV1({
    ledger: fixture.store,
    start,
    execute: async () => {
      calls += 1;
      return payload;
    },
  }), indeterminate());
  assert.equal(calls, 1);
  await fixture.store.close();
});

test('rejects an exact-existing marker when writer fencing changes before acceptance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-recovery-fence-loss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'fence-loss', ['PAIR-Q-1']);
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
    faults: {
      async beforeHeartbeatStartLinkForTest({ stagePath, destination }) {
        await link(stagePath, destination);
        const claimsDirectory = join(
          runDirectory,
          '.sharedeval-file-workflow',
          'writer-claims',
        );
        const acquire = JSON.parse(await readFile(
          join(claimsDirectory, 'claim-000000000000.json'),
          'utf8',
        ));
        const withoutDigest = {
          apiVersion: 'sharedeval-file-writer-claim/v1',
          sequence: 1,
          kind: 'release',
          token: acquire.token,
          pid: acquire.pid,
          previousClaimDigest: acquire.claimDigest,
        };
        await writeFile(
          join(claimsDirectory, 'claim-000000000001.json'),
          `${canonicalTestJson({
            ...withoutDigest,
            claimDigest: sha256(canonicalTestJson(withoutDigest)),
          })}\n`,
          'utf8',
        );
      },
    },
  });
  const payload = heartbeatPayloadFor(
    runBinding,
    1,
    [transition('PAIR-Q-1', 'error', 1)],
  );
  let calls = 0;

  await assert.rejects(
    runFileWorkflowHeartbeatV1({
      ledger: store,
      start: startFor(payload),
      execute: async () => {
        calls += 1;
        return payload;
      },
    }),
    /writer|fencing|authority|ownership/i,
  );
  assert.equal(calls, 0);
  await store.close();
});

test('recovers marker stage and post-link crash windows without duplicate execution', async t => {
  await t.test('stage written before link', async t => {
    const fixture = await opened(t, 'stage-crash');
    const stage = join(
      markerDirectory(fixture.runDirectory),
      'start-stage-00000000-0000-4000-8000-000000000001.json',
    );
    await writeFile(stage, '{"torn":"stage"}\n', 'utf8');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
    const result = await runFileWorkflowHeartbeatV1({
      ledger: fixture.store,
      start: startFor(payload),
      execute: async () => payload,
    });
    assert.equal(result.kind, 'committed');
    assert.equal((await readdir(markerDirectory(fixture.runDirectory))).length, 1);
    await fixture.store.close();
  });

  await t.test('link published before stage cleanup', async t => {
    const fixture = await opened(t, 'link-crash');
    const payload = payloadFor(fixture, 1, 'PAIR-Q-1');
    const start = startFor(payload);
    assert.deepEqual(await fixture.store.beginHeartbeat(start), { kind: 'execute' });
    const stage = join(
      markerDirectory(fixture.runDirectory),
      'start-stage-00000000-0000-4000-8000-000000000002.json',
    );
    await writeFile(stage, await readFile(markerPath(fixture.runDirectory, 1), 'utf8'), 'utf8');
    await fixture.store.close();

    const resumed = await openFileWorkflowLedgerV1(fixture.options);
    let calls = 0;
    assert.deepEqual(await runFileWorkflowHeartbeatV1({
      ledger: resumed,
      start,
      execute: async () => {
        calls += 1;
        return payload;
      },
    }), indeterminate());
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(markerDirectory(fixture.runDirectory)), [
      'start-000000000001.json',
    ]);
    await resumed.close();
  });
});

test('close waits for an in-flight begin and fences later begin operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sharedeval-recovery-begin-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', 'begin-close', ['PAIR-Q-1']);
  let releaseLink!: () => void;
  const linkReleased = new Promise<void>(resolve => { releaseLink = resolve; });
  let reportPaused!: () => void;
  const paused = new Promise<void>(resolve => { reportPaused = resolve; });
  const store = await openFileWorkflowLedgerV1({
    runDirectory,
    binding: runBinding,
    retainPrivate: false,
    faults: {
      async beforeHeartbeatStartLinkForTest() {
        reportPaused();
        await linkReleased;
      },
    },
  });
  const payload = heartbeatPayloadFor(
    runBinding,
    1,
    [transition('PAIR-Q-1', 'error', 1)],
  );
  const start = startFor(payload);
  const begin = store.beginHeartbeat(start);
  await paused;
  const close = store.close();
  assert.equal(await settlesNextTurn(close), 'pending');
  await assert.rejects(store.beginHeartbeat(start), /closed/i);
  releaseLink();
  assert.deepEqual(await begin, { kind: 'execute' });
  await close;
  await assert.rejects(store.beginHeartbeat(start), /closed/i);
  assert.match(await readFile(markerPath(runDirectory, 1), 'utf8'), /markerDigest/);
});

test('runner barrel exposes only the caller-facing recovery coordinator', async () => {
  const runnerV1 = await import('../../src/runner/v1/index.js');
  assert.equal(typeof runnerV1.runFileWorkflowHeartbeatV1, 'function');
  assert.equal('fileWorkflowHeartbeatStartV1Schema' in runnerV1, false);
  assert.equal('fileWorkflowHeartbeatStartMarkerV1Schema' in runnerV1, false);
  assert.equal('FileWorkflowHeartbeatMarkerAuthorityErrorV1' in runnerV1, false);
});

function payloadFor(
  fixture: Awaited<ReturnType<typeof opened>>,
  tick: number,
  taskId: string,
  status: 'error' | 'no_response' = 'error',
) {
  return heartbeatPayloadFor(
    fixture.runBinding,
    tick,
    [transition(taskId, status, tick)],
  );
}

function startFor(payload: ReturnType<typeof heartbeatPayloadFor>) {
  return {
    event: structuredClone(payload.event),
    inputDigest: payload.inputDigest as string,
  };
}

async function opened(
  t: TestContext,
  label: string,
  selectedTaskIds = ['PAIR-Q-1'],
) {
  const root = await mkdtemp(join(tmpdir(), `sharedeval-recovery-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, 'run');
  const runBinding = binding('files-multi', label, selectedTaskIds);
  const options = { runDirectory, binding: runBinding, retainPrivate: false } as const;
  const store = await openFileWorkflowLedgerV1(options);
  return { runDirectory, runBinding, options, store };
}

function indeterminate() {
  return {
    kind: 'indeterminate_external_operation' as const,
    errorCode: 'indeterminate_external_operation' as const,
  };
}

function markerDirectory(runDirectory: string): string {
  return join(runDirectory, '.sharedeval-file-workflow', 'heartbeat-starts');
}

function markerPath(runDirectory: string, tick: number): string {
  return join(markerDirectory(runDirectory), `start-${String(tick).padStart(12, '0')}.json`);
}

function recordPath(runDirectory: string, sequence: number): string {
  return join(
    runDirectory,
    '.sharedeval-file-workflow',
    'records',
    `record-${String(sequence).padStart(12, '0')}.json`,
  );
}

function canonicalTestJson(value: unknown): string {
  return JSON.stringify(sortTestJson(value));
}

function sortTestJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortTestJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortTestJson(nested)]));
  }
  return value;
}

async function settlesNextTurn(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>(resolve => setImmediate(() => resolve('pending'))),
  ]);
}
