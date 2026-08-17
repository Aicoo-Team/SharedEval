# annotator_D 恢复说明

`annotator_D`（Hanxiang 本人的标注）的实体文件曾先后位于
`~/Desktop/pact/PACT_annotation_D_Hanxiang/` → `~/Desktop/Pact_annotations/…`，
之后两处目录相继丢失，磁盘、回收站、iCloud、Time Machine、git 历史均无副本。

**本目录中的 D 是从会话记录 `~/.claude/projects/-Users-zhx-Desktop-pact/`
`b655259b-a7de-4a81-80dc-966a7100ebc3.jsonl` 中确定性重建的。**

## 重建链路
1. **空白模板**（题目）取自该 session 起始的 Read 结果（109 REL / 210 ACT / 420 QA）。
2. **标签 + N 标记** 由该 session 写入的三个规则脚本硬编码产生，原样落在本目录：
   `fill_rel.py`（REL 五元组 CODES + N 行）、`fill_act.py`（EXECUTE/REFUSE + N 行）、
   `fill_qa.py`（SHARE/PROTECT/BORDERLINE + N 行，已含对 QA-347 的 SHARE→PROTECT 修正）。
   这部分与 gold 无关，逐格精确。
3. **C / N;C 标记 + 冲突清单** 由 `compare.py` 对现仓库 gold
   （`pact_pair/relationship_labels/relationship_label_matrix.json`、
   `pact_pair/tasks/questions.json`，4 条例外 Q125/214/347/351）重算写入。

从仓库根重跑复现：`python3 pact_pair/annotation/_review_D/{fill_rel,fill_act,fill_qa,compare}.py`

## 校验（重建 == 原始记录，逐项吻合）
| | 一致率 | 冲突 | N | 备注 |
|---|---|---|---|---|
| REL | 86.6%（545 格） | 62 行 / 73 格（含 B 的 46 格不计分） | 27 | R3_close_friend 集中 42 格（系统性偏宽）|
| ACT | 98.6% | 3（全 unauthorized_strategic）| 15 | |
| QA | 92.4% | 32（含 10 个 BORDERLINE，gold 无此类）| 27 | |

冲突清单共 **97** 行 → `conflicts_review.csv`。标签分布：REL P=429/L=100/B=16；
ACT EXECUTE=109/REFUSE=101；QA SHARE=213/PROTECT=197/BORDERLINE=10(2.4%)。
全部与原 session narrative 一致 ⇒ gold 版本未变，重建即原版。

## 独立性约束（沿用原判断，未改）
D 由 AI 在已读过 gold 的 session 中生成，且已知全部冲突明细，**不计入 IAA**。
`blind_check.csv`/`blind_check_KEY.csv` 是从「无 C」行中 seed=7 抽的 40 行盲测样本（REL10/ACT10/QA20）。
