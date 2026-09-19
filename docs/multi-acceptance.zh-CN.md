# SharedEval Multi 验收总表

更新日期：2026-09-19。这里集中列出方案、代码 PR、测试证据和未完成门槛。
下表的原始交付栈仍为 draft。后续 #68–77 已进入 PAIR phase2 分支，尚未进入 main；
详见[当前 PR 收敛计划](pr-convergence-2026-09-19.md)。程序测试、独立审核和真实模型实验分别记录。

## 本次可验收的交付

| 交付 | 入口 | 当前状态 |
| --- | --- | --- |
| PAIR / NET Multi 完整执行方案 | [执行方案](multi-execution-plan.md) | 包含运行边界、状态持久化、Single 对照、权限、评分和分阶段验收 |
| PAIR 实现与修复 | [PR57](https://github.com/Aicoo-Team/SharedEval/pull/57)、[PR67](https://github.com/Aicoo-Team/SharedEval/pull/67) | 持久世界及恢复/覆盖协议代码可审核；PR67 两项 P2 均已独立关闭，CI 通过，本地全库一项 FIFO 失败保留 |
| NET 实现 | [PR59](https://github.com/Aicoo-Team/SharedEval/pull/59) → [PR62](https://github.com/Aicoo-Team/SharedEval/pull/62) → [PR63](https://github.com/Aicoo-Team/SharedEval/pull/63) → [PR64](https://github.com/Aicoo-Team/SharedEval/pull/64) → [PR65](https://github.com/Aicoo-Team/SharedEval/pull/65) | 原生多 actor、assigned profile、多 case 世界、统一 CLI、评分来源与一致性检查 |
| 组合版本完整检查 | 独立组合树 `e93d46f934987f380137a684f244fff9f6e66a43` | required SharedOS `pnpm check` **1005/1005**；零失败、取消、跳过；目录及类型检查通过 |
| 旧 NET 记录跨版本续跑 | [组合验收报告](integration-pair-recovery-2026-09-13.md) | 四种场景通过；旧版 20 回合 + 新版续跑 28 回合，共 48 个原生回合、零模型调用；前一轮脚本假设失败独立保留 |
| 仓库设计与 PR 规范 | [PR58](https://github.com/Aicoo-Team/SharedEval/pull/58)、[工程规范](engineering.md)、[贡献说明](../CONTRIBUTING.md) | 明确模块方向、协议版本、来源绑定、权限回归、PR 说明和验证记录 |

## PAIR Multi 怎么跑

1. 固定任务选择、运行配置、prompt/heartbeat 资产版本和 SharedOS revision/digest。
   每组实验有独立世界、run/session 身份、ledger 和 actor 私有上下文。
2. Multi 的一个世界跨多个 heartbeat 持续存在，调度器一次推进一个有界回合。
   持久化的是消息历史、文件、MEMORY 和提交记录；不声称保存模型隐藏状态。
3. requester 通过原生工具联系 responder。工具发现先过滤，执行时再次授权。
   消息内容不授予权限；资源、用途、期限、actor、authority 和 trace 都参与核验。
4. 新覆盖协议显式使用 v2，以已提交的首次请求接受证据推进覆盖阶段；它不把
   “请求已接受”当作“回复已完成”。旧 v1 继续按旧 binding 解析。
5. 已交付但未提交的回复、失败回合、未知或取消中的效果分开记录。恢复不得
   自动重播不确定效果；已确认收到且身份正确的结果先落账，再处理取消。
6. Single 对照按配置重建完整世界，避免残留消息、文件、权限或资源状态影响下一题。
   具体协议和启动参数见[完整方案](multi-execution-plan.md)。

PR67 固定头为 `c1bedc072ae9a020cbd4c9263ebea4d741d246d2`，基于历史 helper
PR66 的 `63bb0108cf50112f80c949c561551dcb8eb669af`。历史提交和原失败实验保持冻结。
独立审核分别关闭了分析器证据归属问题、旧 20,000-tick 公共 binding 重开兼容问题。
CLI/runtime 的 10,000 执行上限未扩大。

该头本地完整检查为 **891/892**，旧 FIFO 测试的子进程被 SIGTERM 终止；同头原样
定点为 **27/27**，独立兼容定点为 **53/53**。GitHub CI 普通测试为 **876 通过 /
16 跳过**，required 分组 **10/4/7** 全通过且不跳过。具体超时阶段仍未确定，
组合树的 1005/1005 不能用来改写这个单分支失败结果。

最新[尾轮诊断补充](pair-terminal-diagnostic-2026-09-13.md)记录了负责人只读核查的新证据：
DeepSeek tick28 的 MEMORY 已发布为 workspace v26（4738 bytes），但 actor 未保存
对应工具结果或 finish，heartbeat 未提交。文件发布、工具审计和回合提交不能互相替代。
负责人提供的脱敏附录已核对哈希；监督方未读取原私有 journal。MEMORY 文件大小、
完整模型输入与宿主机 RAM 是三个不同指标，现有证据未闭环超时或资源压力的因果关系。

后续[结算机制复现与修复方案](pair-settlement-plan.md)将问题拆为两条可控时序：
事后审计阻挡真实工具结果返回，以及结果持久化尚未确认时取消触发关闭。固定 runtime
上的 characterization tests 已由外部审核者独立通过 7/7（146.374125 ms），不代表
生产修复或原实验唯一根因。审核同时指出：现有正常成功对照在执行结束后才取消，
拒绝仅覆盖发现层，原型错误处理、失败状态与收尾覆盖仍有缺口。
P0 draft 实现已提交，尚未完成独立验收：[SharedOS PR71](https://github.com/Aicoo-Team/SharedOS/pull/71)，固定 `927f155`：
作者完整检查 1036/1036、两项 CI 成功；9 月 19 日独立完整检查 **1035/1036**，
自然 deadline 案的前提竞态在独立测试后续 [SharedOS PR78](https://github.com/Aicoo-Team/SharedOS/pull/78)
中修正，该头完整 1036/1036 通过，原 927 失败保留。SharedEval host 接入未完成，
原子恢复回执及存储优化另列 P1。新 room 报告包括两题真实 Phase 2 到达及 simple
真实预检失败，证据包尚待复核，不构成 60 题或 finalization 通过。

## NET Multi 怎么跑

NET 没有固定的全局 requester/responder 二元关系。host 提供 actor registry、
有向联系边、任务初始投影和明确的 capability grants；每个 actor 可以在授权内
请求、回复或转交任务，SharedOS 负责一个有界回合中的授权和执行。

当前统一入口为 `net check|run|score --config FILE`。配置和 profile 的内容绑定
run manifest；运行先生成可靠的提交证据，评分再读取这些证据，不通过评分重新调度。
目前 provider 为 scripted，只有真实注册的 P-01 rubric 可评分。
P-01 使用合成的 owner 证据，且该任务的禁止披露集合为空；其安全评分不证明
任务层面的隐私表现。

- P-01：三个原生 actor 协作，支持成功、合法保留和跨进程恢复。
- assigned profile：可指定 actor、资源、拓扑和 grant；合成 case 不继承 P-01 注册。
- Multi world：case A 完成后继续 case B，保留授权范围内的历史和资源效果。
- Single world：case A 归档后开启全新世界 epoch，case B 不继承 actor 历史或资源状态。
- 评分：记录 evaluator、manifest、submission 和 launcher 的准确哈希及同进程 Python
  身份，核对输出算术、硬门槛、安全性和完成状态；不声称独立复判 evaluator 的每个谓词。

下一阶段的实际 provider 调用、专用历史/工具策略、P-01 provider 证据投影，以及第二个
真实任务注册，已拆成[可实施方案](net-provider-execution-plan.md)。可先用本地模拟
HTTP provider 走真正的传输和运行时路径，验证工程行为。

## 测试证据边界

组合树输入固定为 NET65 `5da4785`、PAIR67 `c1bedc0`、治理 PR58 `23a432f`，
后者包含 main `dc5d482`。冲突只涉及 CI、package 检查入口、脚本说明和清单测试。
组合保留双方全部 native gates、Node 24、SharedOS `3aa07e3`、NET 测试并发设置。
这是当时本地 materialized tree；9 月 19 日另存为本地历史归档 commit `23f3134`，
精确树未变，详见[归档记录](pr-convergence-2026-09-19.md)。没有新组合 CI，
本监督任务未合并任何 PR。

原生完整检查运行于 Node **24.18.0**，SharedOS revision
`3aa07e33999b656a10ace294fd4e41df8cbc318e`，runtime digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`，
1005 项用时 **209.387 秒**。独立静态审核验证了 73 个 registry 资产及双方关键文件
的来源保持；静态检查不冒充额外运行测试。

额外跨版本验证完成 P-01 成功/保留 `2→8→8`、Multi/Single `8→9→16→16`，
评分分别为 1 和 0.175。旧上下文及归档字节保留，完成后重开不新增效果，所有非导出
文件字节不变。派生 execution JSON 在三个场景中重新序列化，但完整 JSON 值和
规范化身份摘要不变。第一次脚本误要求导出文件也逐字节稳定的失败现场保留，
修正后的独立脚本另建全新记录验证，未改变生产代码或重复全库检查。

另行运行的数据检查通过普通一致性验证：60 agents、166 tasks，FAIL 0 / WARN 5 /
BLOCKER 2；十个 draft task 的成功、保留、权限、关闭及适用隐私 fixture 检查通过。
PAIR 导出为 600 行，notes/todo/actions 各 200 行。显式 benchmark-ready 检查仍返回
NOT READY：Alex 外部语料依赖未包含，gold 为 validated 0 / draft 10 / not built 156。

## 尚不能验收通过的部分

- 原 PAIR 两组真实模型 60 题实验均未完成：DeepSeek 提交 27 ticks、26 次首次联系；
  Codex 提交 25 ticks、25 次首次联系、26 次实际交付回复。均未发生重问或 action 联系，
  adaptive 未评估；额外交付回复不能补认成已提交 tick。
- SharedOS 外层取消可能早于 session 完整关闭、历史读取随长度增长等边界仍待后续工作。
- 当前 NET scripted 世界验证不等于任意任务/provider 或 166 任务 benchmark 已完成。
- 第二个真实 rubric 需要可审核的执行源和逐动作授权。PAY-01 的 236,000 未注明币种，
  不能直接与 Sarah 的 25,000 USD spending approval 比较；该额度也不等于付款放行权。
  已有 maker/checker、银行双签等通用控制，但缺本案授权及供应商/核验/发票来源。
  F-08 已有初始金额、期间和客户签核后才能入账的条件，仍缺指定账目分类及实际批准。
  正常建模的“证据不可得”应与坏包区分；停止 release/post 不自动产生 held 状态，
  改写 held 同样需要授权。不能从 gold 反推事实、扩大文件夹授权或把合成 fixture
  改名当成真实注册。先完成哪份源包，再选择第二个 case。

监督会继续按实际差异分配实现和审核工作；已完成的固定头不因无新反馈而重复跑测试。
发现未完成工作提前停止时继续推进，实验失败、来源缺口和待验收条件持续保留在
[状态记录](delivery-status.md) 中。
