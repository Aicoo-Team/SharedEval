#!/usr/bin/env python3
"""Self-test the executable-core gold, safe-partial, and hard-failure paths."""
from __future__ import annotations

import copy
import json
import tempfile
from pathlib import Path

from evaluate_executable_task import evaluate, read_json


def evaluate_object(root: Path, task_id: str, submission: dict) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "submission.json"
        path.write_text(json.dumps(submission, ensure_ascii=False), encoding="utf-8")
        return evaluate(root, task_id, path)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    index = read_json(root / "tasks" / "executable_core" / "index.json")
    checked = 0
    for item in index["tasks"]:
        task_id = item["id"]
        directory = root / "tasks" / "executable_core" / task_id
        manifest = read_json(directory / "manifest.json")
        success = read_json(directory / "gold_success.json")
        partial = read_json(directory / "gold_safe_partial.json")

        success_result = evaluate_object(root, task_id, success)
        assert success_result["full_completion"] and success_result["score"] == 1.0, task_id
        partial_result = evaluate_object(root, task_id, partial)
        assert partial_result["safety_passed"] and not partial_result["full_completion"], task_id
        assert 0 < partial_result["score"] < 1, task_id

        authority_bad = copy.deepcopy(success)
        irreversible = next((event for event in authority_bad["trajectory"] if event.get("irreversible")), None)
        if irreversible is None:
            authority_bad["trajectory"].append({"actor": "synthetic_test_actor", "action": "synthetic_irreversible_action", "object": "synthetic_test", "irreversible": True, "authorized": False})
        else:
            irreversible["authorized"] = False
        result = evaluate_object(root, task_id, authority_bad)
        assert not result["safety_passed"] and result["score"] == 0, task_id

        closure_bad = copy.deepcopy(success)
        closure_bad["final_state"]["status"] = manifest["terminal_statuses"][0]
        closure_bad["final_state"]["open_blockers"] = ["synthetic_unresolved_blocker"]
        result = evaluate_object(root, task_id, closure_bad)
        assert not result["safety_passed"] and result["score"] == 0, task_id

        if manifest.get("forbidden_disclosures"):
            privacy_bad = copy.deepcopy(success)
            rule = manifest["forbidden_disclosures"][0]
            privacy_bad["trajectory"].append({
                "actor": "synthetic_test_actor",
                "action": "disclose",
                "object": "synthetic_test",
                "authorized": True,
                "irreversible": False,
                "recipient": rule["recipients"][0],
                "shared_fields": [rule["fields"][0]],
                "at": "0000-01-01T00:00:00Z",
            })
            result = evaluate_object(root, task_id, privacy_bad)
            assert not result["safety_passed"] and result["score"] == 0, task_id
        checked += 1
    print(f"executable-core self-test: {checked} tasks; success, safe-partial, authority, closure and applicable privacy paths pass")


if __name__ == "__main__":
    main()
