/**
 * File-based agent configuration for PACT-Pair (COO.md / POLICY.md /
 * MEMORY.md), restoring the live-aicoo arrangement in a provenance-attested
 * form. When a run opts in (`benchmark.agentConfig`), the responder's system
 * prompt is built from the persona's editable COO.md instead of the hardcoded
 * template, so behavior is editable without code changes.
 *
 * Reference files live at dataset/pact-pair/agent_configs/<persona>/. Every
 * loaded file's sha256 is recorded in run.json (agentConfigProvenance),
 * mirroring policyProvenance; a missing file fails the run closed rather than
 * silently degrading to the hardcoded prompt.
 *
 * Persona ↔ requester-id mapping (verified against requesterIdentities in
 * task-loader.ts): alex = responder (agent "Atlas"); tina = R1, marcus = R2,
 * jordan = R3, dana = R4. R0 (Riley Novak, stranger) has no persona config.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PACT_PAIR_AGENT_PERSONAS_V1 = [
  'alex',
  'tina',
  'marcus',
  'jordan',
  'dana',
] as const;
export type PactPairAgentPersonaV1 = (typeof PACT_PAIR_AGENT_PERSONAS_V1)[number];

/** The responder persona is always the data owner in the current dataset. */
export const PACT_PAIR_RESPONDER_PERSONA_V1: PactPairAgentPersonaV1 = 'alex';

/** Requester persona for each requester cohort id (R0 has no config). */
export const PACT_PAIR_REQUESTER_PERSONA_BY_ID_V1: Record<string, PactPairAgentPersonaV1> = {
  R1: 'tina',
  R2: 'marcus',
  R3: 'jordan',
  R4: 'dana',
};

/** The three config files loaded per persona. USER/HEARTBEAT are not loaded. */
const AGENT_CONFIG_FILES_V1 = ['COO.md', 'POLICY.md', 'MEMORY.md'] as const;

export type PactPairAgentConfigFileProvenanceV1 = {
  file: string;
  sha256: string;
};

export type PactPairAgentConfigProvenanceV1 = {
  persona: PactPairAgentPersonaV1;
  coo: PactPairAgentConfigFileProvenanceV1;
  policy: PactPairAgentConfigFileProvenanceV1;
  memory: PactPairAgentConfigFileProvenanceV1;
};

export type PactPairAgentConfigV1 = {
  persona: PactPairAgentPersonaV1;
  /** COO.md — the editable operating-instructions template. */
  coo: string;
  /** POLICY.md — the persona's policy file (used only when policySource=agent_config). */
  policy: string;
  /** MEMORY.md — the initial maintainable memory seed. */
  memory: string;
  provenance: PactPairAgentConfigProvenanceV1;
};

function agentConfigDir(rootDir: string | undefined, persona: PactPairAgentPersonaV1): string {
  if (rootDir) {
    return join(rootDir, 'dataset', 'pact-pair', 'agent_configs', persona);
  }
  return fileURLToPath(
    new URL(`../../../dataset/pact-pair/agent_configs/${persona}/`, import.meta.url),
  );
}

function loadFile(
  directory: string,
  persona: PactPairAgentPersonaV1,
  fileName: string,
): { content: string; provenance: PactPairAgentConfigFileProvenanceV1 } {
  const path = join(directory, fileName);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // Fail closed: an opted-in run must never silently fall back to the
    // hardcoded prompt because a config file is missing.
    throw new Error(
      `PACT-Pair agent config file is missing for persona ${persona}: `
      + `${fileName} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const content = raw.trim();
  if (!content) {
    throw new Error(
      `PACT-Pair agent config file is empty for persona ${persona}: ${fileName}`,
    );
  }
  return {
    content,
    provenance: {
      file: `dataset/pact-pair/agent_configs/${persona}/${fileName}`,
      sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    },
  };
}

export function loadPactPairAgentConfigV1(
  persona: PactPairAgentPersonaV1,
  rootDir?: string,
): PactPairAgentConfigV1 {
  const directory = agentConfigDir(rootDir, persona);
  const [coo, policy, memory] = AGENT_CONFIG_FILES_V1.map(fileName =>
    loadFile(directory, persona, fileName),
  );
  return {
    persona,
    coo: coo.content,
    policy: policy.content,
    memory: memory.content,
    provenance: {
      persona,
      coo: coo.provenance,
      policy: policy.provenance,
      memory: memory.provenance,
    },
  };
}

export type PactPairAgentConfigRunProvenanceV1 = {
  policySource: 'dial' | 'agent_config';
  responder: PactPairAgentConfigProvenanceV1;
  requester?: PactPairAgentConfigProvenanceV1;
};

/**
 * Builds the run.json agentConfigProvenance for an opted-in run: the responder
 * persona always, plus the requester persona when a requester driver runs with
 * its own config (Feature 2). Loading here re-hashes the exact bytes used.
 */
export function buildPactPairAgentConfigProvenanceV1(options: {
  responder: PactPairAgentPersonaV1;
  policySource: 'dial' | 'agent_config';
  requester?: PactPairAgentPersonaV1;
  rootDir?: string;
}): PactPairAgentConfigRunProvenanceV1 {
  const responder = loadPactPairAgentConfigV1(options.responder, options.rootDir).provenance;
  return {
    policySource: options.policySource,
    responder,
    ...(options.requester
      ? { requester: loadPactPairAgentConfigV1(options.requester, options.rootDir).provenance }
      : {}),
  };
}

/** Resolve the requester persona for a cohort id, or throw for R0 (no config). */
export function requesterPersonaForCohortV1(requester: string): PactPairAgentPersonaV1 {
  const persona = PACT_PAIR_REQUESTER_PERSONA_BY_ID_V1[requester];
  if (!persona) {
    throw new Error(
      `Requester cohort ${requester} has no agent config persona `
      + '(R0/Riley Novak is a stranger with no config directory)',
    );
  }
  return persona;
}
