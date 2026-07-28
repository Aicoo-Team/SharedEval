# Cross-model 实验修复与重跑方案

版本 2026-07-27。起因：`lib/ai/tools/agent-network.ts:254` 将 responder 模型写死为 `gpt-5-mini`，导致所有"跨模型"实验实际未改变任何模型。本文件给出 story 重构、逐行代码改动、重跑设计。

## 0. 事实基础（已由代码与 git 确认）

| 时间 | 事件 |
|---|---|
| 2026-04-13 `d68586857` | `:254` 写入 `getAzureProviderConfig("gpt-5-mini")`。`git log -L 254,254` 显示此行**从未被任何 commit 修改** |
| 2026-05-02 ~ 05-05 | 全部 cross-model 实验执行完毕（g2000–g2045） |
| 2026-05-06 `b99b8fb10` | `EXPERIMENT_MODEL` 首次进入代码，且**只写在 metadata 参数里**，不影响推理 |

结论：launcher 设置的环境变量，在实验跑完 4 天后才被写进代码，且写进去的位置也不生效。

### 各批实验的真实状态

| 批次 | launcher | requester | responder | 可救？ |
|---|---|---|---|---|
| Cross-model Files/Todos（g2000–g2045） | `launch_ss_rep2.sh`、`launch_crossmodel_todos.sh` | **gpt-5-mini**（未传 `--model`） | **gpt-5-mini**（写死） | ❌ 两轴皆未变，只能重跑 |
| Defense prompt（g4000–g4005） | `launch_ss_defense.sh`、`launch_ms_defense.sh` | gpt-5-mini / gpt-5.5 ✅ | gpt-5-mini（写死） | ✅ 真 attacker ablation，改标签保留 |
| 10-split multi-turn | `launch_msplit10_gpt55.sh` | 传了 `--model` ✅ | gpt-5-mini | ✅ 同上 |
| D3 / relationship / MCC / escalation | `run_d3_relationship.ts` 等 | — | **自建模型，`--model` 真生效** ✅ | ✅ 完全不受影响 |
| PACT-NET | `run_pact_net_v2.ts` | 独立路径 | 需单独核查 | ⚠️ 待查 |

Run artifact（`results.jsonl`）**不含任何模型字段**，所以此问题在数据层无法自查，只能读代码发现。这是必须一并修掉的根因。

## 1. Story 重构

### 原 story 的隐含错误

论文把"模型"当作一个一维轴（"six model configurations"）。但本文的核心前提是**跨所有权边界的委托**——requester 和 responder 属于不同主人，本就可以是不同厂商的模型。把两侧塌缩成一个"模型"变量，既不符合论文自己的设定，也正是这个 bug 能藏住的原因。

### 新 story

> **A2A 场景下的 security–utility 权衡是"一对模型"的属性，而不是单个模型的属性。**

实验对象从一维变成二维网格：行 = responder（防守方）模型，列 = requester（提问方）模型。

三个可回答的新问题：

1. **哪一轴主导？** 同样的 policy 下，换强防守方 vs 换强提问方，哪个对泄露率影响更大？如果防守方主导，说明 policy 设计应针对防守方；如果提问方主导，这是一场军备竞赛。
2. **对角线（双方同模型）是否代表真实部署？** 现实中两个用户各自用自己的 agent，同模型是常见情形。
3. **policy 效应是否跨防守方稳健？** 这才是论文原本声称、但实际没有证据的那个 claim。

### 为什么这个 story 更强

- 每个网格单元都是一个 operating point，直接回应 aP1N Q1 和 TtBh Q4 要的"点太少"；
- "安全是一对模型的属性"是一个此前无人报告的结论，把整改变成了贡献；
- 与论文的 cross-boundary 主题自洽，不是补丁式的辩解。

### 诚实边界

新表必须写明：D0/D1/D2 的原始 RQ1 结论是在 **gpt-5-mini 双侧**上建立的；跨模型稳健性由本次重跑的网格支持。旧的六模型表整体撤回，不做"改标签"处理。

## 2. 代码改动清单

### 改动 1（核心）：`lib/ai/tools/agent-network.ts` :254 与 :277

**这是生产代码**，`contact_agent` 被真实 Aicoo 用户使用。默认值必须保持 `gpt-5-mini`，且生产环境不得设置该环境变量。

```ts
// BEFORE (:254)
const azureConfig = getAzureProviderConfig("gpt-5-mini");

// AFTER
const responderModelId = process.env.PACT_RESPONDER_MODEL?.trim() || "gpt-5-mini";
// getModelConfig() 对未知 id 只 console.warn 然后静默回落到 pulse-standard，
// 这会造出第二种假数据，所以必须先断言。
if (!getAvailableModels().includes(responderModelId)) {
  throw new Error(
    `[PACT] Unknown responder model "${responderModelId}". ` +
    `Registry: ${getAvailableModels().join(", ")}`
  );
}
const azureConfig = getAzureProviderConfig(responderModelId);
console.log(
  `[PACT] responder model=${responderModelId} deployment=${azureConfig.deployment}`
);
```

```ts
// BEFORE (:277) —— 这一行是 metadata，改它没有任何效果，是本次事故的直接来源
model: process.env.EXPERIMENT_MODEL || "gpt-5-mini",

// AFTER —— 与真正生效的变量同源，杜绝二者再次分叉
model: responderModelId,
```

import 需补 `getAvailableModels`（与 `getAzureProviderConfig` 同一模块，`lib/ai/chat/language_model_apis.ts:472`）。

注意 :271 的注释 `// gpt-5-mini (reasoning model) requires temperature=1.` —— 换成 DeepSeek/Kimi/Qwen 后此假设需重新确认，必要时按模型分支设置。

### 改动 2：provenance 落盘 —— `research/scripts/experiment_v2.ts` `cmdSingleAll`（约 :1085）

```ts
const requesterModelId = modelOverride || 'gpt-5-mini';
const responderModelId = process.env.PACT_RESPONDER_MODEL?.trim() || 'gpt-5-mini';

await writeFile(path.join(runDir, 'run_meta.json'), JSON.stringify({
  requesterModel: requesterModelId,
  responderModel: responderModelId,
  requesterDeployment: getAzureProviderConfig(requesterModelId).deployment,
  responderDeployment: getAzureProviderConfig(responderModelId).deployment,
  mLevel, group: groupLabel, from: fromQ, to: toQ,
  gitSha: execSync('git rev-parse HEAD').toString().trim(),
  startedAt: new Date().toISOString(),
}, null, 2));
```

并在每条 `results.jsonl` 记录里加 `requesterModel` / `responderModel` 两个字段。**没有这一步，重跑出来的数据仍然无法自证。**

### 改动 3：新 launcher `research/scripts/launch_grid.sh`

两轴都显式传，且缺一个就报错：

```sh
# group mLevel requester responder alexId tinaId
RUNS=(
  "3000 m0 gpt-5-mini gpt-5.5      <alex-uuid> <tina-uuid>"
  "3001 m1 gpt-5-mini gpt-5.5      ..."
  ...
)

[[ -n "$requester" && -n "$responder" ]] || { echo "both models required"; exit 1; }

PACT_RESPONDER_MODEL="$responder" \
NODE_OPTIONS="--require ./research/scripts/env-preload.js" \
  npx tsx research/scripts/experiment_v2.ts single-all \
  --config "$mlevel" --model "$requester" \
  --alex-id "$alex_id" --tina-id "$tina_id" --group "$group" \
  --from 1 --to 200
```

每个网格单元用**独立的 alex/tina UUID**（沿用现有做法），但需先确认各 workspace seeding 一致——旧数据里组间 utility 78→98 的差异无法归因于模型，只能来自 workspace 状态，这本身要查清。

### 改动 4：旧 launcher 加护栏

`launch_ss_rep2.sh`、`launch_crossmodel_todos.sh` 顶部插入：

```sh
echo "DEPRECATED: this launcher sets EXPERIMENT_MODEL, which never affected the responder."
echo "It produced the retracted cross-model results. Use launch_grid.sh."
exit 1
```

防止任何人（包括未来的自己）再跑出一批假数据。

### 改动 5：judge 可配（顺带完成 E4）

六个 eval 脚本的硬编码 `getAzureProviderConfig("gpt-5-mini")` 改为：

```ts
const judgeModelId = process.env.PACT_JUDGE_MODEL?.trim() || "gpt-5-mini";
```

涉及文件：`eval_single_step.ts:233`、`eval_multistep.ts:278`、`automated_eval.ts:316`、`eval_v2_add_llm_judge.ts:62`、`solutions/eval_llm_judge.ts:110`、`thesis/pact-bench-submission/scripts/automated_eval.ts:316`。同样需要断言 + 把 judge 模型写进 eval 输出。

### 改动 6：冒烟测试（跑全量前必做）

```sh
PACT_RESPONDER_MODEL=deepseek-v3 npx tsx ... --from 1 --to 20 --group smoke-ds
PACT_RESPONDER_MODEL=gpt-5-mini  npx tsx ... --from 1 --to 20 --group smoke-mini
```

然后 diff 两组 `alexResponse`。**如果风格上无法区分，说明改动没生效**——这正是上次"修复"失败而无人察觉的原因。同时确认 `run_meta.json` 里的 deployment 字段确实不同（`DeepSeek-V3.2-1` vs `gpt-5-mini-1`）。

## 3. 重跑设计与优先级

Azure registry 现有可用 id：`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5-mini`、`deepseek-v3`(→`DeepSeek-V3.2-1`)、`kimi-k2`(→`Kimi-K2.6-1`)、`grok-4`。
OpenRouter 可补新家族：`deepseek/deepseek-v4-flash`、`z-ai/glm-5.2`、`moonshotai/kimi-k3`、Qwen 系列。（Anthropic 与 Google 在当前区域被 403 封锁。）

| 优先级 | 实验 | 设计 | 规模 | 回应 |
|---|---|---|---|---|
| **P0** | Defender 轴 | requester 固定 gpt-5-mini，responder ∈ 6 模型 × D0/D1/D2 × 200 Files | 3,600 | 补回论文现有 claim；aP1N Q1、JD3a Q3 |
| **P1** | 对角线 | requester = responder ∈ 6 模型 × D0/D1/D2 × 200 | 3,600 | 真实部署形态 |
| **P2** | Attacker 轴 | responder 固定 gpt-5-mini，requester ∈ 6 模型 × D0/D1/D2 × 200 | 3,600 | 部分已有（g4000–4005 可改标签补充） |
| **P3** | 全网格 | 6 × 6 × D2 × 200 | 7,200 | 若预算允许 |

建议先跑 P0 的 D0/D2 两档（跳过 D1，它在所有旧数据里都近乎无效），即 6 × 2 × 200 = 2,400 次，出结果后再决定是否补 D1 和 P1。

## 4. 必须同时处理的两件事

1. **今天告知导师与 Kevin。** 这是已发表 claim 的事实基础不存在，不是补实验的量级。自查发现主动更正与被他人发现，性质完全不同，且直接影响 rebuttal 发帖时间线。
2. **Rebuttal v3 中下列内容在重跑完成前不得发布**：Table GR-1 六模型表、§1.2 "recurs across six model configurations from three vendor families"、aP1N Q1 中 "69–91 pp across all six models"、Table GR-2 与 JD3a Q1 中 Kimi/DeepSeek 的 gold-string 行、以及给 Kimi 标注的 "~12% infrastructure errors"（该 errors 实为 g2024 组的 23/200，而该组并未运行 Kimi）。
