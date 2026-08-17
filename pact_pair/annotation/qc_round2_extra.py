#!/usr/bin/env python3
"""Round-2 acceptance checks that annotation_qc.py does not cover.

Implements the remaining items of annotation_acceptance_plan_zh.md:
  - stage 1 leftovers: relationship P-rate monotonicity, note_optional audit
  - stage 2: plagiarism fingerprints (vs-gold similarity, 15 gold-conflict
    items, 39 most-subjective gold B cells), pairwise identity
  - stage 3 leftovers: per-annotator vs-gold rates, cross-file consistency,
    Fleiss kappa variants (with/without D, with/without B),
    majority-vs-gold adjudication CSV export
  - A-specific rework acceptance (104 cells, outbox/A_rework_rows.txt)

Run from repo root:
  python3 pact_pair/annotation/qc_round2_extra.py <A_dir> <B_dir> <C_dir> <D_dir> <E_dir>

Ordering of folders does not matter; letters are inferred from file names.
Stdlib only.
"""

import csv, itertools, json, os, re, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from annotation_qc import TASKS, VOCAB_ALIASES, fleiss_kappa, find_annotator_files

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))  # repo root

norm = lambda s: re.sub(r"\s+", " ", s.strip().lower())
REL_COLS = ["R0_stranger", "R1_colleague", "R2_ceo_delegate", "R3_close_friend", "R4_investor"]
GCOL = dict(zip(REL_COLS, ["R0", "R1", "R2", "R3", "R4"]))

# QA gold mapping = category track with the 4 audit exceptions (same as _review_D/compare.py)
EXC = {125: "work_public", 214: "sensitive_work", 347: "sensitive_work", 351: "work_public"}
qa_lab = lambda c: "SHARE" if c == "work_public" else "PROTECT"

# The 15 QA-gold vs matrix-R1 conflicts (gold_conflict_15_items_zh.md).
CONFLICT_IDS = [121, 122, 130, 163, 164, 173,          # QA gold PROTECT vs R1 SHARE(L)
                103, 105, 118, 119, 123, 129, 160, 176, 179]  # QA gold PROTECT vs R1 BORDERLINE(B)

# ------------------------------------------------------------------ load gold

with open(os.path.join(ROOT, "pact_pair/tasks/questions.json")) as f:
    Q = json.load(f)
with open(os.path.join(ROOT, "pact_pair/relationship_labels/relationship_label_matrix.json")) as f:
    MATRIX = json.load(f)["labels"]

qa_gold = {}          # (topic, question) -> SHARE/PROTECT
qa_gold_by_q = {}     # question -> SHARE/PROTECT
for x in Q["questions"]:
    lab = qa_lab(EXC.get(x["id"], x["category"]))
    qa_gold[(norm(x["topic"]), norm(x["question"]))] = lab
    qa_gold_by_q[norm(x["question"])] = lab
act_gold = {norm(a["instruction"]): a["expected_verdict"].upper() for a in Q["actions"]}
rel_gold = {norm(x["question"]): x for x in MATRIX}

gold_b_cells = [(norm(x["question"]), col) for x in MATRIX for col in REL_COLS if x[GCOL[col]] == "B"]
conflict_items = {c["id"]: c for c in MATRIX if c["id"] in CONFLICT_IDS}
assert len(conflict_items) == 15, sorted(conflict_items)

# ------------------------------------------------------------ load annotators

def load(folder):
    letter, paths = find_annotator_files(folder)
    out = {}
    for task, path in paths.items():
        if path is None:
            out[task] = None
            continue
        with open(path, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        # tolerate A's renamed judgment header
        for r in rows:
            for k in list(r):
                if k and k.startswith("judgment_") and k != "judgment_SHARE_PROTECT_BORDERLINE":
                    r["judgment_SHARE_PROTECT_BORDERLINE"] = r.pop(k)
        aliases = VOCAB_ALIASES.get(task, {})
        for r in rows:
            for col in TASKS[task]["label_cols"]:
                v = (r.get(col) or "").strip()
                r[col] = aliases.get(v, v)
        out[task] = rows
    return letter, out

DATA = {}
for folder in sys.argv[1:]:
    letter, tasks = load(folder)
    DATA[letter] = tasks
LETTERS = sorted(DATA)

def uniq_qa(rows):    # question -> label (first occurrence)
    out = {}
    for r in rows:
        out.setdefault(norm(r["question"]), r["judgment_SHARE_PROTECT_BORDERLINE"])
    return out

def uniq_act(rows):
    out = {}
    for r in rows:
        out.setdefault(norm(r["request"]), r["verdict_EXECUTE_or_REFUSE"])
    return out

def uniq_rel(rows):   # question -> {col: label}
    out = {}
    for r in rows:
        out.setdefault(norm(r["question"]), {c: r[c] for c in REL_COLS})
    return out

U = {lt: {"qa": uniq_qa(d["qa"]), "actions": uniq_act(d["actions"]), "relationship": uniq_rel(d["relationship"])}
     for lt, d in DATA.items()}

# ------------------------------------------------- 1. vs-gold agreement (fingerprint 1)

print("=== vs-gold agreement per file (fingerprint 1: flag any file > 95%)")
print(f"{'':3}{'REL(495 cells)':>16}{'ACT(200)':>10}{'QA(400)':>9}   flags")
for lt in LETTERS:
    rel_hit = rel_tot = 0
    for q, cells in U[lt]["relationship"].items():
        g = rel_gold.get(q)
        if not g:
            continue
        for col in REL_COLS:
            rel_tot += 1
            rel_hit += cells[col] == g[GCOL[col]]
    act_hit = sum(v == act_gold.get(k) for k, v in U[lt]["actions"].items())
    act_tot = sum(k in act_gold for k in U[lt]["actions"])
    qa_hit = sum(v == qa_gold_by_q.get(k) for k, v in U[lt]["qa"].items())
    qa_tot = sum(k in qa_gold_by_q for k in U[lt]["qa"])
    pr, pa, pq = 100 * rel_hit / rel_tot, 100 * act_hit / act_tot, 100 * qa_hit / qa_tot
    flags = [f"{n}>95%" for n, p in [("REL", pr), ("ACT", pa), ("QA", pq)] if p > 95]
    print(f"{lt:3}{pr:15.1f}%{pa:9.1f}%{pq:8.1f}%   {' '.join(flags) or '-'}"
          + (f"   (matched {rel_tot}/495, {act_tot}/200, {qa_tot}/400)" if min(rel_tot, act_tot, qa_tot) < 200 else ""))

# --------------------------------- 2. fingerprint 2: 15 gold-internal-conflict items

print("\n=== Fingerprint 2: 15 gold-conflict items (QA=PROTECT AND rel R1 == matrix R1; >=10/15 strong evidence)")
for lt in LETTERS:
    both = qa_side = rel_side = 0
    for cid, item in sorted(conflict_items.items()):
        q = norm(item["question"])
        qa_v = U[lt]["qa"].get(q)
        rel_v = U[lt]["relationship"].get(q, {}).get("R1_colleague")
        m_qa = qa_v == "PROTECT"           # QA-gold side of the contradiction
        m_rel = rel_v == item["R1"]        # matrix side (L or B)
        qa_side += m_qa
        rel_side += m_rel
        both += m_qa and m_rel
    tag = "  <-- STRONG PLAGIARISM SIGNAL" if both >= 10 else ""
    print(f"  {lt}: reproduced both sides on {both}/15 (QA side {qa_side}/15, matrix side {rel_side}/15){tag}")

# --------------------------------------- 3. fingerprint 3: 39 gold B cells hit rate

print("\n=== Fingerprint 3: 39 most-subjective gold B cells (round-1 honest range 13-18%; >60% strong evidence)")
for lt in LETTERS:
    hits = sum(U[lt]["relationship"].get(q, {}).get(col) == "B" for q, col in gold_b_cells)
    pct = 100 * hits / len(gold_b_cells)
    tag = "  <-- STRONG PLAGIARISM SIGNAL" if pct > 60 else ""
    print(f"  {lt}: {hits}/39 ({pct:.0f}%){tag}")

# ------------------------------------------------------- 4. pairwise identity screen

print("\n=== Pairwise identity across all 1095 unique decisions (flag > 98%)")
def decisions(lt):
    out = {}
    for q, v in U[lt]["qa"].items():
        out[("qa", q)] = v
    for k, v in U[lt]["actions"].items():
        out[("act", k)] = v
    for q, cells in U[lt]["relationship"].items():
        for col in REL_COLS:
            out[("rel", q, col)] = cells[col]
    return out
DEC = {lt: decisions(lt) for lt in LETTERS}
common = set.intersection(*(set(d) for d in DEC.values()))
for a, b in itertools.combinations(LETTERS, 2):
    same = sum(DEC[a][k] == DEC[b][k] for k in common)
    pct = 100 * same / len(common)
    print(f"  {a}-{b}: {pct:5.1f}%{'  <-- REVIEW' if pct > 98 else ''}")

# --------------------------------------------- 5. relationship P-rate monotonicity

print("\n=== Relationship P-rate by tier (plan: closer tier must not be MORE protective than colleague/stranger)")
gold_p = {col: 100 * sum(x[GCOL[col]] == "P" for x in MATRIX) / len(MATRIX) for col in REL_COLS}
print("  gold: " + "  ".join(f"{c.split('_', 1)[1]} {gold_p[c]:.0f}%" for c in REL_COLS))
for lt in LETTERS:
    rows = DATA[lt]["relationship"]
    p = {col: 100 * sum(r[col] == "P" for r in rows) / len(rows) for col in REL_COLS}
    inv = []
    if p["R3_close_friend"] >= p["R1_colleague"]:
        inv.append("close_friend >= colleague")
    if p["R3_close_friend"] >= p["R0_stranger"]:
        inv.append("close_friend >= stranger")
    if p["R1_colleague"] > p["R0_stranger"]:
        inv.append("colleague > stranger")
    print(f"  {lt}:   " + "  ".join(f"{c.split('_', 1)[1]} {p[c]:.0f}%" for c in REL_COLS)
          + ("   INVERSION: " + "; ".join(inv) if inv else ""))

# ------------------------------------------------------------- 6. note_optional audit

print("\n=== note_optional audit (non-empty / distinct; top values)")
for lt in LETTERS:
    for task in ["qa", "actions", "relationship"]:
        notes = [(r.get("note_optional") or "").strip() for r in DATA[lt][task]]
        ne = [x for x in notes if x]
        if not ne:
            continue
        cnt = Counter(ne)
        top = "; ".join(f"{v!r} x{n}" for v, n in cnt.most_common(3))
        codes_only = all(set(x.split(";")) <= {"N", "C"} for x in ne)
        print(f"  {lt}/{task}: {len(ne)}/{len(notes)} non-empty, {len(cnt)} distinct"
              + (" [codes N/C only]" if codes_only else "") + f" | {top[:150]}")

# --------------------------------------------------- 7. cross-file self-consistency

print("\n=== Cross-file consistency: QA label vs rel R1 (mapped P->PROTECT/L->SHARE/B->BORDERLINE) on the 99 shared questions")
r1map = {"P": "PROTECT", "L": "SHARE", "B": "BORDERLINE"}
base = sum(qa_gold_by_q[q] == r1map[g["R1"]] for q, g in rel_gold.items()) / len(rel_gold)
print(f"  gold's own baseline: {100 * base:.1f}%")
for lt in LETTERS:
    tot = hit = 0
    for q, g in rel_gold.items():
        qa_v, rel_v = U[lt]["qa"].get(q), U[lt]["relationship"].get(q, {}).get("R1_colleague")
        if qa_v and rel_v:
            tot += 1
            hit += qa_v == r1map[rel_v]
    print(f"  {lt}: {100 * hit / tot:.1f}% ({hit}/{tot})")

# --------------------------------------------------------------- 8. kappa variants

print("\n=== Fleiss kappa variants (decision, pending B fingerprints + D independence ruling)")
def kappa_for(letters):
    subset = set.intersection(*(set(DEC[lt]) for lt in letters))
    out = {}
    for task in ["qa", "act", "rel"]:
        keys = [k for k in subset if k[0] == task]
        matrix = [Counter(DEC[lt][k] for lt in letters) for k in keys]
        out[task] = (fleiss_kappa(matrix), len(keys))
    return out
variants = [tuple(LETTERS),
            tuple(lt for lt in LETTERS if lt != "D"),
            tuple(lt for lt in LETTERS if lt != "B"),
            tuple(lt for lt in LETTERS if lt not in "BD")]
print(f"{'raters':16}{'QA':>8}{'ACT':>8}{'REL':>8}")
for vs in variants:
    ks = kappa_for(vs)
    print(f"  {'+'.join(vs):14}" + "".join(f"{ks[t][0]:8.3f}" for t in ["qa", "act", "rel"]))

# ------------------------------------------- 9. majority-vs-gold adjudication export

GOLD = {}
for q, v in qa_gold_by_q.items():
    GOLD[("qa", q)] = v
for k, v in act_gold.items():
    GOLD[("act", k)] = v
for q, g in rel_gold.items():
    for col in REL_COLS:
        GOLD[("rel", q, col)] = g[GCOL[col]]

out_csv = os.path.join(HERE, "qc_reports", "round2_majority_vs_gold.csv")
n_out = ties = 0
with open(out_csv, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["task", "item", "column", "gold"] + [f"label_{lt}" for lt in LETTERS]
               + ["majority", "votes", "is_tie", "adjudication_note"])
    for k in sorted(common, key=lambda x: (x[0], x[1])):
        if k not in GOLD:
            continue
        cnt = Counter(DEC[lt][k] for lt in LETTERS).most_common()
        top, top_n = cnt[0]
        tie = len(cnt) > 1 and cnt[1][1] == top_n
        if top == GOLD[k] and not tie:
            continue
        n_out += 1
        ties += tie
        w.writerow([k[0], k[1][:90], k[2] if len(k) > 2 else "", GOLD[k]]
                   + [DEC[lt][k] for lt in LETTERS]
                   + [top, f"{top_n}/{len(LETTERS)}", "YES" if tie else "", ""])
print(f"\nWrote {n_out} majority!=gold rows ({ties} ties) to {out_csv}")

# ------------------------------------------------------------- 10. A rework check

rework = [l.strip() for l in open(os.path.join(HERE, "outbox", "A_rework_rows.txt"))
          if l.strip() and not l.startswith("#")]
redecide, blanks = set(rework[:102]), set(rework[102:])
if "A" in DATA:
    rows = {r["row_code"]: r for r in DATA["A"]["qa"]}
    still_b = [c for c in redecide if rows[c]["judgment_SHARE_PROTECT_BORDERLINE"] == "BORDERLINE"]
    blank_now = [c for c in blanks if not rows[c]["judgment_SHARE_PROTECT_BORDERLINE"]]
    b_outside = [c for c, r in rows.items()
                 if r["judgment_SHARE_PROTECT_BORDERLINE"] == "BORDERLINE" and c not in redecide]
    n_b = sum(r["judgment_SHARE_PROTECT_BORDERLINE"] == "BORDERLINE" for r in rows.values())
    print(f"\n=== A rework acceptance ({len(redecide)} re-decide + {len(blanks)} blanks)")
    print(f"  still BORDERLINE among the 102: {len(still_b)} {still_b[:10]}")
    print(f"  still blank among {sorted(blanks)}: {blank_now or 'none'}")
    print(f"  BORDERLINE outside the list (= edit outside allowed cells): {b_outside or 'none'}")
    print(f"  residual BORDERLINE total: {n_b}/420 ({100 * n_b / 420:.1f}%, threshold <=10%)")
