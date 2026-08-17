import json, csv, re, collections

norm = lambda s: re.sub(r"\s+", " ", s.strip().lower())
D = "pact_pair/annotation/submissions/PACT_annotation_D_Hanxiang/"
report = []


def write(path, rows, header):
    with open(path, "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows([[r[h] for h in header] for r in rows])


def note(r, conflict):
    n = r["note_optional"]
    has_n = n == "N"
    r["note_optional"] = ("N;C" if has_n else "C") if conflict else n


# ---------------- Part A: relationship ----------------
gt = {norm(x["question"]): x for x in
      json.load(open("pact_pair/relationship_labels/relationship_label_matrix.json"))["labels"]}
COLS = [("R0_stranger", "R0"), ("R1_colleague", "R1"), ("R2_ceo_delegate", "R2"),
        ("R3_close_friend", "R3"), ("R4_investor", "R4")]
rows = list(csv.DictReader(open(D + "annotator_D_relationship.csv")))
hdr = list(rows[0])
cell_tot = cell_bad = 0
bad_soft = 0
percol = collections.Counter()
confmat = collections.Counter()
for r in rows:
    g = gt[norm(r["question"])]
    diffs = []
    for mine_col, gcol in COLS:
        cell_tot += 1
        mine, theirs = r[mine_col], g[gcol]
        confmat[(mine, theirs)] += 1
        if mine != theirs:
            cell_bad += 1
            percol[mine_col] += 1
            diffs.append(f"{gcol}:me={mine}/gt={theirs}")
            if "B" in (mine, theirs):
                bad_soft += 1
    note(r, bool(diffs))
    if diffs:
        report.append(("REL", r["row_code"], r["question"][:58], "; ".join(diffs)))
write(D + "annotator_D_relationship.csv", rows, hdr)
rel_rows_bad = sum(1 for r in rows if "C" in r["note_optional"])
print(f"REL  cells {cell_tot}  mismatch {cell_bad} ({100*cell_bad/cell_tot:.1f}%)  "
      f"agree {100*(cell_tot-cell_bad)/cell_tot:.1f}%  | rows flagged C {rel_rows_bad}/109")
print(f"     of those mismatches, {bad_soft} involve a B on one side (uncounted in scoring)")
print("     per-requester mismatches:", dict(percol))
print("     confusion (me,gt):", dict(sorted(confmat.items())))

# ---------------- Part B: actions ----------------
acts = json.load(open("pact_pair/tasks/questions.json"))["actions"]
ga = {norm(a["instruction"]): a for a in acts}
rows = list(csv.DictReader(open(D + "annotator_D_actions.csv")))
hdr = list(rows[0])
bad = 0
bycat = collections.Counter()
cm = collections.Counter()
for r in rows:
    g = ga[norm(r["request"])]
    theirs = g["expected_verdict"].upper()
    mine = r["verdict_EXECUTE_or_REFUSE"]
    cm[(mine, theirs)] += 1
    diff = mine != theirs
    note(r, diff)
    if diff:
        bad += 1
        bycat[g["category"]] += 1
        report.append(("ACT", r["row_code"], g["category"], f"me={mine}/gt={theirs}"))
write(D + "annotator_D_actions.csv", rows, hdr)
print(f"\nACT  rows 210  mismatch {bad} ({100*bad/210:.1f}%)  agree {100*(210-bad)/210:.1f}%")
print("     by gt category:", dict(bycat))
print("     confusion (me,gt):", dict(sorted(cm.items())))

# ---------------- Part C: qa ----------------
q = json.load(open("pact_pair/tasks/questions.json"))
EXC = {125: "work_public", 214: "sensitive_work", 347: "sensitive_work", 351: "work_public"}
cat = {}
for x in q["questions"]:
    cat[(norm(x["topic"]), norm(x["question"]))] = EXC.get(x["id"], x["category"])
lab = lambda c: "SHARE" if c == "work_public" else "PROTECT"
rows = list(csv.DictReader(open(D + "annotator_D_qa.csv")))
hdr = list(rows[0])
bad = 0
cm = collections.Counter()
bycat = collections.Counter()
for r in rows:
    c = cat[(norm(r["topic"]), norm(r["question"]))]
    theirs = lab(c)
    mine = r["judgment_SHARE_PROTECT_BORDERLINE"]
    cm[(mine, theirs)] += 1
    diff = mine != theirs
    note(r, diff)
    if diff:
        bad += 1
        bycat[c] += 1
        report.append(("QA", r["row_code"], r["question"][:58], f"me={mine}/gt={theirs}"))
write(D + "annotator_D_qa.csv", rows, hdr)
nb = sum(1 for r in rows if r["judgment_SHARE_PROTECT_BORDERLINE"] == "BORDERLINE")
print(f"\nQA   rows 420  mismatch {bad} ({100*bad/420:.1f}%)  agree {100*(420-bad)/420:.1f}%")
print(f"     ({nb} of my rows are BORDERLINE; gt has no BORDERLINE class, so all count as mismatch)")
print("     by gt category:", dict(bycat))
print("     confusion (me,gt):", dict(sorted(cm.items())))

with open("pact_pair/annotation/_review_D/conflicts.txt", "w") as f:
    for t in report:
        f.write(" | ".join(t) + "\n")
print("\ntotal conflict lines:", len(report))
