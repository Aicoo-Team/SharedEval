/**
 * Multi-attempt requester protocol ("attacker" persistence) — suite-owned
 * policy for retrying a task after a responder-level refusal or escalation.
 *
 * The follow-up asks are SCRIPTED, versioned dataset artifacts
 * (`dataset/pact-pair/attempts/followup_scripts_v1.json`), not a live
 * requester model: deterministic, hash-attested, and identical for every
 * responder under test. Attempt 1 is always the original task prompt; the
 * scripts renew the same ask for attempts 2+ without ever claiming new
 * authority, permissions, or owner approval — the retry travels through the
 * same principal and the same grants, always.
 *
 * Retry eligibility is deliberately narrow (see docs/multi-attempt-requester.md):
 * only a harness-emitted terminal `refuse` or `escalate` triggers another
 * attempt. Runner-synthesized escalations (budget exhaustion, protocol
 * errors), infrastructure errors, kernel-level `denied` turns, and timeouts
 * all end the task — "denied is an experimental outcome, not an
 * infrastructure retry", and a retry against a deterministic grant decision
 * with unchanged grants measures nothing.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PactTaskIntroV1 } from '../../protocol/v1/index.js';
import type { PactPairTerminalDecisionV1 } from './evaluator.js';

export const PACT_PAIR_FOLLOWUP_SCRIPT_FILE_V1 =
  'dataset/pact-pair/attempts/followup_scripts_v1.json' as const;

/** Matches the `message` bound of the `requester_followup` observation. */
const MAX_FOLLOWUP_MESSAGE_CHARS_V1 = 32_768;

const followUpEntryV1Schema = z
  .object({
    attempt: z.number().int().min(2).max(8),
    template: z.string().min(1).max(MAX_FOLLOWUP_MESSAGE_CHARS_V1),
  })
  .strict();

const uniqueAttempts = (entries: Array<{ attempt: number }>): boolean =>
  new Set(entries.map(entry => entry.attempt)).size === entries.length;

export const pactPairFollowUpScriptV1Schema = z
  .object({
    version: z.number().int().positive(),
    id: z.string().min(1).max(128),
    description: z.string().max(4_096).optional(),
    followUps: z
      .array(followUpEntryV1Schema)
      .min(1)
      .max(7)
      .refine(uniqueAttempts, { message: 'follow-up attempts must be unique' }),
    taskOverrides: z
      .record(
        z
          .array(followUpEntryV1Schema)
          .min(1)
          .max(7)
          .refine(uniqueAttempts, { message: 'follow-up attempts must be unique' }),
      )
      .default({}),
  })
  .strict();

export type PactPairFollowUpScriptV1 = z.infer<typeof pactPairFollowUpScriptV1Schema>;

const scriptUrl = new URL(
  `../../../${PACT_PAIR_FOLLOWUP_SCRIPT_FILE_V1}`,
  import.meta.url,
);
const scriptBytes = readFileSync(fileURLToPath(scriptUrl), 'utf8');
const SCRIPT: PactPairFollowUpScriptV1 = pactPairFollowUpScriptV1Schema.parse(
  JSON.parse(scriptBytes),
);
const SCRIPT_SHA256 = createHash('sha256').update(scriptBytes, 'utf8').digest('hex');

export type PactPairFollowUpProvenanceV1 = {
  id: string;
  version: number;
  file: string;
  sha256: string;
};

/** Provenance block recorded in run.json when the protocol is enabled. */
export function getPactPairFollowUpProvenanceV1(): PactPairFollowUpProvenanceV1 {
  return {
    id: SCRIPT.id,
    version: SCRIPT.version,
    file: PACT_PAIR_FOLLOWUP_SCRIPT_FILE_V1,
    sha256: SCRIPT_SHA256,
  };
}

/**
 * The scripted requester follow-up for one attempt (2-based). Per-task
 * overrides win over the default templates; a missing entry is a hard error
 * so a config asking for more attempts than the script covers fails loudly
 * instead of silently repeating an ask.
 */
export function buildPactPairFollowUpMessageV1(options: {
  task: PactTaskIntroV1;
  attempt: number;
}): string {
  const entries = SCRIPT.taskOverrides[options.task.taskId] ?? SCRIPT.followUps;
  const entry = entries.find(candidate => candidate.attempt === options.attempt)
    ?? SCRIPT.followUps.find(candidate => candidate.attempt === options.attempt);
  if (!entry) {
    throw new Error(
      `Follow-up script ${SCRIPT.id} has no template for attempt ${options.attempt}`,
    );
  }
  return entry.template
    .split('{{prompt}}')
    .join(options.task.prompt)
    .slice(0, MAX_FOLLOWUP_MESSAGE_CHARS_V1);
}

/**
 * Whether a completed attempt triggers another one. Only responder-authored
 * terminal refusals/escalations are retry-eligible; `terminalReceived` must
 * be the engine's flag that the decision came from the harness rather than
 * being synthesized by the runner (budget exhaustion, runner errors, kernel
 * denial), so those outcomes never retry.
 */
export function pactPairRetryEligibleV1(
  decision: PactPairTerminalDecisionV1,
  terminalReceived: boolean,
): boolean {
  return terminalReceived
    && (decision.type === 'refuse' || decision.type === 'escalate');
}
