# 给 Jindong 的审查包（v3.2，2026-07-30）

配套文件：`rebuttal_v3.2_clean.md` / `rebuttal_v3.2_clean.docx`（可直接上传 Google Doc）。
总量 7,945 words：AC 412 / General 1,766 / aP1N 2,248 / JD3a 1,911 / TtBh 1,596。

## 一、您 29 条批注的逐条落实（v1 docx → v3.2）

程序化验证 14 项关键改动全部在最终稿中（2026-07-30 复检）。

| 批注 | 您的意见 | 落实情况 |
|---|---|---|
| 0/13/28 | 简单易读、对话感、减少 mental burden | 全文重写为"先结论、再细节、最后收束"；每答案开头一句话给结论 |
| 1 | 参考 Google Doc 范例 | 无法访问该链接，未对齐（唯一未落实项，需您导出或口头传达要点） |
| 3 | aP1N 开场 smooth | 已拆短句 |
| 4 | "We have done both" 奇怪；分"做过/新做"两类 | 改为 "Thank you for raising this framing concern; we agree, and we address it in both ways" + First/Second 结构 |
| 5/6/7/17 | 没做过的要感谢+follow 建议新跑；"we ran it" 歧义 | 四处全改 "Following the reviewer's suggestion, we have now run…"，credit 明给 |
| 8 | 长度结论加粗 | "**The conclusion: both length and category enumeration matter, and their effects are roughly additive.**" |
| 9 | 删 "not from inconsistent measurement" | 已删 |
| 10/11 | Q3 先 high-level 说两表研究什么；大白话在前 | "Table 15 studies whether the answer the requester actually receives solves the task…" 先行，术语进括号 |
| 12 | "we will … in our revision" + 收尾感谢 | Q3 结尾已加 |
| 14 | "Three points." 换掉 | "We would like to clarify from the following perspectives." |
| 15 | 不用 intentional | "Our initial goal in RQ3 is…" |
| 16 | 看不懂的句子改简单 | 已改为短句大白话 |
| 19/20/21 | "direct-channel amplification" 等术语 90% 人不懂 | 全部改为大白话（"does not make the direct leak worse; it adds a second, different way for facts to leak"） |
| 22 | excited to receive | JD3a 开场已用 |
| 23 | 排版可读性 | 全文 17 张小表，重点句加粗 |
| 24 | "Done for X; in progress" 开头不合惯例 | 改结论先行结构 |
| 25/26 | "Tested;" / "after submission" 显得没做完就投 | 改 "We did not stop at…" 句式 |
| 27 | 先结论再细节最后 recall | 全文执行 |

## 二、您批注之后新增的内容（v1 → v3.2 的增量）

**新实验（全部有产物背书，25 组数字均经原始文件复算）：**

1. **GR-4：八 policy 同题同模型对照**（8×60）——回应"点太少"，泄露 87.5%→5.0% 谱系
2. **GR-3：换防守方**（DeepSeek/GLM responder，4×30）——P2 效应跨防守方成立
3. **2×2 消融**（aP1N Q2）——长度~38pp 与类别~30pp 近似可加，修正我们自己旧框架
4. **双面异族 judge**——Files 1,058 条 98.3%、States 1,030 条 91.6% 一致
5. **五人非作者标注**——≥4/5 一致 83.5–86.5%；κ 0.654/0.501/0.491；ACT 未达标如实报+归因；100 格 majority≠gold 冻结 gold 原样交出
6. **GLM 5.2 关系复现**（seed 世界，500/500）——密友档泄露 31.8%，定性失败模式跨模型复现
7. **D3/D4/D5 文献防御**（Spotlighting/Hines、Instr. Hierarchy/Wallace、Sandwich）多轮表——原来在论文附录，rebuttal 首次引用
8. **Escalation gate 八格**（11,659 决策）——监督 10→30% 把合法放行 69.8→91.0%
9. **PACT-NET 九任务族 + 网络原生指标 + MCC 验证**（JD-4/5/6，来自 4YP 数据）
10. **多轮双模型 scaling**（AP-1）

**措辞级：**"frontier" 全文（含论文标题）改 "trade-offs across discrete operating points"；"erosion" 改 "opens additional disclosure channels"；删 "specificity threshold"。

## 三、需要您拍板的三件事

1. **标注员表述**：D（Hanxiang）按"非作者"处理，文中写 "five non-author annotators"。他做了 QC 验收、属 author-track 但不在作者名单。请确认这个表述您接受。
2. **Figure 1**：还没重画。文中已诚实写 "remains a pre-posting action, not claimed as complete"。要么发前画掉，要么保留这句。
3. **States n=5**：补跑失败（5 轮 resume 未过质量门），已按预案撤表、回到 n=2 保守表述（"future work, not claimed"）。如果您认为必须有这张表，需要再给实验时间。

## 四、已知边界（主动交代，防被抓）

- 多轮 track 的异族 judge 重判未做（文中已明写）
- GPT-5.5 与 GLM 的关系实验包不同，只比定性模式不比绝对值（文中已明写）
- MCC 网络验证是单次 run，标为 directional（文中已明写）
