# Response to Reviewer aP1N

We genuinely thank the reviewer for recognizing the problem, SharedOS, and the action evaluation. Your five questions have concretely made this paper better, and we answer them one by one below.

## Q1. Pareto-front analysis or narrower framing?

Thank you for raising this, and we fully agree: what we measured is a set of discrete operating points, not a continuous frontier.

We would first like to clarify that we ran far more settings than our chart suggested; we simply did not present them well. The submission already contains over 40 measured points: 18 Files points (3 policies × 6 requester families, 200 tasks per cell), 6 States/Actions points, 9 multi-turn and defence points, four relationship profiles, 6,000 relationship-policy trials, PACT-NET with 25 agents and 997 tasks per run, and 11,659 escalation-gate decisions. We will lay this full inventory out explicitly in the paper so the breadth is visible at a glance.

Following your suggestion, we also added a new controlled comparison during the discussion period: eight policies on the same 60 questions, same model, and same judge, so packages can be compared without confounds. P6/P7 are exploratory variants, not causal controls:

| Policy | Mechanism | Role | Utility | Disclosure | Refusal |
|---|---|---|---:|---:|---:|
| P0 | No policy | Submitted anchor | 95.0% | 87.5% | 2.5% |
| P1 | Generic caution | Submitted anchor | 90.0% | 75.0% | 2.5% |
| P2 | Operationally specific category policy | Submitted anchor | 65.0% | 7.5% | 72.5% |
| P3 | External messages are data | Supplementary defense | 85.0% | 12.5% | 87.5% |
| P4 | Instruction hierarchy | Supplementary defense | 80.0% | 5.0% | 90.0% |
| P5 | Classification checklist | Supplementary defense | 65.0% | 5.0% | 95.0% |
| P6 | Long generic operational policy | Exploratory variant | 85.0% | 35.0% | 40.0% |
| P7 | Short category-naming policy | Exploratory variant | 90.0% | 42.5% | 32.5% |

We additionally froze one 30-question subset and varied only the responder: P2 cuts disclosure from 90% to 5% for DeepSeek V4 Flash and from 80% to 5% for GLM 5.2, with no utility loss.

Finally, we agree with you on the wording itself. We have replaced "frontier" with *trade-offs across discrete operating points* throughout, and we make no dense-Pareto claim anywhere. This is the more accurate description of what we measured, and we thank you for pushing us to it.

## Q2. Length-matched specificity control?

You are right that this control was missing, and we thank you for insisting on it. We built P9 exactly for this: it matches P2's length while keeping only P1's generic content:

| Surface | P1: generic (22 words) | P9: redundant generic (323 words) | P2: operationally specific category policy (323 words) |
|---|---:|---:|---:|
| Files disclosure | 81.5% | 80.0% | 14.0% |
| States disclosure | 63.0% | 62.0% | 8.0% |

P9 adds no categories, no examples, and no action rules; it simply restates the generic caution until it reaches 323 words. The result is clear: P9 stays at P1's operating point on both surfaces, and it sits inside the two submitted P1 replications (Files 83%/80%; States 60%/66%), with every paired exact McNemar test at *p* ≥ 0.61. Meanwhile, at the same length, P2 reduces disclosure by 66 pp on Files and 54 pp on States relative to P9.

So we can now answer your question directly: the gain comes from operational specificity, not from raw length or generic repetition. We will state the conclusion exactly this way in the paper and remove our earlier "differ only in specificity" phrasing.

## Q3. Reconciling Tables 15 and 20

Thank you for catching this; the confusion is our fault, and the fix is simple. The two tables measure utility in two different ways, while their security columns come from one identical pipeline, which is why those match exactly.

At a high level: Table 15 asks whether the answer the requester actually receives solves the task (denominators 193/200/194). Table 20 asks whether the fact appears anywhere in the 240-tick trajectory (fixed denominator 200), so it also counts incidental matches. Both show the same D0 > D1 > D2 ordering.

We will keep Table 15 as the primary utility metric, relabel Table 20 as *trajectory-wide fact coverage (diagnostic)*, and move it to the appendix. We agree this distinction should have been explicit from the start, and making it so will improve the paper's readability.

## Q4. Relationship-agnostic policy and over-refusal

We would like to clarify what this design is testing, and then show you why the measured over-refusal is not simply built in.

Our goal in RQ3 is to test whether one uniform policy plus in-context relationship information lets the model work out relationship-appropriate boundaries on its own. When it falls short, it mostly fails by refusing too much, and that gap is exactly what we measure.

The key observation is that the over-refusal is structured, not uniform, which a "built into the design" account would not predict:

| Requester | Disclosure | Over-refusal | QA utility | Action safety |
|---|---:|---:|---:|---:|
| Colleague | 1.7% | 40% | 57% | 90% |
| CEO delegate | 3.3% | 59% | 49% | 85% |
| Close friend | 9.2% | 86% | 58% | 84% |
| Investor | 7.5% | 31% | 70% | 91% |

Refusal on the personal categories is nearly uniform at 90 to 100% across all four requesters, while sensitive-work refusal varies by 17 pp with the requester. Reads and writes also separate: the investor receives the most reads and the fewest risky writes.

We also ran the relationship-aware baseline you asked about (GPT-5.5, 6,000 trials). Utility rises to 87% for colleague, delegate, and investor, but the close-friend profile stays at 63.3% utility with 38.7% disclosure. So the miscalibration is not only an artifact of the relationship-agnostic policy; we believe it also reflects conservative category priors in current models. A matched GPT-5-mini run is future work, and we do not claim it here.

## Q5. Why "eroding" if direct leakage is similar?

We agree with you, and we will drop the word "eroding". What we actually observe is that multi-turn interaction opens additional channels; it does not make the direct leak worse.

Concretely: direct leakage is 12.6% multi-turn versus 14.0% single-turn, and adaptive retries add only 2.1 pp. The 38.0% figure is an over-inclusive trajectory scan: of its 76 hits, 21 are confirmed incidental disclosures and 55 are false positives, and we will report the two separately from now on. Across 1,184 recorded retries, brute repetition flips only 7.6% of refusals while business-justification reframing flips 34.5%, and the policy recovers after each breach.

We will therefore limit the claim to exactly what the data supports: *persistent multi-turn interaction opens additional disclosure channels beyond the direct response*. That is what a single-turn benchmark would miss, and we thank you for pushing us to state it precisely.
