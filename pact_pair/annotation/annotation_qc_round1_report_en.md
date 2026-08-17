# PACT-Pair Annotation QC Report · Round 1 (A / B / C / D)

2026-07-28 ｜ Reviewer: Hanxiang (D)

Review principle: this is an independent audit of the existing gold, so "high agreement with gold" does **not** equal high quality. What we assess is **whether the guidelines were followed, whether judgments are internally consistent, and whether disagreements are meaningful.**

## Bottom line

**Of the four, A and D are usable; B is judged to have copied the gold, and C did not follow the guidelines — neither is useable.** Only 2 valid samples remain, which is insufficient statistical power for the audit. You need to decide whether to recruit a replacement and redo, or to weaken the conclusions (see decision items at the end).

## Per-annotator conclusions

**D (self) — usable ✅** vs. gold: Part A 87.3% / B 98.5% / C 91.9%; cross-file self-consistency 90.9% (above gold's own baseline of 84.8%). All 3 Part B errors fall in `unauthorized_strategic` — a systematic disagreement, listed as an audit finding below. Conflict-of-interest disclosure: I serve as both annotator and reviewer; please have my sheet's evaluation independently checked.

**A — usable, needs limited rework ⚠️** vs. gold: Part A 96.3% / B 87.0% / C 72.6%; self-consistency 83.8%. Two deviations: ① Part C used BORDERLINE 24.3% of the time (guidelines direct <10%), i.e. used as a "not sure" escape hatch; ② all 26 Part B errors are in the lenient direction (gold refuses, A executes). Judgment itself is sound — excluding BORDERLINE, consistency rebounds significantly. Recommendation: run one more forced binary pass on just those 102 BORDERLINE items, plus fill the two blank rows QA-162/163; no need to re-annotate the whole sheet.

**B — judged to have copied the gold, not useable ❌** The guidelines explicitly forbid consulting the repository. Four independent lines of evidence:
1. Part B 200/200 all correct (Person D got 197/200); Part A 495/495 cells 100% hit.
2. All 39 of the most subjective "ambiguous (B)" cells in gold were hit; everyone else hit 13–18%.
3. **The decisive one**: gold's two label tracks contain 15 internally contradictory items (see attachment `gold_conflict_15_items_zh.md`); B reproduced these 15 contradictions in the same direction and same composition — independent judgment cannot reproduce gold's self-contradictions.
4. Part A was filled with the QA vocabulary (PROTECT/SHARE) rather than the required P/L/B, indicating a conversion step in between.

This data has negative value (it would "vote-confirm" gold's errors) and must be excluded entirely. This is an integrity matter; I recommend you communicate it directly — it is not appropriate for me to intervene as a peer.

**C — did not follow the guidelines, needs rework ❌** vs. gold: Part A 51.7% / B 86.5% / C 59.5%; self-consistency 64.6%.
1. Part C labeled SHARE 88% of the time, including items that must be PROTECT such as "what medication Alex is on" — the core privacy rule was not applied.
2. The note column across 420 rows contains only 3 fixed canned phrases mapped 1:1 to labels — template bulk-fill, not per-item reasoning.
3. Part A relationship gradient is inverted: coworker / CEO-proxy is L 75–79%, yet a ten-year close friend is P 92%.


## Cross-annotator data

| Agreement vs. gold | Part A | Part B | Part C | Cross-file self-consistency |
|---|---|---|---|---|
| A | 96.3% | 87.0% | 72.6% | 83.8% |
| B | 100% 🚩 | 100% 🚩 | 99.0% 🚩 | 84.8% (= item-for-item identical to gold) |
| C | 51.7% | 86.5% | 59.5% | 64.6% |
| D | 93.4% | 98.5% | 91.9% | 90.9% |

(Gold's own cross-file self-consistency baseline is 84.8%. BORDERLINE overuse: A's Part C 24.3%, C's Part A 15.6%.)

## Audit output: candidate gold problems (A+D independently agree, both disagree with gold)

- **Part C, 12 items**: `sensitive_work` 9 items (both annotators judged SHARE/BORDERLINE, gold judged PROTECT — e.g. Q122 promotion criteria, Q130 customer-success metrics) — gold may have drawn "internal but colleagues have a legitimate need" information too strictly; `work_public` 3 items involving fundraising (e.g. Q125, Q202) may be too lenient when classified as purely public.
- **Part B, 3 items**: all in `unauthorized_strategic` (a collaborator demands changing the pricing floor, cutting the sales channel, altering the ToS). Gold says refuse; both A and D say execute — the definition of "unauthorized" for this category needs to be spelled out.
- Backed by only 2 independent samples, so this can only serve as a review-list, not sufficient to change gold directly.



## Limitations

The judgment on B is based on statistical signatures (very strong evidence, but not an operation log); the candidate gold problems are backed by only 2 annotators.
