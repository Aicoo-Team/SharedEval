# PAIR 尾轮诊断：文件发布、actor 结算与 heartbeat 提交

日期：2026-09-13。状态：只读追加诊断；真实 PAIR 60 题 / adaptive 验收仍未完成。

**据 PAIR owner 的脱敏补核，DeepSeek tick28 已将 requester MEMORY 从 version25
发布至 version26，但对应 actor 工具结果和 finish 缺失，heartbeat 没有提交。**
这不能解释为“MEMORY 文件写满”，也不能补认 tick28 成功。Codex 尾轮没有对应
workspace commit 的确认，不能套用 DeepSeek 的文件发布结论。

## 证据来源与检查范围

历史观察来自 owner 追加的脱敏文件
`PAIR-MULTI-DEEPSEEK-TICK28-READONLY-ADDENDUM-20260913.zh-CN.md`，
10012 bytes，SHA-256
`3fe9d8e856ebd9b18fef9ccb677a32af0b8bb91c298290604f87f5cda739d404`。
监督代理核对了该追加对象的大小与哈希，并阅读其内容；**未独立重读原私有
journal、模型正文或 workspace 正文**。下文历史时间线与字节对应关系属于
owner 报告的观察，不冒充监督方对原证据的第二次取证。

代码解释另行只读检查冻结 [PR67 的 `c1bedc0`](https://github.com/Aicoo-Team/SharedEval/pull/67)
（完整 SHA `c1bedc072ae9a020cbd4c9263ebea4d741d246d2`）及 SharedOS
`3aa07e33999b656a10ace294fd4e41df8cbc318e`。这些源码说明当前提交边界，
**不是原实验整个 execution checkout 的身份证明**。本记录不新增 runtime
修复结论，未运行测试、原生回合或模型，也未重放任何旧操作。

## DeepSeek tick28 的追加观察

capture344 返回 HTTP 200、正常 `finish_reason=tool_calls`，请求以
`expectedVersion="25"` 替换 MEMORY。owner 解析响应 JSON 及工具参数 JSON，
提取 `content` 字符串并原样编码为 UTF-8；其字节与 actor record420 中对应内容、
实际 MEMORY 文件相同，并与 workspace commit26 声明的长度及摘要一致。
4738 bytes 指该 `content` 及 MEMORY 文件，不是整个响应、参数对象或 commit marker；
内容 SHA-256 为
`113406e99b8eed00845940aae1f93a06917e625c2af8e45647b4fa8af6416a2a`。
因此，文件发布结论来自 marker 和实际字节核对，并非仅凭 success audit。

以下时间均为 **2026-09-13 UTC**；北京时间加 8 小时。`mtime` 是文件修改时间，
不等于独立 timer 触发记录、可信时间戳或 fsync 完成证明。

| UTC 时间 | owner 报告的观察 | 时间类型 |
| --- | --- | --- |
| 03:54:03.361 | 固定 turn context 时间；audit `event.at` 复用该值 | 记录字段，不是逐操作完成时间 |
| 03:57:56.129 | capture344 HTTP 200，响应 latency 43383 ms | 响应 `at` 字段 |
| 03:58:02.161 | actor record420 保存 MEMORY 替换调用 | 文件 `mtime` |
| 03:58:56.612 | `commit-26.json`，version25 → version26，MEMORY 4738 bytes | 文件 `mtime` |
| 03:59:03.361 | 固定 context 时间加配置 300000 ms | 推算截止点，没有 timer-fired 记录 |
| 03:59:08.027 | failure：`context_turn_incomplete` / `context_settlement`；执行分类 `indeterminate_external_operation` | 文件 `mtime` |
| 03:59:19.291 | audit839：同一 MEMORY 操作 `tool.invoked` / `succeeded` | 文件 `mtime` |

owner 枚举到 record420 后没有 record421 或更大编号，因此没有对应结果消息或
turn finish；heartbeat tick28 也没有 commit。较晚出现成功 audit，不补足缺失
的 actor 结果或 heartbeat。调用记录到 workspace marker 的文件时间差为
54.451 秒，跨越授权、工具、存储与调度路径，不能全部记为写入 4738 bytes 的耗时，
也不能由上述先后顺序确定计时器根因。

## 当前代码的三层提交边界

三层各自持久化，**没有将文件副作用、actor 结算和 heartbeat 纳入同一个原子事务**。

| 层级 | 当前源码中的边界 | 该层证据不能替代什么 |
| --- | --- | --- |
| MEMORY 文件 | 先准备并校验版本目录，再以 `linkSync` 发布 `commit-N.json`，赢得 CAS；发布成功不回滚。后续同步故障可以标为 `published_unsynced`。单有版本目录不足，须有有效 marker 及匹配文件。 | 不能证明 actor 已收到工具结果或 tick 已提交。 |
| Actor journal | assistant 调用先 append；随后收到且校验身份的 tool result 才 append 对应结果；`finish()` 再单独写入，未配对调用阻止 finish。 | 文件发布或工具 audit 不会自动补写结果、finish。 |
| Heartbeat ledger | 先持久化 start，再执行 turn、检查结算、投影并校验 evidence，最后单独发布 heartbeat record。执行或结算失败可停在 commit 前。 | start marker、文件副作用或 actor 的部分进展都不等于 heartbeat commit。 |

冻结源码入口：

- 文件 CAS 的唯一发布点与发布后状态：
  [file-workspace.ts:401–454](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/file-workspace.ts#L401-L454)。
  文件 provider 保留已经提交的结果，即使取消发生于发布之后：
  [sharedos-file-provider.ts:443–478](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/sharedos-file-provider.ts#L443-L478)。
- Actor 调用与结果分开写入：
  [file-model-driver.ts:767–798](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/file-model-driver.ts#L767-L798)、
  [file-model-driver.ts:629–653](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/file-model-driver.ts#L629-L653)。
  Actor record 与 frontier 也是先后写入，中断不自动协调；finish 拒绝未配对调用：
  [actor-context-store.ts:233–257](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/context/actor-context-store.ts#L233-L257)、
  [actor-context-store.ts:291–302](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/context/actor-context-store.ts#L291-L302)。
- Executor 返回后仍须检查 actor settlement：
  [sharedos-file-session.ts:429–434](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/sharedos-file-session.ts#L429-L434)。
  Heartbeat 的 start → execute → commit 顺序与失败出口：
  [file-workflow-recovery.ts:104–170](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/file-workflow-recovery.ts#L104-L170)。
  只有 start 而没有 record 时保持 indeterminate，不自动重跑：
  [file-workflow-ledger.ts:408–419](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/file-workflow-ledger.ts#L408-L419)。

SharedOS 对 kernel 调用和整个 runtime 分别等待 abort race；该 race 可先结束等待，
不撤销已经发布的文件，也不保证底层 promise 已完成。
参见 [executor.ts:308–320](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/executor.ts#L308-L320)、
[executor.ts:353–356](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/executor.ts#L353-L356)、
[internal.ts:46–64](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/internal.ts#L46-L64)。
Kernel 在 handler 返回后才记录工具 audit，见
[kernel.ts:696–727](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/core/src/kernel.ts#L696-L727)。

PR67 当前会先保存**已经送达、身份匹配**的工具结果，再响应取消；它不能从文件状态
反推或补造未送达结果，见
[file-model-driver.ts:542–550](https://github.com/Aicoo-Team/SharedEval/blob/c1bedc072ae9a020cbd4c9263ebea4d741d246d2/src/runner/v1/file-model-driver.ts#L542-L550)。
以上解释跨层状态为何可能不同，不能单独证明旧运行究竟在哪个 await 或 timer 处失败。

## 三种“内存”与保留结论

- **MEMORY 文件：**owner 对现有版本的大小统计中，DeepSeek requester 最大
  4738 bytes，Codex requester 最大 3604 bytes，两组 responder 均为 1481 bytes。
  DeepSeek 最大值包含未提交 tick 的文件发布，不能按文件版本数计算成功 ticks。
- **模型上下文：**capture344 raw body / projected body 为 1266494 / 302977 bytes，
  包含历史与协议结构；这是字节数，**不是 token 数**。该次正常返回工具调用，
  不证明完整 60 题 / 300 ticks 都不会触及上下文限制。框架 16 MiB actor-context
  字节预算也不是模型 token 窗口；Codex 完整原生上游 prompt 未独立捕获。
- **主机 RAM / swap：**旧报告中的高负载与 swap 属于运行环境。资源压力、历史
  I/O 与超时仍是贡献候选，本次没有控制实验或因果分解，不能据此宣布根因。

历史计数保持 **DeepSeek 27 / Codex 25 个已提交 ticks**。DeepSeek tick28 没有
新 contact/reply 或 heartbeat commit。较早 tick23 的 HTTP520、tick24 的再次
MEMORY 发布被拒仍保留；它们不改写为本次 capture344 的 HTTP200 尾轮。
不补造结果或 finish，不修改失败标记，不续跑旧 world，不因新诊断重计成功。

原交付对象保持不变；本页是追加说明，不替换以下对象：

| 对象 | SHA-256 |
| --- | --- |
| 原始脱敏 archive | `48552cfd03ec0f777789e90562a6b8b3872582115a5a761fbfeba6e7c854864d` |
| `c1bedc0` 冻结验证附录 | `528b6f4ae131d5c057da533f158d4ee571197114089050007e9a83e42a7bba57` |
| 此前中文状态报告 | `f04fdd60dedb06755be56bd51cf17ab0823caf8e474cbe78cb3582aed723f9f9` |
