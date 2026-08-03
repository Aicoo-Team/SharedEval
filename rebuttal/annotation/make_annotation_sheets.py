#!/usr/bin/env python3
"""Generate blinded annotation sheets for the PACT-Pair non-author label audit (E7).

Part A: relationship-conditioned P/L/B labels, all 99 items x 5 requesters.
Part B: action expected-verdict audit, all 200 actions.
Part C: QA share/protect sensitivity audit, all 400 questions.

Design for audit:
- Per-annotator randomized row order (fixed seeds, reproducible).
- Opaque row codes; the true item ids live only in keys/ (organizer-only).
- 10 duplicated relationship items and 6 duplicated actions per sheet, under
  fresh codes, to measure intra-rater consistency.
- Author labels/rationales are never written into the sheets.

Run from repo root:  python3 rebuttal/annotation/make_annotation_sheets.py
"""

import csv
import json
import random
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
SHEETS = OUT / "sheets"
KEYS = OUT / "keys"

ANNOTATORS = ["A", "B", "C", "D", "E"]
REL_SEEDS = {"A": 101, "B": 102, "C": 103, "D": 104, "E": 105}
ACT_SEEDS = {"A": 201, "B": 202, "C": 203, "D": 204, "E": 205}
QA_SEEDS = {"A": 301, "B": 302, "C": 303, "D": 304, "E": 305}
DUP_SEED = 999
N_REL_DUPS = 10
N_ACT_DUPS = 10
N_QA_DUPS = 20
MIN_DUP_GAP = 10  # rows between an item and its duplicate

REL_COLS = ["R0_stranger", "R1_colleague", "R2_ceo_delegate",
            "R3_close_friend", "R4_investor"]


def shuffle_with_gap(entries, seed):
    """Shuffle entries so each duplicate sits >= MIN_DUP_GAP rows from its original."""
    rng = random.Random(seed)
    for attempt in range(1000):
        order = entries[:]
        rng.shuffle(order)
        pos = {}
        ok = True
        for i, e in enumerate(order):
            key = e["true_id"]
            if key in pos and abs(i - pos[key]) < MIN_DUP_GAP:
                ok = False
                break
            pos.setdefault(key, i)
        if ok:
            return order
    raise RuntimeError("could not satisfy duplicate gap constraint")


def main():
    matrix = json.loads((REPO / "dataset/pact-pair/relationship_labels/relationship_label_matrix.json").read_text())
    tasks = json.loads((REPO / "dataset/pact-pair/tasks/questions.json").read_text())
    qtext = {x["id"]: x for x in tasks["questions"]}

    SHEETS.mkdir(parents=True, exist_ok=True)
    KEYS.mkdir(parents=True, exist_ok=True)

    # ---------- Part A: relationship sheets ----------
    items = sorted(matrix["labels"], key=lambda x: x["id"])
    dup_rng = random.Random(DUP_SEED)
    dup_ids = sorted(dup_rng.sample([x["id"] for x in items], N_REL_DUPS))
    by_id = {x["id"]: x for x in items}

    base = [{"true_id": x["id"], "dup": False} for x in items]
    base += [{"true_id": i, "dup": True} for i in dup_ids]

    for ann in ANNOTATORS:
        order = shuffle_with_gap(base, REL_SEEDS[ann])
        sheet_path = SHEETS / f"annotator_{ann}_relationship.csv"
        key_path = KEYS / f"key_{ann}_relationship.csv"
        with open(sheet_path, "w", newline="") as fs, open(key_path, "w", newline="") as fk:
            ws = csv.writer(fs)
            wk = csv.writer(fk)
            ws.writerow(["row_code", "topic", "question"] + REL_COLS + ["note_optional"])
            wk.writerow(["row_code", "true_question_id", "is_duplicate"])
            for i, e in enumerate(order, 1):
                code = f"REL-{i:03d}"
                item = by_id[e["true_id"]]
                q = qtext[e["true_id"]]
                ws.writerow([code, q.get("topic", ""), item["question"], "", "", "", "", "", ""])
                wk.writerow([code, e["true_id"], int(e["dup"])])
        print(f"wrote {sheet_path.name}: {len(order)} rows")

    # author labels reference (organizer only)
    with open(KEYS / "author_labels_relationship.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["question_id", "category", "question", "R0", "R1", "R2", "R3", "R4"])
        for x in items:
            w.writerow([x["id"], x["category"], x["question"],
                        x["R0"], x["R1"], x["R2"], x["R3"], x["R4"]])

    # ---------- Part B: action sheets (all 200) ----------
    sampled = sorted(tasks["actions"], key=lambda a: a["id"])
    samp_rng = random.Random(DUP_SEED + 1)
    act_dup_ids = sorted(samp_rng.sample([a["id"] for a in sampled], N_ACT_DUPS))
    act_by_id = {a["id"]: a for a in sampled}

    act_base = [{"true_id": a["id"], "dup": False} for a in sampled]
    act_base += [{"true_id": i, "dup": True} for i in act_dup_ids]

    for ann in ANNOTATORS:
        order = shuffle_with_gap(act_base, ACT_SEEDS[ann])
        sheet_path = SHEETS / f"annotator_{ann}_actions.csv"
        key_path = KEYS / f"key_{ann}_actions.csv"
        with open(sheet_path, "w", newline="") as fs, open(key_path, "w", newline="") as fk:
            ws = csv.writer(fs)
            wk = csv.writer(fk)
            ws.writerow(["row_code", "surface", "operation", "target_folder",
                         "target_item", "request", "verdict_EXECUTE_or_REFUSE",
                         "note_optional"])
            wk.writerow(["row_code", "true_action_id", "is_duplicate"])
            for i, e in enumerate(order, 1):
                code = f"ACT-{i:03d}"
                a = act_by_id[e["true_id"]]
                ws.writerow([code, a["surface"], a["operation"],
                             a.get("target_folder") or "", a.get("target_item") or "",
                             a["instruction"], "", ""])
                wk.writerow([code, e["true_id"], int(e["dup"])])
        print(f"wrote {sheet_path.name}: {len(order)} rows")

    with open(KEYS / "author_labels_actions.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["action_id", "category", "expected_verdict", "instruction"])
        for a in sampled:
            w.writerow([a["id"], a["category"], a["expected_verdict"], a["instruction"]])

    # ---------- Part C: QA share/protect sheets (all 400) ----------
    questions = sorted(tasks["questions"], key=lambda x: x["id"])
    qa_rng = random.Random(DUP_SEED + 2)
    qa_dup_ids = sorted(qa_rng.sample([x["id"] for x in questions], N_QA_DUPS))
    qa_by_id = {x["id"]: x for x in questions}

    qa_base = [{"true_id": x["id"], "dup": False} for x in questions]
    qa_base += [{"true_id": i, "dup": True} for i in qa_dup_ids]

    for ann in ANNOTATORS:
        order = shuffle_with_gap(qa_base, QA_SEEDS[ann])
        sheet_path = SHEETS / f"annotator_{ann}_qa.csv"
        key_path = KEYS / f"key_{ann}_qa.csv"
        with open(sheet_path, "w", newline="") as fs, open(key_path, "w", newline="") as fk:
            ws = csv.writer(fs)
            wk = csv.writer(fk)
            ws.writerow(["row_code", "topic", "question",
                         "judgment_SHARE_PROTECT_BORDERLINE", "note_optional"])
            wk.writerow(["row_code", "true_question_id", "is_duplicate"])
            for i, e in enumerate(order, 1):
                code = f"QA-{i:03d}"
                q = qa_by_id[e["true_id"]]
                ws.writerow([code, q.get("topic", ""), q["question"], "", ""])
                wk.writerow([code, e["true_id"], int(e["dup"])])
        print(f"wrote {sheet_path.name}: {len(order)} rows")

    with open(KEYS / "author_labels_qa.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["question_id", "category", "author_label", "question"])
        for x in questions:
            lab = "SHARE" if x["category"].startswith("work_public") else "PROTECT"
            w.writerow([x["id"], x["category"], lab, x["question"]])

    print(f"\nPart A: 99 items x 5 requesters = 495 cells (+{N_REL_DUPS} dup rows/sheet)")
    print(f"Part B: {len(sampled)} actions (+{N_ACT_DUPS} dup rows/sheet)")
    print(f"Part C: {len(questions)} questions (+{N_QA_DUPS} dup rows/sheet)")


if __name__ == "__main__":
    main()
