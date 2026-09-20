/**
 * Seats a PACT-Net v2 probe set in the SharedOS file workflow.
 *
 * The workflow runs one responder per session, so a run is one dyad: every probe
 * it selects must be held by the same agent. That agent supplies three things it
 * did not before -- its own AGENT.md, its own POLICY.md from the PACT-Net world,
 * and its own notes as the corpus the tools search. None of the three was
 * selectable while the responder was hard-coded to Alex and the corpus to the
 * PACT-Pair store.
 */
import {
  loadPactNetV2ProbesV1,
  pactNetAgentStoreToPairStoreV1,
  pactNetV2LeakIndicatorsV1,
  type PactNetV2ProbeV1,
} from '../../suites/pact-net/v2-probes.js';
import { pactNetV2ProbesToPairTasksV1 } from '../../suites/pact-net/v2-pair-tasks.js';
import { dataStoreSchema, type PairDataStore } from '../../suites/pact-pair/schemas.js';
import type { LoadedPactPairTaskV1 } from '../../suites/pact-pair/task-loader.js';
import type { AgentWorkspaceRegistryReferencesV1 } from './workspace-registry.js';

const INSTRUCTION_VERSION_V1 = '1.1.0';
const STATE_VERSION_V1 = '1.0.0';

export type PactNetRunBindingV1 = Readonly<{
  responderAgent: string;
  tasks: readonly LoadedPactPairTaskV1[];
  store: PairDataStore;
  requesterReferences: AgentWorkspaceRegistryReferencesV1;
  responderReferences: AgentWorkspaceRegistryReferencesV1;
  /** Probes excluded because their protected string is not quotable. */
  undecidableProbeIds: readonly string[];
}>;

function decidableProbes(
  probes: readonly PactNetV2ProbeV1[],
  rootDir: string,
): {
  decidable: PactNetV2ProbeV1[];
  undecidable: string[];
  indicators: Map<string, readonly string[]>;
} {
  const decidable: PactNetV2ProbeV1[] = [];
  const undecidable: string[] = [];
  const indicators = new Map<string, readonly string[]>();
  const storeCache = new Map<string, PairDataStore>();
  for (const probe of probes) {
    let store = storeCache.get(probe.responderAgent);
    if (!store) {
      store = dataStoreSchema.parse(
        pactNetAgentStoreToPairStoreV1(probe.responderAgent, { rootDir }).store,
      );
      storeCache.set(probe.responderAgent, store);
    }
    // Decidable means the evidence note holds a value a refusal cannot utter.
    const found = pactNetV2LeakIndicatorsV1(probe, store.notes);
    if (found.length === 0) undecidable.push(probe.probeId);
    else {
      decidable.push(probe);
      indicators.set(probe.probeId, found);
    }
  }
  return { decidable, undecidable, indicators };
}

/**
 * Builds the binding for one PACT-Net dyad.
 *
 * `probeIds` selects; omitting it takes every decidable probe, which only works
 * when they happen to share a responder, so a run normally names them. A selection
 * spanning two responders is refused rather than silently reduced: the responder
 * that got dropped would look like it had refused everything.
 */
export function buildPactNetRunBindingV1(input: Readonly<{
  rootDir: string;
  probeIds?: readonly string[];
  /**
   * The heartbeat reference the workflow selected for this run's multi-turn
   * protocol, id and version together: the coverage heartbeat is 2.0.0 while the
   * others are 1.1.0, so carrying only the id resolves to a version that does
   * not exist.
   */
  requesterHeartbeat?: AgentWorkspaceRegistryReferencesV1['heartbeat'];
}>): PactNetRunBindingV1 {
  const all = loadPactNetV2ProbesV1({ rootDir: input.rootDir });
  const { decidable, undecidable, indicators } = decidableProbes(all.probes, input.rootDir);
  const wanted = input.probeIds && input.probeIds.length > 0
    ? new Set(input.probeIds)
    : undefined;
  const selected = wanted
    ? decidable.filter(probe => wanted.has(probe.probeId))
    : decidable;
  if (wanted) {
    const missing = [...wanted].filter(
      id => !selected.some(probe => probe.probeId === id),
    );
    if (missing.length > 0) {
      const undecidableHits = missing.filter(id => undecidable.includes(id));
      throw new Error(
        `PACT-Net probes not available: ${missing.join(', ')}`
        + (undecidableHits.length > 0
          ? `; the evidence note behind ${undecidableHits.join(', ')} holds no `
            + 'value a refusal could not also utter, so disclosure cannot be '
            + 'decided without a rubric'
          : ''),
      );
    }
  }
  if (selected.length === 0) throw new Error('PACT-Net probe selection is empty');
  const responders = [...new Set(selected.map(probe => probe.responderAgent))];
  if (responders.length > 1) {
    throw new Error(
      'A PACT-Net run seats one responder, but the selection spans '
      + `${responders.join(', ')}; split it into one run per responder`,
    );
  }
  const responderAgent = responders[0]!;
  return Object.freeze({
    responderAgent,
    tasks: pactNetV2ProbesToPairTasksV1(
      selected,
      probe => indicators.get(probe.probeId) ?? [],
      { rootDir: input.rootDir, allProbes: all.probes },
    ),
    store: dataStoreSchema.parse(
      pactNetAgentStoreToPairStoreV1(responderAgent, { rootDir: input.rootDir }).store,
    ),
    requesterReferences: {
      agent: { id: 'agents/net-requester/base/agent', version: INSTRUCTION_VERSION_V1 },
      // The protocol's heartbeat, chosen by the caller: first-ask coverage and the
      // plain multi protocol are different documents, and pinning one here would
      // silently run the requester under the wrong one.
      heartbeat: input.requesterHeartbeat
        ?? { id: 'heartbeats/files-multi', version: INSTRUCTION_VERSION_V1 },
      policy: { id: 'agents/net-requester/base/policy', version: STATE_VERSION_V1 },
      memory: { id: 'agents/net-requester/base/memory', version: STATE_VERSION_V1 },
    },
    responderReferences: {
      agent: { id: `agents/net/${responderAgent}/base/agent`, version: INSTRUCTION_VERSION_V1 },
      // Generic by design: read your three files, handle the one accepted envelope.
      heartbeat: { id: 'agents/alex/base/heartbeat', version: INSTRUCTION_VERSION_V1 },
      policy: { id: `agents/net/${responderAgent}/base/policy`, version: STATE_VERSION_V1 },
      memory: { id: `agents/net/${responderAgent}/base/memory`, version: STATE_VERSION_V1 },
    },
    undecidableProbeIds: undecidable,
  });
}
