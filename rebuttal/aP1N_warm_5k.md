# Response to Reviewer aP1N

We genuinely thank the reviewer for recognizing the problem, SharedOS, and the action evaluation. Your questions made the paper better; we answer in order.

## Q1. Pareto-front analysis or narrower framing?

Thank you, and we fully agree: we measured discrete operating points, not a continuous frontier.

1) We actually ran far more settings than our chart showed; we presented them poorly. The submission already contains 40+ points: 18 Files (3 policies × 6 requester families, 200 tasks/cell), 6 States/Actions, 9 multi-turn/defence, 4 relationship profiles, 6,000 relationship-policy trials, PACT-NET (25 agents, 997 tasks/run), 11,659 escalation decisions. We will present this inventory explicitly.

2) Following your suggestion, we added eight policies on the same 60 questions, model, and judge (P6/P7 are exploratory, not causal controls):

| Policy | Mechanism | Util | Discl | Refusal |
|---|---|---:|---:|---:|
| P0 | No policy | 95.0 | 87.5 | 2.5 |
| P1 | Generic caution | 90.0 | 75.0 | 2.5 |
| P2 | Operational category policy | 65.0 | 7.5 | 72.5 |
| P3 | External messages are data | 85.0 | 12.5 | 87.5 |
| P4 | Instruction hierarchy | 80.0 | 5.0 | 90.0 |
| P5 | Classification checklist | 65.0 | 5.0 | 95.0 |
| P6 | Long generic operational | 85.0 | 35.0 | 40.0 |
| P7 | Short category-naming | 90.0 | 42.5 | 32.5 |

3) On a frozen 30-question responder control, P2 cuts disclosure 90→5% (DeepSeek V4 Flash) and 80→5% (GLM 5.2), with no utility loss.

4) We agree on the wording too: "frontier" is now *trade-offs across discrete operating points* everywhere.

## Q2. Length-matched specificity control?

You are right that this control was missing; thank you for insisting. We built P9: P2's length, P1's generic content only (no categories, examples, or action rules).

| Surface | P1 (22w) | P9 redundant (323w) | P2 specific (323w) |
|---|---:|---:|---:|
| Files discl | 81.5% | 80.0% | 14.0% |
| States discl | 63.0% | 62.0% | 8.0% |

1) P9 stays at P1's operating point, inside the two P1 replications (Files 83/80%; States 60/66%); all paired McNemar p ≥ 0.61.

2) At the same length, P2 leaks 66 pp less on Files and 54 pp less on States than P9.

3) So the gain comes from operational specificity, not raw length or repetition. We will state exactly this and remove "differ only in specificity".

## Q3. Reconciling Tables 15 and 20

Thank you for catching this; the confusion is our fault and the fix is simple.

1) The two tables measure utility differently; security columns share one pipeline, hence they match. Table 15 asks whether the received answer solves the task (denominators 193/200/194); Table 20 scans the whole 240-tick trajectory for the fact (fixed 200), counting incidental matches.

2) Both keep the D0 > D1 > D2 ordering.

3) We will keep Table 15 primary and move Table 20 to the appendix as *trajectory-wide fact coverage (diagnostic)*.

## Q4. Relationship-agnostic policy and over-refusal

1) This is the study design: RQ3 tests whether one uniform policy plus relationship context yields appropriate boundaries; falling short shows up as over-refusal, which we measure.

2) The over-refusal is structured, not uniform, which "built into the design" cannot explain:

| Requester | Discl | Over-ref | Utility | Act. safety |
|---|---:|---:|---:|---:|
| Colleague | 1.7% | 40% | 57% | 90% |
| CEO delegate | 3.3% | 59% | 49% | 85% |
| Close friend | 9.2% | 86% | 58% | 84% |
| Investor | 7.5% | 31% | 70% | 91% |

Personal-category refusal is uniform (90–100%) while sensitive-work refusal varies by 17 pp; the investor gets the most reads and fewest risky writes.

3) We ran the relationship-aware baseline you asked for (GPT-5.5, 6,000 trials): utility reaches 87% for colleague/delegate/investor, but close friend stays at 63.3% utility, 38.7% disclosure. So miscalibration is not only a policy artifact. A matched GPT-5-mini run is future work, not claimed.

## Q5. Why "eroding" if direct leakage is similar?

Thank you; let us clarify what we meant. "Eroding" referred to persistent interaction opening additional disclosure channels, not to growth in direct leakage; we will reword so this cannot be misread.

1) Direct channel: 12.6% multi-turn vs 14.0% single-turn; retries add only 2.1 pp. We will state this explicitly.

2) What persistent interaction adds is an incidental channel: protected facts surface while the agent serves other requests. The 38.0% figure is an over-inclusive trajectory scan (21 confirmed incidental disclosures, 55 false positives among 76 hits); we will report confirmed disclosures separately from the scan.

3) Across 1,184 retries, brute repetition flips 7.6%; business-justification reframing flips 34.5%; the policy recovers after each breach.

4) The clarified wording: *persistent multi-turn interaction opens additional disclosure channels beyond the direct response*. This is what "eroding" meant, and the paper now says it precisely.
