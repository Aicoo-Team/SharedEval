#!/usr/bin/env python3
"""Run the prespecified PACT rebuttal sweep safely.

This orchestrator runs the public PACT-Pair responder benchmark. The configured
model is therefore the *defender/responder*. Requests are fixed benchmark
artifacts; this script does not claim an attacker-model axis.

Safety invariants
-----------------
* Only a zero-error cell is reportable by default.
* Only reportable cells are resumable.
* Concurrent work reserves its full conservative cost before launch.
* Per-cell costs come from runner artifacts, never overlapping account deltas.
* Every cell has an explicit replicate id, grading mode, task-set digest,
  policy digest, config digest, source revision, and unique output directory.
* The default $100 scheduler cap deliberately leaves $10 of the user's $110
  account-level research budget as an emergency buffer.

Examples
--------
    python3 rebuttal/runs/run_experiments.py --dry-run
    python3 rebuttal/runs/run_experiments.py --self-test
    python3 rebuttal/runs/run_experiments.py --budget 100 --concurrency 4
    python3 rebuttal/runs/run_experiments.py --blocks anchors,actions
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import inspect
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# Direct execution is intentionally retired.  Rebuttal cells must use Pulse's
# deployment-path requester -> contact_agent -> responder engine so their
# results are comparable with the paper.  Keeping the legacy implementation
# below importable preserves historical artifact-inspection helpers, while
# preventing an accidental new public-runner sweep.
PULSE_ORCHESTRATOR = (
    Path(__file__).resolve().parents[3]
    / "pulse/research/scripts/rebuttal/run_experiments.py"
)

if __name__ == "__main__":
    if not PULSE_ORCHESTRATOR.is_file():
        raise SystemExit(
            "Pulse rebuttal orchestrator is missing: "
            f"{PULSE_ORCHESTRATOR}"
        )
    os.execv(
        sys.executable,
        [sys.executable, str(PULSE_ORCHESTRATOR), *sys.argv[1:]],
    )

REPO = Path(__file__).resolve().parents[2]
RUNS = REPO / "rebuttal/runs"
CONFIG_DIR = RUNS / "configs"
LOG_DIR = RUNS / "logs"
MANIFEST = RUNS / "manifest.jsonl"
LOCK_FILE = RUNS / ".sweep.lock"
CAMPAIGN_DIR = RUNS / "campaigns"
OUT_DIR_REL = "rebuttal/runs/out"
BASE_URL = "https://openrouter.ai/api/v1"
SCRIPT_VERSION = "2026-07-28-r6"
DEFAULT_CAMPAIGN_ID = "rebuttal-20260728"
REASONING_EFFORT = "low"
REASONING_CONFIG = {"effort": REASONING_EFFORT}
PROVENANCE_RUNTIME_PATHS = (
    "src/runner/v1/",
    "pact_pair/policies/",
    "pact_pair/tasks/",
    "pact_pair/relationship_labels/",
    "pact_pair/data_spec/",
    "rebuttal/runs/",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
)


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    canonical_model_id: str
    estimated_usd_per_task: float
    estimate_source: str
    provider_slug: str
    provider_name: str
    supports_seed: bool


# DeepSeek is measured from a tiny historical run. GLM/Kimi remain planning
# estimates until clean artifact-level usage is available. The reservation
# multiplier is applied separately and defaults to 1.5x.
MODELS: dict[str, ModelSpec] = {
    "deepseek": ModelSpec(
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-20260423",
        0.000681,
        "historical 5-task estimate; recalibrate with a clean smoke run",
        "deepinfra/fp4",
        "DeepInfra",
        True,
    ),
    "glm": ModelSpec(
        "z-ai/glm-5.2",
        "z-ai/glm-5.2-20260616",
        0.025,
        "price-derived estimate; not yet cleanly measured",
        "novita/fp8",
        "Novita",
        True,
    ),
    "kimi": ModelSpec(
        "moonshotai/kimi-k3",
        "moonshotai/kimi-k3-20260715",
        0.070,
        "price-derived estimate; not yet cleanly measured",
        "baseten/fp8",
        "BaseTen",
        False,
    ),
}

RELATIONSHIP_FILE_IDS = [
    f"Q{i}" for i in range(101, 201) if i != 125
]

SURFACES: dict[str, tuple[str, list[str]]] = {
    "files": ("qa", [f"Q{i}" for i in range(1, 201)]),
    "todos": ("qa", [f"Q{i}" for i in range(201, 401)]),
    "actions": ("action", [f"A{i}" for i in range(1, 201)]),
    # Only the 99 items with requester-specific scenario-contract labels.
    "relationship_files": ("qa", RELATIONSHIP_FILE_IDS),
}

POLICY_FILES = {
    "D0": "D0_no_policy.md",
    "D1": "D1_generic_caution.md",
    "D2": "D2_category_specific.md",
    "D3": "D3_policy.md",
    "D4": "D4_policy.md",
    "D5": "D5_policy.md",
    "D2_SUBMITTED": "D2_SUBMITTED.md",
    "D3_SUBMITTED": "D3_SUBMITTED.md",
    "D4_SUBMITTED": "D4_SUBMITTED.md",
    "D5_SUBMITTED": "D5_SUBMITTED.md",
    "A_LONG_GENERIC": "A_LONG_GENERIC.md",
    "A_CATEGORY_ONLY": "A_CATEGORY_ONLY.md",
    "A_CATEGORY_EXAMPLES": "A_CATEGORY_EXAMPLES.md",
    "REL_R0": "REL_R0.md",
    "REL_R1": "REL_R1.md",
    "REL_R2": "REL_R2.md",
    "REL_R3": "REL_R3.md",
    "REL_R4": "REL_R4.md",
}
POLICY_DIR = REPO / "pact_pair/policies"

BLOCK_DESCRIPTIONS = {
    "anchors": (
        "Files/category: submitted D0,D1,D2 plus three controlled ablations, "
        "DeepSeek+GLM, replicate 1"
    ),
    "replications": (
        "Files/category: submitted D2 plus three controlled ablations, "
        "DeepSeek+GLM, replicate 2"
    ),
    "todo_robustness": (
        "New direct-responder Todo robustness: submitted D2, DeepSeek, "
        "three independent runs (not an original Pulse-protocol replication)"
    ),
    "relationships": (
        "99 relationship-labelled Files tasks: submitted D2 versus matched "
        "REL_R0..REL_R4, DeepSeek"
    ),
    "actions": (
        "Action endpoints: D0 versus submitted D2, DeepSeek+GLM, exact DB-diff scoring"
    ),
    "defenses": (
        "Optional submitted non-ablation defenses D3,D4,D5 on Files/category"
    ),
}
DEFAULT_BLOCKS = (
    "anchors",
    "replications",
    "todo_robustness",
    "relationships",
    "actions",
)
DEFAULT_MODELS = ("deepseek", "glm")

print_lock = threading.Lock()
manifest_lock = threading.Lock()


@dataclass(frozen=True)
class Cell:
    block: str
    model: str
    policy: str
    surface: str
    requester: str
    grading_mode: str
    replicate: int

    @property
    def name(self) -> str:
        return (
            f"{self.block}_{self.model}_{self.policy}_{self.surface}_"
            f"{self.requester}_g-{self.grading_mode}_r{self.replicate}"
        )

    @property
    def n_tasks(self) -> int:
        return len(SURFACES[self.surface][1])

    @property
    def seed(self) -> int | None:
        # Pair the stochastic condition across policies. Policy/block are
        # intentionally excluded, while independent replicates differ.
        key = (
            f"{self.model}|{self.surface}|{self.requester}|"
            f"{self.grading_mode}|r{self.replicate}"
        )
        paired_seed = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)
        return paired_seed if MODELS[self.model].supports_seed else None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    with print_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str | None:
    return sha256_bytes(path.read_bytes()) if path.is_file() else None


def task_set_digest(cell: Cell) -> str:
    kind, ids = SURFACES[cell.surface]
    payload = json.dumps(
        {"kind": kind, "ids": ids},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return sha256_bytes(payload)


def policy_digest(policy: str) -> str | None:
    filename = POLICY_FILES.get(policy)
    if not filename:
        return None
    path = POLICY_DIR / filename
    if not path.is_file():
        return None
    # Match prompt.ts loadCanonicalPolicy(...).trim() byte-for-byte.
    content = path.read_text(encoding="utf-8").strip()
    if not content:
        content = "No additional privacy policy is supplied."
    return sha256_bytes(content.encode("utf-8"))


def load_env() -> str:
    env_path = REPO / ".env"
    if env_path.exists():
        for raw_line in env_path.read_text().splitlines():
            line = raw_line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(
                    key.strip(), value.strip().strip("\"'")
                )
    key = (
        os.environ.get("PACT_MODEL_API_KEY")
        or os.environ.get("OPENROUTER_API_KEY")
    )
    if not key:
        raise RuntimeError(
            "PACT_MODEL_API_KEY not set (checked environment and .env)"
        )
    os.environ["PACT_MODEL_API_KEY"] = key
    return key


def account_credits(key: str) -> dict[str, float]:
    request = urllib.request.Request(
        f"{BASE_URL}/credits",
        headers={"Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read())["data"]
    return {
        "totalCredits": float(data["total_credits"]),
        "totalUsage": float(data["total_usage"]),
        "remaining": float(data["total_credits"]) - float(data["total_usage"]),
    }


def load_or_create_campaign(
    key: str,
    campaign_id: str,
    cap_usd: float,
    *,
    credits: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Load a cumulative account-usage budget ledger under the sweep lock."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", campaign_id):
        raise RuntimeError(
            "campaign id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}"
        )
    CAMPAIGN_DIR.mkdir(parents=True, exist_ok=True)
    path = CAMPAIGN_DIR / f"{campaign_id}.json"
    current = credits or account_credits(key)
    # Bind the cumulative ledger to the credential without storing or printing
    # any secret material. This prevents accidentally reusing an account-wide
    # usage baseline with a different OpenRouter account.
    account_key_sha256 = sha256_bytes(key.encode("utf-8"))
    if path.exists():
        try:
            campaign = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            raise RuntimeError(f"campaign ledger is malformed: {path}") from error
        if (
            campaign.get("campaignId") != campaign_id
            or float(campaign.get("capUsd", -1)) != cap_usd
            or not isinstance(campaign.get("baselineTotalUsage"), (int, float))
            or campaign.get("accountKeySha256") != account_key_sha256
        ):
            raise RuntimeError(
                f"campaign ledger {path} does not match id/cap/account; "
                "do not silently reset a research budget"
            )
    else:
        campaign = {
            "schemaVersion": 2,
            "campaignId": campaign_id,
            "capUsd": cap_usd,
            "baselineTotalUsage": current["totalUsage"],
            "accountKeySha256": account_key_sha256,
            "createdAt": utc_now(),
        }
        temporary = path.with_suffix(".json.tmp")
        with temporary.open("w") as stream:
            stream.write(json.dumps(campaign, indent=2, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    spent = max(
        0.0, current["totalUsage"] - float(campaign["baselineTotalUsage"])
    )
    return {
        **campaign,
        "ledgerPath": str(path.relative_to(REPO)),
        "observedSpendUsd": spent,
    }


def git_provenance() -> dict[str, Any]:
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    status = subprocess.run(
        [
            "git",
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            *PROVENANCE_RUNTIME_PATHS,
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    diff = subprocess.run(
        ["git", "diff", "--binary", "HEAD", "--", *PROVENANCE_RUNTIME_PATHS],
        cwd=REPO,
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    untracked_output = subprocess.run(
        [
            "git",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            *PROVENANCE_RUNTIME_PATHS,
        ],
        cwd=REPO,
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    state_hash = hashlib.sha256()
    state_hash.update(diff)
    for raw_path in sorted(
        value
        for value in untracked_output.split(b"\0")
        if value
        and any(
            value.decode("utf-8", errors="surrogateescape").startswith(prefix)
            for prefix in PROVENANCE_RUNTIME_PATHS
        )
    ):
        state_hash.update(b"\0path\0")
        state_hash.update(raw_path)
        path = REPO / raw_path.decode("utf-8", errors="surrogateescape")
        if path.is_symlink():
            state_hash.update(b"\0symlink\0")
            state_hash.update(os.readlink(path).encode("utf-8"))
        elif path.is_file():
            state_hash.update(b"\0content\0")
            state_hash.update(path.read_bytes())
    return {
        "sourceRevision": revision,
        "sourceDirty": bool(status.strip()),
        "sourceStatusSha256": sha256_bytes(status.encode()),
        "sourceStateSha256": state_hash.hexdigest(),
        "untrackedContentScope": list(PROVENANCE_RUNTIME_PATHS),
    }


def selected_models_for_block(
    block: str, requested_models: Iterable[str]
) -> list[str]:
    requested = list(requested_models)
    if block in ("relationships", "todo_robustness"):
        return ["deepseek"] if "deepseek" in requested else []
    return requested


def build_cells(
    blocks: Iterable[str], requested_models: Iterable[str]
) -> list[Cell]:
    cells: list[Cell] = []
    for block in blocks:
        models = selected_models_for_block(block, requested_models)
        if block == "anchors":
            for model in models:
                for policy in (
                    "D0",
                    "D1",
                    "D2_SUBMITTED",
                    "A_LONG_GENERIC",
                    "A_CATEGORY_ONLY",
                    "A_CATEGORY_EXAMPLES",
                ):
                    cells.append(
                        Cell(block, model, policy, "files", "R1", "category", 1)
                    )
        elif block == "replications":
            for model in models:
                for policy in (
                    "D2_SUBMITTED",
                    "A_LONG_GENERIC",
                    "A_CATEGORY_ONLY",
                    "A_CATEGORY_EXAMPLES",
                ):
                    cells.append(
                        Cell(block, model, policy, "files", "R1", "category", 2)
                    )
        elif block == "relationships":
            for model in models:
                for requester in ("R0", "R1", "R2", "R3", "R4"):
                    cells.append(
                        Cell(
                            block,
                            model,
                            "D2_SUBMITTED",
                            "relationship_files",
                            requester,
                            "relationship",
                            1,
                        )
                    )
                    cells.append(
                        Cell(
                            block,
                            model,
                            f"REL_{requester}",
                            "relationship_files",
                            requester,
                            "relationship",
                            1,
                        )
                    )
        elif block == "todo_robustness":
            for model in models:
                for replicate in (1, 2, 3):
                    cells.append(
                        Cell(
                            block,
                            model,
                            "D2_SUBMITTED",
                            "todos",
                            "R1",
                            "category",
                            replicate,
                        )
                    )
        elif block == "actions":
            for model in models:
                for policy in ("D0", "D2_SUBMITTED"):
                    cells.append(
                        Cell(
                            block,
                            model,
                            policy,
                            "actions",
                            "R1",
                            "category",
                            1,
                        )
                    )
        elif block == "defenses":
            for model in models:
                for policy in (
                    "D3_SUBMITTED",
                    "D4_SUBMITTED",
                    "D5_SUBMITTED",
                ):
                    cells.append(
                        Cell(block, model, policy, "files", "R1", "category", 1)
                    )
        else:
            raise ValueError(f"unknown matrix block: {block}")

    block_order = {name: index for index, name in enumerate(BLOCK_DESCRIPTIONS)}
    cells.sort(
        key=lambda cell: (
            block_order[cell.block],
            MODELS[cell.model].estimated_usd_per_task,
            cell.policy,
            cell.requester,
            cell.replicate,
        )
    )
    if len({cell.name for cell in cells}) != len(cells):
        raise AssertionError("matrix generated duplicate cell names")
    return cells


def write_config(
    cell: Cell,
    sweep_id: str,
    *,
    temperature: float,
    max_output_tokens: int,
    task_ids: list[str] | None = None,
    attempt_label: str | None = None,
) -> Path:
    config_dir = CONFIG_DIR / sweep_id
    config_dir.mkdir(parents=True, exist_ok=True)
    kind, default_ids = SURFACES[cell.surface]
    ids = task_ids if task_ids is not None else default_ids
    suffix = f"_{attempt_label}" if attempt_label else ""
    path = config_dir / f"{cell.name}{suffix}.yaml"
    output_directory = f"{OUT_DIR_REL}/{sweep_id}/{cell.name}"
    if attempt_label:
        output_directory += f"/{attempt_label}"
    seed_line = f"  seed: {cell.seed}\n" if cell.seed is not None else ""
    provider_slug = MODELS[cell.model].provider_slug
    content = (
        "apiVersion: pact-run/v1\n"
        "kind: RunConfig\n\n"
        "model:\n"
        "  provider: openai-compatible\n"
        f"  baseUrl: {BASE_URL}\n"
        "  apiKeyEnv: PACT_MODEL_API_KEY\n"
        f"  model: {MODELS[cell.model].model_id}\n"
        f"  temperature: {temperature}\n"
        f"{seed_line}"
        "  reasoning:\n"
        f"    effort: {REASONING_EFFORT}\n"
        "  providerRouting:\n"
        "    requireParameters: true\n"
        "    allowFallbacks: false\n"
        f"    only: [{provider_slug}]\n"
        f"  maxOutputTokens: {max_output_tokens}\n\n"
        "benchmark:\n"
        f"  policy: {cell.policy}\n"
        f"  requester: {cell.requester}\n"
        f"  gradingMode: {cell.grading_mode}\n"
        "  tasks:\n"
        f"    kind: {kind}\n"
        f"    ids: [{', '.join(ids)}]\n\n"
        "budget:\n"
        "  maxTurns: 8\n"
        "  maxToolCalls: 6\n"
        "  maxRuntimeMs: 120000\n\n"
        "output:\n"
        f"  directory: {output_directory}\n"
        "  saveTraces: true\n"
    )
    temporary = path.with_suffix(".yaml.tmp")
    temporary.write_text(content)
    temporary.replace(path)
    return path


def parse_last_json_object(text: str) -> dict[str, Any] | None:
    """Extract the largest complete JSON object from noisy CLI stdout."""
    stripped = text.strip()
    try:
        whole = json.loads(stripped)
    except json.JSONDecodeError:
        whole = None
    if isinstance(whole, dict):
        return whole

    decoder = json.JSONDecoder()
    candidates: list[tuple[int, dict[str, Any]]] = []
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, end = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            candidates.append((end - index, value))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def run_runner(
    config: Path,
    *,
    check: bool = False,
    timeout_seconds: int = 7200,
) -> tuple[int, dict[str, Any] | None, str, str]:
    tsx = REPO / "node_modules/.bin/tsx"
    if not tsx.is_file():
        raise RuntimeError(
            "local node_modules/.bin/tsx is missing; install locked dependencies "
            "before preflight (network package resolution is disabled)"
        )
    command = [
        str(tsx),
        "src/runner/v1/cli.ts",
        "--config",
        str(config.relative_to(REPO)),
    ]
    if check:
        command.append("--check")
    process = subprocess.run(
        command,
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    return (
        process.returncode,
        parse_last_json_object(process.stdout),
        process.stdout,
        process.stderr,
    )


def validate_configs(
    cells: list[Cell],
    sweep_id: str,
    *,
    temperature: float,
    max_output_tokens: int,
) -> list[str]:
    """Validate every distinct semantic config without calling a model."""
    errors: list[str] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for cell in cells:
        semantic_key = (
            cell.policy,
            cell.surface,
            cell.requester,
            cell.grading_mode,
            cell.model,
        )
        if semantic_key in seen:
            continue
        seen.add(semantic_key)
        config = write_config(
            cell,
            sweep_id,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        code, parsed, _, stderr = run_runner(config, check=True, timeout_seconds=120)
        expected_model = MODELS[cell.model].model_id
        benchmark = parsed.get("benchmark", {}) if parsed else {}
        parsed_model = parsed.get("model", {}) if parsed else {}
        observed_model = parsed_model.get("model")
        expected_routing = {
            "requireParameters": True,
            "allowFallbacks": False,
            "only": [MODELS[cell.model].provider_slug],
        }
        if (
            code != 0
            or not parsed
            or not parsed.get("valid")
            or benchmark.get("policy") != cell.policy
            or benchmark.get("requester") != cell.requester
            or benchmark.get("gradingMode") != cell.grading_mode
            or benchmark.get("taskCount") != cell.n_tasks
            or observed_model != expected_model
            or parsed_model.get("temperature") != temperature
            or parsed_model.get("maxOutputTokens") != max_output_tokens
            or parsed_model.get("reasoning") != REASONING_CONFIG
            or parsed_model.get("providerRouting") != expected_routing
            or parsed_model.get("seed") != cell.seed
        ):
            errors.append(
                f"{cell.name}: config check failed "
                f"(code={code}, parsed={json.dumps(parsed)[:300]}, "
                f"stderr={stderr[:200]})"
            )
    return errors


def load_manifest_rows() -> list[dict[str, Any]]:
    if not MANIFEST.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(MANIFEST.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            log(f"WARN   malformed manifest row {line_number}; not resumable")
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def manifest_row_matches(
    row: dict[str, Any],
    cell: Cell,
    source: dict[str, Any],
    *,
    temperature: float,
    max_output_tokens: int,
) -> bool:
    """Decide whether a prior row is the exact current experiment cell."""
    provenance = row.get("provenance")
    experiment_config = row.get("experimentConfig")
    semantic_fields = (
        "block",
        "model",
        "policy",
        "surface",
        "requester",
        "grading_mode",
        "replicate",
    )
    return (
        row.get("status") == "ok"
        and row.get("strictGatePassed") is True
        and row.get("scriptVersion") == SCRIPT_VERSION
        and row.get("cell") == cell.name
        and all(row.get(field) == getattr(cell, field) for field in semantic_fields)
        and row.get("requestedModelId") == MODELS[cell.model].model_id
        and row.get("seed") == cell.seed
        and row.get("nTasks") == cell.n_tasks
        and isinstance(provenance, dict)
        and provenance.get("taskSetSha256") == task_set_digest(cell)
        and provenance.get("policySha256") == policy_digest(cell.policy)
        and provenance.get("sourceRevision") == source["sourceRevision"]
        and provenance.get("sourceStateSha256") == source["sourceStateSha256"]
        and isinstance(experiment_config, dict)
        and experiment_config.get("temperature") == temperature
        and experiment_config.get("reasoning") == REASONING_CONFIG
        and experiment_config.get("reasoningApplied") is True
        and experiment_config.get("maxOutputTokens") == max_output_tokens
        and experiment_config.get("baseUrl") == BASE_URL
        and experiment_config.get("seedApplied") is MODELS[cell.model].supports_seed
        and experiment_config.get("providerRouting")
        == {
            "requireParameters": True,
            "allowFallbacks": False,
            "only": [MODELS[cell.model].provider_slug],
        }
    )


def done_cells(
    cells: list[Cell],
    source: dict[str, Any],
    *,
    temperature: float,
    max_output_tokens: int,
) -> set[str]:
    """Return only exact, strict, provenance-matching completed cells."""
    by_name = {cell.name: cell for cell in cells}
    done: set[str] = set()
    for row in load_manifest_rows():
        name = row.get("cell")
        cell = by_name.get(name) if isinstance(name, str) else None
        if cell and manifest_row_matches(
            row,
            cell,
            source,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        ):
            done.add(cell.name)
    return done


def append_manifest(row: dict[str, Any]) -> None:
    RUNS.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(row, sort_keys=True) + "\n"
    with manifest_lock:
        with MANIFEST.open("a") as manifest:
            manifest.write(encoded)
            manifest.flush()
            os.fsync(manifest.fileno())


def resolve_output_directory(parsed: dict[str, Any]) -> Path | None:
    raw = parsed.get("outputDirectory")
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = REPO / path
    try:
        path.resolve().relative_to(REPO.resolve())
    except ValueError:
        return None
    return path


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    rows: list[dict[str, Any]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def numeric_at(value: Any, path: tuple[str, ...]) -> float | None:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if isinstance(current, (int, float)) and math.isfinite(float(current)):
        return float(current)
    return None


def extract_artifact_cost(
    parsed: dict[str, Any], run_metadata: dict[str, Any], results: list[dict[str, Any]]
) -> float | None:
    """Return non-overlapping artifact cost, never an account-wide delta."""
    aggregate_paths = (
        ("provider", "costUsd"),
        ("providerTelemetry", "totals", "costUsd"),
        ("providerUsage", "costUsd"),
        ("usage", "costUsd"),
        ("summary", "provider", "costUsd"),
        ("summary", "providerTelemetry", "totals", "costUsd"),
        ("summary", "providerUsage", "costUsd"),
        ("summary", "costUsd"),
    )
    for source in (parsed, run_metadata):
        for path in aggregate_paths:
            value = numeric_at(source, path)
            if value is not None:
                return value

    task_costs: list[float] = []
    for row in results:
        found = None
        for path in (
            ("providerTelemetry", "totals", "costUsd"),
            ("providerUsage", "costUsd"),
            ("usage", "costUsd"),
            ("costUsd",),
        ):
            found = numeric_at(row, path)
            if found is not None:
                break
        if found is None:
            return None
        task_costs.append(found)
    return sum(task_costs) if task_costs else None


def settlement_artifact_cost(
    observed_cost: float | None, cost_complete: bool
) -> float | None:
    """Return a scheduler-settleable cost only when every request is priced."""
    return observed_cost if cost_complete else None


def telemetry_identity(
    run_metadata: dict[str, Any], results: list[dict[str, Any]]
) -> dict[str, Any]:
    requested_models: set[str] = set()
    served_models: set[str] = set()
    providers: set[str] = set()
    response_ids: set[str] = set()

    model_block = run_metadata.get("model")
    if isinstance(model_block, dict) and isinstance(model_block.get("model"), str):
        requested_models.add(model_block["model"])

    for row in results:
        telemetry = row.get("providerTelemetry")
        if not isinstance(telemetry, dict):
            continue
        requested = telemetry.get("requestedModel")
        if isinstance(requested, str):
            requested_models.add(requested)
        requests = telemetry.get("requests")
        if not isinstance(requests, list):
            continue
        for request in requests:
            if not isinstance(request, dict):
                continue
            for key, target in (
                ("servedModel", served_models),
                ("provider", providers),
                ("responseId", response_ids),
                ("generationId", response_ids),
            ):
                value = request.get(key)
                if isinstance(value, str) and value:
                    target.add(value)

    return {
        "requestedModels": sorted(requested_models),
        "servedModels": sorted(served_models),
        "providers": sorted(providers),
        "responseIdCount": len(response_ids),
    }


def task_telemetry_complete(
    results: list[dict[str, Any]],
    expected_model: str,
    allowed_served_models: set[str],
    expected_provider: str,
) -> bool:
    """Require actual routing and response identity on every provider request."""
    if not results:
        return False
    for row in results:
        telemetry = row.get("providerTelemetry")
        if (
            not isinstance(telemetry, dict)
            or telemetry.get("requestedModel") != expected_model
        ):
            return False
        requests = telemetry.get("requests")
        if not isinstance(requests, list) or not requests:
            return False
        for request in requests:
            if not isinstance(request, dict):
                return False
            has_response_identity = any(
                isinstance(request.get(key), str) and bool(request[key])
                for key in ("responseId", "requestId", "generationId")
            )
            if (
                request.get("requestedModel") != expected_model
                or request.get("servedModel") not in allowed_served_models
                or request.get("provider") != expected_provider
                or not has_response_identity
            ):
                return False
    return True


def model_identity_gate(
    run_metadata: dict[str, Any],
    results: list[dict[str, Any]],
    model_alias: str,
    minimum_response_ids: int,
) -> tuple[bool, dict[str, Any]]:
    model_spec = MODELS[model_alias]
    allowed_served_models = {
        model_spec.model_id,
        model_spec.canonical_model_id,
    }
    identity = telemetry_identity(run_metadata, results)
    passed = (
        identity["requestedModels"] == [model_spec.model_id]
        and bool(identity["servedModels"])
        and set(identity["servedModels"]).issubset(allowed_served_models)
        and identity["providers"] == [model_spec.provider_name]
        and identity["responseIdCount"] >= minimum_response_ids
        and task_telemetry_complete(
            results,
            model_spec.model_id,
            allowed_served_models,
            model_spec.provider_name,
        )
    )
    return passed, identity


def attempt_provenance_ok(
    run_metadata: dict[str, Any],
    cell: Cell,
    source_revision: str,
) -> bool:
    runner_policy = run_metadata.get("policyProvenance")
    runner_benchmark = run_metadata.get("benchmark")
    runner_model = run_metadata.get("model")
    model_spec = MODELS[cell.model]
    expected_routing = {
        "requireParameters": True,
        "allowFallbacks": False,
        "only": [model_spec.provider_slug],
    }
    return (
        isinstance(runner_policy, dict)
        and runner_policy.get("id") == cell.policy
        and runner_policy.get("sha256") == policy_digest(cell.policy)
        and isinstance(runner_benchmark, dict)
        and runner_benchmark.get("policy") == cell.policy
        and runner_benchmark.get("requester") == cell.requester
        and runner_benchmark.get("gradingMode") == cell.grading_mode
        and isinstance(runner_model, dict)
        and runner_model.get("model") == model_spec.model_id
        and runner_model.get("reasoning") == REASONING_CONFIG
        and runner_model.get("providerRouting") == expected_routing
        and runner_model.get("seed") == cell.seed
        and isinstance(run_metadata.get("configDigest"), str)
        and len(run_metadata["configDigest"]) == 64
        and isinstance(run_metadata.get("taskSetDigest"), str)
        and len(run_metadata["taskSetDigest"]) == 64
        and run_metadata.get("sourceRevision") == source_revision
    )


def merge_summaries(
    base_summary: dict[str, Any],
    repair_summaries: list[dict[str, Any]],
    remaining_errors: int,
) -> dict[str, Any]:
    """Merge disjoint failed-task repairs without double-counting attempts."""
    merged = json.loads(json.dumps(base_summary))
    for repair in repair_summaries:
        for key in ("observed", "scorable", "correct", "violations"):
            merged[key] = int(merged.get(key, 0)) + int(repair.get(key, 0))
        for section, additive_keys in (
            (
                "qa",
                (
                    "observed",
                    "scorable",
                    "correct",
                    "expectedAnswer",
                    "correctAnswers",
                    "expectedRefuse",
                    "safeRefusals",
                    "protectedNoLeak",
                    "leaks",
                    "falseRefusals",
                    "borderline",
                    "benchmarkAllowed",
                    "correctBenchmarkAnswers",
                    "benchmarkProtected",
                    "benchmarkProtectedNoLeak",
                    "benchmarkLeaks",
                    "benchmarkFalseRefusals",
                ),
            ),
            (
                "actions",
                (
                    "observed",
                    "correct",
                    "expectedExecute",
                    "correctExecutions",
                    "expectedRefuse",
                    "safeRefusals",
                    "safeNoMutation",
                    "unsafeMutations",
                ),
            ),
        ):
            target = merged.setdefault(section, {})
            source = repair.get(section, {})
            for key in additive_keys:
                target[key] = int(target.get(key, 0)) + int(source.get(key, 0))

        target_provider = merged.setdefault("provider", {})
        source_provider = repair.get("provider", {})
        for key in (
            "requests",
            "successfulRequests",
            "invalidResponses",
            "failedRequests",
            "httpAttempts",
            "usageRecords",
            "costRecords",
            "promptTokens",
            "completionTokens",
            "totalTokens",
            "reasoningTokens",
            "cachedTokens",
            "costUsd",
        ):
            if key in target_provider or key in source_provider:
                target_provider[key] = float(target_provider.get(key, 0)) + float(
                    source_provider.get(key, 0)
                )
        for key in ("servedModels", "providers"):
            target_provider[key] = sorted(
                set(target_provider.get(key, []))
                | set(source_provider.get(key, []))
            )
        for key in ("usageComplete", "costComplete"):
            target_provider[key] = (
                target_provider.get(key) is True
                and source_provider.get(key) is True
            )

        target_metrics = merged.setdefault("metrics", {})
        for metric, source_rate in repair.get("metrics", {}).items():
            if not isinstance(source_rate, dict):
                continue
            target_rate = target_metrics.setdefault(
                metric, {"numerator": 0, "denominator": 0, "value": None}
            )
            target_rate["numerator"] = int(target_rate.get("numerator", 0)) + int(
                source_rate.get("numerator", 0)
            )
            target_rate["denominator"] = int(
                target_rate.get("denominator", 0)
            ) + int(source_rate.get("denominator", 0))
            denominator = target_rate["denominator"]
            target_rate["value"] = (
                target_rate["numerator"] / denominator if denominator else None
            )

    merged["errors"] = remaining_errors
    qa = merged.setdefault("qa", {})
    actions = merged.setdefault("actions", {})
    if int(qa.get("total", 0)) > 0:
        qa["errors"] = remaining_errors
    if int(actions.get("total", 0)) > 0:
        actions["errors"] = remaining_errors
    # Recompute every persisted rate from its merged numerator/denominator.
    # These numerators preserve distinctions (for example action refusals
    # versus other incorrect actions) that are not all present as raw fields.
    for rate_value in merged.setdefault("metrics", {}).values():
        if not isinstance(rate_value, dict):
            continue
        numerator = int(rate_value.get("numerator", 0))
        denominator = int(rate_value.get("denominator", 0))
        rate_value["numerator"] = numerator
        rate_value["denominator"] = denominator
        rate_value["value"] = numerator / denominator if denominator else None
    return merged


def retained_rows_identity_ok(
    run_metadata: dict[str, Any],
    results: list[dict[str, Any]],
    model_alias: str,
) -> bool:
    """Validate only successful rows retained from an individual attempt."""
    retained = [row for row in results if row.get("status") == "ok"]
    if not retained:
        model_block = run_metadata.get("model")
        return (
            isinstance(model_block, dict)
            and model_block.get("model") == MODELS[model_alias].model_id
        )
    return model_identity_gate(
        run_metadata,
        retained,
        model_alias,
        len(retained),
    )[0]


def task_filter_id(task_id: str) -> str:
    return task_id.removeprefix("PAIR-")


def run_cell(
    cell: Cell,
    sweep_id: str,
    *,
    temperature: float,
    max_output_tokens: int,
    max_error_rate: float,
    timeout_seconds: int,
    reservation_usd: float,
    source: dict[str, Any],
    campaign: dict[str, Any],
    repair_attempts: int,
    max_repair_tasks: int,
) -> dict[str, Any]:
    config = write_config(
        cell,
        sweep_id,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
    )
    log_directory = LOG_DIR / sweep_id
    log_directory.mkdir(parents=True, exist_ok=True)
    logfile = log_directory / f"{cell.name}.log"
    started_at = utc_now()
    started = time.monotonic()
    log(
        f"START  {cell.name} ({cell.n_tasks} tasks, "
        f"reserved ${reservation_usd:.2f})"
    )

    try:
        code, parsed, stdout, stderr = run_runner(
            config, timeout_seconds=timeout_seconds
        )
    except subprocess.TimeoutExpired as error:
        elapsed = time.monotonic() - started
        timeout_stdout = (
            error.stdout.decode("utf-8", errors="replace")
            if isinstance(error.stdout, bytes)
            else (error.stdout or "")
        )
        timeout_stderr = (
            error.stderr.decode("utf-8", errors="replace")
            if isinstance(error.stderr, bytes)
            else (error.stderr or "")
        )
        logfile.write_text(
            timeout_stdout + "\n--- STDERR ---\n" + timeout_stderr
        )
        return {
            "schemaVersion": 2,
            "scriptVersion": SCRIPT_VERSION,
            "sweepId": sweep_id,
            "cell": cell.name,
            **asdict(cell),
            "status": "timeout",
            "strictGatePassed": False,
            "reservedUsd": reservation_usd,
            "artifactCostUsd": None,
            "campaign": {
                "campaignId": campaign["campaignId"],
                "capUsd": campaign["capUsd"],
                "baselineTotalUsage": campaign["baselineTotalUsage"],
            },
            "elapsedSec": round(elapsed, 3),
            "startedAt": started_at,
            "finishedAt": utc_now(),
            "log": str(logfile.relative_to(REPO)),
            "provenance": {
                **source,
                "configSha256": sha256_file(config),
                "taskSetSha256": task_set_digest(cell),
                "policySha256": policy_digest(cell.policy),
            },
        }

    logfile.write_text(stdout + "\n--- STDERR ---\n" + stderr)
    elapsed = time.monotonic() - started
    base = {
        "schemaVersion": 2,
        "scriptVersion": SCRIPT_VERSION,
        "sweepId": sweep_id,
        "cell": cell.name,
        **asdict(cell),
        "requestedModelId": MODELS[cell.model].model_id,
        "seed": cell.seed,
        "nTasks": cell.n_tasks,
        "experimentConfig": {
            "baseUrl": BASE_URL,
            "temperature": temperature,
            "reasoning": REASONING_CONFIG,
            "reasoningApplied": True,
            "maxOutputTokens": max_output_tokens,
            "seedApplied": MODELS[cell.model].supports_seed,
            "providerRouting": {
                "requireParameters": True,
                "allowFallbacks": False,
                "only": [MODELS[cell.model].provider_slug],
            },
        },
        "reservedUsd": round(reservation_usd, 6),
        "campaign": {
            "campaignId": campaign["campaignId"],
            "capUsd": campaign["capUsd"],
            "baselineTotalUsage": campaign["baselineTotalUsage"],
        },
        "runnerExitCode": code,
        "elapsedSec": round(elapsed, 3),
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "log": str(logfile.relative_to(REPO)),
        "provenance": {
            **source,
            "configSha256": sha256_file(config),
            "taskSetSha256": task_set_digest(cell),
            "policySha256": policy_digest(cell.policy),
        },
    }
    if not parsed:
        row = {
            **base,
            "status": "failed",
            "strictGatePassed": False,
            "artifactCostUsd": None,
            "failure": "runner produced no parseable JSON result",
        }
        log(f"FAIL   {cell.name}: no parseable runner result")
        return row

    output_directory = resolve_output_directory(parsed)
    run_metadata = (
        read_json(output_directory / "run.json") if output_directory else None
    ) or {}
    artifact_summary = (
        read_json(output_directory / "summary.json") if output_directory else None
    )
    summary = artifact_summary or parsed.get("summary") or {}
    results = (
        read_jsonl(output_directory / "results.jsonl")
        if output_directory
        else []
    )
    attempted = int(summary.get("attempted", summary.get("total", len(results))))
    base_error_count = int(summary.get("errors", cell.n_tasks))
    base_artifact_cost = extract_artifact_cost(parsed, run_metadata, results)
    base_provider = summary.get("provider", {})
    all_cost_complete = (
        isinstance(base_provider, dict)
        and base_provider.get("costComplete") is True
        and base_artifact_cost is not None
    )
    total_artifact_cost = base_artifact_cost
    repair_summaries: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = [{
        "label": "base",
        "runId": parsed.get("runId"),
        "outputDirectory": (
            str(output_directory.relative_to(REPO))
            if output_directory
            else None
        ),
        "attempted": attempted,
        "errors": base_error_count,
        "runnerExitCode": code,
        "artifactCostUsd": base_artifact_cost,
    }]
    combined_by_task = {
        row["taskId"]: row
        for row in results
        if isinstance(row.get("taskId"), str)
    }
    original_results = list(results)
    remaining_task_ids = [
        row["taskId"]
        for row in results
        if isinstance(row.get("taskId"), str)
        and (
            row.get("status") == "infrastructure_error"
            or bool(row.get("error"))
            or bool(row.get("finalizeError"))
        )
    ]
    repair_provenance_ok = True
    repair_identity_ok = True
    repair_artifacts_complete = True
    repair_runner_status_ok = True
    if (
        remaining_task_ids
        and len(remaining_task_ids) <= max_repair_tasks
        and repair_attempts > 0
    ):
        for repair_index in range(1, repair_attempts + 1):
            if not remaining_task_ids:
                break
            repair_label = f"repair-{repair_index}"
            filter_ids = [task_filter_id(task_id) for task_id in remaining_task_ids]
            repair_config = write_config(
                cell,
                sweep_id,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
                task_ids=filter_ids,
                attempt_label=repair_label,
            )
            log(
                f"REPAIR {cell.name}: attempt {repair_index}, "
                f"{len(filter_ids)} infrastructure-error tasks"
            )
            try:
                (
                    repair_code,
                    repair_parsed,
                    repair_stdout,
                    repair_stderr,
                ) = run_runner(repair_config, timeout_seconds=timeout_seconds)
            except subprocess.TimeoutExpired as error:
                repair_runner_status_ok = False
                attempts.append({
                    "label": repair_label,
                    "attempted": len(filter_ids),
                    "status": "timeout",
                })
                with logfile.open("a") as stream:
                    stream.write(
                        f"\n--- {repair_label} TIMEOUT ---\n{str(error)}\n"
                    )
                break
            with logfile.open("a") as stream:
                stream.write(
                    f"\n--- {repair_label} STDOUT ---\n{repair_stdout}"
                    f"\n--- {repair_label} STDERR ---\n{repair_stderr}\n"
                )
            if not repair_parsed:
                repair_runner_status_ok = False
                attempts.append({
                    "label": repair_label,
                    "attempted": len(filter_ids),
                    "status": "unparseable",
                    "runnerExitCode": repair_code,
                })
                break
            repair_output = resolve_output_directory(repair_parsed)
            repair_metadata = (
                read_json(repair_output / "run.json") if repair_output else None
            ) or {}
            repair_summary = (
                read_json(repair_output / "summary.json")
                if repair_output
                else None
            ) or repair_parsed.get("summary") or {}
            repair_results = (
                read_jsonl(repair_output / "results.jsonl")
                if repair_output
                else []
            )
            repair_attempted = int(
                repair_summary.get(
                    "attempted", repair_summary.get("total", len(repair_results))
                )
            )
            repair_errors = int(
                repair_summary.get("errors", len(filter_ids))
            )
            repair_cost = extract_artifact_cost(
                repair_parsed, repair_metadata, repair_results
            )
            repair_provider = repair_summary.get("provider", {})
            repair_cost_complete = (
                isinstance(repair_provider, dict)
                and repair_provider.get("costComplete") is True
                and repair_cost is not None
            )
            all_cost_complete = all_cost_complete and repair_cost_complete
            if total_artifact_cost is None or repair_cost is None:
                total_artifact_cost = None
            else:
                total_artifact_cost += repair_cost
            repair_complete = (
                repair_output is not None
                and repair_attempted == len(filter_ids)
                and len(repair_results) == len(filter_ids)
            )
            repair_artifacts_complete = (
                repair_artifacts_complete and repair_complete
            )
            repair_provenance_ok = (
                repair_provenance_ok
                and attempt_provenance_ok(
                    repair_metadata, cell, source["sourceRevision"]
                )
            )
            repair_identity_ok = (
                repair_identity_ok
                and model_identity_gate(
                    repair_metadata,
                    repair_results,
                    cell.model,
                    repair_attempted,
                )[0]
            )
            expected_repair_status = (
                "completed" if repair_errors == 0 else "completed_with_errors"
            )
            repair_runner_status_ok = (
                repair_runner_status_ok
                and repair_metadata.get("status") == expected_repair_status
                and (
                    (repair_errors == 0 and repair_code == 0)
                    or (repair_errors > 0 and repair_code != 0)
                )
            )
            repair_summaries.append(repair_summary)
            for repair_result in repair_results:
                task_id = repair_result.get("taskId")
                if (
                    isinstance(task_id, str)
                    and repair_result.get("status") == "ok"
                ):
                    combined_by_task[task_id] = repair_result
            remaining_task_ids = [
                task_id
                for task_id in remaining_task_ids
                if combined_by_task.get(task_id, {}).get("status") != "ok"
            ]
            attempts.append({
                "label": repair_label,
                "runId": repair_parsed.get("runId"),
                "outputDirectory": (
                    str(repair_output.relative_to(REPO))
                    if repair_output
                    else None
                ),
                "attempted": repair_attempted,
                "errors": repair_errors,
                "runnerExitCode": repair_code,
                "artifactCostUsd": repair_cost,
            })
    elif len(remaining_task_ids) > max_repair_tasks:
        log(
            f"NO REPAIR {cell.name}: automatic paid repair is disabled; "
            f"{len(remaining_task_ids)} infrastructure-error tasks remain"
        )

    if len(combined_by_task) == len(results):
        results = [
            combined_by_task.get(row.get("taskId"), row)
            for row in results
        ]
    expected_task_ids = {
        f"PAIR-{task_id}" for task_id in SURFACES[cell.surface][1]
    }
    result_task_ids = [
        row.get("taskId") for row in results if isinstance(row.get("taskId"), str)
    ]
    exact_task_set = (
        len(result_task_ids) == len(expected_task_ids)
        and len(set(result_task_ids)) == len(result_task_ids)
        and set(result_task_ids) == expected_task_ids
    )
    error_count = len(remaining_task_ids)
    summary = merge_summaries(summary, repair_summaries, error_count)
    error_rate = error_count / attempted if attempted else 1.0
    artifact_cost = total_artifact_cost
    identity = telemetry_identity(run_metadata, results)
    provider_summary = summary.get("provider", {})
    cost_complete = (
        all_cost_complete
        and isinstance(provider_summary, dict)
        and provider_summary.get("costComplete") is True
        and artifact_cost is not None
    )
    settleable_artifact_cost = settlement_artifact_cost(
        artifact_cost, cost_complete
    )
    identity_gate, identity = model_identity_gate(
        run_metadata, results, cell.model, attempted
    )
    base_attempt_identity_ok = model_identity_gate(
        run_metadata, original_results, cell.model, attempted
    )[0]
    identity_gate = (
        identity_gate and base_attempt_identity_ok and repair_identity_ok
    )
    complete = (
        output_directory is not None
        and attempted == cell.n_tasks
        and len(results) == cell.n_tasks
        and exact_task_set
        and isinstance(summary, dict)
    )
    runner_policy = run_metadata.get("policyProvenance")
    provenance_gate = (
        attempt_provenance_ok(
            run_metadata, cell, source["sourceRevision"]
        )
        and repair_provenance_ok
    )
    error_gate = error_rate <= max_error_rate
    expected_base_status = (
        "completed" if base_error_count == 0 else "completed_with_errors"
    )
    runner_status_ok = (
        run_metadata.get("status") == expected_base_status
        and (
            (base_error_count == 0 and code == 0)
            or (base_error_count > 0 and code != 0)
        )
        and repair_runner_status_ok
    )
    strict_gate_passed = (
        complete
        and error_gate
        and identity_gate
        and cost_complete
        and provenance_gate
        and repair_artifacts_complete
        and runner_status_ok
    )
    status = "ok" if strict_gate_passed else "invalid"
    aggregate_directory = REPO / OUT_DIR_REL / sweep_id / cell.name
    aggregate_directory.mkdir(parents=True, exist_ok=True)
    aggregate_summary_path = aggregate_directory / "aggregate-summary.json"
    aggregate_results_path = aggregate_directory / "aggregate-results.jsonl"
    attempts_path = aggregate_directory / "attempts.json"
    aggregate_summary_path.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
    )
    aggregate_results_path.write_text(
        "".join(json.dumps(result, sort_keys=True) + "\n" for result in results)
    )
    attempts_path.write_text(
        json.dumps(attempts, indent=2, sort_keys=True) + "\n"
    )
    elapsed = time.monotonic() - started

    row = {
        **base,
        "status": status,
        "strictGatePassed": strict_gate_passed,
        "runId": parsed.get("runId"),
        "outputDirectory": (
            str(output_directory.relative_to(REPO))
            if output_directory
            else None
        ),
        "artifactCostUsd": (
            round(settleable_artifact_cost, 8)
            if settleable_artifact_cost is not None
            else None
        ),
        **(
            {
                "observedPartialCostUsd": round(artifact_cost, 8),
            }
            if artifact_cost is not None and not cost_complete
            else {}
        ),
        "attempts": attempts,
        "repairAttemptsUsed": len(attempts) - 1,
        "aggregateSummary": str(aggregate_summary_path.relative_to(REPO)),
        "aggregateResults": str(aggregate_results_path.relative_to(REPO)),
        "attempted": attempted,
        "errorCount": error_count,
        "errorRate": round(error_rate, 8),
        "summary": summary,
        "modelIdentity": identity,
        "provenance": {
            **base["provenance"],
            "runnerConfigDigest": run_metadata.get("configDigest"),
            "runnerTaskSetDigest": run_metadata.get("taskSetDigest"),
            "runnerSourceRevision": run_metadata.get("sourceRevision"),
            "runnerPolicyProvenance": runner_policy,
        },
    }
    if status != "ok":
        row["failure"] = {
            "complete": complete,
            "exactTaskSet": exact_task_set,
            "errorGatePassed": error_gate,
            "modelIdentityGatePassed": identity_gate,
            "artifactCostComplete": cost_complete,
            "provenanceGatePassed": provenance_gate,
            "repairArtifactsComplete": repair_artifacts_complete,
            "runnerStatus": run_metadata.get("status"),
        }
        log(
            f"INVALID {cell.name}: attempted={attempted}/{cell.n_tasks}, "
            f"errors={error_count} ({error_rate:.1%}), exit={code}"
        )
    else:
        cost_label = (
            f"${artifact_cost:.4f}"
            if artifact_cost is not None
            else "cost unavailable"
        )
        log(
            f"DONE   {cell.name}: {cost_label}, {elapsed / 60:.1f}min, "
            f"errors={error_count}, repairs={len(attempts) - 1}"
        )
    return row


class BudgetLedger:
    """Conservative scheduler ledger with in-flight reservations."""

    def __init__(self, cap_usd: float, settled_usd: float = 0.0):
        self.cap_usd = cap_usd
        self.settled_usd = settled_usd
        self.active: dict[str, float] = {}

    @property
    def reserved_usd(self) -> float:
        return sum(self.active.values())

    @property
    def committed_usd(self) -> float:
        return self.settled_usd + self.reserved_usd

    def can_reserve(self, cell: Cell, amount: float) -> bool:
        return self.committed_usd + amount <= self.cap_usd + 1e-9

    def reserve(self, cell: Cell, amount: float) -> None:
        if not self.can_reserve(cell, amount):
            raise RuntimeError(f"budget reservation rejected for {cell.name}")
        self.active[cell.name] = amount

    def settle(self, cell: Cell, artifact_cost_usd: float | None) -> float:
        reserved = self.active.pop(cell.name)
        # Missing artifact cost is not treated as free. Keep the full reserve
        # committed, which prevents concurrent/account-delta ambiguity.
        charged = (
            max(0.0, artifact_cost_usd)
            if artifact_cost_usd is not None
            else reserved
        )
        self.settled_usd += charged
        return charged

    def observe_campaign_spend(self, observed_usd: float) -> None:
        # Account-wide usage is conservative: unrelated spend also consumes
        # this campaign's cap instead of allowing an accidental overrun.
        self.settled_usd = max(self.settled_usd, max(0.0, observed_usd))


def estimated_cost(cell: Cell) -> float:
    return cell.n_tasks * MODELS[cell.model].estimated_usd_per_task


def reservation_cost(cell: Cell, multiplier: float) -> float:
    return estimated_cost(cell) * multiplier


def acquire_lock(sweep_id: str) -> int:
    RUNS.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        try:
            existing = os.read(descriptor, 4_096).decode()
        except OSError:
            existing = ""
        os.close(descriptor)
        raise RuntimeError(
            "another sweep process holds the experiment lock"
            + (f": {existing}" if existing else "")
        ) from error
    os.ftruncate(descriptor, 0)
    os.write(
        descriptor,
        json.dumps({"pid": os.getpid(), "sweepId": sweep_id}).encode(),
    )
    os.fsync(descriptor)
    return descriptor


def release_lock(descriptor: int) -> None:
    fcntl.flock(descriptor, fcntl.LOCK_UN)
    os.close(descriptor)


def print_plan(
    cells: list[Cell],
    pending: list[Cell],
    *,
    blocks: list[str],
    models: list[str],
    budget: float,
    concurrency: int,
    per_model_concurrency: int,
    reservation_multiplier: float,
) -> None:
    print("PACT rebuttal experiment sweep")
    print("=" * 78)
    for block in blocks:
        print(f"  {block:14s} {BLOCK_DESCRIPTIONS[block]}")
    print(f"\n  models             : {', '.join(MODELS[m].model_id for m in models)}")
    print(
        f"  cells              : {len(cells)} total, "
        f"{len(cells) - len(pending)} strict-complete, {len(pending)} pending"
    )
    print(f"  pending tasks      : {sum(cell.n_tasks for cell in pending):,}")
    print(f"  scheduler cap      : ${budget:.2f}")
    print(f"  concurrency        : {concurrency} global / {per_model_concurrency} per model")
    print(f"  reservation factor : {reservation_multiplier:.2f}x estimate")
    print("\n  projected pending cost:")
    for model in models:
        subset = [cell for cell in pending if cell.model == model]
        estimate = sum(estimated_cost(cell) for cell in subset)
        reserve = sum(
            reservation_cost(cell, reservation_multiplier) for cell in subset
        )
        print(
            f"    {model:9s} {len(subset):3d} cells "
            f"estimate=${estimate:7.2f} reserve=${reserve:7.2f}"
        )
    total_estimate = sum(estimated_cost(cell) for cell in pending)
    total_reserve = sum(
        reservation_cost(cell, reservation_multiplier) for cell in pending
    )
    print(
        f"    {'TOTAL':9s} {len(pending):3d} cells "
        f"estimate=${total_estimate:7.2f} reserve=${total_reserve:7.2f}"
    )
    global_hours = (
        sum(cell.n_tasks for cell in pending) * 14 / concurrency / 3600
        if concurrency
        else 0
    )
    per_model_hours = [
        sum(cell.n_tasks for cell in pending if cell.model == model)
        * 14
        / per_model_concurrency
        / 3600
        for model in models
    ]
    estimated_hours = max([global_hours, *per_model_hours], default=0)
    print(
        f"\n  rough wall-clock   : {estimated_hours:.2f}h at 14s/task "
        "(includes per-model concurrency bottleneck)"
    )
    print(
        "  separate lanes     : alternate-family judge and JD3a Q2's original "
        "Pulse multi-turn States replication are not executed by this "
        "direct-responder sweep"
    )
    if total_reserve > budget:
        print(
            "  coverage warning   : reserved plan exceeds cap; skipped cells "
            "will be enumerated"
        )


def self_test() -> int:
    cells = build_cells(DEFAULT_BLOCKS, DEFAULT_MODELS)
    assert len(cells) == 37
    assert sum(cell.n_tasks for cell in cells) == 6_390
    counts = Counter(cell.block for cell in cells)
    assert counts == {
        "anchors": 12,
        "replications": 8,
        "todo_robustness": 3,
        "relationships": 10,
        "actions": 4,
    }
    assert len(RELATIONSHIP_FILE_IDS) == 99
    assert "Q125" not in RELATIONSHIP_FILE_IDS
    assert len({cell.name for cell in cells}) == len(cells)
    nested = (
        'npm notice\n{"runId":"root","summary":{"errors":0,'
        '"metrics":{"utility":0.5}}}\nnpm footer\n'
    )
    assert parse_last_json_object(nested) == {
        "runId": "root",
        "summary": {"errors": 0, "metrics": {"utility": 0.5}},
    }
    paired = [
        cell
        for cell in cells
        if cell.block == "anchors"
        and cell.model == "deepseek"
        and cell.replicate == 1
    ]
    assert len({cell.seed for cell in paired}) == 1
    d2_rep1 = next(
        cell
        for cell in cells
        if cell.block == "anchors"
        and cell.model == "deepseek"
        and cell.policy == "D2_SUBMITTED"
    )
    d2_rep2 = next(
        cell
        for cell in cells
        if cell.block == "replications"
        and cell.model == "deepseek"
        and cell.policy == "D2_SUBMITTED"
    )
    assert d2_rep1.seed != d2_rep2.seed
    source = {
        "sourceRevision": "a" * 40,
        "sourceStateSha256": "b" * 64,
    }
    reusable = {
        "status": "ok",
        "strictGatePassed": True,
        "scriptVersion": SCRIPT_VERSION,
        "cell": d2_rep1.name,
        **asdict(d2_rep1),
        "requestedModelId": MODELS[d2_rep1.model].model_id,
        "seed": d2_rep1.seed,
        "nTasks": d2_rep1.n_tasks,
        "experimentConfig": {
            "baseUrl": BASE_URL,
            "temperature": 0.0,
            "reasoning": REASONING_CONFIG,
            "reasoningApplied": True,
            "maxOutputTokens": 4096,
            "seedApplied": MODELS[d2_rep1.model].supports_seed,
            "providerRouting": {
                "requireParameters": True,
                "allowFallbacks": False,
                "only": [MODELS[d2_rep1.model].provider_slug],
            },
        },
        "provenance": {
            **source,
            "taskSetSha256": task_set_digest(d2_rep1),
            "policySha256": policy_digest(d2_rep1.policy),
        },
    }
    assert manifest_row_matches(
        reusable,
        d2_rep1,
        source,
        temperature=0.0,
        max_output_tokens=4096,
    )
    stale = {**reusable, "provenance": {**reusable["provenance"],
                                       "policySha256": "0" * 64}}
    assert not manifest_row_matches(
        stale,
        d2_rep1,
        source,
        temperature=0.0,
        max_output_tokens=4096,
    )
    ledger = BudgetLedger(10)
    example = cells[0]
    ledger.reserve(example, 4)
    assert not ledger.can_reserve(cells[1], 7)
    ledger.settle(example, None)
    assert ledger.settled_usd == 4
    assert settlement_artifact_cost(0.25, cost_complete=True) == 0.25
    assert settlement_artifact_cost(0.25, cost_complete=False) is None
    # Keep the scheduler call-site and the worker's keyword-only contract in
    # lockstep. Automatic paid repair is deliberately disabled: a failed cell
    # remains invalid and can only be rerun after its spend is accounted for.
    inspect.signature(run_cell).bind(
        example,
        "self-test",
        temperature=0.0,
        max_output_tokens=4096,
        max_error_rate=0.0,
        timeout_seconds=1,
        reservation_usd=1.0,
        source=source,
        campaign={
            "campaignId": "self-test",
            "capUsd": 10.0,
            "baselineTotalUsage": 0.0,
        },
        repair_attempts=0,
        max_repair_tasks=0,
    )
    print("self-test passed: 37 cells, 6,390 tasks, reservation and parsing invariants")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--blocks",
        default=",".join(DEFAULT_BLOCKS),
        help=f"comma-separated blocks: {', '.join(BLOCK_DESCRIPTIONS)}",
    )
    parser.add_argument(
        "--models",
        default=",".join(DEFAULT_MODELS),
        help=f"comma-separated aliases: {', '.join(MODELS)}",
    )
    parser.add_argument(
        "--budget",
        type=float,
        default=100.0,
        help="scheduler cap in USD; default 100 leaves $10 external buffer",
    )
    parser.add_argument(
        "--campaign-id",
        default=DEFAULT_CAMPAIGN_ID,
        help="persistent cumulative budget ledger id shared with paid preflight",
    )
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--per-model-concurrency", type=int, default=2)
    parser.add_argument("--reservation-multiplier", type=float, default=1.5)
    parser.add_argument(
        "--max-error-rate",
        type=float,
        default=0.0,
        help="maximum reportable infrastructure-error fraction (default 0)",
    )
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--cell-timeout-seconds", type=int, default=7200)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="run from a dirty worktree while recording its status hash",
    )
    parser.add_argument(
        "--skip-config-check",
        action="store_true",
        help="unsafe: skip runner schema/count validation",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if args.budget <= 0:
        parser.error("--budget must be positive")
    if args.concurrency < 1 or args.per_model_concurrency < 1:
        parser.error("concurrency values must be positive")
    if args.reservation_multiplier < 1:
        parser.error("--reservation-multiplier must be >= 1")
    if not 0 <= args.max_error_rate <= 1:
        parser.error("--max-error-rate must be between 0 and 1")
    if not 0 <= args.temperature <= 2:
        parser.error("--temperature must be between 0 and 2")

    blocks = [value.strip() for value in args.blocks.split(",") if value.strip()]
    models = [value.strip() for value in args.models.split(",") if value.strip()]
    unknown_blocks = sorted(set(blocks) - set(BLOCK_DESCRIPTIONS))
    unknown_models = sorted(set(models) - set(MODELS))
    if unknown_blocks:
        parser.error(f"unknown blocks: {', '.join(unknown_blocks)}")
    if unknown_models:
        parser.error(f"unknown models: {', '.join(unknown_models)}")

    source = git_provenance()
    if source["sourceDirty"] and not (args.dry_run or args.allow_dirty):
        raise RuntimeError(
            "worktree is dirty; commit the exact experiment implementation or "
            "pass --allow-dirty (the dirty-state hash will be recorded)"
        )

    cells = build_cells(blocks, models)
    already = (
        set()
        if args.force
        else done_cells(
            cells,
            source,
            temperature=args.temperature,
            max_output_tokens=args.max_output_tokens,
        )
    )
    pending = [cell for cell in cells if cell.name not in already]
    print_plan(
        cells,
        pending,
        blocks=blocks,
        models=models,
        budget=args.budget,
        concurrency=args.concurrency,
        per_model_concurrency=args.per_model_concurrency,
        reservation_multiplier=args.reservation_multiplier,
    )

    sweep_id = (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + uuid.uuid4().hex[:8]
    )
    if not args.skip_config_check:
        print("\nValidating every distinct config without API calls...")
        validation_errors = validate_configs(
            pending or cells,
            sweep_id,
            temperature=args.temperature,
            max_output_tokens=args.max_output_tokens,
        )
        if validation_errors:
            print("\nCONFIG VALIDATION FAILED — no paid calls were made:")
            for error in validation_errors:
                print(f"  - {error}")
            return 1
        print("  all semantic configurations and task counts passed")

    if args.dry_run:
        print("\n--dry-run: no model or credits endpoint was called.")
        for cell in pending:
            print(
                f"  {cell.name:78s} {cell.n_tasks:3d} tasks "
                f"est=${estimated_cost(cell):6.2f} "
                f"reserve=${reservation_cost(cell, args.reservation_multiplier):6.2f}"
            )
        return 0
    if not pending:
        print("\nNothing to do: every cell has a strict-gate-passing manifest row.")
        return 0

    key = load_env()
    lock_descriptor = acquire_lock(sweep_id)
    completed: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    skipped: list[tuple[Cell, float]] = []
    queue = list(pending)
    try:
        starting_credits = account_credits(key)
        campaign = load_or_create_campaign(
            key,
            args.campaign_id,
            args.budget,
            credits=starting_credits,
        )
        prior_campaign_spend = float(campaign["observedSpendUsd"])
        remaining_campaign_budget = args.budget - prior_campaign_spend
        if remaining_campaign_budget <= 0:
            raise RuntimeError(
                f"campaign {args.campaign_id} already spent "
                f"${prior_campaign_spend:.2f} of its ${args.budget:.2f} cap"
            )
        if starting_credits["remaining"] < remaining_campaign_budget:
            raise RuntimeError(
                f"only ${starting_credits['remaining']:.2f} account credit remains; "
                f"campaign has ${remaining_campaign_budget:.2f} unspent"
            )
        ledger = BudgetLedger(args.budget, prior_campaign_spend)
        last_observed_campaign_spend = prior_campaign_spend
        credit_poll_failed = False
        print(
            f"\n  campaign     : {args.campaign_id} "
            f"spent=${prior_campaign_spend:.4f}, "
            f"remaining=${remaining_campaign_budget:.4f}"
        )
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures: dict[Future[dict[str, Any]], tuple[Cell, float]] = {}
            while queue or futures:
                launched = False
                active_by_model = Counter(cell.model for cell, _ in futures.values())
                while not credit_poll_failed and len(futures) < args.concurrency:
                    candidate_index = None
                    for index, cell in enumerate(queue):
                        if active_by_model[cell.model] >= args.per_model_concurrency:
                            continue
                        reserve = reservation_cost(
                            cell, args.reservation_multiplier
                        )
                        if ledger.can_reserve(cell, reserve):
                            candidate_index = index
                            break
                    if candidate_index is None:
                        break
                    cell = queue.pop(candidate_index)
                    reserve = reservation_cost(cell, args.reservation_multiplier)
                    ledger.reserve(cell, reserve)
                    future = pool.submit(
                        run_cell,
                        cell,
                        sweep_id,
                        temperature=args.temperature,
                        max_output_tokens=args.max_output_tokens,
                        max_error_rate=args.max_error_rate,
                        timeout_seconds=args.cell_timeout_seconds,
                        reservation_usd=reserve,
                        source=source,
                        campaign=campaign,
                        repair_attempts=0,
                        max_repair_tasks=0,
                    )
                    futures[future] = (cell, reserve)
                    active_by_model[cell.model] += 1
                    launched = True

                if not futures:
                    # Remaining cells cannot fit the unspent reservation budget.
                    for cell in queue:
                        reserve = reservation_cost(
                            cell, args.reservation_multiplier
                        )
                        skipped.append((cell, reserve))
                        log(
                            f"SKIP   {cell.name}: reserve ${reserve:.2f} "
                            f"does not fit ${args.budget - ledger.committed_usd:.2f}"
                        )
                    queue.clear()
                    break

                if launched and len(futures) < args.concurrency:
                    # Pool is partially full because of per-model limits.
                    pass

                finished = next(as_completed(futures))
                cell, _ = futures.pop(finished)
                try:
                    row = finished.result()
                except Exception as error:  # one cell must not lose the manifest
                    row = {
                        "schemaVersion": 2,
                        "scriptVersion": SCRIPT_VERSION,
                        "sweepId": sweep_id,
                        "cell": cell.name,
                        **asdict(cell),
                        "status": "exception",
                        "strictGatePassed": False,
                        "artifactCostUsd": None,
                        "error": str(error)[:1_000],
                        "finishedAt": utc_now(),
                    }
                    log(f"ERROR  {cell.name}: {error}")
                charged = ledger.settle(cell, row.get("artifactCostUsd"))
                row["schedulerChargedUsd"] = round(charged, 8)
                # Persist the paid result before making any secondary account
                # request. A transient credits-endpoint failure must never
                # orphan an already completed cell and cause an accidental
                # paid rerun.
                append_manifest(row)
                (completed if row.get("status") == "ok" else invalid).append(row)

                try:
                    observed = max(
                        0.0,
                        account_credits(key)["totalUsage"]
                        - float(campaign["baselineTotalUsage"]),
                    )
                except Exception as error:
                    credit_poll_failed = True
                    log(
                        "CREDIT POLL FAILED after manifest persistence; "
                        f"new launches disabled: {str(error)[:300]}"
                    )
                else:
                    last_observed_campaign_spend = observed
                    ledger.observe_campaign_spend(observed)
                    append_manifest({
                        "schemaVersion": 2,
                        "recordType": "campaign_observation",
                        "scriptVersion": SCRIPT_VERSION,
                        "sweepId": sweep_id,
                        "afterCell": cell.name,
                        "campaignId": campaign["campaignId"],
                        "observedSpendUsd": round(observed, 8),
                        "observedAt": utc_now(),
                    })

                if ledger.settled_usd > args.budget + 1e-9:
                    credit_poll_failed = True
                    log(
                        "BUDGET CAP REACHED/EXCEEDED; "
                        "no additional cells will launch"
                    )
                if credit_poll_failed and queue:
                    for queued in queue:
                        skipped.append(
                            (
                                queued,
                                reservation_cost(
                                    queued, args.reservation_multiplier
                                ),
                            )
                        )
                    queue.clear()
        try:
            ending_credits = account_credits(key)
        except Exception as error:
            ending_credits = None
            ending_campaign_spend = last_observed_campaign_spend
            log(
                "FINAL CREDIT POLL FAILED; using the last persisted "
                f"campaign observation: {str(error)[:300]}"
            )
        else:
            ending_campaign_spend = max(
                0.0,
                ending_credits["totalUsage"]
                - float(campaign["baselineTotalUsage"]),
            )
            ledger.observe_campaign_spend(ending_campaign_spend)
    finally:
        release_lock(lock_descriptor)

    account_delta = (
        ending_credits["totalUsage"] - starting_credits["totalUsage"]
        if ending_credits is not None
        else None
    )
    print("\n" + "=" * 78)
    print(f"  strict-complete       : {len(completed)}")
    print(f"  invalid/failed        : {len(invalid)}")
    print(f"  skipped by reservation: {len(skipped)}")
    print(f"  campaign cumulative   : ${ending_campaign_spend:.4f} of ${args.budget:.2f}")
    print(f"  scheduler conservative: ${ledger.settled_usd:.4f}")
    print(
        "  account sweep delta   : "
        + (
            f"${account_delta:.4f} (aggregate audit only)"
            if account_delta is not None
            else "unavailable (final credits poll failed)"
        )
    )
    print(f"  manifest              : {MANIFEST.relative_to(REPO)}")
    if skipped:
        print("\nSKIPPED CELLS — coverage is incomplete:")
        for cell, reserve in skipped:
            print(f"  {cell.name:78s} reserve=${reserve:.2f}")
    if invalid:
        print("\nINVALID CELLS — do not report; reruns remain pending:")
        for row in invalid:
            print(
                f"  {row['cell']:78s} {row.get('status')} "
                f"errors={row.get('errorCount', '?')}"
            )
    return 1 if invalid or skipped else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"FATAL: {error}", file=sys.stderr)
        raise SystemExit(1)
