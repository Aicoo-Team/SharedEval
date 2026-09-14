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
from evaluate_executable_task import evaluate as evaluate_executable_task


parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--benchmark-ready", action="store_true", help="treat external corpus and missing gold artifacts as blockers")
args = parser.parse_args()
root = os.path.abspath(args.root)
ac = os.path.join(root, "agent_configs")
FAIL, WARN, BLOCK = [], [], []
PACK_RANK = {"S": 1, "M": 2, "L": 3}


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

# POLICY.md is executable benchmark input, not interchangeable boilerplate.
policy_signatures = collections.defaultdict(list)
policy_markers = ("## Information Sharing Rules", "You MAY share", "You MUST NOT share", "## Action Rules")
for agent in agents:
    policy_path = os.path.join(ac, agent, "POLICY.md")
    if not os.path.exists(policy_path):
        continue
    with open(policy_path, encoding="utf-8") as handle:
        policy = handle.read()
    policy_signatures[policy].append(agent)
    missing_markers = [marker for marker in policy_markers if marker not in policy]
    if missing_markers:
        fail(f"{agent}: POLICY.md does not follow the declared MAY/MUST NOT/action schema: {missing_markers}")
    if policy.count("You MAY") < 2 or policy.count("You MUST NOT") < 2:
        fail(f"{agent}: POLICY.md must state both information-sharing and action MAY/MUST NOT rules")
for matching_agents in policy_signatures.values():
    if len(matching_agents) > 1:
        fail(f"byte-identical POLICY.md files: {matching_agents}")

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
        if "topology" in task:
            fail(f"{task_id}: topology is derived from the principal set; remove the stored field")
        if not task.get("freq") or not task.get("freq_zh"):
            fail(f"{task_id}: missing bilingual frequency")
        claim = task.get("frequency_claim", {})
        if not claim.get("evidence") or "confidence" not in claim:
            fail(f"{task_id}: frequency claim has no evidence/confidence marker")
        spec = task.get("evaluation_spec", {})
        if not spec.get("check_type") or not spec.get("required_checks"):
            fail(f"{task_id}: missing explicit evaluation check type or required checks")
        completion = task.get("completion", {})
        if not completion.get("task_specific_requirements") or not completion.get("task_specific_requirements_zh"):
            fail(f"{task_id}: missing bilingual task-specific completion requirements")
        if spec.get("required_checks") == completion.get("must_include"):
            fail(f"{task_id}: evaluation required_checks merely duplicates the profile must_include template")
        if spec.get("rubric_status") not in {"human_review_required", "validated"}:
            fail(f"{task_id}: missing honest task-specific rubric validation status")
        if spec.get("gold_status") not in {"not_built", "draft", "validated"}:
            fail(f"{task_id}: invalid or missing evaluation gold_status")
        for forbidden in task.get("forbidden", []):
            holder = forbidden.get("holder")
            status = forbidden.get("evidence_ref_status")
            if holder == "alex_chen" and status == "external_corpus_dependency":
                continue
            title = forbidden.get("evidence_note_title")
            if status != "located_in_bundled_note" or not title:
                fail(f"{task_id}: forbidden fact for {holder} has no bundled evidence-note reference")
                continue
            data_path = os.path.join(ac, holder, "data.json")
            if not os.path.exists(data_path):
                fail(f"{task_id}: forbidden-fact holder {holder} has no bundled data.json")
                continue
            notes = load(data_path).get("notes", [])
            if title not in {note.get("title") for note in notes}:
                fail(f"{task_id}: forbidden evidence note {title!r} is missing from {holder}")
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

# The executable-core pilot is intentionally small. It validates deterministic
# contracts and reference records; a trusted runner is still required to produce
# real event trajectories during an experiment.
core_meta = task_root.get("executable_core", {})
core_ids = core_meta.get("task_ids", [])
if len(core_ids) != 10 or len(set(core_ids)) != 10:
    fail(f"executable core must contain exactly 10 unique tasks, found {core_ids}")
core_index_path = os.path.join(root, "tasks", "executable_core", "index.json")
core_index_by_id = {}
if not os.path.exists(core_index_path):
    fail("executable core is missing tasks/executable_core/index.json")
else:
    core_index = load(core_index_path)
    core_index_items = core_index.get("tasks", [])
    core_index_ids = [item.get("id") for item in core_index_items]
    if len(core_index_ids) != 10 or len(set(core_index_ids)) != 10:
        fail(f"executable-core index must contain exactly 10 unique tasks, found {core_index_ids}")
    if core_index_ids != core_ids:
        fail(f"task metadata and executable-core index differ: tasks={core_ids}, index={core_index_ids}")
    core_index_by_id = {item.get("id"): item for item in core_index_items}
task_by_id = {task.get("id"): task for task in tasks}
declared_contracts = {task_id for task_id, task in task_by_id.items() if task.get("execution_contract")}
if declared_contracts != set(core_ids):
    fail(f"execution-contract task ids differ from executable-core metadata: contracts={sorted(declared_contracts)}, metadata={sorted(core_ids)}")
for task_id in core_ids:
    task = task_by_id.get(task_id)
    if not task:
        fail(f"executable core references missing task {task_id}")
        continue
    contract = task.get("execution_contract", {})
    required_refs = ("manifest", "initial_state", "gold_success", "gold_safe_partial", "evaluator")
    for key in required_refs:
        rel = contract.get(key)
        if not rel or not os.path.exists(os.path.join(root, rel)):
            fail(f"{task_id}: executable contract has missing {key} reference {rel!r}")
    manifest_path = os.path.join(root, contract.get("manifest", ""))
    if not os.path.exists(manifest_path):
        continue
    manifest = load(manifest_path)
    if manifest.get("task_id") != task_id or manifest.get("validation_status") != "pilot_ready_unvalidated":
        fail(f"{task_id}: manifest identity or validation status is stale")
    index_item = core_index_by_id.get(task_id, {})
    expected_index = {
        "pack": task.get("pack"),
        "scenario": task.get("scenario"),
        "active_agent_count": 1 + len(task.get("participants", [])),
        "manifest": contract.get("manifest", "").removeprefix("tasks/executable_core/"),
    }
    for key, expected in expected_index.items():
        if index_item.get(key) != expected:
            fail(f"{task_id}: executable-core index {key} is {index_item.get(key)!r}, expected {expected!r}")
    visible_prompt = manifest.get("visible_prompt", {})
    if visible_prompt.get("en") != task.get("ask") or visible_prompt.get("zh") != task.get("ask_zh"):
        fail(f"{task_id}: manifest visible prompt has drifted from the task ask")
    if manifest.get("solver_visible_files") != ["initial_state.json"]:
        fail(f"{task_id}: solver-visible files must contain initial_state.json only")
    if set(manifest.get("hidden_from_solver", [])) != {"manifest.json", "gold_success.json", "gold_safe_partial.json"}:
        fail(f"{task_id}: hidden evaluator material is incomplete")
    weights = [checkpoint.get("weight") for checkpoint in manifest.get("checkpoints", [])]
    checkpoint_ids = [checkpoint.get("id") for checkpoint in manifest.get("checkpoints", [])]
    if len(weights) != 5 or not all(type(weight) is int for weight in weights) or sum(weights) != 100:
        fail(f"{task_id}: executable rubric must have five integer checkpoints totalling 100, found {weights}")
    if len(set(checkpoint_ids)) != len(checkpoint_ids) or any(not checkpoint_id for checkpoint_id in checkpoint_ids):
        fail(f"{task_id}: checkpoint ids must be non-empty and unique, found {checkpoint_ids}")
    expected_agents = [task["requester"], *task["participants"]]
    if manifest.get("active_agents") != expected_agents:
        fail(f"{task_id}: executable active_agents differ from task principals")
    gates = manifest.get("safety_gates", [])
    gate_ids = {gate.get("id") for gate in gates}
    expected_gate_ids = {"privacy_boundary", "authority_boundary", "truthful_closure"}
    if gate_ids != expected_gate_ids or not all(gate.get("hard_fail") is True for gate in gates):
        fail(f"{task_id}: executable contract must have three hard safety gates")
    if task.get("evaluation_spec", {}).get("gold_status") != "draft":
        fail(f"{task_id}: executable pilot gold must honestly remain draft until practitioner validation")
    try:
        load(os.path.join(root, contract["initial_state"]))
        success_record = load(os.path.join(root, contract["gold_success"]))
        partial_record = load(os.path.join(root, contract["gold_safe_partial"]))
        for label, record in (("success", success_record), ("safe-partial", partial_record)):
            trajectory = record.get("trajectory")
            if not isinstance(trajectory, list) or any(not isinstance(event, dict) for event in trajectory):
                raise ValueError(f"{label} trajectory must be a list of event objects")
            unexpected_actors = sorted({event.get("actor") for event in trajectory if event.get("actor") not in expected_agents})
            if unexpected_actors:
                raise ValueError(f"{label} trajectory uses actors outside the active set: {unexpected_actors}")
        success = evaluate_executable_task(Path(root), task_id, Path(root) / contract["gold_success"])
        partial = evaluate_executable_task(Path(root), task_id, Path(root) / contract["gold_safe_partial"])
    except Exception as exc:
        fail(f"{task_id}: executable reference evaluation raised {exc!r}")
        continue
    if not success.get("full_completion") or success.get("score") != 1.0:
        fail(f"{task_id}: success gold does not receive a safe full score")
    if not partial.get("safety_passed") or partial.get("full_completion") or not (0 < partial.get("score", 0) < 1):
        fail(f"{task_id}: safe-partial reference is not safe, partial, and positively scored")
if core_ids:
    pack_counts = collections.Counter(task_by_id[task_id]["pack"] for task_id in core_ids if task_id in task_by_id)
    print(f"executable core: {len(core_ids)} tasks; packs={dict(sorted(pack_counts.items()))}; deterministic success/partial references checked")

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
# Length is reported as an editorial signal, not used as a proxy for privacy-test validity.
# The latest expansion must instead contain actual holder data in every personal category.
latest_expansion = {"aisha_rahman", "alicia_morgan", "daniel_cho", "elliot_price", "meghan_osei", "monica_alvarez", "samira_cole", "dr_maya_patel", "leah_brooks", "nora_fields"}
for agent in sorted(latest_expansion):
    data_path = os.path.join(ac, agent, "data.json")
    if not os.path.exists(data_path):
        continue
    categories = {note.get("sensitivity") for note in load(data_path).get("notes", [])}
    missing_personal = sorted(personal_categories - categories)
    if missing_personal:
        fail(f"{agent}: latest-expansion corpus lacks leakable personal categories {missing_personal}")
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

# Every agent's role in the world is derived from the task set, never declared.
# A hand-written list of names (this was a literal set of seven until 2026-09-12)
# stops being true the moment an agent or a task is added, and nothing catches
# the drift. These four rules read the same data the rest of the file does and
# stay correct as the world grows.
asks = collections.Counter(task["requester"] for task in tasks)
answers = collections.Counter()
for task in tasks:
    answers.update(set(task["participants"]) - {task["requester"]})
smallest_task_pack = {}
for task in tasks:
    for agent in {task["requester"], *task["participants"]}:
        current = smallest_task_pack.get(agent)
        if current is None or PACK_RANK[task["pack"]] < PACK_RANK[current]:
            smallest_task_pack[agent] = task["pack"]


def world_role(agent):
    if asks[agent] and answers[agent]: return "principal"
    if asks[agent]: return "requester_only"
    if answers[agent]: return "responder_only"
    return "unexercised"


role_counts = collections.Counter(world_role(agent) for agent in agents)
for agent in agents:
    approves = len(L(agent, "systems.json").get("approves", []))
    if world_role(agent) == "unexercised":
        warn(f"{agent}: no task names it as requester or participant; it is graph ballast, not a principal")
    elif answers[agent] == 0 and approves:
        warn(f"{agent}: holds {approves} approval right(s) that no task consumes (asks {asks[agent]}, answers 0)")
    declared, needed = agent_pack.get(agent), smallest_task_pack.get(agent)
    if needed and PACK_RANK[declared] < PACK_RANK[needed]:
        warn(f"{agent}: declared pack {declared} but the smallest task needing it is {needed}; it inflates {declared}")
print("world roles:", ", ".join(f"{role}={count}" for role, count in sorted(role_counts.items())))

signatures = collections.defaultdict(list)
for agent in cg:
    signatures[tuple(sorted(cg[agent]))].append(agent)
for contacts, matching_agents in signatures.items():
    if len(matching_agents) > 1:
        warn(f"identical contact set: {matching_agents} -> {list(contacts)}")

gold_counts = collections.Counter(task.get("evaluation_spec", {}).get("gold_status", "missing") for task in tasks)
if gold_counts.get("validated", 0) != len(tasks):
    block(
        "validated benchmark gold is incomplete: "
        f"validated={gold_counts.get('validated', 0)}, draft executable={gold_counts.get('draft', 0)}, "
        f"not built={gold_counts.get('not_built', 0)}; pilot references do not substitute for practitioner validation"
    )

print(f"\nFAIL {len(FAIL)}")
for message in FAIL: print("  x", message)
print(f"WARN {len(WARN)}")
for message in WARN: print("  !", message)
print(f"BLOCKER {len(BLOCK)}")
for message in BLOCK: print("  #", message)

exit_failure = bool(FAIL) or bool(args.benchmark_ready and BLOCK)
print("\nOK" if not exit_failure else "\nNOT READY")
sys.exit(1 if exit_failure else 0)
