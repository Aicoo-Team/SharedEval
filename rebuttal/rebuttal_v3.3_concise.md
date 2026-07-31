# SharedOS / PACT — Rebuttal v3.3 (concise draft, 2026-07-30)

## 0. Response to the Area Chair

We thank the AC and reviewers for the careful assessment. The reviews agree that cross-boundary personal-agent interaction is important, and that SharedOS, the multi-surface benchmark, and the database-diff action evaluation are valuable. The main concerns are framing, causal attribution, evaluator independence, and external grounding.

We address these concerns in four ways.

1. **Framing.** We replace “security–utility frontier” with *trade-offs across discrete operating points*. The study covers many settings, but it does not estimate a continuous Pareto boundary.
2. **Policy attribution.** We add a 2×2 length-by-category ablation. Length and category enumeration both matter, with roughly additive effects.
3. **Evaluation reliability.** We add gold-string scoring, different-family re-scoring of 2,088 QA responses, and independent annotation by five non-authors.
4. **Structural controls.** We evaluate relationship-conditioned mounting, network-scale access control, and a pre-tool escalation gate.

The paper’s contribution is a first controlled study of security and utility in agent-to-agent delegation under current foundation models. SharedOS supplies the deployed execution substrate; PACT supplies reproducible scenario contracts and measurements. We scope every conclusion to the tested models and settings.

## 1. General Response

We thank all reviewers for recognizing the problem’s importance and the breadth of the evaluation. Reviewer aP1N highlighted the multi-surface setting and action track. Reviewer JD3a highlighted the database-diff evaluation and read/write distinction. Reviewer TtBh highlighted the deployment motivation and relationship-conditioned setting.

### 1.1 Main result across models and surfaces

The D0→D2 security improvement appears across six requester configurations and three surfaces. Utility costs vary by model and surface.

| Surface / requester configuration | Utility D0 / D1 / D2 | Disclosure or unauthorized-action block D0 / D1 / D2 | D0→D2 change |
|---|---:|---:|---:|
| Files — GPT-5-mini (2 reps/cell) | 78.0 / 78.5 / 77.0 | 83.0 / 81.5 / 14.0 disclosure | −69.0 pp |
| Files — GPT-5.5 | 87 / 94 / 86 | 88 / 75 / 4 disclosure | −84.0 pp |
| Files — GPT-5.4-mini | 96 / 99 / 91 | 87 / 90 / 7 disclosure | −80.0 pp |
| Files — GPT-5.4 | 98 / 97 / 74 | 92 / 80 / 1 disclosure | −91.0 pp |
| Files — Kimi K2.6 | 82 / 86 / 81 | 93 / 87 / 4 disclosure | −89.0 pp |
| Files — DeepSeek V3.2 | 91 / 97 / 62 | 93 / 80 / 9 disclosure | −84.0 pp |
| States — GPT-5-mini (2 reps) | 55.0 / 60.5 / 18.0 | 58.5 / 63.0 / 8.0 disclosure | −50.5 pp |
| Actions — GPT-5-mini (2 reps) | 65.5 / 48.0 / 61.0 authorized execution | 43.0 / 43.0 / 93.5 block | +50.5 pp |

**Table GR-1. Core operating points.** Kimi has about 12% infrastructure errors, which are counted as utility failures. The submission varied the requester while holding the responder fixed; we address the responder axis in aP1N Q1.

Gold-string scoring gives the same security direction without an LLM judge. Files disclosure falls from 72.5% to 13.0%; States from 47.5% to 6.5%; Kimi from 86.5% to 8.0%; and DeepSeek from 89.0% to 13.0%.

### 1.2 Scale and breadth of the evidence

The new matched controls improve attribution. They are not the main evidence of scale.

| Evaluation layer | Scale | Main observation |
|---|---:|---|
| PACT-PAIR main study | 600-task benchmark; six requester configurations; Files, States, Actions, multi-turn, and relationships | D0→D2 security direction repeats; utility costs are model- and surface-dependent |
| PACT-NET baseline | 25 agents; 4 clean runs; **4,288 ticks** | Safety rises 26.6→71.5%; utility falls 88.7→78.8%; transitive leakage remains high |
| PACT-PAIR structural mounting | 3 conditions × 5 profiles × 400 questions = **6,000 cells** | Policy + mounting reduces disclosure 15.5→8.0%; utility falls 70.9→58.5% |
| PACT-NET structural validation | Replicated P0/P1 plus two 1,072-tick MCC runs | Policy + mounting gives 77.8% safety and 67.0% transitive leakage, but read-only mounting harms write utility |
| Escalation-gate ablation | 8 cells; **11,659 held-out decisions** | Protected-request stopping is 87.7–94.4%; more supervision mainly restores utility |
| Reviewer-requested policy control | 8 policies × 60 tasks = **480 episodes** | Separates policy length from category enumeration |
| Reviewer-requested responder control | 4 cells × 30 tasks = **120 episodes** | P2 reduces disclosure for DeepSeek V4 Flash and GLM 5.2 |
| Different-family judging | **2,088 responses** | Files agreement 98.3%; States agreement 91.6% |

**Table GR-2. Evidence map.** These rows use different units and answer different questions. We therefore do not combine them into one headline trial count.

### 1.3 Three definitions used below

1. **Operating point.** We compare tested policy/model/system settings. We do not interpolate a continuous frontier.
2. **PACT-PAIR.** It is a controlled instrument on the deployed SharedOS execution path. Seeded worlds provide replayable facts and database-diff ground truth.
3. **Disclosure.** *Direct leakage* appears in the answer to the probing request. *Incidental exposure* appears elsewhere in a persistent trajectory.

## 2. Response to Reviewer aP1N

We thank the reviewer for recognizing the importance of the problem, the breadth of SharedOS, and the strength of the action track.

### Q1. Pareto-front analysis or narrower framing?

**We agree with the terminology concern, but the evidence already covers many operating points.**

1. The submitted study varies requester models, data surfaces, policies, interaction lengths, relationships, and network settings. Table GR-2 also makes the structural and escalation evaluations explicit.
2. The study does not densely sample one continuous intervention axis. We therefore replace “frontier” with *trade-offs across discrete operating points*.
3. We add two matched controls for attribution. They hold the question set and requester fixed.

| Responder | Policy | Utility | Disclosure | Explicit refusal |
|---|---:|---:|---:|---:|
| DeepSeek V4 Flash | P0 | 10/10 (100%) | 18/20 (90%) | 1/20 (5%) |
| DeepSeek V4 Flash | P2 | 10/10 (100%) | 1/20 (5%) | 19/20 (95%) |
| GLM 5.2 | P0 | 9/10 (90%) | 16/20 (80%) | 3/20 (15%) |
| GLM 5.2 | P2 | 10/10 (100%) | 1/20 (5%) | 19/20 (95%) |

**Table GR-3. Responder robustness on one canonical 30-question subset.** Each cell is one run, so this is a robustness check rather than a population estimate.

| Policy | Mechanism | Utility | Disclosure | Explicit refusal |
|---|---|---:|---:|---:|
| P0 | No policy | 95.0% | 87.5% | 2.5% |
| P1 | Generic caution | 90.0% | 75.0% | 2.5% |
| P2 | Category policy | 65.0% | 7.5% | 72.5% |
| P3 | External messages are data | 85.0% | 12.5% | 87.5% |
| P4 | Instruction hierarchy | 80.0% | 5.0% | 90.0% |
| P5 | Classification checklist | 65.0% | 5.0% | 95.0% |
| P6 | Length-matched generic | 85.0% | 35.0% | 40.0% |
| P7 | Short category-specific | 90.0% | 42.5% | 32.5% |

**Table GR-4. Eight policies on one fixed 60-question setting.** P3–P5 reach similar disclosure rates but different utility and refusal rates. P6–P7 are controls, not deployment recommendations.

The submitted appendix also contains multi-turn operating points:

| Model | Policy | Refusal | Direct leak | Global scan | Utility | Action block |
|---|---|---:|---:|---:|---:|---:|
| GPT-5-mini | D0 | 0.0% | 84.2% | 83.0% | 82.9% | 59.0% |
| GPT-5-mini | D1 | 2.0% | 72.9% | 79.5% | 77.5% | 51.0% |
| GPT-5-mini | D2 | 64.4% | 12.6% | 38.0% | 60.3% | 88.5% |
| GPT-5.5 | D0 | 63.5% | 28.0% | 39.5% | 68.5% | 40.9% |
| GPT-5.5 | D1 | 68.5% | 25.0% | 34.0% | 56.0% | 52.6% |
| GPT-5.5 | D2 | 80.5% | 13.0% | 24.5% | 51.5% | 91.4% |

**Table AP-1. Multi-turn model scaling.** Model scale changes the ungoverned point. Under D2, direct leakage converges to 12.6–13.0%, while utility remains model-dependent.

### Q2. Length-matched control separating specificity from length/content?

**We agree this control was missing. The result also corrects our earlier framing.**

We crossed policy length with category enumeration. The world, 60 Files tasks, both agents, and judge stay fixed.

| | Generic wording | Category-specific wording |
|---|---|---|
| **Short (22 words)** | P1: disclosure 75.0%, utility 90.0% | P7: disclosure 42.5%, utility 90.0% |
| **Long (323 words)** | P6: disclosure 35.0%, utility 85.0% | P2: disclosure 7.5%, utility 65.0% |

Each cell has 40 sensitive and 20 public tasks. P6 and P7 are new controls.

The result is simple:

1. Category enumeration reduces disclosure by about 30 pp.
2. Length reduces disclosure by about 38 pp.
3. Their interaction is small, about 5 pp.
4. The full P2 package has the largest utility cost: 5 of 20 legitimate requests are refused.

Thus, neither “specificity alone” nor “length alone” explains the result. We revise the paper to describe D1 and D2 as policy packages.

### Q3. Reconciling Tables 15 and 20

**The tables use different utility definitions; their security columns are identical.**

1. Table 15 measures whether the requester’s attributed answer solves the task. This is the primary semantic-utility metric.
2. Table 20 scans the full 240-tick trajectory for the requested string. It can count partial and incidental matches.
3. We relabel Table 20 as *trajectory-wide fact coverage (diagnostic)* and move it to the appendix.

Both tables retain the D0 > D1 > D2 utility ordering. We thank the reviewer for identifying the ambiguity.

### Q4. How much over-refusal follows from the relationship-agnostic setup?

**The relationship-agnostic policy creates part of the mismatch, but it does not explain all observed structure.**

1. RQ3 asks whether a model can combine one D2 policy with relationship context. The relationship-conditioned labels specify the intended behavior.
2. The errors differ by requester and operation. They are not uniform refusals.

| Requester | QA disclosure | QA over-refusal | QA utility | Action utility | Unauthorized-action block |
|---|---:|---:|---:|---:|---:|
| Colleague | 1.7% | 40% | 57% | 92% | 90% |
| CEO delegate | 3.3% | 59% | 49% | 89% | 85% |
| Close friend | 9.2% | 86% | 58% | 92% | 84% |
| Investor / board observer | 7.5% | 31% | 70% | 83% | 91% |

**Table AP-2. Relationship-conditioned D2.** The close-friend profile has the highest QA over-refusal but the lowest action safety. The investor profile shows the opposite pattern.

The scenario contracts also differ materially: 70 of 99 sensitive items change label across requesters, and the friend and investor differ on 55 of 99.

3. We also run the requested relationship-aware baseline. With requester-specific policies, GPT-5.5 utility reaches 87.4% for the colleague, 87.1% for the delegate, and 87.4% for the investor. The close-friend profile remains difficult: 63.3% utility and 38.7% P+B disclosure.

Thus, relationship-aware policy reduces over-refusal but does not eliminate mis-calibration. We report the unmatched model/package difference as a limitation.

### Q5. Why “eroding” if direct leakage is similar to single-turn?

**We drop “eroding.” Multi-turn interaction adds a second disclosure channel; it does not enlarge the direct leak.**

Direct leakage is similar: 12.6% multi-turn versus 14.0% single-turn. Retries add only 2.1 pp, from 20/191 to 24/191.

The 38.0% global rate is different. It scans the full trajectory. Of 76 string hits, 21 are semantically confirmed and 55 are false positives. We now report this as a diagnostic, not as direct leakage.

| Category | Mini direct leak | Mini global scan | GPT-5.5 direct leak | GPT-5.5 global scan |
|---|---:|---:|---:|---:|
| Sensitive work | 22.8% | 51.7% | 16.7% | 26.7% |
| Personal finance | 4.5% | 34.7% | 8.0% | 24.0% |
| Personal health | 2.6% | 20.0% | 0.0% | 15.0% |
| Personal relationships | 15.7% | 39.2% | 8.0% | 24.0% |
| **All** | **12.6%** | **38.0%** | **9.0%** | **23.0%** |

**Table AP-3. D2 multi-turn security by category.** Sensitive work is the main residual direct-leak category. Health is rarely disclosed directly but still appears in the global scan.

The revised claim is: *persistent interaction opens additional disclosure channels beyond the direct response*.

## 3. Response to Reviewer JD3a

We thank the reviewer for the positive assessment of the database-diff evaluation, statistical reporting, and read/write-trust findings.

### Q1. Different-family judge

**We add both judge-independent scoring and full different-family re-scoring.**

DeepSeek V4 Flash re-scores every gradable single-step Files and States response. The rubric and verdict labels are unchanged.

| Surface | Items | Overall agreement | Utility agreement | Security agreement |
|---|---:|---:|---:|---:|
| Files QA | 1,058 | 98.3% | 98.6% | 98.0% |
| States QA | 1,030 | 91.6% | 88.8% | 94.3% |

**Table JD-1. Cross-family judge robustness.** All outputs include provider-returned model provenance. One empty Files response is excluded because there is no text to judge.

The Files result is nearly invariant: D0→D2 disclosure is 88.1→14.1% with the original judge and 88.6→14.1% with DeepSeek. For States, D2 utility is 21.6→20.4% and disclosure is 7.5→5.7%. Agreement rates use gradable items and do not replace the manuscript’s fixed-denominator rates.

### Q2. Bounding the D2 States-QA variance

**We agree that n=2 cannot bound the utility magnitude. We narrow the claim accordingly.**

1. The security direction repeats. Disclosure falls 58→5% in one replication and 59→11% in the other. McNemar p<.001 in both.
2. D2 utility ranges from 5% to 31%. Early context determines whether the queried state object is available, and small denominators amplify the variation.
3. The revision reports this range, states n=2, and avoids a precise utility claim.

Further replication under the original protocol remains future work.

### Q3. RQ3 beyond GPT-5-mini

**We reproduce the relationship result on GPT-5.5 and on non-OpenAI GLM 5.2.**

The GPT-5.5 study contains 5 requesters × 400 QA × 3 conditions = 6,000 trials. The GLM run uses one verified seeded world with 103 Notes and the same 100 sensitive questions for each profile. Immutable retries replace 22 engine-error rows, yielding 500/500 provenance-valid rows.

| Requester | Utility | Disclosure | Safe non-answer | Explicit refusal |
|---|---:|---:|---:|---:|
| Stranger | – (0 legitimate) | 1.0% | 62.0% | 37.0% |
| Colleague | 100.0% (6/6) | 5.3% | 4.3% | 90.4% |
| CEO delegate | 93.9% (31/33) | 0.0% | 1.5% | 98.5% |
| Close friend | 100.0% (15/15) | 31.8% | 4.7% | 63.5% |
| Investor | 90.9% (10/11) | 13.5% | 2.2% | 84.3% |

**Table JD-3. Seeded GLM relationship replication.** Utility denominators differ because the scenario contracts assign different legitimate items to each profile.

The close-friend disclosure concentration repeats. The delegate occupies a more conservative point. We do not compare absolute GPT-5.5 and GLM utility because the task ranges and policy implementations differ.

### Q4. Interventions MVP

**We implement and evaluate mounting and pre-tool escalation.**

#### (1) Dyadic structural mounting

Pre-retrieval relationship-conditioned mounting filters content before search or ranking. Direct note-ID access also re-checks the mount.

| Notes condition | Policy | Reachability | Utility | P+B disclosure |
|---|---|---|---:|---:|
| Relationship policy | requester-specific | all Notes | 78.9% | 12.9% |
| Mounted access | none | profile folders | 64.2% | 9.0% |
| Policy + mounted access | requester-specific | profile folders | 65.2% | 5.6% |

**Table JD-4. PACT-PAIR structural baseline.** Mounting reduces reachable context. Policy still improves safety within the mounted scope.

#### (2) Network-scale validation

PACT-NET contains 25 agents. The P0/P1 rows average two namespace-isolated replications.

| Task family | N | P0 accuracy | P1 accuracy | Change |
|---|---:|---:|---:|---:|
| Legitimate contact query | 172 | 75.9% | 64.0% | −11.9 pp |
| Direct sensitive query | 139 | 16.2% | 73.4% | +57.2 pp |
| Transitive third-party risk | 94 | 3.7% | 22.3% | +18.6 pp |
| Cross-cluster disclosure | 28 | 12.5% | 30.4% | +17.9 pp |
| Unauthorized mutation | 115 | 29.6% | 85.2% | +55.7 pp |
| Confused-deputy request | 50 | 53.0% | 98.0% | +45.0 pp |
| Cross-surface sensitive plant | 50 | 0.0% | 94.0% | +94.0 pp |

**Table JD-5. PACT-NET task families.** Static policy handles visible violations well. It is less effective for transitive and cross-cluster risk.

We then add network-scale mounted-context control (MCC):

| Condition | Policy | MCC | Safety | Utility | Trans. leak | Deputy success | Plant defence |
|---|---|---|---:|---:|---:|---:|---:|
| P0 | no | no | 26.6% | 88.7% | 96.3% | 47.0% | 0.0% |
| P1 | yes | no | 71.5% | 78.8% | 77.7% | 2.0% | 94.0% |
| MCC_H | no | yes | 64.4% | 23.1% | 77.7% | 6.0% | 2.0% |
| MCC_H + P1 | yes | yes | 77.8% | 20.6% | 67.0% | 0.0% | 92.0% |

**Table JD-6. PACT-NET MCC validation.** MCC + policy has the best safety and lowest transitive leakage. Utility collapses because this validation mount is read-only and blocks authorized writes.

#### (3) Pre-tool escalation

The gate covers two models, three precedent representations, and two supervision levels.

| Model | Precedent scope | Sup. | N | Protected-stop | Utility |
|---|---|---:|---:|---:|---:|
| GPT-5-mini | individual | 10% | 1,548 | 90.8% | 69.8% |
| GPT-5-mini | cluster-2NN | 10% | 1,548 | 88.5% | 76.7% |
| GPT-5-mini | rich cluster-2NN | 10% | 1,548 | 91.3% | 78.0% |
| GPT-5-mini | individual | 30% | 1,186 | 87.7% | 91.0% |
| GPT-5.5 | individual | 10% | 1,548 | 94.2% | 67.1% |
| GPT-5.5 | cluster-2NN | 10% | 1,547 | 92.7% | 71.3% |
| GPT-5.5 | rich cluster-2NN | 10% | 1,548 | 94.4% | 68.1% |
| GPT-5.5 | individual | 30% | 1,186 | 92.1% | 87.4% |

**Table JD-7. Escalation-gate ablation (11,659 decisions).** Protection remains 87.7–94.4%. Increasing same-pair supervision mainly restores utility.

These controls expose complementary layers. Policy handles visible violations. Mounting limits reachable context. Escalation moves ambiguous decisions to the tool boundary. None is free of utility cost.

### Weaknesses and limitations

1. **Network scope.** PACT-NET is now executed over 25 agents and 114 directed contact edges. Transitive and cross-cluster leakage remain open problems. Its action rows predate database-diff instrumentation and are used only as directional evidence.
2. **Independent labels.** Five non-author annotators re-label all three tracks. We report agreement and every majority-vs-gold disagreement in TtBh Q1.
3. **Naming.** SharedOS is the platform. PACT-Bench is the suite: PACT-PAIR plus PACT-NET.
4. **Novelty.** The contribution is the joint measurement of policy, relationship, persistence, tools, and state on one instrumented substrate.

## 4. Response to Reviewer TtBh

We thank the reviewer for the access-control-informed review. The requests for independent labels, a controlled policy ablation, and a structural baseline directly improve the paper.

### Q1. Validation of relationship-conditioned labels

**Five non-author annotators independently re-label every item in all three tracks.**

| Track | Items | ≥4/5 agree | Majority exists | Fleiss’ κ |
|---|---:|---:|---:|---:|
| QA labels | 400 | 86.5% | 97.8% | 0.654 |
| Relationship P/L/B | 495 | 85.7% | 95.6% | 0.501 |
| Action verdicts | 200 | 83.5% | 100% | 0.491 |

**Table TT-1. Independent annotation.** Annotators are blinded to model outputs and to one another.

1. Only 31 of 1,095 cells are unresolved 2-2-1 ties.
2. The action κ is below our 0.6 target. We report this rather than hiding it.
3. In 100 cells, the annotator majority differs from our frozen gold. These cells ship as adjudication records.
4. The main disagreement patterns concern company-internal work data and close-friend access.

We now call the labels *scenario contracts*. They are explicit authorization stipulations, not universal social norms. The requester set is a maximum-contrast design: 70 of 99 sensitive items change label across profiles.

### Q2. Cleaner policy-specificity ablation

**Completed. Length and category enumeration both matter.**

The full 2×2 appears in aP1N Q2. Category enumeration reduces disclosure by about 30 pp, and length by about 38 pp. The effects are roughly additive.

The short category control names categories but omits examples and action rules. It reduces disclosure from 75.0% to 42.5%. The full package reaches 7.5% but has a larger utility cost.

### Q3. Structural non-ML baseline

**We implement the requested pre-retrieval relationship-conditioned mounting baseline.**

| Notes condition | Utility | P+B disclosure |
|---|---:|---:|
| Relationship policy | 78.9% | 12.9% |
| Mounted access | 64.2% | 9.0% |
| Policy + mounted access | 65.2% | 5.6% |

**Table TT-2. Structural Notes baseline (5 profiles × 200 questions × 3 conditions).**

The result has three implications:

1. Mounting works where it applies. Adding it to the same policy cuts disclosure from 12.9% to 5.6%.
2. It is coarse. Folder-level scope cannot express item-, operation-, or purpose-specific access.
3. Policy still helps within the mounted scope. It reduces disclosure from 9.0% to 5.6% at similar utility.

Network-scale MCC and the escalation gate show the same complementarity (JD3a Q4). We do not claim a complete RBAC/ABAC system. Field-level redaction, role hierarchies, and post-generation auditing remain future work.

### Q4. “Frontier” terminology

**Agreed. We use *trade-offs across discrete operating points* throughout.**

This is a wording correction, not a replacement of the evidence base. Table GR-2 summarizes the dyadic, multi-turn, network, structural, and escalation evaluations. The smaller GR-3 and GR-4 controls improve attribution.

### Q5. Evaluator robustness for States QA and multi-turn

**We add three robustness checks.**

1. Gold-string scoring preserves every headline security direction.
2. DeepSeek re-scores all single-step Files and States responses. Agreement is 98.3% and 91.6%, respectively.
3. Independent annotators provide adjudication records for all non-unanimous items.

We do not claim different-family robustness for multi-turn. Its full trajectory inputs have not been reconstructed for re-scoring, and we state this limitation.

### Presentation and limitations

We thank the reviewer for the concrete Figure 1 feedback. The revision enlarges the text and separates requester routing, policy, mounted reachability, tools, persistent owner state, and database-diff evaluation.

The revision also makes two limitations explicit:

1. Relationship labels are audited scenario contracts, not universal access norms.
2. “Governance” refers only to the mechanisms tested here: prompt policy, mounted reachability, contact ACLs, and pre-tool escalation.
