# P9 Pure-Length 控制实验 — 全量 600 题版规划 v2（只规划，未执行）

2026-07-30，Claude（v2：按用户指示从 60 题扩到全量 600、双 responder、10×60 拆分 5 路并行）。

## 0. 设计一句话

P9（P1 逐字 + 323 词办公室废话，见 §1 全文）在**整套 PACT-PAIR 600 题**上跑，responder 分别为 **gpt-5-mini** 和 **DeepSeek V4 Flash**；若 P9 ≈ P1，纯长度效应被全量规模证伪，E2 的 "length" 质疑封死。

## 1. 政策文本

POLICY_P9.md 全文（wc -w = 323，禁词审计通过，隐私相关词仅 P1 自带两处）见本文件 v1 版 §1（git 历史 d04082e）或 /tmp/P9_draft.md；执行时原样落盘。

## 2. 条件矩阵（每条件 = 完整 600 题：Files Q1-200 + Todos Q201-400 + Actions A1-200）

| 条件 | 政策 | responder | 用途 | 基线来源 |
|---|---|---|---|---|
| C1 | P9 | gpt-5-mini | 核心 | 提交版 D1 行（Files 81.5% disc / States 63.0 / Actions block 43.0，n=200/track，2 reps 已发表） |
| C2 | P1 | deepseek-v4-flash | DeepSeek 基线（此前不存在） | 同批自比 |
| C3 | P9 | deepseek-v4-flash | 核心 | C2 |
| C4（可选） | P1 | gpt-5-mini | 同批重跑基线，消批次效应 | 与提交版 D1 互验 |

requester 恒 gpt-5-mini。judge：QA 用 e2_eval_input 管线（gpt-5-mini rubric 逐字），Actions 用 eval_actions 管线（GR-2 口径，分母固定 200）。

## 3. 并行结构（10×60 拆分，5 路同步）

600 题拆成既有的 10×60 splits（s01–s10）。**每条件 seed 5 个 sibling group**（同世界同政策、各自独立 alex/tina UUID——不允许多 worker 共打一个 UUID，工作区会互踩）；每 worker 顺序吃 2 个 splits（120 题）。

| 条件 | groups | UUIDs |
|---|---|---|
| C1 | 3500–3504 | 8d10–8d14 |
| C2 | 3505–3509 | 8d15–8d19 |
| C3 | 3510–3514 | 8d1a–8d1e |
| C4 | 3515–3519 | 8d1f–8d23 |

**波次**（遵守今天实测的并发带：≤7 活 worker）：
- 波 1：C1 的 5 worker（~2h：120 题 × ~1 min/题）
- 波 2：C2+C3 各 3 worker 共 6（DeepSeek 单题稍快，~2.5h）
- 波 3：剩余 worker 补完 C2/C3 + C4（如启用）
- 全程 seed 与 run 错峰（seed 是 DB 密集短任务，20 groups 分两批 seed）

墙钟合计 ~5–6h；随时可按 questionId 断点补跑（append，同 UUID）。

## 4. 铁律 0 执行单

- seed 前：ps census 无 8d10–8d23 占用；DB 查各 UUID 无既有行；无 seeder 在飞；内存 ≥1.5GB
- 注册改动：POLICY_P9.md 新建 + p9/m9 映射一行（照 p6/p7 抄）
- 每 worker 命令模板（C1 例）：

```
nohup caffeinate -dimsu tsx research/scripts/experiment_v2.ts single-all \
  --config p9 --requester-model gpt-5-mini --responder-model gpt-5-mini \
  --alex-id 00000000-0000-4000-8d10-000000000000 --tina-id ...8d10-100000000001 \
  --group 3500 --only <s01,s02 的 120 个 id> \
  --out-dir research/runs/rebuttal/p9_length_600/c1_w1 >> .../nohup.log 2>&1 &
```

## 5. 成本与预算

- mini 条件：Azure，≈$0
- DeepSeek 两条件：1,200 responder 调用 ≈ **$1.5–2**（OpenRouter，历史单价 200 题 ≈ $0.24）
- judge 全部走 Azure ≈$0。总预算 <$3，不碰 $30 红线

## 6. 预登记判读规则（n=200/track，95% CI ≈ ±6pp；比 60 题版严一倍）

主指标：QA disclosure（Files 与 Todos 分开报）；副指标 Actions unauthorized block。

| 结果（每 track 独立判） | 判读 |
|---|---|
| \|P9 − P1\| < 8pp | 该 track 无纯长度效应 |
| P9 比 P1 低 ≥10pp | 存在长度/形式效应 → 如实报告，E2 叙事降级，通知 Jindong |
| P9 比 P1 高 ≥10pp | 填充干扰合规 → 报干扰，不下长度结论 |

跨模型一致性是加分项：若 mini 与 DeepSeek 同向，结论写 "under two responder families"。
sanity：utility 各 track 与对应 P1 差 <10pp，否则该格作废查填充。

## 7. provenance 门（沿用全套）

responseReceived、无 error/contactErrors、requester/responder requested=resolved（DeepSeek 条件另验 servedId 从响应体读回）、policySha256 == P9 的 sha、完成判定一律逐 questionId 复算。

## 8. 交付物

`p9_length_600/` 下按条件归档 + 一张 4×3 结果表（条件 × track）+ 判读结论，进 rebuttal 时替换 E2 的 "length" 表述为 "content, not token count"（或按 §6 第二行如实降级）。
