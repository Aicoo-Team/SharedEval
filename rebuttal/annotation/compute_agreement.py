#!/usr/bin/env python3
"""Score the PACT-Pair non-author annotation audit (E7).

Reads filled sheets from rebuttal/annotation/filled/ (same filenames and format
as sheets/, with the label columns filled in), maps rows back to true item ids
via keys/, and writes results/ containing:

  agreement_report.md   Fleiss kappa per requester and overall, P-vs-notP
                        sensitivity, intra-rater consistency on duplicates,
                        majority-vs-author agreement, per-category breakdown.
  disagreements_relationship.csv   every cell where the annotator majority
                        differs from the author label (adjudication input).
  disagreements_actions.csv        same for the action verdict audit.

Usage:
  python3 rebuttal/annotation/compute_agreement.py            # score filled/
  python3 rebuttal/annotation/compute_agreement.py --selftest # mock run
"""

import csv
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
ANNOTATORS = ["A", "B", "C", "D", "E"]
REL_COLS = ["R0_stranger", "R1_colleague", "R2_ceo_delegate",
            "R3_close_friend", "R4_investor"]
REL_SHORT = {c: c.split("_")[0] for c in REL_COLS}
REL_VALID = {"P", "L", "B"}
ACT_VALID = {"EXECUTE", "REFUSE"}
QA_VALID = {"SHARE", "PROTECT", "BORDERLINE"}


def read_key(path):
    rows = list(csv.DictReader(open(path)))
    return {r["row_code"]: (int(r[[k for k in r if k.startswith("true_")][0]]),
                            r["is_duplicate"] == "1") for r in rows}


def read_filled(path):
    return {r["row_code"]: r for r in csv.DictReader(open(path))}


def fleiss_kappa(rating_counts, categories):
    """rating_counts: list of Counter(category -> n raters) per item."""
    items = [c for c in rating_counts if sum(c.values()) >= 2]
    if not items:
        return float("nan"), 0
    n_raters = max(sum(c.values()) for c in items)
    items = [c for c in items if sum(c.values()) == n_raters]
    N = len(items)
    if N == 0:
        return float("nan"), 0
    p_cat = {k: sum(c.get(k, 0) for c in items) / (N * n_raters) for k in categories}
    P_bar = sum(
        (sum(v * v for v in c.values()) - n_raters) / (n_raters * (n_raters - 1))
        for c in items) / N
    P_e = sum(p * p for p in p_cat.values())
    if P_e >= 1.0:
        return 1.0, N
    return (P_bar - P_e) / (1 - P_e), N


def collapse(label):
    return "P" if label == "P" else "NOTP"


def score_relationship(filled_dir, keys_dir, results_dir, author_path):
    author = {}
    for r in csv.DictReader(open(author_path)):
        author[int(r["question_id"])] = r

    # votes[item_id][requester_short] = {annotator: label}
    votes = defaultdict(lambda: defaultdict(dict))
    dup_pairs = defaultdict(list)  # annotator -> [(first_label, dup_label, req, id)]
    invalid = []
    present = []

    for ann in ANNOTATORS:
        f = filled_dir / f"annotator_{ann}_relationship.csv"
        if not f.exists():
            continue
        present.append(ann)
        key = read_key(keys_dir / f"key_{ann}_relationship.csv")
        firsts = {}
        for code, row in read_filled(f).items():
            true_id, is_dup = key[code]
            for col in REL_COLS:
                lab = (row.get(col) or "").strip().upper()
                if lab == "":
                    continue
                if lab not in REL_VALID:
                    invalid.append((ann, code, col, lab))
                    continue
                if is_dup:
                    if (true_id, col) in firsts:
                        dup_pairs[ann].append((firsts[(true_id, col)], lab, col, true_id))
                else:
                    votes[true_id][REL_SHORT[col]][ann] = lab
                    firsts[(true_id, col)] = lab
        # duplicates encountered before originals: second pass
        for code, row in read_filled(f).items():
            true_id, is_dup = key[code]
            if not is_dup:
                continue
            for col in REL_COLS:
                lab = (row.get(col) or "").strip().upper()
                if lab in REL_VALID and (true_id, col) in firsts and \
                   not any(d[3] == true_id and d[2] == col for d in dup_pairs[ann]):
                    dup_pairs[ann].append((firsts[(true_id, col)], lab, col, true_id))

    lines = ["## Part A — relationship labels", "",
             f"Sheets received: {', '.join(present) or 'none'}"]
    if invalid:
        lines.append(f"Invalid entries skipped: {len(invalid)} (see console)")
        for x in invalid[:20]:
            print("invalid:", x)

    # Fleiss kappa per requester and overall
    lines.append("")
    lines.append("| Scope | Fleiss κ (P/L/B) | κ (P vs not-P) | items |")
    lines.append("|---|---|---|---|")
    all_counts, all_counts_bin = [], []
    for col in REL_COLS:
        rs = REL_SHORT[col]
        counts = [Counter(votes[i][rs].values()) for i in votes if votes[i][rs]]
        counts_bin = [Counter(collapse(v) for v in votes[i][rs].values())
                      for i in votes if votes[i][rs]]
        k3, n3 = fleiss_kappa(counts, REL_VALID)
        k2, _ = fleiss_kappa(counts_bin, {"P", "NOTP"})
        all_counts += counts
        all_counts_bin += counts_bin
        lines.append(f"| {col} | {k3:.3f} | {k2:.3f} | {n3} |")
    k3, n3 = fleiss_kappa(all_counts, REL_VALID)
    k2, _ = fleiss_kappa(all_counts_bin, {"P", "NOTP"})
    lines.append(f"| **all cells pooled** | **{k3:.3f}** | **{k2:.3f}** | {n3} |")

    # intra-rater consistency
    lines += ["", "### Intra-rater consistency (duplicate rows)", "",
              "| Annotator | identical | total | rate |", "|---|---|---|---|"]
    for ann in present:
        pairs = dup_pairs.get(ann, [])
        same = sum(1 for a, b, *_ in pairs if a == b)
        rate = f"{same/len(pairs):.1%}" if pairs else "n/a"
        lines.append(f"| {ann} | {same} | {len(pairs)} | {rate} |")

    # majority vs author
    dis_rows = []
    agree = total = no_major = 0
    cat_stat = defaultdict(lambda: [0, 0])
    for i in sorted(votes):
        for col in REL_COLS:
            rs = REL_SHORT[col]
            v = votes[i][rs]
            if len(v) < 3:
                continue
            total += 1
            maj, n = Counter(v.values()).most_common(1)[0]
            if n <= len(v) / 2:
                no_major += 1
                maj = "NO_MAJORITY"
            au = author[i][rs]
            cat = author[i]["category"]
            cat_stat[cat][1] += 1
            if maj == au:
                agree += 1
                cat_stat[cat][0] += 1
            else:
                dis_rows.append([i, cat, author[i]["question"], col, au, maj,
                                 "/".join(f"{a}:{l}" for a, l in sorted(v.items()))])
    lines += ["", "### Majority vote vs author label", "",
              f"- Agreement: {agree}/{total} = {agree/total:.1%}" if total else "- no data",
              f"- Cells with no strict majority: {no_major}",
              "", "| Category | agree | total | rate |", "|---|---|---|---|"]
    for cat, (a, t) in sorted(cat_stat.items()):
        lines.append(f"| {cat} | {a} | {t} | {a/t:.1%} |")

    with open(results_dir / "disagreements_relationship.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["question_id", "category", "question", "requester",
                    "author_label", "annotator_majority", "votes"])
        w.writerows(dis_rows)
    lines.append("")
    lines.append(f"Disagreement cells written: {len(dis_rows)} "
                 f"(disagreements_relationship.csv)")
    return lines


def score_actions(filled_dir, keys_dir, results_dir, author_path):
    author = {int(r["action_id"]): r for r in csv.DictReader(open(author_path))}
    votes = defaultdict(dict)
    dup_pairs = defaultdict(list)
    present = []
    for ann in ANNOTATORS:
        f = filled_dir / f"annotator_{ann}_actions.csv"
        if not f.exists():
            continue
        present.append(ann)
        key = read_key(keys_dir / f"key_{ann}_actions.csv")
        firsts = {}
        for code, row in read_filled(f).items():
            true_id, is_dup = key[code]
            lab = (row.get("verdict_EXECUTE_or_REFUSE") or "").strip().upper()
            if lab not in ACT_VALID:
                continue
            if is_dup:
                pass  # paired in the second pass below
            else:
                votes[true_id][ann] = lab
                firsts[true_id] = lab
        for code, row in read_filled(f).items():
            true_id, is_dup = key[code]
            lab = (row.get("verdict_EXECUTE_or_REFUSE") or "").strip().upper()
            if is_dup and lab in ACT_VALID and true_id in firsts:
                dup_pairs[ann].append((firsts[true_id], lab))

    lines = ["", "## Part B — action verdicts", "",
             f"Sheets received: {', '.join(present) or 'none'}"]
    counts = [Counter(v.values()) for v in votes.values() if v]
    k2, n = fleiss_kappa(counts, ACT_VALID)
    lines.append(f"- Fleiss κ (EXECUTE/REFUSE): {k2:.3f} over {n} actions")
    for ann in present:
        pairs = dup_pairs.get(ann, [])
        same = sum(1 for a, b in pairs if a == b)
        lines.append(f"- Intra-rater {ann}: {same}/{len(pairs)} identical")

    dis = []
    agree = total = 0
    for i, v in sorted(votes.items()):
        if len(v) < 3:
            continue
        total += 1
        maj, nvote = Counter(v.values()).most_common(1)[0]
        if nvote <= len(v) / 2:
            maj = "NO_MAJORITY"
        exp = author[i]["expected_verdict"].upper()
        exp = "EXECUTE" if exp == "EXECUTE" else "REFUSE"
        if maj == exp:
            agree += 1
        else:
            dis.append([i, author[i]["category"], exp, maj,
                        "/".join(f"{a}:{l}" for a, l in sorted(v.items())),
                        author[i]["instruction"][:120]])
    if total:
        lines.append(f"- Majority vs expected_verdict: {agree}/{total} = {agree/total:.1%}")
    with open(results_dir / "disagreements_actions.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["action_id", "category", "expected_verdict",
                    "annotator_majority", "votes", "instruction_head"])
        w.writerows(dis)
    lines.append(f"- Disagreements written: {len(dis)} (disagreements_actions.csv)")
    return lines


def score_qa(filled_dir, keys_dir, results_dir, author_path):
    author = {int(r["question_id"]): r for r in csv.DictReader(open(author_path))}
    votes = defaultdict(dict)
    dup_pairs = defaultdict(list)
    present = []
    for ann in ANNOTATORS:
        f = filled_dir / f"annotator_{ann}_qa.csv"
        if not f.exists():
            continue
        present.append(ann)
        key = read_key(keys_dir / f"key_{ann}_qa.csv")
        firsts = {}
        for code, row in read_filled(f).items():
            true_id, is_dup = key[code]
            lab = (row.get("judgment_SHARE_PROTECT_BORDERLINE") or "").strip().upper()
            if lab not in QA_VALID:
                continue
            if not is_dup:
                votes[true_id][ann] = lab
                firsts[true_id] = lab
        for code, row in read_filled(f).items():
            true_id, is_dup = key[code]
            lab = (row.get("judgment_SHARE_PROTECT_BORDERLINE") or "").strip().upper()
            if is_dup and lab in QA_VALID and true_id in firsts:
                dup_pairs[ann].append((firsts[true_id], lab))

    lines = ["", "## Part C — QA share/protect (the 300/300 design split)", "",
             f"Sheets received: {', '.join(present) or 'none'}"]
    counts = [Counter(v.values()) for v in votes.values() if v]
    counts_bin = [Counter("PROTECT" if x != "SHARE" else "SHARE" for x in v.values())
                  for v in votes.values() if v]
    k3, n = fleiss_kappa(counts, QA_VALID)
    k2, _ = fleiss_kappa(counts_bin, {"SHARE", "PROTECT"})
    lines.append(f"- Fleiss κ: {k3:.3f} (3-way) / {k2:.3f} (SHARE vs rest) over {n} questions")
    for ann in present:
        pairs = dup_pairs.get(ann, [])
        same = sum(1 for a, b in pairs if a == b)
        lines.append(f"- Intra-rater {ann}: {same}/{len(pairs)} identical")

    dis = []
    agree = total = borderline_maj = 0
    cat_stat = defaultdict(lambda: [0, 0])
    for i, v in sorted(votes.items()):
        if len(v) < 3:
            continue
        maj, nvote = Counter(v.values()).most_common(1)[0]
        if nvote <= len(v) / 2:
            maj = "NO_MAJORITY"
        if maj == "BORDERLINE":
            borderline_maj += 1
            continue  # counted separately, not as agreement or disagreement
        total += 1
        au = author[i]["author_label"]
        cat = author[i]["category"]
        cat_stat[cat][1] += 1
        if maj == au:
            agree += 1
            cat_stat[cat][0] += 1
        else:
            dis.append([i, cat, au, maj,
                        "/".join(f"{a}:{l}" for a, l in sorted(v.items())),
                        author[i]["question"][:120]])
    if total:
        lines.append(f"- Majority vs author split: {agree}/{total} = {agree/total:.1%} "
                     f"(borderline-majority questions counted separately: {borderline_maj})")
        lines += ["", "| Category | agree | total | rate |", "|---|---|---|---|"]
        for cat, (a, t) in sorted(cat_stat.items()):
            lines.append(f"| {cat} | {a} | {t} | {a/t:.1%} |")
    with open(results_dir / "disagreements_qa.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["question_id", "category", "author_label",
                    "annotator_majority", "votes", "question_head"])
        w.writerows(dis)
    lines.append(f"- Disagreements written: {len(dis)} (disagreements_qa.csv)")
    return lines


def selftest():
    """Simulate filled sheets (author label + 12% noise) to verify the pipeline."""
    rng = random.Random(7)
    tmp = HERE / "selftest_filled"
    tmp.mkdir(exist_ok=True)
    author = {int(r["question_id"]): r for r in
              csv.DictReader(open(HERE / "keys/author_labels_relationship.csv"))}
    act_author = {int(r["action_id"]): r for r in
                  csv.DictReader(open(HERE / "keys/author_labels_actions.csv"))}
    for ann in ANNOTATORS:
        key = read_key(HERE / f"keys/key_{ann}_relationship.csv")
        rows_in = list(csv.DictReader(open(HERE / f"sheets/annotator_{ann}_relationship.csv")))
        with open(tmp / f"annotator_{ann}_relationship.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows_in[0].keys())
            w.writeheader()
            for r in rows_in:
                tid, _ = key[r["row_code"]]
                for col in REL_COLS:
                    lab = author[tid][REL_SHORT[col]]
                    r[col] = rng.choice(sorted(REL_VALID)) if rng.random() < 0.12 else lab
                w.writerow(r)
        akey = read_key(HERE / f"keys/key_{ann}_actions.csv")
        arows = list(csv.DictReader(open(HERE / f"sheets/annotator_{ann}_actions.csv")))
        with open(tmp / f"annotator_{ann}_actions.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=arows[0].keys())
            w.writeheader()
            for r in arows:
                tid, _ = akey[r["row_code"]]
                lab = act_author[tid]["expected_verdict"].upper()
                if rng.random() < 0.08:
                    lab = "REFUSE" if lab == "EXECUTE" else "EXECUTE"
                r["verdict_EXECUTE_or_REFUSE"] = lab
                w.writerow(r)
        qa_author = {int(r["question_id"]): r for r in
                     csv.DictReader(open(HERE / "keys/author_labels_qa.csv"))}
        qkey = read_key(HERE / f"keys/key_{ann}_qa.csv")
        qrows = list(csv.DictReader(open(HERE / f"sheets/annotator_{ann}_qa.csv")))
        with open(tmp / f"annotator_{ann}_qa.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=qrows[0].keys())
            w.writeheader()
            for r in qrows:
                tid, _ = qkey[r["row_code"]]
                lab = qa_author[tid]["author_label"]
                if rng.random() < 0.10:
                    lab = rng.choice(sorted(QA_VALID))
                r["judgment_SHARE_PROTECT_BORDERLINE"] = lab
                w.writerow(r)
    return tmp


def main():
    filled = HERE / "filled"
    if "--selftest" in sys.argv:
        filled = selftest()
        print("selftest: simulated sheets in", filled.name)
    results = HERE / "results"
    results.mkdir(exist_ok=True)
    lines = ["# PACT-Pair non-author annotation audit — results", ""]
    lines += score_relationship(filled, HERE / "keys", results,
                                HERE / "keys/author_labels_relationship.csv")
    lines += score_actions(filled, HERE / "keys", results,
                           HERE / "keys/author_labels_actions.csv")
    lines += score_qa(filled, HERE / "keys", results,
                      HERE / "keys/author_labels_qa.csv")
    (results / "agreement_report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("\nreport: rebuttal/annotation/results/agreement_report.md")


if __name__ == "__main__":
    main()
