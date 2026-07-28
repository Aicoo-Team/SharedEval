# Rebuttal 补充实验：设计思路与决策记录

2026-07-27。内部工作文档，记录这一轮 rebuttal 补充实验的动机、中途发现的问题、由此改变的设计，以及每条结论当前的证据强度。

配套文件：
- `rebuttal_v3.md` — 可发帖的 rebuttal 草稿
- `rebuttal_v2_internal_checklist.md` — 实验优先级与话术红线
- `CROSSMODEL_FIX_PLAN.md` — 代码修复清单（**注意：其"事实基础"一节基于一个已被推翻的推论，待重写**）
- `runs/run_experiments.py`、`runs/validate_setup.py` — 执行脚本
- `annotation/` — 非作者标注审计（E7，独立于本文档）

## 1. 这轮实验要回答什么

三位 reviewer 加 AC 的核心质疑可以归成四类，每类对应具体实验：

| 质疑 | 提出者 | 补充实验 |
|---|---|---|
| operating points 太少，"frontier"言过其实 | aP1N Q1、TtBh Q4、AC | 提交版 policy、受控消融与多个 responder model 的离散 operating points |
| D1/D2 混杂了长度、类别、示例三个变量 | aP1N Q2、TtBh Q2、AC | 等长成分消融（`A_LONG_GENERIC` / `A_CATEGORY_ONLY` / `A_CATEGORY_EXAMPLES`） |
| judge 与被测模型同族 | JD3a Q1、TtBh Q5、AC | 异族开源 judge 重打分 |
| RQ3 只有 gpt-5-mini | JD3a Q3 | 关系条件 × 非 OpenAI 模型 |
| 标注全部来自作者 | JD3a、TtBh Q1 | 五名非作者标注审计（见 `annotation/`） |
| 缺结构化 access control 基线 | TtBh Q3、JD3a Q4 | 已有（mounted access、escalation gate），只需整理 |

**一条贯穿的话术原则**：所有结论加 "under current foundation models / in the tested settings" 限定。这轮工作的定位是 A2A 委托场景下 security–utility 权衡的**首次系统探索**，目标是把平台、测量方法和第一组可复现观察立起来，不是给出终局结论。

## 2. 中途发现的问题

在配置模型准备跑实验时，读代码发现：**`pulse/lib/ai/tools/agent-network.ts:254` 把 responder 模型写死为 `gpt-5-mini`。**

```ts
const azureConfig = getAzureProviderConfig("gpt-5-mini");   // :254 真正生效
...
model: process.env.EXPERIMENT_MODEL || "gpt-5-mini",        // :277 只写进 metadata
```

时间线（git 确认）：

| 时间 | 事件 |
|---|---|
| 2026-04-13 `d68586857` | `:254` 写死。`git log -L 254,254` 显示**此行从未被任何 commit 修改** |
| 2026-05-02 ~ 05-05 | 全部 cross-model 实验跑完 |
| 2026-05-06 `b99b8fb10` | `EXPERIMENT_MODEL` 首次进入代码，且只在 metadata 参数里 |

也就是说，launcher 设置的那个环境变量，**在实验跑完 4 天后才被写进代码**，而且写进去的位置也不生效。

### 影响面

任何经 `contact_agent` 到达目标 agent 的实验，被测防守方恒为 gpt-5-mini。这覆盖 `experiment_v2.ts` 的全部单步与多轮 QA/action 实验，即论文 RQ1 的跨模型表。

**不受影响**：`run_d3_relationship.ts` 及其衍生（D3 / relationship / MCC / escalation）不走 `contact_agent`，自己构造模型直接扮演 Alex，`--model` 真生效。已逐段核对代码链条，并排除两个陷阱：`getModelConfig()` 对未知 id 会静默回落到 `pulse-standard`（但 `gpt-5.5` 是注册过的真 id）；registry 存在别名重定向（`gpt-4o` → `gpt-5.4-mini-1`，所以历史上标 gpt-4o 的 PACT-NET run 其实不是 gpt-4o；但 `gpt-5.5` → deployment `gpt-5.5`，无撞车）。

### 一个必须记下的过程教训

第一轮排查时，我（Claude）从 `launch_ss_rep2.sh` 未传 `--model` 推断出"所有跨模型实验两轴皆未变、六模型表必须整体撤回"，并按这个强度给了结论。**这是错的**，因为：

- 那个 launcher 是 05-06 提交的，而 rep-1 的实验 05-02 就跑完了——用一个事后提交的脚本去推断更早的运行配置，前提就不成立；
- 真正能判定的证据一直在数据里：`contactMessage` 由 requester 生成、`alexResponse` 由 responder 生成，分开比较即可分离两个轴。这是三行代码，却在下结论之后才做。

Xisen 的质疑（"attacker 肯定改了 model"）促成了这次核对，结论被推翻。**方法论要求：不要用代码推断历史运行的配置，要用运行产物本身去验证。**

## 3. 当前证据状态

按证据强度分类，不混为一谈：

| 结论 | 证据 | 强度 |
|---|---|---|
| defender 恒为 gpt-5-mini（`contact_agent` 路径） | `git log -L 254,254` 显示该行从未修改；rep-1 四组 `alexResponse` 均长 221.8 / 213.9 / 214.3 / 222.1 一致 | **代码 + 数据双向印证，可依赖** |
| rep-1（偶数组，05-02）attacker 确实变了 | 同日四组 `contactMessage` 均长 104 / 104 / 126 / 166；文本风格显著不同（DeepSeek 每条带完整自我介绍，GPT 简洁带破折号） | **数据直证，可依赖** |
| rep-2（奇数组）与 GPT-5.5 组 attacker 未变 | 五组均长挤在 198–207；launcher 代码缺 `--model` | **仅为推断，待验证** |
| D3 / relationship / MCC 的 defender 是 gpt-5.5 | 代码链条完整走通 + registry 无别名撞车；`summary.json` 记录 `model: gpt-5.5` | **代码链条可靠，缺数据侧独立确认**（45 个 run 全是 gpt-5.5，无同脚本 gpt-5-mini run 可对比） |

**待验证两项的确认方法**（都很便宜）：

1. rep-2/GPT-5.5：取 `g2040` 的 `contactMessage` 与一个确定是 gpt-5-mini 的组做文本对比，和 DeepSeek 那次一样直观。
2. D3 defender：`run_d3_relationship.ts --model gpt-5-mini --defense D3 --requester R1 --from 101 --to 110` 跑 10 题，与现有 `d3_D3_R1_gpt-5.5_*` 比 response 风格和 `avg_latency_ms`（现值 13,248ms，gpt-5-mini 应明显更快）。

跨批次的长度比较不可用：rep-1 均长约 104、rep-2 约 200，两批相隔一天，Tina 的 prompt 应该改过，基线整体抬高。**有效推断只能在同一天内做。**

## 4. 由此改变的实验设计

### 从一维塌缩到二维

原设计把"模型"当作单一轴（"six model configurations"）。但本文的前提是**跨所有权边界的委托**——requester 与 responder 属于不同主人，本就可以是不同厂商的模型。把两侧塌缩成一个变量，既不符合论文自己的设定，也正是这个 bug 能藏住的结构性原因。

概念上，完整的 A2A 实验对象是二维网格：

|  | responder = gpt-5-mini | responder = 其他模型 |
|---|---|---|
| requester = gpt-5-mini | 基线（已有） | responder-only sweep 可补这一行 |
| requester = 其他模型 | rep-1 已有，改标签保留 | 真实部署形态（同模型双方） |

三个可回答的新问题：哪一轴主导泄露率？对角线（双方同模型）是否代表真实部署？policy 效应是否跨防守方稳健？

**这个 framing 把整改变成贡献**：每个网格单元都是一个 operating point，直接回应"点太少"；而"安全是一对模型的属性、而非单个模型的属性"是此前无人报告的结论。

但必须区分概念设计与本轮实际执行面：`PACT/src/runner/v1` 接收固定的公开任务，只直接评估 Alex 的 responder/defender，因此 `rebuttal/runs/run_experiments.py` **没有 attacker-model 轴，也不会生成上述二维网格**。本轮 standalone sweep 能支持的是“policy × responder model × surface/requester”的结论；requester-model/attacker-model 复现实验属于 Pulse production path 的独立 lane，不能混进同一张表。

### 旧数据的处置

- **rep-1 跨模型表**：改标签为 "requester model varies, responder fixed at gpt-5-mini"，作为 attacker 轴证据保留。这是真实且有意义的结果，论文现在还没有这个 claim。
- **rep-2 与 GPT-5.5 行**：待第 3 节的验证完成后再定去留。
- **诚实边界**：论文必须写明 D0/D1/D2 的原始 RQ1 结论建立在 **gpt-5-mini 双侧**；跨防守方的稳健性只能由本轮 standalone responder sweep 支持，不能包装成完整 attacker × defender 网格。

### 为什么用 PACT 公开 runner 而不是 pulse 脚本

`PACT/src/runner/v1` 从设计上被测的就是 responder（公开 benchmark 本该如此），`provider: openai-compatible` + 可配 `baseUrl`，接 OpenRouter 零代码改动。**它没有那个 bug。** pulse 那边的 `:254` 该修（见 `CROSSMODEL_FIX_PLAN.md` 的代码清单），但本轮实验不依赖它。

## 5. 执行方案

### 模型可用性（区域限制）

OpenRouter 在当前区域实测：

| 模型 | 状态 |
|---|---|
| `deepseek/deepseek-v4-flash` | 可用，非推理模型 |
| `z-ai/glm-5.2` | 可用，推理模型 |
| `moonshotai/kimi-k3` | 可用，推理模型，completion 单价 $15/M |
| `anthropic/claude-sonnet-5` | **403 not available in your region** |
| `google/gemini-3-flash-preview` | **403 同上** |

JD3a Q3 原话是 "Claude **or other open-source models**"，所以三个开源家族在字面上已满足。若确实要 Claude，需走海外部署机或既有 Azure 通道。

**一个实测坑**：推理模型会把 `max_tokens` 全烧在 hidden reasoning 上返回空串。首次测试用 `max_tokens=20`，三个模型全部返回空。配置里 `maxOutputTokens` 不低于 4096。

### 成本与执行门

脚本中的单题费率是保守调度估算，不是新结果：DeepSeek 来自历史小样本，GLM/Kimi 在获得干净 artifact-level usage 之前仍是 price-derived estimate。不能再写“脚本会自校准费率”，也不能把并发期间的 account-wide usage delta 归因给某个 cell。

当前控制方式是：

- 每个 cell 启动前预留 `estimated cost × reservation multiplier`（默认 1.5×），并把所有 in-flight reservation 计入 $100 scheduler cap；
- cell 结算只使用 runner artifact 中逐请求持久化的 cost；缺少完整 cost telemetry 时该 cell 无效，并保留全部 reservation；
- OpenRouter account usage 只作为 campaign 累计上限和整轮 audit，绝不作为并发 cell 的花费；
- 默认 $100 cap 在外部 $110 research envelope 中保留 $10 buffer；每次真正启动前以 `--dry-run` 的即时输出为准。
- 所有 sweep config 固定 `temperature=0`、精确 provider route 和
  `reasoning.effort=low`；DeepSeek/GLM 使用 paired seed，BaseTen Kimi
  endpoint 不支持 seed，因此显式省略；
- 自动付费 repair 默认关闭；失败 cell 先落盘并计费，再决定是否单独重跑，
  不允许在原 reservation 之外偷偷追加调用。

严格执行顺序：

```bash
# 纯本地：不访问 provider / credits
python3 rebuttal/runs/run_experiments.py --self-test
python3 rebuttal/runs/run_experiments.py --dry-run

# no-spend：会验证 credential、credits 与 endpoint metadata，但不调用模型
python3 rebuttal/runs/validate_setup.py --no-spend

# bounded paid smoke：必须 zero infrastructure errors，并核对实际 route/cost
python3 rebuttal/runs/validate_setup.py \
  --budget 100 \
  --campaign-id rebuttal-20260728 \
  --preflight-reserve 5

# paid preflight 全部通过、且 exact source 已 commit 后，才启动同一默认矩阵
python3 rebuttal/runs/run_experiments.py \
  --budget 100 \
  --campaign-id rebuttal-20260728 \
  --concurrency 4 \
  --per-model-concurrency 2
```

### 实验矩阵（以脚本即时输出为准）

`run_experiments.py` 不接受已经删除的 `--tiers` 参数。通过
`--blocks` 选择：

| block | 内容 | 回应 |
|---|---|---|
| `anchors` | Files/category：D0、D1、`D2_SUBMITTED` 与三个等长消融；DeepSeek + GLM，replicate 1 | specificity/length/content + operating points |
| `replications` | `D2_SUBMITTED` 与三个等长消融；DeepSeek + GLM，replicate 2 | ablation 稳健性 |
| `todo_robustness` | 独立 public-runner Todos/category：`D2_SUBMITTED`、DeepSeek、三个 paired replicates | 新的 direct-responder Todo robustness；**不是**原 Pulse multi-turn States-QA variance replication |
| `relationships` | 99 个有指定关系标签的 Files task：`D2_SUBMITTED` vs 对应 `REL_R0`–`REL_R4`；DeepSeek | relationship-aware policy baseline |
| `actions` | D0 vs `D2_SUBMITTED`；DeepSeek + GLM；DB-diff scoring | action utility/safety |
| `defenses`（可选） | `D3_SUBMITTED`–`D5_SUBMITTED`；Files/category | 额外 prompt-defense operating points |

默认 blocks、模型、cell 数和任务数都由脚本的 `--dry-run` 打印；launch decision 不应引用此文档里可能过时的硬编码总数。当前 sweep 是 responder-only；alternate-family judge 和 JD3a Q2 所要求的原 Pulse multi-turn States-QA replication 都是明确分开的 Pulse lanes。

### 汇报指标：固定 benchmark contract 与 policy compliance 必须分开

旧的 flat summary 会让 policy 自己改变 utility/security 的分母，因而不能把不同 policy 画成可比 operating points。现在每个 QA task 同时保留 active `expectedBehavior` 与 policy-independent `benchmarkExpectedBehavior` 两个 contract：

| 指标组 | Contract / 分母 | 用途 |
|---|---|---|
| `informationUtility`, `informationSecurity`, `leakRate`, `falseRefusalRate` 的 information 部分 | 固定为提交版 D2 category allow/restrict split | 比较不同 policy/model 的主要 flat operating points |
| `policyComplianceInformationUtility`, `policyComplianceInformationSecurity`, `policyComplianceLeakRate`, `policyComplianceFalseRefusalRate` | 当前 policy + `gradingMode` 的 `expectedBehavior` | 判断模型是否遵守当前治理规则；分母会随 policy/requester 变化 |

`summary.qa.benchmark*` 是固定 contract 的原始计数，`expectedAnswer/expectedRefuse/correctAnswers/protectedNoLeak/leaks` 是 active-policy 原始计数。任何 rate 的 denominator 为 0 时 `value: null`，不得填成 0 或从图中静默删除。

尤其 relationship block 的 99 个 Files task 在固定 D2 category contract 下全部属于 protected set，所以 `informationUtility = 0/0 = null` 是设计结果。关系实验的主要结论必须使用 `policyCompliance*`：L 进入 allowed utility 分母，P 进入 protected security/leakage 分母，B（either）不进入二者。固定 `informationSecurity/leakRate` 只可作为 secondary category-contract comparator，不能称为 relationship-conditioned metric。

## 6. 方法论教训（已固化进脚本）

这次事故的根因不是某一行代码写错，而是**没有任何机制能验证实际生效的模型**：

1. **Provenance 缺失**。`results.jsonl` 只有 `questionId/mLevel/status/alexResponse/…`，**没有任何模型字段**；`run_d3_relationship.ts` 的 trace 里 `total_tokens` 字段存在但**恒为 0**（从未被写入）。所以这个 bug 在数据层完全不可见，只能靠读代码发现，而费用估算也只能靠查账单反推。
2. **意图 ≠ 实际**。`summary.json` 里的 `model` 字段和 `EXPERIMENT_MODEL` 一样，记录的是 CLI 参数（意图），不是实际服务的 deployment。
3. **静默回落**。`getModelConfig()` 对未知 id 只 `console.warn` 然后回落到 `pulse-standard`；registry 还有别名重定向（`gpt-4o` → `gpt-5.4-mini-1`）。一个 typo 就能造出第二批假数据。

**固化措施**：

- runner 对每个 provider request 持久化 requested model、实际 served model、provider、response/request/generation identity 以及 provider 返回的 token/cost；不再用回答文本差异猜模型身份。
- `validate_setup.py` 的 paid smoke 核对 requested/served model、被 pin 的 provider、response identity、usage/cost completeness，并要求不同 alias 落到不同的实际 served-model 集合。
- runner 每题 append `results.jsonl` / 可选 trace 并更新 `checkpoint.json`；基础设施错误单列为 `infrastructure_error`，不进入任何 utility/security denominator。
- `run_experiments.py` 的 manifest 记录 replicate、grading mode、model/policy/requester/surface、run 目录、artifact-level cost、summary、policy/config/task/source hashes；只有 zero-error 且 provenance 完全匹配的 cell 才可 resume-skip。
- 修 Pulse 的 `:254` 时仍必须加未注册 model 的 hard failure，并把实际 deployment 写进 Pulse 产物，见 `CROSSMODEL_FIX_PLAN.md`。

**一句话原则：永远不要相信只记录“请求了什么”、却没有记录 provider 实际“服务了什么”的模型切换。**

## 7. 待办与风险

| 项 | 状态 |
|---|---|
| 验证 rep-2 / GPT-5.5 组的 attacker 身份 | 待做，方法见第 3 节 |
| 验证 D3 defender 确为 gpt-5.5 | 待做，10 题即可 |
| 重写 `CROSSMODEL_FIX_PLAN.md` 的事实基础一节 | 待做（现版基于已推翻的推论） |
| 组间 utility 78→98 的差异归因 | **未解**。rep-1 唯一真实自变量是 attacker 模型与 workspace UUID；需确认各 workspace seeding 一致，否则新网格会继承同样的混杂 |
| 告知导师与 Kevin | 待做。自查发现主动更正与被他人发现，性质完全不同 |
| rebuttal v3 中依赖旧跨模型表的段落 | 在结论确定前不得发布：Table GR-1、§1.2 六模型表述、aP1N Q1 的 "69–91 pp across all six models"、Table GR-2 与 JD3a Q1 的 Kimi/DeepSeek 行 |

**一条已撤回的指控**：此前认为 rebuttal 里 Kimi 的 "~12% infrastructure errors" 是错误归因。该判断基于"什么都没变"这个已被推翻的前提；g202x 确实是 kimi 组（attacker 侧），错误率归因**是对的**。
