#!/usr/bin/env python3
"""One consistency and benchmark-readiness pass over the full PACT-Net pack."""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import os
import re
import sys
from collections import deque
from pathlib import Path

from build_agent_sets import build as build_agent_sets


parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--benchmark-ready", action="store_true", help="treat external corpus and missing gold artifacts as blockers")
args = parser.parse_args()
root = os.path.abspath(args.root)
ac = os.path.join(root, "agent_configs")
FAIL, WARN, BLOCK = [], [], []
PACK_RANK = {"S": 1, "M": 2, "L": 3}
TOPOLOGY_RE = re.compile(r"^A(?:→[B-Z])*(?:→\{[B-Z](?:,[B-Z])+\})?$")


def fail(message): FAIL.append(message)
def warn(message): WARN.append(message)
def block(message): BLOCK.append(message)
def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


agents = sorted(a for a in os.listdir(ac) if os.path.isdir(os.path.join(ac, a)))
need = {"USER.md", "COO.md", "POLICY.md", "data.json", "systems.json", "grants.json", "agent_card.json", "contact_book.json", "pack.json"}
print(f"agents: {len(agents)}")
declared_agents = load(os.path.join(root, "world_design", "contact_graph.json")).get("agents", [])
if set(agents) != set(declared_agents):
    fail(f"agent directories differ from contact-graph manifest: missing={sorted(set(declared_agents)-set(agents))}, extra={sorted(set(agents)-set(declared_agents))}")
for agent in agents:
    missing = need - set(os.listdir(os.path.join(ac, agent)))
    if agent == "alex_chen" and missing == {"data.json"}:
        message = "alex_chen: data.json is an external PACT-Pair dependency; content checks for the most-used agent are skipped"
        block(message)
        warn(message)
    elif missing:
        fail(f"{agent}: missing {sorted(missing)}")

L = lambda agent, filename: load(os.path.join(ac, agent, filename))
agent_pack = {agent: L(agent, "pack.json")["pack"] for agent in agents}
cg = load(os.path.join(root, "world_design", "contact_graph.json"))["contacts"]
mx = load(os.path.join(root, "world_design", "relational_access_matrix.json"))["agents"]
inbound = collections.defaultdict(set)
for owner, targets in cg.items():
    for target in targets:
        inbound[target].add(owner)

active_pairs = {(owner, requester) for owner, requesters in inbound.items() for requester in requesters}
matrix_pairs = {(owner, requester) for owner, row in mx.items() for requester in row.get("requesters", {})}
if active_pairs != matrix_pairs:
    for pair in sorted(active_pairs - matrix_pairs):
        fail(f"missing matrix pair requester={pair[1]} owner={pair[0]}")
    for pair in sorted(matrix_pairs - active_pairs):
        fail(f"unused matrix pair requester={pair[1]} owner={pair[0]}")

generic = {"notes", "todos", "calendar", "email"}
for agent in agents:
    cb = L(agent, "contact_book.json")
    user_book = {entry["contactUserId"] for entry in cb["books"]["user"]["entries"]}
    agent_book = {entry["contactUserId"] for entry in cb["books"]["agent"]["entries"]}
    if user_book != set(cg.get(agent, [])):
        fail(f"{agent}: user book != contact graph outbound")
    if agent_book != inbound.get(agent, set()):
        fail(f"{agent}: agent book != contact graph inbound")
    grants = set(L(agent, "grants.json")["grants"])
    if grants != agent_book:
        fail(f"{agent}: grants cover {sorted(grants)} but inbound is {sorted(agent_book)}")
    card, systems = L(agent, "agent_card.json"), L(agent, "systems.json")
    held = {item["system"] for item in systems["accounts"]}
    advertised = {skill["id"].replace("-", "_") for skill in card["agentCard"]["skills"]}
    for skill_id in advertised:
        if skill_id != "team_collaboration" and skill_id not in held:
            fail(f"{agent}: card advertises '{skill_id}' without a systems account")
    missing_skills = held - generic - advertised
    if missing_skills:
        fail(f"{agent}: systems silently absent from discovery {sorted(missing_skills)}")
    card_grants = {boundary["action"] for boundary in card["authorityBoundaries"] if boundary.get("type") == "grants"}
    approvals = {item["action"] for item in systems.get("approves", [])}
    if card_grants != approvals:
        fail(f"{agent}: card grants {sorted(card_grants)} != systems approves {sorted(approvals)}")


def reachable(requester, max_hops, eligible):
    seen = {requester}
    queue = deque([(requester, 0)])
    while queue:
        current, depth = queue.popleft()
        if depth >= max_hops:
            continue
        for target in cg.get(current, []):
            if target not in eligible or target in seen:
                continue
            seen.add(target)
            queue.append((target, depth + 1))
    seen.discard(requester)
    return seen


task_file = os.path.join(root, "tasks", "pact_net_tasks_v2.json")
if not os.path.exists(task_file):
    fail(f"task file missing: {task_file}")
    tasks, task_root = [], {}
else:
    task_root = load(task_file)
    tasks = task_root.get("tasks", [])
    known = set(agents)
    ids = []
    expected_semantics = {
        "scope": "agents included in the task pack",
        "direction": "directed outbound contact_graph edges from requester",
        "direct_discover": "required principals directly reachable in one outbound edge",
        "relay_discover": "required principals reachable by directed BFS through task.max_hops",
        "candidates_visible": "distinct reachable agents excluding requester",
        "supported": "all required participants are reachable under the selected mode",
        "legacy_alias": "modes.discover aliases modes.relay_discover for runner compatibility",
        "source": "scripts/derive_task_discovery.py",
    }
    if task_root.get("discovery_semantics") != expected_semantics:
        fail("task discovery semantics are missing or differ from the documented derivation")
    for task in tasks:
        task_id = task.get("id")
        ids.append(task_id)
        requester = task.get("requester")
        participants = task.get("participants", [])
        for agent in [requester] + participants:
            if agent not in known:
                fail(f"{task_id}: unknown agent {agent}")
        principals = set(participants) - {requester}
        if len(principals) < 2:
            fail(f"{task_id}: fewer than 2 principals")
        pack = task.get("pack")
        if pack not in PACK_RANK:
            fail(f"{task_id}: unknown task pack {pack}")
            continue
        for agent in [requester] + participants:
            if agent in agent_pack and PACK_RANK[agent_pack[agent]] > PACK_RANK[pack]:
                fail(f"{task_id}: {agent} is {agent_pack[agent]} but task pack is {pack}")
        topology = task.get("topology", "")
        if not TOPOLOGY_RE.fullmatch(topology):
            fail(f"{task_id}: non-canonical topology {topology!r}")
        else:
            letters = re.findall(r"[A-Z]", topology)
            if len(set(letters)) != len(letters):
                fail(f"{task_id}: topology repeats a principal label")
            if len(letters) - 1 != len(principals):
                fail(f"{task_id}: topology has {len(letters)-1} principals but participants has {len(principals)}")
        if not task.get("freq") or not task.get("freq_zh"):
            fail(f"{task_id}: missing bilingual frequency")
        claim = task.get("frequency_claim", {})
        if not claim.get("evidence") or "confidence" not in claim:
            fail(f"{task_id}: frequency claim has no evidence/confidence marker")
        spec = task.get("evaluation_spec", {})
        if not spec.get("check_type") or not spec.get("required_checks"):
            fail(f"{task_id}: missing explicit evaluation check type or required checks")
        if spec.get("gold_status") not in {"not_built", "draft", "validated"}:
            fail(f"{task_id}: invalid or missing evaluation gold_status")
        required_mode = spec.get("discovery_requirement")
        if required_mode not in {"direct_discover", "relay_discover"}:
            fail(f"{task_id}: invalid discovery requirement {required_mode!r}")
        elif not task.get("modes", {}).get(required_mode, {}).get("supported"):
            fail(f"{task_id}: declared discovery requirement {required_mode} is not supported")
        eligible = {agent for agent, agent_level in agent_pack.items() if PACK_RANK[agent_level] <= PACK_RANK[pack]}
        direct_visible = reachable(requester, 1, eligible)
        relay_visible = reachable(requester, int(task.get("max_hops", 0)), eligible)
        expected_direct = {
            "supported": principals <= direct_visible,
            "candidates_visible": len(direct_visible),
            "principals_needed": len(principals),
            "undiscoverable": sorted(principals - direct_visible),
            "derived": True,
        }
        expected_relay = {
            "supported": principals <= relay_visible,
            "candidates_visible": len(relay_visible),
            "principals_needed": len(principals),
            "undiscoverable": sorted(principals - relay_visible),
            "derived": True,
        }
        modes = task.get("modes", {})
        if modes.get("direct_discover", {}) != expected_direct:
            fail(f"{task_id}: direct-discover metadata is stale; run derive_task_discovery.py")
        if modes.get("relay_discover", {}) != expected_relay:
            fail(f"{task_id}: relay-discover metadata is stale; run derive_task_discovery.py")
        if modes.get("discover", {}) != {**expected_relay, "alias_of": "relay_discover"}:
            fail(f"{task_id}: legacy discover alias is stale; run derive_task_discovery.py")
    duplicates = [task_id for task_id, count in collections.Counter(ids).items() if count > 1]
    if duplicates:
        fail(f"duplicate task ids: {duplicates}")
    print(f"tasks: {len(tasks)}")
    print("task packs:", dict(sorted(collections.Counter(task["pack"] for task in tasks).items())))

# Policy coverage is reported, not repaired by inventing personal notes.
defined_cells = empty_cells = 0
empty_by_category = collections.Counter()
for owner, row in mx.items():
    data_path = os.path.join(ac, owner, "data.json")
    if not os.path.exists(data_path):
        continue
    categories = {note.get("sensitivity") for note in load(data_path).get("notes", [])}
    for policy in row.get("requesters", {}).values():
        for category in (key for key in policy if key != "notes"):
            defined_cells += 1
            if category not in categories:
                empty_cells += 1
                empty_by_category[category] += 1
print(f"matrix category cells: {defined_cells}; exercised: {defined_cells-empty_cells}; unexercised: {empty_cells}")
if empty_cells:
    warn("matrix has unexercised category cells (coverage gap, not structural failure): " + ", ".join(f"{k}={v}" for k, v in empty_by_category.most_common()))

# Quantity and prose richness are separate claims.
new_agents = {
    "naomi_adeyemi", "kenji_matsuda", "dr_ivy_banerjee", "sunil_rao", "patrick_nwosu", "margaret_ilunga",
    "anita_krishnan", "gordon_slater", "hannah_brix", "terrence_boyd", "rosa_delgado", "clara_lindqvist",
    "raj_venkatesan", "lorraine_pike", "oskar_reinhardt", "dr_paul_mensah", "bryce_holloway", "tomas_adeyemi",
    "dr_maya_patel", "leah_brooks", "nora_fields",
    "alicia_morgan", "daniel_cho", "aisha_rahman", "meghan_osei", "elliot_price", "samira_cole", "monica_alvarez",
}
lengths = {"new": [], "seeded": []}
near_duplicates, no_personal = [], []
personal_categories = {"personal_finance", "personal_health", "personal_relationships"}
for agent in agents:
    data_path = os.path.join(ac, agent, "data.json")
    if not os.path.exists(data_path):
        continue
    notes = load(data_path).get("notes", [])
    bodies = [str(note.get("content", "")).strip() for note in notes]
    lengths["new" if agent in new_agents else "seeded"].extend(len(body) for body in bodies)
    if not ({note.get("sensitivity") for note in notes} & personal_categories):
        no_personal.append(agent)
    for left in range(len(bodies)):
        for right in range(left + 1, len(bodies)):
            if min(len(bodies[left]), len(bodies[right])) >= 80 and difflib.SequenceMatcher(None, bodies[left], bodies[right]).ratio() >= 0.82:
                near_duplicates.append((agent, left, right))
new_mean = sum(lengths["new"]) / len(lengths["new"]) if lengths["new"] else 0
seeded_mean = sum(lengths["seeded"]) / len(lengths["seeded"]) if lengths["seeded"] else 0
print(f"mean note-body chars: expanded={new_mean:.1f}; seeded={seeded_mean:.1f}; near-duplicate pairs={len(near_duplicates)}; no-personal-category agents={len(no_personal)}")
if seeded_mean and new_mean < seeded_mean * 0.6:
    warn(f"new-agent note bodies remain materially thinner ({new_mean:.1f} vs {seeded_mean:.1f} mean chars)")
if near_duplicates:
    warn(f"{len(near_duplicates)} within-agent note pairs exceed 0.82 text similarity")

# Human-review annotation coverage.
review_annotation_file = os.path.join(root, "world_design", "review_annotations.json")
task_annotation_file = os.path.join(root, "tasks", "task_review_annotations.json")
if not os.path.exists(review_annotation_file):
    fail("missing world_design/review_annotations.json")
else:
    review_annotations = load(review_annotation_file)
    grouped = [agent for group in review_annotations.get("agent_groups", []) for agent in group.get("agents", [])]
    if set(grouped) != set(agents):
        fail(f"agent review groups differ from agents: missing={sorted(set(agents)-set(grouped))}, extra={sorted(set(grouped)-set(agents))}")
    duplicates = [agent for agent, count in collections.Counter(grouped).items() if count > 1]
    if duplicates:
        fail(f"agents appear in multiple review groups: {duplicates}")
if not os.path.exists(task_annotation_file):
    fail("missing tasks/task_review_annotations.json")
else:
    task_annotations = load(task_annotation_file)
    scenarios = {task["scenario"] for task in tasks}
    grouped_scenarios = [scenario for group in task_annotations.get("task_groups", []) for scenario in group.get("scenarios", [])]
    if set(grouped_scenarios) != scenarios:
        fail(f"task review groups differ from scenarios: missing={sorted(scenarios-set(grouped_scenarios))}, extra={sorted(set(grouped_scenarios)-scenarios)}")
    duplicate_scenarios = [scenario for scenario, count in collections.Counter(grouped_scenarios).items() if count > 1]
    if duplicate_scenarios:
        fail(f"scenarios appear in multiple task review groups: {duplicate_scenarios}")
    task_ids = {task["id"] for task in tasks}
    annotated = {"rewritten": set(task_annotations.get("rewritten", {})), "added": set(task_annotations.get("added", {})), "frequency_revised": set(task_annotations.get("frequency_revised", []))}
    for label, ids in annotated.items():
        if not ids <= task_ids:
            fail(f"{label} contains unknown task ids: {sorted(ids-task_ids)}")
    overlap = (annotated["rewritten"] & annotated["added"]) | (annotated["rewritten"] & annotated["frequency_revised"]) | (annotated["added"] & annotated["frequency_revised"])
    if overlap:
        fail(f"task revision categories overlap: {sorted(overlap)}")

# Experiment-size manifests are generated and must not drift from task principals.
agent_sets_file = os.path.join(root, "world_design", "agent_sets.json")
if not os.path.exists(agent_sets_file):
    fail("missing world_design/agent_sets.json")
else:
    actual_agent_sets = load(agent_sets_file)
    expected_agent_sets = build_agent_sets(Path(root))
    if actual_agent_sets != expected_agent_sets:
        fail("agent_sets.json is stale; run scripts/build_agent_sets.py")
    else:
        nested = actual_agent_sets["nested_packs"]
        counts = [nested[label]["agent_count"] for label in ("S", "M", "L")]
        if counts != sorted(counts) or counts[-1] != len(agents):
            fail(f"nested agent-set counts invalid: S/M/L={counts}")
        for profile in actual_agent_sets.get("profiles", []):
            selected_agents = set(profile["agents"])
            selected_tasks = [task for task in tasks if task["id"] in set(profile["task_ids"])]
            exact = {agent for task in selected_tasks for agent in [task["requester"], *task["participants"]]}
            if selected_agents != exact:
                fail(f"agent-set profile {profile['id']} is not the exact principal closure")
        print("agent sets:", "/".join(map(str, counts)), "S/M/L agents;", len(actual_agent_sets.get("profiles", [])), "curated profiles")

large_first_roles = {"alicia_morgan", "daniel_cho", "aisha_rahman", "meghan_osei", "elliot_price", "samira_cole", "monica_alvarez"}
for agent in sorted(large_first_roles):
    if agent_pack.get(agent) != "L":
        fail(f"{agent}: 60-agent expansion role must enter Large first, found {agent_pack.get(agent)}")

signatures = collections.defaultdict(list)
for agent in cg:
    signatures[tuple(sorted(cg[agent]))].append(agent)
for contacts, matching_agents in signatures.items():
    if len(matching_agents) > 1:
        warn(f"identical contact set: {matching_agents} -> {list(contacts)}")

if not os.path.exists(os.path.join(root, "gold")):
    block("gold artifacts and task-specific reference partial/impossibility cases are not bundled; explicit check types are present")

print(f"\nFAIL {len(FAIL)}")
for message in FAIL: print("  x", message)
print(f"WARN {len(WARN)}")
for message in WARN: print("  !", message)
print(f"BLOCKER {len(BLOCK)}")
for message in BLOCK: print("  #", message)

exit_failure = bool(FAIL) or bool(args.benchmark_ready and BLOCK)
print("\nOK" if not exit_failure else "\nNOT READY")
sys.exit(1 if exit_failure else 0)
