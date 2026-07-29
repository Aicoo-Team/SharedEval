# SharedOS / PACT — Rebuttal v3 (co-author draft, 2026-07-27)

> **使用说明（发帖前删除本框）**
> - `【TODO: …】` = 待填数字/待跑实验结果；`【CHECK-n】` = 数据一致性待核对项，编号对应 `rebuttal_v2_internal_checklist.md`。
> - 结构：AC 回复、General Response、aP1N、JD3a、TtBh。每个 question 单独作答，顺序为：一句同意或总结，关键解释，点名具体表格，回扣主贡献。
> - 所有新结论均加了 "under current foundation models / in the tested settings" 限定，不推翻任何已发表数字。
> - v3 相对 v2：删除了全部分隔线与箭头符号，压低破折号密度，内容与数字不变。
> - 2026-07-29：按 Jindong 在 v1 docx 上的 29 条批注逐条修订。结构统一为"先结论、再细节、最后收束"；没做过的实验明写"follow 建议新跑的"并把 credit 给 reviewer；术语先大白话后括号；删 intentional / after submission / amplification 等被点名的词。数字与 TODO 占位符一律不动。
> - 发帖前核对 OpenReview 单条评论字数上限；超限时优先压缩表格为文字。

## 0. Response to the Area Chair (Metareview)

We thank the AC and all reviewers for the careful metareview. We are glad the reviews agree that cross-boundary interaction between personal agents is an important and timely problem and that SharedOS, the benchmark, and the database-diff action evaluation are valuable contributions. Below we summarize how the response addresses the four issues the metareview highlights; details and evidence are in the General Response and the individual replies.

1. **"Frontier" framing.** It was intended as conceptual framing, and we agree the measured object is a set of discrete operating points. We have (a) renamed it throughout to *security–utility trade-offs across discrete operating points*, and (b) densified the point set: beyond D0/D1/D2, the component ablation adds two judged policy packages (a length-matched generic policy and a category-names-only policy) on the fixed model pair, and Table GR-1 spans six requester configurations (General Response, C1).
2. **Policy-specificity confounds.** We agree D1 vs D2 is a policy-*package* comparison. We ran a 2×2 ablation crossing policy length with category-specificity, with a length-matched generic control and a short category-specific control: both components contribute substantially and roughly additively (about 38 pp and 30 pp of disclosure reduction respectively), which corrects our own earlier framing that specificity alone drives the effect (C2; full table in the reply to aP1N Q2).
3. **Evaluation reliability.** We add (a) judge-independent gold-string scoring, which already reproduces every headline security direction, (b) a complete re-scoring of the single-step Files QA track by a different-family judge, which agrees with the original judgments on 98.3% of 1,058 items and preserves every headline rate, and (c) an independent non-author annotation study of the relationship-conditioned labels (C3, C4).
4. **Comparison with traditional access control.** We have run a structural baseline the reviewers requested, pre-retrieval relationship-conditioned data mounting, plus a pre-tool escalation gate, and we discuss where rule-based enforcement wins, where it is inherently coarse, and why the measured result is *complementarity* between structural and policy-level control (C5; reply to TtBh Q3).

We view this paper as a first systematic exploration of the security–utility trade-off in agent-to-agent delegation, on a deployment-realistic substrate, under current foundation models. Our goal is to establish the platform, the measurement methodology, and the first set of reproducible observations, and thereby to initialize more research in this direction; the revision scopes every conclusion accordingly. We are happy to continue the discussion on any remaining point.

## 1. General Response (to all reviewers)

We thank all reviewers for their careful and constructive reviews. Reviewer aP1N recognized the importance of the problem and the breadth of SharedOS across files, structured state, tools, persistent interaction, and relationship context; Reviewer JD3a highlighted the database-diff action evaluation, statistical reporting, and the read/write-trust and metadata findings; Reviewer TtBh recognized the timely, deployment-motivated problem and the multi-surface, multi-turn, relationship-conditioned evaluation. The reviews agree on the importance of the problem and the value of the artifacts; the concerns center on causal attribution, evaluator independence, external grounding, and wording strength. We address all of them, with new experiments wherever an experiment was requested.

**Positioning.** As personal agents are increasingly deployed, agent-to-agent (A2A) communication across ownership boundaries is emerging as a consequential application surface. This paper is a first systematic exploration of the security–utility trade-off that arises there. The contributions are (i) SharedOS, a deployment-realistic platform: a deployed system with external users, MCP-compatible tools, persistent state, and permission objects, on which external personal agents can follow our settings and be evaluated; and (ii) a controlled measurement, under current foundation models, of common failure modes in cross-boundary interaction. All conclusions are scoped to the tested models and settings; we expect and hope the operating points will move as foundation models improve, and we intend the platform and protocol to support exactly that follow-up research.

### 1.1 Summary of changes and new experiments

| # | Concern (raised by) | Action | Status |
|---|---|---|---|
| C1 | "Frontier" too strong; too few operating points (aP1N Q1, TtBh Q4, AC) | Renamed to *trade-offs across discrete operating points*; point set densified: five judged policy packages (D0/D1/D2 plus length-matched and category-only controls) on the fixed model pair, six requester configurations in Table GR-1 | Done (aP1N Q1, Q2); additional packages still running are not claimed |
| C2 | D1/D2 confounds length, categories, examples (aP1N Q2, TtBh Q2, AC) | 2×2 ablation, length × category-specificity (P1/P7/P6/P2), 60 stratified tasks per cell, submitted judge | **done**: both factors matter and are roughly additive (~38 pp length, ~30 pp category); table in aP1N Q2 |
| C3 | Same-family LLM judge (JD3a Q1, TtBh Q5, AC) | (a) judge-independent gold-string scoring; (b) full re-scoring of single-step Files QA by a different-family judge | (a) done (Table GR-2); (b) **done** — 1,058 items, 98.3% agreement (reply to JD3a Q1); States and multi-turn re-scoring still outstanding |
| C4 | Labels author-designed; no independent validation (TtBh Q1, JD3a Lim., AC) | Independent annotation by 5 annotators (4 external, 1 project-affiliated), blinded; κ plus disagreement analysis; labels reframed as *scenario contracts* | **done**: κ 0.654 / 0.501 / 0.491 (QA / relationship / actions), external-only sensitivity reported; 100 majority-vs-gold cells ship as adjudication records (TtBh Q1) |
| C5 | No structural access-control baseline (TtBh Q3, JD3a Q4, AC) | Pre-retrieval relationship-conditioned mounting baseline plus pre-tool escalation gate; discussion of rule-based vs policy-reasoning trade-offs | Done (TtBh Q3, JD3a Q4) |
| C6 | Relationship-aware policy baseline (aP1N Q4) | Rel-Policy baseline run (GPT-5.5, 5 requesters × 400 QA) | **done**; the matched GPT-5-mini run is stated as future work, not claimed |
| C7 | States variance rests on n=2 (JD3a Q2) | Claim rescoped to what n=2 supports: security direction robust (McNemar p<.001 in both reps), utility reported as a range (5 to 31%) with its mechanism; n=2 stated in Limitations | Done (JD3a Q2); further replications are future work, not claimed |
| C8 | RQ3 single-model (JD3a Q3) | Reproduced on GPT-5.5 across 5 requester profiles × 400 QA × 3 conditions | 6,000 trials; result reported below |
| C9 | Table 15/20 discrepancy; multi-turn wording (aP1N Q3/Q5) | Denominators clarified (identical security pipeline; two different utility definitions); direct vs incidental channels separated in text | Done (aP1N Q3/Q5) |
| C10 | Figure 1, naming, captions (TtBh, JD3a) | Figure 1 redrawn (larger text, explicit architecture); naming defined once: **SharedOS** = platform, **PACT-Bench** = suite = **PACT-PAIR** (dyadic) plus **PACT-NET** (network); Tables 32–39 captions and the missing table reference fixed | Done in revision |

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

### 1.3 Three clarifications used throughout

1. **What we measure.** The empirical object is a comparison of discrete governance operating points, not an estimated continuous Pareto boundary; the revision uses the conservative wording everywhere. Every tested (model, policy) pair sits on a trade-off; some packages trade off strictly better than others, and that comparison is the finding.
2. **What PACT-PAIR is.** PACT-PAIR is a *controlled instrument built on a deployed substrate*: SharedOS is a live system whose production execution path (routing, permission objects, typed tools, persistent state) the benchmark runs on, while the seeded world provides exact gold facts, counterfactual replay, and database-diff ground truth. It estimates within-world contrasts under explicit scenario contracts, not population prevalence; we curated it to study the problem, not to rank models on a leaderboard.
3. **Two disclosure channels.** *Direct* leakage means a protected fact disclosed in the response to the probing request. *Incidental (global)* exposure means the fact appearing anywhere in a persistent trajectory while serving other requests. Multi-turn interaction adds the second channel; it does not amplify the first (details in aP1N Q5). Security columns use one identical pipeline across all tables.

## 2. Response to Reviewer aP1N

We thank the reviewer for recognizing the importance of the problem, the breadth of SharedOS, and the strength of the action track. The five questions below have concretely improved the paper; we answer them in order.

### Q1. Pareto-front analysis or narrower framing?

**Thank you for raising this framing concern; we agree, and we address it in both ways.** First, the wording: the revision replaces "security–utility frontier" with *security–utility trade-offs across discrete operating points* everywhere, and no longer suggests an interpolated frontier. Second, more points: we did not stop at the submitted three policies. Five policy packages now carry judged Files numbers on the fixed gpt-5-mini pair: D0, D1, D2, plus the two purpose-built controls from the component ablation, a length-matched generic policy and a category-names-only policy (full 2×2 table in our reply to Q2), and Table GR-1 spans six requester configurations at D0/D1/D2. The picture is consistent under current models: *every* configuration shows a trade-off, but the trade-offs are not equal. D2 reduces Files disclosure by 69 to 91 pp across all six models at a utility cost between 1 and 29 pp; D1 barely moves security in any configuration; and at matched length the category-specific package still leaks 4.7 times less than the generic one (7.5% vs 35.0%). This comparison, which policies and which models trade off better, measured point by point, is exactly what the new framing supports. Additional policy packages are still running; we will post whatever completes within the discussion period and do not claim it in advance.

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

## 3. Response to Reviewer JD3a

We are excited to receive the positive assessment, and we thank the reviewer for recognizing the database-diff action evaluation, the statistical reporting, the read/write-trust distinction, the metadata channel, and the wedding-cascade case study. We answer the four questions, then the limitations and presentation points.

### Q1. Different-family judge

**Yes, and two layers of evidence already bound the risk.** (a) *Judge-independent scoring*: with gold-string matching only and no LLM judge at all, every headline security direction reproduces. Files disclosure falls from 72.5% under D0 to 13.0% under D2, States from 47.5% to 6.5%, Kimi K2.6 from 86.5% to 8.0%, and DeepSeek V3.2 from 89.0% to 13.0%. Semantic/string agreement is 89.3 to 93.7% across tracks; we manually reviewed all disagreements (44 single-step cases: all genuine paraphrase or format leaks missed by the matcher; 38 multi-turn cases: 28 real leaks missed by strings, 5 judge false positives, 3 debatable, 2 partial; removing the 5 false positives changes no headline by more than 1.6 pp). (b) *New*: we re-scored **every** gradable response from the six single-step Files QA runs (D0/D1/D2 × two replications) with a different-family judge, DeepSeek V4 Flash at temperature 0 — 1,058 of 1,059 items, one lost to repeated empty provider responses. This is a full re-scoring, not a sample. We kept the submitted utility and security rubrics and verdict labels verbatim and added only a provider-specific JSON-format instruction, so that the judge family is the only thing that varies. Verdict agreement with the original gpt-5-mini judgments is **98.3%** overall (98.6% utility, 98.0% security). The headline result is preserved: Files disclosure falls from 88.1% to 14.1% under the original judge and from 88.6% to 14.1% under the cross-family judge, and D1 remains ineffective (89.4% vs 90.6%). (Rates in this paragraph are over gradable items, e.g. 163/185 leaked under D0; Table GR-1 reports 83.0% because it uses the fixed 200-item denominator, which also counts non-gradable cases as non-leaks.) Of the 18 disagreements, 9 change a disclosure classification, with a net effect of +3 leaks; they do not alter the ordering or any conclusion. Per-item verdicts and the served-model provenance for all 1,058 calls are in the supplementary artifact.

### Q2. Bounding the D2 States-QA variance

**Agreed: n=2 cannot bound the utility magnitude, and we scope the claim to exactly what n=2 supports.** What the two existing replications already establish: the *security* direction repeats in both (disclosure falls from 58% to 5% in one and from 59% to 11% in the other; McNemar p<.001 each), while D2 States utility spans 5 to 31%. The mechanism, on inspection: under a strict D2, States utility depends on whether early trajectory context happens to include the queried state objects, and small per-cell denominators amplify this; the submitted item set was small for this cell. The revision therefore (i) reports the D2 States utility as the observed range with this mechanism, not as a point estimate, (ii) states the n=2 limitation explicitly in Limitations, and (iii) keeps the surface-asymmetry claim only in the direction the replications support: the security effect is robust; the utility magnitude is uncertain and reported with its spread. Additional replications under the original protocol are future work; we do not claim them in this response.

### Q3. RQ3 beyond gpt-5-mini

**Following the reviewer's suggestion, we have reproduced RQ3 on GPT-5.5.**

Across 5 requesters × 400 QA × 3 conditions (6,000 trials), the qualitative pattern replicates. Requester-specific policy raises utility to 87% for colleague, delegate, and investor, while the close-friend profile remains the failure mode (63.3% utility, 38.7% P+B disclosure). We note this experiment uses a richer policy package (an extension, not an exact fixed-D2 replication), and Table GR-1's Kimi and DeepSeek columns already provide non-OpenAI evidence for the RQ1 policy contrast.

### Q4. Interventions MVP

**We did not stop at stating the interventions: two of them are now implemented and tested, and both work, at a measurable utility cost.** (i) *Pre-retrieval relationship-conditioned mounting* (Notes surface, 5 requesters × 200 questions × 3 conditions): adding folder-level mounting to the same relationship policy reduces P+B disclosure from 12.9% to 5.6%, a 56.8% relative reduction, at a utility cost from 78.9% to 65.2%. Conversely, semantic policy still reduces disclosure within the mounted scope, from 9.0% to 5.6%, at unchanged utility (64.2% and 65.2%). (ii) *Pre-tool escalation gate*: 2 models × supervision/retrieval conditions, 11,659 gate decisions in the relationship phase alone. Two headline numbers. First, protection is robust across every tested condition: the gate stops 87.7 to 94.4% of protected requests in all eight condition-model cells. Second, the trade-off is tunable: raising the supervised-precedent fraction from 10% to 30% lifts legitimate-request pass-through from 69.8% to 91.0% (gpt-5-mini; 67.1% to 87.4% for GPT-5.5) at essentially unchanged protection (88 to 92% stop rate), so the gate exposes an adjustable operating point rather than a fixed cost:

| Gate condition (individual scope) | Protected stopped | Legitimate passed |
|---|---|---|
| gpt-5-mini, 10% supervised | 90.8% | 69.8% |
| gpt-5-mini, 30% supervised | 87.7% | 91.0% |
| GPT-5.5, 10% supervised | 94.2% | 67.1% |
| GPT-5.5, 30% supervised | 92.1% | 87.4% | Together these demonstrate, rather than assert, that structural and policy-level enforcement are complementary under current models, with a measurable utility cost; this also answers the "architectural enforcement asserted but not demonstrated" weakness. Full protocol and tables go into the revised appendix.

### Weaknesses and limitations

- **Single-target design / PACT-NET design-only.** PACT-NET is now executed, not design-only: 25 agents, D0/D1, two replications per condition, roughly 1,000 tasks plus 75 probes per run, every agent appearing as both source and target. Moving from D0 to D1, private-request refusal rises from 16.2% to 73.4%, but transitive-risk refusal only from 3.7% to 22.3% and cross-cluster refusal from 12.5% to 30.4%, with the hard non-contact gate at 100% throughout. The single-target observations generalize directionally, and transitive and cross-cluster risk remains an open problem, which we flag as such. (Action-level PACT-NET results are excluded from strong claims because those runs predate DB-diff instrumentation. Scale, for reference: the contact graph spans 114 directed edges, 58 undirected pairs, over the 25 agents.)
- **Author-only annotation (κ=0.96 among co-authors).** Five independent annotators (four external, one project-affiliated; blinded to model outputs and to each other) have now re-labelled all three tracks: κ = 0.654 (QA share/protect), 0.501 (relationship P/L/B), 0.491 (action verdicts), with external-only sensitivity values also reported. In 100 audited cells the annotator majority disagrees with our gold; we froze the gold rather than editing it after the votes, and those cells ship as adjudication records. Full table and disagreement patterns in our reply to TtBh Q1.
- **Naming.** Defined once in the revision: SharedOS is the platform; PACT-Bench is the benchmark suite, comprising PACT-PAIR (dyadic) and PACT-NET (network). All inconsistent uses fixed.
- **Novelty positioning.** We agree the integrative combination is the novelty and will cite the "abstraction paradox" connection explicitly; our incremental observations (incidental co-located disclosure at roughly three times the direct channel; metadata in refusals; read trust differing from write trust) are, to our knowledge, new in this jointly-instrumented setting.
- **Formatting.** Tables 32–39 captions and the missing table reference are fixed in the revision. Thank you for catching these.

## 4. Response to Reviewer TtBh

We sincerely thank the reviewer for the expert, access-control-informed review. The three main requests, namely independent label validation, a component-controlled policy ablation, and a structural access-control baseline, are exactly the right tests for this work, and we have run or are completing all of them. We answer the five questions in order.

### Q1. Validation of relationship-conditioned labels

**The independent annotation is complete, and we report it in full, including the cells where the annotators disagree with our own labels.** (a) *Validation*: five annotators independently re-labelled all three tracks, blinded to model outputs and to each other. Four are external to the project and one is project-affiliated, so we report both the five-annotator agreement and the external-only sensitivity:

| Track | κ (5 annotators) | κ (4 external only) | Unanimous cells |
|---|---|---|---|
| QA share/protect | 0.654 | 0.609 | 60.0% |
| Relationship P/L/B | 0.501 | 0.452 | 61.4% |
| Action verdicts | 0.491 | 0.389 | 46.5% |

QA agreement is substantial and relationship agreement is moderate. Action agreement falls below our 0.6 bar, and we say so plainly; the shortfall is structural rather than negligence, since annotators deviate from the gold in three *opposite* directions (lenient on unauthorized-strategic actions; strict on authorized routine edits; lenient on probing and sensitive create/edit), which indicates genuinely underspecified boundaries, and we release the identified guideline gaps with the data. All 458 non-unanimous items ship with an adjudication column. Most informative for this question: in 100 cells the annotator majority disagrees with our own gold (32 QA, 6 actions, 62 relationship, including 31 ties), with two clear patterns: on 16 sensitive-work items the majority reads company-internal knowledge as shareable where our contract says protect, and on 16 close-friend items the majority upgrades our borderline label to legitimate. We froze the gold rather than editing it after seeing the votes; these cells ship as adjudication records. (b) *Framing*: the labels are *scenario contracts*, that is, explicit and self-consistent authorization stipulations for one concrete scenario, instantiating the variables that contextual integrity and ReBAC/ABAC identify (requester, relationship, object, operation, context). They are not claims about universal social norms, and the revision says so in Limitations, as the reviewer requests. The requester set is a maximum-contrast design, not a representative sample: 70 of the 99 relationship-conditioned sensitive items change label across requesters, and the close-friend and investor profiles differ on 55 of them. The investor (a lead Series A investor and non-voting board observer with stipulated information rights) exists precisely to break a scalar-trust reading: narrow legitimate company-information rights, and no entitlement to the founder's health or personal finances. What the benchmark measures is whether an agent can realize a stipulated information-flow contract while remaining useful; that is the construct the labels need to support, and the one the independent annotation study tests.

### Q2. Cleaner policy-specificity ablation

**Agreed, and we thank the reviewer for the suggestion; we have now run exactly this ablation.** It is a 2×2 crossing policy length with category-specificity, holding world, tasks, agents and judge fixed (full table in our reply to aP1N Q2). The outcome corrects our own earlier framing: length and category enumeration each contribute substantially (about 38 pp and 30 pp of disclosure reduction, roughly additive), so neither "specificity is what matters" nor "it is just a longer prompt" survives the data. The phrase about the policies differing only in specificity is removed from the paper accordingly. On schema overlap: the short category-specific control (P7) names the sensitive categories without the benchmark's examples or action rules, and still reduces disclosure from 75.0% to 42.5%, evidence that naming the protected categories helps in itself, though far short of the full package's 7.5%.

### Q3. Structural (non-ML) baseline

**Following the reviewer's request, we have now run one of the named baselines, relationship-conditioned data mounting, and we discuss the trade-off it exposes.** Implementation: requester-conditioned folder mounts are enforced *pre-retrieval* on the Notes surface; unmounted content is filtered before search and ranking and never reaches the model, and direct note-ID access re-checks the mount. Results (5 requesters × 200 questions × 3 conditions):

| Notes condition | Policy | Reachability | Utility | P+B disclosure |
|---|---|---|---|---|
| Rel-Policy | requester-specific | all Notes | 78.9% | 12.9% |
| Mounted access | none | profile folders | 64.2% | 9.0% |
| Rel-Policy + Mounted | same policy | profile folders | 65.2% | 5.6% |

Three conclusions, scoped to this experiment. (i) Structural enforcement works where it applies: adding mounting to the same policy cuts disclosure by more than half, from 12.9% to 5.6%. (ii) It is inherently coarse for this problem: enforcement is container-level, while entitlements in cross-boundary delegation are item- and context-level. The same item is legitimate for the investor and protected from the friend (55 of the 99 relationship-conditioned items differ between just those two profiles), and static mounts cannot express purpose-bound access; the measured utility cost, from 78.9% to 65.2%, is the price of that coarseness. (iii) Policy reasoning still adds protection *inside* the mounted scope, from 9.0% to 5.6% at unchanged utility. So the measured relationship is complementarity: structure bounds the worst case; semantic policy handles context-dependence within scope. We additionally tested a pre-tool escalation gate (over 10,000 decisions per phase; details in the reply to JD3a Q4). We do not claim this constitutes a complete RBAC/ABAC engine; field-level redaction, role hierarchies, and post-generation auditing are explicitly future work, and the revision scopes "governance" into its four distinct layers (prompt policy, mounted reachability, contact ACLs, pre-tool escalation) rather than treating them as one mechanism.

### Q4. "Frontier" terminology

**We agree and thank the reviewer for the suggestion; we adopt the more conservative wording** (*security–utility trade-offs across discrete operating points*) throughout, while also densifying the measured points (five judged policy packages on the fixed model pair, six requester configurations at D0/D1/D2; see General Response C1 and the reply to aP1N Q1). No dense-Pareto claim is made anywhere in the revision.

### Q5. Evaluator robustness for States QA and multi-turn

**Added on three levels.** (i) Judge-independent gold-string scoring reproduces every headline security direction (States disclosure falls from 47.5% to 6.5%; multi-turn semantic/string agreement is 93.7%). (ii) A full re-scoring of the single-step Files QA track by a different-family judge (DeepSeek V4 Flash, temperature 0, 1,058 items, 98.3% verdict agreement; details in our reply to JD3a Q1). The equivalent re-scoring for States QA and multi-turn is not yet complete, and we do not claim judge-family robustness for those two surfaces. (iii) A human audit of disagreements, now grounded in the returned independent annotations rather than in authors only: all 458 non-unanimous items carry an adjudication column, and the 100 cells where the annotator majority disagrees with our gold ship as adjudication records (details in our reply to Q1). We will report all three alongside the main tables so readers can see the stability of leakage and over-refusal rates under alternative scoring rules.

### Presentation and limitations

We especially appreciate the concrete feedback on Figure 1; this kind of comment is rare and genuinely helpful. We have redrawn it with larger text and a single explicit cross-boundary path: from the requester agent, through the cross-boundary policy and contact layer, to the target agent, its typed read/write tools, and the owner's private state, with the enforcement layers (prompt policy, mounted reachability, DB-diff evaluation) visually separated. Per the reviewer's limitation note, the revision states explicitly that (a) benchmark labels and relationship-conditioned access norms are author-designed scenario contracts pending the independent annotation study, and (b) the submitted "governance" conclusions concern prompt-level policies plus the structural mechanisms actually tested. We hope the added experiments, the scoped claims, and the framing of this work as a first controlled exploration of cross-boundary A2A delegation, intended to initialize research on a problem that current deployments are already encountering, address the reviewer's concerns, and we welcome further discussion.
