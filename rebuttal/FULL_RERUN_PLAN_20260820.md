# Tech Report 全量重跑计划（2026-08-20 v3 — 定位：August 2026 model refresh）

清点基准：`/Users/zhx/Desktop/aicoo_techreport.pdf`（29 页新版，"SharedOS and PACT"；
开跑前对该 PDF 取 sha256 记录于此：`TODO`）。旧 21 页版（Systemind_TechReport_STR-2026-001.pdf 桌面版）已废弃。
成本锚点：`runs/azure-live-kimi-full/usage-summary.json`（600 题单步 = 1.86M in / 0.26M out / $2.83，
2026-07-21，Kimi K2.6 responder；此文件未入 git，数值抄录于此以便异机复核）。
预算：~$1,800。定价一律以 OpenRouter `/api/v1/models` 机读结果为准（2026-08-20 拉取）。

## 0. 已定决策

1. 所有 mini（gpt-5-mini、gpt-5.4-mini）→ **GPT-5.6 Luna**；Table 11 两条 mini 行合并。
2. DeepSeek V3.2 → **DeepSeek V4 Flash**，不引入 V4 Pro。
3. 快照：**0726 不存在**（OpenRouter 与 Azure catalog 双向核实），可固定的是 `deepseek/deepseek-v4-flash-0731`。
   `run_experiments.py` 的 legacy MODELS 表已改为 0731（注意：该表当前是死代码，见 §6.2）。
4. judge 换代 gate：见 §5。
5. Claude Opus 5：待 Hanxiang 定（§4）。
6. **定位改为 "August 2026 model refresh"，不称"复现"**：requester/responder/judge/provider 同时换代，
   旧新差异不可归因。为保留纵向可比性，增设桥接 cell（§2 E16）。
7. **Pulse 永久退役（2026-08-20，Hanxiang）**：rebuttal 用 Pulse 只是为与提交版对齐；本轮起全部实验
   跑新架构（PACT runner → SharedOS 846cbf6）。`rebuttal/runs/run_experiments.py` 的转交入口作废；
   sweep 工具链改用 per-config YAML + runner CLI（ds_grid 即模板）。多轮/requester-attempt 循环
   需在 PACT 侧新建（tick cadence 归 PACT、单 turn 归 SharedOS，符合 P-018 边界）。
8. **DeepSeek 先行 grid 已执行**（lead 指示）：single-turn 5 persona × 600 = 3,000，
   deepseek-v4-flash-0731，temperature 0、无 seed（Relace/Baidu 不支持，显式省略）、
   路由锁 [relace, baidu]（账户 data-policy 排除了第一方 deepseek 端点）、SharedOS 846cbf6 worktree、
   D2_SUBMITTED、category 判分（v2 gold 接线后离线重判）。实测 ~$0.0003/题，全量 ≈ $0.9。

## 1. 模型映射与核实后定价（OpenRouter，$/M in/out）

| 老模型 | 新模型 | 定价 | 备注 |
|---|---|---|---|
| gpt-5-mini | **GPT-5.6 Luna** | 0.20 / 1.20（:batch 半价） | responder/defender、judge、多轮双侧 |
| GPT-5.5 | **GPT-5.6 Sol** | **2.50 / 15**（:batch 1.25/7.5） | OpenRouter 价低于 OpenAI 直连报价（5/30），以实际路由为准 |
| GPT-5.4 | **GPT-5.6 Terra** | 2 / 12 | |
| GPT-5.4-mini | **GPT-5.6 Luna** | — | 与 mini 行合并 |
| Kimi K2.6 | **Kimi K3** | **3 / 15**（v2 的 2.60/13 作废） | BaseTen 无 seed |
| DeepSeek V3.2 | **DeepSeek V4 Flash 0731** | **0.14 / 0.28**（v2 的峰谷价表述作废） | |
| GLM 5.2 | **GLM 5.3** | 1.40 / 4.40 | 8/18 发布，不稳则退 5.2（0.966/3.036） |
| DS V4 Flash 0423（judge） | **DS V4 Flash 0731** | 0.14 / 0.28 | |
| （可选） | **Claude Opus 5** | 5 / 25（:batch 2.5/12.5） | §4 |

新 Table 11 requester 行：Sol / Terra / Luna / K3 / DS-Flash-0731（5 行，Luna 2 reps）；采纳 §4 则 +Opus 5。

## 2. 待跑实验清单（对应新版报告表号）

规模口径说明：eps = 单步 episode（一次 requester 触发 + 一次 responder turn + 判分）；
多轮条目按 trajectory 计（每条 ≤240 tick），不折算成独立观察。

| # | 实验（新版位置） | 规模 | 模型 | 预计成本 |
|---|---|---|---|---|
| E1 | Table 11 Files 跨 requester | 5 family × D0/D1/D2 × 200 + Luna 第二 rep 600 = **3,600 eps**（+Opus 后 4,200） | req 5 家；resp+judge Luna | ~$45 |
| E2 | Table 11 States QA | 3 × 2 reps × 200 = 1,200 eps | Luna | ~$5 |
| E3 | Table 11 Actions | 1,200 eps，DB-diff | Luna | ~$5 |
| E4 | §6.2 + Table 16 多轮 240-tick D0–D5 | **50 条 trajectory**（10/10/10/7/7/6 splits × 60 题） | Luna 双侧 | ~$70 |
| E5 | Table 12 关系条件 | 4 requester × fixed policy（~1,000 eps） | Luna responder | ~$5 |
| E6 | §6.3 rel-aware baseline + Table 7 mounting | 3 条件 × 5 profile × 400 = 6,000 trials | **Sol** | **~$180**（:batch → ~$90） |
| E7 | §6.3 GLM 复现 | ~500 trials | GLM 5.3 | ~$11 |
| E8 | Table 13/14 8-policy sweep | 8 × 60 = 480 eps | Luna | ~$2 |
| E9 | §6.4.1 frozen 30q responder control | P0/P2 × 2 responder × 30 = 120 eps | DS-Flash-0731 + GLM 5.3 | ~$1 |
| E10 | Table 15 P9 length control | 600 × 4 条件新跑（P1 锚点不复用历史，全部同代重测）× 双 responder = 4,800 eps；**注明这是对 P9_V3 的扩展而非照抄** | Luna + DS-Flash | ~$10 |
| E11 | §5.1 escalation gate | **合计 11,659 决策**（两模型八 cell 的总数，不再乘） | Luna + Sol | ~$45 |
| E12 | Table 17 PACT-NET | 台账口径：(997+75)×4 = **4,288 ticks** + MCC 1,072-tick runs（台账 #26）+ 997×4 判分 | Luna | ~$12 |
| E13 | §8 异族 judge 复评（含报告明写"多轮复评未完成"的补齐） | 全部新单步输出 + 多轮消息 | DS V4 Flash 0731 | ~$20 |
| E14 | §8 gold-string 判分 | 全部输出 | 无模型 | $0 |
| E15（可选） | Claude Opus 5（§4） | requester 行 600 + defender Files 1,800 + 30q control | Opus 5 | ~$90 |
| E16（新增，桥接） | 纵向可比桥接 cell | ① 老模型锚点 cell（均已核实在 OpenRouter：gpt-5.5 $5/$30、kimi-k2.6 $0.95/$4）：GPT-5.5 与 Kimi K2.6 × D0/D2 × 200；② 新 judge（Luna）+ 旧 judge 输出复评同一批旧 artifact（e4 verdicts 所在机器） | GPT-5.5 / K2.6 / Luna | ~$18 |
| 范围外 | 新版报告 Table 3–6/8–10/18 为**未填充 manifest**（infra agenda / governed views / context isolation / group meeting），属未来工作，不在本轮 refresh 内 | — | — | — |
| 范围外 | 多轮 model-scaling 表：仅存在于 NeurIPS 投稿附录，新旧 tech report 正文均无。若要跑（Sol 多轮 30 splits），另列 ~$360–700，需单独批准 | — | — | （未计入） |
| — | §8 人工标注 | 已完成、gold 冻结，不重跑 | — | $0 |

## 3. 总成本 vs 预算

- 必跑（E1–E14, E16）≈ **$415**；+E15 ≈ $505。
- ×1.5 reservation → **~$630–760**，$1,800 预算内余量充足。
- 若追加范围外的多轮 model-scaling（$360–700），总额仍可控（~$1,000–1,460 含预留）；先跑 1 条 Sol trajectory 实测再定。
- 杠杆：Sol lane 用 `:batch` 变体（半价）；多轮 lane 确认 provider prompt-caching。

## 4. Claude Opus 5（推荐加入，待定）

同 v2 理由：JD3a Q1 点名 Claude；家族覆盖加强外部效度；defender-side variation 是报告自列 open direction。
可用性双通道核实：OpenRouter `anthropic/claude-opus-5`（$5/$25，:batch 半价）+ 自有 Azure 部署。
披露：预标用过 Fable 5，gold 人工终裁、预标不进 gold；披露句写全"被测含 Claude 家族"。

## 5. Judge 换代 gate（v3 强化）

- 脚本：`rebuttal/runs/judge_agreement_check.py`（OpenRouter 优先，自动读 repo `.env`）。
- 样本：120 条已冻结（60 public / 60 sensitive，含 7 条 deterministic-leak）。**已知不足**：正例仅 7 条，
  总体一致率会被多数类淹没。补强（开跑前落地）：
  1. 正例扩容：从 azure-live / azure-live-mini / sharedos-harbor-600 运行中再收 leak 正例；不足则加
     gold-fact 注入 canary 正例（合成响应，仅用于 judge 灵敏度，不进任何论文数字）；
  2. 分层报告：surface × 正/负例 × 判定维度，输出 sensitivity / specificity / Cohen's κ / Wilson CI，
     以及新旧 judge 相对 gold-string 的配对非劣检验（McNemar，δ=5pp）；
  3. 多轮消息子集：从 heartbeat 产物抽 50 条消息级判定（服务 E13 的多轮复评承诺）。
- 通过标准：leak 判定 sensitivity ≥ 0.9 且 specificity ≥ 0.95，κ ≥ 0.8，非劣检验通过；任一不达即不切 judge。
- rubric：当前为按报告 §3.3 重建版；**跑正式 gate 前从 Pulse 侧取回提交版逐字 rubric**（E4 lane 用过 "the submitted rubric verbatim"）。
- 本地文件（脚本/样本/plan）尚未 commit，异机不可见——待 Hanxiang 决定是否入库（建议入库到当前分支）。

## 6. 执行就绪度缺口（No-Go 主因，逐条对账）

1. **报告版本**：✅ 已切换到 29 页新版（aicoo_techreport.pdf），表号对齐 Table 7/11–17；PDF sha256 待记录。
2. **执行路径**：lead 的 AI 说对了一半——
   - 平台本体拆分是干净的：`src/runner/v1` → `SharedOsExecutionAdapterV1`（sharedos-embedded/harbor），
     `src/` 无任何 Pulse 运行时依赖（仅 evaluation-tools 可读取 Pulse 旧产物格式用于复评，这是 feature）。
   - 但 `rebuttal/runs/run_experiments.py` 在 rebuttal 期被"退役"：`__main__` 直接 exec 转交
     `../pulse/research/scripts/rebuttal/run_experiments.py`（本机无 pulse repo → self-test 秒挂）。
     其下的 MODELS 表是死代码；真正生效的模型表在 Pulse 侧（尚无 5.6 三档 / GLM-5.3 / Opus 5）。
   - **决策点**：本轮 refresh 的单步 responder lane 建议走干净的 PACT→SharedOS 路径（8/7 已有
     sharedos-harbor-600 全量跑通记录）；需要双 agent 部署路径的 lane（E1 requester 轴、E4 多轮、E5 关系）
     要么取回/更新 Pulse repo 及其模型表，要么在 PACT 侧用 heartbeat 配置补 requester-driver。二选一后
     才能宣称 ready。
3. **SOURCE_MANIFEST 漂移**：lead 侧 self-test 报 frozen source changed——本机因缺 pulse 未到达该检查；
   取回 pulse 后需重新 `--self-test` 并按当前源重新冻结。
4. **矩阵数字**：E1=3,600（不含 Opus）、E4a 按 trajectory 计、E11 为合计 11,659、E12 按台账 4,288+MCC——均已在 §2 修正。
5. **judge gate**：按 §5 强化后再执行。
6. **定价**：Kimi $3/$15、DS-Flash $0.14/$0.28、无 0726 —— 均已修正；GLM 5.3 $1.40/$4.40 维持（lead 未质疑）；
   Sol 以 OpenRouter 实际路由价 2.5/15 入账。
7. **断点续跑**：已实现但只在 Harbor 后端 —— `feat/harbor-streaming-results`（`77e50d7`
   "stream Harbor per-trial results and resume interrupted runs in place"）。`sharedos-embedded`
   本地路径只有逐题流式落盘（results.jsonl 每题即写、中断不丢已完成数据），**无 resume**，
   中断的 run 需整段重跑。含义：长时 lane（多轮、Sol lane）与远程/无人值守执行应走 Harbor 后端，
   或先把 resume 移植到 embedded 路径；短的单步 persona run（~3h/600 题，~$0.2）重跑成本可接受。

## 7. 执行顺序

pulse 路径决策（§6.2）→ 逐字 rubric 取回 → judge gate（§5，通过才切 Luna judge）→ 重冻 SOURCE_MANIFEST →
`--self-test` → `--dry-run` → `--no-spend` → bounded paid smoke（核对 served model / route / cost completeness，
含 0731 pin 校验）→ 便宜 lane（E1–E3, E5, E7–E10, E12, E16）→ 实测重估 → Sol lane（E6, E11）→ E13。
所有 cell 结算只认 artifact-level cost；DeepSeek/GLM paired seed，K3 无 seed 照旧注明。

## 8.0 ⚠️ 区域可用性实测（2026-08-20，付费探针）

| 家族 | OpenRouter 本区域 | 实测 |
|---|---|---|
| OpenAI（gpt-5.5 / 5.6 Sol/Terra/Luna/mini） | **403 not available in your region** | 全系阻断 |
| Anthropic（claude-opus-5） | **403** 同上 | 阻断 |
| DeepSeek v4-flash-0731 | ✅ OK（served=…-0731, provider=Baidu） | 可用 |
| GLM 5.3 | ✅ OK（provider=Z.AI） | 可用 |
| Kimi K3 / K2.6 | ✅ OK（Chutes / Venice） | 可用 |

**后果**：纯 OpenRouter 无法承载本 plan 的大部分花费（Luna 所有 lane、Sol E6/E11、桥接 GPT-5.5、
Opus 5、judge gate 两个模型全部被阻断）。可选出路：
(a) 混合通道——OpenAI/Claude lane 回 Azure（catalog 有 5.6 三档可部署、opus-5 已部署，7 月即此通道），
open-weight lane 走 OpenRouter；(b) 海外部署机上跑 OpenRouter（7 月笔记已提过此 route）；
(c) OpenAI/Anthropic 直连 key（区域限制大概率同样存在，需验证）。**待 Hanxiang 选择。**

## 8. OpenRouter 接入（open-weight 家族通道）

- key 位置：`/Users/zhx/Desktop/aicoo/pact/.env` 的 `OPENROUTER_API_KEY=`（已填、`--check` 验证通过；
  `.env` 在 .gitignore，勿入库）。`.env` 中的 AZURE_* 两行留作历史，不再被任何脚本使用。
- **⚠️ key 限额 $80**（`/api/v1/key` 返回 limit=80）：低于全量 sweep 需求，正式开跑前先在
  OpenRouter 后台把 limit 提到 ≥$1,000，或按 lane 分次提额。
- 消费脚本：`judge_agreement_check.py`（OpenRouter-only）；sweep 侧 `PACT_MODEL_API_KEY` 复用同一 key。
- 定价/快照机读来源：`GET https://openrouter.ai/api/v1/models`（本 plan 价格取自 2026-08-20 快照）。
