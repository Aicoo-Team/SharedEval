import assert from 'node:assert/strict';
import test from 'node:test';
import { heartbeatInstructionText } from '../../src/runner/v1/sharedos-file-session.js';

const LEGACY_INSTRUCTION = 'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.';

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
