# JD-2 Fallback（E5 重试失败时使用）

2026-07-30 准备（Claude PREP watcher）。E5 三轨迹首跑失败（exit=1，strict cells 0/3）；Codex 正在重试（plan a682b8a7fc7c）。**若重试在发帖前未过 strict gate，按本文件两步切换，5 分钟内完成。**

## 步骤 1：删除 JD-2 表

删除 rebuttal_v3.md 中从 `**Table JD-2 (internal fill-ready table...` 到该表最后一行（含 PENDING mean ± SD 行）的整块。

## 步骤 2：替换 JD3a Q2 段落

用下文整体替换 Q2 现有回答（保守版，2026-07-30 上午曾在文中、经导师风格规则写成）：

> **Agreed: n=2 cannot bound the utility magnitude, and we scope the claim to exactly what n=2 supports.** What the two existing replications already establish: the *security* direction repeats in both (disclosure falls from 58% to 5% in one and from 59% to 11% in the other; McNemar p<.001 each), while D2 States utility spans 5 to 31%. The mechanism, on inspection: under a strict D2, States utility depends on whether early trajectory context happens to include the queried state objects, and small per-cell denominators amplify this; the submitted item set was small for this cell. The revision therefore (i) reports the D2 States utility as the observed range with this mechanism, not as a point estimate, (ii) states the n=2 limitation explicitly in Limitations, and (iii) keeps the surface-asymmetry claim only in the direction the replications support: the security effect is robust; the utility magnitude is uncertain and reported with its spread. Additional replications under the original protocol are future work; we do not claim them in this response.

## 步骤 3：替换 C7 行

> `| C7 | States variance rests on n=2 (JD3a Q2) | Claim rescoped to what n=2 supports: security direction robust (McNemar p<.001 in both reps), utility reported as a range (5 to 31%) with its mechanism; n=2 stated in Limitations | Done (JD3a Q2); further replications are future work, not claimed |`

## 判据

- 切换条件：发帖时刻 `a682b8a7fc7c` 未产出过 strict gate 的 3/3 轨迹 + judge 数
- 不切换条件：重试成功 → 下一轮 PREP 审数后把 PENDING 填实，本文件作废删除
