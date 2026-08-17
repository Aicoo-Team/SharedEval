#!/usr/bin/env python3
"""PACT annotation acceptance QC.

Two modes:

  1. Validate one or more annotator folders (structural + self-consistency):
       python3 pact_pair/annotation/annotation_qc.py validate <folder> [<folder>...]

  2. Cross-annotator comparison once >=2 folders are collected:
       python3 pact_pair/annotation/annotation_qc.py compare <folder> [<folder>...] --out qc_report

Each annotator folder must contain three CSVs matching
annotator_<X>_{qa,actions,relationship}*.csv, where <X> is the annotator letter.

Important: each annotator receives the same item set in a DIFFERENT row order,
so every cross-annotator comparison aligns on item content, never on row_code.

Stdlib only; no third-party dependencies.
"""

import argparse
import csv
import itertools
import os
import re
import sys
from collections import Counter, defaultdict

# ---------------------------------------------------------------- task specs

REL_COLS = ["R0_stranger", "R1_colleague", "R2_ceo_delegate", "R3_close_friend", "R4_investor"]

TASKS = {
    "qa": {
        "prefix": "QA",
        "expected_rows": 420,
        "header": ["row_code", "topic", "question", "judgment_SHARE_PROTECT_BORDERLINE", "note_optional"],
        "label_cols": ["judgment_SHARE_PROTECT_BORDERLINE"],
        "vocab": {"SHARE", "PROTECT", "BORDERLINE"},
        "key_cols": ["topic", "question"],
    },
    "actions": {
        "prefix": "ACT",
        "expected_rows": 210,
        "header": ["row_code", "surface", "operation", "target_folder", "target_item", "request", "verdict_EXECUTE_or_REFUSE", "note_optional"],
        "label_cols": ["verdict_EXECUTE_or_REFUSE"],
        "vocab": {"EXECUTE", "REFUSE"},
        "key_cols": ["surface", "operation", "target_folder", "target_item", "request"],
    },
    "relationship": {
        "prefix": "REL",
        "expected_rows": 109,
        "header": ["row_code", "topic", "question"] + REL_COLS + ["note_optional"],
        "label_cols": REL_COLS,
        "vocab": {"P", "L", "B"},
        "key_cols": ["topic", "question"],
    },
}

# Some annotators wrote the QA vocabulary into the relationship sheet.
# Mapped by permissiveness: PROTECT->P (withhold), SHARE->L (disclose), BORDERLINE->B.
# Flagged loudly wherever applied; confirm the intent with the annotator.
VOCAB_ALIASES = {
    "relationship": {"PROTECT": "P", "SHARE": "L", "BORDERLINE": "B"},
}

MAX_RUN = 30  # straight-lining alarm threshold (consecutive identical labels)


# ---------------------------------------------------------------- loading

def find_annotator_files(folder):
    """Return (letter, {task: path}). Tolerates suffixed names like _qa_trishit.csv."""
    files = sorted(os.listdir(folder))
    paths, letters = {}, Counter()
    for task in TASKS:
        pat = re.compile(r"^annotator_([A-Za-z0-9]+)_" + task + r"[^/]*\.csv$", re.I)
        matches = [f for f in files if pat.match(f)]
        paths[task] = os.path.join(folder, matches[0]) if len(matches) == 1 else None
        if len(matches) == 1:
            letters[pat.match(matches[0]).group(1).upper()] += 1
        # non-CSV siblings (e.g. .numbers) are reported by the caller
    letter = letters.most_common(1)[0][0] if letters else os.path.basename(folder.rstrip("/"))
    return letter, paths


def load_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader, [])
        rows = [r for r in reader if any(cell.strip() for cell in r)]
    return [h.strip() for h in header], rows


def note_is_templated(rows, label_cols):
    """True when note_optional is a pure function of the label (scripted fill)."""
    notes = [r.get("note_optional", "").strip() for r in rows]
    if sum(1 for n in notes if n) < 0.9 * len(rows):
        return None
    mapping = defaultdict(set)
    for r, n in zip(rows, notes):
        mapping[tuple(r[c].strip() for c in label_cols)].add(n)
    if all(len(v) == 1 for v in mapping.values()) and len(mapping) < len(set(notes)) + 1:
        return len(mapping)
    return None


# ---------------------------------------------------------------- validate

def validate_task(letter, task, path, problems, folder):
    spec = TASKS[task]
    if path is None:
        stray = [f for f in os.listdir(folder) if task in f.lower() and not f.lower().endswith(".csv")]
        extra = f" (found non-CSV file: {stray[0]})" if stray else ""
        problems.append(("ERROR", task, f"missing or ambiguous CSV for annotator {letter}{extra}"))
        return None

    header, raw = load_rows(path)
    if header != spec["header"]:
        missing = set(spec["header"]) - set(header)
        added = set(header) - set(spec["header"])
        detail = []
        if missing:
            detail.append(f"missing {sorted(missing)}")
        if added:
            detail.append(f"unexpected {sorted(added)}")
        if not detail:
            detail.append("column order differs")
        problems.append(("ERROR", task, "header mismatch: " + "; ".join(detail)))
        if missing:
            return None

    rows = [dict(zip(header, r)) for r in raw]
    n = len(rows)
    if n != spec["expected_rows"]:
        problems.append(("ERROR", task, f"row count {n}, expected {spec['expected_rows']}"))

    codes = [r["row_code"] for r in rows]
    dups = [c for c, k in Counter(codes).items() if k > 1]
    if dups:
        problems.append(("ERROR", task, f"duplicate row_code: {dups[:5]}"))
    expected_codes = [f"{spec['prefix']}-{i:03d}" for i in range(1, n + 1)]
    if codes != expected_codes:
        bad = [c for c, e in zip(codes, expected_codes) if c != e][:5]
        problems.append(("ERROR", task, f"row_code sequence broken near {bad}"))

    # label vocabulary, with alias normalization
    aliases = VOCAB_ALIASES.get(task, {})
    applied = Counter()
    for r in rows:
        for col in spec["label_cols"]:
            v = r.get(col, "").strip()
            if not v:
                problems.append(("ERROR", task, f"{r['row_code']}: empty label in {col}"))
                continue
            if v in aliases:
                applied[v] += 1
                r[col] = aliases[v]
            elif v not in spec["vocab"]:
                problems.append(("ERROR", task, f"{r['row_code']}: invalid label {v!r} in {col} (allowed {sorted(spec['vocab'])})"))
    if applied:
        problems.append(("WARN", task, "used the QA vocabulary instead of the P/L/B codebook; normalized "
                                       + ", ".join(f"{k}->{aliases[k]} x{v}" for k, v in applied.most_common())
                                       + " — confirm this mapping matches what the annotator meant"))

    # scripted-looking notes
    n_classes = note_is_templated(rows, spec["label_cols"])
    if n_classes is not None:
        problems.append(("WARN", task, f"note_optional is a pure function of the label ({n_classes} fixed templates "
                                       f"across {n} rows) — consistent with scripted/bulk fill rather than per-item reasoning"))

    # self-consistency on repeated items (same content appearing twice in the file)
    by_key = defaultdict(list)
    for r in rows:
        by_key[tuple(r[c].strip() for c in spec["key_cols"])].append(r)
    n_probe = n_bad = 0
    for grp in by_key.values():
        if len(grp) < 2:
            continue
        n_probe += 1
        sigs = {tuple(r[c].strip() for c in spec["label_cols"]) for r in grp}
        if len(sigs) > 1:
            n_bad += 1
            problems.append(("WARN", task, f"inconsistent labels on repeated item {[r['row_code'] for r in grp]}: {sorted(sigs)}"))
    if n_probe:
        lvl = "WARN" if n_bad > 2 else "INFO"
        problems.append((lvl, task, f"self-consistency probes: {n_probe - n_bad}/{n_probe} consistent"))

    # straight-lining (R0_stranger all-P is the expected conservative pattern, not laziness)
    for col in spec["label_cols"]:
        seq = [r[col].strip() for r in rows]
        if col == "R0_stranger" and set(seq) == {"P"}:
            continue
        best_len, best_at = 0, 0
        for _, grp in itertools.groupby(enumerate(seq), key=lambda t: t[1]):
            grp = list(grp)
            if len(grp) > best_len:
                best_len, best_at = len(grp), grp[0][0]
        if best_len >= MAX_RUN:
            problems.append(("WARN", task, f"{col}: run of {best_len} identical labels starting at {rows[best_at]['row_code']}"))

    for col in spec["label_cols"]:
        dist = Counter(r[col].strip() for r in rows)
        total = sum(dist.values())
        problems.append(("INFO", task, f"{col}: " + ", ".join(f"{k}={v} ({100*v/total:.0f}%)" for k, v in dist.most_common())))

    if task == "relationship":
        for r in rows:
            if r["R0_stranger"] == "L" and all(r[c] != "L" for c in REL_COLS[1:]):
                problems.append(("WARN", task, f"{r['row_code']}: stranger=L but no other relation gets L — verify"))

    return rows


def cmd_validate(folders):
    any_error = False
    data = {}
    for folder in folders:
        letter, paths = find_annotator_files(folder)
        problems, tasks_data = [], {}
        for task in TASKS:
            tasks_data[task] = validate_task(letter, task, paths[task], problems, folder)
        data[letter] = tasks_data
        errs = sum(1 for lvl, _, _ in problems if lvl == "ERROR")
        warns = sum(1 for lvl, _, _ in problems if lvl == "WARN")
        any_error |= errs > 0
        verdict = "FAIL (fix and resubmit)" if errs else ("PASS with warnings" if warns else "PASS")
        print(f"\n=== Annotator {letter} ({os.path.basename(folder.rstrip('/'))}) — {verdict}: {errs} error(s), {warns} warning(s)")
        for lvl, task, msg in problems:
            print(f"  [{lvl}] {task}: {msg}")
    return data, any_error


# ---------------------------------------------------------------- compare

def item_decisions(tasks_data):
    """Flatten one annotator's labels into {(task, item_key, column): label}.

    Repeated items collapse to their first occurrence; disagreement between the
    copies is reported separately by the self-consistency check.
    """
    out = {}
    for task, rows in tasks_data.items():
        if not rows:
            continue
        spec = TASKS[task]
        for r in rows:
            key = tuple(r[c].strip() for c in spec["key_cols"])
            for col in spec["label_cols"]:
                k = (task, key, col)
                if k not in out:
                    v = r[col].strip()
                    if v:
                        out[k] = v
    return out


def fleiss_kappa(matrix):
    """matrix: list of Counters (label -> count), one per item, equal rater count."""
    matrix = [m for m in matrix if sum(m.values()) > 1]
    if not matrix:
        return float("nan")
    sizes = {sum(m.values()) for m in matrix}
    if len(sizes) != 1:
        return float("nan")
    n_raters = sizes.pop()
    cats = sorted({c for m in matrix for c in m})
    N = len(matrix)
    p_j = {c: sum(m.get(c, 0) for m in matrix) / (N * n_raters) for c in cats}
    P_i = [(sum(v * v for v in m.values()) - n_raters) / (n_raters * (n_raters - 1)) for m in matrix]
    P_bar = sum(P_i) / N
    P_e = sum(v * v for v in p_j.values())
    return 1.0 if P_e == 1 else (P_bar - P_e) / (1 - P_e)


def cmd_compare(folders, out_prefix):
    data, any_error = cmd_validate(folders)
    letters = sorted(data)
    if len(letters) < 2:
        print("\ncompare needs >=2 annotator folders")
        return 1

    print("\n=== Item-set alignment (matched on content, since row order is shuffled per annotator)")
    ref = letters[0]
    for task, spec in TASKS.items():
        ref_rows = data[ref][task]
        if not ref_rows:
            print(f"  [SKIP] {task}: reference annotator {ref} has no usable file")
            continue
        ref_keys = Counter(tuple(r[c].strip() for c in spec["key_cols"]) for r in ref_rows)
        for lt in letters[1:]:
            rows = data[lt][task]
            if not rows:
                print(f"  [SKIP] {task}: {lt} has no usable file")
                continue
            keys = Counter(tuple(r[c].strip() for c in spec["key_cols"]) for r in rows)
            if keys == ref_keys:
                same_pos = sum(1 for a, b in zip(rows, ref_rows)
                               if tuple(a[c].strip() for c in spec["key_cols"]) == tuple(b[c].strip() for c in spec["key_cols"]))
                print(f"  [OK] {task}: {lt} has the same {len(keys)} items as {ref} (row order differs; {same_pos} rows coincide)")
            else:
                only_lt = sum((keys - ref_keys).values())
                only_ref = sum((ref_keys - keys).values())
                print(f"  [ERROR] {task}: {lt} item set differs from {ref} — {only_lt} extra, {only_ref} missing")

    all_dec = {lt: item_decisions(data[lt]) for lt in letters}
    common = set.intersection(*(set(d) for d in all_dec.values()))
    for lt in letters:
        skipped = len(set(all_dec[lt]) - common)
        if skipped:
            print(f"  [note] {lt}: {skipped} decision(s) excluded from agreement (blank label or item not shared by all)")

    per_task = defaultdict(list)
    for key in common:
        per_task[key[0]].append(key)

    print("\n=== Agreement metrics")
    majority, tied = {}, set()
    for task in TASKS:
        keys = sorted(per_task[task])
        if not keys:
            continue
        matrix, n_full = [], 0
        for k in keys:
            cnt = Counter(all_dec[lt][k] for lt in letters)
            matrix.append(cnt)
            ranked = cnt.most_common()
            majority[k] = ranked[0]
            if len(ranked) > 1 and ranked[1][1] == ranked[0][1]:
                tied.add(k)
            if ranked[0][1] == len(letters):
                n_full += 1
        kappa = fleiss_kappa(matrix)
        n_tied = sum(1 for k in keys if k in tied)
        print(f"  {task}: {len(keys)} decisions | unanimous {n_full} ({100*n_full/len(keys):.1f}%) | "
              f"no-majority ties {n_tied} | Fleiss kappa = {kappa:.3f}")
        for a, b in itertools.combinations(letters, 2):
            agree = sum(1 for k in keys if all_dec[a][k] == all_dec[b][k])
            print(f"    pairwise {a}-{b}: {100*agree/len(keys):5.1f}%")

    print("\n=== Per-annotator agreement with the majority label (ties excluded; flag if < 80%)")
    for lt in letters:
        line = [f"  {lt}:"]
        for task in TASKS:
            keys = [k for k in per_task[task] if k not in tied]
            if not keys:
                continue
            hit = sum(1 for k in keys if all_dec[lt][k] == majority[k][0])
            pct = 100 * hit / len(keys)
            line.append(f"{task} {pct:5.1f}%{'(!)' if pct < 80 else '   '}")
        print(" ".join(line))

    print("\n=== Duplicate-submission screen (flag if > 98% identical)")
    for a, b in itertools.combinations(letters, 2):
        same = sum(1 for k in common if all_dec[a][k] == all_dec[b][k])
        pct = 100 * same / len(common)
        print(f"  {a}-{b}: {pct:5.1f}%{'  <-- REVIEW (suspiciously identical)' if pct > 98 else ''}")

    out_csv = f"{out_prefix}_disagreements.csv"
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["task", "column", "item"] + [f"label_{lt}" for lt in letters]
                   + ["majority", "votes", "is_tie", "adjudicated_label"])
        n_out = 0
        for k in sorted(common, key=lambda x: (x[0], x[2], x[1])):
            top_label, top_n = majority[k]
            if top_n == len(letters):
                continue
            task, key, col = k
            w.writerow([task, col, " | ".join(key)]
                       + [all_dec[lt][k] for lt in letters]
                       + [top_label, f"{top_n}/{len(letters)}", "YES" if k in tied else "", ""])
            n_out += 1
    print(f"\nWrote {n_out} disagreement rows to {out_csv} (fill 'adjudicated_label' to resolve).")
    return 1 if any_error else 0


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="structural + self-consistency checks per folder")
    v.add_argument("folders", nargs="+")
    c = sub.add_parser("compare", help="cross-annotator agreement (needs >=2 folders)")
    c.add_argument("folders", nargs="+")
    c.add_argument("--out", default="annotation_qc", help="prefix for output files")
    args = ap.parse_args()
    if args.cmd == "validate":
        _, any_error = cmd_validate(args.folders)
        return 1 if any_error else 0
    return cmd_compare(args.folders, args.out)


if __name__ == "__main__":
    sys.exit(main())
