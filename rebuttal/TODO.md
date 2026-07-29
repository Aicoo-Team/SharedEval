# Rebuttal TODO

2026-07-28。从 `rebuttal_v3.md` 的占位符整理（41 → 剩 23），并按 7/27–28 的新发现更新。

> **协作规则（因重复劳动而加）**：Claude 与 Codex 并行工作。**做完任何一项，立刻在本文件勾掉并写明产物路径**，再去做下一件。
> E4 已经因为没有及时记录而被重复跑了一次（Codex 未先检查 `rebuttal/runs/e4/` 就重跑了一个较弱版本，浪费一轮 + 约 \$1.17）。
> 开工前先读本文件；本文件是唯一的进度真相来源。

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
- [ ] **Metric_Definition 错误**（新增）：Lark 表写 "errors excluded from denominators"，实际算法是 noResponse 计入分母当失败。Kimi 三行受影响最大（82% vs 排除后 98.8%）。改描述而非改数字

### 3. 非作者标注（E7）— lead time 最长

- [ ] 五份 CSV 发出（zip 已打好在 `annotation/outbox/`）：Sara(A) / Trishit(B) / Abhinav(C) / Hanxiang(D) / Yu Chen(E)
- [ ] 回收后放 `annotation/filled/`，跑 `compute_agreement.py`
- [ ] 填 v3 的三处 κ 占位：relationship P/L/B、action verdicts、QA share/protect
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
- [ ] **States 无法做配对对比**：`eval_results.json` 是 string-match 产物，**从未有过 LLM judge 基线**。这本身应写进 limitations，而不是当作"待补"
- [ ] **multi-turn 可做但需重建输入**：`10split_llm_judge.json` 有 60 runs × 20 题的 `llm_verdict`，但 `response_preview` 只截 200 字符；全文在各 run 的 `chat_history.json`，需写提取逻辑
- ⚠️ **Codex 曾重复跑过一个较弱版本**（585 抽样 + 改写 rubric），已自行撤回，其 `e4-*-600.json` 标记为 exploratory，不得进入论文

### 5. E2 D1/D2 成分消融（三方点名，最救 claim）

- [x] **E2 原始数据完成（2026-07-29 05:20）**：P1/P2/P6/P7 全部 **60/60**，merged 产物在 `pulse/research/runs/rebuttal/6b656e42874d_resume/policy_*/results.merged.jsonl`。待 judge pass 出消融表数字
- [x] **消融表已填进 rebuttal（2026-07-29 07:15，commit d7579f2）**：judge pass（gpt-5-mini，与论文同 judge）跑完 240 行。disclosure P1 75.0 / P7 42.5 / P6 35.0 / P2 7.5；utility 90/90/85/65。**真发现：length（~38pp）与 category（~30pp）同量级且近似可加，推翻了草稿"specificity 主导"的预设**。AC 第 2 点、C2 行、aP1N Q2、TtBh Q2 四处已按数据重写
- [x] 回应 aP1N Q2、TtBh Q2、AC —— 已写入，含全部 caveat（单 rep、新 60 题子集、P6/P7 为 draft-control 对照）
- [ ] 🚨 **defender 轴：两条 lane 的题目子集不同，现状拼不成一张表**（2026-07-29 14:47 发现）
  - 两边目录名都带 `qset30`，且前 10 个 id 完全一致（1,6,11,17,22,27,32,37,43,48），所以一直没被发现。**第 11 个起分叉**：
    - Claude（`or_claude_lane`）：…53,58,64,69,74,79,84,90,95,100,101,104,107,111,114,117,120,124,127,130
    - Codex（`f1d964b29c2e`）：…101,104,107,111,114,131,134,136,139,142,156,158,160,162,164,176,179,181,184,187
    - **交集只有 15/30**。直接把 DeepSeek/GLM 和 Kimi/Qwen 放进同一张表 = 拿不同题目比不同模型，把 defender 身份和题目难度混在一起
  - **每个模型自己的 P0→P2 delta 仍然有效**（同模型的两格用同一子集），坏掉的只是跨模型比较
  - 发现方式：provenance 复算时加了 questionId 过滤，同一格从 28/30 掉到 13/30，两个数对不上才查出来
  - **Codex 侧还不完整**：p0-deepseek 28/30（缺 6,27）、p0-glm 28/30（缺 134,156）、p2-deepseek 25/30（缺 1,11,139,158,176）、**p2-glm 在该 plan 里根本不存在** → GLM 没有 P0→P2 delta，而这正是 defender 轴要证的东西。旧 plan `7b99d045b3ec` 有一个 p2-glm52，但它属于污染后归档的那批，provenance 未确认前不能混用
  - 这些在 8bb8/8bb9/8bba，无活进程但**未完成 = 铁律 0 的 owned**，Claude 不碰，留给 Codex
  - **Claude 侧修法（只动自己命名空间）**：把 4 个格子各补跑 Codex 独有的 15 题（131,134,136,139,142,156,158,160,162,164,176,179,181,184,187），补完后每格覆盖两个子集的并集 ⊇ Codex 的 30 题，全部模型即可在 Codex 子集上互比。**qwen P0/P2 已启动**；kimi 两格等 8ce5 上的 Q100 重试结束（铁律 0）
  - ⚠️ **教训（今天第 4 次）**：qwen-P2 曾显示 30/30 行、E1-P0 曾显示 60/60 行且进程已退出，都是"完成"的样子，实际分别只有 28 和 55 条 provenance-valid。**完成判定一律走 provenance 复算，绝不看 `wc -l`**
- [ ] **第五个模型家族已就位**：`x-ai/grok-4.3` 实测在区域可用（HTTP 200，served id 一致，且能真发 tool_calls），已注册进 `experiment-model-runtime.ts`。grok-4/grok-4-fast 已废弃返回 404。Grok P0/P2 两格在 `next_batch.sh` 里待发
- [ ] **对角线格（双方同厂商）待发**：GLM↔GLM、DeepSeek↔DeepSeek 各 P0/P2，UUID 8d00–8d03。这是论文自己设定的"跨所有权边界"最真实形态
- [ ] defender 8 格齐后跑 judge pass 出跨 defender 表

### 6. E1 operating points 扩充

- [ ] 确定 7 个 policy package 的名称 + 文献引用（v3 里 4 处 `【TODO: 7】`）
- [ ] 出 7-policy × k-model 散点表，填 `【TODO: k】`
- [ ] 回应 aP1N Q1、TtBh Q4

### 7. E5 States replication

- [ ] 原 protocol 下补 K 组（目标 n≥5），报 mean±sd
- [ ] 解释 variance 机制（early-context 是否含被查 state 对象 + 小分母）
- [ ] 回应 JD3a Q2

### 8. E6 RQ3 非 OpenAI

- [x] **阻塞 bug 已修（2026-07-29 13:12，commit 6e11f6c34）**：`run_d3_relationship.ts` 的 `createModel` 走的是 `getAzureProviderConfig`，**Azure 专用**。传 OpenRouter id 时 baseURL 正则匹配不上，回落到默认 Azure resource——也就是说 `--model z-ai/glm-5.2` **根本不会跑 GLM**，但产物会全程标成 GLM。这是"CLI 参数存在 ≠ 生效"的第四例，且会**凭空捏造 RQ3 的非 OpenAI 结论**。已改为走 `resolveExperimentModelRuntime()`（按 registry 推断 provider、未知 id 直接抛错），并在开跑时打印解析后的 provenance
- [x] **确认 E6 无需 seed group**：该脚本不走 `contact_agent`（0 匹配），自己构造模型直接扮演 Alex。此前为它 seed 的 8ce8/8ce9 两组是多余的
- [x] **修复已验证跑通（2026-07-29 13:26）**：冒烟 D3 × R1 × GLM × Q101-103 打印 `provider=openai-compatible`，3 例 0 error。这行 provider 就是"没走 Azure 回落"的判据
- [x] **跑起来才发现的第二个 bug（同日修，commit c2293b0cd）**：run id 直接拼接原始 model id，`z-ai/glm-5.2` 的斜杠把产物切成 `research/runs/d3_D3_R1_z-ai/glm-5.2_.../`，**分析脚本的扁平 `d3_*` glob 会静默漏掉整个 run**。已改为路径用 slug、`summary.json` 保留真实 id。两次冒烟已归档进 `e6_smoke_glm/artifacts/`，防止 1–3 题被当数据
- [ ] **全量已启动（pid 46041）**：D3 × R0–R4 × Q101-200 × GLM 5.2，单进程顺序执行。这是 JD3a Q3 的第一份非 OpenAI 答案
- [ ] 注：区域限制，Claude/Gemini 在 OpenRouter 403；开源家族现有 DeepSeek / GLM / Kimi / Qwen / Grok 五个，JD3a 原话 "Claude **or other open-source models**" 字面已满足
- [ ] 回应 JD3a Q3

### 9. 补零散数字

- [ ] per-category over-refusal 数字（work/finance/health/relationship）— aP1N Q4(b)
- [ ] Escalation gate 提炼 1–2 个 headline 数字（实验已跑完，只差写作）— JD3a Q4
- [ ] D2-Rel matched run（原 GPT-5-mini 设置上的干净对照）— aP1N Q4(c)

---

## P2 — 写作与呈现

- [ ] Figure 1 重画（字号加大 + 明确架构）— TtBh 专门提，属于"送人情"，必须真改
- [ ] 命名统一：SharedOS=平台，PACT-Bench=套件=PACT-PAIR+PACT-NET
- [ ] Tables 32–39 caption + 缺失的表引用修复 — JD3a formatting
- [ ] Table 20 relabel 为 "trajectory-wide fact coverage (diagnostic)" 并移入附录
- [ ] 全文替换 "frontier" → "trade-offs across discrete operating points"
- [ ] 删 "differ only in specificity" / "specificity threshold"
- [ ] 不写 "erosion of protection"，改 "opens additional disclosure channels"
- [ ] 不承诺 "1000+ tools"，只说 MCP-compatible

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

- ⏸ Pulse 侧运行验证：iCloud 冷缓存导致首次模块加载极慢，需暖机一次
- ⏸ Pulse type-check：同上原因未跑完（**注意：之前误报过"干净"，实际未验证**）
