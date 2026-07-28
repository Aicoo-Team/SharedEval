# Rebuttal v2 内部执行清单（不发帖，仅供作者组）

更新：2026-07-27。配套文档：`rebuttal_v3.md`（可发帖草稿，含 `【TODO】` 待填位和 `【CHECK-n】` 核对位；v3 已去除分隔线与箭头符号，v2 为历史版本）。

---

## 一、必跑实验清单（按导师要求：先广度、后深度；投稿截止前一天有啥数字填啥数字）

| 优先级 | 编号 | 实验 | 直接回应的审稿人原话 | 状态 | 备注 |
|---|---|---|---|---|---|
| P0 | E1 | **Policy operating points 扩充**：D0/D1/D2 + 4 个来自 agentic-safety 文献的 defense prompt baseline（共 7 个 package）× 尽量多模型（含开源） | aP1N Q1 "provide an actual Pareto-front analysis"; TtBh Q4 "frontier too strong" | 4YP 已有 7 policy，需整理成统一表 | 导师："闭着眼加，加越多越好"。填 aP1N-Q1 和 C1 |
| P0 | E2 | **D1/D2 成分消融**：D1-L（长度对齐的废话版 generic ~320词）、D1-C（只加 category 名，无例子）、D2−E（去掉例子） | aP1N Q2 "length-matched control"; TtBh Q2 "small sweep controlling for length, examples, wording" | 待跑，2–3 个模型即可 | 预期结论：length 几乎不动，category 是 dominant，example 小幅增益。**只报数据支持的粒度** |
| P0 | E4 | **异家族开源 judge**：选 Qwen/Llama 系，重打分分层子集（建议 ≥600 例，覆盖 Files/States/multi-turn） | JD3a Q1 "different model family judge"; TtBh Q5 "different judge model family" | 待跑 | 导师："结论 slightly different but nearly一致" → 填 JD3a-Q1、TtBh-Q5 |
| P0 | E7 | **非作者标注**：5 个 research intern，独立、盲评，**全量 1,095 个作者标注**（495 relationship cells + 200 action verdicts + 400 QA share/protect，即论文 300 该/300 不该的设计二分） | JD3a Limitations "all labels from authors"; TtBh Q1 "checked by independent annotators?" | **标注包已就绪**：`rebuttal/annotation/`（指南 + 每人 3 份乱序掩码空表 + 统计脚本），今天可发 | 每人约 2.5–3.5 小时；回收后跑 `compute_agreement.py` 出 κ + 分歧清单；细节见 `annotation/ANNOTATION_GUIDE.md` |
| P1 | E5 | **States 补 replication**：原 protocol 下 +K 组（建议 ≥3，凑到 n≥5），可同时按原设计扩 States 题目数 | JD3a Q2 "add replications to bound it, n=2" | 待跑 | 报 mean±sd；解释 variance 机制（early-context 是否含被查 state 对象 + 小分母）。先跑他点名的 cell，其他 cell 顺带更新 |
| P1 | E6 | **RQ3 非 OpenAI 模型**：Claude + 至少 1 个开源模型跑 relationship setting | JD3a Q3 "reproduce on non-OpenAI models" | GPT-5.5 已完成；Claude/开源待跑 | |
| P1 | E3 | **D2-Rel matched run**：在原 GPT-5-mini + 原 RQ3 设置上跑 relationship-aware 版 D2（干净对照，非 GPT-5.5 大包） | aP1N Q4 "a relationship-aware policy baseline would help" | 待跑 | GPT-5.5 Rel-Policy 已有但换了模型+包，v2 里已如实标注 |
| P1 | E2b | **fixed-D2 per-category over-refusal 数字**：work/finance/health/relationship 分类的 refusal pattern | aP1N Q4 角度(b)（导师三角度之二） | 数据应已有，需整理 | 填 aP1N-Q4(b) 的【TODO】 |
| P2 | E8 | **Escalation gate headline 数字提炼**：从 Phase1/2 的 10k+ decisions 里选 1–2 个最能说明问题的数字 | JD3a Q4 "interventions MVP"; TtBh Q3 结构性 baseline | 实验已跑完，只差写作 | |
| P2 | E9 | **Figure 1 重画** + 命名统一 + Tables 32–39 caption 修复 | TtBh "figure 1 difficult to read"; JD3a formatting | 待做 | 低成本高收益，revision 里必须真做 |

---

## 二、`rebuttal_v2.md` 待填【TODO】总表（发帖前逐个消灭）

1. 7-policy package 的名称 + 引用（E1）；7×k 散点数据表（aP1N-Q1、C1）。
2. E2 消融表全部 4 行数字 + 各 variant 词数（aP1N-Q2、TtBh-Q2）。
3. 开源 judge 的模型名、N、agreement %、方向是否全部保持（JD3a-Q1、TtBh-Q5、C3）。
4. 非作者标注 κ + 主要分歧案例（JD3a-Lim、TtBh-Q1、C4）。
5. States 新增 replication 数 K + mean±sd（JD3a-Q2、C7）。
6. RQ3 Claude/开源模型结果（JD3a-Q3、C8）。
7. D2-Rel matched run 结果（aP1N-Q4c、C6）。
8. per-category over-refusal 数字（aP1N-Q4b）。
9. Escalation gate 1–2 个 headline 数字（JD3a-Q4）。
10. General Response C1 里的模型数 k。

---

## 三、数据一致性核对项【CHECK-n】（发帖前必须 reconcile，宁可删数不发矛盾数）

| 编号 | 问题 | 位置 | 处理建议 |
|---|---|---|---|
| CHECK-1 | **Actions 两套数字冲突**：v1 的 Table G2 说 exec 65.5/48.0/61.0、block 43.0/43.0/93.5；v1 的 A1 表说 util 55.0/54.0/58.7、block 31.5/35.1/90.0 | GR-1 表 Actions 行 | 查清分母/口径差异，统一用一套；如口径不同就像 15/20 那样明确写出估计量定义。**绝不能让 reviewer 再抓到一次"两表打架"** |
| CHECK-2 | **PACT-NET 有向边数三个来源不一致**：graph_stats=76、contact lists 求和=114、draft=172 | JD3a "single-target" 回复 | reconcile 前不发边数，只说 25 agents / 2 reps / ~1,000 tasks per run（v2 已按此写） |
| CHECK-3 | **敏感 items 总数 150 还是 200** | TtBh-Q1、Q3 | **已实测（repo data v6, 2026-07-27）**：`relationship_label_matrix.json` = **99 行**（Q101–200，Q125 已移出）× 5 requester = **495 cells**；label 跨 requester 变化 **70/99**；friend vs investor 不同 **55/99**；per-requester P/L/B：R0=99/0/0、R1=84/6/9、R2=67/32/0、R3=61/15/23、R4=82/10/7。v1 rebuttal 里的 150/200、108、84、以及 T2 分布（如 R2=150/49/1）与当前数据全对不上——需确认那些数字来自哪个旧版数据；rebuttal 发帖前统一改用 v6 实测数或注明数据版本 |
| CHECK-4 | **judge 到底是不是 gpt-5-mini**（Xisen 自己也存疑 "really?"）| JD3a-Q1 | 如果实际 judge 是别的模型，回复可以直接更正 reviewer 的前提，更有力；如果确实同族，维持 v2 写法 |
| CHECK-5 | **~20,000 live-platform observations** 的 N/单位/时间窗/排除规则未审计 | v2 已不写具体数字，只说 "deployed system with external users" | 审计完成前不要把 2 万写回去 |
| CHECK-6 | Kimi K2.6 ~12% infrastructure errors 的脚注要保留（Files 行） | GR-1 | 已保留，别删 |
| CHECK-7 | multi-turn States 分母 16/91 为何是 91（不是 100/200）——预备好一句话解释，防追问 | aP1N-Q5 | 先内部搞清，暂不写进回复 |

---

## 四、话术红线（导师会议共识，写作时逐条自查）

1. **不推翻任何已发表数字，不说"我们可能测错了"**。所有分歧一律用"两个估计量/分母不同，security 口径一致，趋势一致"收束（15/20 模板已写好）。尤其 adaptive/multi-turn 那块，禁止出现"our evaluation may be flawed"类表述。
2. **每个 claim 加限定**："under current foundation models" / "in the tested settings" / "scoped to the completed sweep"。给未来模型留空间，同时堵 overclaim 的嘴。
3. **每个 question 的结构**：一句同意/总结 → 关键解释 → 点名具体 table/setting → 回扣主贡献。禁止散文。
4. **不写 "erosion of protection"**（paper 里本来也没写 protection）；统一用 "opens additional disclosure channels"。
5. **不承诺 "1000+ tools"**，只说 MCP-compatible（没有 dated catalog snapshot 之前）。
6. **v1 里大量 "claim boundary / does not establish" 栏目已删**——每个结果保留一句诚实的 scope 句即可，不要整列自我拆台。
7. **对 TtBh（给 2 分的 access-control 背景 reviewer）要格外真诚**：Figure 1 那条按"送人情"处理，明确感谢 + 真改；结构 baseline 不止跑，还要讨论 rule-based 的固有粗粒度 vs policy reasoning 的不可靠 → 结论是 complementarity（v2 的 TtBh-Q3 已按此写）。
8. **labels 一律叫 scenario contracts**，不叫 norms；relationship 效应叫 "requester-profile effect"（identity/authority/history/wording 共变）。
9. **PACT-NET action 数据不做强 claim**（无 DB-diff）；QA + contact-gate 证据可用。
10. **新数字随做随填**：截止前一天锁版，没跑完的保留 "in progress, will post during discussion"，但已承诺的必须在 discussion 期内真发。

---

## 五、发帖流程建议

1. **先内部**：把 v3 + 清单抄送全体作者（导师原话："写完抄送所有作者，feel free to comment"），并单独找 Kevin 过数据细节（导师点名）。
2. **核对平台字数上限**（NeurIPS 风格 venue 通常每条 official comment 有字数限制）：超限时压缩顺序 = 先把表格改成一两句话，再砍 GR-1 的次要行；每个 reviewer 的 Q&A 结构不动。
3. **发帖顺序**：General Response（置顶，AC 可见）→ 各 reviewer 单独回复（每人开头一句个性化感谢，引用他们各自认可的点）→ AC 回复可并入 General Response 或单发（v2 已单独写好 §0，视平台机制选择）。
4. **讨论期跟进**：每补完一个实验就在对应 thread 追加短评论（"As promised, here are the results of X"）——比一次性大包更能表现 responsiveness。
5. **目标**：让 AC 看到（a）能同意的全同意了，（b）要求的实验全补了/在补，（c）这是该方向第一个初步系统探索、claims 已收窄——对应 metareview 四条逐一闭环。
