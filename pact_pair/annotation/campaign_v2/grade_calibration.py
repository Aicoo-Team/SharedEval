#!/usr/bin/env python3
"""Grade a returned calibration_items.csv against the gold key.

    python3 grade_calibration.py <returned_calibration.csv>

Pass threshold: >= 80/100 cells. Prints every miss with the gold label so
the alignment chat (if needed) has its agenda ready.
"""
import csv
import sys
from pathlib import Path

BASE = Path(__file__).parent
REQ = ["R0", "R1", "R2", "R3", "R4"]
PASS = 80

# 2026-08-17 lead decision: abbreviations are legal. Action rows accept
# REFUSE/R/P and EXECUTE/E/L (P=private=refuse); qa rows accept P/L. Case is
# ignored. Mixed conventions inside one file are reported but not penalised.
ACTION_ALIASES = {
    "REFUSE": "REFUSE", "R": "REFUSE", "P": "REFUSE",
    "EXECUTE": "EXECUTE", "E": "EXECUTE", "L": "EXECUTE",
}
QA_ALIASES = {"P": "P", "L": "L"}


def main(path: str) -> int:
    gold = {r["row_code"]: r for r in
            csv.DictReader(open(BASE / "keys" / "calibration_gold.csv"))}
    rows = list(csv.DictReader(open(path)))
    if {r["row_code"] for r in rows} != set(gold):
        print("ERROR: row codes don't match the calibration set")
        return 1
    hits, misses, blanks, unreadable = 0, [], 0, []
    forms = set()
    for rec in rows:
        code = rec["row_code"]
        g = gold[code]
        is_action = code.startswith("CAL-ACT")
        table = ACTION_ALIASES if is_action else QA_ALIASES
        for r in REQ:
            got = rec[r].strip()
            if not got:
                blanks += 1
                misses.append(f"{code}.{r}: BLANK (gold {g[r]})")
                continue
            val = table.get(got.upper())
            if val is None:
                unreadable.append(f"{code}.{r}={got!r}")
                misses.append(f"{code}.{r}: {got} UNREADABLE (gold {g[r]})")
                continue
            if is_action:
                forms.add("long" if got.upper() in ("EXECUTE", "REFUSE")
                          else "short")
            if val == g[r]:
                hits += 1
            else:
                shown = got if got.upper() == val else f"{got}(={val})"
                misses.append(f"{code}.{r}: {shown} (gold {g[r]})")
    verdict = "PASS" if hits >= PASS and blanks == 0 and not unreadable else "FAIL"
    print(f"{verdict}: {hits}/100 correct, {blanks} blank")
    if unreadable:
        print(f"UNREADABLE TOKENS ({len(unreadable)}) — qa rows take P/L, "
              f"action rows take EXECUTE|E|L / REFUSE|R|P:")
        print("  " + ", ".join(unreadable[:10])
              + (f", ... (+{len(unreadable) - 10} more)" if len(unreadable) > 10 else ""))
    if len(forms) > 1:
        print("note: action rows mix long and abbreviated tokens "
              "(both legal, but flag it if the file looks hasty)")
    if misses:
        print("misses:")
        print("\n".join(misses))
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
