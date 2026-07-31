# Response to Reviewer TtBh

We sincerely thank the reviewer for the expert, access-control-informed review. The three main requests are exactly the right tests, and we ran them.

## Q1. Validation of relationship-conditioned labels

The independent annotation is complete, and we report it in full, including where annotators disagree with our own labels.

1) Five non-author annotators re-labelled all three tracks (1,095 items each), blinded to model outputs and to each other:

| Track | ≥4 of 5 agree | κ |
|---|---:|---:|
| QA share/protect | 86.5% | 0.654 |
| Relationship P/L/B | 85.7% | 0.501 |
| Action verdicts | 83.5% | 0.491 |

2) The action κ falls below our 0.6 bar and we say so plainly. The shortfall is structural: annotators deviate from the gold in three opposite directions, which indicates underspecified boundaries. We release the identified guideline gaps with the data. Excluding one pre-registered outlier annotator gives 0.745 / 0.623 / 0.582.

3) In 100 cells the annotator majority disagrees with our gold, with two patterns: 16 sensitive-work items read as shareable, and 16 close-friend borderline items upgraded to legitimate. We froze the gold rather than editing it after the votes; these cells ship as adjudication records.

4) Framing: the labels are *scenario contracts*, explicit authorization stipulations for one concrete scenario, not claims about universal social norms; the revision says so in Limitations. 70 of 99 sensitive items change label across requesters, and the close-friend and investor profiles differ on 55, which is why a scalar-trust reading fails.

## Q2. Cleaner policy-specificity ablation

Agreed, and we thank the reviewer; we ran exactly this ablation (full table in aP1N Q2).

1) A length-matched redundant-generic control (P9, 323 words) stays at the 22-word P1's disclosure (80.0% vs 81.5% Files; 62.0% vs 63.0% States), while the equally long P2 reaches 14.0% and 8.0%. So operational specificity, not raw length, explains the gain; the "differ only in specificity" phrase is removed from the paper.

2) On schema overlap: the category-names-only control (P7) still cuts disclosure from 75.0% to 42.5% with no examples or action rules, so naming the categories helps in itself, though far short of the full package's 7.5%.

## Q3. Structural (non-ML) baseline

Following the request, we ran relationship-conditioned data mounting and report the trade-off it exposes.

1) Mounts are enforced pre-retrieval; unmounted content never reaches the model:

| Notes condition | Utility | Disclosure |
|---|---:|---:|
| Rel-Policy | 78.9% | 12.9% |
| Mounted access | 64.2% | 9.0% |
| Rel-Policy + Mounted | 65.2% | 5.6% |

2) Structure works where it applies (disclosure halves) but is container-level while entitlements are item-level: the same item is legitimate for the investor and protected from the friend on 55 of 99 items. The utility drop is the price of that coarseness. Structure helps most exactly where policy fails: the close-friend profile improves from 38.7% to 18.1% disclosure when mounting is added.

3) So the measured relationship is complementarity, not replacement. We also tested a pre-tool escalation gate (11,659 decisions; JD3a Q4). We do not claim a complete RBAC/ABAC engine; field-level redaction and role hierarchies are future work.

## Q4. "Frontier" terminology

We framed Frontier to assess how different combinations of models and policies would trade off at security vs utility. We agree and adopt the conservative wording (*trade-offs across discrete operating points*) throughout, while reporting the full point inventory (aP1N Q1). No dense-Pareto claim remains.

## Q5. Evaluator robustness for States QA and multi-turn

Added on three levels.

1) Judge-free gold-string scoring reproduces every headline direction (States 47.5% → 6.5%).

2) A different-family judge re-scored both single-step surfaces: Files 98.3% agreement over 1,058 items, States 91.6% over 1,030 (JD3a Q1). Multi-turn re-scoring is not done, and we do not claim it.

3) The human audit is grounded in the returned independent annotations: all 458 non-unanimous items carry an adjudication column, and the 100 majority-vs-gold cells ship as records (Q1).

## Presentation and limitations

We especially appreciate the concrete feedback on Figure 1; the redraw enlarges the text and shows one explicit cross-boundary path with the enforcement layers separated. The revision also states that the labels are independently audited scenario contracts and that "governance" here means the four tested layers: prompt policy, mounted reachability, contact ACLs, and pre-tool escalation. We hope the added experiments and scoped claims address the concerns, and we welcome further discussion.
