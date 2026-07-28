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

- [x] **设计已定并在跑**：P1/P2/P6/P7 的干净 2×2（short/long × generic/category-specific），60 道分层题 × 4 policy。不是原来那三个变体，TODO 旧命名作废。
  - 2026-07-29 01:12 进度：p1 59/60、**p2 60/60**、p6 56/60、p7 55/60，剩 10 题已重启补跑
- [ ] **新增：defender 轴**（plan `129b842dbfe9`）8 cell × 60 题，requester 固定 gpt-5-mini，defender = DeepSeek V4 / GLM 5.2 / Kimi K3 / Qwen 3.5，policy P0+P2。复用 E2 同一批 60 题，两组直接可比。**这是替代论文里被删掉的 L312 claim 的实验**，同时答 JD3a Q3
  - 实测单题中位 145s；8 cell ÷ 并发 2 ≈ 9.7h，**大概率超出 10 小时窗口**，下轮决定是否降到 30 题/cell
- [ ] 填消融表 4 行数字 + 各 variant 词数
- [ ] 回应 aP1N Q2、TtBh Q2、AC

### 6. E1 operating points 扩充

- [ ] 确定 7 个 policy package 的名称 + 文献引用（v3 里 4 处 `【TODO: 7】`）
- [ ] 出 7-policy × k-model 散点表，填 `【TODO: k】`
- [ ] 回应 aP1N Q1、TtBh Q4

### 7. E5 States replication

- [ ] 原 protocol 下补 K 组（目标 n≥5），报 mean±sd
- [ ] 解释 variance 机制（early-context 是否含被查 state 对象 + 小分母）
- [ ] 回应 JD3a Q2

### 8. E6 RQ3 非 OpenAI

- [ ] Claude 或开源模型跑 relationship setting（GPT-5.5 已完成）
- [ ] 注：区域限制，Claude/Gemini 在 OpenRouter 403，需 Azure 或海外机
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
