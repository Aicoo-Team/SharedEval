# PR 收敛与验收状态（2026-09-19）

负责人：总协调负责整合候选与证据；PAIR 接手 lane 负责 profile/observation 行为，
NET lane 负责 runtime/scoring 增量。以下是固定 Git 对象的核验与实施顺序，
不代表这些分支已经合入 main，也不授权新的付费实验。

## 当前代码在哪

| 顶点 | 固定 SHA | 状态 |
| --- | --- | --- |
| main | `8de1d27a54236448af4c5269405869c4386882ca` | 包含 #53；不是旧组合测试的 main `dc5d482` |
| PAIR phase2 | `f74f038520c3dd914288ea02da1eb71a1f8ac524` | 已含原 #57/#66/#67，以及 #68–77 的落地改动；尚未进入 main |
| [PR78](https://github.com/Aicoo-Team/SharedEval/pull/78) | `b155c6931620fb87531fb1cb608c9474b0ff242d` | 在 phase2 上再加一个提交，仍 open |
| NET stack tip [PR65](https://github.com/Aicoo-Team/SharedEval/pull/65) | `5da4785c781cd660fd3c41cc42cdbe137f895f32` | 不在 main 或 phase2 |
| 治理更新前 [PR58](https://github.com/Aicoo-Team/SharedEval/pull/58) | `2e4b897f18063825befad11af2033e43e3796bf5` | 独立治理栈，本次文档在其后追加 |

main 与 phase2 的 merge-base 为 `14463247af15641b1d4231537d7f263e5105a8e7`，
两侧独有提交分别为 **8 / 73**。#68–77 的 GitHub `merged` 状态表示合入 phase2
及其子栈；其落地提交都不是 main 的祖先。#69–72 使用 squash，原 head 不在
祖先图，但原 PR 与落地 patch 的 stable patch-id 一致，不可重复 cherry-pick。

本次核验 GitHub 元数据、祖先图、patch-id 和交叉文件，没有执行新树测试或合并
演练。旧 `1005/1005` 与 48 scripted turns 只适用于历史树
`e93d46f934987f380137a684f244fff9f6e66a43`。

## 历史树已固定为本地归档

9 月 19 日在独立 bare 仓库建立 commit
`23f3134b4ecdca5cb01a0dffea8b110a6637f5c3`，tree 精确等于 e93，单父为
NET65 `5da4785c781cd660fd3c41cc42cdbe137f895f32`。归档同时保存 PAIR67
`c1bedc072ae9a020cbd4c9263ebea4d741d246d2` 与当时治理
`23a432f4cdd1e7b7233216dcdec92c1e0b4edc3f` 的独立输入 refs。

自包含 `sharedeval-e93-20260913.bundle` 为 4498724 bytes，SHA-256
`85c561bbb86fedf81c956ad7a3c50d659d129d0f2066d5a4f5a7606142de4d79`。
独立空仓库恢复、两侧完整 fsck、恢复树核对均成功；原冻结目录的 HEAD、index、
status 与 refs 前后指纹相同。前两次传输失败保留，最终对象导出/import 全部 exit 0。
这是当前真实时间创建的**本地历史归档**，未推远端、没有新测试或 CI；旧测试仍
绑定原 tree。它不是新 main 整合提交，也不替代后续候选验收。

## 收敛顺序

1. 总协调已将 e93 在独立仓库保存为可引用的历史快照，保留三个原输入和原证据。
   不改原暂存目录，不把后来 phase2、治理或 P0 改动混入该树。
2. PAIR 接手 lane 固定 #78 的取舍和 profile 语义，总协调在新 `codex/` 分支上
   制作 main + phase2 的整合候选及 draft PR。保留 main 的数据/恢复改动及 phase2
   已包含的旧栈；原 #57/#66/#67 继续作为历史审查入口，载体未落地前不关闭。
3. NET 按 **#59 → #62 → #63 → #64 → #65** 的直接父分支增量进入候选，
   不重复应用共同的 #57。逐层记录新 base/head；保留 required native gates、
   P-01 数据与 scorer 来源、session-store 字节校验和 Multi/Single 状态隔离。
4. 治理规范随候选刷新；#58 包含历史 CI checkout 和测试启动预算改动，整个 PR
   不能称为纯文档变更。本次追加才是纯文档。统一 CI/check/脚本清单后执行候选
   完整 `pnpm check` 和冷进程 e2e，旧头 CI 不代替新树验证。
5. SharedOS P0 host adapter 单独接入：新 pin/digest、driver ACK、consumer
   兼容、取消结算与恢复测试独立验收。运行在 `3aa07e3` 的 PAIR 结果不含 PR71。

总协调负责 [PR60](https://github.com/Aicoo-Team/SharedEval/pull/60) 数据检查变更与
[PR61](https://github.com/Aicoo-Team/SharedEval/pull/61) 评分变更的单独处置审查。
两者继续排除在当前运行时组合之外；先核对与新 main 数据的增量、metric 版本及
既有 P2，再决定独立纳入或标记被替代，不能无声遗漏、直接关闭或冒称已经验证。

PAIR 的 driver/session、observation、router、ledger/evidence、配置和 grants
已变化；NET 与其交叉 CI、脚本清单、session-store 测试等文件。这里记录交叉风险，
不声称已确认具体文本冲突。实际 merge 仍不在本监督任务已执行的操作内。

## 新实验报告的边界

下列是 room 170、180 的作者报告，监督方尚未收到完整脱敏产物包，**不是独立复验**：

| 范围 | 作者报告 | 当前验收结论 |
| --- | --- | --- |
| strict 两题真实 DeepInfra 预检 | 五次 completed 联系；进入 Phase 2；tick 6 联系失败、题目 error，以 all_terminal 结束 | 有真实 Phase 2 到达报告；未证明 finalization 或 60 题通过 |
| simple scripted-13 | 八 tick completed、七次联系、零 files.read；913 测试及 tsc 通过 | 替身路径报告；不能据此推断真实模型会跳过读取 |
| simple 真实 OpenInference 预检 | tick 2 context_turn_incomplete，只有一次联系；仍有七条 files.read | 失败保留，simple 真实模型验收未通过 |
| 五次 60×180 尝试 | 分别出现读循环、429、宿主终止、畸形联系等阻断 | 均未完成；180/161 与旧 300/261 配置分列，不覆盖旧失败原组 |

phase2 内 `docs/pair-simple-profile-handoff.md` 的历史叙述已过时：源码已引入
结构化 injection 声明和共享 observation predicate，不能继续以旧 marker 描述、
“没有单测”或旧 908/913 计数概括 `f74f038`。由 PAIR lane 补新版固定头报告，
提供脱敏 config、偏离说明、source/runtime/profile/provider 绑定、命令、退出码、
产物 manifest/hash，以及成功、失败和从未联系任务的独立计数。

对从未联系的任务，finalization 只能记录未尝试/未覆盖，不能冒充 responder
拒绝或生成不存在的 contact。后续用版本化 host-finalization 记录和独立评分
规则实现；未知外部效果仍 fail-closed。对确定没有 responder 执行或外部效果的
畸形联系，可在明确 profile 契约下隔离失败，并用允许、拒绝和未知三类回归验证。
不通过改写冻结 dataset、journal 或旧成绩来完成这些门槛。

通用 NET provider、第二个已注册真实任务 rubric，以及数据就绪门槛
（外部 PAIR corpus、validated gold）仍开放。总协调追踪证据，业务/data owner
需提供可共享来源与审核；gold 不能成为模型输入或替代执行授权。
