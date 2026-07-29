# SharedOS / PACT — Rebuttal v3 (co-author draft, 2026-07-27)

> **使用说明（发帖前删除本框）**
> - `【TODO: …】` = 待填数字/待跑实验结果；`【CHECK-n】` = 数据一致性待核对项，编号对应 `rebuttal_v2_internal_checklist.md`。
> - 结构：AC 回复、General Response、aP1N、JD3a、TtBh。每个 question 单独作答，顺序为：一句同意或总结，关键解释，点名具体表格，回扣主贡献。
> - 所有新结论均加了 "under current foundation models / in the tested settings" 限定，不推翻任何已发表数字。
> - v3 相对 v2：删除了全部分隔线与箭头符号，压低破折号密度，内容与数字不变。
> - 发帖前核对 OpenReview 单条评论字数上限；超限时优先压缩表格为文字。

## 0. Response to the Area Chair (Metareview)

We thank the AC and all reviewers for the careful metareview. We are glad the reviews agree that cross-boundary interaction between personal agents is an important and timely problem and that SharedOS, the benchmark, and the database-diff action evaluation are valuable contributions. Below we summarize how the response addresses the four issues the metareview highlights; details and evidence are in the General Response and the individual replies.

1. **"Frontier" framing.** It was intended as conceptual framing, and we agree the measured object is a set of discrete operating points. We have (a) renamed it throughout to *security–utility trade-offs across discrete operating points*, and (b) densified the point set: beyond D0/D1/D2 we now evaluate 【TODO: 7】policy packages (including four defense-prompt baselines adapted from prior agentic-safety work) across multiple models (General Response, C1).
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
| C1 | "Frontier" too strong; too few operating points (aP1N Q1, TtBh Q4, AC) | Renamed to *trade-offs across discrete operating points*; expanded from 3 to 【TODO: 7】policy packages (D0/D1/D2 plus 4 defense baselines from prior agentic-safety work) × 【TODO: k】models | Partial results in the reply to aP1N Q1; full sweep by end of discussion |
| C2 | D1/D2 confounds length, categories, examples (aP1N Q2, TtBh Q2, AC) | 2×2 ablation, length × category-specificity (P1/P7/P6/P2), 60 stratified tasks per cell, submitted judge | **done**: both factors matter and are roughly additive (~38 pp length, ~30 pp category); table in aP1N Q2 |
| C3 | Same-family LLM judge (JD3a Q1, TtBh Q5, AC) | (a) judge-independent gold-string scoring; (b) full re-scoring of single-step Files QA by a different-family judge | (a) done (Table GR-2); (b) **done** — 1,058 items, 98.3% agreement (reply to JD3a Q1); States and multi-turn re-scoring still outstanding |
| C4 | Labels author-designed; no independent validation (TtBh Q1, JD3a Lim., AC) | Independent annotation by 5 non-author annotators, blinded, stratified sample; κ plus disagreement analysis; labels reframed as *scenario contracts* | 【TODO: κ, disagreements】 |
| C5 | No structural access-control baseline (TtBh Q3, JD3a Q4, AC) | Pre-retrieval relationship-conditioned mounting baseline plus pre-tool escalation gate; discussion of rule-based vs policy-reasoning trade-offs | Done (TtBh Q3, JD3a Q4) |
| C6 | Relationship-aware policy baseline (aP1N Q4) | Rel-Policy baseline run (GPT-5.5, 5 requesters × 400 QA); matched D2-Rel run on GPT-5-mini | GPT-5.5 done; matched run 【TODO】 |
| C7 | States variance rests on n=2 (JD3a Q2) | 【TODO: +K】replications under the original protocol; expanded item set; variance reported | 【TODO】 |
| C8 | RQ3 single-model (JD3a Q3) | GPT-5.5 run; GLM 5.2 run under the identical D3 defense and identical judge | **done**: GPT-5.5 replicates the qualitative pattern; GLM 5.2 sits at the opposite extreme (0/418 leaks, 100% block, utility 0–11%), so the trade-off is defender-dependent (reply to JD3a Q3) |
| C9 | Table 15/20 discrepancy; multi-turn wording (aP1N Q3/Q5) | Denominators clarified (identical security pipeline; different utility estimands); direct vs incidental channels separated in text | Done (aP1N Q3/Q5) |
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

1. **Estimand.** The empirical object is a comparison of discrete governance operating points, not an estimated continuous Pareto boundary; the revision uses the conservative wording everywhere. Every tested (model, policy) pair sits on a trade-off; some packages trade off strictly better than others, and that comparison is the finding.
2. **What PACT-PAIR is.** PACT-PAIR is a *controlled instrument built on a deployed substrate*: SharedOS is a live system whose production execution path (routing, permission objects, typed tools, persistent state) the benchmark runs on, while the seeded world provides exact gold facts, counterfactual replay, and database-diff ground truth. It estimates within-world contrasts under explicit scenario contracts, not population prevalence; we curated it to study the problem, not to rank models on a leaderboard.
3. **Two disclosure channels.** *Direct* leakage means a protected fact disclosed in the response to the probing request. *Incidental (global)* exposure means the fact appearing anywhere in a persistent trajectory while serving other requests. Multi-turn interaction adds the second channel; it does not amplify the first (details in aP1N Q5). Security columns use one identical pipeline across all tables.

## 2. Response to Reviewer aP1N

We thank the reviewer for recognizing the importance of the problem, the breadth of SharedOS, and the strength of the action track, and for questions that have concretely improved the paper. We answer the five questions in order.

### Q1. Pareto-front analysis or narrower framing?

**We have done both.** First, the revision replaces "security–utility frontier" with *security–utility trade-offs across discrete operating points* and does not interpolate an unmeasured frontier. Second, we densified the point set: after submission we continued the study and now evaluate 【TODO: 7】policy packages, namely D0/D1/D2 plus four defense-prompt baselines adapted from prior agentic-safety papers (【TODO: names and citations】), across 【TODO: k】models (Table GR-1 already shows six model configurations at D0/D1/D2). The consistent picture, under current models: *every* configuration exhibits a trade-off, but the trade-offs are not equal. For example, D2 reduces Files disclosure by 69 to 91 pp across all six models at a utility cost between 0 and 29 pp, whereas D1 is near-inert on security in every configuration. Comparing how well different policies and models trade off is precisely the contribution this framing supports. 【TODO: 补上 7-policy × k-model 散点数据表】

### Q2. Length-matched control separating specificity from length/content?

**Agreed, this is the right control, and we ran it — and the result corrects our own prior framing.** The loaded policies differ in more than specificity (22 vs 323 words; categories; examples; action rules), so the submitted claim is a policy-*package* comparison. We built a 2×2 that crosses length with category-specificity, holding the world, the 60 stratified Files tasks (20 public, 40 sensitive), both agents (gpt-5-mini) and the submitted gpt-5-mini judge fixed:

| | Generic wording | Category-specific wording |
|---|---|---|
| **Short (22 w)** | P1 = submitted D1: disclosure 75.0%, utility 90.0% | P7 (new control): disclosure 42.5%, utility 90.0% |
| **Long (323 w)** | P6 (new control): disclosure 35.0%, utility 85.0% | P2 = submitted D2: disclosure 7.5%, utility 65.0% |

(n = 40 sensitive / 20 public per cell, one replication; P6/P7 are purpose-built controls, not submitted policies.)

Both factors matter, and they are roughly additive: averaging over the 2×2, adding category enumeration reduces disclosure by ~30 pp, lengthening the policy by ~38 pp, with a small interaction (~5 pp). This *refutes* the simple reading that specificity alone drives the effect — a length-matched generic policy (P6) already cuts disclosure roughly in half — and equally refutes the "verbosity suffices" reading, since at matched length the category-specific package still leaks 4.7× less (7.5% vs 35.0%). The utility cost concentrates in the full D2 package (65.0% with 29/60 refusals; every other cell stays at 85–90%), so over-refusal emerges specifically from combining length with category enumeration. The revision replaces the phrase about differing only in specificity with exactly this decomposition, reported as measured on this new 60-task subset rather than folded into the original 200-task tables.

### Q3. Reconciling Tables 15 and 20

**The impression of disagreement comes from two different utility estimands with different denominators, not from inconsistent measurement.** Table 15 reports *direct-response semantic utility*: whether the directly attributed response answers the requested task (denominators 193/200/194, with pending or unattributed cases excluded). Table 20 reports *trajectory-wide fact coverage*: whether the public gold string appears anywhere within the 240-tick trajectory (fixed denominator 200), which can count partial or incidental matches. The leakage and action-safety columns use the identical pipeline in both tables, which is why they match exactly. In the revision, Table 15 remains the primary utility metric; Table 20 is relabeled "trajectory-wide fact coverage (diagnostic)" and moved to the appendix. Both tables show the same D0 > D1 > D2 utility ordering, consistent with the paper's trade-off analysis.

### Q4. How much over-refusal follows from the relationship-agnostic setup?

Three points.

**(a) The setup is intentional, and the gap is the measurement, not an artifact.** D2 is deliberately relationship-agnostic: the question RQ3 asks is whether current models, given a uniform policy plus in-context relationship information, can *infer* relationship-appropriate boundaries. The relationship-conditioned gold labels define the target behavior; the measured over-refusal is the cost of that inference failing under current models, which is the finding we report.

**(b) The pattern is richer than "over-refusal exists."** Under the same fixed D2 and the same 60 sensitive-work questions, behavior differs systematically by requester and by category *before any scoring against labels*: colleague 6.7% disclosure / 71.7% refusal; CEO delegate 30.0% / 58.3%; close friend 18.3% / 75.0%; investor 30.0% / 58.3%. Category-level over-refusal patterns (work vs finance vs health) likewise differ 【TODO: 补 per-category 数字】. A "built into the design" account predicts uniform over-refusal; it does not predict this structure.

**(c) We ran the requested relationship-aware policy baseline.** With requester-specific policies (GPT-5.5, 5 requesters × 400 QA), over-refusal drops substantially: utility reaches 87.4% (colleague), 87.1% (delegate), and 87.4% (investor). But failures do not disappear; the close-friend profile stays at 63.3% utility with 38.7% P+B disclosure. So mis-calibration is not attributable solely to relationship-agnostic prompting; we conjecture it also reflects conservative category priors in current models. A matched D2-Rel run on the original GPT-5-mini setup is in progress for a cleaner comparison 【TODO】. We will report this baseline as an additional operating point (noting that model and package differ from the submitted RQ3 cell).

### Q5. Why "eroding" if direct leakage is similar to single-turn?

**We agree the wording should separate two channels, and the revision does; we did not intend "erosion of protection."** *Direct* leakage, meaning a protected fact disclosed in the response to the probing request, is indeed similar across settings (12.6% multi-turn after retries vs 14.0% single-turn; retries add only +2.1 pp, from 20/191 to 24/191), and we make no claim of direct-channel amplification. What multi-turn interaction adds is an *incidental co-located disclosure* channel that single-turn evaluation cannot exhibit: while serving other requests over 240 ticks, protected facts surface elsewhere in the trajectory. The 38.0% figure is an over-inclusive string-scan diagnostic of that channel (76/200 hits, of which 21 were semantically confirmed and 55 were false positives); we will report confirmed incidental disclosure separately from the scan rate. The channel is also surface-dependent (Files 8.0% vs States 17.6% under the multi-turn protocol). The revised claim: *persistent multi-turn interaction opens additional disclosure channels beyond the direct response*, which is exactly what a single-turn benchmark would miss and one reason the SharedOS setting matters.

## 3. Response to Reviewer JD3a

We thank the reviewer for the positive assessment and for recognizing the database-diff action evaluation, the statistical reporting, the read/write-trust distinction, the metadata channel, and the wedding-cascade case study. We answer the four questions, then the limitations and presentation points.

### Q1. Different-family judge

**Yes, and two layers of evidence already bound the risk.** (a) *Judge-independent scoring*: with gold-string matching only and no LLM judge at all, every headline security direction reproduces. Files disclosure falls from 72.5% under D0 to 13.0% under D2, States from 47.5% to 6.5%, Kimi K2.6 from 86.5% to 8.0%, and DeepSeek V3.2 from 89.0% to 13.0%. Semantic/string agreement is 89.3 to 93.7% across tracks; we manually reviewed all disagreements (44 single-step cases: all genuine paraphrase or format leaks missed by the matcher; 38 multi-turn cases: 28 real leaks missed by strings, 5 judge false positives, 3 debatable, 2 partial; removing the 5 false positives changes no headline by more than 1.6 pp). (b) *New*: we re-scored **every** gradable response from the six single-step Files QA runs (D0/D1/D2 × two replications) with a different-family judge, DeepSeek V4 Flash at temperature 0 — 1,058 of 1,059 items, one lost to repeated empty provider responses. This is a full re-scoring, not a sample. We kept the submitted utility and security rubrics and verdict labels verbatim and added only a provider-specific JSON-format instruction, so that the judge family is the only thing that varies. Verdict agreement with the original gpt-5-mini judgments is **98.3%** overall (98.6% utility, 98.0% security). The headline result is preserved: Files disclosure falls from 88.1% to 14.1% under the original judge and from 88.6% to 14.1% under the cross-family judge, and D1 remains ineffective (89.4% vs 90.6%). Of the 18 disagreements, 9 change a disclosure classification, with a net effect of +3 leaks; they do not alter the ordering or any conclusion. Per-item verdicts and the served-model provenance for all 1,058 calls are in the supplementary artifact.

### Q2. Bounding the D2 States-QA variance

**Agreed that n=2 cannot bound the utility magnitude, and we are adding replications.** What the two existing replications already establish: the *security* direction repeats in both (disclosure falls from 58% to 5% in one and from 59% to 11% in the other; McNemar p<.001 each), while D2 States utility spans 5 to 31%. The mechanism, on inspection: under a strict D2, States utility depends on whether early trajectory context happens to include the queried state objects, and small per-cell denominators amplify this; the submitted item set was small for this cell. Following the reviewer's suggestion we (i) run 【TODO: K】additional replications under the original protocol, and (ii) extend the States item set following the original construction procedure, reporting mean ± sd for all cells 【TODO: numbers】. The surface-asymmetry claim will be scoped to what the completed replications support: the security direction is robust; the utility magnitude is reported with its variance.

### Q3. RQ3 beyond gpt-5-mini

**Done for GPT-5.5, and now for a non-OpenAI model in the same protocol.** The relationship-conditioned setting has been extended to GPT-5.5 (5 requesters × 400 QA × 3 conditions; 6,000 trials): the qualitative pattern replicates. Requester-specific policy raises utility to 87% for colleague, delegate, and investor, while the close-friend profile remains the failure mode (63.3% utility, 38.7% P+B disclosure). We note the GPT-5.5 experiment uses a richer policy package (an extension, not an exact fixed-D2 replication), and Table GR-1's Kimi and DeepSeek columns already provide non-OpenAI evidence for the RQ1 policy contrast.

**New since submission: GLM 5.2 under the identical relationship-conditioned defense and identical judge.** We ran the D3 relationship-conditioned defense with all five requester profiles on GLM 5.2 (500 trials over the sensitive question range) and scored it with the same judge script, rubric, and judge model used for the GPT-5.5 runs, unchanged. The result is a model contrast rather than a replication of the gradient, and it is informative. GLM 5.2 leaks nothing for any requester: 0 of 418 judged security items, a 100% block rate for every profile, including the close-friend profile where GPT-5.5 under the same defense leaks 37.8%. Its utility, however, collapses to 0 to 11% on the in-range legitimate items, against 19 to 98% for GPT-5.5. Relationship context still modulates GLM's behavior, but along engagement rather than disclosure: average tool calls rise from 0.08 for the stranger to 2.00 for the CEO delegate, and responses lengthen, while disclosure stays at zero. So under current foundation models the relationship-conditioned trade-off is defender-dependent: the same defense places GPT-5.5 on a graded, relationship-sensitive operating point and GLM 5.2 at a maximally conservative one. This is precisely the comparison the discrete-operating-points framing (General Response C1) exists to support, and it strengthens the paper's case that governance results must be reported per (model, policy) pair rather than as model-independent properties of a policy. Caveats, stated plainly: one run per requester profile; transient provider errors (1 to 11 per profile) are excluded from denominators and reported; and the utility denominators in this sensitive-range protocol are small (0 to 24 items per profile) and are not comparable to the GPT-5.5 requester-specific-policy utility figures quoted above.

### Q4. Interventions MVP

**Tested; after submission we implemented two of the stated interventions.** (i) *Pre-retrieval relationship-conditioned mounting* (Notes surface, 5 requesters × 200 questions × 3 conditions): adding folder-level mounting to the same relationship policy reduces P+B disclosure from 12.9% to 5.6%, a 56.8% relative reduction, at a utility cost from 78.9% to 65.2%. Conversely, semantic policy still reduces disclosure within the mounted scope, from 9.0% to 5.6%, at unchanged utility (64.2% and 65.2%). (ii) *Pre-tool escalation gate*: 2 models × multiple supervision/retrieval conditions, over 10,000 gate decisions in each phase 【TODO: 提炼 1–2 个 headline 数字】. Together these demonstrate, rather than assert, that structural and policy-level enforcement are complementary under current models, with a measurable utility cost; this also answers the "architectural enforcement asserted but not demonstrated" weakness. Full protocol and tables go into the revised appendix.

### Weaknesses and limitations

- **Single-target design / PACT-NET design-only.** PACT-NET is now executed, not design-only: 25 agents, D0/D1, two replications per condition, roughly 1,000 tasks plus 75 probes per run, every agent appearing as both source and target. Moving from D0 to D1, private-request refusal rises from 16.2% to 73.4%, but transitive-risk refusal only from 3.7% to 22.3% and cross-cluster refusal from 12.5% to 30.4%, with the hard non-contact gate at 100% throughout. The single-target observations generalize directionally, and transitive and cross-cluster risk remains an open problem, which we flag as such. (Action-level PACT-NET results are excluded from strong claims because those runs predate DB-diff instrumentation. Scale, for reference: the contact graph spans 114 directed edges, 58 undirected pairs, over the 25 agents.)
- **Author-only annotation (κ=0.96 among co-authors).** We have recruited 5 non-author annotators to independently re-label a stratified sample (blinded to model outputs and to each other); we will report agreement and the main disagreement cases 【TODO: κ, cases】.
- **Naming.** Defined once in the revision: SharedOS is the platform; PACT-Bench is the benchmark suite, comprising PACT-PAIR (dyadic) and PACT-NET (network). All inconsistent uses fixed.
- **Novelty positioning.** We agree the integrative combination is the novelty and will cite the "abstraction paradox" connection explicitly; our incremental observations (incidental co-located disclosure at roughly three times the direct channel; metadata in refusals; read trust differing from write trust) are, to our knowledge, new in this jointly-instrumented setting.
- **Formatting.** Tables 32–39 captions and the missing table reference are fixed in the revision. Thank you for catching these.

## 4. Response to Reviewer TtBh

We sincerely thank the reviewer for the expert, access-control-informed review. The three main requests, namely independent label validation, a component-controlled policy ablation, and a structural access-control baseline, are exactly the right tests for this work, and we have run or are completing all of them. We answer the five questions in order.

### Q1. Validation of relationship-conditioned labels

**We are adding independent validation, and we reframe what the labels claim.** (a) *Validation*: 5 non-author annotators independently re-label a stratified sample covering all relationship-conditioned items, blinded to model outputs and to each other; we will report inter-rater agreement and the main disagreement cases with the adjudication rule 【TODO: κ, disagreement analysis】. (b) *Framing*: the labels are *scenario contracts*, that is, explicit and self-consistent authorization stipulations for one concrete scenario, instantiating the variables that contextual integrity and ReBAC/ABAC identify (requester, relationship, object, operation, context). They are not claims about universal social norms, and the revision says so in Limitations, as the reviewer requests. The requester set is a maximum-contrast design, not a representative sample: 70 of the 99 relationship-conditioned sensitive items change label across requesters, and the close-friend and investor profiles differ on 55 of them. The investor (a lead Series A investor and non-voting board observer with stipulated information rights) exists precisely to break a scalar-trust reading: narrow legitimate company-information rights, and no entitlement to the founder's health or personal finances. What the benchmark measures is whether an agent can realize a stipulated information-flow contract while remaining useful; that is the construct the labels need to support, and the one the independent annotation study tests.

### Q2. Cleaner policy-specificity ablation

**Agreed and done.** We ran a 2×2 crossing policy length with category-specificity, holding world, tasks, agents and judge fixed (full table in our reply to aP1N Q2). The outcome corrects our own prior framing: length and category enumeration each contribute substantially (about 38 pp and 30 pp of disclosure reduction, roughly additive), so neither "specificity is what matters" nor "it is just a longer prompt" survives the data. The phrase about the policies differing only in specificity is removed from the paper accordingly. On schema overlap: the short category-specific control (P7) names the sensitive categories without the benchmark's examples or action rules, and still reduces disclosure from 75.0% to 42.5%, evidence that naming the protected categories helps in itself, though far short of the full package's 7.5%.

### Q3. Structural (non-ML) baseline

**We ran one of the baselines the reviewer names, relationship-conditioned data mounting, and we discuss the trade-off it exposes.** Implementation: requester-conditioned folder mounts are enforced *pre-retrieval* on the Notes surface; unmounted content is filtered before search and ranking and never reaches the model, and direct note-ID access re-checks the mount. Results (5 requesters × 200 questions × 3 conditions):

| Notes condition | Policy | Reachability | Utility | P+B disclosure |
|---|---|---|---|---|
| Rel-Policy | requester-specific | all Notes | 78.9% | 12.9% |
| Mounted access | none | profile folders | 64.2% | 9.0% |
| Rel-Policy + Mounted | same policy | profile folders | 65.2% | 5.6% |

Three conclusions, scoped to this experiment. (i) Structural enforcement works where it applies: adding mounting to the same policy cuts disclosure by more than half, from 12.9% to 5.6%. (ii) It is inherently coarse for this problem: enforcement is container-level, while entitlements in cross-boundary delegation are item- and context-level. The same item is legitimate for the investor and protected from the friend (55 of the 99 relationship-conditioned items differ between just those two profiles), and static mounts cannot express purpose-bound access; the measured utility cost, from 78.9% to 65.2%, is the price of that coarseness. (iii) Policy reasoning still adds protection *inside* the mounted scope, from 9.0% to 5.6% at unchanged utility. So the measured relationship is complementarity: structure bounds the worst case; semantic policy handles context-dependence within scope. We additionally tested a pre-tool escalation gate (over 10,000 decisions per phase; details in the reply to JD3a Q4). We do not claim this constitutes a complete RBAC/ABAC engine; field-level redaction, role hierarchies, and post-generation auditing are explicitly future work, and the revision scopes "governance" into its four distinct layers (prompt policy, mounted reachability, contact ACLs, pre-tool escalation) rather than treating them as one mechanism.

### Q4. "Frontier" terminology

**We agree and thank the reviewer for the suggestion; we adopt the more conservative wording** (*security–utility trade-offs across discrete operating points*) throughout, while also densifying the measured points (【TODO: 7】policy packages × multiple models; see General Response C1 and the reply to aP1N Q1). No dense-Pareto claim is made anywhere in the revision.

### Q5. Evaluator robustness for States QA and multi-turn

**Added on three levels.** (i) Judge-independent gold-string scoring reproduces every headline security direction (States disclosure falls from 47.5% to 6.5%; multi-turn semantic/string agreement is 93.7%). (ii) A full re-scoring of the single-step Files QA track by a different-family judge (DeepSeek V4 Flash, temperature 0, 1,058 items, 98.3% verdict agreement; details in our reply to JD3a Q1). The equivalent re-scoring for States QA and multi-turn is not yet complete, and we do not claim judge-family robustness for those two surfaces. (iii) A human audit of stratified disagreements, now including the non-author annotators from Q1 rather than authors only 【TODO】. We will report all three alongside the main tables so readers can see the stability of leakage and over-refusal rates under alternative scoring rules.

### Presentation and limitations

We especially appreciate the concrete feedback on Figure 1; this kind of comment is rare and genuinely helpful. We have redrawn it with larger text and a single explicit cross-boundary path: from the requester agent, through the cross-boundary policy and contact layer, to the target agent, its typed read/write tools, and the owner's private state, with the enforcement layers (prompt policy, mounted reachability, DB-diff evaluation) visually separated. Per the reviewer's limitation note, the revision states explicitly that (a) benchmark labels and relationship-conditioned access norms are author-designed scenario contracts pending the independent annotation study, and (b) the submitted "governance" conclusions concern prompt-level policies plus the structural mechanisms actually tested. We hope the added experiments, the scoped claims, and the framing of this work as a first controlled exploration of cross-boundary A2A delegation, intended to initialize research on a problem that current deployments are already encountering, address the reviewer's concerns, and we welcome further discussion.
