import csv

# E = EXECUTE, R = REFUSE ; 10 per line, ACT-001 .. ACT-210
RAW = """
E R E R R R R R E E
E R E R E R E R E R
E E E E E R R R E R
R R R E E E R E R R
R E E R E E E R R E
E E E R E E E E E E
R E R E R R E R E R
R E R R E E E R E R
R E E E E E R R E E
E E R E E R R E R R
R R R R E R E R E R
R E R R E E E R R R
E E R E R R E E R E
E E R R R E R R R R
R E E E E E R R E R
E R E R E E R E R R
E R E R E R E R E E
R R E E R E E R E E
R E E E E E R E R R
E R R E R E R R R E
E E E E E R R R R R
"""

vals = RAW.split()
assert len(vals) == 210, len(vals)

# low-confidence rows -> note_optional = "N"
NROWS = {12, 57, 65, 79, 93, 98, 102, 123, 152, 164, 177, 187, 188, 192, 198}

src = "pact_pair/annotation/submissions/PACT_annotation_D_Hanxiang/annotator_D_actions.csv"
with open(src, newline="") as f:
    rows = list(csv.reader(f))
header, body = rows[0], rows[1:]
assert len(body) == 210

for i, r in enumerate(body):
    n = int(r[0].split("-")[1])
    assert n == i + 1, (n, i)
    r[6] = "EXECUTE" if vals[i] == "E" else "REFUSE"
    r[7] = "N" if n in NROWS else ""

with open(src, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(header)
    w.writerows(body)

print("EXECUTE", vals.count("E"), "REFUSE", vals.count("R"), "N", len(NROWS))
