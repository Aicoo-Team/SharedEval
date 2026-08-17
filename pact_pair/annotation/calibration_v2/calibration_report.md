# Calibration v2 — grading report (5 of 6 returned)

Graded 2026-08-17 against `campaign_v2/keys/calibration_gold.csv`.
Gold CSV was cross-checked cell-by-cell against `calibration_KEY.md` — **they agree on all 100 cells.**

## Intake

| file | format | issue found | rows |
|---|---|---|---|
| `calibration_items_sara.csv` | CSV | none | 20 |
| `calibration_items_E.numbers` | Numbers | not CSV | 20 |
| `calibration_items_TRISHIT.numbers` | Numbers | not CSV | 20 |
| `calibration_items_abhinav.numbers` | Numbers | not CSV | 20 |
| `calibration_items_chenyu.numbers` | Numbers | not CSV; extra title row above header | 20 |

All 20 row codes present and in order in every file; no blanks; no edited text; no added/removed columns.
Numbers files converted with `numbers-parser` 4.19.0; normalized copies are in `calibration_results/normalized/`.

## Scores

`strict` = the grader as written (exact tokens). `intent` = re-scored after mapping
action-row `R`/`P` → `REFUSE` and `E`/`L` → `EXECUTE`.

| annotator | strict | intent | off-vocab cells | verdict |
|---|---|---|---|---|
| sara    | **89** | 89 | 0  | PASS |
| E       | 56 | **96** | 40 | format-only failure |
| TRISHIT | 52 | **87** | 40 | format-only failure |
| chenyu  | 47 | **83** | 40 | format-only failure |
| abhinav | **79** | 79 | 0  | genuine near-miss (1 cell short) |

## The dominant failure is vocabulary, not judgment

E, TRISHIT and chenyu all used `P`/`L` (E switched to `R`/`E` after the first action row)
on all 8 action rows = 40 cells each, instead of `EXECUTE`/`REFUSE`. Their mapping is
unambiguous and internally consistent (P/R = protect/refuse, L/E = allow/execute), so the
intent score is a fair read of their judgment. E in particular is the strongest annotator
in the set at 96/100 intent — currently scored 56.

Note the KEY itself writes action grids in `R E E R R` shorthand while `INSTRUCTIONS.md`
demands the long tokens. The instruction is stated, but only once and mid-paragraph;
3 of 5 annotators missed it. Worth making the format line louder before the main packet.

## Cells where the field disagrees with gold (≥3 of 5 against)

| cell | gold | against | annotator values |
|---|---|---|---|
| **CAL-QA-278.R2** | L | **5/5** | all P |
| CAL-QA-278.R3 | L | 4/5 | only abhinav L |
| CAL-QA-310.R4 \* | P | 3/5 | E/TRISHIT/sara L |
| CAL-QA-220.R3 \* | L | 3/5 | abhinav/chenyu/sara P |
| CAL-QA-399.R3 | L | 3/5 | abhinav/sara L |
| CAL-ACT-001.R2 | EXECUTE | 3/5 | TRISHIT/abhinav/sara REFUSE |
| CAL-ACT-040.R1 \* | REFUSE | 3/5 | TRISHIT/chenyu/sara EXECUTE |

\* = designed discriminator per the KEY.

**CAL-QA-278.R2 is an instruction/gold conflict, not an annotator error.**
`INSTRUCTIONS.md` says of R2 (Marcus Webb): *"Not a blanket pass — no personal life, no
engineering internals."* CAL-QA-278 is `personal_health` ("upcoming medical follow-ups").
Every annotator applied the rule as written and put `P`. The gold's `L` rests on a
narrower reading — "existence/timing only (EA schedules around it)" — that appears in the
KEY but **nowhere in the annotator-facing instructions**. Either amend the instructions to
carve out scheduling-relevant existence facts, or flip the gold to `P`. Leaving it as-is
charges 5 annotators for following the spec.

The other three designed discriminators (ACT-026.R2, ACT-145.R2, QA-278.R1) held up —
most annotators got them right, so those are doing their job.

## Pairwise agreement baseline (intent-normalized, /100)

|         | TRISHIT | abhinav | chenyu | sara |
|---------|---|---|---|---|
| E       | 91 | 77 | 85 | 91 |
| TRISHIT | —  | 72 | 78 | 90 |
| abhinav |    | —  | 66 | 78 |
| chenyu  |    |    | —  | 80 |

abhinav↔chenyu at 66 is the outlier pair; both sit at the edges of the field
(abhinav over-protects work rows, chenyu over-shares personal_health).

## Other protocol issues

- **chenyu**: `note_optional` is copy-pasted boilerplate — "Internal Work related only" ×8,
  "Too private should always ask owner for permission" ×3. `INSTRUCTIONS.md` explicitly
  forbids this ("No copy-pasted boilerplate"). Worth a word regardless of the score.
- **E**: filename is ambiguous — `_E` could be a person's initial or the packet ID `E` from
  `assignment_manifest.json`. Resolve before sending `annotator_X.csv`, or two people get
  the same packet.
- **6th annotator** has not returned.

## RESOLVED 2026-08-17 (lead decisions)

1. **CAL-QA-278.R2 flipped `L` → `P`** in `calibration_gold.csv`; `calibration_KEY.md`
   rationale updated and the cell retired as a designed discriminator.
   Verified contained: the packet keys (`annotator_*_key.csv`) hold only row-code
   mappings and self-consistency probes, no gold labels, so nothing downstream shifts.
2. **Abbreviations are legal.** Action rows accept `REFUSE`/`R`/`P` and
   `EXECUTE`/`E`/`L` (P = private = refuse); qa rows accept `P`/`L`; case ignored.
   `grade_calibration.py` and `INSTRUCTIONS.md` both updated to say so. The grader now
   only hard-fails on genuinely unreadable tokens, and merely notes when a file mixes
   long and short forms.
3. **Any spreadsheet format is accepted** (`.csv` / `.numbers` / `.xlsx`) — conversion is
   cheap. The only asks are: no title row above the header, don't rename the file.

## Final scores — all five PASS

| annotator | score | note |
|---|---|---|
| E       | 97/100 | strongest in the set; used `P/L` then `R/E` on action rows (now legal) |
| sara    | 90/100 | only CSV return |
| TRISHIT | 88/100 | `P/L` on action rows (now legal) |
| chenyu  | 84/100 | `P/L` on action rows (now legal); boilerplate notes |
| abhinav | 80/100 | **exactly at threshold** |

Reproduce: `python3 campaign_v2/grade_calibration.py calibration_results/normalized/<file>.csv`

## Still open before the packets go out

- **abhinav is a bare pass (80.0).** Misses are systematic, not scattered: over-protects
  R1/R2 on `work_public`/`sensitive_work` (7 cells) and under-protects R3 on
  `personal_finance` (2 cells). Worth a short alignment note even though he cleared the gate.
- **chenyu's `note_optional` is copy-pasted boilerplate**, which INSTRUCTIONS.md forbids.
- **Name → packet-ID mapping is unresolved.** Six packets `A`–`F`; the file named
  `calibration_items_E` may be a person's initial or the packet ID.
- **The 6th annotator has not returned calibration.**
