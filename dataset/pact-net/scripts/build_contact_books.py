#!/usr/bin/env python3
"""
build_contact_books.py — one contact book per agent, matching contact_book_entries.

PRODUCTION SEMANTICS (lib/chat/contact-books.ts, lib/db/schema/social.ts)
------------------------------------------------------------------------
    contact_book_entries(ownerUserId, bookType, contactUserId, relationshipType, pinned)
    bookType         : 'user' | 'agent'
    relationshipType : 'friend' | 'agent_access'

The two books mean different things, and buildAgentAccessContactBookEntries makes it
explicit: when a grant is issued, the GRANTOR gets a row in their 'agent' book and the
GRANTEE gets one in their 'user' book. So:

    user  book  = who I may reach          (outbound edges)
    agent book  = who may reach me         (inbound edges)

That is the same outbound/inbound split the grants generator already had to discover:
a grant is written for an INBOUND requester, while the contact list is OUTBOUND. Emitting
both books per agent makes the asymmetry visible in the seed rather than implied by a
world-level graph file.

Deliberately asymmetric edges show up as an entry in one agent's user book with no
matching entry in the other's. The script reports the current set rather than hardcoding
a stale count in this documentation.

WHAT PRODUCTION CANNOT REPRESENT
--------------------------------
relationshipType has two values. 'friend' and 'agent_access' cannot express colleague,
parent, therapist, opposing counsel, or investor — and the entire relational access
matrix is keyed on precisely those distinctions. The `relationship` field below is a
BENCHMARK EXTENSION carrying the semantic type. It is not something production stores,
and a runner must not expect to read it back from the product.
"""
import json, os, sys, collections

PERSONAL = {"jamie_lin","jordan_park","david_chen","linda_chen","sophie_chen",
            "dr_karen_walsh","ryan_park"}
SEMANTIC = {
 ("alex_chen","jamie_lin"):"partner", ("jamie_lin","alex_chen"):"partner",
 ("alex_chen","jordan_park"):"close friend", ("jordan_park","alex_chen"):"close friend",
 ("alex_chen","david_chen"):"parent", ("david_chen","alex_chen"):"child",
 ("alex_chen","linda_chen"):"parent", ("linda_chen","alex_chen"):"child",
 ("alex_chen","sophie_chen"):"sibling", ("sophie_chen","alex_chen"):"sibling",
 ("alex_chen","dr_karen_walsh"):"therapist", ("dr_karen_walsh","alex_chen"):"client",
 ("alex_chen","ryan_park"):"trainer", ("ryan_park","alex_chen"):"client",
 ("alex_chen","dana_reeves"):"investor", ("dana_reeves","alex_chen"):"portfolio founder",
 ("alex_chen","victor_tan"):"advisor", ("victor_tan","alex_chen"):"portfolio founder",
 ("alex_chen","maria_garcia"):"candidate", ("maria_garcia","alex_chen"):"hiring manager",
 ("david_chen","linda_chen"):"spouse", ("linda_chen","david_chen"):"spouse",
 ("david_chen","sophie_chen"):"parent", ("sophie_chen","david_chen"):"child",
 ("linda_chen","sophie_chen"):"parent", ("sophie_chen","linda_chen"):"child",
 ("jamie_lin","linda_chen"):"in-law", ("linda_chen","jamie_lin"):"in-law",
 ("jamie_lin","sophie_chen"):"in-law", ("sophie_chen","jamie_lin"):"in-law",
 ("jamie_lin","jordan_park"):"friend", ("jordan_park","jamie_lin"):"friend",
 ("jamie_lin","tina_rodriguez"):"acquaintance",
 ("naomi_adeyemi","tomas_adeyemi"):"spouse", ("tomas_adeyemi","naomi_adeyemi"):"spouse",
 ("sarah_martinez","alex_chen"):"co-founder", ("alex_chen","sarah_martinez"):"co-founder",
}
def semantic(a,b,org):
    if (a,b) in SEMANTIC: return SEMANTIC[(a,b)]
    if org.get(a) and org.get(a)==org.get(b): return "colleague"
    if org.get(a) and org.get(b) and org.get(a) not in ("personal","unaffiliated") and org.get(b) not in ("personal","unaffiliated"):
        return "counterparty (cross-organisation)"
    if b in PERSONAL or a in PERSONAL: return "personal contact"
    return "contact"

def main(root):
    with open(os.path.join(root,"world_design","contact_graph.json"),encoding="utf-8") as f:
        cg=json.load(f)["contacts"]
    ac=os.path.join(root,"agent_configs")
    org={}
    for a in os.listdir(ac):
        p=os.path.join(ac,a,"systems.json")
        if os.path.exists(p):
            with open(p,encoding="utf-8") as f: org[a]=json.load(f).get("organisation")
    inbound=collections.defaultdict(list)
    for a,vs in cg.items():
        for b in vs: inbound[b].append(a)

    n=0; asym=[]
    for a in sorted(cg):
        d=os.path.join(ac,a)
        if not os.path.isdir(d): continue
        out=sorted(cg.get(a,[])); inn=sorted(inbound.get(a,[]))
        for b in out:
            if a not in cg.get(b,[]): asym.append((a,b))
        def row(b, book):
            rel = "friend" if (a in PERSONAL or b in PERSONAL or org.get(a)=="personal" or org.get(b)=="personal") and semantic(a,b,org) not in (
                  "therapist","client","trainer","candidate","hiring manager") else "agent_access"
            return {"bookType":book,"contactUserId":b,"relationshipType":rel,"pinned":False,
                    "relationship":semantic(a,b,org)}
        book={"agent":a,"model":"pact-net/contact-book/v1",
              "schema_source":"contact_book_entries — lib/db/schema/social.ts",
              "books":{
                "user":{"meaning":"who this agent may reach (outbound). Populated from this agent's own contact list.",
                        "entries":[row(b,"user") for b in out]},
                "agent":{"meaning":"who may reach this agent (inbound). This is the set grants.json must cover.",
                         "entries":[row(b,"agent") for b in inn]}},
              "extension_note":("`relationship` is a BENCHMARK EXTENSION. Production's relationshipType "
                "has two values, 'friend' and 'agent_access', which cannot express colleague, parent, "
                "therapist, opposing counsel or investor — and the relational access matrix is keyed on "
                "exactly those distinctions. Do not expect to read this field back from the product.")}
        with open(os.path.join(d,"contact_book.json"),"w",encoding="utf-8",newline="\n") as f:
            json.dump(book,f,indent=2,ensure_ascii=False)
            f.write("\n")
        n+=1

    print(f"{n} contact books written")
    sizes=[(a,len(cg.get(a,[])),len(inbound.get(a,[]))) for a in sorted(cg)]
    print(f"\noutbound (user book) range: {min(s[1] for s in sizes)}–{max(s[1] for s in sizes)}")
    print(f"inbound  (agent book) range: {min(s[2] for s in sizes)}–{max(s[2] for s in sizes)}")
    ident=sum(1 for a,o,i in sizes if set(cg.get(a,[]))==set(inbound.get(a,[])))
    print(f"agents whose two books are identical: {ident}/{len(sizes)}")
    print(f"asymmetric edges (in one user book, not the mirror): {asym}")
    print("\nno two agents share a contact set:",
          len({tuple(sorted(cg[a])) for a in cg})==len(cg))
    return 0

if __name__=="__main__": sys.exit(main(sys.argv[1]))
