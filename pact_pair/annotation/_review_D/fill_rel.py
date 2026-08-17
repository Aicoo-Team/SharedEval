import csv

CODES = """PPLPP PPPLP PPPLP PPPLP PPPPP PPPPP PPPPP PPLPP PPPLP PPPLP
PBBLP PPPLP PPPLP PPPLP PPLPP PPLPL PPPPP PLLPB PPPPP PPPLP
PPPLP PPPLP PPLPL PPPLP PPPLP PLLPL PPPLP PPPLP PPPLP PPPLP
PPPPP PBLPL PPPLP PPPLP PPLPP PPPLP PPPPP PPPLP PPPPP PBPLP
PPPPP PBPLP PPPLP PPPLP PPBPP PBLPP PBLPL PPPLP PPLPP PBLPP
PPPLP PPPLP PPLPP PPLPL PLLPL PPPPP PPBPP PPPLP PPLPP PPPLP
PPPLP PPPLP PBLPL PPPLP PPPLP PPPPP PPPLP PPPLP PPPLP PPPPP
PPPLP PPLPP PPPLP PPPPP PPPLP PPPLP PBLPL PPPLP PPPLP PPPLP
PPLPP PPPPP PPPPP PPLPP PPPLP PPPLP PPLPB PPLPL PPPPP PPPPP
PPPLP PPPLP PPPPP PPLPL PPPLP PPPPP PPPLP PPPPP PPBPP PPPLP
PPPLP PPPPP PPLPL PPLPP PPPLP PPLPB PPPLP PPPLP PPPLP""".split()

# rows flagged low-confidence
NROWS = {11,13,16,18,23,31,32,40,42,44,45,46,47,50,54,55,57,63,69,77,79,87,88,
         99,102,103,106}

assert len(CODES) == 109, len(CODES)

src = "pact_pair/annotation/submissions/PACT_annotation_D_Hanxiang/annotator_D_relationship.csv"
with open(src, newline="") as f:
    rows = list(csv.reader(f))

header, body = rows[0], rows[1:]
assert len(body) == 109

for i, r in enumerate(body):
    n = int(r[0].split("-")[1])
    assert n == i + 1, (n, i)
    r[3:8] = list(CODES[i])
    r[8] = "N" if n in NROWS else ""

with open(src, "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(header)
    w.writerows(body)

flat = "".join(CODES)
print("cells", len(flat), "B", flat.count("B"), "L", flat.count("L"), "P", flat.count("P"))
print("N rows", len(NROWS))
