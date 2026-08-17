#!/usr/bin/env python3
"""Validate the D-verified grid and emit verified_labels.jsonl.

Flow (lead, 2026-08-14): AI prelabel -> D (Hanxiang) verifies -> 6 non-author
humans annotate. This script ingests the edited verify_grid.csv.

Checks:
  - every *_final cell filled; QA tokens P/L, action tokens EXECUTE/REFUSE
    (B is illegal everywhere — binary decision)
  - frozen v1.1 cells (marked "(frozen)" in the *_ai column) unchanged
Emits:
  - verified_labels.jsonl: one line per cell with label + source
    (ai_confirmed / d_override / d_resolved_B / v11_frozen / v11_resolved_B)
  - override summary printed to stdout
"""
import csv
import json
import sys
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent
REQ = ["R0", "R1", "R2", "R3", "R4"]
VALID = {"qa": {"P", "L"}, "action": {"EXECUTE", "REFUSE"}}


def main() -> None:
    errors, out, src_count = [], [], Counter()
    overrides = []
    with open(BASE / "verify_grid.csv", newline="") as f:
        for rec in csv.DictReader(f):
            kind = "qa" if rec["kind"].startswith("qa") else "action"
            for r in REQ:
                ai_raw = rec[f"{r}_ai"]
                final = rec[f"{r}_final"].strip()
                cell = f"{rec['row']}.{r}"
                if not final:
                    errors.append(f"{cell}: blank — must be decided")
                    continue
                if final not in VALID[kind]:
                    errors.append(f"{cell}: illegal token {final!r}")
                    continue
                ai_label = ai_raw.split("(")[0]
                frozen = "(frozen)" in ai_raw
                if frozen and final != ai_label:
                    errors.append(f"{cell}: frozen v1.1 cell changed "
                                  f"{ai_label} -> {final} (not allowed)")
                    continue
                if frozen:
                    source = "v11_frozen"
                elif ai_label == "B":
                    source = ("v11_resolved_B" if "(v1.1)" in ai_raw
                              else "d_resolved_B")
                elif final == ai_label:
                    source = "ai_confirmed"
                else:
                    source = "d_override"
                    overrides.append(f"{cell}: {ai_label} -> {final}")
                src_count[source] += 1
                out.append({"row": rec["row"], "requester": r, "kind": kind,
                            "category": rec["category"], "label": final,
                            "source": source})
    if errors:
        print(f"{len(errors)} ERRORS — nothing written:")
        print("\n".join(errors[:30]))
        sys.exit(1)
    with open(BASE / "verified_labels.jsonl", "w") as f:
        for cell in out:
            f.write(json.dumps(cell, ensure_ascii=False) + "\n")
    print(f"verified_labels.jsonl: {len(out)} cells")
    print("sources:", dict(src_count.most_common()))
    if overrides:
        print(f"D overrides ({len(overrides)}):")
        print("\n".join(overrides))


if __name__ == "__main__":
    main()
