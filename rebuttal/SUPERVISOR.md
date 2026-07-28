# Rebuttal 实验监督循环 — 运行手册

Claude 每小时执行一次，共 10 轮（2026-07-29 00:00 起）。Codex 并行工作在同一批代码和实验上，所以每一步都假设文件可能已被改动。

日志：`pulse/research/runs/rebuttal/EXPERIMENT_SUPERVISOR.log`（追加，每条署名）

---

## 铁律 0 — 命名空间隔离（2026-07-29 污染事故后新增）

**绝不触碰其他实验正在使用的 group/UUID。** 启动或 seed 任何东西之前：

1. 列出所有在跑实验的 alex/tina UUID（`ps` 读 `--alex-id`，orchestrator 的读 seed 日志）
2. 读即将启动的 plan JSON，提取它的 groups/UUID
3. **与任何在跑或未完成实验有重叠 → 不启动**，把冲突写进日志
4. **seed 之前先查 DB**：该 alex UUID 下已有数据 → 停下，先弄清归属。covering seed 覆盖活数据，就是 P0/P1 policy 被两个 sweep 互相改写的根源

背景：orchestrator 每个 plan 都从 3000 起编 group，**没有跨 plan 唯一性**。defender sweep 的 group 3000/3001 与 E2 的 p1/p2 撞在同一对 Alex（8bb8/8bb9）上，`setupAlexPolicy` 互相覆盖 POLICY.md，两边数据双向污染。dry-run 输出里 `group=3000` 明明白白写着，启动前没对号——这类冲突肉眼可查，必须查。

## 每轮固定动作

1. **读日志尾部** — 先看 Codex 写了什么，再动手。今天已经因为不看当前状态就执行，导致重复跑一次 E4、误启四个 cell。
2. **查余额** — `OpenRouter /credits`。留 $30 不动；单轮新增支出上限 $15。
3. **查在跑的实验** — `ps -Ao command | grep -c '[e]xperiment_v2'`（注意：`pgrep -fc` 在 macOS 上返回值不可靠，今天误判过两次）。
4. **查进度缺口** — 各 sweep 的 valid/total，对照 `TODO.md`。
5. **只在 DB 空闲时启新实验** — 并发上限 2。两个 sweep 抢 Neon 连接今天造成过 `ECONNRESET` 连环失败。
6. **写日志** — 时间戳 + `CLAUDE` 署名 + 本轮做了什么、为什么、下一轮打算做什么。
7. **提交** — `TODO.md`、`rebuttal_v3.md`、supervisor log 的变更，留下轨迹。

---

## 判定规则（今天踩坑换来的）

| 现象 | 正确解读 |
|---|---|
| 日志为空 | **不是"没错误"**，是 stdout 被块缓冲或进程被杀。查产物文件，不查 stdout |
| `tsc` exit 134 | 128+6 = SIGABRT，OOM 崩溃。**不是"0 errors"**。只有 exit 0/1 才是有效结论 |
| exit 144 | 128+16，被 harness 杀。任务没跑完 |
| cell 名以 `_q1_r1` 结尾 | 单题 smoke，**通路验证不是实验数据** |
| manifest 状态 `running` 但无进程 | 被强杀，来不及写终止状态。数据完好可续跑 |
| CLI 参数存在 | **不代表生效**。今天发现三个空转参数（`EXPERIMENT_MODEL`、QA track 的 `--judge-model`、我自己漏传的 `--out-dir`） |

**一条总原则**：任何"完成"的声明，必须来自读过的产物文件，不能来自命令返回值或叙述。

---

## 实验优先级

按"能否支撑一条被 reviewer 点名的 claim"排序，不是按容易程度。

| 序 | 实验 | 规模 | 回应 | 状态 |
|---|---|---|---|---|
| 1 | **E2 policy 消融** P1/P2/P6/P7 | 4×60 | aP1N Q2、TtBh Q2、AC | 收尾中，剩 13 题 |
| 2 | **Defender 轴** 4 模型 × P0/P2 | 8×60 = 480 | JD3a Q3；替换被删的 L312 claim | **已启动** |
| 3 | **E6 relationship × 非 OpenAI** | R0–R4 × GLM | JD3a Q3 的关系条件部分 | 未启动 |
| 4 | **E5 States replication** | 补至 n≥5 | JD3a Q2 | 未启动 |
| 5 | **E1 operating points** | 7 policy × k 模型 | aP1N Q1、TtBh Q4 | 未启动，需先定 policy 名单 |

**10 小时内现实的交付**：1、2 完成，3 可能完成。4、5 量太大，**不会为了凑数把没跑完的当跑完**。

---

## 不做的事

- 不重构 Codex 正在改的文件，只修阻塞运行的 bug
- 不在余额低于 $30 时启动任何付费实验
- 不并发超过 2 个 sweep
- 不把单题 smoke 写成实验结果
- 不在没读产物的情况下更新 `TODO.md` 的完成状态
