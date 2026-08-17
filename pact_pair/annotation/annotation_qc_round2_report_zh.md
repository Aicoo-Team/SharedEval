# PACT-Pair 标注验收报告 · 第二轮（A / B / C / D / E 齐）

2026-07-29 ｜ 验收人：Hanxiang (D) ｜ 按 `annotation_acceptance_plan_zh.md` 执行
工具：`annotation_qc.py`（validate + compare）+ 本轮补充脚本 `qc_round2_extra.py`（阶段二指纹、vs-gold、单调性、κ 变体、majority≠gold 导出、A 返工核对）

## 结论

**五份全部真实作业，无抄袭指纹命中，五份全部采纳。数据按 2026-07-29 交付版冻结，不安排返工轮**；B、C、E 的残留问题以 caveat 形式记录（见逐人节），并给出对应的敏感性 κ。ACT 的 κ 未达标（0.49），是三种方向相反的系统偏差叠加，成因与指南缺口一并记录在案。

> 2026-07-29 验收决定：① B 的 relationship 词表按 PROTECT→P / SHARE→L / BORDERLINE→B 归一化采纳，不要求重交；② **D 计入 κ**，v3 占位取 5 人口径；③ gold 暂不修改，majority≠gold 仅作裁决记录；④ 时间约束下数据冻结，所有残留问题记录为 caveat，不再要求标注员返工。

## 阶段二：抄袭指纹（全员干净）

| | vs gold REL/ACT/QA | 15 矛盾题同向复现 | 39 个 gold B 格命中 | 两两最高 |
|---|---|---|---|---|
| 红线 | 任一 >95% | ≥10/15 | >60% | >98% |
| A | 89.7 / 87.0 / 89.8 | 2/15 | 13% | A-D 90.6% |
| B | **67.7 / 77.0 / 70.5** | 0/15 | 31% | ≤71% |
| C | 83.0 / 87.0 / 79.9 | 1/15 | 8% | ≤85.6% |
| D | 87.3 / 98.5* / 91.9 | 4/15 | 15% | — |
| E | 87.5 / 76.5 / 92.1 | 0/15 | 33%† | ≤87.9% |

\* D 的 ACT 98.5% 触发 >95% 复核线——D 为 author track，与 gold 高一致是预期，非指纹问题。
† E 总 B 用量仅 7%（38/545）但 13 格落在 gold 最难的 39 格上——是"把 B 用在刀刃上"的诚实模式（其余指纹全净、note 逐题手写），判 benign，仅记录。

**B 的"未实际重做"检查**：round-1 原文件已丢失，无法逐格 diff；但 B round 1 ≈ gold（100%/100%/99%），故 vs-gold 即代理——本轮 67.7–77%，与 round 1 判若两人，**"未实际重做"不成立**。B 这轮 relationship 大量用 B/L（R3 列 61% B），QA 分布也独立，是真实重做。

## 逐人结论

**A — 返工验收通过 ✅（并入已接受版本）**
102 条 BORDERLINE 全部二选一（残余 0/420）；QA-162/163 已填；无清单外新增 BORDERLINE；actions / relationship 文件 mtime 仍为 7/28 原件（未动）。
唯一瑕疵：qa 表头第 4 列被改成 `judgment_SHARE_PROTECT_PROTECT`（应为 `..._BORDERLINE`），纯表头文字问题，已在验收侧修正，不要求重发。
局限：round-1 原文件丢失，清单外 S↔P 改动无法逐格排除；以 mtime、BORDERLINE 布局、vs-gold 提升幅度（72.6%→89.8%，与仅重决 102 格相符）间接佐证。

**B — 真实重做，采纳（带 caveat）⚠️**
1. ~~relationship 再次用 QA 词表~~——已裁定按 PROTECT→P / SHARE→L / BORDERLINE→B 归一化采纳，不要求重交（所有指标均基于映射后数值计算）。
2. Caveat A：QA BORDERLINE 104/420 = **25%**，超 1–10% 指引；REL 的 B 占比同为 25%（135/545），集中在 R3_close_friend（61% B）。时间约束下按原样采纳。
3. Caveat B：对多数票三项全部 <80%（QA 74.9 / ACT 76.0 / REL 75.3），B 是本轮离群标注员。
影响评估：5 人多数票下 B 单独无法翻转任何多数（需 3/5），其影响集中体现为压低 κ——剔 B 敏感性口径（0.745 / 0.582 / 0.623）已在汇总表给出，报告数字时可并列引用；B 的 B/BORDERLINE 重仓格大多落在非全票格，已全部进入分歧导出表。
附：BORDERLINE 判定标准至今未补（前置依赖 2 未解决），B 的超标与 A round-1 同理，不能全算标注员问题——记录为方法学缺口。

**C — 有条件通过 ✅**
Round-1 三个失败点全部消失：Part C SHARE 88%→50%；模板 note 消失（本轮 note 几乎不写，合规——note 为 optional）；关系梯度方向恢复正常（close_friend P 42% < colleague 87%）。vs 多数票 83.6 / 90.0 / 92.6 全过线。
Caveat（不返工，记录）：QA 自我一致性探针 **5/20 组不一致**（计划阈值 ≤2）：QA-056/145、074/275、106/174、252/281、278/329。影响上限为 5/400 题的 C 侧标签置信度（计分取首次出现），5 人多数票下不构成系统性风险。REL 2 组不一致在阈值内。

**D（本人）— author track**
`_review_D/RECOVERY_NOTE.md` 的独立性约束（AI 在读过 gold 的 session 中生成）与验收计划"D 正常当标注员"存在矛盾——**已裁定：D 计入 κ**（已同步 lead；4 人口径保留作敏感性参考）。对 D 份的评价请 lead 抽查复核（利益冲突声明同 round 1）。

**E — 首交，有条件通过 ✅**
结构零错误；note 逐题手写（61/76/20 条全部不同）；跨文件自洽 100%（99/99，高于 gold 自身基线 84.8%）。
Caveat（不返工，记录）：**actions 系统性偏宽**——EXECUTE 73%（他人 45–64%），vs gold 的 47 个分歧全部是"gold 拒、E 执行"，集中在 probing_action 16、unauthorized_create_sensitive 15、unauthorized_edit_sensitive 15；对多数票 76.5% <80%。这是方向一致的真实判断分歧（E 认为助理应执行 probing/敏感内容操作），非敷衍作业；计入 ACT κ 偏低的结构性成因（见汇总节），E 的 47 个分歧格已全部进入分歧导出表。

## 汇总指标（v3 三处 κ 占位）

| 口径 | QA | ACT | REL |
|---|---|---|---|
| **5 人（含 D）→ v3 正式占位** | **0.654** | **0.491** | **0.501** |
| 敏感性参考：A+B+C+E（剔 D） | 0.609 | 0.389 | 0.452 |
| 敏感性参考：剔 B 含 D | 0.745 | 0.582 | 0.623 |

- QA 达标（≥0.6）。REL 无明文阈值，moderate。
- **ACT 未达标**（0.491 < 0.6；剔 D 敏感性口径甚至 <0.4）。结构性原因是三种相反偏差叠加：A/C 偏宽 unauthorized_strategic（A 16 条、C 13 条，round-1 已知问题，定义至今未写清）；B 反向拒绝 authorized_edit 20 条、authorized_complete 8 条；E 执行 probing/敏感 create/edit 47 条。按计划口径这属"指南缺口"而非个人敷衍——报告 κ 时建议随附此归因；指南缺口清单（供后续版本）：①"越权战略操作"边界，② probing 与敏感内容创建/编辑的处置，③ authorized 常规编辑不应拒。
- unanimous：QA 60.0% / ACT 46.5% / REL 61.4%；平票（5 人 2-2-1）共 31 格。

## 产出物

- `qc_reports/round2_disagreements.csv` — 458 行非全票题，末列 `adjudicated_label` 由裁决会填。
- `qc_reports/round2_majority_vs_gold.csv` — **100 格 majority≠author**（QA 32 / ACT 6 / REL 62，含 31 平票），已附类别与草稿 adjudication note，待逐条润色。主模式：
  - QA：sensitive_work 的 PROTECT→多数 SHARE 16 条——round-1"候选 gold 问题"清单（A+D 两人版）如今获 5 人多数确认，gold 的"公司内部共享知识"类划分偏严；
  - REL：R3_close_friend 的 gold B→多数 L 16 条——密友档 gold 偏保守；
  - ACT：6 条 REFUSE→多数 EXECUTE（3 条 unauthorized_strategic）。
- `qc_round2_extra.py` — 本轮补充检查，可复跑。

## 决策状态

已决（2026-07-29，已同步 lead）：
1. **D 计入 κ** → v3 用 5 人口径（0.654 / 0.491 / 0.501）。
2. **gold 暂不修改**（含 15 题矛盾与 sensitive_work 16 条多数确认项）——majority≠gold 的 100 格仅作裁决记录，不回写 gold。
3. B 的 relationship 词表按映射采纳，不重交。
4. **数据冻结**：五份按 7/29 交付版采纳，残留问题以本报告 caveat 为准，不再要求标注员返工。

仍开放（均为 lead/author 侧动作，不依赖标注员）：
- **BORDERLINE 书面标准**（前置依赖 2，仍缺）——B 的 25% 超标部分归因于此，已记录为方法学缺口。
- 458 行分歧与 100 格 majority≠gold 的裁决（如需）：`adjudicated_label` 列留空待填，可由 lead/author 侧完成。

## 局限

- 计划勘误：QA 探针实为 20 组（非 27）；REL 唯一决策数 495（99 题 ×5，计划写 545 系含重复行）。
