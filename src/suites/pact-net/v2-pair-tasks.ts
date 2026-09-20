/**
 * Projects PACT-Net v2 disclosure probes into the loaded task shape the
 * PACT-Pair file workflow already consumes, so one workflow runs both worlds.
 *
 * The projection carries the probe's protected string as the task's single gold
 * fact and marks the task refuse-expected. That is deliberate and it is the only
 * thing this arrangement measures: the evaluator treats gold facts appearing in a
 * refuse-expected task's replies as disclosure, which is exactly "did the
 * withheld string reach the agent it was withheld from". The utility side is not
 * measured here and must not be read off these tasks -- v2 ships `gold_status:
 * not_built` on 156 of 166 tasks and a human-review rubric on all of them, so
 * there is no machine-checkable right answer to compare against.
 */
import { pactTaskIntroV1Schema } from '../../contracts/benchmark.js';
import type { LoadedPactPairQaTaskV1 } from '../pact-pair/task-loader.js';
import {
  pactNetV2ProbeNumbersV1,
  readPactNetAgentIdentityV1,
  type PactNetV2ProbeV1,
} from './v2-probes.js';

/**
 * The responder's policy is its own POLICY.md from the PACT-Net world, not one of
 * the PACT-Pair defence variants, so the loaded task records that rather than
 * naming a pair policy it was not run under.
 */
export const PACT_NET_AGENT_PROFILE_POLICY_V1 = 'NET_AGENT_PROFILE' as const;

function identityFor(agent: string, rootDir?: string): { id: string; displayName: string; relationship: string } {
  const identity = readPactNetAgentIdentityV1(agent, ...(rootDir ? [{ rootDir }] : []));
  return {
    id: agent,
    displayName: identity.name,
    // The requester's own role, as its USER.md states it. No relationship to the
    // responder is asserted: the v2 world records none, and inventing one would
    // put a claim in the prompt that no dataset backs.
    relationship: identity.role,
  };
}

export function pactNetV2ProbeToPairTaskV1(input: Readonly<{
  probe: PactNetV2ProbeV1;
  numbers: Map<string, number>;
  rootDir?: string;
}>): LoadedPactPairQaTaskV1 {
  const { probe, numbers } = input;
  const number = numbers.get(probe.probeId);
  if (number === undefined) {
    throw new Error(`PACT-Net probe ${probe.probeId} has no assigned question number`);
  }
  const publicTask = pactTaskIntroV1Schema.parse({
    taskId: probe.probeId,
    kind: 'qa',
    prompt: probe.ask,
    requester: identityFor(probe.requesterAgent, input.rootDir),
    target: identityFor(probe.responderAgent, input.rootDir),
    surface: 'notes',
  });
  return {
    taskId: probe.probeId,
    benchmarkVersion: 2,
    kind: 'qa',
    // Recorded, not executed: the responder runs its own PACT-Net POLICY.md.
    policy: PACT_NET_AGENT_PROFILE_POLICY_V1 as unknown as LoadedPactPairQaTaskV1['policy'],
    requesterId: 'R1',
    gradingMode: 'category',
    category: probe.category,
    question: {
      id: number,
      category: probe.category,
      topic: probe.scenario,
      question: probe.ask,
      source_notes: [probe.evidenceNoteTitle],
      gold_key_facts: [probe.forbiddenFact],
      minimum_correct: probe.forbiddenFact,
    },
    // The edge exists in the dataset precisely because this fact must not travel
    // to this requester, so the expectation is refusal of that fact.
    expectedBehavior: 'refuse',
    benchmarkExpectedBehavior: 'refuse',
    publicTask,
  };
}

export function pactNetV2ProbesToPairTasksV1(
  probes: readonly PactNetV2ProbeV1[],
  options: { rootDir?: string; allProbes?: readonly PactNetV2ProbeV1[] } = {},
): LoadedPactPairQaTaskV1[] {
  const numbers = pactNetV2ProbeNumbersV1(options.allProbes ?? probes);
  return probes.map(probe => pactNetV2ProbeToPairTaskV1({
    probe, numbers, ...(options.rootDir ? { rootDir: options.rootDir } : {}),
  }));
}
