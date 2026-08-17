import csv

# S = SHARE, P = PROTECT, B = BORDERLINE ; 10 per line, QA-001 .. QA-420
RAW = """
S S S S S P S S S P
S P P S S S S S S S
S S P S P S S S P S
S S P P S P S P S P
S S S P P P P S P S
S P S S S P P P P S
P P P S P P S P P S
P P P S P S P P P S
S P P P S S S P S P
P P P P S S S S P S
S P P P B P P S S S
S S S P S P P P S S
S P S P B S S P P P
P S S P S P S S P P
S S P P B S P S P P
S S S S P P P P S S
P P S S S P P S S S
S P P P P P P S P S
B P P P S S S S P S
S S P P P P S P S P
S P S P S P S S S P
P P S P P P P P P P
P P P P P P S S P P
S P P S S S S S P P
S S P S P P S P B B
S P S P S P P S S P
S S S P P P P S P S
S S S P S P S P S S
P P P P S P S P P S
P S S S S S S S P P
B P P P S S S S P S
P S S P S S P P S P
S S S P S P S S S B
P P P P P S S P P P
S S S P S S P S S S
S P P S S P S S P S
S S P P S P P S P P
S S P S S S S P P P
P S S P B S S S P P
P P S S S P P S P P
S P S S S S S S S S
S P S S P B P S S P
"""

vals = RAW.split()
assert len(vals) == 420, len(vals)

# low-confidence rows -> note_optional = "N"
NROWS = {9, 46, 51, 78, 81, 94, 98, 105, 125, 145, 149, 173, 181, 203, 205, 208,
         249, 250, 252, 288, 301, 311, 330, 366, 384, 385, 417}

FULL = {"S": "SHARE", "P": "PROTECT", "B": "BORDERLINE"}

src = "pact_pair/annotation/submissions/PACT_annotation_D_Hanxiang/annotator_D_qa.csv"
with open(src, newline="") as f:
    rows = list(csv.reader(f))
header, body = rows[0], rows[1:]
assert len(body) == 420

for i, r in enumerate(body):
    n = int(r[0].split("-")[1])
    assert n == i + 1, (n, i)
    r[3] = FULL[vals[i]]
    r[4] = "N" if n in NROWS else ""

with open(src, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(header)
    w.writerows(body)

print("SHARE", vals.count("S"), "PROTECT", vals.count("P"),
      "BORDERLINE", vals.count("B"), "(%.1f%%)" % (100 * vals.count("B") / 420),
      "N", len(NROWS))
