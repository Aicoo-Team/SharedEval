# Rebuttal 数据点终审台账（AUDIT_LEDGER）

2026-07-30 首次全量建账（Claude）。规则：每个数字簇一行；VERIFIED = 从原始产物复算或逐格对照；AS-PUBLISHED = 提交版论文表格原文引用（提交时已过一轮审）；PENDING = 不得随发帖出现。PREP watcher 每 30 分钟增量维护本表。

| # | 数字簇（rebuttal 位置） | 关键数字 | 源 | 状态 |
|---|---|---|---|---|
| 1 | GR-1 六模型表 | −69~−91pp 等 | 提交版论文 tab | AS-PUBLISHED |
| 2 | GR-2 gold-string | 72.5→13.0 等 | 提交版论文 | AS-PUBLISHED |
| 3 | E2 2×2 消融（Q2/C2/AC2） | 75.0/42.5/35.0/7.5；util 90/90/85/65；~38pp/~30pp；4.7×；29 of 60 | `6b656e42874d_resume/*/results.merged.jsonl` + judge pass | **VERIFIED**（07-29 复算） |
| 4 | E4 Files 异族 judge（JD3a Q1） | 1,058；98.3%（98.6/98.0）；88.1→14.1 vs 88.6→14.1；89.4/90.6；18 分歧净+3 | `runs/e4/verdicts.jsonl` | **VERIFIED**（07-29 原始计数审计） |
| 5 | JD-1 States 异族 judge | 1,030；91.6% | `runs/e4_states/verdicts.jsonl` | **VERIFIED**（07-30 复算 943/1030=91.55%；分歧 87 条无 leak 翻转） |
| 6 | GR-3 responder 表 | DS 90→5；GLM 80→5；util 100/100/90/100 | `finalized_defender_20260730/*/eval_output/eval_single_step_gpt-5-mini.json` | **VERIFIED-RAW**（07-30 PREP：四格 12 个分数从 judge 原始输出精确复现） |
| 7 | GR-4 8-policy 表 | P0 87.5/95→P5 5/65 等 | `finalized_e1_20260730/eval_output/`（P0/P3-P5）+ `e2_eval_input/eval_output/`（P1/P2/P6/P7） | **VERIFIED-RAW**（07-30 PREP：8 行 × 3 指标 = 24 个分数从两处 judge 原始输出精确复现） |
| 8 | JD-3 GLM relationship 修正版 | R3 泄露 31.8%(27/85)；util 6/6,31/33,15/15,10/11；478+22=500 | `finalized_e6_glm_20260730/relationship_table.md` | **VERIFIED**（20 格逐格一致；L 分母与 label matrix join 独立吻合 6/33/15/11 ✓） |
| 9 | Q4(b) 逐 requester D2 | answered 6.7/28.3/18.3/30.0；refused 71.7/58.3/75.0/58.3；类别 ~94/90-93/90-100；17pp | `l1_qa_eval_llm.json` sensitive_work 切片 + byCategory | **VERIFIED**（07-30 复算；Marcus 已修 28.3） |
| 10 | Q4(c) GPT-5.5 rel-policy | 87.4/87.1/87.4；63.3 util/38.7 P+B | 4YP thesis L1 三条件表 D3 列 + `eval_relationship_aware.json` | **VERIFIED**（leak/O-Ref 精确复现） |
| 11 | 逐 requester leak/O-Ref（tab:relationship 语境） | 1.7/3.3/9.2/7.5；40/59/86/31 | `eval_relationship_aware.json` | **VERIFIED**（精确；Util 列口径差异记录在案，rebuttal 未引用 Util 列） |
| 12 | aP1N Q3 两表口径 | 193/200/194；固定 200 | 提交版论文 | AS-PUBLISHED |
| 13 | aP1N Q5 双通道 | 12.6/14.0；+2.1pp(20/191→24/191)；38.0%；76/200=21+55；8.0/17.6 | 提交版论文 | AS-PUBLISHED |
| 14 | Escalation gate（JD3a Q4 ii） | 11,659；pstop 87.7–94.4%；10→30% 放行 69.8→91.0 / 67.1→87.4 | `escalation/phase2_relationship/all_conditions_eval.json` | **VERIFIED**（07-30 复算） |
| 15 | Mounting 三行表（TtBh Q3） | 78.9/64.2/65.2；12.9/9.0/5.6；56.8% | 提交版论文 + l1 产物 | AS-PUBLISHED（56.8% 算术复核 ✓） |
| 16 | D3/D4/D5 多轮防御（aP1N Q1） | 85.5/38.0/88.5；72.9/34.3/94.0；72.1/32.1/96.0；80.0/27.5/94.0 | neurips 附录 tab:ms_defense | AS-PUBLISHED |
| 17 | 标注全套（TtBh Q1/C4/JD3a） | κ 0.654/0.501/0.491；≥4/5 86.5/85.7/83.5；多数可判 97.8/95.6/100；31 平票；100 格(32/6/62)；458 行；剔离群 0.745/0.623/0.582；1,095=400+495+200 | QC round2 报告 + 两个 CSV | **VERIFIED**（07-30 从 CSV 反推分布，总数精确对账） |
| 18 | PACT-NET 概览（JD3a limitations） | 16.2→73.4；3.7→22.3；12.5→30.4；gate 100%；114 边/58 对 | 提交版论文 + `contact_graph.json` | **VERIFIED**（CHECK-2） |
| 19 | 标注矩阵计数（TtBh Q1/Q3） | 70/99；55/99 | `relationship_label_matrix.json` | **VERIFIED**（CHECK-3） |
| 20 | JD3a Q1(a) 人工复核 | 44 单步；38 多轮=28+5+3+2；≤1.6pp | 提交版论文 | AS-PUBLISHED |
| 21 | JD3a Q2 States | 58→5 / 59→11；5–31% | 提交版论文 | AS-PUBLISHED |
| 22 | **JD-2 States n=5 表** | PENDING 单元格 | E5 队列 2026-07-30 02:10Z **失败**（exit=1，strict cells 0/3，ORCHESTRATOR_FAILED gate=False） | **FLAGGED — 除非 Codex 重试成功并过 strict gate，发帖前应整表删除并软化 C7/Q2 措辞** |
| 23 | JD-1 明细行（States D2 双 judge 对照） | util 21.6→20.4%（36/167→34/167）；discl 7.5→5.7%（13/174→10/174）；agreement util 88.8% / sec 94.3% | `runs/e4_states/verdicts.jsonl` | **VERIFIED**（07-30 PREP 复算，四数精确） |
| 24 | 多轮 model-scaling 六点（aP1N Q1/Q5 语境） | gpt-5-mini vs GPT-5.5 × D0/D1/D2 多轮 | neurips 附录 multi-turn model scaling 表 | AS-PUBLISHED |
| 25 | JD-4 PACT-NET per-family | safety 26.6→71.5（+44.8pp 注明取自未舍入聚合）；utility 88.7→78.8 | 4YP thesis PACT-NET 表 + caption | **VERIFIED**（与 thesis 逐值一致；舍入差异已在文中注明） |

## 已知口径备注（防双分母）

- GR-4/GR-3 的 disclosure 分母是敏感题（40 或 20），utility 分母是 public 题（20 或 10）——与 GR-1 的 200 题口径不同，表内已自带 n。
- D3/D4/D5 的 leak 是 240-tick trajectory-wide scan（诊断口径），文中已注明不可与单轮 message rate 比。
- JD-3 utility 分母逐 requester 不同（scenario contract 决定 L 数），文中已解释。
- tab:relationship 的 Util 列与 `combinedUtility` 存在口径差（论文 57/49/58/70 vs 产物 54.3/45.0/52.7/68.1），rebuttal 未引用该列；若论文修订要引用需先 reconcile。

## 发帖前人工动作

1. 删除文首说明框；2. JD-2 填实或删除；3. OpenReview 字数上限核对；4. Figure 1 决定；5. "five non-author annotators" 表述最终确认。
