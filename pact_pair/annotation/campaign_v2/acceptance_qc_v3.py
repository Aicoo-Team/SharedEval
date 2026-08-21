#!/usr/bin/env python3
"""Acceptance QC for the v3 full-coverage campaign (5 annotators x 413 rows).

    python3 acceptance_qc_v3.py <returns_dir> [--out <prefix>]

<returns_dir> holds one CSV per annotator, named <name>.csv matching
assignment_manifest_v3.json (E, abhinav, chenyu, sara, trishit).

Stage 1 — per-file validation (any ERROR = return to annotator):
  header, row count, row_code set vs key, blanks, vocabulary (2026-08-17
  alias rules: qa P/L; action REFUSE|R|P / EXECUTE|E|L; case-insensitive),
  probe self-consistency (12 hidden repeats; >=4 mismatches ERROR, >=2 WARN),
  straight-lining (R0/R3/R4 exempt for actions, R0 exempt for qa),
  templated notes.

Stage 2 — cross-annotator (only files that passed):
  per-cell 5-way votes on the 401 true rows: Fleiss kappa (overall + by
  kind), pairwise Cohen kappa, each annotator's agreement-with-majority,
  majority labels with pre-committed tie rule (qa->P, action->REFUSE, flagged
  `tie`), terse label distribution, disagreement export.

Outputs (written next to this script):
  qc_v3_majority.csv, qc_v3_disagreements.csv
"""
import csv
import json
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

BASE = Path(__file__).parent
REQ = ["R0", "R1", "R2", "R3", "R4"]
HEADER = ["row_code", "kind", "category", "text",
          "R0", "R1", "R2", "R3", "R4", "note_optional"]
ACTION_ALIASES = {"REFUSE": "REFUSE", "R": "REFUSE", "P": "REFUSE",
                  "EXECUTE": "EXECUTE", "E": "EXECUTE", "L": "EXECUTE"}
QA_ALIASES = {"P": "P", "L": "L"}
# --lenient-qa: accept the action-style letters on qa rows too (round-2
# precedent: normalize a consistent foreign vocabulary instead of bouncing
# the file). E/EXECUTE -> L (answer), R/REFUSE -> P (protect).
QA_ALIASES_LENIENT = {**QA_ALIASES, "E": "L", "EXECUTE": "L",
                      "R": "P", "REFUSE": "P"}
LENIENT_QA = False
CONSERVATIVE = {"qa": "P", "action": "REFUSE"}
PROBE_ERROR, PROBE_WARN = 4, 2
STRAIGHT_RUN = 40


def kind_of(true_row: str) -> str:
    return "qa" if true_row.startswith("Q") else "action"


def normalize(raw: str, kind: str):
    if kind == "qa":
        table = QA_ALIASES_LENIENT if LENIENT_QA else QA_ALIASES
    else:
        table = ACTION_ALIASES
    return table.get(raw.strip().upper())


def validate(name: str, path: Path, key: dict) -> tuple[dict, bool]:
    """Returns (normalized labels {true_row: {req: label}}, passed)."""
    errors, warns = [], []
    rows = list(csv.DictReader(open(path)))
    if not rows or [c.strip() for c in rows[0].keys()] != HEADER:
        print(f"[{name}] ERROR: header mismatch")
        return {}, False
    if len(rows) != len(key):
        errors.append(f"row count {len(rows)} != {len(key)}")
    seen = {}
    notes = Counter()
    for rec in rows:
        code = rec["row_code"].strip()
        k = key.get(code)
        if not k:
            errors.append(f"{code}: unknown row_code")
            continue
        kind = kind_of(k["true_row"])
        labels = {}
        for r in REQ:
            raw = rec[r].strip()
            if not raw:
                errors.append(f"{code}.{r}: blank")
                continue
            val = normalize(raw, kind)
            if val is None:
                errors.append(f"{code}.{r}: unreadable token {raw!r} ({kind})")
                continue
            labels[r] = val
        seen[code] = labels
        note = rec["note_optional"].strip()
        if note:
            notes[note.lower()] += 1
    # probes
    by_true = defaultdict(list)
    for code, k in key.items():
        by_true[k["true_row"]].append(code)
    probe_miss = 0
    for true_row, codes in by_true.items():
        if len(codes) < 2:
            continue
        variants = {tuple(sorted(seen.get(c, {}).items())) for c in codes}
        if len(variants) > 1:
            probe_miss += 1
    if probe_miss >= PROBE_ERROR:
        errors.append(f"{probe_miss}/12 probes inconsistent (>= {PROBE_ERROR})")
    elif probe_miss >= PROBE_WARN:
        warns.append(f"{probe_miss}/12 probes inconsistent")
    # templated notes
    if notes and notes.most_common(1)[0][1] > 15:
        top, n = notes.most_common(1)[0]
        warns.append(f"note reused {n}x: {top[:60]!r}")
    # straight-lining on non-trivial columns
    exempt = {"qa": {"R0"}, "action": {"R0", "R3", "R4"}}
    for r in REQ:
        run = best = 0
        prev = None
        for rec in rows:
            k = key.get(rec["row_code"].strip())
            if not k:
                continue
            kind = kind_of(k["true_row"])
            if r in exempt[kind]:
                prev = None
                run = 0
                continue
            v = seen.get(rec["row_code"].strip(), {}).get(r)
            run = run + 1 if v == prev and v is not None else 1
            prev = v
            best = max(best, run)
        if best >= STRAIGHT_RUN:
            warns.append(f"{r}: {best}-row straight-line run (non-exempt rows)")
    for w in warns:
        print(f"[{name}] WARN: {w}")
    if errors:
        print(f"[{name}] {len(errors)} ERRORS:")
        for e in errors[:15]:
            print(f"[{name}]   {e}")
        if len(errors) > 15:
            print(f"[{name}]   ... +{len(errors) - 15} more")
        return {}, False
    # collapse to true_row keyed labels (first occurrence wins, probes agree)
    out = {}
    for code, labels in seen.items():
        true = key[code]["true_row"]
        if true not in out and len(labels) == len(REQ):
            out[true] = labels
    print(f"[{name}] OK: {len(rows)} rows, probe misses {probe_miss}/12")
    return out, True


def fleiss(cells: list[list[str]]) -> float:
    cats = sorted({l for votes in cells for l in votes})
    n = len(cells[0])
    p_cell = []
    p_cat = Counter()
    for votes in cells:
        c = Counter(votes)
        p_cell.append((sum(v * v for v in c.values()) - n) / (n * (n - 1)))
        p_cat.update(c)
    total = sum(p_cat.values())
    pe = sum((p_cat[c] / total) ** 2 for c in cats)
    pbar = sum(p_cell) / len(p_cell)
    return (pbar - pe) / (1 - pe) if pe < 1 else float("nan")


def main() -> int:
    global LENIENT_QA
    args = sys.argv[1:]
    if "--lenient-qa" in args:
        LENIENT_QA = True
        args.remove("--lenient-qa")
        print("lenient-qa: action-style letters accepted on qa rows "
              "(E->L, R->P)")
    if not args:
        print(__doc__)
        return 2
    out_prefix = "qc_v3"
    if "--out" in args:
        i = args.index("--out")
        out_prefix = args[i + 1]
        args = args[:i]
    returns = Path(args[0])
    manifest = json.loads((BASE / "assignment_manifest_v3.json").read_text())
    labels = {}
    for name in manifest["annotators"]:
        path = returns / f"{name}.csv"
        if not path.exists():
            print(f"[{name}] MISSING: {path}")
            continue
        key = {r["row_code"]: r for r in
               csv.DictReader(open(BASE / "keys_v3" / f"{name}_key.csv"))}
        norm, ok = validate(name, path, key)
        if ok:
            labels[name] = norm
    if len(labels) < 2:
        print("fewer than 2 valid files — stopping before comparison")
        return 1
    names = sorted(labels)
    common = set.intersection(*(set(v) for v in labels.values()))
    print(f"\ncomparison over {len(common)} rows x 5 requesters, "
          f"annotators: {', '.join(names)}")
    # build vote table
    votes = {}
    for true in sorted(common):
        for r in REQ:
            votes[(true, r)] = {n: labels[n][true][r] for n in names}
    # Fleiss overall + by kind
    for label_kind in ("qa", "action"):
        cells = [list(v.values()) for (t, _), v in votes.items()
                 if kind_of(t) == label_kind]
        if cells:
            print(f"Fleiss kappa ({label_kind}): {fleiss(cells):.3f} "
                  f"over {len(cells)} cells")
    # pairwise Cohen
    print("pairwise:", end=" ")
    pair_stats = []
    for a, b in combinations(names, 2):
        pairs = [(v[a], v[b]) for v in votes.values()]
        agree = sum(x == y for x, y in pairs)
        po = agree / len(pairs)
        ca, cb = Counter(x for x, _ in pairs), Counter(y for _, y in pairs)
        pe = sum(ca[l] * cb[l] for l in set(ca) | set(cb)) / len(pairs) ** 2
        kappa = (po - pe) / (1 - pe) if pe < 1 else float("nan")
        pair_stats.append(f"{a}-{b} {po:.0%}/{kappa:.2f}")
    print("; ".join(pair_stats))
    # majority + ties + per-annotator agreement with majority
    maj = {}
    ties = 0
    with_majority = Counter()
    seen_by = Counter()
    for cell, v in votes.items():
        c = Counter(v.values())
        top, n = c.most_common(1)[0]
        tie = list(c.values()).count(n) > 1
        if tie:
            ties += 1
            final = CONSERVATIVE[kind_of(cell[0])]
        else:
            final = top
        maj[cell] = (final, tie, c)
        for name, l in v.items():
            seen_by[name] += 1
            with_majority[name] += l == final
    print("agreement with majority:",
          "; ".join(f"{n} {with_majority[n]/seen_by[n]:.0%}" for n in names))
    print(f"ties (resolved conservative): {ties}")
    dist = Counter()
    for (t, _), (final, _, _) in maj.items():
        dist[(kind_of(t), final)] += 1
    print("majority label dist:",
          {f"{k}:{l}": n for (k, l), n in sorted(dist.items())})
    # exports
    maj_path = BASE / f"{out_prefix}_majority.csv"
    dis_path = BASE / f"{out_prefix}_disagreements.csv"
    with open(maj_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["row", "requester", "kind", "label", "votes", "tie"])
        for (t, r), (final, tie, c) in sorted(maj.items()):
            w.writerow([t, r, kind_of(t), final,
                        "/".join(f"{l}x{n}" for l, n in sorted(c.items())),
                        int(tie)])
    n_dis = 0
    with open(dis_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["row", "requester", "kind", "votes_by_annotator",
                    "majority", "tie"])
        for (t, r), (final, tie, c) in sorted(maj.items()):
            if len(c) > 1:
                n_dis += 1
                w.writerow([t, r, kind_of(t),
                            ";".join(f"{n}:{votes[(t, r)][n]}" for n in names),
                            final, int(tie)])
    print(f"non-unanimous cells: {n_dis} -> {dis_path.name}; "
          f"full majority -> {maj_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
