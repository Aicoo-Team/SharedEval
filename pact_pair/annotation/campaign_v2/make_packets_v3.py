#!/usr/bin/env python3
"""Cut full-coverage annotator packets: every annotator labels all 600 rows.

Lead decision 2026-08-17: abandon the partitioned design (make_packets.py, 6
packets x ~81 rows). All five annotators label the complete 600-task set, so
every cell carries 5 independent labels -> per-cell majority vote and full-set
kappa, which the partitioned design could not produce (280 of its rows were
singly labeled, and no row anywhere had the 3 labels a majority needs).

Packets are identical in content and differ only in row order (per-annotator
seed) plus the placement of hidden self-consistency probes. Row codes are blind
(ROW-###); the true-ID mapping stays in keys_v3/ and is never sent.

Deterministic: seeded, no timestamps.

Run from repo root:
    python3 pact_pair/annotation/campaign_v2/make_packets_v3.py
Outputs: outbox_v3/<name>.csv, keys_v3/<name>_key.csv, assignment_manifest_v3.json
"""
import csv
import json
import random
from pathlib import Path

BASE = Path(__file__).parent
DATASET = BASE.parent.parent.parent / "dataset" / "pact-pair"
QUESTIONS = DATASET / "tasks" / "questions.json"
MATRIX = DATASET / "relationship_labels" / "relationship_label_matrix.json"
CANONICAL = BASE.parent / "prelabel_v2" / "rows_canonical.json"

# The five annotators who cleared the calibration gate (2026-08-17). Named after
# their returned calibration files so no name->packet mapping step is needed.
ANNOTATORS = ["sara", "abhinav", "chenyu", "trishit", "E"]
SEED = 2026
N_PROBES = 12
HEADER = ["row_code", "kind", "category", "text",
          "R0", "R1", "R2", "R3", "R4", "note_optional"]


def load_rows() -> list:
    """The 401 rows that actually need fresh human labels.

    600 dataset tasks, minus two blocks the lead cut on 2026-08-17:

      -100 actions with `expected_verdict == "refuse"`. The loader enforces that
           the relationship axis may only *restrict* the action surface, so all
           five cells are forced REFUSE regardless of what a human writes
           (`autofill_refuse_actions.py`). Labeling them produces no information.
       -99 questions already labeled in relationship_label_matrix.json (v1.1).
           Those results are reused as-is.

    The v1.1 block is Q101–Q200 **minus Q125**, which was never in the matrix and
    does need labels — hence the set is derived from the matrix file rather than
    from an id range. Result equals prelabel_v2/rows_canonical.json (401).
    """
    data = json.loads(QUESTIONS.read_text())
    if data["version"] != 6:
        raise SystemExit(f"questions.json version {data['version']} != 6")
    v11 = {int(l["id"]) for l in json.loads(MATRIX.read_text())["labels"]}

    rows = [{"row": f"Q{q['id']}", "kind": "qa", "category": q["category"],
             "text": q["question"]}
            for q in data["questions"] if int(q["id"]) not in v11]
    rows += [{"row": f"A{a['id']}", "kind": "action", "category": a["category"],
              "text": a["instruction"]}
             for a in data["actions"] if a["expected_verdict"] != "refuse"]

    if len(rows) != 401:
        raise SystemExit(f"expected 401 rows, built {len(rows)}")
    if len({r["row"] for r in rows}) != 401:
        raise SystemExit("duplicate row ids")
    canon = {r["row"] for r in json.loads(CANONICAL.read_text())}
    if {r["row"] for r in rows} != canon:
        raise SystemExit("row set does not match rows_canonical.json")
    return rows


def main() -> None:
    rows = load_rows()
    (BASE / "outbox_v3").mkdir(exist_ok=True)
    (BASE / "keys_v3").mkdir(exist_ok=True)
    manifest = {"seed": SEED, "design": "full_coverage",
                "rows_per_annotator": len(rows), "probes": N_PROBES,
                "annotators": {}}

    for n, name in enumerate(ANNOTATORS):
        # distinct stream per annotator: different order, different probe picks
        rng = random.Random(SEED + 1000 * (n + 1))
        order = rows[:]
        rng.shuffle(order)
        probes = rng.sample(order, N_PROBES)
        entries = [(r, False) for r in order] + [(p, True) for p in probes]
        rng.shuffle(entries)

        out = BASE / "outbox_v3" / f"{name}.csv"
        key = BASE / "keys_v3" / f"{name}_key.csv"
        with open(out, "w", newline="") as f, open(key, "w", newline="") as kf:
            w, kw = csv.writer(f), csv.writer(kf)
            w.writerow(HEADER)
            kw.writerow(["row_code", "true_row", "is_probe"])
            for i, (r, is_probe) in enumerate(entries, 1):
                code = f"ROW-{i:03d}"
                w.writerow([code, r["kind"], r["category"], r["text"],
                            "", "", "", "", "", ""])
                kw.writerow([code, r["row"], int(is_probe)])
        manifest["annotators"][name] = {
            "rows": len(entries), "unique_rows": len(order),
            "probes": N_PROBES, "cells": len(entries) * 5}

    (BASE / "assignment_manifest_v3.json").write_text(
        json.dumps(manifest, indent=2) + "\n")
    per = len(rows) + N_PROBES
    print(f"design: full coverage — {len(ANNOTATORS)} annotators x {per} rows")
    print(f"  unique tasks     : {len(rows)}")
    print(f"  probes each      : {N_PROBES} (duplicated rows, fresh codes)")
    print(f"  cells per person : {per * 5}")
    print(f"  cells total      : {per * 5 * len(ANNOTATORS)}")
    print(f"  labels per cell  : {len(ANNOTATORS)} -> majority vote + full kappa")


if __name__ == "__main__":
    main()
