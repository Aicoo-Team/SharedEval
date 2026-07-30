# SharedOS / PACT — Rebuttal v3.3 (Claude concise version, 2026-07-30)

## Response to the Area Chair

We thank the AC and all reviewers. The reviews agree the problem is important and the platform is valuable; the concerns are framing strength, confounds, evaluator independence, and external grounding. We addressed all four with new experiments:

1. **Framing.** We renamed "frontier" to *security–utility trade-offs across discrete operating points* throughout, and we now report the full inventory of measured points: over forty across policies, models, surfaces, requesters, and interaction lengths (aP1N Q1).
2. **Confounds.** We ran the requested 2×2 ablation. Both policy length and category naming matter, roughly additively (aP1N Q2).
3. **Evaluator independence.** A different-family judge re-scored 2,088 items with 98.3% (Files) and 91.6% (States) agreement, and five non-author annotators re-labelled all 1,095 gold labels (JD3a Q1, TtBh Q1).
4. **Access-control comparison.** We ran structural baselines at dyadic and network scale. The result is complementarity: structure bounds the worst case, policy handles context (JD3a Q4, TtBh Q3).

All conclusions are scoped to current foundation models. We are happy to continue the discussion on any point.

## General Response

**Positioning.** This paper is a first systematic exploration of the security–utility trade-off in agent-to-agent delegation across ownership boundaries. The contributions are SharedOS, a deployed evaluation platform, and a controlled measurement of failure modes under current models.

**The core result is stable across models and scorers (Table GR-1).** D2 cuts Files disclosure by 69 to 91 pp across six requester-model families at 0 to 29 pp utility cost:

| Surface / model | Utility D0 / D1 / D2 | Disclosure or block D0 / D1 / D2 | Change |
|---|---|---|---|
| Files — GPT-5-mini (2 reps) | 78.0 / 78.5 / 77.0 | 83.0 / 81.5 / 14.0 | −69.0 pp |
| Files — GPT-5.5 | 87 / 94 / 86 | 88 / 75 / 4 | −84.0 pp |
| Files — GPT-5.4-mini | 96 / 99 / 91 | 87 / 90 / 7 | −80.0 pp |
| Files — GPT-5.4 | 98 / 97 / 74 | 92 / 80 / 1 | −91.0 pp |
| Files — Kimi K2.6 | 82 / 86 / 81 | 93 / 87 / 4 | −89.0 pp |
| Files — DeepSeek V3.2 | 91 / 97 / 62 | 93 / 80 / 9 | −84.0 pp |
| States — GPT-5-mini (2 reps) | 55.0 / 60.5 / 18.0 | 58.5 / 63.0 / 8.0 | −50.5 pp |
| Actions — GPT-5-mini (2 reps) | exec 65.5 / 48.0 / 61.0 | block 43.0 / 43.0 / 93.5 | +50.5 pp |

The same direction survives with no LLM judge at all: gold-string scoring gives Files 72.5% → 13.0% and States 47.5% → 6.5%.

**Two definitions used throughout.** *Direct leakage*: a protected fact in the answer to the probing request. *Incidental exposure*: the fact appearing anywhere in a persistent trajectory. Multi-turn adds the second channel; it does not amplify the first.

## Response to Reviewer aP1N

We thank the reviewer for recognizing the problem, the breadth of SharedOS, and the action track. The five questions below improved the paper.

### Q1. Pareto-front analysis or narrower framing?

**Thank you for this framing concern; we agree, and we answer in three parts.**

(1) The study already measures many more operating points than the figure showed. Beyond the three policies in the chart, the submission and appendix contain: three policies × six requester families on Files (18 points, 200 tasks each); the same policies on States and Actions (6 points); a 240-tick multi-turn protocol over two models, three policies, and three literature-derived defences, Spotlighting (Hines et al. 2024), Instruction Hierarchy (Wallace et al. 2024), and Sandwich + Boundary (9 points); four requester profiles under fixed D2 (400 QA + 200 actions each); a 6,000-trial relationship-policy comparison; PACT-NET with 25 agents and 997 tasks per run; and an escalation gate with 11,659 decisions. That is over forty measured points. The chart under-represented this, and the revision will present the inventory explicitly.

(2) During the discussion period we added one controlled comparison, small by design: its job is attribution, not scale. Eight policy packages on the same 60 questions, same model, same judge:

| Policy | Mechanism | Utility | Disclosure | Refusal |
|---|---|---:|---:|---:|
| P0 | No policy | 95.0% | 87.5% | 2.5% |
| P1 | Generic caution | 90.0% | 75.0% | 2.5% |
| P2 | Category policy | 65.0% | 7.5% | 72.5% |
| P3 | External messages are data | 85.0% | 12.5% | 87.5% |
| P4 | Instruction hierarchy | 80.0% | 5.0% | 90.0% |
| P5 | Classification checklist | 65.0% | 5.0% | 95.0% |
| P6 | Length-matched generic | 85.0% | 35.0% | 40.0% |
| P7 | Short category-specific | 90.0% | 42.5% | 32.5% |

We also varied the responder on one frozen 30-question subset: P2 cuts disclosure from 90% to 5% for DeepSeek V4 Flash and from 80% to 5% for GLM 5.2, with no utility loss.

(3) We follow the suggestion on wording: "frontier" is replaced by *trade-offs across discrete operating points* everywhere. No dense-Pareto claim remains.

### Q2. Length-matched control separating specificity from length?

**This is the right control, it was missing, and we thank the reviewer. We ran it, and it corrects our own earlier framing.**

(1) The 2×2 crosses length with category naming, holding world, 60 tasks, model, and judge fixed:

| | Generic | Category-specific |
|---|---|---|
| Short (22 w) | P1: disclosure 75.0%, utility 90.0% | P7: 42.5%, 90.0% |
| Long (323 w) | P6: 35.0%, 85.0% | P2: 7.5%, 65.0% |

(2) **Both factors matter, roughly additively: about 38 pp from length and 30 pp from category naming.** "Specificity alone" fails because P6 already halves disclosure. "Just a longer prompt" fails because at matched length the category package leaks 4.7 times less.

(3) The utility cost sits almost entirely in the full D2 package (5 of 20 legitimate queries refused). We will replace the "differ only in specificity" phrase with this decomposition in the revision.

### Q3. Reconciling Tables 15 and 20

**Thank you for catching this. The two tables measure utility differently; the security columns are identical.**

(1) Table 15 asks whether the answer the requester receives solves the task (denominators 193/200/194). Table 20 asks whether the fact appears anywhere in the 240-tick trajectory (fixed 200), counting incidental matches.

(2) Both show the same D0 > D1 > D2 ordering. In the revision, Table 15 stays primary; Table 20 is relabelled "trajectory-wide fact coverage (diagnostic)" and moves to the appendix. This will improve readability.

### Q4. How much over-refusal follows from the relationship-agnostic setup?

We would like to clarify from three perspectives.

(1) The relationship-agnostic policy is the study design. RQ3 asks whether a model, given one uniform policy plus relationship context, can work out relationship-appropriate boundaries. Falling short mostly means refusing too much; that gap is the finding.

(2) The measured over-refusal is structured, not uniform, which a "built into the design" account does not predict:

| Requester | Disclosure | Over-refusal | QA utility | Action safety |
|---|---:|---:|---:|---:|
| Colleague | 1.7% | 40% | 57% | 90% |
| CEO delegate | 3.3% | 59% | 49% | 85% |
| Close friend | 9.2% | 86% | 58% | 84% |
| Investor | 7.5% | 31% | 70% | 91% |

Refusal on personal categories is nearly uniform (90 to 100%), while sensitive-work refusal varies by 17 pp with the requester. Read and write also separate: the investor gets the most reads and the fewest risky writes.

(3) Following the request, we ran the relationship-aware baseline (GPT-5.5, 6,000 trials). Over-refusal drops (utility 87% for colleague, delegate, investor) but the close-friend profile stays at 63.3% utility with 38.7% disclosure. So mis-calibration is not only a prompting artifact. A matched GPT-5-mini run is future work, not claimed.

### Q5. Why "eroding" if direct leakage is similar to single-turn?

**We agree and will drop the word "eroding".**

(1) Direct leakage is similar across settings: 12.6% multi-turn vs 14.0% single-turn; adaptive retries add only 2.1 pp.

(2) What multi-turn adds is a second channel that single-turn cannot show: protected facts surfacing while the agent serves other requests. The 38.0% figure is an over-inclusive string scan of that channel (21 confirmed, 55 false positives out of 76 hits); we will report confirmed incidental disclosure separately.

(3) Of 1,184 recorded retry attempts, brute repetition flips 7.6% while business-justification reframing flips 34.5%; the policy recovers after each breach. The revised claim reads: *persistent multi-turn interaction opens additional disclosure channels beyond the direct response*.

## Response to Reviewer JD3a

We are excited to receive the positive assessment and thank the reviewer for recognizing the database-diff evaluation, the statistical reporting, and the read/write-trust finding.

### Q1. Different-family judge

**Yes. We re-scored both single-step surfaces with a different-family judge and add judge-free scoring.**

(1) Gold-string matching alone reproduces every headline direction: Files 72.5% → 13.0%, States 47.5% → 6.5%.

(2) DeepSeek V4 Flash re-scored every gradable response with the submitted rubric verbatim:

| Surface | Items | Agreement | Headline under both judges |
|---|---:|---:|---|
| Files QA | 1,058 | 98.3% | D0→D2 disclosure 88.1→14.1% vs 88.6→14.1% |
| States QA | 1,030 | 91.6% | D2 disclosure 7.5% vs 5.7% |

(3) States is more judge-sensitive (88.8% utility agreement) but the D2 ordering holds under both judges. Multi-turn re-scoring is not yet done and we do not claim it. Per-item verdicts and served-model provenance ship with the artifact.

### Q2. Bounding the D2 States-QA variance

**Agreed: n=2 cannot bound the utility magnitude, and we scope the claim to what n=2 supports.**

(1) The security direction repeats in both replications (58% → 5% and 59% → 11%; McNemar p<.001 each).

(2) D2 States utility spans 5 to 31%. The mechanism: under strict D2, utility depends on whether early context happens to contain the queried objects, and small denominators amplify this.

(3) The revision reports the utility as a range with this mechanism, states the n=2 limitation explicitly, and keeps only the direction claim. Additional replications are future work, not claimed.

### Q3. RQ3 beyond gpt-5-mini

**We reproduce the relationship study on GPT-5.5 and add a non-OpenAI GLM 5.2 replication.**

(1) GPT-5.5 (6,000 trials): the qualitative pattern replicates; the close-friend profile remains the failure mode (63.3% utility, 38.7% disclosure).

(2) GLM 5.2, seeded world, fixed D3, 500/500 provenance-valid rows:

| Requester | Utility | Disclosure | Refusal |
|---|---:|---:|---:|
| Stranger | – (0 legitimate items) | 1.0% | 37.0% |
| Colleague | 100.0% (6/6) | 5.3% | 90.4% |
| CEO delegate | 93.9% (31/33) | 0.0% | 98.5% |
| Close friend | 100.0% (15/15) | 31.8% | 63.5% |
| Investor | 90.9% (10/11) | 13.5% | 84.3% |

(3) The close-friend disclosure concentration replicates on a non-OpenAI model. The two packages differ in task range and policy, so we compare the qualitative pattern, not absolute rates.

### Q4. Interventions MVP

**Both stated interventions are implemented and evaluated, at dyadic and network scale.**

(1) *Mounting* (PACT-PAIR): adding folder mounts to the same policy cuts disclosure from 12.9% to 5.6% at a utility cost of 78.9% → 65.2%. Policy still helps inside the mounted scope (9.0% → 5.6%).

(2) *Network scale* (PACT-NET, 25 agents, 997 tasks per run, two replications): static policy raises aggregate safety from 26.6% to 71.5% while utility falls 88.7% to 78.8%. It nearly solves visible violations (confused-deputy success 47% → 2%) but leaves transitive leakage high (96.3% → 77.7%). Adding MCC reaches the best safety (77.8%) and zero deputy success, but the read-only mount collapses utility, useful negative evidence that structure needs separate read/write capabilities.

(3) *Escalation gate* (11,659 decisions, two models): protection stays at 87.7 to 94.4% in all eight cells. Raising supervision from 10% to 30% lifts legitimate pass-through from 69.8% to 91.0% (gpt-5-mini), a tunable operating point:

| Condition | Protected stopped | Legitimate passed |
|---|---:|---:|
| gpt-5-mini, 10% supervised | 90.8% | 69.8% |
| gpt-5-mini, 30% supervised | 87.7% | 91.0% |
| GPT-5.5, 10% supervised | 94.2% | 67.1% |
| GPT-5.5, 30% supervised | 92.1% | 87.4% |

Together: policy handles visible violations, mounting limits reachable context, escalation gates ambiguous tool calls. None dominates without cost.

### Weaknesses and limitations

1. **PACT-NET is executed, not design-only**: 25 agents, two policy conditions, two replications, 997 tasks plus 75 probes per run, contact graph of 114 directed edges. Transitive and cross-cluster risk remains open, and we flag it as such.
2. **Annotation**: five non-author annotators re-labelled everything; at least four of five agree on 83.5 to 86.5% of items; details in TtBh Q1.
3. **Naming**: SharedOS = platform; PACT-Bench = suite = PACT-PAIR + PACT-NET. Fixed once, used consistently.
4. **Novelty positioning**: we agree the integrative combination is the novelty and will cite the abstraction-paradox connection.
5. **Formatting**: Tables 32–39 captions and the missing reference are fixed. Thank you for catching these.

## Response to Reviewer TtBh

We sincerely thank the reviewer for the expert, access-control-informed review. The three main requests are exactly the right tests, and we ran them.

### Q1. Validation of relationship-conditioned labels

**The independent annotation is complete, and we report it in full, including where annotators disagree with our own labels.**

(1) Five non-author annotators re-labelled all three tracks (1,095 items each), blinded to model outputs and to each other:

| Track | ≥4 of 5 agree | κ |
|---|---:|---:|
| QA share/protect | 86.5% | 0.654 |
| Relationship P/L/B | 85.7% | 0.501 |
| Action verdicts | 83.5% | 0.491 |

(2) The action κ falls below our 0.6 bar and we say so plainly. The shortfall is structural: annotators deviate from the gold in three opposite directions, which indicates underspecified boundaries. We release the identified guideline gaps with the data. Excluding one pre-registered outlier annotator gives 0.745 / 0.623 / 0.582.

(3) In 100 cells the annotator majority disagrees with our gold, with two patterns: 16 sensitive-work items read as shareable, and 16 close-friend borderline items upgraded to legitimate. We froze the gold rather than editing it after the votes; these cells ship as adjudication records.

(4) *Framing*: the labels are *scenario contracts*, explicit authorization stipulations for one concrete scenario, not claims about universal social norms; the revision says so in Limitations. 70 of 99 sensitive items change label across requesters, and the close-friend and investor profiles differ on 55, which is why a scalar-trust reading fails.

### Q2. Cleaner policy-specificity ablation

**Agreed, and we thank the reviewer; we ran exactly this ablation** (full table in aP1N Q2).

(1) Length and category naming each contribute substantially (about 38 pp and 30 pp), roughly additively. The "differ only in specificity" phrase is removed from the paper.

(2) On schema overlap: the category-names-only control (P7) still cuts disclosure from 75.0% to 42.5% with no examples or action rules, so naming the categories helps in itself, though far short of the full package's 7.5%.

### Q3. Structural (non-ML) baseline

**Following the request, we ran relationship-conditioned data mounting and report the trade-off it exposes.**

(1) Mounts are enforced pre-retrieval; unmounted content never reaches the model:

| Notes condition | Utility | Disclosure |
|---|---:|---:|
| Rel-Policy | 78.9% | 12.9% |
| Mounted access | 64.2% | 9.0% |
| Rel-Policy + Mounted | 65.2% | 5.6% |

(2) Structure works where it applies (disclosure halves) but is container-level while entitlements are item-level: the same item is legitimate for the investor and protected from the friend on 55 of 99 items. The utility drop is the price of that coarseness. Structure helps most exactly where policy fails: the close-friend profile improves from 38.7% to 18.1% disclosure when mounting is added.

(3) So the measured relationship is complementarity, not replacement. We also tested a pre-tool escalation gate (11,659 decisions; JD3a Q4). We do not claim a complete RBAC/ABAC engine; field-level redaction and role hierarchies are future work.

### Q4. "Frontier" terminology

**We agree and adopt the conservative wording** (*trade-offs across discrete operating points*) throughout, while reporting the full point inventory (aP1N Q1). No dense-Pareto claim remains.

### Q5. Evaluator robustness for States QA and multi-turn

**Added on three levels.**

(1) Judge-free gold-string scoring reproduces every headline direction (States 47.5% → 6.5%).

(2) A different-family judge re-scored both single-step surfaces: Files 98.3% agreement over 1,058 items, States 91.6% over 1,030 (JD3a Q1). Multi-turn re-scoring is not done, and we do not claim it.

(3) The human audit is grounded in the returned independent annotations: all 458 non-unanimous items carry an adjudication column, and the 100 majority-vs-gold cells ship as records (Q1).

### Presentation and limitations

We especially appreciate the concrete feedback on Figure 1; the redraw enlarges the text and shows one explicit cross-boundary path with the enforcement layers separated. The revision also states that the labels are independently audited scenario contracts and that "governance" here means the four tested layers: prompt policy, mounted reachability, contact ACLs, and pre-tool escalation. We hope the added experiments and scoped claims address the concerns, and we welcome further discussion.
