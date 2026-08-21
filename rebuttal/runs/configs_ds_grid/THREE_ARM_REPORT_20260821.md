# D0 / D2_SUBMITTED / D2R_PRINCIPLES 三臂对照（2026-08-21）

模型：deepseek/deepseek-v4-flash-0731（Relace/Baidu 锁路由，temp 0）。
每臂 5 persona × 600 题（QA 400 + actions 200），全部 zero-gap（主 run + 两轮修补）。
判分：v2 relationship gold（600×5 人工标注矩阵），QA 用 evaluator 全量重判，action 按落盘
DB-diff 事实推导。runtime category 口径仅作参考，未用于本表。
产物：`rescore_v2_3arms.json`；run 目录 `ds_grid_{,d0_,d2r_}R*{,_repair,_repair2}`。
执行备注：D0/D2R 主 run 尾段遭遇本机断网，QA 尾部与全部 action 由两轮修补 run 补齐
（修补与主 run 同 config、同路由；错误任务不进任何分母）。

## 结果（v2 gold 口径）

| | utility(L)% | over-refusal% | disclosure(P)% | act execute✓% | act refuse-safe% |
|---|---|---|---|---|---|
| **D0** R0 | 100 | 0 | 80.7 | — | 39.5 |
| D0 R1 | 91.4 | 2.4 | 83.7 | 94.5 | 49.5 |
| D0 R2 | 88.5 | 2.3 | 89.2 | 97.0 | 33.8 |
| D0 R3 | 88.9 | 3.7 | 88.4 | — | 26.3 |
| D0 R4 | 88.7 | 3.2 | 87.0 | — | 29.5 |
| **D2_SUBMITTED** R0 | 100 | 0 | 47.9 | — | 47.5 |
| D2 R1 | 88.6 | 5.7 | 3.2 | 97.8 | 83.5 |
| D2 R2 | 74.7 | 19.2 | 2.9 | 97.0 | 67.7 |
| D2 R3 | 7.4 | 92.6 | 56.9 | — | 45.5 |
| D2 R4 | 74.2 | 16.1 | 41.4 | — | 46.5 |
| **D2R_PRINCIPLES** R0 | 100 | 0 | **4.5** | — | **100** |
| D2R R1 | 86.2 | 4.8 | 4.2 | 94.5 | 85.3 |
| D2R R2 | 74.3 | 17.2 | 2.2 | 95.5 | 66.9 |
| D2R R3 | **77.8** | **18.5** | **7.5** | — | **96.5** |
| D2R R4 | 77.4 | 9.7 | **42.3** ⚠️ | — | 96.0 |

## 读法

1. **D2R 同时修复了双向失败**：R3 close friend 的 utility 7.4→77.8（over-refusal 92.6→18.5），
   同时 disclosure 56.9→7.5；R0 stranger 的 disclosure 47.9→4.5、action refuse-safe 47.5→100。
   category 政策做不到的"给朋友开个人域、对陌生人关工作域"，把映射原则写进政策后模型能执行。
2. **无回归**：R1/R2（category 政策本来就对齐的 persona）在 D2R 下基本持平
   （R1: 88.6→86.2 util / 3.2→4.2 discl）。
3. **D0 基线确认模型裸先验几乎不设防**：disclosure 80–89%、action refuse-safe 26–50%，
   五 persona 无差别 —— 关系敏感性不是模型自发行为，是政策诱导的。
4. **⚠️ 遗留失败点：R4 investor disclosure 42.3%，D2R 几乎没改善（41.4→42.3）**。
   直接原因是政策里 "work product … in summary form to formal oversight" 这行——模型把大量
   工作类问题解释为可向投资人提供，而 v2 gold 只给 R4 62 个 L。这正是写政策时预先标记的
   "investor 线画在哪"的设计决策点，也呼应论文 Table 12 投资人拿到最多 reads 的观察：
   oversight 关系是授权语义最含糊的一类。改法有二：(a) 收紧该行（如 "only metrics and
   milestones your owner has designated for investor reporting"）；(b) 接受为 finding——
   原则式政策在语义边界模糊的关系上失效，需要 item 级授权。待 Hanxiang 定。
5. 循环性纪律已守：D2R 文本仅依据关系定义撰写、未参考 gold 标注（R4 的失败本身即是佐证）。

## 花费

三臂累计 ≈ $2.4（含全部修补与废弃的 REL 部分 run），OpenRouter key 余额充足（$80 限额）。

## 附录（2026-08-22）：D6_PRINCIPLES_TIGHT × R4 对照

政策：D2R 原文只改 oversight 一行（investor 仅限 owner 指定的 reporting
metrics/milestones，明示排除 ongoing work/documents/meetings/logistics）。
独立政策 ID（lead 决定：不改 D2R 原文；D3–D5 已被 defence registry 占用故取 D6）。
run：600 题 zero-gap（主 run 596 + 修补 5），成本 ≈ $0.115，served 全 0731。

| R4 | utility(L)% | over-refusal% | disclosure(P)% | act refuse-safe% |
|---|---|---|---|---|
| D2R_PRINCIPLES | 77.4 | 9.7 | 42.3 | 96.0 |
| **D6_PRINCIPLES_TIGHT** | **24.2** | **67.7** | **5.3** | **99.5** |

读法：收紧把泄露压掉了（42.3→5.3，act refuse-safe 96→99.5），但 utility 塌了
（77.4→24.2）——模型现在把 gold 判给 investor 的 62 个 L 里的大多数也拒了。
两版政策合起来把 trade-off 钉死了：宽措辞多放 ~125 个 P，紧措辞多拒 ~33 个 L，
中间没有一句自然语言能恰好切在 gold 的 62/338 边界上。这正是"oversight 关系
授权语义天然含糊、原则式政策在此失效、需要 item 级授权（designated list 作为
数据而非散文）"的完整定量证据——两个 run 都保留为 finding；按总分算 D6 版
R4 明显更高（P 分母 338 ≫ L 分母 62），但按论文叙事应报 trade-off 本身。
循环性纪律：D6 措辞同样只依据关系定义撰写，未参考 gold（utility 塌方本身即佐证）。
