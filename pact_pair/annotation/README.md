# pact_pair/annotation/

Everything about the PACT-Pair annotation campaign — planning, the QC tool, raw
submissions, and audit results. Co-located with the data it audits.

**The gold data itself is NOT here** — it lives in its canonical place:
- `../tasks/questions.json` — category-level QA gold (`expected_m2`, requester-agnostic)
- `../tasks/gold_answers_legacy.{json,md}`
- `../relationship_labels/relationship_label_matrix.json` — R-tier requester-conditioned labels

## Contents

### 600×5 campaign (v2, 2026-08 — see `../../pact_pair_annotation_plan.md`)
- `ANNOTATION_GUIDELINES_V2.md` — Phase 0 draft guidelines (per-requester rules, B criteria, tie rule, forced-refuse constraint). Pending lead sign-off on two work_public policy calls.
- `calibration_v2/` — 20-item calibration set: `calibration_items.csv` (blank, annotator-facing) + `calibration_KEY.md` (draft gold, lead-only).
- `autofill_refuse_actions.py` — emits the 500 mechanically-forced `refuse` cells (100 canonically-refused actions × R0–R4) in matrix-v2 row shape.
- `prelabel_v2/` — Phase 1 AI prelabel (single-pass Claude Fable 5, routing only, never gold): `JUDGE_RULES.md` (condensed judge prompt), `packets/` + `outputs/` (9 chunks, 401 rows), `merge_prelabels.py`, `ai_prelabels.jsonl` (2,005 cells), `routing.csv` (confidence-based routes for the human campaign).

### Round 1–2 campaign (99×5 → matrix v1.1, frozen 2026-07-29)
- `how_to_annotate_zh.md` — the labeling strategy guide (REL patterns / ACT lines / QA rules); reconstructed how-to.
- `expectations_from_lead.md` — the lead's checklist for the E7 non-author annotation round + repo mapping.
- `annotation_acceptance_plan_zh.md` — 5-annotator (×3 CSV) acceptance procedure.
- `annotation_qc.py` — QC tool (pure stdlib). Run from repo root:
  - `python3 pact_pair/annotation/annotation_qc.py validate <folder> [...]`
  - `python3 pact_pair/annotation/annotation_qc.py compare <folder> [...] --out <name>`
- `annotation_qc_round1_report_zh.md` — round-1 audit (A/B/C/D).
- `gold_conflict_15_items_zh.md` — 15 QA-gold vs relationship-matrix conflicts for leader adjudication.
- `submissions/` — raw annotator CSVs (one subfolder per annotator). Present: **A** (`SARASWATHI_A/`) and **D** (`PACT_annotation_D_Hanxiang/`, recovered — see `_review_D/RECOVERY_NOTE.md`). B/C/E not on disk.
- `_review_D/` — D's provenance: generator scripts (`fill_*.py`, `compare.py`), `conflicts_review.csv` (97 rows D vs gold), `blind_check.csv` + `blind_check_KEY.csv` (40-row blind sample), `RECOVERY_NOTE.md`.
- `outbox/` — zips to send to annotators.
- `filled/` — returned submissions to score with `annotation_qc.py compare`.
- `qc_reports/` — `compare` output.

Annotator letters: A=Sara, B=Trishit, C=Abhinav, **D=Hanxiang (self)**, E=Yu Chen.
