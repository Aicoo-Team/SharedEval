# Rebuttal TODO

2026-07-29。从 `rebuttal_v3.md` 的占位符整理，并按 7/27–29 的新发现更新。

> **协作规则（因重复劳动而加）**：Claude 与 Codex 并行工作。**做完任何一项，立刻在本文件勾掉并写明产物路径**，再去做下一件。
> E4 已经因为没有及时记录而被重复跑了一次（Codex 未先检查 `rebuttal/runs/e4/` 就重跑了一个较弱版本，浪费一轮 + 约 \$1.17）。
> 开工前先读本文件；本文件是唯一的进度真相来源。

### 交付范围冻结（2026-07-29 15:40）

**2026-07-30 用户显式扩容：** 在原先“尽快形成可发 rebuttal”的最低范围之外，E1、E5 与 seed-verified GLM E6 corrected rerun 均已获准执行；Q4(b) 仍由 Claude 独立负责，Codex 不触碰。扩容实验必须继续满足 frozen plan、同题集、world/model provenance、immutable attempt 与固定分母要求。

目标是 **3–4 小时内形成可发 rebuttal**，不再把所有“有时间最好补”的实验当作发帖前阻塞项。

**必须完成：**

1. E6 GLM relationship 跑完 R0–R4，并用既定 rubric 完成 judge pass。
2. 用同一 canonical 30-question set 补齐 DeepSeek/GLM 的 P0→P2 responder 对照；所有 completion 必须过 provenance gate。
3. 修复 responder/runtime 改动范围内唯一的 TypeScript 类型错误并重新检查。
4. 完成 P2 的 reviewer-facing 写作与呈现修改。
5. 将已经完成的 E2、E4 和 CHECK-1–4 数字完整填入 rebuttal。

**可选，不阻塞发帖：**

- Kimi/Qwen defender cells：允许当前已经启动的 Qwen P2 自然完成，但不为凑四个模型重启另外三格。
- E1：只在一个固定 model pair 上展示 7–8 个 policy operating points；不跑 `7 policies × k models` 笛卡尔积。
- E5 States replication、E4 multi-turn re-judge：时间不足时收窄 claim 并写明 limitation。
- E7：外部标注回收是外部依赖，未返回时不能捏造 agreement，也不应无限期阻塞 rebuttal。

**本轮明确不启动：** Grok、GLM/DeepSeek diagonal cells，以及 `next_batch.sh` 中的任何 scope-expansion cell。

---

## P0 — 不做完就不能发帖

### 1. 论文正文的 cross-model 表述（新增，v3 写完后才发现）

`main.tex` 把 requester 说成了 evaluated model。**数字没错，表述错了**，五处要改：

- [x] L119 contribution 表：已拆成 `Requester models`（6 families）+ `Responder model`（gpt-5-mini, fixed）两行
- [x] L171 evaluation scope：已改为 "we vary the **requester** agent…"，并写明 responder 恒为 gpt-5-mini、此设计**不能**测出 policy 效应跨 defender 的稳健性
- [x] `tab:crossmodel`：caption、`\paragraph{}`、表头列名全部 Model → **Requester**；caption 补注 "the responder is gpt-5-mini in every row"
- [x] **L312 那句无支撑的 claim 已删除**，改为：排除的是 requester 侧 artifact，不是 provider 侧；后者需要变 defender 才能测
- [x] L1063 附录：`Cross-model validation` → **Cross-requester validation**，并写明 responder 全程固定

> Lark 表已改对（`Cross-requester single-step sentinel`），论文还没改。JD3a 的 review 证明 reviewer 就是按字面理解的。

### 2. 数据一致性核对

- [x] **CHECK-1 已解决**（2026-07-28 逐格复算）。**两套数字都对，是两个不同批次 + 两种分母**：
  - GR-2 组 `65.5/48.0/61.0`、block `43.0/43.0/93.5` = `research/runs/v2/eval_output/eval_actions.json`（g401–g406），分母固定 200（每 policy 两 rep，各 100 authorized + 100 unauthorized），取 `utility.correct` / `safety.correct`。已精确还原：131/200、96/200、122/200。
  - A1 组 `55.0/54.0/58.7`、block `31.5/35.1/90.0` = `thesis/results/layer0_single_step/actions_preliminary_analysis.md`（更早批次），分母是 **authorized 任务数**（M2 为 143），且 system/tool errors（M2 占 15.4%）不计入分子但留在分母。
  - 同一文件还有第三套 `goldPassed` = 35.5/30.5/34.0，是严格口径：不仅执行了，且结果匹配 gold check。
  - **不改数字，改呈现**：rebuttal 只保留一套（建议 GR-2，因为分母固定、口径最易解释），并在脚注写明另一套的定义。**绝不能两套并排出现**——这正是 aP1N 抓 Table 15/20 的同一个坑。
- [x] **CHECK-2 已解决**（2026-07-28 从 `research/configs/pact_net/world_design/contact_graph.json` 实算）。**权威值是 114 有向边 / 58 无向对**：
  - **114** = 25 个 agent 的 contact list 求和，`seed_pact_net.ts:282` 实际按它建图 → **以此为准**
  - **58** = 无向去重后的 pair 数；其中 **112/114 条有向边是双向对称**的（仅 2 条单向），与 description "bidirectional edges unless noted" 一致
  - **76** = 同文件 `graph_stats.total_edges`，**陈旧字段**，与 `contacts` 对不上（`avg_contacts: 6.08 × 25 = 152` 也对不上）→ 待修
  - **172** = `README.md` 的 "Contact graph edges | 172 directed" 与 "should_answer 172" → 待修
  - 连带作废：`PACT_NET_DESIGN.md:300` 那句 "contact graph has 76 edges, so the maximum is 76 directed pairs" 的推论
  - **rebuttal 里如需提边数，写 114 directed edges over 25 agents（58 undirected pairs）**
- [x] **CHECK-3 已解决**（2026-07-28 直接从 `relationship_label_matrix.json` 复算）。**v3 里两处数字都是错的**：
  - 真实规模：matrix **99 行**（Q101–200，Q125 在 2026-07 审计中被移为 work_public）。Q1–200 是 100 public + 100 sensitive。
  - 跨 requester 变化的行：**70/99**（v3 写的是 108）
  - R3 close friend 与 R4 investor 判定不同的行：**55/99**（v3 写的是 84/200 和 84/150 两个版本）
  - 分类构成：sensitive_work 29、personal_finance 25、personal_health 20、personal_relationships 25
  - **必须全文替换**，涉及 TtBh Q1 和 Q3 两处。这是唯一一个 v3 里数字本身错了的地方（其余是口径问题）。
- [x] **CHECK-4 已解决**：judge 确实是 gpt-5-mini（六个 offline eval 脚本全部硬编码），JD3a 说对了，不能反驳，只能承认+补异族 judge（见 E4）
- [x] **Metric_Definition 已更正**：Lark 表现在明确写明分母固定、error/no-response 不排除且按 utility failure 计；数字未改。Kimi 三行受影响最大（82% vs 排除后 98.8%）。

### 3. 非作者标注（E7）— **回收完成，κ 已入 rebuttal（2026-07-30，Claude）**

- [x] 五份全部回收并通过第二轮验收（Hanxiang 的 QC 报告：抄袭指纹全净、五份采纳、数据按 7/29 交付版冻结）。产物归档 `annotation/filled/qc_round2/`（报告 + 458 行分歧表 + 100 格 majority≠gold 表，行数已核对）
- [x] κ 已填入 v3 四处（C4 状态、JD3a limitations、TtBh Q1 含表格、TtBh Q5(iii)）：**5 人口径 QA 0.654 / REL 0.501 / ACT 0.491**，并按报告并列 4 人 external-only 敏感性口径
- [x] ⚠️ **措辞修正**：原稿写 "5 non-author annotators"，但 D（Hanxiang）是 author-track——已改为 "four external, one project-affiliated" 并双口径报告。**发帖前请你确认这个表述**，这是诚实性问题不是风格问题
- [x] ACT κ 未达 0.6 已如实写出，并附结构性归因（三种反向偏差 + 三个指南缺口）；100 格 majority≠gold 按"gold 冻结、仅作裁决记录"写入
- [ ] 458 行 `adjudicated_label` 列裁决（lead/author 侧动作，不阻塞发帖）
- [ ] 写 adjudication notes（每个 majority ≠ author 的 cell 一句话）

---

## P1 — 补实验

### 4. E4 异族 judge — **single-step Files 已完成**

- [x] **已跑完，实测 $0.0706**。用 DeepSeek V4 Flash（temperature 0）重打分 6 个正式 run（D0/D1/D2 × 2 reps）的**全部** 1,058 条可判条目——不是抽样。judge prompt 从 `eval_single_step.ts` **逐字复制**，只换模型，确保"换 judge"与"换 rubric"不混淆。
  - 整体一致率 **98.3%**（utility 98.6% / security 98.0%）
  - 头条数字保持：disclosure D0→D2 原 judge 88.1%→14.1%，异族 judge 88.6%→14.1%；D1 依旧无效（89.4% vs 90.6%）
  - 18 处分歧中 9 处改变 disclosure 分类，净 +3 leak，不改变 ordering 或任何结论
  - provenance：1,058/1,058 由 `deepseek/deepseek-v4-flash` 实际服务（从响应体读回，非请求值）
  - 产物：`rebuttal/runs/e4_cross_family_judge.py`、`rebuttal/runs/e4/verdicts.jsonl`、`rebuttal/runs/e4/full.log`
- [x] 已填入 `rebuttal_v3.md` 四处（General Response、C3 状态栏、JD3a Q1、TtBh Q5）
- [x] **States 异族 judge 完成（2026-07-30；修正此前误判）**：此前只检查了 `eval_results.json`，因而错误断言 States 没有 LLM-judge 基线；权威产物 `thesis/results/layer0_single_step/ss_todo_eval_llm.json` 实际包含 g401–g406 的 1,200 条逐题 gpt-5-mini verdict。原始/续跑 response 与该产物按 questionId 严格配对后，DeepSeek V4 Flash（temperature 0；提交 evaluator 的逐字 rubric）全量重判 **1,030/1,030 条可判文本**，0 errors，**1,030/1,030 由响应体确认 served model**，成本 $0.0718。整体一致率 **91.6%**（utility 88.8% / security 94.3%）；D2 的方向与结论保持：可判分母上的 utility 21.6%→20.4%，disclosure 7.5%→5.7%，仍远低于 D0/D1。注意这两列是 judge-agreement 的 gradable-only denominator，**不能替代论文把 no-response 计为失败的固定 200 分母 headline rates**。87 处分歧以 `correct→incorrect` 为主（50 例），说明 DeepSeek 对 States utility 更严格；应诚实表述为“核心 ordering 稳健，但 States scoring 比 Files 更 judge-sensitive”。产物：`PACT/rebuttal/runs/e4_states/verdicts.jsonl` 与 `full.log`。
- [ ] **multi-turn re-judge（可选）**：需从各 run 的 `chat_history.json` 重建全文输入；当前不阻塞发帖。
- ⚠️ **Codex 曾重复跑过一个较弱版本**（585 抽样 + 改写 rubric），已自行撤回，其 `e4-*-600.json` 标记为 exploratory，不得进入论文

### 5. E2 D1/D2 成分消融（三方点名，最救 claim）

- [x] **E2 原始数据完成（2026-07-29 05:20）**：P1/P2/P6/P7 全部 **60/60**，merged 产物在 `pulse/research/runs/rebuttal/6b656e42874d_resume/policy_*/results.merged.jsonl`。待 judge pass 出消融表数字
- [x] **消融表已填进 rebuttal（2026-07-29 07:15，commit d7579f2）**：judge pass（gpt-5-mini，与论文同 judge）跑完 240 行。disclosure P1 75.0 / P7 42.5 / P6 35.0 / P2 7.5；utility 90/90/85/65。**真发现：length（~38pp）与 category（~30pp）同量级且近似可加，推翻了草稿"specificity 主导"的预设**。AC 第 2 点、C2 行、aP1N Q2、TtBh Q2 四处已按数据重写
- [x] 回应 aP1N Q2、TtBh Q2、AC —— 已写入，含全部 caveat（单 rep、新 60 题子集、P6/P7 为 draft-control 对照）
- [x] 🚨 **defender 轴的题集错配已通过 canonical rerun 解决**（问题于 2026-07-29 14:47 发现；修复于 2026-07-30 完成）
  - 两边目录名都带 `qset30`，且前 10 个 id 完全一致（1,6,11,17,22,27,32,37,43,48），所以一直没被发现。**第 11 个起分叉**：
    - Claude（`or_claude_lane`）：…53,58,64,69,74,79,84,90,95,100,101,104,107,111,114,117,120,124,127,130
    - Codex（`f1d964b29c2e`）：…101,104,107,111,114,131,134,136,139,142,156,158,160,162,164,176,179,181,184,187
    - **交集只有 15/30**。直接把 DeepSeek/GLM 和 Kimi/Qwen 放进同一张表 = 拿不同题目比不同模型，把 defender 身份和题目难度混在一起
  - **每个模型自己的 P0→P2 delta 仍然有效**（同模型的两格用同一子集），坏掉的只是跨模型比较
  - 发现方式：provenance 复算时加了 questionId 过滤，同一格从 28/30 掉到 13/30，两个数对不上才查出来
  - **Codex 侧还不完整**：p0-deepseek 28/30（缺 6,27）、p0-glm 28/30（缺 134,156）、p2-deepseek 25/30（缺 1,11,139,158,176）、**p2-glm 在该 plan 里根本不存在** → GLM 没有 P0→P2 delta，而这正是 defender 轴要证的东西。旧 plan `7b99d045b3ec` 有一个 p2-glm52，但它属于污染后归档的那批，provenance 未确认前不能混用
  - 这些在 8bb8/8bb9/8bba，无活进程但**未完成 = 铁律 0 的 owned**，Claude 不碰，留给 Codex
  - **当前处理决定**：不再补 Claude lane 的 15 题并拼接历史尝试。必须从 frozen plan、canonical 30-question set 和 provenance-valid artifacts 得到可比较结果。
  - **正式范围收缩为 DeepSeek/GLM 的 P0→P2 对照**。Kimi/Qwen 只作可选补充；当前已经启动的 Qwen P2 可以自然完成，但不为凑四模型重启其余三格。
  - ⚠️ **教训（今天第 4 次）**：qwen-P2 曾显示 30/30 行、E1-P0 曾显示 60/60 行且进程已退出，都是"完成"的样子，实际分别只有 28 和 55 条 provenance-valid。**完成判定一律走 provenance 复算，绝不看 `wc -l`**
- [x] **Grok 本轮不启动**：模型通路可用，但它扩大范围且不是 reviewer 要求的最低充分证据。
- [x] **GLM/DeepSeek diagonal cells 本轮不启动**：属于后续扩展，不阻塞 rebuttal。
- [x] **DeepSeek defender canonical 对照完成（2026-07-30）**：P0/P2 各 30/30，同一 canonical question set；7 个失败题以独立 immutable attempts 补齐后，由 `finalize_defender_cells.py` 按 questionId 合并并通过 policy、question、response、error、contact-error、requester/responder provenance gate。产物：`pulse/research/runs/rebuttal/finalized_defender_20260730/deepseek/`。同一 gpt-5-mini rubric 的 60/60 judge 完成：utility P0→P2 **100%→100%**（10/10→10/10）；disclosure **90%→5%**（18/20→1/20）；explicit refusal **5%→95%**（1/20→19/20）。这是单次 30 题 canonical subset，不与不同 question set 的 Kimi/Qwen 绝对值横比。
- [x] **GLM defender canonical 对照完成（2026-07-30）**：P0/P2 各 **30/30**，与 DeepSeek 使用完全相同的 canonical question set；P0 的 Q134/Q156 由 immutable retries 补齐，P2 为单一完整 attempt。`finalize_defender_cells.py --model glm` 已通过 policy、question、response、error/contact-error 与 requester/responder provenance gate；同一 gpt-5-mini rubric 的 **60/60** judge 退出码为 0。utility P0→P2 **90%→100%**（9/10→10/10）；disclosure **80%→5%**（16/20→1/20）；explicit refusal **15%→95%**（3/20→19/20）。DeepSeek/GLM 同题集表：`pulse/research/runs/rebuttal/finalized_defender_20260730/defender_table.md`。

### 6. E1 operating points 扩充（已批准；不得扩成 policy × model 全矩阵）

- [x] **26 个 provenance 缺口全部补齐并严格 finalization（2026-07-30）**：P0 Q167、P3 9/9、P4 10/10、P5 6/6 的 frozen-plan 补跑全部 `strictGatePassed=true`。`finalize_e1_operating_points.py` 以 E2 P1 的 60 个 questionId 为 canonical reference，按 questionId 合并 immutable attempts，并对 P0/P3/P4/P5 各 **60/60** 执行 policy、exact question、response、error/contact-error、requester/responder provenance gate；四格全部通过。产物：`pulse/research/runs/rebuttal/finalized_e1_20260730/`。同一 gpt-5-mini rubric 的 240-row judge 已 detached 启动；完成后与已判分的 P1/P2/P6/P7 组成合法 8-policy operating-points table/scatter。
- [ ] 确定 7–8 个 policy package 的名称 + 文献引用（固定一个 model pair）
- [x] **单一 model pair 的 8-policy operating points 完成（2026-07-30）**：同一 60 题集、同一 gpt-5-mini requester/responder 与 judge。utility / disclosure：P0 95.0/87.5，P1 90.0/75.0，P2 65.0/7.5，P3 85.0/12.5，P4 80.0/5.0，P5 65.0/5.0，P6 85.0/35.0，P7 90.0/42.5。产物：`pulse/research/runs/rebuttal/finalized_e1_20260730/operating_points.{md,csv,png,svg}`；明确表述为 eight discrete operating points，不称 dense frontier。defender robustness 继续单独成表，不做 policy × model 笛卡尔积。
- [ ] 回应 aP1N Q1、TtBh Q4

### 7. E5 States replication（已批准并排队）

- [ ] **原协议复现计划正在运行（2026-07-30）**：plan `a682b8a7fc7c3663d59859e22310efa3e3252aa402c2cddfdbd9e8860ab5cb87`，P2、baseline gpt-5-mini requester/responder、Q201–Q400、groups 3540–3542、3 个完整 200-question trajectories、并发 3，共 600 calls。与原 g403/g406 合并后 D2 从 n=2 提升到 n=5。当前原始进度 **41/200、27/200、39/200**；99/107 行 response/model provenance 正确。transient Azure failures：r1 Q207/Q228/Q231、r2 Q202/Q205/Q214/Q224、r3 Q214，主批次结束后必须在新 attempts 中仅重试这些失败题。每格仍必须达到 200 unique provenance-valid rows、100 notes + 150 todos seed evidence 与 0 engine errors；任何空世界或题集错配直接作废。
- [ ] 解释 variance 机制（early-context 是否含被查 state 对象 + 小分母）
- [ ] 若时间不足：收窄 surface-asymmetry claim，明确 n=2 与高方差，不仓促换 protocol

### 8. E6 RQ3 非 OpenAI

- [x] **阻塞 bug 已修（2026-07-29 13:12，commit 6e11f6c34）**：`run_d3_relationship.ts` 的 `createModel` 走的是 `getAzureProviderConfig`，**Azure 专用**。传 OpenRouter id 时 baseURL 正则匹配不上，回落到默认 Azure resource——也就是说 `--model z-ai/glm-5.2` **根本不会跑 GLM**，但产物会全程标成 GLM。这是"CLI 参数存在 ≠ 生效"的第四例，且会**凭空捏造 RQ3 的非 OpenAI 结论**。已改为走 `resolveExperimentModelRuntime()`（按 registry 推断 provider、未知 id 直接抛错），并在开跑时打印解析后的 provenance
- [ ] 🚨 **此前“E6 无需 seed group”的判断错误**：不走 `contact_agent` 只说明不需要联系人协商，不代表不需要数据。`run_d3_relationship.ts` 仍通过 `createFlatToolsWithContext(HOST_USER_ID, ...)` 从 research DB 读取 Alex 的 Notes/Todos；因此必须为该 data namespace 完整 seed，并在调用模型前验证数据量。
- [x] **修复已验证跑通（2026-07-29 13:26）**：冒烟 D3 × R1 × GLM × Q101-103 打印 `provider=openai-compatible`，3 例 0 error。这行 provider 就是"没走 Azure 回落"的判据
- [x] **跑起来才发现的第二个 bug（同日修，commit c2293b0cd）**：run id 直接拼接原始 model id，`z-ai/glm-5.2` 的斜杠把产物切成 `research/runs/d3_D3_R1_z-ai/glm-5.2_.../`，**分析脚本的扁平 `d3_*` glob 会静默漏掉整个 run**。已改为路径用 slug、`summary.json` 保留真实 id。两次冒烟已归档进 `e6_smoke_glm/artifacts/`，防止 1–3 题被当数据
- [ ] 🚨 **2026-07-30 data-mount audit invalidated the first GLM run**：500 条调用均配置并路由到 OpenRouter 的 `z-ai/glm-5.2`，但旧 trace 没有逐调用记录 provider 返回的 served-model id，因此不能把它们表述为 500 条独立确认的 served-model observations。更关键的是，固定 `HOST_USER_ID` 在 research DB 中只有 10 个 folders、**0 notes**。运行日志里 387 次 Notes 搜索全部为 0 hit，并出现 370 次 “You have no notes yet”；合法访问响应也明确写着 “there are currently no notes stored.” 这批结果不能用于判断 relationship-conditioned security/utility。
- [ ] **原 judge pass 仅保留为失败审计，不得进入 rebuttal**：judge 按既定脚本完成，但它只能判断输出是否含 gold facts，不能发现底层 workspace 为空。原表如下：

  | req | GLM leak (n) | GLM block | GLM util | gpt-5.5 leak | gpt-5.5 util |
  |---|---|---|---|---|---|
  | R0 | **0.0%** (0/99) | 100% | –（0 题） | 1.1% | 18.7% |
  | R1 | **0.0%** (0/92) | 100% | 0.0% (0/5) | 7.4% | 96.2% |
  | R2 | **0.0%** (0/65) | 100% | 0.0% (0/24) | 3.0% | 97.7% |
  | R3 | **0.0%** (0/77) | 100% | 7.1% (1/14) | **37.8%** | 70.8% |
  | R4 | **0.0%** (0/85) | 100% | 11.1% (1/9) | 14.8% | 98.2% |

  - ❌ `block_rate = (safe + refused) / security_total = 1 - leak_rate`。所以 “0% leak / 100% block” 是同一个量写了两遍，不表示 100% 明确拒绝。原 GLM verdict 实际包含 safe non-answers（R0–R4：11/9/4/27/12）与 explicit refusals（88/83/61/50/73）。
  - ❌ “0/418 leak、100% block、utility 0–11%”以及由此推导的 model-dependent operating-point 结论全部撤回。
- [x] **rebuttal_v3 中无效 GLM 数字已移除（2026-07-30）**：C8 改回 corrected run pending；JD3a Q3 仅保留 GPT-5.5 已验证结果，并为 seed-verified GLM rerun 留位。
- [x] **judge 输出口径已修正（2026-07-30）**：`eval_llm_judge.ts` 不再输出容易误读的 `block_rate`，改为分别输出 `leak_rate`、`safe_nonanswer_rate`、`explicit_refusal_rate` 与 `non_disclosure_rate`；其中最后一项明确只是前两类非泄露结果之和，不能作为第二条独立安全证据。
- [x] **当前 rebuttal 不再重跑 GLM E6（2026-07-30 scope decision）**：JD3a Q3 要求 GPT-5.5 *or* another non-OpenAI model；现有 GPT-5.5 已完成 5 requesters × 400 QA × 3 conditions = 6,000 trials，足以回答该问题。GLM corrected rerun 降为论文后续可选实验，不再阻塞 rebuttal。若未来重跑，仍必须满足：fresh namespace；Notes count gate（预期 100）；两道 L 题检索探针；逐 trace world/model provenance；分别报告 leaked / safe / explicit refusal / system error。
- [ ] **上述 scope decision 已被用户于 2026-07-30 显式覆盖，corrected GLM E6 主 collection + base judge 完成，22-pair retry queue 正在运行**：seed gate 与 R2 legitimate-access probe 均通过；R0–R4 各 **100/100**，全部记录 `notes_at_start=103`、固定 namespace 与 `z-ai/glm-5.2` openai-compatible provenance。usable/error：R0 100/0、R1 99/1、R2 91/9、R3 92/8、R4 96/4，共 **478 usable + 22 failed**。同一 gpt-5-mini rubric 的 base judge 五格均 exit 0；当前 provisional 结果（错误行不进 judge 分母）为 R0 leak 1/100；R1 utility 6/6、leak 4/93；R2 utility 25/26、leak 0/65；R3 utility 15/15、leak 25/77；R4 utility 8/9、leak 10/87。`pact-e6-glm-retries` 仅对这 22 个 `(requester, questionId)` 使用 fresh immutable attempts，逐条执行 world/namespace/model/response/error/judge gates，最多 5 次；不修改工具契约、不覆盖 base artifacts。首轮 **16/22** pairs 已通过全部 gates；R4 Q129 在第 5 次通过。未完成的 R2 Q117、R3 Q113/Q125/Q129、R4 Q104/Q118 已进入第二轮 fresh immutable retries，16 个成功 pair 会由 resume gate 自动跳过。全部补齐后才按 questionId/provenance finalization 并发布正式分母。
- [ ] 注：区域限制，Claude/Gemini 在 OpenRouter 403；开源家族现有 DeepSeek / GLM / Kimi / Qwen / Grok 五个，JD3a 原话 "Claude **or other open-source models**" 字面已满足
- [x] 回应 JD3a Q3：仅使用已验证的 GPT-5.5 6,000-trial replication；无效 GLM 数字及 corrected-run placeholder 均已从 rebuttal 删除

### 9. 补零散数字 — **全部处理完（2026-07-30，Claude）**

- [x] **per-category 数字已入 Q4(b)**，但用的是"全敏感项拒绝率"口径（personal 三类跨 requester 恒定 ~90-100%，sensitive_work 随 requester 波动 17pp），与 `l1_qa_eval_llm.json` byCategory 精确对账。**刻意不报 "L 项 per-category over-refusal"**：与 label matrix join 后每格分母只有 0–12，且与已发表 O-Ref 分母（含 Q201-400）不可调和——报了就是又一个双分母陷阱
- [x] **Escalation headline 已入 JD3a Q4(ii)**（源 `research/runs/escalation/phase2_relationship/all_conditions_eval.json`，11,659 个 gate 决策）：全部 8 个条件格 pstop 87.7–94.4%；监督比例 10%→30% 把合法放行 69.8%→91.0%（gpt-5-mini）/ 67.1%→87.4%（GPT-5.5）而保护基本不动，附 4 行小表
- [x] **D2-Rel matched run：查无产物，已改保守表述**（Q4(c) 与 C6 行均改为 "future work, not claimed"，符合 Codex 冻结报告的要求）

### 9b. 全文数字审计（2026-07-30，E6 空世界事故后的全面复查）

**已修（commit 见本次）：**
- [x] 🐛 aP1N Q2 "65.0% with **29 of 60** refusals" 分子分母错配：产物（`e2_eval_input/eval_output/eval_single_step_gpt-5-mini.json`）里 29 是 **security 侧 29/40**，utility 侧另有 5/20 refused，总拒绝 34/60。已改写为分开陈述（5/20 legitimate refused + 29/40 sensitive refused as intended）
- [x] 🐛 同一实验两套披露率并排且无解释：JD3a Q1 的 88.1%（=163/185 可判条目）vs GR-1 的 83.0%（=固定 200 分母）。**正是 aP1N 抓 Table 15/20 的同款坑**。已在 Q1 加一句分母说明
- [x] 🐛 aP1N Q1 "utility cost between **0** and 29 pp"：GR-1 实际最小是 1pp（六模型 D0→D2 utility 差 1/1/5/24/1/29）。改 "between 1 and 29 pp"

**复算通过（分子分母到原始产物）：**
- E4：1,058/1,059 ✓；原 judge 88.1/14.1、D1 89.4 = 163/185、26/184、161/180 ✓；异族 judge 88.6/90.6/14.1 ✓
- E2 表：75.0/42.5/35.0/7.5 与 90/90/85/65 ✓；可加性 30/38/5pp、4.7× ✓
- mounting：12.9%（54/418）、5.6%（23/412）、78.9%、65.2% ✓；**56.8% 相对降幅从原始计数复算精确成立**（四舍五入值会得 56.6，是 rounding 假警报）
- CHECK-3 修正值（70/99、55/99）两处均在，陈旧的 108/84 已清零 ✓；114/58 边数 ✓；Q5 的 20/191→24/191、76=21+55 ✓；GR-1 行内 delta（69–91pp）✓；JD3a Q2 的 5–31% ↔ 论文 26pp ✓；6,000 trials ✓
- [ ] ⚠️ **aP1N Q4(b) 四组数字（colleague 6.7/71.7、delegate 30.0/58.3、close friend 18.3/75.0、investor 30.0/58.3）源产物未找到**：形状是 x/60（4、43、18、35、11、45），从 v1 一路继承，从未对过账；且 "the same 60 sensitive-work questions" 措辞与 CHECK-3 的 sensitive_work=29 行冲突（若指 60 题敏感子集应改措辞）。**发帖前必须找到产物或删掉这组数**
- [ ] ⚠️ 未复算（源自论文正文，风险较低但没验）：GR-2 gold-string 组（72.5→13.0 等）、44/38 分歧审计计数、Files 8.0% vs States 17.6%

---

## P2 — 写作与呈现

> 2026-07-29 23:1x（Claude）：除 Figure 1 外七项已在 `pulse/thesis/neurips/main.tex` 落实（**注意 thesis 是嵌套独立 git 仓库**，commit `9a3eda5` 在它自己的历史里）。验证方式全部为产物级：正则清零 + 悬空 `\ref` 为 0 + 每个 table 环境都有 caption + diff 中百分数/pp token 集合完全一致（数字零改动）。

- [ ] Figure 1 重画（字号加大 + 明确架构）— TtBh 专门提，属于"送人情"，必须真改。`figures/shared_os_overview.png` 仍是 5 月 6 日的旧文件，**这是 P2 唯一剩下的活**
- [x] 命名统一（commit 9a3eda5）：L380 段改为一次性定义 SharedOS=平台、PACT-Bench=套件=PACT-PAIR+PACT-NET；10 处 `PACT-Net` 规范为 `PACT-NET`
- [x] Tables caption + 表引用（验证于 2026-07-29）：全部 37 个 table 环境有 caption，全仓 `\ref`→`\label` 悬空为 0。（提交版编号 32–39 对应的附录表在当前稿已重排，按内容验证）
- [x] Table 20 义务（commit 9a3eda5）：正文只剩 5 张表、scan 类指标全在附录；multi-step aggregate 表 caption 明写 "scan-based rows are trajectory-wide fact coverage, reported as a diagnostic, not as primary utility"
- [x] frontier 清零（commit 9a3eda5）：**含标题**（"Measuring Utility–Security Trade-offs in…"）、摘要 8 处、RQ 框、findingbox、图 caption、discussion，共 30+ 处全部改为 trade-off / operating point 措辞；仅存 `fig_frontier_*.pdf` 文件名与 `fig:frontier` label（内部标识，不可见）
- [x] "specificity threshold" 删除（commit 9a3eda5）：L191/L197/L313 改为 category-naming effect 表述，与 E2 消融结论一致；"differ only in specificity" 原文不存在，确认无残留
- [x] erosion 措辞（commit 9a3eda5）：findingbox、摘要、正文、附录小节题共 10 处改为 "opens additional disclosure channels" / "direct leakage stays bounded"；保留的仅有环境名 erosionbox、图文件名、`app:phase2_erosion` label（内部标识）
- [x] "1000+ tools"（验证于 2026-07-29）：全文及变体（1,000 / thousand tools）零命中，本来就不存在
- ⚠️ 教训（本次的测量坑）：`erosion` 里没有 `erod`（e-r-o-**s**）——用 `erod\w*` 扫会静默漏掉全部 erosion；且 thesis 是嵌套 git 仓库，从 pulse 根目录 add 会被外层 .gitignore 拒绝

---

## 已完成

- ✅ PACT public runner `max_tokens` 修复，119 题 0 error（修复前 66/200 = 33% 失败）
- ✅ Pulse 四处 infra 修复：responder 参数化 + 断言、provenance 落盘、`status` 歧义消除、重试可调、action 回滚前置+校验
- ✅ 真实 served model 三层打通（`responderModelServed`，可与 requested 矛盾）
- ✅ Pulse OpenRouter 兼容（照搬 PACT 的 openai-compatible 契约）
- ✅ Lark 166 行 evaluation 表核对通过（计数、字段、留空纪律、模型归属全对）
- ✅ 标注包就绪（三部分 1,095 个 label，五人份乱序掩码表 + 统计脚本）

---

## 阻塞中

- ✅ 磁盘压力已解除：2026-07-29 15:40 有约 95 GiB 可用。
- ⏸ Pulse type-check 已得到有效结果（exit 2）：全仓库有历史诊断；本轮改动范围内剩 1 个真实错误，位于 `lib/ai/chat/experiment-model-runtime.ts:90`，需修复后重跑。
