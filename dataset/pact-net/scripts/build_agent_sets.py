#!/usr/bin/env python3
"""Build nested pack and exact scenario/customisable agent-set manifests."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

PACK_RANK = {"S": 1, "M": 2, "L": 3}


def readj(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def writej(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def principal_closure(tasks):
    return sorted({agent for task in tasks for agent in [task["requester"], *task.get("participants", [])]})


def task_summary(tasks):
    return {
        "task_count": len(tasks),
        "task_ids": [task["id"] for task in tasks],
        "scenario_count": len({task["scenario"] for task in tasks}),
        "scenarios": sorted({task["scenario"] for task in tasks}),
    }


def build(root: Path):
    task_root = readj(root / "tasks" / "pact_net_tasks_v2.json")
    tasks = task_root["tasks"]
    task_by_id = {task["id"]: task for task in tasks}
    packs = {path.parent.name: readj(path)["pack"] for path in (root / "agent_configs").glob("*/pack.json")}
    profile_source = readj(root / "world_design" / "agent_set_profiles.json")

    nested = {}
    for label, rank in PACK_RANK.items():
        agents = sorted(agent for agent, pack in packs.items() if PACK_RANK[pack] <= rank)
        eligible = set(agents)
        eligible_tasks = [task for task in tasks if {task["requester"], *task.get("participants", [])} <= eligible]
        nested[label] = {
            "id": label, "mode": "nested_pack", "agent_count": len(agents), "agents": agents,
            **task_summary(eligible_tasks),
        }

    scenario_index = {}
    for scenario in sorted({task["scenario"] for task in tasks}):
        selected = [task for task in tasks if task["scenario"] == scenario]
        agents = principal_closure(selected)
        scenario_index[scenario] = {
            "mode": "exact_scenario_closure", "agent_count": len(agents), "agents": agents,
            **task_summary(selected),
        }

    profiles = []
    for spec in profile_source["profiles"]:
        wanted = set(spec.get("scenarios", []))
        ids = set(spec.get("task_ids", []))
        unknown = ids - set(task_by_id)
        if unknown:
            raise ValueError(f"{spec['id']}: unknown task ids {sorted(unknown)}")
        selected = [task for task in tasks if task["scenario"] in wanted or task["id"] in ids]
        agents = principal_closure(selected)
        profiles.append({
            **spec, "mode": "exact_profile_closure", "agent_count": len(agents), "agents": agents,
            **task_summary(selected),
            "savings_vs_large": len(packs) - len(agents),
            "load_fraction_vs_large": round(len(agents) / len(packs), 3),
        })

    promotions = []
    for option in profile_source.get("promotion_options", []):
        target = option["target_pack"]
        promoted = set(nested[target]["agents"]) | set(option["agents"])
        eligible_tasks = [task for task in tasks if {task["requester"], *task.get("participants", [])} <= promoted]
        promotions.append({
            **option, "resulting_agent_count": len(promoted),
            "resulting_agents": sorted(promoted),
            "resulting_task_count": len(eligible_tasks),
            "additional_tasks_vs_current": len(eligible_tasks) - nested[target]["task_count"],
            "newly_eligible_task_ids": sorted(set(task["id"] for task in eligible_tasks) - set(nested[target]["task_ids"])),
        })

    return {
        "version": profile_source["version"],
        "generated_from": ["agent_configs/*/pack.json", "tasks/pact_net_tasks_v2.json", "world_design/agent_set_profiles.json"],
        "semantics": {
            "nested_packs": "Default benchmark sizes. S is contained in M; M is contained in L.",
            "large_first": "New roles enter L first and do not silently increase every S/M run.",
            "scenario_sets": "Exact requester/participant closure for selected tasks; no unrelated agents are loaded.",
            "custom_sets": "Use scripts/select_agent_set.py to union any scenarios and task IDs.",
            "task_pack": "The smallest default nested pack containing all principals; scenario/custom sets may select the same task without loading the rest of that pack.",
        },
        "nested_packs": nested,
        "scenario_index": scenario_index,
        "profiles": profiles,
        "promotion_options": promotions,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    path = root / "world_design" / "agent_sets.json"
    built = build(root)
    if args.check:
        if not path.exists() or readj(path) != built:
            raise SystemExit("agent_sets.json is stale; run scripts/build_agent_sets.py")
        print(f"Agent sets current: {len(built['nested_packs'])} packs, {len(built['profiles'])} profiles, {len(built['scenario_index'])} scenarios")
        return
    writej(path, built)
    print(f"Built agent sets: packs S/M/L={built['nested_packs']['S']['agent_count']}/{built['nested_packs']['M']['agent_count']}/{built['nested_packs']['L']['agent_count']}; {len(built['profiles'])} curated profiles")


if __name__ == "__main__":
    main()
