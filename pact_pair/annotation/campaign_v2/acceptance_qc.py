#!/usr/bin/env python3
"""Acceptance QC for the v2 binary campaign (successor to annotation_qc.py).

validate — run per returned file, any ERROR -> return to annotator:
    python3 acceptance_qc.py validate filled/annotator_A.csv
  Checks: header, row count vs manifest, no blanks, exact vocab by kind,
  hidden-probe self-consistency, straight-lining (R0 exempt), template notes.

compare — run when all six are in (and D's verify is ingested):
    python3 acceptance_qc.py compare filled/ --out qc_report
  Reports per annotator: agreement vs D-verified labels, calibration score;
  pairwise raw agreement + Cohen kappa on shared rows; per-cell majority and
  disagreement export (qc_report_disagreements.csv). Ties resolve P/REFUSE
  per the pre-committed rule and are flagged `tie`.
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

BASE = Path(__file__).parent
PRE = BASE.parent / "prelabel_v2"
REQ = ["R0", "R1", "R2", "R3", "R4"]
HEADER = ["row_code", "kind", "category", "text",
          "R0", "R1", "R2", "R3", "R4", "note_optional"]
VALID = {"qa": {"P", "L"}, "action": {"EXECUTE", "REFUSE"}}
CONSERVATIVE = {"qa": "P", "action": "REFUSE"}
STRAIGHT_RUN = 30


def load_key(annotator: str) -> dict:
    path = BASE / "keys" / f"annotator_{annotator}_key.csv"
    return {r["row_code"]: r for r in csv.DictReader(open(path))}


def read_filled(path: Path):
    rows = list(csv.DictReader(open(path)))
    if not rows or list(rows[0].keys()) != HEADER:
        return None, [f"header mismatch — expected {HEADER}"]
    return rows, []


def validate(path: Path) -> int:
    manifest = json.loads((BASE / "assignment_manifest.json").read_text())
    annotator = path.stem.split("_")[-1].upper()
    if annotator not in manifest["annotators"]:
        print(f"ERROR: cannot map {path.name!r} to an annotator — "
              f"expected filename annotator_<{'|'.join(manifest['annotators'])}>.csv")
        return 1
    rows, errors = read_filled(path)
    warns = []
    if rows is None:
        print("ERROR:", errors[0])
        return 1
    expected_n = manifest["annotators"][annotator]["rows"]
    if len(rows) != expected_n:
        errors.append(f"row count {len(rows)} != {expected_n}")
    key = load_key(annotator)
    seen_labels = {}
    notes = Counter()
    for rec in rows:
        code = rec["row_code"]
        if code not in key:
            errors.append(f"{code}: unknown row_code")
            continue
        kind = rec["kind"]
        labels = []
        for r in REQ:
            v = rec[r].strip()
            if not v:
                errors.append(f"{code}.{r}: blank")
            elif v not in VALID.get(kind, set()):
                errors.append(f"{code}.{r}: illegal token {v!r} for {kind}")
            labels.append(v)
        seen_labels[code] = tuple(labels)
        if rec["note_optional"].strip():
            notes[rec["note_optional"].strip().lower()] += 1
    # probe consistency
    by_true = defaultdict(list)
    for code, k in key.items():
        by_true[k["true_row"]].append(code)
    bad_probes = 0
    for true_row, codes in by_true.items():
        if len(codes) > 1:
            got = {seen_labels.get(c) for c in codes if c in seen_labels}
            if len(got) > 1:
                bad_probes += 1
                warns.append(f"probe inconsistent: {true_row} ({codes})")
    if bad_probes >= 3:
        errors.append(f"{bad_probes} inconsistent probes (>=3 fails)")
    # template notes
    if notes and notes.most_common(1)[0][1] > 10:
        errors.append(f"templated note reused {notes.most_common(1)[0][1]}x")
    # straight-lining per column (R0 exempt)
    for i, r in enumerate(REQ):
        if r == "R0":
            continue
        run = best = 0
        prev = None
        for rec in rows:
            v = rec[r].strip()
            run = run + 1 if v == prev else 1
            prev = v
            best = max(best, run)
        if best >= STRAIGHT_RUN:
            warns.append(f"{r}: {best}-row straight-line run")
    for w in warns:
        print("WARN:", w)
    if errors:
        print(f"{len(errors)} ERRORS:")
        print("\n".join(errors[:40]))
        return 1
    print(f"OK: {path.name} ({len(rows)} rows, {bad_probes} probe misses)")
    return 0


def compare(folder: Path, out: str) -> int:
    verified = {}
    vf = PRE / "verified_labels.jsonl"
    if vf.exists():
        for line in open(vf):
            c = json.loads(line)
            verified[(c["row"], c["requester"])] = c["label"]
    else:
        print("note: verified_labels.jsonl missing — vs-verified stats skipped")
    votes = defaultdict(dict)   # (true_row, requester) -> annotator -> label
    kinds = {}
    for path in sorted(folder.glob("annotator_*.csv")):
        annotator = path.stem.split("_")[-1].upper()
        key = load_key(annotator)
        rows, errs = read_filled(path)
        if rows is None:
            print(f"skip {path.name}: {errs[0]}")
            continue
        for rec in rows:
            k = key.get(rec["row_code"])
            if not k or k["is_probe"] == "1":
                continue
            for r in REQ:
                votes[(k["true_row"], r)][annotator] = rec[r].strip()
                kinds[k["true_row"]] = rec["kind"]
    annotators = sorted({a for v in votes.values() for a in v})
    # per annotator vs verified
    for a in annotators:
        hit = tot = 0
        for (row, r), v in votes.items():
            if a in v and (row, r) in verified:
                tot += 1
                hit += v[a] == verified[(row, r)]
        if tot:
            print(f"{a}: vs-verified {hit}/{tot} = {hit/tot:.1%}")
    # pairwise on shared cells
    for a, b in combinations(annotators, 2):
        shared = [(v[a], v[b]) for v in votes.values() if a in v and b in v]
        if len(shared) < 10:
            continue
        agree = sum(x == y for x, y in shared)
        po = agree / len(shared)
        pa = Counter(x for x, _ in shared)
        pb = Counter(y for _, y in shared)
        pe = sum(pa[l] * pb[l] for l in set(pa) | set(pb)) / len(shared) ** 2
        kappa = (po - pe) / (1 - pe) if pe < 1 else float("nan")
        print(f"{a}-{b}: n={len(shared)} agree={po:.1%} kappa={kappa:.3f}")
    # majority + disagreements
    out_rows = []
    for (row, r), v in sorted(votes.items()):
        if len(v) < 2:
            continue
        counts = Counter(v.values())
        top, n = counts.most_common(1)[0]
        tie = len(counts) > 1 and list(counts.values()).count(n) > 1
        final = CONSERVATIVE[kinds[row]] if tie else top
        if tie or len(counts) > 1:
            out_rows.append([row, r, kinds[row],
                             ";".join(f"{a}:{l}" for a, l in sorted(v.items())),
                             verified.get((row, r), ""), final,
                             "tie" if tie else "majority"])
    out_path = folder / f"{out}_disagreements.csv"
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["row", "requester", "kind", "votes", "d_verified",
                    "resolution", "how"])
        w.writerows(out_rows)
    print(f"multi-annotated cells with disagreement: {len(out_rows)} "
          f"-> {out_path}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "validate":
        sys.exit(validate(Path(sys.argv[2])))
    if len(sys.argv) >= 3 and sys.argv[1] == "compare":
        out = "qc_report"
        args = sys.argv[2:]
        if "--out" in args:
            i = args.index("--out")
            out = args[i + 1]
            args = args[:i]
        sys.exit(compare(Path(args[0]), out))
    print(__doc__)
    sys.exit(2)
