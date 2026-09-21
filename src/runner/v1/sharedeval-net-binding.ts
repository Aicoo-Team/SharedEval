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
  readPactNetAgentNotesV1,
  type PactNetV2ProbeV1,
} from '../../suites/pact-net/v2-probes.js';
import {
  pactNetV2IndicatorsV1,
  type PactNetV2IndicatorRejectionV1,
  type PactNetV2IndicatorsV1,
} from '../../suites/pact-net/v2-indicators.js';
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
  /** Why each excluded probe was excluded, so the gap is explained, not silent. */
  undecidableReasons: Readonly<Record<string, PactNetV2IndicatorRejectionV1>>;
  /**
   * The derivation behind every selected probe's indicators: the anchor text, the
   * note it came from, and the values whose amount the asker's own store also
   * carries. Written into the run so a hit can be read back to a line of the
   * world rather than to a regex.
   */
  indicatorProvenance: readonly PactNetV2IndicatorsV1[];
}>;

function decidableProbes(
  probes: readonly PactNetV2ProbeV1[],
  rootDir: string,
): {
  decidable: PactNetV2ProbeV1[];
  undecidable: string[];
  reasons: Record<string, PactNetV2IndicatorRejectionV1>;
  indicators: Map<string, readonly string[]>;
  provenance: PactNetV2IndicatorsV1[];
} {
  const decidable: PactNetV2ProbeV1[] = [];
  const undecidable: string[] = [];
  const reasons: Record<string, PactNetV2IndicatorRejectionV1> = {};
  const indicators = new Map<string, readonly string[]>();
  const provenance: PactNetV2IndicatorsV1[] = [];
  const notesCache = new Map<string, ReturnType<typeof readPactNetAgentNotesV1>>();
  const notesOf = (agent: string): ReturnType<typeof readPactNetAgentNotesV1> => {
    let notes = notesCache.get(agent);
    if (!notes) {
      notes = readPactNetAgentNotesV1(agent, { rootDir });
      notesCache.set(agent, notes);
    }
    return notes;
  };
  for (const probe of probes) {
    // Decidable means the fact itself denotes a value, that value is in the
    // holder's store, and no refusal the holder could give reproduces it.
    const outcome = pactNetV2IndicatorsV1({
      probe,
      holderNotes: notesOf(probe.responderAgent),
      askerNotes: notesOf(probe.requesterAgent),
    });
    if (!outcome.ok) {
      undecidable.push(probe.probeId);
      reasons[probe.probeId] = outcome.reason;
      continue;
    }
    decidable.push(probe);
    indicators.set(probe.probeId, outcome.value.indicators);
    provenance.push(outcome.value);
  }
  return { decidable, undecidable, reasons, indicators, provenance };
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
  /**
   * Also seat probes the scorer cannot decide. Their rows come back
   * `scorable: false`, so they enter no rate; the point is the transcript, which
   * a judge reads afterwards. This is the only way to reach the 47 of 51 probes
   * whose forbidden fact names a class rather than quoting a value.
   */
  includeRubricProbes?: boolean;
}>): PactNetRunBindingV1 {
  const all = loadPactNetV2ProbesV1({ rootDir: input.rootDir });
  const { decidable, undecidable, reasons, indicators, provenance } = decidableProbes(
    all.probes, input.rootDir,
  );
  const rubricProbes = input.includeRubricProbes === true
    ? all.probes.filter(probe => undecidable.includes(probe.probeId))
    : [];
  const seatable = [...decidable, ...rubricProbes];
  const wanted = input.probeIds && input.probeIds.length > 0
    ? new Set(input.probeIds)
    : undefined;
  const selected = wanted
    ? seatable.filter(probe => wanted.has(probe.probeId))
    : seatable;
  if (wanted) {
    const missing = [...wanted].filter(
      id => !selected.some(probe => probe.probeId === id),
    );
    if (missing.length > 0) {
      // Naming the reason per probe, because they differ: a fact that denotes a
      // class needs a rubric, while one whose value the asker's own notes also
      // carry is a different problem with a different remedy.
      const undecidableHits = missing.filter(id => undecidable.includes(id));
      throw new Error(
        `PACT-Net probes not available: ${missing.join(', ')}`
        + (undecidableHits.length > 0
          ? '; no indicator could be derived, so disclosure cannot be decided '
            + 'without a rubric — '
            + undecidableHits.map(id => `${id}: ${reasons[id]}`).join('; ')
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
      {
        rootDir: input.rootDir,
        allProbes: all.probes,
        ...(input.includeRubricProbes === true ? { rubricScored: true } : {}),
      },
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
    undecidableReasons: Object.freeze(reasons),
    indicatorProvenance: provenance.filter(
      entry => selected.some(probe => probe.probeId === entry.probeId),
    ),
  });
}
