#!/usr/bin/env python3
"""Derive task discovery fields from pack membership and the directed contact graph."""
from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path


PACK_RANK = {"S": 1, "M": 2, "L": 3}


def readj(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def reachable(requester, max_hops, eligible, graph):
    seen = {requester}
    queue = deque([(requester, 0)])
    while queue:
        current, depth = queue.popleft()
        if depth >= max_hops:
            continue
        for target in graph.get(current, []):
            if target not in eligible or target in seen:
                continue
            seen.add(target)
            queue.append((target, depth + 1))
    seen.discard(requester)
    return seen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--check", action="store_true", help="fail instead of writing when derived fields drift")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    task_path = root / "tasks" / "pact_net_tasks_v2.json"
    task_root = readj(task_path)
    graph = readj(root / "world_design" / "contact_graph.json")["contacts"]
    agent_pack = {
        path.parent.name: readj(path)["pack"]
        for path in (root / "agent_configs").glob("*/pack.json")
    }
    changed = []
    task_root["discovery_semantics"] = {
        "scope": "agents included in the task pack",
        "direction": "directed outbound contact_graph edges from requester",
        "direct_discover": "required principals directly reachable in one outbound edge",
        "relay_discover": "required principals reachable by directed BFS through task.max_hops",
        "candidates_visible": "distinct reachable agents excluding requester",
        "supported": "all required participants are reachable under the selected mode",
        "legacy_alias": "modes.discover aliases modes.relay_discover for runner compatibility",
        "source": "scripts/derive_task_discovery.py",
    }
    for task in task_root["tasks"]:
        rank = PACK_RANK[task["pack"]]
        eligible = {agent for agent, pack in agent_pack.items() if PACK_RANK[pack] <= rank}
        direct_visible = reachable(task["requester"], 1, eligible, graph)
        relay_visible = reachable(task["requester"], int(task["max_hops"]), eligible, graph)
        principals = set(task["participants"]) - {task["requester"]}
        direct = {
            "supported": principals <= direct_visible,
            "candidates_visible": len(direct_visible),
            "principals_needed": len(principals),
            "undiscoverable": sorted(principals - direct_visible),
            "derived": True,
        }
        relay = {
            "supported": principals <= relay_visible,
            "candidates_visible": len(relay_visible),
            "principals_needed": len(principals),
            "undiscoverable": sorted(principals - relay_visible),
            "derived": True,
        }
        legacy = {**relay, "alias_of": "relay_discover"}
        modes = task.setdefault("modes", {})
        if modes.get("direct_discover") != direct or modes.get("relay_discover") != relay or modes.get("discover") != legacy:
            changed.append(task["id"])
            modes["direct_discover"] = direct
            modes["relay_discover"] = relay
            modes["discover"] = legacy
    if args.check:
        if changed:
            raise SystemExit("discovery fields drifted for: " + ", ".join(changed))
        print(f"Discovery fields current for {len(task_root['tasks'])} tasks")
        return
    task_path.write_text(json.dumps(task_root, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Derived discovery fields for {len(task_root['tasks'])} tasks; changed {len(changed)}")


if __name__ == "__main__":
    main()
