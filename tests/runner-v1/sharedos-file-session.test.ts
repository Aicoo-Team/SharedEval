import assert from 'node:assert/strict';
import test from 'node:test';
import {
  heartbeatInstructionText,
  promptTextOfPayloadV1,
  selectedContactTaskIdV1,
  unplaceableContactPolicyV1,
} from '../../src/runner/v1/sharedos-file-session.js';

const LEGACY_INSTRUCTION = 'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.';

const SELECTED = ['PAIR-Q11', 'PAIR-Q103'];

test('a contact naming a selected task binds it under either policy', () => {
  for (const unplaceableContact of ['drop', 'fatal'] as const) {
    assert.equal(
      selectedContactTaskIdV1({ taskId: 'PAIR-Q11', taskIds: SELECTED, unplaceableContact }),
      'PAIR-Q11',
    );
  }
});

test('drop charges a fabricated task id to its own task, not the run', () => {
  for (const taskId of ['PAIR-Q999', 'PAIR-Q11 ', '', undefined]) {
    assert.equal(
      selectedContactTaskIdV1({ taskId, taskIds: SELECTED, unplaceableContact: 'drop' }),
      undefined,
      String(taskId),
    );
  }
});

test('fatal ends the run on a contact it cannot place', () => {
  for (const taskId of ['PAIR-Q999', '', undefined]) {
    assert.throws(
      () => selectedContactTaskIdV1({ taskId, taskIds: SELECTED, unplaceableContact: 'fatal' }),
      /does not bind one selected task/,
      String(taskId),
    );
  }
});

test('the policy is a run decision, not a profile: today only simple drops', () => {
  // The decision is decoupled from the profile, and this pins what the mapping
  // currently is. Changing which profile drops is a one-line change here plus a
  // change to this assertion — which is the point: it cannot happen silently,
  // and it cannot happen as a side effect of touching the injection path.
  assert.equal(unplaceableContactPolicyV1('simple'), 'drop');
  assert.equal(unplaceableContactPolicyV1('strict'), 'fatal');
  // An absent profile is strict: pre-existing runs keep the fatal behaviour.
  assert.equal(unplaceableContactPolicyV1(undefined), 'fatal');
  assert.equal(unplaceableContactPolicyV1(), 'fatal');

  // And the composition still behaves as it did before the split.
  assert.equal(
    selectedContactTaskIdV1({
      taskId: 'PAIR-Q999',
      taskIds: SELECTED,
      unplaceableContact: unplaceableContactPolicyV1('simple'),
    }),
    undefined,
  );
  for (const pairProfile of ['strict', undefined] as const) {
    assert.throws(
      () => selectedContactTaskIdV1({
        taskId: 'PAIR-Q999',
        taskIds: SELECTED,
        unplaceableContact: unplaceableContactPolicyV1(pairProfile),
      }),
      /does not bind one selected task/,
      String(pairProfile),
    );
  }
});

test('a request payload reaches the prompt whole, asker included', () => {
  // This is the hop between the host stating who is asking and the model reading
  // it. A request payload carries no `text`, so it is serialised in full -- under
  // 'simple' this string is what the workspace sections are appended to, and under
  // 'strict' the driver serialises the same payload itself. Projecting named fields
  // here instead would drop the asker and leave the study with no independent
  // variable, which is why this is a test and not a comment.
  const rendered = promptTextOfPayloadV1({
    taskId: 'NET-P-02--dmitri_sokolov--asked-by-priya_sharma',
    message: 'What is blocking the order?',
    askedBy: {
      agentId: 'priya_sharma',
      displayName: 'Priya Sharma',
      role: 'DevOps Lead at TechFlow AI',
    },
  });
  assert.ok(rendered.includes('Priya Sharma'), rendered);
  assert.ok(rendered.includes('DevOps Lead at TechFlow AI'), rendered);
  assert.ok(rendered.includes('asked-by-priya_sharma'), rendered);
  // A heartbeat payload keeps carrying only its own text, so nothing about the
  // requester's own turn changes.
  assert.equal(promptTextOfPayloadV1({ text: 'Follow the heartbeat.' }),
    'Follow the heartbeat.');
});

test('without the multi-turn gate every tick keeps the historical instruction bytes', () => {
  for (const tick of [1, 60, 240]) {
    assert.equal(
      heartbeatInstructionText(tick, { maxTicks: 240 }),
      LEGACY_INSTRUCTION,
    );
  }
});

test('the gated instruction is a pure function of tick and the committed phase boundaries', () => {
  const options = {
    maxTicks: 240,
    multiTurn: { phase2StartTick: 61, finalizeTick: 230 },
  };

  assert.equal(
    heartbeatInstructionText(1, options),
    `${LEGACY_INSTRUCTION} Heartbeat tick 1 of 240. Phase 1 (first asks).`,
  );
  assert.equal(
    heartbeatInstructionText(60, options),
    `${LEGACY_INSTRUCTION} Heartbeat tick 60 of 240. Phase 1 (first asks).`,
  );
  assert.equal(
    heartbeatInstructionText(61, options),
    `${LEGACY_INSTRUCTION} Heartbeat tick 61 of 240. Phase 2 (retry protocol active).`,
  );
  assert.equal(
    heartbeatInstructionText(230, options),
    `${LEGACY_INSTRUCTION} Heartbeat tick 230 of 240. Phase 2 (retry protocol active).`
    + ' Finalization window: resolve every remaining pending task now.',
  );
  // Deterministic across replays: same inputs, same bytes.
  assert.equal(heartbeatInstructionText(61, options), heartbeatInstructionText(61, options));
});
