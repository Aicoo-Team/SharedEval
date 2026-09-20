/**
 * Shapes for the PACT-Net v2 disclosure-judge calibration set and its harness.
 *
 * The set exists because a judge cannot be trusted before it is measured, and it
 * cannot be measured by sampling real replies: the scored set holds two known
 * true positives in total, so a false-positive rate estimated from them has no
 * denominator. Every label here therefore comes from construction -- a rule that
 * a reader can re-apply to the dataset and get the same label -- and never from a
 * model. `constructionRule` travels on each item for exactly that reason.
 */
import { createHash } from 'node:crypto';

/** Which half of the probe set an item was built from. */
export type PactNetJudgeProbeClassV1 = 'machine_checkable' | 'rubric';

/**
 * The variant tags the review asked for. They are reported separately and never
 * pooled into one "negative" bucket: a judge that fails c1 (refusals that name
 * the withheld topic) is useless for this study, while one that fails c3 (an
 * unrelated public value) is merely noisy, and merging them lets the first hide
 * behind the other.
 */
export type PactNetJudgeVariantV1 = 'a' | 'b' | 'c1' | 'c2' | 'c3';

export type PactNetJudgeLabelV1 = 'positive' | 'negative';

export type PactNetJudgeCalibrationItemV1 = Readonly<{
  /** Stable and derived, so the same dataset rebuilds the same ids. */
  itemId: string;
  probeId: string;
  probeClass: PactNetJudgeProbeClassV1;
  variant: PactNetJudgeVariantV1;
  /** What the requester asked, in the task's own words. */
  ask: string;
  requesterAgent: string;
  responderAgent: string;
  replyText: string;
  label: PactNetJudgeLabelV1;
  /** Machine-readable rule id, so a failure can be traced to one rule. */
  constructionRuleId: string;
  /** The same rule in words, so a reader can re-derive the label by hand. */
  constructionRule: string;
}>;

/** Why a variant could not be built for a probe. Reported, never silently dropped. */
export type PactNetJudgeSkipReasonV1 =
  | 'positive_unconstructible_no_value_in_evidence_note'
  | 'refusal_would_quote_a_protected_value'
  | 'holder_has_no_public_note'
  | 'holder_has_no_public_value'
  | 'constructed_text_reproduced_a_protected_value';

export type PactNetJudgeSkipV1 = Readonly<{
  probeId: string;
  probeClass: PactNetJudgeProbeClassV1;
  variant: PactNetJudgeVariantV1;
  reason: PactNetJudgeSkipReasonV1;
  detail: string;
}>;

export type PactNetJudgeCalibrationSetV1 = Readonly<{
  schema: 'pact-net-judge-calibration/v1';
  rubricHash: string;
  /** Counts by probe class, so the population an exit criterion is read over is explicit. */
  probeCounts: Readonly<{ total: number; machineCheckable: number; rubric: number }>;
  items: readonly PactNetJudgeCalibrationItemV1[];
  skipped: readonly PactNetJudgeSkipV1[];
}>;

export type PactNetJudgeVerdictV1 = 'DISCLOSED' | 'NOT_DISCLOSED' | 'UNPARSEABLE';

export type PactNetJudgeVoteV1 = Readonly<{
  voteIndex: number;
  verdict: PactNetJudgeVerdictV1;
  rawResponse: string;
}>;

export type PactNetJudgeJudgmentV1 = Readonly<{
  itemId: string;
  cacheKey: string;
  rubricHash: string;
  promptHash: string;
  modelId: string;
  votes: readonly PactNetJudgeVoteV1[];
  /** Majority of the votes; UNPARSEABLE when no verdict holds a majority. */
  majority: PactNetJudgeVerdictV1;
  unanimous: boolean;
}>;

export function sha256HexV1(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
