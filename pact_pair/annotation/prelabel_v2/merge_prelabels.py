#!/usr/bin/env python3
"""Merge the single-pass Fable 5 prelabels into ai_prelabels.jsonl + routing.

Mode (lead decision 2026-08-14): ONE AI prelabel pass; all real annotation is
done by the 6-7 human annotators. The prelabel only routes human attention.

Inputs:  outputs/pass1_chunk{1..9}.json  (written by judge agents)
         rows_canonical.json             (401 rows; defines full coverage)
Outputs: ai_prelabels.jsonl  — one line per cell (2,005), single vote
         routing.csv         — per-cell route (Phase 2 packet input)

Routing (confidence-based, since there is a single vote):
  conf >= 0.8 and label != B  -> "audit_pool"   (15% QA / 20% ACT human audit)
  label == B, or 0.6<=conf<0.8 -> "adjudicate_1" (1 human decides)
  conf < 0.6                   -> "double_label" (2 humans, escalate to 3)
"""
import csv
import json
import sys
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent
REQ = ["R0", "R1", "R2", "R3", "R4"]
CHUNKS = range(1, 10)


def main() -> None:
    canonical = json.loads((BASE / "rows_canonical.json").read_text())
    expected = {r["row"]: r for r in canonical}
    votes = {}
    for c in CHUNKS:
        f = BASE / "outputs" / f"pass1_chunk{c}.json"
        if not f.exists():
            sys.exit(f"missing output: {f} — run incomplete, not merging")
        for obj in json.loads(f.read_text()):
            if obj["row"] in votes:
                sys.exit(f"duplicate row {obj['row']}")
            votes[obj["row"]] = obj
    missing = set(expected) - set(votes)
    if missing:
        sys.exit(f"missing rows: {sorted(missing)[:10]}")

    valid = {"qa": {"P", "L", "B"}, "action": {"EXECUTE", "REFUSE"}}
    cells, route_rows = [], []
    routes, label_dist = Counter(), Counter()
    for row_key, meta in expected.items():
        o = votes[row_key]
        for r in REQ:
            label = o["labels"][r]
            if label not in valid[meta["kind"]]:
                sys.exit(f"invalid label {label} for {row_key}.{r}")
            conf = o["conf"][r]
            why = o.get("why", {}).get(r, "")
            if conf >= 0.8 and label != "B":
                route = "audit_pool"
            elif conf >= 0.6:
                route = "adjudicate_1"
            else:
                route = "double_label"
            routes[route] += 1
            label_dist[(meta["kind"], label)] += 1
            cells.append({"row": row_key, "requester": r, "kind": meta["kind"],
                          "category": meta["category"], "ai_label": label,
                          "conf": conf, "why": why, "route": route})
            route_rows.append([row_key, r, meta["kind"], meta["category"],
                               label, f"{conf:.2f}", route])

    assert len(cells) == 2005, len(cells)
    with open(BASE / "ai_prelabels.jsonl", "w") as f:
        for cell in cells:
            f.write(json.dumps(cell, ensure_ascii=False) + "\n")
    with open(BASE / "routing.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["row", "requester", "kind", "category", "ai_label",
                    "conf", "route"])
        w.writerows(route_rows)

    print(f"cells: {len(cells)}")
    print("routes:", dict(routes.most_common()))
    qa_b = label_dist[("qa", "B")]
    qa_total = sum(n for (k, _), n in label_dist.items() if k == "qa")
    print(f"QA B share: {qa_b}/{qa_total} = {qa_b/qa_total:.1%}")
    print("label dist:", {f"{k}:{l}": n for (k, l), n in sorted(label_dist.items())})


if __name__ == "__main__":
    main()
