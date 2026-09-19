# PAIR 取消结算：机制证据与 P0/P1 实施方案

日期：2026-09-19（Asia/Shanghai）。状态：**P0 draft PR 已交付；原 927 独立失败保留，测试后续完整检查通过；SharedEval 接入未验收**。
本文提出跨层契约及验收顺序，不批准新模型调用或旧世界续跑。历史证据见
[尾轮诊断](pair-terminal-diagnostic-2026-09-13.md)，既有代码见冻结
[PR67](https://github.com/Aicoo-Team/SharedEval/pull/67)。

优先修复取消后的真实结果交付与持久化确认，再建设 host 恢复回执及存储优化。
不能用增大 MEMORY、ticks 或执行 deadline 替代结算契约，也不能跳过完整性检查
或重放完成状态未知的操作。

## P0 固定交付与复验状态

[SharedOS PR71](https://github.com/Aicoo-Team/SharedOS/pull/71) 为 draft，head
`927f1557035dde45454935649aabf6ca1fe1f89c`，base
`d6cee613d666ab977f462a38f9633c4a0a1f9b2d`，tree
`7b3b459fd13d29f98b37f0dcef485896900a12bd`。作者普通 clone 的 `pnpm check`
通过：47 个 Vitest 文件、1036/1036，release 7/7，format/typecheck/API references/
strict conformance 通过；conformance manifest 为 165 pass / 15 NA / 12 NI。
监督方核对了 [CI 34774488112](https://github.com/Aicoo-Team/SharedOS/actions/runs/34774488112)
在该 head 的 Node 20.11/22 两项成功，未将作者运行计为监督方复跑。

交付 archive 为 63589 bytes，SHA-256
`db32da01bd6114dcb8b775dda77f9a463df1481e6bf143bb5aa2d64a4015ece8`。
监督方核对四个正文成员哈希，且 `changes.patch` 与固定 base→head 的
`git diff --binary` 字节一致（1050075 bytes，SHA-256
`4a046d3b88f0879d94b658297b0d1f86995f244710cbca9112f7c436ba03b9a7`）。

9 月 19 日独立普通 clone、Node 24.18.0 / pnpm 9.15.0 的单次 `pnpm check`
为 **1035/1036，exit 1**：自然 work deadline 测试预期 cancelled + settled，
实际 cancelled + unsupported。审核者正在核查 session 注册前超时这一前提竞态，
不能据此直接断言生产 bug，也不能用作者/CI 通过覆盖该失败。后续单案 1 pass /10 filtered skips、release 7/7、监督方补跑 API/conformance
成功均分列，原 927 完整检查仍为失败。

实现覆盖 validated result-ready 与 audit 分离、非生成 ingestion ACK、有限总
settlement budget、打开 session 前能力检查、未注册 session 的专用关闭，以及
报告语义校验；ADR0027 记录兼容边界。旧 d6→33c+2f 静态 review 曾发现清理
所有权 P2，最终 927 的关闭结论须以完整新 review 为准。

后续有限静态复核已完成：F1 在标准 runtime/controller 的清理所有权范围关闭，
C2 原列身份及状态约束已补齐，C1 明确要求 host 协调升级。它不是全 executor
穷尽证明；超出整个 settlement 预算才返回的 open、合法格式但内容不符的 ACK
摘要等直接用例仍可补强，ACK 的真实存储保证仍属 host。

测试修正另见 [SharedOS PR78](https://github.com/Aicoo-Team/SharedOS/pull/78)，
head `eb9b054c89a4b91d3830607c5a6e8ae82d6220e7`，基于原 927。仅修改自然
deadline 测试：暂停计时等待真实 handler publication，再推进原 20ms timer，
保留一次 decision/ingestion 和 settled 断言，finally drain 并恢复计时。
该头最终 `pnpm check` exit 0：1036/1036、release 7/7、API 与 strict conformance
通过；没有生产源码、权限或 timeout 值改动。开发中零测试的未构建环境失败、
微任务等待不足的 10/11 失败，以及本地 origin 导致 API source links 不可识别的
首次 full-check 失败均保留在 PR 说明；正确配置 remote 后的通过不覆盖这些记录。
这不是原 927 独立失败被回写成通过，也不构成 SharedEval host 或模型验收。

功能默认关闭。旧 strict v1 consumer 会拒绝新增 settlement 字段，driver 能力
协商不等于 HTTP consumer 协商；启用时须同步升级消费者或使用单独本地 port。
ACK/schema 解析不独自证明掉电持久性。**SharedEval driver/journal 尚未接入，
原子 operation receipt 与 crash recovery 仍属 P1，真实 60 题仍未验收。**

## 固定来源、运行与机制

监督方核对了新脱敏 archive 及其四个正文成员的字节数、哈希；未访问原始私有 journal。
本节记录 9 月 14 日诊断包，监督方基于该包两份说明整理本节，未自行复跑或复核
七项测试断言；外部审核另列。来源指纹如下：

| 文件 | Bytes | SHA-256 |
| --- | ---: | --- |
| `PAIR-MULTI-ROOT-CAUSE-20260914.tar.gz` | 16003 | `e5b51bc999ecba8c12a68e8386bd8ae3975da4adc00b355b43e0be8135852277` |
| `README.md` | 12839 | `5c8ba4900bb8c7ae87edb39caaecd64aaa3b87a63474a1b32c36585f0f6a231f` |
| `PLAN.zh-CN.md` | 12102 | `028ff054cdb7b2b46781263943ab0c809ad160edff3818d386f957425953aa07` |
| `runtime-cancellation.test.mjs` | 13980 | `b5516c53a615c242a92cad431d12814ac4726203e2c3933eeb005438bf1c51cc` |
| `settlement-prototype.mjs` | 2182 | `dc9b997500a1b7ae69a354a53b254129733b0ddeae53be51f7147ee1a636c545` |
| 外部审核 `PAIR-RUNTIME-MECHANISM-REVIEW.md` | 11938 | `dc852c0dd2cba7899bf4adac0e3d689f9033af8264685e00d063e48510b67355` |

复现运行固定 Node 24.18.0、SharedOS revision
`3aa07e33999b656a10ace294fd4e41df8cbc318e`，loader 验证 executable digest
`4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d`。
命令为 `node --test --test-concurrency=1 runtime-cancellation.test.mjs`，
须满足该脚本引用的已核验 loader 和 pin 前提；不是任意 checkout 的通用测试命令。

| 运行归属 | 结果 | 用时 | 证据边界 |
| --- | --- | --- | --- |
| 诊断作者 | 7/7；0 fail/cancel/skip；exit 0 | 149.625208 ms | 新诊断运行 |
| 作者所在任务的根代理 | 7/7；0 fail/cancel/skip；exit 0 | 148.979708 ms | 同一固定诊断复跑，**不是本监督任务复验** |
| 外部 room reviewer | 7/7；0 fail/cancel/skip/todo；exit 0 | 146.374125 ms | 独立阅读与复跑；实际 Node 24.18.0、已验证同一 pin/digest |

外部 reviewer 报告运行前后正文文件及 archive 哈希不变，SharedOS checkout clean，
临时 fixture 已清理。监督方核对并阅读了这份脱敏报告，没有将其计为监督侧自行复跑。
通过路径的清理不等于所有 observer promise 都已 join，相关限制及后续门槛见下文。

**7/7 是 characterization 通过，包含成功重现现有缺陷，不表示修复通过。**
真实 kernel、runtime、executor、授权及 abort 实现未修改；file、driver、audit
使用 synthetic 数据与可控 gates。文件写入后核对了实际字节，但不是完整 SharedEval
actor journal、workspace CAS 或掉电持久性测试。实验显式触发 abort；配置的
60000 ms 执行期限未等到触发，现有 1000 ms close 上限未覆盖修改。

| 机制或对照 | 报告观察到的顺序与含义 |
| --- | --- |
| A：事后 audit 阻挡真实结果 | 文件已写、handler 已产生并经 kernel 校验的 succeeded 结果 → audit gate 等待 → abort → close 开始、executor 返回 cancelled → audit 放行、kernel 才返回结果。driver 交付数为 0、handler 仅一次；外层返回不保证 close 已 ACK。 |
| B：ingestion 与 close 竞争 | kernel 返回结果 → combined `session.next(tool_result)` 开始异步保存 → abort → close 及 executor/runtime 返回 → 保存之后才完成。PR67 先接收结果再检查 abort，仍不足以保证 runtime 等到持久化 ACK。 |
| 正常成功对照（原称反序对照） | audit、结果保存、close 和完整 execution/runtime 均结束，取消监听 dispose 后才 abort；一次结果交付、一次 `tool.completed`。证明正常路径可成功，未覆盖 ACK 已到但 finish/close 仍活动时的取消。 |

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

## 独立审核明确的限制

以下是外部 reviewer 对原型和测试覆盖的静态发现；七案之外未新增动态复现，
不将这些发现归为 SharedOS 生产源码缺陷或原 timer 的唯一因果证明。原七案包保持
冻结，P0 owner 已收到发现并继续实现；新增回归另记版本与结果。

| 现有证明的边界 | 生产实现及新增回归要求 |
| --- | --- |
| 正常成功对照在整个执行结束、监听释放后才取消。 | 保留该对照，另测 audit/result ACK 已完成、finish/close gate 仍阻塞时取消，不能用旧对照代替活动边界。 |
| 原型直接读取 `caught.message`，遇 `null` / `undefined` 拒绝值可能在 catch 中再抛；已知 reject、invalid/mismatch、ingestion/finish 失败又可能只留下 pending。 | 安全处理非 Error 拒绝值；用精确 JSON-safe 状态区分未决、已拒绝/无效、失败与已确认，覆盖 operation、ingestion、finish 各阶段。这是原型问题，不是已验证的生产缺陷。 |
| 现有拒绝案通过 discovery 的 `tool_unavailable` 阻止执行，未覆盖 consuming invocation re-authorization。 | 新增工具仍可发现但具体执行权限不足，以及契约允许的撤销边界测试；核对拒绝码、审计和零 handler/effect，不改变固定 turn authority 的既有语义。 |
| 两个 budget 案由外部 AbortController 中止等待，未等自然 timer 到期，也未覆盖 finish 已开始后的超时/失败。 | 分别验证自然预算到期、finish 超时及失败，且 operation/ingestion/finish 共用有限总预算；不把它们解释为测到了历史执行 timer。 |
| ACK 只证明 synthetic `appendFile` 返回，不证明 fsync 或完整 journal；原型依赖可信 promise、默认 cancelled 前提，仅有限身份字段校验。 | 生产契约须认证已准入操作与取消前提，覆盖完整 schema、精确摘要、重复/冲突/外来结果、audit 和 cleanup 状态；持久性语义由 host 存储协议和崩溃测试证明。 |
| 通过路径 fixture 干净，但部分测试仅等待完成标记，未显式 join 原始 observer；budget/ACK 案断言失败后可能来不及释放 gate。 | 将 release 与有界 drain 放入 `finally`，保留并处理已启动 observer；验证失败路径收尾，不把目录清空或进程 exit 0 当作全面静止证明。 |

## P0：实时结算契约

下表保留原设计的三个独立实现单元；PR71 的实际 API 与测试另按固定头审核。变更公开或持久化
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

现有孤立原型由可信调用方传入已发起的 kernel promise，演示有限预算结构、
ACK→finish 顺序和 incomplete 的处理；它不自行认证 promise 来源或取消前提，
也未完整区分已知错误。它尚未实现 P0-A，仍受旧 kernel 的 audit wait 阻挡，
没有生产 driver 接口、崩溃恢复或原子回执；有限 grace period 本身不是完整修复。

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

1. **固定诊断独立审核已完成：**外部 reviewer 在同一指纹及 pin 上取得 7/7，覆盖
   A、B、执行结束后的正常成功对照、真实结果 ACK 后 finish、operation/ingestion
   预算由显式 abort 中止、discovery 拒绝无写入。保留上述证据限制及原包；新增测试
   不倒填入这七案。三个 7/7 分列，不能把“缺陷仍能重现”改称生产修复通过。
2. **生产实现回归：**在实际新 contracts/core/runtime/driver 中验证发布前取消、
   发布后 audit 前取消、result-ready/audit 未决、ingestion 未 ACK、handler 不返回、
   close 失败、重复/冲突/外来结果及 callback/error 路径；逐案断言无新模型决策、
   无新授权使用、无 action 重放、无伪造 finish，返回 settled/incomplete 与事实一致。
   必须落实上表的活动 close 取消、非 Error 与已知失败状态、执行阶段拒绝/撤销、
   自然 timer/finish 超时、完整结果/ACK 绑定及失败后 `finally` 有界 drain；覆盖
   allow/deny、旧 plugin capability 兼容及完整仓库检查。现有七案不满足此门槛。
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
