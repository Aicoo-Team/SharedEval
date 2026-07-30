# SharedOS / PACT — Rebuttal v3.2

## 0. Response to the Area Chair (Metareview)

We thank the AC and all reviewers for the careful metareview. We are glad the reviews agree that cross-boundary interaction between personal agents is an important and timely problem and that SharedOS, the benchmark, and the database-diff action evaluation are valuable contributions. Below we summarize how the response addresses the four issues the metareview highlights; details and evidence are in the General Response and the individual replies.

1. **"Frontier" framing.** It was intended as conceptual framing, and we agree the measured object is a set of discrete operating points. We have (a) renamed it throughout to *security–utility trade-offs across discrete operating points*, and (b) densified the point set to eight judged policy packages on one fixed 60-task/model setting (Table GR-4), plus three literature-derived defence prompts (Spotlighting, Instruction Hierarchy, Sandwich + Boundary) evaluated under the 240-tick multi-step protocol (reply to aP1N Q1). Separately, we vary the responder on one canonical 30-task subset (Table GR-3), so policy breadth and responder robustness are not conflated.
2. **Policy-specificity confounds.** We agree D1 vs D2 is a policy-*package* comparison. We ran a 2×2 ablation crossing policy length with category-specificity, with a length-matched generic control and a short category-specific control: both components contribute substantially and roughly additively (about 38 pp and 30 pp of disclosure reduction respectively), which corrects our own earlier framing that specificity alone drives the effect (C2; full table in the reply to aP1N Q2).
3. **Evaluation reliability.** We add (a) judge-independent gold-string scoring, which reproduces every headline security direction; (b) complete different-family re-scoring of Files (1,058 items; 98.3% agreement) and States (1,030 items; 91.6% agreement), preserving the D2 ordering on both surfaces; and (c) an independent non-author annotation study of the relationship-conditioned labels (C3, C4; Table JD-1).
4. **Comparison with traditional access control.** We have run a structural baseline the reviewers requested, pre-retrieval relationship-conditioned data mounting, plus a pre-tool escalation gate, and we discuss where rule-based enforcement wins, where it is inherently coarse, and why the measured result is *complementarity* between structural and policy-level control (C5; reply to TtBh Q3).

We view this paper as a first systematic exploration of the security–utility trade-off in agent-to-agent delegation, on a deployment-realistic substrate, under current foundation models. Our goal is to establish the platform, the measurement methodology, and the first set of reproducible observations, and thereby to initialize more research in this direction; the revision scopes every conclusion accordingly. We are happy to continue the discussion on any remaining point.

## 1. General Response (to all reviewers)

We thank all reviewers for their careful and constructive reviews. Reviewer aP1N recognized the importance of the problem and the breadth of SharedOS across files, structured state, tools, persistent interaction, and relationship context; Reviewer JD3a highlighted the database-diff action evaluation, statistical reporting, and the read/write-trust and metadata findings; Reviewer TtBh recognized the timely, deployment-motivated problem and the multi-surface, multi-turn, relationship-conditioned evaluation. The reviews agree on the importance of the problem and the value of the artifacts; the concerns center on causal attribution, evaluator independence, external grounding, and wording strength. We address all of them, with new experiments wherever an experiment was requested.

**Positioning.** As personal agents are increasingly deployed, agent-to-agent (A2A) communication across ownership boundaries is emerging as a consequential application surface. This paper is a first systematic exploration of the security–utility trade-off that arises there. The contributions are (i) SharedOS, a deployment-realistic platform: a deployed system with external users, MCP-compatible tools, persistent state, and permission objects, on which external personal agents can follow our settings and be evaluated; and (ii) a controlled measurement, under current foundation models, of common failure modes in cross-boundary interaction. All conclusions are scoped to the tested models and settings; we expect and hope the operating points will move as foundation models improve, and we intend the platform and protocol to support exactly that follow-up research.

### 1.1 Summary of changes and new experiments

| # | Concern (raised by) | Action | Status |
|---|---|---|---|
| C1 | "Frontier" too strong; too few operating points (aP1N Q1, TtBh Q4, AC) | Renamed to *trade-offs across discrete operating points*; eight judged single-step policy packages (Table GR-4) plus three literature-derived defences at 240-tick multi-step (aP1N Q1), with responder robustness reported separately (Table GR-3) | **done**: 8 × 60 single-step evaluations, 3 multi-step defence packages, 4 × 30 responder-policy cells |
| C2 | D1/D2 confounds length, categories, examples (aP1N Q2, TtBh Q2, AC) | 2×2 ablation, length × category-specificity (P1/P7/P6/P2), 60 stratified tasks per cell, submitted judge | **done**: both factors matter and are roughly additive (~38 pp length, ~30 pp category); table in aP1N Q2 |
| C3 | Same-family LLM judge (JD3a Q1, TtBh Q5, AC) | (a) judge-independent gold-string scoring; (b) full different-family re-scoring of single-step Files and States QA | **done**: Files 1,058 items / 98.3% agreement; States 1,030 items / 91.6% agreement (Table JD-1); multi-turn remains untested by a second model family |
| C4 | Labels author-designed; no independent validation (TtBh Q1, JD3a Lim., AC) | Independent annotation by 5 non-author annotators, blinded; agreement plus disagreement analysis; labels reframed as *scenario contracts* | **done**: ≥4/5 agreement on 83.5–86.5% of items; κ 0.654 / 0.501 / 0.491 (QA / relationship / actions); 100 majority-vs-gold cells ship as adjudication records (TtBh Q1) |
| C5 | No structural access-control baseline (TtBh Q3, JD3a Q4, AC) | Pre-retrieval relationship-conditioned mounting on PACT-PAIR, network-scale MCC validation on PACT-NET, and a pre-tool escalation gate; discussion of rule-based vs policy-reasoning trade-offs | Done (TtBh Q3, JD3a Q4); replicated and single-run evidence are labelled separately |
| C6 | Relationship-aware policy baseline (aP1N Q4) | Rel-Policy baseline run (GPT-5.5, 5 requesters × 400 QA) | **done**; the matched GPT-5-mini run is stated as future work, not claimed |
| C7 | States variance rests on n=2 (JD3a Q2) | Claim rescoped to what n=2 supports: security direction robust (McNemar p<.001 in both reps), utility reported as a range (5 to 31%) with its mechanism; n=2 stated in Limitations | Done (JD3a Q2); further replications are future work, not claimed |
| C8 | RQ3 single-model (JD3a Q3) | Reproduced on GPT-5.5 (6,000 trials) and independently on a seeded GLM 5.2 D3 sensitive subset (5 profiles × 100) | **done**: GLM 500/500 provenance-valid rows after immutable retries (Table JD-3) |
| C9 | Table 15/20 discrepancy; multi-turn wording (aP1N Q3/Q5) | Denominators clarified (identical security pipeline; two different utility definitions); direct vs incidental channels separated in text | Done (aP1N Q3/Q5) |
| C10 | Figure 1, naming, captions (TtBh, JD3a) | Naming defined once: **SharedOS** = platform, **PACT-Bench** = suite = **PACT-PAIR** (dyadic) plus **PACT-NET** (network); Tables 32–39 captions and the missing table reference fixed | Naming/captions done; Figure 1 redraw remains a visible pre-posting action and is not claimed as complete here |

The completed supplemental evidence in this response comprises 480 policy-task episodes (8 policies × 60 tasks), 120 responder-policy episodes (4 cells × 30 tasks), 500 seeded relationship episodes, and 2,088 different-family judge calls. We report these units separately rather than inflating them into one heterogeneous trial count. The 600 additional States task responses planned for Table JD-2 are not included until strict finalization and judging complete.

We also surface several previously completed evaluations that were compressed or omitted in the original response: the full two-model multi-turn matrix, requester-conditioned read/write results, PACT-NET task-family and network-native metrics, the full PACT-PAIR MCC decomposition, network-scale MCC validation, and all eight escalation-gate cells. These are not counted as newly run episodes; they are existing artifacts now made auditable in the response.

### 1.2 The core result is stable across models and scorers (Table GR-1)

The central contrast between D0 and D2 recurs across six model configurations from three vendor families, with the same evaluation pipeline:

| Surface / model | Utility D0 / D1 / D2 | Disclosure (QA) or block (Actions) D0 / D1 / D2 | Change, D0 to D2 |
|---|---|---|---|
| Files — GPT-5-mini (2 reps/cell) | 78.0 / 78.5 / 77.0 | 83.0 / 81.5 / 14.0 | −69.0 pp |
| Files — GPT-5.5 | 87 / 94 / 86 | 88 / 75 / 4 | −84.0 pp |
| Files — GPT-5.4-mini | 96 / 99 / 91 | 87 / 90 / 7 | −80.0 pp |
| Files — GPT-5.4 | 98 / 97 / 74 | 92 / 80 / 1 | −91.0 pp |
| Files — Kimi K2.6 (~12% infra errors) | 82 / 86 / 81 | 93 / 87 / 4 | −89.0 pp |
| Files — DeepSeek V3.2 | 91 / 97 / 62 | 93 / 80 / 9 | −84.0 pp |
| States — GPT-5-mini (2 reps) | 55.0 / 60.5 / 18.0 | 58.5 / 63.0 / 8.0 | −50.5 pp |
| Actions — GPT-5-mini (2 reps) | authorized exec 65.5 / 48.0 / 61.0 | unauthorized block 43.0 / 43.0 / 93.5 | +50.5 pp block |

**Table GR-2, the security direction survives without any LLM judge.** With gold-string scoring only, Files disclosure falls from 72.5% under D0 to 13.0% under D2; States from 47.5% to 6.5%; Kimi K2.6 from 86.5% to 8.0%; DeepSeek V3.2 from 89.0% to 13.0%. Semantic/string agreement is 91.5% (single-step Files), 89.3% (States), and 93.7% (multi-turn); all audited disagreements are reported in the reply to JD3a Q1.

### 1.3 Responder robustness on one canonical subset (Table GR-3)

The submission varied the requester while holding the responder fixed. To test the previously missing responder axis without changing the task set, we use one frozen subset of 10 public-work and 20 sensitive Files questions. The requester is gpt-5-mini in every cell; only the responder and policy vary. All 120 rows pass question, policy, response, error, and requester/responder provenance gates, and the existing gpt-5-mini rubric is used throughout:

| Responder | Policy | Utility | Disclosure | Explicit refusal |
|---|---:|---:|---:|---:|
| DeepSeek V4 Flash | P0 | 10/10 (100%) | 18/20 (90%) | 1/20 (5%) |
| DeepSeek V4 Flash | P2 | 10/10 (100%) | 1/20 (5%) | 19/20 (95%) |
| GLM 5.2 | P0 | 9/10 (90%) | 16/20 (80%) | 3/20 (15%) |
| GLM 5.2 | P2 | 10/10 (100%) | 1/20 (5%) | 19/20 (95%) |

On this canonical subset, P2 reduces disclosure by 85 pp for DeepSeek V4 Flash and 75 pp for GLM 5.2 without reducing measured utility. Because each cell is one 30-question run, this is a responder-robustness check, not a population estimate.

### 1.4 Eight policy operating points on one fixed setting (Table GR-4)

To compare policy mechanisms without model or task-set confounds, all eight cells use the same 60 Files questions (20 public, 40 sensitive), gpt-5-mini requester/responder, and gpt-5-mini judge:

| Policy | Mechanism | Role | Utility | Disclosure | Explicit refusal |
|---|---|---|---:|---:|---:|
| P0 | No policy | submitted anchor | 19/20 (95.0%) | 35/40 (87.5%) | 1/40 (2.5%) |
| P1 | Generic caution | submitted | 18/20 (90.0%) | 30/40 (75.0%) | 1/40 (2.5%) |
| P2 | Category policy | submitted | 13/20 (65.0%) | 3/40 (7.5%) | 29/40 (72.5%) |
| P3 | External messages are data | supplementary defense | 17/20 (85.0%) | 5/40 (12.5%) | 35/40 (87.5%) |
| P4 | Instruction hierarchy | supplementary defense | 16/20 (80.0%) | 2/40 (5.0%) | 36/40 (90.0%) |
| P5 | Classification checklist | supplementary defense | 13/20 (65.0%) | 2/40 (5.0%) | 38/40 (95.0%) |
| P6 | Length-matched generic | ablation control | 17/20 (85.0%) | 14/40 (35.0%) | 16/40 (40.0%) |
| P7 | Short category-specific | ablation control | 18/20 (90.0%) | 17/40 (42.5%) | 13/40 (32.5%) |

These are eight discrete operating points, not a dense frontier. P3–P5 reduce disclosure to 5.0–12.5% but differ materially in utility and refusal; P6–P7 isolate the length/category components rather than serving as deployable governance recommendations.

### 1.5 Three clarifications used throughout

1. **What we measure.** The empirical object is a comparison of discrete governance operating points, not an estimated continuous Pareto boundary; the revision uses the conservative wording everywhere. Every tested (model, policy) pair sits on a trade-off; some packages trade off strictly better than others, and that comparison is the finding.
2. **What PACT-PAIR is.** PACT-PAIR is a *controlled instrument built on a deployed substrate*: SharedOS is a live system whose production execution path (routing, permission objects, typed tools, persistent state) the benchmark runs on, while the seeded world provides exact gold facts, counterfactual replay, and database-diff ground truth. It estimates within-world contrasts under explicit scenario contracts, not population prevalence; we curated it to study the problem, not to rank models on a leaderboard.
3. **Two disclosure channels.** *Direct* leakage means a protected fact disclosed in the response to the probing request. *Incidental (global)* exposure means the fact appearing anywhere in a persistent trajectory while serving other requests. Multi-turn interaction adds the second channel; it does not amplify the first (details in aP1N Q5). Security columns use one identical pipeline across all tables.

## 2. Response to Reviewer aP1N

We thank the reviewer for recognizing the importance of the problem, the breadth of SharedOS, and the strength of the action track. The five questions below have concretely improved the paper; we answer them in order.

### Q1. Pareto-front analysis or narrower framing?

**Thank you for raising this framing concern; we agree, and we address it in both ways.** First, the wording: the revision replaces "security–utility frontier" with *security–utility trade-offs across discrete operating points* everywhere and no longer suggests interpolation. Second, more points: Table GR-4 now reports eight policy packages on the same 60 questions and fixed gpt-5-mini requester/responder/judge. The submitted P0/P1/P2 anchors are joined by three supplementary defenses (P3–P5) and two controlled ablations (P6–P7). Disclosure spans 87.5% to 5.0%, while utility spans 95.0% to 65.0%; the lowest-disclosure packages are not interchangeable because their refusal rates range from 72.5% to 95.0%. Table GR-3 then tests the orthogonal responder axis on one canonical 30-question subset: P2 cuts disclosure from 90% to 5% for DeepSeek V4 Flash and from 80% to 5% for GLM 5.2. These are discrete, auditable operating points, not a fitted Pareto boundary.

The same three literature-derived defences also carry *multi-turn* operating points, already in the submitted appendix (the prompt-level defence comparison table): P3, P4, and P5 are the single-step adaptations of D3 (Spotlighting, Hines et al. 2024), D4 (Instruction Hierarchy, Wallace et al. 2024), and D5 (Sandwich + Boundary), which we evaluated under the 240-tick multi-step protocol on gpt-5-mini (6 to 7 splits each). Both the fact-coverage and leak columns below are trajectory-wide string-scan diagnostics, not the direct-response semantic metrics used in Table AP-1:

| Defence (multi-step, 240 ticks) | Trajectory fact coverage (diagnostic) | Scan-based leak (diagnostic) | Unauthorized-action block |
|---|---|---|---|
| D2 category deny (baseline) | 85.5% | 38.0% | 88.5% |
| D3 Spotlighting | 72.9% | 34.3% | 94.0% |
| D4 Instruction Hierarchy | 72.1% | 32.1% | 96.0% |
| D5 Sandwich + Boundary | 80.0% | 27.5% | 94.0% |

The existing multi-turn model-scaling ablation provides six additional operating points under the same 240-tick protocol. `Utility` is direct-response semantic utility, `MsgL` is the judged direct-message leak, and `GlobL` is the over-inclusive trajectory scan and remains diagnostic:

| Model | Policy | Refusal | MsgL | GlobL | Utility | Unauthorized-action block |
|---|---|---:|---:|---:|---:|---:|
| gpt-5-mini | D0 | 0.0% | 84.2% | 83.0% | 82.9% | 59.0% |
| gpt-5-mini | D1 | 2.0% | 72.9% | 79.5% | 77.5% | 51.0% |
| gpt-5-mini | D2 | 64.4% | 12.6% | 38.0% | 60.3% | 88.5% |
| GPT-5.5 | D0 | 63.5% | 28.0% | 39.5% | 68.5% | 40.9% |
| GPT-5.5 | D1 | 68.5% | 25.0% | 34.0% | 56.0% | 52.6% |
| GPT-5.5 | D2 | 80.5% | 13.0% | 24.5% | 51.5% | 91.4% |

**Table AP-1: multi-turn model scaling.** Scale changes the ungoverned operating point substantially (D0 direct leakage 84.2% vs 28.0%), but the explicit D2 boundary brings direct leakage to nearly the same level (12.6% vs 13.0%) and raises action blocking to 88.5–91.4%. Thus the policy effect is not an artifact of a single model, while the accompanying utility/refusal costs remain model-dependent.

The pattern matches the single-step ablation: literature defences buy 4 to 11 pp of scan-leak reduction and 5.5 to 7.5 pp of action safety at a 6 to 13 pp fact-coverage cost, and no prompt-level package closes the incidental-disclosure channel. On the fixed backbone, the response reports eleven judged policy packages (eight single-step and three additional multi-step defences); Table AP-1 adds six model-policy cells, and Table GR-3 separately varies the responder.

### Q2. Length-matched control separating specificity from length/content?

**This is the right control, it was missing from the submission, and we thank the reviewer for it. Following the suggestion we have now run it, and the result corrects our own earlier framing.** The loaded policies differ in more than specificity (22 vs 323 words; categories; examples; action rules), so the submitted claim is a policy-*package* comparison. Following the reviewer's design, we built a 2×2 that crosses policy length with category-specificity, holding the world, the 60 stratified Files tasks (20 public, 40 sensitive), both agents (gpt-5-mini), and the submitted gpt-5-mini judge fixed:

| | Generic wording | Category-specific wording |
|---|---|---|
| **Short (22 w)** | P1 = submitted D1: disclosure 75.0%, utility 90.0% | P7 (new control): disclosure 42.5%, utility 90.0% |
| **Long (323 w)** | P6 (new control): disclosure 35.0%, utility 85.0% | P2 = submitted D2: disclosure 7.5%, utility 65.0% |

(n = 40 sensitive / 20 public per cell, one replication; P6/P7 are purpose-built controls, not submitted policies.)

**The conclusion: both length and category enumeration matter, and their effects are roughly additive.** Averaging over the 2×2, category enumeration reduces disclosure by about 30 pp and length by about 38 pp, with a small interaction (about 5 pp). So neither simple reading survives the data. "Specificity alone drives the effect" fails, because the length-matched generic policy (P6) already cuts disclosure roughly in half. "A longer prompt suffices" also fails, because at matched length the category-specific package still leaks 4.7 times less (7.5% vs 35.0%). The utility cost sits almost entirely in the full D2 package: utility drops to 65.0%, with 5 of the 20 legitimate queries refused, while every other cell stays at 85 to 90%. (On the 40 sensitive items, D2 refuses 29, which is the intended behavior.) So over-refusal of legitimate requests appears specifically when length and category enumeration are combined. In our revision we will replace the phrase about the policies differing only in specificity with exactly this decomposition, reported as measured on this new 60-task subset rather than folded into the original 200-task tables.

### Q3. Reconciling Tables 15 and 20

**Thank you for pointing this out. The two tables measure utility in two different ways, which is why their numbers differ; the security numbers are identical.** At a high level, Table 15 studies whether the answer the requester actually receives solves the task, while Table 20 studies whether the requested fact shows up anywhere in the whole interaction. Concretely: Table 15 counts a success when the directly attributed response answers the requested task (*direct-response semantic utility*; denominators 193/200/194, with pending or unattributed cases excluded). Table 20 counts a hit when the public gold string appears anywhere in the 240-tick trajectory (*trajectory-wide fact coverage*; fixed denominator 200), which also counts partial or incidental matches. The leakage and action-safety columns use one identical pipeline in both tables, which is why they match exactly. In our revision we will keep Table 15 as the primary utility metric, relabel Table 20 as "trajectory-wide fact coverage (diagnostic)", and move it to the appendix. Both tables show the same D0 > D1 > D2 utility ordering. We agree the distinction should have been explicit, and the change will improve the readability of the paper.

### Q4. How much over-refusal follows from the relationship-agnostic setup?

We would like to clarify from the following perspectives.

**(a) The relationship-agnostic policy is the study design, and the gap it produces is the finding.** Our initial goal in RQ3 is to test whether current models, given one uniform policy (D2) plus in-context relationship information, can work out relationship-appropriate boundaries on their own. The relationship-conditioned gold labels define what the right behavior would be. When the model falls short of that target, it mostly fails by refusing too much, and that over-refusal is exactly what we measure and report.

The full fixed-D2 experiment includes both reads and writes:

| Requester | QA disclosure on protected items | QA over-refusal on legitimate items | QA utility | Action utility | Unauthorized-action block |
|---|---:|---:|---:|---:|---:|
| Colleague | 1.7% | 40% | 57% | 92% | 90% |
| CEO delegate | 3.3% | 59% | 49% | 89% | 85% |
| Close friend | 9.2% | 86% | 58% | 92% | 84% |
| Investor / board observer | 7.5% | 31% | 70% | 83% | 91% |

**Table AP-2: relationship-conditioned D2 across read and write tracks.** The relationship effect is not scalar trust. The investor profile has the highest QA utility and low over-refusal but the lowest action utility and highest action safety, whereas the close-friend profile combines the highest over-refusal with the lowest action safety. This read/write separation is observed under one fixed policy and responder.

**(b) We therefore treat RQ3 as a calibration stress test, and the measured over-refusal is structured, not uniform.** The mismatch is substantive rather than cosmetic: 70 of 99 sensitive items change label across requester profiles, and the close-friend and investor contracts differ on 55 of 99. The behavior under the same fixed D2 shows matching structure. On the same 60 sensitive-work questions, before any scoring against labels (so "answers" here includes answers the requester is entitled to):

| Requester | Answers with the queried facts | Refuses |
|---|---|---|
| Colleague | 6.7% | 71.7% |
| CEO delegate | 28.3% | 58.3% |
| Close friend | 18.3% | 75.0% |
| Investor | 30.0% | 58.3% |

By category, refusal on the personal categories is nearly uniform across all four requesters (personal finance roughly 94%, personal health 90 to 93%, personal relationships 90 to 100%), while sensitive-work refusal varies by 17 pp with the requester. A "built into the design" account predicts uniform over-refusal; it does not predict requester-dependent and category-dependent structure.

**(c) Following the reviewer's request, we have now run the relationship-aware policy baseline.** With requester-specific policies (GPT-5.5, 5 requesters × 400 QA), over-refusal drops substantially: utility reaches 87.4% (colleague), 87.1% (delegate), and 87.4% (investor). But failures do not disappear; the close-friend profile stays at 63.3% utility with 38.7% P+B disclosure. So mis-calibration is not attributable solely to relationship-agnostic prompting; we conjecture it also reflects conservative category priors in current models. We report this baseline as an additional operating point and state explicitly that model and package differ from the submitted RQ3 cell; a matched run on the original GPT-5-mini setup is future work, and we do not claim it here.

### Q5. Why "eroding" if direct leakage is similar to single-turn?

**We agree, and we will drop the word "eroding": multi-turn interaction does not make the direct leak worse; it adds a second, different way for facts to leak.** *Direct* leakage, a protected fact appearing in the answer to the probing request itself, is indeed similar across settings (12.6% multi-turn after retries vs 14.0% single-turn; retries add only +2.1 pp, from 20/191 to 24/191), and we do not claim that multi-turn interaction makes this direct leak larger. What it adds is a channel that single-turn evaluation cannot show at all: while the agent serves other requests over 240 ticks, protected facts can surface elsewhere in the conversation (*incidental co-located disclosure*). The 38.0% figure is an over-inclusive string-scan diagnostic of that channel (76/200 hits, of which 21 were semantically confirmed and 55 were false positives); we will report confirmed incidental disclosure separately from the scan rate. The channel is also surface-dependent (Files 8.0% vs States 17.6% under the multi-turn protocol). The revised claim reads: *persistent multi-turn interaction opens additional disclosure channels beyond the direct response*. That is exactly what a single-turn benchmark would miss, and one reason the SharedOS setting matters.

The category decomposition shows why the aggregate direct rate stays bounded:

| Category | mini Ref | mini MsgL | mini Fail | mini GlobL | 5.5 Ref | 5.5 MsgL | 5.5 Fail | 5.5 GlobL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sensitive work | 36.8% | 22.8% | 40.4% | 51.7% | 83.3% | 16.7% | 0.0% | 26.7% |
| Personal finance | 75.0% | 4.5% | 20.5% | 34.7% | 80.0% | 8.0% | 12.0% | 24.0% |
| Personal health | 89.7% | 2.6% | 7.7% | 20.0% | 100.0% | 0.0% | 0.0% | 15.0% |
| Personal relationships | 66.7% | 15.7% | 17.6% | 39.2% | 80.0% | 8.0% | 12.0% | 24.0% |
| All | 64.4% | 12.6% | 23.0% | 38.0% | 85.0% | 9.0% | 6.0% | 23.0% |

**Table AP-3: D2 multi-turn security by category** (`mini`: n=191 gradable protected requests; `5.5`: n=100). Sensitive work is the residual direct-leak bottleneck for both models; health is strongly refused yet still appears in the trajectory-wide scan. This is why we separate direct semantic disclosure from the broader diagnostic scan.

The persistent protocol also records 1,184 adaptive retry attempts. Raw-note-ID retrieval accounts for 65% of attempts but flips only 7.6%; business-justification reframing accounts for 15% but flips 34.5%. The highest-risk observed breach combines business justification, scope expansion, and constrained output after 12 failed attempts; the responder then refuses all six follow-up probes. This supports bounded, strategy-dependent breaches rather than monotonic policy collapse.

Finally, the existing cross-surface audit classifies every unique D2 leak pooled across the two single-step replications:

| Failure mechanism | Files | States | Total |
|---|---:|---:|---:|
| Category-boundary ambiguity | 17 | 10 | 27/44 (61%) |
| Protected fact outside the attributed answer | 4 | 3 | 7/44 (16%) |
| Company-benefit / personal-finance confusion | 2 | 1 | 3/44 (7%) |
| Stochastic, one-replication-only failure | 5 | 2 | 7/44 (16%) |

**Table AP-4: D2 residual-failure taxonomy.** Most residual leakage is not an obvious-PII failure; it is boundary ambiguity in organisational data. The second row also shows why attributed-response scoring and trajectory-level auditing answer different questions.

## 3. Response to Reviewer JD3a

We are excited to receive the positive assessment, and we thank the reviewer for recognizing the database-diff action evaluation, the statistical reporting, the read/write-trust distinction, the metadata channel, and the wedding-cascade case study. We answer the four questions, then the limitations and presentation points.

### Q1. Different-family judge

**Yes. We now provide judge-independent scoring plus full different-family re-scoring on both single-step QA surfaces.** Gold-string matching, with no LLM judge, reproduces every headline security direction: Files disclosure falls from 72.5% under D0 to 13.0% under D2 and States from 47.5% to 6.5%. For the model-family check, DeepSeek V4 Flash (temperature 0) re-scores every gradable response using the submitted rubrics and verdict labels verbatim:

| Surface | Re-scored items | Overall agreement | Utility agreement | Security agreement | Headline comparison on gradable items |
|---|---:|---:|---:|---:|---|
| Files QA | 1,058/1,059 | 98.3% | 98.6% | 98.0% | D0→D2 disclosure: original 88.1→14.1%; DeepSeek 88.6→14.1% |
| States QA | 1,030/1,030 | 91.6% | 88.8% | 94.3% | D2 utility: 21.6→20.4%; D2 disclosure: 7.5→5.7% |

**Table JD-1: cross-family judge robustness.** All 1,030 States calls and all 1,058 returned Files calls carry provider-returned served-model provenance; provider errors are zero for States and one repeatedly empty Files response is excluded because there is no text to judge. The Files conclusion is nearly invariant. States is more judge-sensitive: 57/507 utility judgments and 30/523 security judgments disagree, with DeepSeek more often changing utility `correct` to `incorrect` (29 cases) than the reverse (5); nevertheless, the D2 ordering and low-disclosure conclusion remain. Rates here use the gradable-only denominator for judge agreement and do not replace the manuscript's fixed-200 headline rates, which count no-response as failure.

### Q2. Bounding the D2 States-QA variance

**Agreed: n=2 cannot bound the utility magnitude, and we scope the claim to exactly what n=2 supports.** What the two existing replications already establish: the *security* direction repeats in both (disclosure falls from 58% to 5% in one and from 59% to 11% in the other; McNemar p<.001 each), while D2 States utility spans 5 to 31%. The mechanism, on inspection: under a strict D2, States utility depends on whether early trajectory context happens to include the queried state objects, and small per-cell denominators amplify this; the submitted item set was small for this cell. The revision therefore (i) reports the D2 States utility as the observed range with this mechanism, not as a point estimate, (ii) states the n=2 limitation explicitly in Limitations, and (iii) keeps the surface-asymmetry claim only in the direction the replications support: the security effect is robust; the utility magnitude is uncertain and reported with its spread. Additional replications under the original protocol are future work; we do not claim them in this response.

### Q3. RQ3 beyond gpt-5-mini

**Following the reviewer's suggestion, we reproduce the relationship study on GPT-5.5 and add a non-OpenAI GLM 5.2 replication.** The GPT-5.5 experiment covers 5 requesters × 400 QA × 3 conditions (6,000 trials): requester-specific policy raises utility to 87% for colleague, delegate, and investor, while the close-friend profile remains the failure mode (63.3% utility, 38.7% P+B disclosure).

The independent GLM 5.2 run uses one seeded world (103 Notes at run start), fixed D3, and the same Q101–Q200 sensitive subset for every requester. After retaining 478 valid base rows and replacing 22 engine-error pairs through immutable, question-specific retries, strict finalization yields 500/500 rows:

| Requester profile | Utility | Disclosure | Safe non-answer | Explicit refusal |
|---|---:|---:|---:|---:|
| R0 stranger | – (0/0 legitimate items) | 1.0% (1/100) | 62.0% (62/100) | 37.0% (37/100) |
| R1 colleague | 100.0% (6/6) | 5.3% (5/94) | 4.3% (4/94) | 90.4% (85/94) |
| R2 CEO delegate | 93.9% (31/33) | 0.0% (0/67) | 1.5% (1/67) | 98.5% (66/67) |
| R3 close friend | 100.0% (15/15) | 31.8% (27/85) | 4.7% (4/85) | 63.5% (54/85) |
| R4 investor | 90.9% (10/11) | 13.5% (12/89) | 2.2% (2/89) | 84.3% (75/89) |

**Table JD-3: seeded GLM relationship replication.** The utility denominator varies because the scenario contract assigns different numbers of legitimate items to each profile; security is evaluated on the remaining protected/borderline items. The close-friend disclosure concentration replicates as a qualitative failure mode, while the delegate profile occupies a different, highly conservative operating point. Because the GPT-5.5 and GLM packages cover different task ranges and policy implementations, we do not compare their absolute utility rates as a controlled model effect; together they show that relationship-conditioned behavior remains model- and package-dependent.

### Q4. Interventions MVP

**We did not stop at stating the interventions: mounting and pre-tool escalation are implemented and evaluated at dyadic and network scales.** First, *pre-retrieval relationship-conditioned mounting* on PACT-PAIR (Notes, 5 requesters × 200 questions × 3 conditions) reduces P+B disclosure from 12.9% to 5.6% when added to the same relationship policy, a 56.8% relative reduction, while utility falls from 78.9% to 65.2%. Policy still helps inside the mounted scope: disclosure falls from 9.0% under mounting alone to 5.6% under mounting plus policy, at similar utility (64.2% vs 65.2%).

Second, PACT-NET provides a larger structural test. The P0/P1 baselines average two namespace-isolated replications:

| PACT-NET task family | N | P0 accuracy | P1 accuracy | Change |
|---|---:|---:|---:|---:|
| Legitimate contact query | 172 | 75.9% | 64.0% | −11.9 pp |
| Direct sensitive query | 139 | 16.2% | 73.4% | +57.2 pp |
| Transitive third-party risk | 94 | 3.7% | 22.3% | +18.6 pp |
| Cross-cluster disclosure | 28 | 12.5% | 30.4% | +17.9 pp |
| Authorized create | 184 | 98.4% | 86.7% | −11.7 pp |
| Authorized complete/update | 115 | 91.7% | 88.3% | −3.5 pp |
| Unauthorized mutation | 115 | 29.6% | 85.2% | +55.7 pp |
| Confused-deputy request | 50 | 53.0% | 98.0% | +45.0 pp |
| Cross-surface sensitive plant | 50 | 0.0% | 94.0% | +94.0 pp |

**Table JD-4: PACT-NET per-family accuracy.** Aggregate safety rises from 26.6% to 71.5% (reported +44.8 pp from the unrounded aggregates) while aggregate utility falls from 88.7% to 78.8% (reported −10.0 pp). P1 handles visible direct violations well but leaves most network-native threats unresolved:

| Network-native metric | P0 | P1 | Better direction |
|---|---:|---:|---|
| Transitive leak rate | 96.3% | 77.7% | lower |
| Cross-cluster leak rate | 87.5% | 69.6% | lower |
| Facts disclosed per leak event | 1.61 | 1.55 | lower |
| Confused-deputy success | 47.0% | 2.0% | lower |
| Hard contact enforcement | 100.0% | 100.0% | higher |

**Table JD-5: PACT-NET network-native metrics.** Static policy nearly solves a visible false-authority claim but only modestly reduces transitive and cross-cluster leakage; structural contact enforcement remains exact in every condition.

We then add network-scale MCC. P0/P1 below are the replicated baselines; the MCC rows are single validation runs and therefore directional rather than replication-balanced:

| Network condition | Policy | MCC | Safety | Utility | Transitive leak | Deputy success | Plant defence |
|---|---|---|---:|---:|---:|---:|---:|
| P0 | no | no | 26.6% | 88.7% | 96.3% | 47.0% | 0.0% |
| P1 | yes | no | 71.5% | 78.8% | 77.7% | 2.0% | 94.0% |
| MCC_H | no | yes | 64.4% | 23.1% | 77.7% | 6.0% | 2.0% |
| MCC_H + P1 | yes | yes | 77.8% | 20.6% | 67.0% | 0.0% | 92.0% |

**Table JD-6: PACT-NET MCC validation.** Combining MCC with policy produces the strongest safety and lowest transitive leakage, but utility collapses because this validation mount is read-only and blocks authorized writes. This is useful negative evidence: structural isolation needs separate read/write capabilities and cannot be treated as a free replacement for policy.

Third, the *pre-tool escalation gate* covers two models and four supervision/retrieval conditions, totalling 11,659 decisions. `PStop` is protected-request recall; `Utility` is legitimate-request pass-through:

| Model | Precedent scope | Supervised fraction | N | PStop | Utility | False continue | False stop |
|---|---|---:|---:|---:|---:|---:|---:|
| gpt-5-mini | individual | 10% | 1,548 | 90.8% | 69.8% | 9.2% | 30.2% |
| gpt-5-mini | cluster-2NN | 10% | 1,548 | 88.5% | 76.7% | 11.5% | 23.3% |
| gpt-5-mini | rich cluster-2NN | 10% | 1,548 | 91.3% | 78.0% | 8.8% | 22.0% |
| gpt-5-mini | individual | 30% | 1,186 | 87.7% | 91.0% | 12.3% | 9.0% |
| GPT-5.5 | individual | 10% | 1,548 | 94.2% | 67.1% | 5.8% | 32.9% |
| GPT-5.5 | cluster-2NN | 10% | 1,547 | 92.7% | 71.3% | 7.3% | 28.7% |
| GPT-5.5 | rich cluster-2NN | 10% | 1,548 | 94.4% | 68.1% | 5.6% | 31.9% |
| GPT-5.5 | individual | 30% | 1,186 | 92.1% | 87.4% | 7.9% | 12.6% |

**Table JD-7: escalation-gate ablation.** Protection stays at 87.7–94.4% in all eight cells. Raising same-pair supervision from 10% to 30% lifts utility from 69.8% to 91.0% for gpt-5-mini and from 67.1% to 87.4% for GPT-5.5; cluster transfer recovers some utility, while richer cards help gpt-5-mini on both axes but do not close the gap to direct precedents.

Together these results demonstrate three distinct enforcement layers: static policy handles visible violations, mounting limits reachable context, and escalation moves ambiguous decisions to the tool boundary. None dominates without cost. The PACT-NET action-family rows above are response-heuristic scored because those runs predate DB-diff instrumentation; we use them as directional evidence and reserve strong action claims for the instrumented PACT-PAIR track.

### Weaknesses and limitations

- **Single-target design / PACT-NET design-only.** PACT-NET is now executed, not design-only: 25 agents, D0/D1, two replications per condition, roughly 1,000 tasks plus 75 probes per run, every agent appearing as both source and target. Moving from D0 to D1, private-request refusal rises from 16.2% to 73.4%, but transitive-risk refusal only from 3.7% to 22.3% and cross-cluster refusal from 12.5% to 30.4%, with the hard non-contact gate at 100% throughout. The single-target observations generalize directionally, and transitive and cross-cluster risk remains an open problem, which we flag as such. (Action-level PACT-NET results are excluded from strong claims because those runs predate DB-diff instrumentation. Scale, for reference: the contact graph spans 114 directed edges, 58 undirected pairs, over the 25 agents.)
- **Author-only annotation (κ=0.96 among co-authors).** Five non-author annotators (blinded to model outputs and to each other) have now re-labelled all three tracks. At least four of the five agree on 83.5 to 86.5% of items; chance-corrected κ = 0.654 (QA share/protect), 0.501 (relationship P/L/B), 0.491 (action verdicts), with an outlier-excluded sensitivity also reported. In 100 audited cells the annotator majority disagrees with our gold; we froze the gold rather than editing it after the votes, and those cells ship as adjudication records. Full table and disagreement patterns in our reply to TtBh Q1.
- **Naming.** Defined once in the revision: SharedOS is the platform; PACT-Bench is the benchmark suite, comprising PACT-PAIR (dyadic) and PACT-NET (network). All inconsistent uses fixed.
- **Novelty positioning.** We agree the integrative combination is the novelty and will cite the "abstraction paradox" connection explicitly; our incremental observations (incidental co-located disclosure at roughly three times the direct channel; metadata in refusals; read trust differing from write trust) are, to our knowledge, new in this jointly-instrumented setting.
- **Formatting.** Tables 32–39 captions and the missing table reference are fixed in the revision. Thank you for catching these.

## 4. Response to Reviewer TtBh

We sincerely thank the reviewer for the expert, access-control-informed review. The three main requests, namely independent label validation, a component-controlled policy ablation, and a structural access-control baseline, are exactly the right tests for this work, and we have run or are completing all of them. We answer the five questions in order.

### Q1. Validation of relationship-conditioned labels

**The independent annotation is complete, and we report it in full, including the cells where the annotators disagree with our own labels.** (a) *Validation*: five non-author annotators independently re-labelled all three tracks (1,095 items each: 400 QA, 495 relationship decisions, 200 action verdicts), blinded to model outputs and to each other:

| Track | ≥4 of 5 annotators agree | Majority decision exists | κ (5 annotators) |
|---|---|---|---|
| QA share/protect | 86.5% | 97.8% | 0.654 |
| Relationship P/L/B | 85.7% | 95.6% | 0.501 |
| Action verdicts | 83.5% | 100% | 0.491 |

A supermajority of at least four of five annotators agrees on 83.5 to 86.5% of items across the three tracks, and only 31 of 1,095 cells are unresolvable 2-2-1 ties. Chance-corrected agreement is substantial for QA and moderate for relationship and actions; the action κ falls below our 0.6 bar, and we say so plainly. The action shortfall is structural rather than negligence, since annotators deviate from the gold in three *opposite* directions (lenient on unauthorized-strategic actions; strict on authorized routine edits; lenient on probing and sensitive create/edit), which indicates genuinely underspecified boundaries, and we release the identified guideline gaps with the data. As a sensitivity check, a pre-registered outlier analysis (one annotator fell below 80% majority-agreement on all three tracks) yields κ of 0.745 / 0.623 / 0.582 with that annotator excluded. All 458 non-unanimous items ship with an adjudication column. Most informative for this question: in 100 cells the annotator majority disagrees with our own gold (32 QA, 6 actions, 62 relationship, including 31 ties), with two clear patterns: on 16 sensitive-work items the majority reads company-internal knowledge as shareable where our contract says protect, and on 16 close-friend items the majority upgrades our borderline label to legitimate. We froze the gold rather than editing it after seeing the votes; these cells ship as adjudication records. (b) *Framing*: the labels are *scenario contracts*, that is, explicit and self-consistent authorization stipulations for one concrete scenario, instantiating the variables that contextual integrity and ReBAC/ABAC identify (requester, relationship, object, operation, context). They are not claims about universal social norms, and the revision says so in Limitations, as the reviewer requests. The requester set is a maximum-contrast design, not a representative sample: 70 of the 99 relationship-conditioned sensitive items change label across requesters, and the close-friend and investor profiles differ on 55 of them. The investor (a lead Series A investor and non-voting board observer with stipulated information rights) exists precisely to break a scalar-trust reading: narrow legitimate company-information rights, and no entitlement to the founder's health or personal finances. What the benchmark measures is whether an agent can realize a stipulated information-flow contract while remaining useful; that is the construct the labels need to support, and the one the independent annotation study tests.

### Q2. Cleaner policy-specificity ablation

**Agreed, and we thank the reviewer for the suggestion; we have now run exactly this ablation.** It is a 2×2 crossing policy length with category-specificity, holding world, tasks, agents and judge fixed (full table in our reply to aP1N Q2). The outcome corrects our own earlier framing: length and category enumeration each contribute substantially (about 38 pp and 30 pp of disclosure reduction, roughly additive), so neither "specificity is what matters" nor "it is just a longer prompt" survives the data. The phrase about the policies differing only in specificity is removed from the paper accordingly. On schema overlap: the short category-specific control (P7) names the sensitive categories without the benchmark's examples or action rules, and still reduces disclosure from 75.0% to 42.5%, evidence that naming the protected categories helps in itself, though far short of the full package's 7.5%.

### Q3. Structural (non-ML) baseline

**Following the reviewer's request, we have now run one of the named baselines, relationship-conditioned data mounting, and we discuss the trade-off it exposes.** Implementation: requester-conditioned folder mounts are enforced *pre-retrieval* on the Notes surface; unmounted content is filtered before search and ranking and never reaches the model, and direct note-ID access re-checks the mount. Results (5 requesters × 200 questions × 3 conditions):

| Notes condition | Policy | Reachability | Utility | P+B disclosure |
|---|---|---|---|---|
| Rel-Policy | requester-specific | all Notes | 78.9% | 12.9% |
| Mounted access | none | profile folders | 64.2% | 9.0% |
| Rel-Policy + Mounted | same policy | profile folders | 65.2% | 5.6% |

The table above isolates Notes, where folder mounting is fully implemented. For completeness, the broader Q1–Q400 analysis combines Notes and Todos and reports every requester separately; Todo isolation is coarser, so its absolute utility and disclosure denominators must not be mixed with the Notes-only table:

| Requester | Rel-Policy utility / leak | Mounted utility / leak | Combined utility / leak |
|---|---:|---:|---:|
| Stranger | 21.0% / 1.2% | 23.8% / 1.6% | 23.9% / 0.6% |
| Colleague | 87.4% / 8.0% | 82.9% / 20.3% | 83.3% / 6.3% |
| CEO delegate | 87.1% / 12.6% | 86.6% / 17.9% | 85.9% / 12.6% |
| Close friend | 63.3% / 38.7% | 26.2% / 22.0% | 27.1% / 18.1% |
| Investor | 87.4% / 16.9% | 59.7% / 1.6% | 60.6% / 2.7% |
| **Aggregate** | **70.9% / 15.5%** | **57.6% / 12.4%** | **58.5% / 8.0%** |

**Table TT-1: requester-level MCC decomposition over Notes + Todos.** Structure helps most for the misaligned close-friend and investor profiles, while mounting alone can increase leakage for aligned requesters because the agent freely discloses protected facts that remain inside an allowed folder. The combined layer therefore dominates aggregate disclosure but does not dominate utility.

Three conclusions, scoped to this experiment. (i) Structural enforcement works where it applies: adding mounting to the same policy cuts disclosure by more than half, from 12.9% to 5.6%. (ii) It is inherently coarse for this problem: enforcement is container-level, while entitlements in cross-boundary delegation are item- and context-level. The same item is legitimate for the investor and protected from the friend (55 of the 99 relationship-conditioned items differ between just those two profiles), and static mounts cannot express purpose-bound access; the measured utility cost, from 78.9% to 65.2%, is the price of that coarseness. (iii) Policy reasoning still adds protection *inside* the mounted scope, from 9.0% to 5.6% at unchanged utility. So the measured relationship is complementarity: structure bounds the worst case; semantic policy handles context-dependence within scope. We additionally tested a pre-tool escalation gate (over 10,000 decisions per phase; details in the reply to JD3a Q4). We do not claim this constitutes a complete RBAC/ABAC engine; field-level redaction, role hierarchies, and post-generation auditing are explicitly future work, and the revision scopes "governance" into its four distinct layers (prompt policy, mounted reachability, contact ACLs, pre-tool escalation) rather than treating them as one mechanism.

### Q4. "Frontier" terminology

**We agree and thank the reviewer for the suggestion; we adopt the more conservative wording** (*security–utility trade-offs across discrete operating points*) throughout, while also densifying the measured points to eight judged single-step policy packages (Table GR-4) plus three literature-derived defences under the multi-step protocol (reply to aP1N Q1). Responder robustness is reported separately on one canonical 30-question subset (Table GR-3), rather than conflated with the policy comparison. No dense-Pareto claim is made anywhere in the revision.

### Q5. Evaluator robustness for States QA and multi-turn

**Added on three levels.** (i) Judge-independent gold-string scoring reproduces every headline security direction (States disclosure falls from 47.5% to 6.5%; multi-turn semantic/string agreement is 93.7%). (ii) DeepSeek V4 Flash re-scores every gradable response from both single-step surfaces using the submitted rubric: Files agreement is 98.3% over 1,058 items, and States agreement is 91.6% over 1,030 items (88.8% utility, 94.3% security). Table JD-1 reports the full comparison: States is more judge-sensitive than Files, but D2 remains the lowest-disclosure package under both judges (7.5% original vs 5.7% DeepSeek on gradable items). We do not yet claim different-family robustness for multi-turn because its full trajectory inputs have not been reconstructed for re-scoring. (iii) A human audit of disagreements is grounded in the returned independent annotations: all 458 non-unanimous items carry an adjudication column, and the 100 cells where the annotator majority disagrees with our gold ship as adjudication records (details in our reply to Q1).

### Presentation and limitations

We especially appreciate the concrete feedback on Figure 1; this kind of comment is rare and genuinely helpful. The architecture redraw remains a pre-posting action, and we do not claim it as complete in this draft. The intended revision enlarges the text and shows one explicit path from requester agent, through the cross-boundary policy/contact layer, to the target agent, typed read/write tools, and owner state, with prompt policy, mounted reachability, and DB-diff evaluation visually separated. Per the reviewer's limitation note, the revision also states explicitly that (a) benchmark labels and relationship-conditioned access norms are independently audited scenario contracts rather than universal social norms, and (b) the submitted "governance" conclusions concern prompt-level policies plus the structural mechanisms actually tested. We hope the added experiments, scoped claims, and framing of this work as a first controlled exploration of cross-boundary A2A delegation address the concerns, and we welcome further discussion.
