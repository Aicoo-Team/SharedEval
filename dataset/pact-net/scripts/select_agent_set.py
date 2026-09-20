#!/usr/bin/env python3
"""Select the exact PACT-Net agents required by profiles, scenarios, or task IDs."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def readj(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root", nargs="?", default=None,
        help="PACT-Net world root (defaults to the parent directory of this script)",
    )
    parser.add_argument("--profile", action="append", default=[], help="Curated profile id; repeatable")
    parser.add_argument("--scenario", action="append", default=[], help="Scenario id; repeatable")
    parser.add_argument("--task", action="append", default=[], help="Task id; repeatable")
    parser.add_argument("--pack", choices=["S", "M", "L"], help="Use a whole nested default pack")
    parser.add_argument("--max-agents", type=int, help="Fail if the selected closure exceeds this size")
    parser.add_argument("--list", action="store_true", help="List available packs, profiles, and scenarios")
    parser.add_argument("--output", help="Write the resulting JSON manifest to this path")
    args = parser.parse_args()
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    sets = readj(root / "world_design" / "agent_sets.json")
    tasks = readj(root / "tasks" / "pact_net_tasks_v2.json")["tasks"]
    by_id = {task["id"]: task for task in tasks}
    profiles = {profile["id"]: profile for profile in sets["profiles"]}

    if args.list:
        print("Nested packs:")
        for pack in sets["nested_packs"].values():
            print(f"  {pack['id']}: {pack['agent_count']} agents, {pack['task_count']} tasks")
        print("Curated profiles:")
        for profile in sets["profiles"]:
            print(f"  {profile['id']}: {profile['agent_count']} agents, {profile['task_count']} tasks — {profile['label_en']}")
        print("Scenarios:")
        for scenario, item in sets["scenario_index"].items():
            print(f"  {scenario}: {item['agent_count']} agents, {item['task_count']} tasks")
        return

    selected_ids = set()
    selection = []
    if args.pack:
        selected_ids.update(sets["nested_packs"][args.pack]["task_ids"])
        selection.append({"type": "pack", "id": args.pack})
    for pid in args.profile:
        if pid not in profiles:
            raise SystemExit(f"unknown profile {pid!r}; use --list")
        selected_ids.update(profiles[pid]["task_ids"])
        selection.append({"type": "profile", "id": pid})
    known_scenarios = set(sets["scenario_index"])
    for scenario in args.scenario:
        if scenario not in known_scenarios:
            raise SystemExit(f"unknown scenario {scenario!r}; use --list")
        selected_ids.update(sets["scenario_index"][scenario]["task_ids"])
        selection.append({"type": "scenario", "id": scenario})
    for tid in args.task:
        if tid not in by_id:
            raise SystemExit(f"unknown task {tid!r}")
        selected_ids.add(tid)
        selection.append({"type": "task", "id": tid})
    if not selection:
        raise SystemExit("select --pack, --profile, --scenario, or --task; use --list to inspect options")

    selected_tasks = [task for task in tasks if task["id"] in selected_ids]
    agents = sorted({agent for task in selected_tasks for agent in [task["requester"], *task.get("participants", [])]})
    result = {
        "version": sets["version"], "mode": "custom_exact_principal_closure", "selection": selection,
        "agent_count": len(agents), "agents": agents,
        "task_count": len(selected_tasks), "task_ids": [task["id"] for task in selected_tasks],
        "scenario_count": len({task["scenario"] for task in selected_tasks}),
        "scenarios": sorted({task["scenario"] for task in selected_tasks}),
        "savings_vs_large": sets["nested_packs"]["L"]["agent_count"] - len(agents),
    }
    if args.max_agents is not None and len(agents) > args.max_agents:
        raise SystemExit(f"selection requires {len(agents)} agents, exceeding --max-agents {args.max_agents}; narrow scenarios or select task IDs")
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).resolve().write_text(rendered, encoding="utf-8", newline="\n")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
