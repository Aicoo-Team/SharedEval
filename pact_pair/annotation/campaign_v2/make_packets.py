#!/usr/bin/env python3
"""Cut the 6 annotator packets for the 600x5 binary campaign.

Assignment (row-level, from prelabel routing):
  - rows with any double_label cell      -> 2 annotators
  - v1.1-B rows (39 legacy B cells)      -> 2 annotators
  - rows with adjudicate_1 (no double)   -> 1 annotator
  - audit-pool-only rows                 -> seeded sample 15% QA / 20% ACT -> 1
Every packet also carries 6 hidden self-consistency probes (duplicated rows
under fresh codes). Row codes are blind (ROW-###); the true-ID mapping stays
in keys/ (never sent). Deterministic: seeded, no timestamps.

Run from repo root:  python3 pact_pair/annotation/campaign_v2/make_packets.py
Outputs: outbox/annotator_{A..F}.csv, keys/annotator_{A..F}_key.csv,
         assignment_manifest.json
"""
import csv
import json
import random
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).parent
PRE = BASE.parent / "prelabel_v2"
MATRIX = BASE.parent.parent.parent / "dataset" / "pact-pair" / \
    "relationship_labels" / "relationship_label_matrix.json"
ANNOTATORS = list("ABCDEF")
SEED = 2026
N_PROBES = 6
REQ = ["R0", "R1", "R2", "R3", "R4"]


def load_texts() -> dict:
    texts = {}
    for r in json.loads((PRE / "rows_canonical.json").read_text()):
        texts[r["row"]] = {
            "kind": r["kind"], "category": r["category"],
            "text": r.get("question") or r.get("instruction"),
        }
    for lrow in json.loads(MATRIX.read_text())["labels"]:
        texts[f"Q{lrow['id']}(v1.1)"] = {
            "kind": "qa", "category": lrow["category"],
            "question_id_hidden": lrow["id"], "text": lrow["question"],
        }
    return texts


def main() -> None:
    rng = random.Random(SEED)
    texts = load_texts()
    routes = defaultdict(set)
    for rec in csv.DictReader(open(PRE / "routing.csv")):
        routes[rec["row"]].add(rec["route"])
    v11_rows = sorted({f"{r['row']}(v1.1)" for r in
                       csv.DictReader(open(PRE / "v11_b_cells_rebinarize.csv"))})

    double = sorted(r for r, s in routes.items() if "double_label" in s)
    adj = sorted(r for r, s in routes.items()
                 if "adjudicate_1" in s and "double_label" not in s)
    audit_only = sorted(r for r, s in routes.items() if s == {"audit_pool"})
    qa_audit = [r for r in audit_only if r.startswith("Q")]
    act_audit = [r for r in audit_only if r.startswith("A")]
    audit = (rng.sample(qa_audit, round(len(qa_audit) * 0.15))
             + rng.sample(act_audit, round(len(act_audit) * 0.20)))

    packets = {a: [] for a in ANNOTATORS}
    order = ANNOTATORS[:]
    idx = 0

    def next_annotators(n):
        nonlocal idx
        chosen = []
        while len(chosen) < n:
            a = order[idx % len(order)]
            idx += 1
            if a not in chosen:
                chosen.append(a)
        return chosen

    for pool, copies in ((double, 2), (v11_rows, 2), (adj, 1), (audit, 1)):
        pool = pool[:]
        rng.shuffle(pool)
        for row in pool:
            for a in next_annotators(copies):
                packets[a].append(row)

    (BASE / "outbox").mkdir(exist_ok=True)
    (BASE / "keys").mkdir(exist_ok=True)
    manifest = {"seed": SEED, "annotators": {}, "pools": {
        "double_rows": len(double), "adjudicate_rows": len(adj),
        "v11_b_rows": len(v11_rows), "audit_sample_rows": len(audit)}}
    for a in ANNOTATORS:
        rows = packets[a][:]
        rng.shuffle(rows)
        probes = rng.sample(rows, N_PROBES)
        entries = [(row, False) for row in rows] + [(p, True) for p in probes]
        rng.shuffle(entries)
        with open(BASE / "outbox" / f"annotator_{a}.csv", "w", newline="") as f, \
             open(BASE / "keys" / f"annotator_{a}_key.csv", "w", newline="") as kf:
            w = csv.writer(f)
            kw = csv.writer(kf)
            w.writerow(["row_code", "kind", "category", "text",
                        "R0", "R1", "R2", "R3", "R4", "note_optional"])
            kw.writerow(["row_code", "true_row", "is_probe"])
            for i, (row, is_probe) in enumerate(entries, 1):
                code = f"ROW-{i:03d}"
                t = texts[row]
                w.writerow([code, t["kind"], t["category"], t["text"],
                            "", "", "", "", "", ""])
                kw.writerow([code, row, int(is_probe)])
        manifest["annotators"][a] = {
            "rows": len(entries), "unique_rows": len(rows), "probes": N_PROBES}
    (BASE / "assignment_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n")
    counts = {a: m["rows"] for a, m in manifest["annotators"].items()}
    print("packet sizes:", counts)
    print("pools:", manifest["pools"])


if __name__ == "__main__":
    main()
