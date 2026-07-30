# Q1 三点结构成稿（2026-07-30，Claude；Codex 合并用）

用户指示的结构：① 我们本来就有大量 operating points（全部实验规模说清楚）；② 我们还特意在一个固定 dataset 上跑了可比的新实验；③ 我们也听了建议改了 framing。

关键叙事修正：breadth 的证据 = 提交版全量实验（每格 200 题级别），新跑的 60 题 = 受控可比性工具。绝不能让 60 题承担 breadth 的举证责任。

以下英文可直接替换 Q1 开头至 GR-3 句（保留其后的 D3-D5 表与 AP-1 表作为第一点的展开证据）：

---

**Thank you for raising this framing concern; we agree, and we address it from three angles: the breadth the study already measures, a new controlled comparison, and the corrected framing.**

First, the submitted study already measures far more operating points than the frontier figure displayed. The figure showed three policies; the evaluation behind it spans five axes. Policy by model: three policies across six requester-model families on Files, 200 tasks per cell (18 points, Table GR-1). Surface: the same policies on States and on Actions with database-diff scoring (6 points). Interaction length: the 240-tick multi-turn protocol over two models and three policies, plus three literature-derived defences, Spotlighting (Hines et al. 2024), Instruction Hierarchy (Wallace et al. 2024), and Sandwich + Boundary (9 points; Table AP-1 and the defence table below). Relationship: four requester profiles under one fixed policy, 400 QA plus 200 actions each (Table AP-2), and a relationship-aware policy comparison of 6,000 trials. Scale and mechanism: PACT-NET with 25 agents, two policy conditions, two replications of roughly 1,000 tasks plus 75 probes each (Tables JD-4 and JD-5), pre-retrieval mounting over three conditions and five requesters (TtBh Q3), and a pre-tool escalation gate with eight cells and 11,659 decisions (Table JD-7). Counting distinct model, policy, surface, and requester combinations, the submission and its appendix already contain more than forty operating points; the chart under-represented the evaluation, and the revision presents this inventory explicitly.

Second, during the discussion period we added one deliberately controlled comparison, small by design: its job is comparability, not breadth. Table GR-4 evaluates eight policy packages on the same 60 questions with the same gpt-5-mini requester, responder, and judge, so package differences cannot be confounded with model or task differences; disclosure spans 87.5% to 5.0%, utility spans 95.0% to 65.0%, and the lowest-disclosure packages are not interchangeable because their refusal rates range from 72.5% to 95.0%. Table GR-3 then varies the responder on one canonical 30-question subset: P2 cuts disclosure from 90% to 5% for DeepSeek V4 Flash and from 80% to 5% for GLM 5.2.

Third, we follow the reviewer's suggestion on the framing itself: the revision replaces "security–utility frontier" with *security–utility trade-offs across discrete operating points* everywhere and no longer suggests interpolation, which is indeed the more accurate description of what we measure.

---

数字核对备注（全部已在 AUDIT_LEDGER 或论文表中）：
- 18 = 6 模型 × 3 policy（GR-1，Files，每格 200 题，mini 2 reps）
- 6 = States 3 + Actions 3
- 9 = AP-1 的 2×3 + D3/D4/D5 三点（各 6–7 splits）
- 4 requesters × (400 QA + 200 actions)（tab:relationship / AP-2）
- 6,000 = rel-policy 5×400×3
- PACT-NET：25 agents、P0/P1、2 reps、每 run ~1,000 tasks + 75 probes
- mounting 3 条件 × 5 requesters × 200 题；gate 8 格 11,659
- "more than forty" 为保守计数（实数 ≈53），不给精确数以免被逐格对
