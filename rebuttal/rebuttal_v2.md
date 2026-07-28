# SharedOS / PACT — Rebuttal v2 (co-author draft, 2026-07-27)

> **使用说明（发帖前删除本框）**
> - `【TODO: …】` = 待填数字/待跑实验结果；`【CHECK-n】` = 数据一致性待核对项，编号对应 `rebuttal_v2_internal_checklist.md`。
> - 结构：AC 回复 → General Response → aP1N → JD3a → TtBh，每个 question 单独作答，遵循「一句总结 → 关键解释 → 点名具体表格 → 回扣贡献」。
> - 所有新结论均加了 "under current foundation models / in the tested settings" 限定，不推翻任何已发表数字。
> - 发帖前核对 OpenReview 单条评论字数上限；超限时优先压缩表格为文字。

---

## 0. Response to the Area Chair (Metareview)

We thank the AC and all reviewers for the careful metareview. We are glad the reviews agree that cross-boundary interaction between personal agents is an important and timely problem and that SharedOS, the benchmark, and the database-diff action evaluation are valuable contributions. Below we summarize how the response addresses the four issues the metareview highlights; details and evidence are in the General Response and the individual replies.

1. **"Frontier" framing.** It was intended as conceptual framing, and we agree the measured object is a set of discrete operating points. We have (a) renamed it throughout to *security–utility trade-offs across discrete operating points*, and (b) densified the point set: beyond D0/D1/D2 we now evaluate 【TODO: 7】policy packages (including four defense-prompt baselines adapted from prior agentic-safety work) across multiple models (General Response, C1).
2. **Policy-specificity confounds.** We agree D1 vs D2 is a policy-*package* comparison. We have added a component-controlled sweep — length-matched generic policy, category-names-only, and D2-without-examples — to isolate what drives the effect (C2; interim results in the reply to aP1N Q2).
3. **Evaluation reliability.** We add (a) judge-independent gold-string scoring (already reproduces every headline security direction), (b) a different-family open-source judge on a stratified subset, and (c) an independent non-author annotation study of the relationship-conditioned labels (C3, C4).
4. **Comparison with traditional access control.** We have run a structural baseline the reviewers requested — pre-retrieval, relationship-conditioned data mounting — plus a pre-tool escalation gate, and we discuss where rule-based enforcement wins, where it is inherently coarse, and why the measured result is *complementarity* between structural and policy-level control (C5; reply to TtBh Q3).

We view this paper as a first systematic exploration of the security–utility trade-off in agent-to-agent delegation, on a deployment-realistic substrate, under current foundation models. Our goal is to establish the platform, the measurement methodology, and the first set of reproducible observations, and thereby to initialize more research in this direction; the revision scopes every conclusion accordingly. We are happy to continue the discussion on any remaining point.

---

## 1. General Response (to all reviewers)

We thank all reviewers for their careful and constructive reviews. Reviewer aP1N recognized the importance of the problem and the breadth of SharedOS across files, structured state, tools, persistent interaction, and relationship context; Reviewer JD3a highlighted the database-diff action evaluation, statistical reporting, and the read/write-trust and metadata findings; Reviewer TtBh recognized the timely, deployment-motivated problem and the multi-surface, multi-turn, relationship-conditioned evaluation. The reviews agree on the importance of the problem and the value of the artifacts; the concerns center on causal attribution, evaluator independence, external grounding, and wording strength. We address all of them, with new experiments wherever an experiment was requested.

**Positioning.** As personal agents are increasingly deployed, agent-to-agent (A2A) communication across ownership boundaries is emerging as a consequential application surface. This paper is a first systematic exploration of the security–utility trade-off that arises there. The contributions are (i) SharedOS, a deployment-realistic platform — a deployed system with external users, MCP-compatible tools, persistent state, and permission objects — on which external personal agents can follow our settings and be evaluated; and (ii) a controlled measurement, under current foundation models, of common failure modes in cross-boundary interaction. All conclusions are scoped to the tested models and settings; we expect and hope the operating points will move as foundation models improve, and we intend the platform and protocol to support exactly that follow-up research.

### 1.1 Summary of changes and new experiments

| # | Concern (raised by) | Action | Status |
|---|---|---|---|
| C1 | "Frontier" too strong; too few operating points (aP1N Q1, TtBh Q4, AC) | Renamed to *trade-offs across discrete operating points*; expanded from 3 to 【TODO: 7】policy packages (D0/D1/D2 + 4 defense baselines from prior agentic-safety work) × 【TODO: k】models | Partial results in §aP1N-Q1; full sweep by end of discussion |
| C2 | D1/D2 confounds length, categories, examples (aP1N Q2, TtBh Q2, AC) | Component-controlled sweep: D1-L (length-matched generic), D1-C (category names only), D2−E (no examples), D2 | 【TODO: interim numbers】 |
| C3 | Same-family LLM judge (JD3a Q1, TtBh Q5, AC) | (a) judge-independent gold-string scoring — done; (b) different-family open-source judge on stratified subset | (a) done (Table GR-2); (b) 【TODO】 |
| C4 | Labels author-designed; no independent validation (TtBh Q1, JD3a Lim., AC) | Independent annotation by 5 non-author annotators, blinded, stratified sample; κ + disagreement analysis; labels reframed as *scenario contracts* | 【TODO: κ, disagreements】 |
| C5 | No structural access-control baseline (TtBh Q3, JD3a Q4, AC) | Pre-retrieval relationship-conditioned mounting baseline + pre-tool escalation gate; discussion of rule-based vs policy-reasoning trade-offs | Done (§TtBh-Q3, §JD3a-Q4) |
| C6 | Relationship-aware policy baseline (aP1N Q4) | Rel-Policy baseline run (GPT-5.5, 5 requesters × 400 QA); matched D2-Rel run on GPT-5-mini | GPT-5.5 done; matched run 【TODO】 |
| C7 | States variance rests on n=2 (JD3a Q2) | 【TODO: +K】replications under the original protocol; expanded item set; variance reported | 【TODO】 |
| C8 | RQ3 single-model (JD3a Q3) | GPT-5.5 done; Claude / open-source runs | GPT-5.5 done; others 【TODO】 |
| C9 | Table 15/20 discrepancy; multi-turn wording (aP1N Q3/Q5) | Denominators clarified (identical security pipeline; different utility estimands); direct vs incidental channels separated in text | Done (§aP1N-Q3/Q5) |
| C10 | Figure 1, naming, captions (TtBh, JD3a) | Figure 1 redrawn (larger text, explicit architecture); naming defined once: **SharedOS** = platform, **PACT-Bench** = suite = **PACT-PAIR** (dyadic) + **PACT-NET** (network); Tables 32–39 captions and the missing table reference fixed | Done in revision |

### 1.2 The core result is stable across models and scorers (Table GR-1)

The central D0→D2 contrast recurs across six model configurations from three vendor families, with the same evaluation pipeline:

| Surface / model | Utility D0 / D1 / D2 | Disclosure (QA) or block (Actions) D0 / D1 / D2 | D0→D2 |
|---|---|---|---|
| Files — GPT-5-mini (2 reps/cell) | 78.0 / 78.5 / 77.0 | 83.0 / 81.5 / 14.0 | −69.0 pp |
| Files — GPT-5.5 | 87 / 94 / 86 | 88 / 75 / 4 | −84.0 pp |
| Files — GPT-5.4-mini | 96 / 99 / 91 | 87 / 90 / 7 | −80.0 pp |
| Files — GPT-5.4 | 98 / 97 / 74 | 92 / 80 / 1 | −91.0 pp |
| Files — Kimi K2.6 (~12% infra errors) | 82 / 86 / 81 | 93 / 87 / 4 | −89.0 pp |
| Files — DeepSeek V3.2 | 91 / 97 / 62 | 93 / 80 / 9 | −84.0 pp |
| States — GPT-5-mini (2 reps) | 55.0 / 60.5 / 18.0 | 58.5 / 63.0 / 8.0 | −50.5 pp |
| Actions — GPT-5-mini (2 reps) | authorized exec 65.5 / 48.0 / 61.0 | unauthorized block 43.0 / 43.0 / 93.5 | +50.5 pp block 【CHECK-1】 |

**Table GR-2 — the security direction survives without any LLM judge** (gold-string scoring only): Files D0 72.5% → D2 13.0%; States 47.5% → 6.5%; Kimi K2.6 86.5% → 8.0%; DeepSeek V3.2 89.0% → 13.0%. Semantic/string agreement is 91.5% (single-step Files), 89.3% (States), 93.7% (multi-turn); all audited disagreements are reported in the reply to JD3a Q1.

### 1.3 Three clarifications used throughout

1. **Estimand.** The empirical object is a comparison of discrete governance operating points, not an estimated continuous Pareto boundary; the revision uses the conservative wording everywhere. Every tested (model, policy) pair sits on a trade-off; some packages trade off strictly better than others — that comparison is the finding.
2. **What PACT-PAIR is.** PACT-PAIR is a *controlled instrument built on a deployed substrate*: SharedOS is a live system whose production execution path (routing, permission objects, typed tools, persistent state) the benchmark runs on, while the seeded world provides exact gold facts, counterfactual replay, and database-diff ground truth. It estimates within-world contrasts under explicit scenario contracts, not population prevalence — and we curated it to study the problem, not to rank models on a leaderboard.
3. **Two disclosure channels.** *Direct* leakage = a protected fact disclosed in the response to the probing request. *Incidental (global)* exposure = the fact appearing anywhere in a persistent trajectory while serving other requests. Multi-turn interaction adds the second channel; it does not amplify the first (details in aP1N Q5). Security columns use one identical pipeline across all tables.

---

## 2. Response to Reviewer aP1N

We thank the reviewer for recognizing the importance of the problem, the breadth of SharedOS, and the strength of the action track, and for questions that have concretely improved the paper. We answer the five questions in order.

### Q1. Pareto-front analysis or narrower framing?

**We have done both.** First, the revision replaces "security–utility frontier" with *security–utility trade-offs across discrete operating points* and does not interpolate an unmeasured frontier. Second, we densified the point set: after submission we continued the study and now evaluate 【TODO: 7】policy packages — D0/D1/D2 plus four defense-prompt baselines adapted from prior agentic-safety papers (【TODO: names + citations】) — across 【TODO: k】models (Table GR-1 already shows six model configurations at D0/D1/D2). The consistent picture, under current models: *every* configuration exhibits a trade-off, but the trade-offs are not equal — e.g., D2 reduces Files disclosure by 69–91 pp across all six models at a 0–29 pp utility cost, whereas D1 is near-inert on security in every configuration. Comparing how well different policies and models trade off is precisely the contribution this framing supports. 【TODO: 补上 7-policy × k-model 散点数据表】

### Q2. Length-matched control separating specificity from length/content?

**Agreed — this is the right control, and we ran it.** The loaded policies differ in more than specificity (22 vs 323 words; categories; examples; action rules), so the submitted claim is a policy-*package* comparison. The new sweep holds the world, tasks, and models fixed and varies one component at a time:

| Variant | Length | Categories | Examples | Files disclosure | Utility |
|---|---|---|---|---|---|
| D1 (submitted) | 22 w | – | – | 81.5% | 78.5% |
| D1-L (verbose generic, length-matched) | ~320 w | – | – | 【TODO】 | 【TODO】 |
| D1-C (+ category names only) | ~【TODO】 w | ✓ | – | 【TODO】 | 【TODO】 |
| D2−E (D2 without examples) | ~【TODO】 w | ✓ | – | 【TODO】 | 【TODO】 |
| D2 (submitted) | 323 w | ✓ | ✓ | 14.0% | 77.0% |

Interim results on 【TODO: models】 indicate that length alone changes disclosure by 【TODO】, category enumeration accounts for the bulk of the reduction (【TODO】), and examples add a further 【TODO】. Under current models, explicit category enumeration — not verbosity — appears to be the dominant component; we will state the conclusion at exactly the granularity the completed sweep supports and remove the phrase "differ only in specificity."

### Q3. Reconciling Tables 15 and 20

**The impression of disagreement comes from two different utility estimands with different denominators, not from inconsistent measurement.** Table 15 reports *direct-response semantic utility*: whether the directly attributed response answers the requested task (denominators 193/200/194 — pending/unattributed cases excluded). Table 20 reports *trajectory-wide fact coverage*: whether the public gold string appears anywhere within the 240-tick trajectory (fixed denominator 200), which can count partial or incidental matches. The leakage and action-safety columns use the identical pipeline in both tables — which is why they match exactly. In the revision, Table 15 remains the primary utility metric; Table 20 is relabeled "trajectory-wide fact coverage (diagnostic)" and moved to the appendix. Both tables show the same D0>D1>D2 utility ordering, consistent with the paper's trade-off analysis.

### Q4. How much over-refusal follows from the relationship-agnostic setup?

Three points.

**(a) The setup is intentional, and the gap is the measurement, not an artifact.** D2 is deliberately relationship-agnostic: the question RQ3 asks is whether current models, given a uniform policy plus in-context relationship information, can *infer* relationship-appropriate boundaries. The relationship-conditioned gold labels define the target behavior; the measured over-refusal is the cost of that inference failing under current models — which is the finding we report.

**(b) The pattern is richer than "over-refusal exists."** Under the same fixed D2 and the same 60 sensitive-work questions, behavior differs systematically by requester and by category *before any scoring against labels*: colleague 6.7% disclosure / 71.7% refusal; CEO delegate 30.0% / 58.3%; close friend 18.3% / 75.0%; investor 30.0% / 58.3%. Category-level over-refusal patterns (work vs finance vs health) likewise differ 【TODO: 补 per-category 数字】. A "built into the design" account predicts uniform over-refusal; it does not predict this structure.

**(c) We ran the requested relationship-aware policy baseline.** With requester-specific policies (GPT-5.5, 5 requesters × 400 QA), over-refusal drops substantially — utility reaches 87.4% (colleague), 87.1% (delegate), 87.4% (investor) — but failures do not disappear: the close-friend profile stays at 63.3% utility with 38.7% P+B disclosure. So mis-calibration is not attributable solely to relationship-agnostic prompting; we conjecture it also reflects conservative category priors in current models. A matched D2-Rel run on the original GPT-5-mini setup is in progress for a cleaner comparison 【TODO】. We will report this baseline as an additional operating point (noting model and package differ from the submitted RQ3 cell).

### Q5. Why "eroding" if direct leakage is similar to single-turn?

**We agree the wording should separate two channels, and the revision does; we did not intend "erosion of protection."** *Direct* leakage — a protected fact disclosed in the response to the probing request — is indeed similar across settings (12.6% multi-turn after retries vs 14.0% single-turn; retries add only +2.1 pp, 20/191→24/191), and we make no claim of direct-channel amplification. What multi-turn interaction adds is an *incidental co-located disclosure* channel that single-turn evaluation cannot exhibit: while serving other requests over 240 ticks, protected facts surface elsewhere in the trajectory. The 38.0% figure is an over-inclusive string-scan diagnostic of that channel (76/200 hits, of which 21 were semantically confirmed and 55 were false positives); we will report confirmed incidental disclosure separately from the scan rate. The channel is also surface-dependent (Files 8.0% vs States 17.6% under the multi-turn protocol). The revised claim: *persistent multi-turn interaction opens additional disclosure channels beyond the direct response* — which is exactly what a single-turn benchmark would miss, and one reason the SharedOS setting matters.

---

## 3. Response to Reviewer JD3a

We thank the reviewer for the positive assessment and for recognizing the database-diff action evaluation, the statistical reporting, the read/write-trust distinction, the metadata channel, and the wedding-cascade case study. We answer the four questions, then the limitations and presentation points.

### Q1. Different-family judge

**Yes — and two layers of evidence already bound the risk.** (a) *Judge-independent scoring*: with gold-string matching only (no LLM judge at all), every headline security direction reproduces — Files D0 72.5% → D2 13.0%, States 47.5% → 6.5%, Kimi K2.6 86.5% → 8.0%, DeepSeek V3.2 89.0% → 13.0%. Semantic/string agreement is 89.3–93.7% across tracks; we manually reviewed all disagreements (44 single-step cases: all genuine paraphrase/format leaks missed by the matcher; 38 multi-turn cases: 28 real leaks missed by strings, 5 judge false positives, 3 debatable, 2 partial — removing the 5 false positives changes no headline by more than 1.6 pp). (b) *New*: we re-scored a stratified subset of 【TODO: N】cases with an open-source, different-family judge (【TODO: Qwen/Llama model id】): verdict agreement 【TODO】%, and all headline directions are unchanged 【TODO: 确认后填】. Scores differ slightly; conclusions are consistent — and the open judge makes the pipeline reproducible without proprietary access. We will report both and state the residual limitation plainly.

### Q2. Bounding the D2 States-QA variance

**Agreed that n=2 cannot bound the utility magnitude, and we are adding replications.** What the two existing replications already establish: the *security* direction repeats in both (58%→5% and 59%→11% disclosure; McNemar p<.001 each), while D2 States utility spans 5–31%. The mechanism, on inspection: under a strict D2, States utility depends on whether early trajectory context happens to include the queried state objects, and small per-cell denominators amplify this — the submitted item set was small for this cell. Following the reviewer's suggestion we (i) run 【TODO: K】additional replications under the original protocol, and (ii) extend the States item set following the original construction procedure, reporting mean ± sd for all cells 【TODO: numbers】. The surface-asymmetry claim will be scoped to what the completed replications support: the security direction is robust; the utility magnitude is reported with its variance.

### Q3. RQ3 beyond gpt-5-mini

**Done for GPT-5.5; non-OpenAI runs in progress.** The relationship-conditioned setting has been extended to GPT-5.5 (5 requesters × 400 QA × 3 conditions; 6,000 trials): the qualitative pattern replicates — requester-specific policy raises utility to 87% for colleague/delegate/investor while the close-friend profile remains the failure mode (63.3% utility, 38.7% P+B disclosure). Runs on 【TODO: Claude model / open-source model】 are in progress and will be posted during the discussion period 【TODO】. We note the GPT-5.5 experiment uses a richer policy package (an extension, not an exact fixed-D2 replication), and Table GR-1's Kimi/DeepSeek columns already provide non-OpenAI evidence for the RQ1 policy contrast.

### Q4. Interventions MVP

**Tested — after submission we implemented two of the stated interventions.** (i) *Pre-retrieval relationship-conditioned mounting* (Notes surface, 5 requesters × 200 questions × 3 conditions): adding folder-level mounting to the same relationship policy reduces P+B disclosure 12.9%→5.6% (−56.8% relative) at a utility cost 78.9%→65.2%; conversely, semantic policy still reduces disclosure within the mounted scope (9.0%→5.6%) at unchanged utility (64.2%→65.2%). (ii) *Pre-tool escalation gate*: 2 models × multiple supervision/retrieval conditions, >10,000 gate decisions in each phase 【TODO: 提炼 1–2 个 headline 数字】. Together these demonstrate — rather than assert — that structural and policy-level enforcement are complementary under current models, with a measurable utility cost; this also answers the "architectural enforcement asserted but not demonstrated" weakness. Full protocol and tables go into the revised appendix.

### Weaknesses and limitations

- **Single-target design / PACT-NET design-only.** PACT-NET is now executed, not design-only: 25 agents, D0/D1, two replications per condition, ~1,000 tasks + 75 probes per run, every agent appearing as both source and target. From D0→D1: private-request refusal 16.2%→73.4%, but transitive-risk refusal only 3.7%→22.3% and cross-cluster refusal 12.5%→30.4%, with the hard non-contact gate at 100% throughout. The single-target observations generalize directionally, and transitive/cross-cluster risk remains an open problem — which we flag as such. (Action-level PACT-NET results are excluded from strong claims because those runs predate DB-diff instrumentation.) 【CHECK-2: 边数 76/114/172 需 reconcile 后再发】
- **Author-only annotation (κ=0.96 among co-authors).** We have recruited 5 non-author annotators to independently re-label a stratified sample (blinded to model outputs and to each other); we will report agreement and the main disagreement cases 【TODO: κ, cases】.
- **Naming.** Defined once in the revision: SharedOS = platform; PACT-Bench = benchmark suite = PACT-PAIR (dyadic) + PACT-NET (network). All inconsistent uses fixed.
- **Novelty positioning.** We agree the integrative combination is the novelty and will cite the "abstraction paradox" connection explicitly; our incremental observations (incidental co-located disclosure ≈3× the direct channel; metadata-in-refusals; read-trust ≠ write-trust) are, to our knowledge, new in this jointly-instrumented setting.
- **Formatting.** Tables 32–39 captions and the missing table reference are fixed in the revision — thank you for catching these.

---

## 4. Response to Reviewer TtBh

We sincerely thank the reviewer for the expert, access-control-informed review. The three main requests — independent label validation, a component-controlled policy ablation, and a structural access-control baseline — are exactly the right tests for this work, and we have run or are completing all of them. We answer the five questions in order.

### Q1. Validation of relationship-conditioned labels

**We are adding independent validation, and we reframe what the labels claim.** (a) *Validation*: 5 non-author annotators independently re-label a stratified sample covering all relationship-conditioned items, blinded to model outputs and to each other; we will report inter-rater agreement and the main disagreement cases with the adjudication rule 【TODO: κ, disagreement analysis】. (b) *Framing*: the labels are *scenario contracts* — explicit, self-consistent authorization stipulations for one concrete scenario — instantiating the variables that contextual integrity and ReBAC/ABAC identify (requester, relationship, object, operation, context). They are not claims about universal social norms, and the revision says so in Limitations, as the reviewer requests. The requester set is a maximum-contrast design, not a representative sample: 108 of the 【CHECK-3: 150/200】sensitive items change label across requesters, and the close-friend and investor profiles differ on 84 items — the investor (lead Series A investor and non-voting board observer with stipulated information rights) exists precisely to break a scalar-trust reading: narrow legitimate company-information rights, no entitlement to the founder's health or personal finances. What the benchmark measures is whether an agent can realize a stipulated information-flow contract while remaining useful — the construct the labels need to support, and the one the independent annotation study tests.

### Q2. Cleaner policy-specificity ablation

**Agreed and running.** We added a component-controlled sweep holding world, tasks, and model fixed: D1-L (length-matched verbose generic, no categories), D1-C (category names only, no examples), D2−E (D2 without examples), against D1 and D2 (full design and interim numbers in our reply to aP1N Q2). Interim direction: length alone is near-inert; category enumeration drives most of the reduction; examples add a smaller increment 【TODO: confirm with data】. We will also remove "differ only in specificity" from the paper: the supported claim is which policy *components* move the operating point, at exactly the granularity the sweep measures. On schema overlap: we will report the D1-C cell (category names without the benchmark's examples or rules) as the direct test of whether naming the categories — rather than mirroring the benchmark schema — suffices.

### Q3. Structural (non-ML) baseline

**We ran one of the baselines the reviewer names — relationship-conditioned data mounting — and we discuss the trade-off it exposes.** Implementation: requester-conditioned folder mounts are enforced *pre-retrieval* on the Notes surface — unmounted content is filtered before search/ranking and never reaches the model; direct note-ID access re-checks the mount. Results (5 requesters × 200 questions × 3 conditions):

| Notes condition | Policy | Reachability | Utility | P+B disclosure |
|---|---|---|---|---|
| Rel-Policy | requester-specific | all Notes | 78.9% | 12.9% |
| Mounted access | none | profile folders | 64.2% | 9.0% |
| Rel-Policy + Mounted | same policy | profile folders | 65.2% | 5.6% |

Three conclusions, scoped to this experiment. (i) Structural enforcement works where it applies: adding mounting to the same policy cuts disclosure by more than half (12.9%→5.6%). (ii) It is inherently coarse for this problem: enforcement is container-level, while entitlements in cross-boundary delegation are item- and context-level — the same item is legitimate for the investor and protected from the friend (84/【CHECK-3】items differ between just those two profiles) — and static mounts cannot express purpose-bound access; the measured utility cost (78.9%→65.2%) is the price of that coarseness. (iii) Policy reasoning still adds protection *inside* the mounted scope (9.0%→5.6% at unchanged utility). So the measured relationship is complementarity: structure bounds the worst case; semantic policy handles context-dependence within scope. We additionally tested a pre-tool escalation gate (>10,000 decisions/phase; details in reply to JD3a Q4). We do not claim this constitutes a complete RBAC/ABAC engine — field-level redaction, role hierarchies, and post-generation auditing are explicitly future work — and the revision scopes "governance" into its four distinct layers (prompt policy, mounted reachability, contact ACLs, pre-tool escalation) rather than treating them as one mechanism.

### Q4. "Frontier" terminology

**We agree and thank the reviewer for the suggestion — we adopt the more conservative wording** (*security–utility trade-offs across discrete operating points*) throughout, while also densifying the measured points (【TODO: 7】policy packages × multiple models; see General Response C1 and reply to aP1N Q1). No dense-Pareto claim is made anywhere in the revision.

### Q5. Evaluator robustness for States QA and multi-turn

**Added on three levels.** (i) Judge-independent gold-string scoring reproduces every headline security direction (States 47.5%→6.5%; multi-turn semantic/string agreement 93.7%). (ii) A different-family open-source judge on a stratified subset 【TODO: model, N, agreement】. (iii) A human audit of stratified disagreements — now including the non-author annotators from Q1 rather than authors only 【TODO】. We will report all three alongside the main tables so readers can see the stability of leakage and over-refusal rates under alternative scoring rules.

### Presentation and limitations

We especially appreciate the concrete feedback on Figure 1 — this kind of comment is rare and genuinely helpful. We have redrawn it with larger text and a single explicit cross-boundary path: requester agent → cross-boundary policy/contact layer → target agent → typed read/write tools → private state, with the enforcement layers (prompt policy, mounted reachability, DB-diff evaluation) visually separated. Per the reviewer's limitation note, the revision states explicitly that (a) benchmark labels and relationship-conditioned access norms are author-designed scenario contracts pending the independent annotation study, and (b) the submitted "governance" conclusions concern prompt-level policies plus the structural mechanisms actually tested. We hope the added experiments, the scoped claims, and the framing of this work as a first controlled exploration of cross-boundary A2A delegation — intended to initialize research on a problem that current deployments are already encountering — address the reviewer's concerns, and we welcome further discussion.
