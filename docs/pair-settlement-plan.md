# PAIR 取消结算：机制证据与 P0/P1 实施方案

日期：2026-09-14（Asia/Shanghai）。状态：**机制 characterization 已交付；P0 生产实现已分配，尚未验收**。
本文提出跨层契约及验收顺序，不批准新模型调用或旧世界续跑。历史证据见
[尾轮诊断](pair-terminal-diagnostic-2026-09-13.md)，既有代码见冻结
[PR67](https://github.com/Aicoo-Team/SharedEval/pull/67)。

优先修复取消后的真实结果交付与持久化确认，再建设 host 恢复回执及存储优化。
不能用增大 MEMORY、ticks 或执行 deadline 替代结算契约，也不能跳过完整性检查
或重放完成状态未知的操作。

## 固定来源、运行与机制

监督方核对了新脱敏 archive 及其四个正文成员的字节数、哈希；未访问原始私有 journal。
监督方基于两份说明整理本文，未自行复跑或复核测试断言；外部审核另列。来源指纹如下：

| 文件 | Bytes | SHA-256 |
| --- | ---: | --- |
| `PAIR-MULTI-ROOT-CAUSE-20260914.tar.gz` | 16003 | `e5b51bc999ecba8c12a68e8386bd8ae3975da4adc00b355b43e0be8135852277` |
| `README.md` | 12839 | `5c8ba4900bb8c7ae87edb39caaecd64aaa3b87a63474a1b32c36585f0f6a231f` |
| `PLAN.zh-CN.md` | 12102 | `028ff054cdb7b2b46781263943ab0c809ad160edff3818d386f957425953aa07` |
| `runtime-cancellation.test.mjs` | 13980 | `b5516c53a615c242a92cad431d12814ac4726203e2c3933eeb005438bf1c51cc` |
| `settlement-prototype.mjs` | 2182 | `dc9b997500a1b7ae69a354a53b254129733b0ddeae53be51f7147ee1a636c545` |

复现运行固定 Node 24.18.0、SharedOS revision
`3aa07e33999b656a10ace294fd4e41df8cbc318e`，loader 验证 executable digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`。
命令为 `node --test --test-concurrency=1 runtime-cancellation.test.mjs`，
须满足该脚本引用的已核验 loader 和 pin 前提；不是任意 checkout 的通用测试命令。

| 运行归属 | 结果 | 用时 | 证据边界 |
| --- | --- | --- | --- |
| 诊断作者 | 7/7；0 fail/cancel/skip；exit 0 | 149.625208 ms | 新诊断运行 |
| 作者所在任务的根代理 | 7/7；0 fail/cancel/skip；exit 0 | 148.979708 ms | 同一固定诊断复跑，**不是本监督任务复验** |
| 外部 room reviewer | **pending** | 待填 | 独立复跑与断言审核尚未回传，不能计为通过 |

**7/7 是 characterization 通过，包含成功重现现有缺陷，不表示修复通过。**
真实 kernel、runtime、executor、授权及 abort 实现未修改；file、driver、audit
使用 synthetic 数据与可控 gates。文件写入后核对了实际字节，但不是完整 SharedEval
actor journal、workspace CAS 或掉电持久性测试。实验显式触发 abort；配置的
60000 ms 执行期限未等到触发，现有 1000 ms close 上限未覆盖修改。

| 机制或对照 | 报告观察到的顺序与含义 |
| --- | --- |
| A：事后 audit 阻挡真实结果 | 文件已写、handler 已产生并经 kernel 校验的 succeeded 结果 → audit gate 等待 → abort → close 开始、executor 返回 cancelled → audit 放行、kernel 才返回结果。driver 交付数为 0、handler 仅一次；外层返回不保证 close 已 ACK。 |
| B：ingestion 与 close 竞争 | kernel 返回结果 → combined `session.next(tool_result)` 开始异步保存 → abort → close 及 executor/runtime 返回 → 保存之后才完成。PR67 先接收结果再检查 abort，仍不足以保证 runtime 等到持久化 ACK。 |
| 反序对照 | 先放行 audit、完成结果保存与 close，executor 返回 succeeded 后才 abort；一次结果交付、一次 `tool.completed`。说明顺序改变会改变结果。 |

固定 pin 的相关代码为：
[kernel handler/result/audit 顺序](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/core/src/kernel.ts#L696-L727)、
[executor 工具调用 race](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/executor.ts#L308-L320)、
[整个 runtime 的 race](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/executor.ts#L353-L356)、
[combined next 与 finally close](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/standard-runtime.ts#L122-L187)。
abort race 放弃等待，不撤销文件副作用或自动 join 底层工作，见
[internal.ts](https://github.com/Aicoo-Team/SharedOS/blob/3aa07e33999b656a10ace294fd4e41df8cbc318e/packages/runtime/src/internal.ts#L46-L64)。

owner 另报告对 SharedOS `d6cee613d666ab977f462a38f9633c4a0a1f9b2d` 做了源码适用性
检查：kernel 1216–1255 / 2089–2098、executor 434–446 / 479–482 / 602–614、
standard-runtime 155–158 / 242–243 / 344–346 仍存在相关控制流。**这是 owner 对固定
SHA 的静态检查；不声称它是目前的 main，也未在该 SHA 上执行七项复现。**
机制与旧 DeepSeek 时序相容，仍未证明原 timer 的准确触发点、唯一根因或 Codex
尾轮也已发布文件。

## P0：实时结算契约

以下是拟议的三个独立实现单元；接口名示例不是已接受的公开 API。变更公开或持久化
协议前须提交 ADR，明确版本、兼容和迁移。SharedOS 保持 host-neutral，不导入
PAIR/NET 数据、MEMORY 格式、gold、任务调度或 host 存储实现。

| 实现单元与归属 | 要实现的边界 | 必须保留的约束 |
| --- | --- | --- |
| P0-A：SharedOS core / contracts | 将经过 schema、call ID、tool identity 校验的真实 result-ready 与事后 audit 的完成/失败/未决状态分离，可采用版本化 invocation handle 或只观察结果的接口。 | 事前授权、grant 消费及准入不放松；不从文件或模型文本合成 ToolResult，不丢弃 audit。host 要求持久 audit 时，未决 audit 仍阻止不合理的 heartbeat commit。 |
| P0-B：SharedOS runtime / driver contracts | 分离非生成型 `ingestToolResult(result, settlementSignal)` 与产生新决策的 `next`。ACK 表示真实持久化完成；绑定 turn/call/tool 和精确结果摘要。`finish` 排在 ACK 后。 | 重复只能确认同一结果，外来/冲突 ACK 拒绝。取消后不为保存结果再次调用模型；进程 cleanup 与 journal finish 分开表达。 |
| P0-C：SharedOS executor / contracts | 取消立即封住新模型决策、工具准入及新授权使用，保留已准入操作的观察句柄；使用独立、有限、总量受控的 settlement budget，等待真实结果、ingestion、必要 audit、finish/cleanup。 | 不能给 generation 换未取消信号绕过 deadline；cancelled 即使 settled 仍不是成功。预算耗尽返回 incomplete，保留已知状态，不补造、不重放、不改写已经返回的结果。 |

返回状态须 JSON-safe，分别表达 execution、operation/result、ingestion ACK、audit、
history finish、cleanup 与未决 operation IDs。内部观察或存储接口不能成为新工具
执行通道。用显式 capability/contract version 协商：旧 plugin 缺少 ACK 能力时不得
仅凭 `run()` / `close()` 返回就推断 settled；旧调用方行为单独做兼容回归，新的
SharedEval world profile 明确要求所需能力，不能静默升级旧世界。

现有孤立原型仅接收已发起的真实 kernel promise，验证有界等待、ACK→finish 顺序
及 unknown 的处理。它尚未实现 P0-A，仍受旧 kernel 的 audit wait 阻挡，也没有
生产 driver 接口、崩溃恢复或原子回执；有限 grace period 本身不是完整修复。

## P1：Host 回执与存储

先建立新版本 **operation receipt 与文件变更的同一原子 publication**，绑定 run
binding、actor、turn/call、参数摘要、前后版本及真实结果。写完后再补 sidecar 会
重建崩溃窗口。host 的 provider/workspace 保存回执，driver/context 幂等确认真实
结果；workflow 只有在操作状态确定、结果进入历史、finish 与所需 audit 完成后，
才按显式协议决定能否提交 failed/cancelled heartbeat。失败不改记成功，未知不重试。
NET 远端操作也需 host 提供可核验接受/交付/修改回执，否则保持 unknown。

再评估新运行的 segmented journal 和内容寻址 workspace：保留完整记录、链、顺序、
actor identity、frontier 及 MEMORY 历史，完整 tamper 校验不放松。重新读取 bytes
并核对 SHA 后的解析缓存只减少解析；segmentation 减少小文件数量，不自动消除
整历史字节读取；不可变正文去重不原地改旧证据。跨调用仅看 mtime/size 的缓存不能
代替验证；若要省去完整 byte 校验，必须另立可信不可变存储和写入权边界。

owner 根据 **Codex tick26 开始前**的冻结元数据前缀及源码路径估算：该样本中
四次单文件读取可能带来 **12480 次逻辑读取、约 24 MB 应用层历史读取**。它不是实测 syscall、物理磁盘 I/O 或独立原因证明，
不包含全部元数据及收尾，OS cache 也可能命中。性能优化不能阻塞 P0，更不能据此
宣称 swap、历史 I/O 或某个 timer 已被确定为原失败根因。

## 验收顺序与停止条件

1. **固定诊断的独立审核：**外部 reviewer 针对上述四文件指纹及 pin 回传七案结果：
   A、B、反序正常、真实结果 ACK 后 finish、operation settlement 超时、ingestion
   ACK 超时、真实授权拒绝无写入。保留 characterization 的预期，不能把“缺陷仍能
   重现”改称修复验收；两个作者侧 7/7 不合并为独立监督通过。
2. **生产实现回归：**在实际新 contracts/core/runtime/driver 中验证发布前取消、
   发布后 audit 前取消、result-ready/audit 未决、ingestion 未 ACK、handler 不返回、
   close 失败、重复/冲突/外来结果及 callback/error 路径；逐案断言无新模型决策、
   无新授权使用、无 action 重放、无伪造 finish，返回 settled/incomplete 与事实一致。
   必须覆盖 allow/deny、旧 plugin capability 兼容及完整仓库检查。
3. **新 world 的 scripted 集成及恢复：**实际接入 SharedEval journal/workspace/消息，
   覆盖跨 tick 状态修改、failed/cancelled tick 的显式恢复、首问覆盖、依赖先前回复
   的重问。0/24/300-turn mock 历史比较记录/frontier 等价并测量 read calls、bytes、
   fsync、解析次数及耗时；新格式另测同尺寸篡改、截断、替换和各崩溃点。旧 v1 字节
   与 reopen 行为保留，不将诊断 synthetic file 当作这些集成已通过。
4. **另行授权的新 world 模型 canary → 完整验收：**此前门槛通过后再开始有预算的
   新 canary，必须出现“上一回复影响下一请求”的实际重问证据；随后同一 60 题 split、
   每组最多 300 ticks 完整验收。本计划没有启动或授权新付费运行。

旧实验仍为 **DeepSeek 27 / Codex 25 个已提交 ticks**，未完成真实 60 题/adaptive
验收。DeepSeek tick28 的文件发布不补计 heartbeat；较早 tick23/24 历史、未提交回复
及原报告哈希保持不变，不补造结果、不续旧 world。既有 PR67 本地 **891/892 红**、
同头定点 **27/27**、CI 与组合树 **1005/1005** 等结果仍按
[验收总表](multi-acceptance.zh-CN.md) 分列；本次诊断不替换、累加或改变任何旧计数。
