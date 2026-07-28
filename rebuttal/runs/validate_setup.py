#!/usr/bin/env python3
"""Strict preflight for the PACT rebuttal sweep.

No-spend mode validates the complete matrix, task counts, policies, grading
modes, and local provenance. Paid mode additionally runs small QA/action cells
through every requested responder model and rejects any infrastructure error,
missing artifact cost, or missing served-model provenance.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PULSE_ORCHESTRATOR = (
    Path(__file__).resolve().parents[3]
    / "pulse/research/scripts/rebuttal/run_experiments.py"
)

if __name__ == "__main__":
    unsupported = [arg for arg in sys.argv[1:] if arg != "--no-spend"]
    if unsupported:
        print(
            "The public-runner preflight is retired. Use the Pulse "
            "orchestrator directly for matrix/model options:\n"
            f"  python3 {PULSE_ORCHESTRATOR} --preflight ...",
            file=sys.stderr,
        )
        raise SystemExit(2)
    os.execv(
        sys.executable,
        [sys.executable, str(PULSE_ORCHESTRATOR), "--preflight"],
    )

from run_experiments import (
    BASE_URL,
    BLOCK_DESCRIPTIONS,
    DEFAULT_CAMPAIGN_ID,
    DEFAULT_BLOCKS,
    DEFAULT_MODELS,
    MODELS,
    POLICY_DIR,
    POLICY_FILES,
    REASONING_CONFIG,
    REASONING_EFFORT,
    REPO,
    Cell,
    account_credits,
    acquire_lock,
    build_cells,
    extract_artifact_cost,
    git_provenance,
    load_env,
    load_or_create_campaign,
    policy_digest,
    read_json,
    read_jsonl,
    release_lock,
    resolve_output_directory,
    run_runner,
    task_telemetry_complete,
    telemetry_identity,
    validate_configs,
    write_config,
)

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"
failures: list[str] = []


def ok(message: str) -> None:
    print(f"  {GREEN}PASS{RESET}  {message}")


def fail(message: str) -> None:
    print(f"  {RED}FAIL{RESET}  {message}")
    failures.append(message)


def warn(message: str) -> None:
    print(f"  {YELLOW}WARN{RESET}  {message}")


def check_key_and_credits() -> tuple[str, float]:
    print("\n[1] Credential and credits")
    try:
        key = load_env()
    except RuntimeError as error:
        fail(str(error))
        raise SystemExit(1) from error
    # Deliberately never print any part, length, or fingerprint of the secret.
    ok("dedicated PACT model credential loaded without exposing it")
    try:
        credits = account_credits(key)
    except urllib.error.HTTPError as error:
        fail(f"credits endpoint returned HTTP {error.code}")
        raise SystemExit(1) from error
    ok(
        f"credits endpoint accepted the key; "
        f"${credits['remaining']:.2f} remains"
    )
    return key, credits["remaining"]


def check_source(allow_dirty: bool) -> dict[str, Any]:
    print("\n[3] Source provenance")
    source = git_provenance()
    ok(f"source revision {source['sourceRevision']}")
    if source["sourceDirty"]:
        message = (
            "worktree is dirty; experiment artifacts would not identify a "
            "committed implementation"
        )
        if allow_dirty:
            warn(
                message
                + f" (status hash {source['sourceStatusSha256'][:12]})"
            )
        else:
            fail(message + "; commit first or explicitly pass --allow-dirty")
    else:
        ok("worktree is clean")
    return source


def check_model_metadata(
    key: str, models: list[str], max_output_tokens: int
) -> dict[str, dict[str, float]]:
    print("\n[2] OpenRouter model metadata (no model calls)")
    base_required_parameters = {
        "tools",
        "tool_choice",
        "temperature",
        "max_tokens",
        "reasoning",
        "reasoning_effort",
    }
    pricing: dict[str, dict[str, float]] = {}
    for alias in models:
        model_spec = MODELS[alias]
        expected_id = model_spec.model_id
        required_parameters = set(base_required_parameters)
        if model_spec.supports_seed:
            required_parameters.add("seed")
        request = urllib.request.Request(
            f"{BASE_URL}/model/{expected_id}",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read())
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError) as error:
            fail(f"{alias}: model metadata request failed: {error}")
            continue
        data = payload.get("data") if isinstance(payload, dict) else None
        if (
            not isinstance(data, dict)
            or data.get("id") != expected_id
            or data.get("canonical_slug") != model_spec.canonical_model_id
        ):
            fail(
                f"{alias}: model/canonical identity mismatch for {expected_id!r}"
            )
            continue
        supported = set(data.get("supported_parameters") or [])
        missing = sorted(required_parameters - supported)
        if missing:
            fail(f"{alias}: required parameters are unsupported: {', '.join(missing)}")
            continue
        endpoint_request = urllib.request.Request(
            f"{BASE_URL}/models/{expected_id}/endpoints",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(endpoint_request, timeout=30) as response:
                endpoint_payload = json.loads(response.read())
        except (
            urllib.error.HTTPError,
            urllib.error.URLError,
            json.JSONDecodeError,
        ) as error:
            fail(f"{alias}: endpoint metadata request failed: {error}")
            continue
        endpoint_data = (
            endpoint_payload.get("data")
            if isinstance(endpoint_payload, dict)
            else None
        )
        endpoints = (
            endpoint_data.get("endpoints")
            if isinstance(endpoint_data, dict)
            else None
        )
        matching_endpoints = [
            endpoint
            for endpoint in (endpoints or [])
            if isinstance(endpoint, dict)
            and endpoint.get("provider_name") == model_spec.provider_name
            and endpoint.get("tag") == model_spec.provider_slug
            and endpoint.get("status") == 0
        ]
        if len(matching_endpoints) != 1:
            fail(
                f"{alias}: expected one active {model_spec.provider_slug} "
                f"endpoint, found {len(matching_endpoints)}"
            )
            continue
        endpoint = matching_endpoints[0]
        endpoint_supported = set(endpoint.get("supported_parameters") or [])
        endpoint_missing = sorted(required_parameters - endpoint_supported)
        if endpoint_missing:
            fail(
                f"{alias}: pinned {model_spec.provider_slug} endpoint lacks "
                f"{', '.join(endpoint_missing)}"
            )
            continue
        raw_pricing = endpoint.get("pricing")
        try:
            prompt_price = float(raw_pricing["prompt"])
            completion_price = float(raw_pricing["completion"])
        except (KeyError, TypeError, ValueError):
            fail(f"{alias}: prompt/completion pricing is unavailable")
            continue
        if prompt_price < 0 or completion_price < 0:
            fail(f"{alias}: model pricing is negative")
            continue
        max_completion = endpoint.get("max_completion_tokens")
        if (
            isinstance(max_completion, int)
            and max_completion < max_output_tokens
        ):
            fail(
                f"{alias}: max completion {max_completion} is below configured "
                f"{max_output_tokens}"
            )
            continue
        pricing[alias] = {
            "promptUsdPerToken": prompt_price,
            "completionUsdPerToken": completion_price,
        }
        ok(
            f"{alias:9s} exact id; required parameters present; "
            f"provider={model_spec.provider_slug}; "
            f"seed={'on' if model_spec.supports_seed else 'off'}; "
            f"reasoning={REASONING_EFFORT}; "
            f"prompt=${prompt_price * 1_000_000:.4f}/M, "
            f"completion=${completion_price * 1_000_000:.4f}/M"
        )
    return pricing


def check_policy_artifacts(cells: list[Cell]) -> None:
    print("\n[4] Frozen policy artifacts")
    required = sorted({cell.policy for cell in cells})
    for policy in required:
        filename = POLICY_FILES.get(policy)
        path = POLICY_DIR / filename if filename else Path("")
        digest = policy_digest(policy)
        if not filename or not path.is_file() or not digest:
            fail(f"{policy}: frozen policy file is missing")
            continue
        ok(f"{policy:20s} {filename:28s} sha256={digest[:12]}")

    tsx = REPO / "node_modules/.bin/tsx"
    command = (
        "import { PACT_POLICY_FILES_V1, getPactPolicySha256V1 } "
        "from './src/runner/v1/prompt.ts'; "
        "console.log(JSON.stringify(Object.fromEntries("
        "Object.keys(PACT_POLICY_FILES_V1).map(id => "
        "[id, getPactPolicySha256V1("
        "id as keyof typeof PACT_POLICY_FILES_V1)]))))"
    )
    try:
        process = subprocess.run(
            [str(tsx), "-e", command],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        runner_hashes = json.loads(process.stdout.strip())
    except (
        OSError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        json.JSONDecodeError,
    ) as error:
        fail(f"could not compare policy hashes with the TypeScript runner: {error}")
        return
    mismatches = {
        policy: (runner_digest, policy_digest(policy))
        for policy, runner_digest in runner_hashes.items()
        if policy_digest(policy) != runner_digest
    }
    if mismatches:
        fail(f"Python/runner policy hash mismatch: {mismatches}")
    else:
        ok(f"all {len(runner_hashes)} Python policy hashes match the runner")


def check_matrix_configs(
    cells: list[Cell],
    sweep_id: str,
    *,
    temperature: float,
    max_output_tokens: int,
) -> None:
    print("\n[5] Complete matrix schema and task-count validation (no API calls)")
    errors = validate_configs(
        cells,
        sweep_id,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
    )
    if errors:
        for error in errors:
            fail(error)
        return
    ok(
        f"{len(cells)} cells validated; "
        f"{sum(cell.n_tasks for cell in cells):,} selected task attempts"
    )
    relationship = [cell for cell in cells if cell.block == "relationships"]
    if relationship and any(cell.n_tasks != 99 for cell in relationship):
        fail("relationship block must contain exactly 99 labelled Files tasks/cell")
    elif relationship:
        ok("relationship cells use only the 99 requester-labelled Files items")


def smoke_ids(surface: str, count: int) -> list[str]:
    candidates = {
        "files": ["Q1", "Q50", "Q101", "Q151", "Q199", "Q200"],
        "actions": ["A1", "A50", "A151", "A199", "A101", "A200"],
        # R1 composition for the first four: L, P, B, P.
        "relationship_files": ["Q121", "Q101", "Q103", "Q151"],
    }[surface]
    return candidates[:count]


def check_smoke_design(count: int) -> None:
    print("\n[6] Smoke-set balance (no model calls)")
    relationship_data = json.loads(
        (REPO / "pact_pair/relationship_labels/relationship_label_matrix.json")
        .read_text()
    )
    relationship_rows = {
        f"Q{row['id']}": row
        for row in relationship_data["labels"]
    }
    relationship_ids = smoke_ids("relationship_files", min(count, 4))
    relationship_counts = Counter(
        relationship_rows[task_id]["R1"] for task_id in relationship_ids
    )
    expected_relationship = Counter({"P": 2, "L": 1, "B": 1})
    if len(relationship_ids) == 4 and relationship_counts != expected_relationship:
        fail(
            "R1 relationship smoke is not P=2/L=1/B=1: "
            f"{dict(relationship_counts)}"
        )
    else:
        ok(
            f"R1 relationship smoke {relationship_ids}: "
            f"{dict(relationship_counts)}"
        )

    task_data = json.loads(
        (REPO / "pact_pair/tasks/questions.json").read_text()
    )
    action_verdicts = {
        f"A{row['id']}": row["expected_verdict"]
        for row in task_data["actions"]
    }
    action_ids = smoke_ids("actions", count)
    action_counts = Counter(action_verdicts[task_id] for task_id in action_ids)
    if count == 4 and action_counts != Counter({"execute": 2, "refuse": 2}):
        fail(f"action smoke is not execute=2/refuse=2: {dict(action_counts)}")
    else:
        ok(f"action smoke {action_ids}: {dict(action_counts)}")


def inspect_smoke(
    cell: Cell,
    parsed: dict[str, Any] | None,
    exit_code: int,
    stderr: str,
    *,
    max_error_rate: float,
    expected_source_revision: str,
) -> dict[str, Any] | None:
    if not parsed:
        fail(f"{cell.name}: no parseable runner output; {stderr[:240]}")
        return None
    output_directory = resolve_output_directory(parsed)
    if not output_directory:
        fail(f"{cell.name}: output directory missing or outside repository")
        return None
    run_metadata = read_json(output_directory / "run.json") or {}
    summary = read_json(output_directory / "summary.json") or {}
    rows = read_jsonl(output_directory / "results.jsonl")
    attempted = int(summary.get("attempted", summary.get("total", len(rows))))
    errors = int(summary.get("errors", attempted))
    error_rate = errors / attempted if attempted else 1.0
    if attempted != cell.n_tasks or len(rows) != cell.n_tasks:
        fail(
            f"{cell.name}: incomplete artifact "
            f"({attempted} summary / {len(rows)} rows / {cell.n_tasks} expected)"
        )
    if exit_code != 0:
        fail(f"{cell.name}: runner exited {exit_code}; errors={errors}")
    if error_rate > max_error_rate:
        fail(
            f"{cell.name}: infrastructure errors {errors}/{attempted} "
            f"exceed {max_error_rate:.1%}"
        )
    if any(row.get("status") != "ok" for row in rows):
        fail(f"{cell.name}: at least one task artifact is not status=ok")
    if any(row.get("evaluation") is None for row in rows):
        fail(f"{cell.name}: at least one task has no valid evaluation")

    provenance = run_metadata.get("policyProvenance")
    benchmark = run_metadata.get("benchmark")
    run_model = run_metadata.get("model")
    if not (
        isinstance(provenance, dict)
        and provenance.get("id") == cell.policy
        and provenance.get("sha256") == policy_digest(cell.policy)
        and isinstance(benchmark, dict)
        and benchmark.get("policy") == cell.policy
        and benchmark.get("requester") == cell.requester
        and benchmark.get("gradingMode") == cell.grading_mode
        and isinstance(run_model, dict)
        and run_model.get("reasoning") == REASONING_CONFIG
        and isinstance(run_metadata.get("configDigest"), str)
        and len(run_metadata["configDigest"]) == 64
        and isinstance(run_metadata.get("taskSetDigest"), str)
        and len(run_metadata["taskSetDigest"]) == 64
        and run_metadata.get("sourceRevision") == expected_source_revision
    ):
        fail(f"{cell.name}: policy/config/task/source provenance is incomplete")

    identity = telemetry_identity(run_metadata, rows)
    model_spec = MODELS[cell.model]
    expected = model_spec.model_id
    allowed_served_models = {
        model_spec.model_id,
        model_spec.canonical_model_id,
    }
    if identity["requestedModels"] != [expected]:
        fail(
            f"{cell.name}: requested-model provenance is "
            f"{identity['requestedModels']!r}, expected {[expected]!r}"
        )
    if (
        not identity["servedModels"]
        or not set(identity["servedModels"]).issubset(allowed_served_models)
    ):
        fail(
            f"{cell.name}: served models {identity['servedModels']!r} are not "
            f"within {sorted(allowed_served_models)!r}"
        )
    if identity["providers"] != [model_spec.provider_name]:
        fail(
            f"{cell.name}: provider route is {identity['providers']!r}, "
            f"expected {[model_spec.provider_name]!r}"
        )
    if identity["responseIdCount"] < cell.n_tasks:
        fail(
            f"{cell.name}: only {identity['responseIdCount']} provider response "
            f"IDs across {cell.n_tasks} tasks"
        )
    if not task_telemetry_complete(
        rows,
        expected,
        allowed_served_models,
        model_spec.provider_name,
    ):
        fail(
            f"{cell.name}: at least one provider request lacks requested/served "
            "model, provider route, or response identity"
        )

    cost = extract_artifact_cost(parsed, run_metadata, rows)
    if cost is None:
        fail(
            f"{cell.name}: artifact-level usage cost is absent; "
            "account-wide deltas are invalid under concurrency"
        )
    elif cost < 0:
        fail(f"{cell.name}: artifact cost is negative")
    provider_summary = summary.get("provider", {})
    cost_complete = (
        isinstance(provider_summary, dict)
        and provider_summary.get("costComplete") is True
    )
    if not cost_complete:
        fail(
            f"{cell.name}: provider usage cost is incomplete across requests"
        )

    if (
        attempted == cell.n_tasks
        and len(rows) == cell.n_tasks
        and exit_code == 0
        and error_rate <= max_error_rate
        and identity["requestedModels"] == [expected]
        and set(identity["servedModels"]).issubset(allowed_served_models)
        and identity["providers"] == [model_spec.provider_name]
        and task_telemetry_complete(
            rows,
            expected,
            allowed_served_models,
            model_spec.provider_name,
        )
        and cost is not None
        and cost_complete
    ):
        ok(
            f"{cell.model:9s} {cell.surface:18s} "
            f"{attempted} tasks, errors={errors}, cost=${cost:.5f}, "
            f"served={','.join(identity['servedModels'])}, "
            f"provider={','.join(identity['providers'])}"
        )
    return {
        "cell": cell,
        "identity": identity,
        "cost": cost,
        "rows": rows,
    }


def paid_smokes(
    models: list[str],
    *,
    count: int,
    max_error_rate: float,
    temperature: float,
    max_output_tokens: int,
    timeout_seconds: int,
    source_revision: str,
) -> None:
    print("\n[7] Strict runner smokes (paid)")
    smoke_results: list[dict[str, Any]] = []
    sweep_id = "preflight-" + __import__("uuid").uuid4().hex[:10]
    for model in models:
        for surface in ("files", "actions"):
            ids = smoke_ids(surface, count)
            original = (
                ("qa", ids) if surface == "files" else ("action", ids)
            )
            # write_config reads the shared surface registry. A local smoke key
            # avoids mutating the prespecified production matrix.
            from run_experiments import SURFACES

            smoke_surface = f"_smoke_{surface}_{model}"
            SURFACES[smoke_surface] = original
            cell = Cell(
                "smoke",
                model,
                "D2_SUBMITTED",
                smoke_surface,
                "R1",
                "category",
                0,
            )
            config = write_config(
                cell,
                sweep_id,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            )
            failure_count_before = len(failures)
            code, parsed, _, stderr = run_runner(
                config, timeout_seconds=timeout_seconds
            )
            result = inspect_smoke(
                cell,
                parsed,
                code,
                stderr,
                max_error_rate=max_error_rate,
                expected_source_revision=source_revision,
            )
            if result:
                smoke_results.append(result)
            if len(failures) > failure_count_before:
                warn(
                    f"aborting remaining paid smokes after strict failure in "
                    f"{cell.name}"
                )
                return

    # The default primary relationship block uses DeepSeek. Exercise the
    # relationship-tailored prompt and relationship grading before the sweep.
    if "deepseek" in models:
        from run_experiments import SURFACES

        smoke_surface = "_smoke_relationship_deepseek"
        ids = smoke_ids("relationship_files", min(count, 4))
        SURFACES[smoke_surface] = ("qa", ids)
        cell = Cell(
            "smoke",
            "deepseek",
            "REL_R1",
            smoke_surface,
            "R1",
            "relationship",
            0,
        )
        config = write_config(
            cell,
            sweep_id,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        failure_count_before = len(failures)
        code, parsed, _, stderr = run_runner(
            config, timeout_seconds=timeout_seconds
        )
        result = inspect_smoke(
            cell,
            parsed,
            code,
            stderr,
            max_error_rate=max_error_rate,
            expected_source_revision=source_revision,
        )
        if result:
            smoke_results.append(result)
        if len(failures) > failure_count_before:
            warn(
                f"aborting remaining paid smokes after strict failure in "
                f"{cell.name}"
            )
            return

        # Exercise every new causal ablation live before committing the full
        # matrix. Two category-scored items per policy keep this bounded.
        for policy in (
            "A_LONG_GENERIC",
            "A_CATEGORY_ONLY",
            "A_CATEGORY_EXAMPLES",
        ):
            smoke_surface = f"_smoke_{policy.lower()}_deepseek"
            SURFACES[smoke_surface] = ("qa", ["Q1", "Q101"])
            cell = Cell(
                "smoke",
                "deepseek",
                policy,
                smoke_surface,
                "R1",
                "category",
                0,
            )
            config = write_config(
                cell,
                sweep_id,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            )
            failure_count_before = len(failures)
            code, parsed, _, stderr = run_runner(
                config, timeout_seconds=timeout_seconds
            )
            result = inspect_smoke(
                cell,
                parsed,
                code,
                stderr,
                max_error_rate=max_error_rate,
                expected_source_revision=source_revision,
            )
            if result:
                smoke_results.append(result)
            if len(failures) > failure_count_before:
                warn(
                    f"aborting remaining paid smokes after strict failure in "
                    f"{cell.name}"
                )
                return

    print("\n[8] Model-routing differential")
    by_alias = {
        result["cell"].model: result["identity"]["servedModels"]
        for result in smoke_results
        if result["cell"].surface.startswith("_smoke_files")
    }
    if len(models) >= 2:
        missing = [model for model in models if model not in by_alias]
        if missing:
            fail(
                "cannot verify model differential because smokes are missing: "
                + ", ".join(missing)
            )
        elif len({tuple(by_alias[model]) for model in models}) != len(models):
            fail(
                "two requested aliases resolved to the same served-model set: "
                + json.dumps(by_alias)
            )
        else:
            ok(
                "requested model aliases have distinct persisted served-model "
                "identities"
            )
    else:
        ok("single-model preflight; served-model identity was checked above")


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
        "--no-spend",
        action="store_true",
        help="run all local/config checks but make no model calls",
    )
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--smoke-tasks-per-surface", type=int, default=4)
    parser.add_argument("--max-error-rate", type=float, default=0.0)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--campaign-id", default=DEFAULT_CAMPAIGN_ID)
    parser.add_argument("--budget", type=float, default=100.0)
    parser.add_argument(
        "--preflight-reserve",
        type=float,
        default=5.0,
        help="campaign budget reserved before paid smoke calls",
    )
    args = parser.parse_args()

    blocks = [value.strip() for value in args.blocks.split(",") if value.strip()]
    models = [value.strip() for value in args.models.split(",") if value.strip()]
    unknown_blocks = sorted(set(blocks) - set(BLOCK_DESCRIPTIONS))
    unknown_models = sorted(set(models) - set(MODELS))
    if unknown_blocks:
        parser.error(f"unknown blocks: {', '.join(unknown_blocks)}")
    if unknown_models:
        parser.error(f"unknown models: {', '.join(unknown_models)}")
    if not 1 <= args.smoke_tasks_per_surface <= 6:
        parser.error("--smoke-tasks-per-surface must be between 1 and 6")
    if not 0 <= args.max_error_rate <= 1:
        parser.error("--max-error-rate must be between 0 and 1")
    if args.budget <= 0 or args.preflight_reserve <= 0:
        parser.error("--budget and --preflight-reserve must be positive")

    print("PACT rebuttal sweep — strict preflight")
    print("=" * 72)
    key, remaining = check_key_and_credits()
    check_model_metadata(key, models, args.max_output_tokens)
    source = check_source(args.allow_dirty)
    cells = build_cells(blocks, models)
    check_policy_artifacts(cells)
    check_matrix_configs(
        cells,
        "preflight-config",
        temperature=args.temperature,
        max_output_tokens=args.max_output_tokens,
    )
    check_smoke_design(args.smoke_tasks_per_surface)
    if remaining < 110:
        warn(
            f"remaining credit is ${remaining:.2f}; lower than the full external "
            "$110 research budget"
        )

    if args.no_spend:
        print(
            f"\n{YELLOW}--no-spend: strict paid smokes and actual model-route "
            f"verification were skipped{RESET}"
        )
    elif failures:
        warn("paid smokes skipped because a no-spend prerequisite failed")
    else:
        lock_descriptor = acquire_lock("preflight")
        try:
            credits_before = account_credits(key)
            campaign = load_or_create_campaign(
                key,
                args.campaign_id,
                args.budget,
                credits=credits_before,
            )
            spent_before = float(campaign["observedSpendUsd"])
            if spent_before + args.preflight_reserve > args.budget:
                fail(
                    f"campaign {args.campaign_id} has ${spent_before:.2f} spent; "
                    f"${args.preflight_reserve:.2f} preflight reserve exceeds "
                    f"the ${args.budget:.2f} cap"
                )
            elif credits_before["remaining"] < args.preflight_reserve:
                fail(
                    f"only ${credits_before['remaining']:.2f} account credit "
                    f"remains; paid preflight reserves "
                    f"${args.preflight_reserve:.2f}"
                )
            else:
                ok(
                    f"campaign {args.campaign_id}: ${spent_before:.4f} spent, "
                    f"${args.budget - spent_before:.4f} remains"
                )
                paid_smokes(
                    models,
                    count=args.smoke_tasks_per_surface,
                    max_error_rate=args.max_error_rate,
                    temperature=args.temperature,
                    max_output_tokens=args.max_output_tokens,
                    timeout_seconds=args.timeout_seconds,
                    source_revision=source["sourceRevision"],
                )
                try:
                    credits_after = account_credits(key)
                except Exception as error:
                    fail(
                        "final credits poll failed after paid smokes; "
                        f"campaign spend cannot be reconciled: {str(error)[:240]}"
                    )
                else:
                    spent_after = max(
                        0.0,
                        credits_after["totalUsage"]
                        - float(campaign["baselineTotalUsage"]),
                    )
                    print(
                        f"\n  campaign cumulative spend after preflight: "
                        f"${spent_after:.4f} / ${args.budget:.2f}"
                    )
                    preflight_spend = max(0.0, spent_after - spent_before)
                    if spent_after > args.budget + 1e-9:
                        fail(
                            f"campaign cap exceeded after paid preflight: "
                            f"${spent_after:.4f} > ${args.budget:.2f}"
                        )
                    if preflight_spend > args.preflight_reserve + 1e-9:
                        fail(
                            f"paid preflight used ${preflight_spend:.4f}, above "
                            f"its ${args.preflight_reserve:.2f} reservation"
                        )
        finally:
            release_lock(lock_descriptor)

    print("\n" + "=" * 72)
    if failures:
        print(f"{RED}{len(failures)} check(s) failed:{RESET}")
        for message in failures:
            print(f"  - {message}")
        print("\nDO NOT START THE SWEEP.")
        return 1
    if args.no_spend:
        print(
            f"{YELLOW}Local checks passed, but paid preflight is still required."
            f"{RESET}"
        )
        return 0
    print(f"{GREEN}All strict checks passed. The sweep is ready to launch.{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
