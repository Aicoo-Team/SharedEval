# Expectations from lead — annotation E7

> Handed down by the lead. Kept verbatim (intent-preserving); status tracked here.

## 3. 非作者标注（E7）— lead time 最长

- [ ] 五份 CSV 发出（zip 已打好在 `annotation/outbox/`）：Sara(A) / Trishit(B) / Abhinav(C) / Hanxiang(D) / Yu Chen(E)
- [ ] 回收后放 `annotation/filled/`，跑 `compute_agreement.py`
- [ ] 填 v3 的三处 κ 占位：relationship P/L/B、action verdicts、QA share/protect
- [ ] 写 adjudication notes（每个 majority ≠ author 的 cell 一句话）

## Notes / mapping to this repo

- **`compute_agreement.py` = `annotation_qc.py`** in this folder (`compare` mode).
  It computes per-item majority, no-majority ties, **Fleiss kappa**, and each
  annotator's agreement-with-majority. Run from repo root:
  `python3 pact_pair/annotation/annotation_qc.py compare filled/<A> filled/<B> ... --out qc_reports/<name>`
- **Annotator letters → people:** A = Sara (Saraswathi), B = Trishit, C = Abhinav,
  **D = Hanxiang (self, author track)**, E = Yu Chen.
- **`outbox/`** = zips to send out. **`filled/`** = returned submissions to score.
- Current submissions on disk: only **A** (`submissions/SARASWATHI_A/`).
  B/C/D/E not yet here — D (author) missing, see recovery status.
