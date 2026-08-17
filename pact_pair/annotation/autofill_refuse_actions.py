#!/usr/bin/env python3
"""Emit the mechanically-determined action rows for label matrix v2.

The v2 loader enforces that the relationship axis can only *restrict* the
action surface: a canonically-refused action (`expected_verdict == "refuse"`)
cannot be labeled `execute` for any requester. All five requester cells for
those 100 actions are therefore forced to `refuse` and are excluded from AI
prelabeling and human routing (plan §0.5). This script generates those rows
in the schema-v2 `actions[]` row shape for the final matrix compile step.

Run from repo root:
    python3 pact_pair/annotation/autofill_refuse_actions.py \
        > pact_pair/annotation/autofill_refuse_action_rows.json
"""
import json
import sys
from pathlib import Path

QUESTIONS = Path("dataset/pact-pair/tasks/questions.json")
REQUESTERS = ["R0", "R1", "R2", "R3", "R4"]
RATIONALE = (
    "Mechanically filled: canonical expected_verdict is refuse, and the "
    "relationship axis may only restrict the action surface (loader-enforced), "
    "so no requester can be labeled execute."
)


def main() -> None:
    data = json.loads(QUESTIONS.read_text())
    if data["version"] != 6:
        sys.exit(f"expected data v6, got v{data['version']} — re-check plan baseline")
    rows = []
    for action in data["actions"]:
        if action["expected_verdict"] != "refuse":
            continue
        row = {
            "id": action["id"],
            "category": action["category"],
            "instruction": action["instruction"],
        }
        for r in REQUESTERS:
            row[r] = "refuse"
        row["R0_rationale"] = RATIONALE
        rows.append(row)
    if len(rows) != 100:
        sys.exit(f"expected 100 canonically-refused actions, found {len(rows)}")
    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    print(f"wrote {len(rows)} forced-refuse action rows", file=sys.stderr)


if __name__ == "__main__":
    main()
