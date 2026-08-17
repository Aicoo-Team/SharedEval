# PACT 标注验收方案（round 2）

> 适用范围：A(Sara) / B(Trishit) / C(Abhinav) / D(Hanxiang，本人) / E(Yu Chen) 各三份 CSV：
> `annotator_<X>_qa.csv`（420 行）、`annotator_<X>_actions.csv`（210 行）、`annotator_<X>_relationship.csv`（109 行 × 5 档）。
> 配套脚本：`annotation_qc.py`。
>
> **当前状态**：A 已交（round 1 判"可用需小范围返工"，只补 102 条 BORDERLINE 二选一 + QA-162/163 两行空白）；B、C round 1 不可采纳、重做中；E 首次提交未到；D 为本人（author track）。

## 验收框架（双轨）

与 v1 不同：**存在 gold（author 标签）**，验收不是纯多数票框架，而是：

- **轨一（单人）**：格式 + 认真度机械校验，收到一份跑一份；
- **轨二（汇总）**：对 gold 的一致率审计 + 交叉一致性。多数票只用于两件事：填 v3 的三处 κ 占位、生成 majority ≠ author 的逐格 adjudication notes（lead 要求的产出）。

## 阶段一：单人收件校验

```bash
python3 annotation_qc.py validate <submission_dir>
```

任何 ERROR 直接退回，WARN 人工过目：

| 检查项 | 级别 | 说明 |
|---|---|---|
| 文件齐全、命名符合 `annotator_<X>_{qa,actions,relationship}.csv` | ERROR | |
| 表头与模板完全一致 | ERROR | 防止列被增删改名 |
| 行数 = 420 / 210 / 109 | ERROR | |
| row_code 连续无重复 | ERROR | 防止删行、乱序 |
| 标签格非空且取值合法（QA: SHARE/PROTECT/BORDERLINE；actions: EXECUTE/REFUSE；relationship: P/L/B，大小写敏感） | ERROR | round 1 中 B 的 Part A 填了 QA 词表而非 P/L/B，即栽在这条 |
| **note 模板化检测**：note 非空行 >50 且去重后 ≤5 种固定话术、或 note 与标签 1:1 对应 | ERROR | round 1 C 的失败模式（420 行只有 3 句话术批量填充） |
| **relationship 梯度单调性**：按关系档位算 P 占比，亲密度越高 P 应越低；出现倒挂（如密友 P 明显高于同事/陌生人） | ERROR（人工复核后定） | round 1 C 把亲疏标反（密友 P 92%、同事 L 75%+） |
| note_optional 只含已知代码（N、C，分号分隔） | WARN | |
| 自我一致性探针（重复题：QA 27 组 / actions 10 组 / relationship 10 组） | WARN | 不一致 ≥3 组退回重过不一致的题 |
| Straight-lining：连续 ≥30 行同标签 | WARN | R0_stranger 全 P 豁免 |
| 标签分布 | INFO | SHARE 占比偏离他人 >15pp 需约谈；round 1 C 的 Part C 88% SHARE 属此类 |

## 阶段二：抄袭 / 未实际重做筛查（在一致性计算之前跑）

Round 1 教训：B 抄的是 **gold**，"标注员两两 >98%"抓不到。三层指纹：

1. **vs gold 整体相似度**：任一文件对 gold >95% 一致 → 人工核查（认真做的 D 为 87–98%，98.5% 是单文件观测上限）。
2. **gold 内部矛盾 15 题**（见 `gold_conflict_15_items_zh.md`）：独立标注不可能同向复现 gold 的自相矛盾。同向复现 ≥10/15 → 强抄袭证据。
3. **39 个最主观 B 格**：命中率其他人在 13–18%，命中 >60% → 强抄袭证据。

**对重交者（B、C）额外一条**：与本人 round 1 被退回版本逐格比对，>95% 相同 → 判"未实际重做"，直接退回。

标注员两两 >98% 的互抄检查保留。

以上是统计证据非操作日志，结论写"判定"需 ≥2 条指纹同时命中；单条命中只标"可疑"交 lead。

## 阶段三：一致性与审计

```bash
python3 annotation_qc.py compare <dirs...> --out qc_reports/round2
```

1. 题目对齐校验（按 row_code 比题干，防旧版任务文件）；
2. Fleiss' kappa、pairwise 一致率、unanimous 比例 → 填 v3 三处 κ 占位；
3. 个人 vs gold、个人 vs 多数票一致率；
4. majority ≠ author 的格子逐条写 adjudication note（lead 要求）；
5. 非全票题导出 `*_disagreements.csv`，末列 `adjudicated_label` 由裁决会填。

## 验收阈值

| 指标 | 阈值 | 不达标处理 |
|---|---|---|
| 阶段一 ERROR | = 0 | 退回重交 |
| 探针不一致组数 | ≤ 2 组/文件 | ≥3 组退回重过 |
| 个人 vs 多数票（qa、actions、relationship 按 545 决策算） | ≥ 80% | 对齐标准后重标分歧题 |
| Fleiss' kappa（qa、actions） | ≥ 0.6 | < 0.4 先修指南再谈个人问题 |
| BORDERLINE / B 占比 | 1%–10% | 超标者仅重决 BORDERLINE 题，不整份重标（A 先例） |
| 抄袭指纹 | ≥2 条命中 | 整份剔除，lead 直接沟通 |

裁决规则：4/5、5/5 直接采纳；3/2 进裁决会；BORDERLINE 参与投票、裁决时优先讨论。

## 人员特殊处理

- **A**：只验收返工的 104 格（102 BORDERLINE + QA-162/163，清单在 `outbox/A_rework_rows.txt`）。收到后 diff：这 104 格外不得有任何改动，残余 BORDERLINE ≤10%，即并入已接受版本，不重跑全套阈值。
- **B**：round 1 判抄 gold（AI 代做未自查，本人未看过 gold 内容，不构成记忆污染）。重做数据**正常进 κ**（此决定已获 lead 授权由验收人裁量）；阶段二指纹从严照跑——尤其"与自己 round 1 版本 >95% 相同"和三条 vs-gold 指纹，防再次 AI 代做。
- **C**：重做后按全流程验收，重点看 round 1 三个失败点是否消失（Part C SHARE 占比、note 模板化、relationship 梯度方向）。
- **D（本人）**：既是标注员又是验收人，对 D 份的评价请 lead 抽查复核。
- **E**：首次提交，全流程。

## 前置依赖（round 2 收件前必须解决，否则问题会复现）

1. **说明书补 BORDERLINE 判定标准**：目前只有 "<10%" 量化指引、无定性标准，A 的超标直接源于此；不补则超标不能全算标注员问题。
2. **gold 15 题内部矛盾先裁决**：定清 Part C 审计对照哪一轨，否则认真标注员也复现不出自相矛盾的目标。

## 已知局限

- gold 本身有已知问题（15 题矛盾 + A/D 独立一致质疑的候选错误清单，见 round 1 报告），"与 gold 一致"是审计参照不是正确性证明；
- 机械校验抓不出"AI 代做但没抄 gold"——只要输出自洽且合规，与认真人工不可区分，只能靠指纹 + 分布异常间接提示；
- B 的重做若再次通不过指纹筛查，有效样本降至 4 份，κ 的置信区间会变宽，结论强度需在报告里如实降级。
