#!/usr/bin/env python3
"""Serve a local, read-only view of PACT rebuttal sweep progress.

The server intentionally exposes only:

* ``index.html`` from this directory;
* aggregate metadata derived from allowlisted ``results.jsonl`` files; and
* the parsed or raw contents of those exact ``results.jsonl`` files.

It never serves directories, ``trace.jsonl``, ``run.json``, ``.env`` files, or
paths supplied by a client. Cell identifiers are opaque hashes resolved against
a fresh registry of result files found below ``rebuttal/runs/out``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import threading
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, quote, urlsplit


VIEWER_DIR = Path(__file__).resolve().parent
INDEX_FILE = VIEWER_DIR / "index.html"
OUT_ROOT = VIEWER_DIR.parent / "runs" / "out"
LOOPBACK_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
APP_VERSION = "2026-07-28"

SAFE_SWEEP_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")
PRODUCTION_SWEEP_ID = re.compile(
    r"^20\d{6}T\d{6}Z-[A-Za-z0-9][A-Za-z0-9_-]*$"
)
OPAQUE_CELL_ID = re.compile(r"^[0-9a-f]{64}$")
RUN_DIRECTORY = re.compile(r"^pact-\d{4}-")
MAX_QUERY_LENGTH = 4096
MAX_RUN_JSON_BYTES = 5 * 1024 * 1024


class DashboardError(Exception):
    """An expected request or local-artifact error."""

    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Sweep:
    """One immediate child directory of the configured output root."""

    sweep_id: str
    path: Path
    kind: str
    modified_at: str
    cell_count: int

    def public(self) -> dict[str, Any]:
        return {
            "id": self.sweep_id,
            "kind": self.kind,
            "modifiedAt": self.modified_at,
            "cellCount": self.cell_count,
        }


@dataclass(frozen=True)
class CellSource:
    """An allowlisted result artifact and its non-path public identity."""

    cell_id: str
    sweep_id: str
    name: str
    results_path: Path
    run_path: Path | None


@dataclass
class CachedCell:
    """Cached aggregate for a cell whose source files have not changed."""

    fingerprint: tuple[int, int, int, int]
    value: dict[str, Any]


def _utc_iso(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _safe_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _safe_nonnegative_int(value: Any) -> int | None:
    number = _safe_number(value)
    if number is None or number < 0:
        return None
    return int(number)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _classify_sweep(sweep_id: str) -> str:
    if PRODUCTION_SWEEP_ID.fullmatch(sweep_id):
        return "production"
    if sweep_id.startswith("preflight-"):
        return "preflight"
    if sweep_id.startswith("probe-"):
        return "probe"
    if sweep_id.startswith("pact-"):
        return "standalone"
    return "other"


def _safe_sweep_entry(entry: Path, out_root: Path) -> bool:
    """Accept only real, immediate child directories with conservative names."""

    if (
        not SAFE_SWEEP_ID.fullmatch(entry.name)
        or ".." in entry.name
        or entry.name.startswith(".")
        or entry.is_symlink()
        or not entry.is_dir()
    ):
        return False
    try:
        resolved = entry.resolve(strict=True)
    except OSError:
        return False
    return resolved.parent == out_root


def _walk_result_files(sweep_path: Path) -> Iterator[Path]:
    """Yield only real ``results.jsonl`` files contained by one sweep."""

    for current, directory_names, file_names in os.walk(
        sweep_path, followlinks=False
    ):
        directory_names[:] = sorted(
            name
            for name in directory_names
            if not name.startswith(".")
            and not (Path(current) / name).is_symlink()
        )
        if "results.jsonl" not in file_names:
            continue
        candidate = Path(current) / "results.jsonl"
        if candidate.is_symlink() or not candidate.is_file():
            continue
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if _is_within(resolved, sweep_path):
            yield resolved


def _read_run_json(path: Path | None) -> dict[str, Any]:
    """Read run metadata without ever returning or forwarding its raw content."""

    if path is None or path.is_symlink() or not path.is_file():
        return {}
    try:
        stat = path.stat()
        if stat.st_size > MAX_RUN_JSON_BYTES:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _iter_rows(path: Path) -> Iterator[tuple[int, dict[str, Any] | None, str | None]]:
    """Read a changing JSONL file safely, tolerating an incomplete final line."""

    try:
        handle = path.open("rb")
    except OSError as error:
        raise DashboardError(
            HTTPStatus.SERVICE_UNAVAILABLE,
            f"Could not read the selected result artifact: {error.strerror}.",
        ) from error

    with handle:
        for line_number, raw_line in enumerate(handle, start=1):
            if not raw_line.strip():
                continue
            try:
                row = json.loads(raw_line.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                # A writer may be midway through its final JSON object. That is
                # not a corrupted task result and will be picked up next poll.
                if not raw_line.endswith(b"\n"):
                    yield line_number, None, "incomplete"
                else:
                    yield line_number, None, f"invalid JSON: {error}"
                continue
            if not isinstance(row, dict):
                yield line_number, None, "JSONL row is not an object"
                continue
            yield line_number, row, None


def _model_from_run(run: dict[str, Any]) -> str | None:
    model = run.get("model")
    if not isinstance(model, dict):
        return None
    value = model.get("model")
    return value if isinstance(value, str) and value else None


def _benchmark_field(run: dict[str, Any], field: str) -> str | None:
    benchmark = run.get("benchmark")
    if not isinstance(benchmark, dict):
        return None
    value = benchmark.get(field)
    return value if isinstance(value, str) and value else None


def _planned_tasks(run: dict[str, Any]) -> int:
    benchmark = run.get("benchmark")
    if not isinstance(benchmark, dict):
        return 0
    tasks = benchmark.get("tasks")
    if not isinstance(tasks, dict):
        return 0
    identifiers = tasks.get("ids")
    return len(identifiers) if isinstance(identifiers, list) else 0


def _request_metrics(row: dict[str, Any]) -> dict[str, Any]:
    """Extract request accounting using telemetry totals without double counting."""

    telemetry = row.get("providerTelemetry")
    if not isinstance(telemetry, dict):
        telemetry = {}
    request_values = telemetry.get("requests")
    requests = (
        [value for value in request_values if isinstance(value, dict)]
        if isinstance(request_values, list)
        else []
    )
    totals = telemetry.get("totals")
    if not isinstance(totals, dict):
        totals = {}

    logical_requests = _safe_nonnegative_int(totals.get("requests"))
    if logical_requests is None:
        logical_requests = len(requests)

    http_attempts = 0
    providers: set[str] = set()
    served_models: set[str] = set()
    fallback_cost = 0.0
    for request in requests:
        attempts = _safe_nonnegative_int(request.get("attempts"))
        http_attempts += attempts if attempts is not None else 1
        provider = request.get("provider")
        if isinstance(provider, str) and provider:
            providers.add(provider)
        served_model = request.get("servedModel")
        if isinstance(served_model, str) and served_model:
            served_models.add(served_model)
        usage = request.get("usage")
        if isinstance(usage, dict):
            cost = _safe_number(usage.get("costUsd"))
            if cost is not None and cost >= 0:
                fallback_cost += cost

    cost_usd = _safe_number(totals.get("costUsd"))
    if cost_usd is None or cost_usd < 0:
        cost_usd = fallback_cost

    requested_model = telemetry.get("requestedModel")
    return {
        "logicalRequests": logical_requests,
        "httpAttempts": http_attempts,
        "costUsd": cost_usd,
        "providers": providers,
        "servedModels": served_models,
        "requestedModel": (
            requested_model
            if isinstance(requested_model, str) and requested_model
            else None
        ),
    }


def _cell_name(sweep_id: str, relative_results: Path) -> str:
    parent_parts = relative_results.parent.parts
    if not parent_parts or parent_parts == (".",):
        return sweep_id
    if len(parent_parts) >= 2 and RUN_DIRECTORY.match(parent_parts[-1]):
        return parent_parts[-2]
    return parent_parts[-1]


def _cell_id(sweep_id: str, relative_results: Path) -> str:
    identity = f"{sweep_id}\0{relative_results.as_posix()}".encode("utf-8")
    return hashlib.sha256(identity).hexdigest()


def _derive_status(tasks: int, planned: int, errors: int) -> str:
    if tasks == 0:
        return "not_started"
    if planned > 0 and tasks >= planned:
        return "completed_with_errors" if errors else "complete"
    return "partial_with_errors" if errors else "partial"


def _rounded_cost(value: float) -> float:
    return round(value, 9)


class DashboardState:
    """Discovers artifacts and builds read-only API responses."""

    def __init__(self, out_root: Path, default_sweep_id: str | None) -> None:
        self.out_root = out_root.resolve()
        self.default_sweep_id = default_sweep_id
        self._cache: dict[str, CachedCell] = {}
        self._cache_lock = threading.RLock()

    def list_sweeps(self) -> list[Sweep]:
        if not self.out_root.is_dir():
            return []
        sweeps: list[Sweep] = []
        try:
            entries = list(self.out_root.iterdir())
        except OSError:
            return []
        for entry in entries:
            if not _safe_sweep_entry(entry, self.out_root):
                continue
            try:
                modified_at = _utc_iso(entry.stat().st_mtime)
                cell_count = sum(1 for _ in _walk_result_files(entry))
            except OSError:
                continue
            sweeps.append(
                Sweep(
                    sweep_id=entry.name,
                    path=entry.resolve(),
                    kind=_classify_sweep(entry.name),
                    modified_at=modified_at,
                    cell_count=cell_count,
                )
            )
        return sorted(
            sweeps,
            key=lambda sweep: (sweep.kind == "production", sweep.sweep_id),
            reverse=True,
        )

    def selected_sweep(
        self, requested_sweep_id: str | None, sweeps: list[Sweep] | None = None
    ) -> Sweep | None:
        available = sweeps if sweeps is not None else self.list_sweeps()
        by_id = {sweep.sweep_id: sweep for sweep in available}
        if requested_sweep_id is not None:
            if (
                not SAFE_SWEEP_ID.fullmatch(requested_sweep_id)
                or ".." in requested_sweep_id
            ):
                raise DashboardError(HTTPStatus.BAD_REQUEST, "Invalid sweep id.")
            selected = by_id.get(requested_sweep_id)
            if selected is None:
                raise DashboardError(
                    HTTPStatus.NOT_FOUND, "The requested sweep does not exist."
                )
            return selected

        if self.default_sweep_id:
            selected = by_id.get(self.default_sweep_id)
            if selected is not None:
                return selected

        production = [
            sweep for sweep in available if sweep.kind == "production"
        ]
        if production:
            return max(production, key=lambda sweep: sweep.sweep_id)
        if not available:
            return None
        return max(available, key=lambda sweep: sweep.modified_at)

    def cells_for_sweep(self, sweep: Sweep) -> list[CellSource]:
        cells: list[CellSource] = []
        for results_path in _walk_result_files(sweep.path):
            relative_results = results_path.relative_to(sweep.path)
            run_candidate = results_path.parent / "run.json"
            run_path: Path | None = None
            if run_candidate.is_file() and not run_candidate.is_symlink():
                try:
                    resolved_run = run_candidate.resolve(strict=True)
                except OSError:
                    resolved_run = None
                if resolved_run and _is_within(resolved_run, sweep.path):
                    run_path = resolved_run
            cells.append(
                CellSource(
                    cell_id=_cell_id(sweep.sweep_id, relative_results),
                    sweep_id=sweep.sweep_id,
                    name=_cell_name(sweep.sweep_id, relative_results),
                    results_path=results_path,
                    run_path=run_path,
                )
            )
        return sorted(cells, key=lambda cell: (cell.name, cell.cell_id))

    def all_cells(self, sweeps: list[Sweep] | None = None) -> dict[str, CellSource]:
        registry: dict[str, CellSource] = {}
        for sweep in sweeps if sweeps is not None else self.list_sweeps():
            for cell in self.cells_for_sweep(sweep):
                registry[cell.cell_id] = cell
        return registry

    @staticmethod
    def _fingerprint(cell: CellSource) -> tuple[int, int, int, int]:
        result_stat = cell.results_path.stat()
        if cell.run_path is None:
            return (result_stat.st_mtime_ns, result_stat.st_size, 0, 0)
        try:
            run_stat = cell.run_path.stat()
        except OSError:
            return (result_stat.st_mtime_ns, result_stat.st_size, 0, 0)
        return (
            result_stat.st_mtime_ns,
            result_stat.st_size,
            run_stat.st_mtime_ns,
            run_stat.st_size,
        )

    def cell_progress(self, cell: CellSource) -> dict[str, Any]:
        try:
            fingerprint = self._fingerprint(cell)
        except OSError as error:
            raise DashboardError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                f"Could not inspect the selected result artifact: {error.strerror}.",
            ) from error

        with self._cache_lock:
            cached = self._cache.get(cell.cell_id)
            if cached and cached.fingerprint == fingerprint:
                return dict(cached.value)

        run = _read_run_json(cell.run_path)
        configured_model = _model_from_run(run)
        policy = _benchmark_field(run, "policy")
        requester = _benchmark_field(run, "requester")
        grading_mode = _benchmark_field(run, "gradingMode")
        task_kind: str | None = None
        benchmark = run.get("benchmark")
        if isinstance(benchmark, dict):
            tasks_config = benchmark.get("tasks")
            if isinstance(tasks_config, dict):
                kind_value = tasks_config.get("kind")
                if isinstance(kind_value, str) and kind_value:
                    task_kind = kind_value

        tasks = 0
        ok = 0
        errors = 0
        malformed_rows = 0
        incomplete_rows = 0
        logical_requests = 0
        http_attempts = 0
        cost_usd = 0.0
        providers: set[str] = set()
        served_models: set[str] = set()
        requested_models: set[str] = set()
        error_statuses: Counter[str] = Counter()

        for _, row, row_error in _iter_rows(cell.results_path):
            if row is None:
                if row_error == "incomplete":
                    incomplete_rows += 1
                else:
                    malformed_rows += 1
                continue
            tasks += 1
            status = row.get("status")
            if status == "ok":
                ok += 1
            else:
                errors += 1
                error_statuses[
                    status if isinstance(status, str) and status else "unknown"
                ] += 1

            metrics = _request_metrics(row)
            logical_requests += metrics["logicalRequests"]
            http_attempts += metrics["httpAttempts"]
            cost_usd += metrics["costUsd"]
            providers.update(metrics["providers"])
            served_models.update(metrics["servedModels"])
            if metrics["requestedModel"]:
                requested_models.add(metrics["requestedModel"])

        planned_tasks = _planned_tasks(run)
        models = set(requested_models)
        models.update(served_models)
        if configured_model:
            models.add(configured_model)
        primary_model = configured_model or (
            sorted(requested_models)[0] if len(requested_models) == 1 else None
        )
        provider = (
            sorted(providers)[0]
            if len(providers) == 1
            else ", ".join(sorted(providers))
            if providers
            else None
        )
        run_status = run.get("status")
        started_at = run.get("startedAt")
        finished_at = run.get("finishedAt")
        run_id = run.get("runId")
        updated_at = _utc_iso(cell.results_path.stat().st_mtime)

        value: dict[str, Any] = {
            "id": cell.cell_id,
            "name": cell.name,
            "sweep": cell.sweep_id,
            "runId": run_id if isinstance(run_id, str) else None,
            "status": _derive_status(tasks, planned_tasks, errors),
            "runStatus": run_status if isinstance(run_status, str) else None,
            "startedAt": started_at if isinstance(started_at, str) else None,
            "finishedAt": finished_at if isinstance(finished_at, str) else None,
            "updatedAt": updated_at,
            "model": primary_model,
            "models": sorted(models),
            "servedModels": sorted(served_models),
            "provider": provider,
            "providers": sorted(providers),
            "policy": policy,
            "requester": requester,
            "gradingMode": grading_mode,
            "taskKind": task_kind,
            "tasks": tasks,
            "plannedTasks": planned_tasks,
            "ok": ok,
            "errors": errors,
            "errorStatuses": dict(sorted(error_statuses.items())),
            "malformedRows": malformed_rows,
            "incompleteRows": incomplete_rows,
            "logicalRequests": logical_requests,
            "httpAttempts": http_attempts,
            "costUsd": _rounded_cost(cost_usd),
            "progressPct": (
                round(min(tasks / planned_tasks, 1.0) * 100, 1)
                if planned_tasks
                else None
            ),
            "rowsUrl": f"/api/results?cell={quote(cell.cell_id)}",
            "rawUrl": f"/raw?cell={quote(cell.cell_id)}",
        }
        with self._cache_lock:
            self._cache[cell.cell_id] = CachedCell(fingerprint, dict(value))
        return value

    @staticmethod
    def _aggregate(cells: list[dict[str, Any]]) -> dict[str, Any]:
        metric_names = (
            "tasks",
            "plannedTasks",
            "ok",
            "errors",
            "malformedRows",
            "logicalRequests",
            "httpAttempts",
        )
        summary: dict[str, Any] = {
            "cells": len(cells),
            "completeCells": sum(
                cell["status"] in {"complete", "completed_with_errors"}
                for cell in cells
            ),
            "partialCells": sum(
                cell["status"] in {"partial", "partial_with_errors"}
                for cell in cells
            ),
        }
        for metric_name in metric_names:
            summary[metric_name] = sum(
                int(cell.get(metric_name, 0)) for cell in cells
            )
        summary["costUsd"] = _rounded_cost(
            sum(float(cell.get("costUsd", 0.0)) for cell in cells)
        )
        summary["models"] = sorted(
            {
                model
                for cell in cells
                for model in cell.get("models", [])
                if isinstance(model, str)
            }
        )
        summary["providers"] = sorted(
            {
                provider
                for cell in cells
                for provider in cell.get("providers", [])
                if isinstance(provider, str)
            }
        )
        summary["policies"] = sorted(
            {
                cell["policy"]
                for cell in cells
                if isinstance(cell.get("policy"), str)
            }
        )
        summary["byModel"] = DashboardState._group_cells(cells, "model")
        summary["byProvider"] = DashboardState._group_cells(cells, "provider")
        summary["byPolicy"] = DashboardState._group_cells(cells, "policy")
        return summary

    @staticmethod
    def _group_cells(
        cells: list[dict[str, Any]], field: str
    ) -> list[dict[str, Any]]:
        groups: dict[str, dict[str, Any]] = {}
        for cell in cells:
            raw_name = cell.get(field)
            name = raw_name if isinstance(raw_name, str) and raw_name else "Unknown"
            group = groups.setdefault(
                name,
                {
                    "name": name,
                    "cells": 0,
                    "tasks": 0,
                    "plannedTasks": 0,
                    "ok": 0,
                    "errors": 0,
                    "logicalRequests": 0,
                    "httpAttempts": 0,
                    "costUsd": 0.0,
                },
            )
            group["cells"] += 1
            for metric_name in (
                "tasks",
                "plannedTasks",
                "ok",
                "errors",
                "logicalRequests",
                "httpAttempts",
            ):
                group[metric_name] += int(cell.get(metric_name, 0))
            group["costUsd"] += float(cell.get("costUsd", 0.0))
        result = []
        for group in groups.values():
            group["costUsd"] = _rounded_cost(group["costUsd"])
            result.append(group)
        return sorted(result, key=lambda group: group["name"].lower())

    def progress(self, requested_sweep_id: str | None) -> dict[str, Any]:
        sweeps = self.list_sweeps()
        selected = self.selected_sweep(requested_sweep_id, sweeps)
        if selected is None:
            return {
                "generatedAt": _utc_iso(datetime.now().timestamp()),
                "selectedSweep": None,
                "sweeps": [],
                "summary": self._aggregate([]),
                "cells": [],
            }
        cells = [
            self.cell_progress(source)
            for source in self.cells_for_sweep(selected)
        ]
        return {
            "generatedAt": _utc_iso(datetime.now().timestamp()),
            "selectedSweep": selected.sweep_id,
            "sweeps": [sweep.public() for sweep in sweeps],
            "summary": self._aggregate(cells),
            "cells": cells,
        }

    def resolve_cell(
        self, cell_id: str | None, requested_sweep_id: str | None = None
    ) -> CellSource:
        if cell_id is None or not OPAQUE_CELL_ID.fullmatch(cell_id):
            raise DashboardError(
                HTTPStatus.BAD_REQUEST, "A valid opaque cell id is required."
            )
        sweeps = self.list_sweeps()
        registry = self.all_cells(sweeps)
        cell = registry.get(cell_id)
        if cell is None:
            raise DashboardError(
                HTTPStatus.NOT_FOUND, "The requested cell does not exist."
            )
        if requested_sweep_id is not None:
            selected = self.selected_sweep(requested_sweep_id, sweeps)
            if selected is None or selected.sweep_id != cell.sweep_id:
                raise DashboardError(
                    HTTPStatus.NOT_FOUND,
                    "The requested cell is not part of that sweep.",
                )
        return cell

    def parsed_results(
        self, cell_id: str | None, requested_sweep_id: str | None
    ) -> dict[str, Any]:
        cell = self.resolve_cell(cell_id, requested_sweep_id)
        rows: list[dict[str, Any]] = []
        malformed: list[dict[str, Any]] = []
        for line_number, row, row_error in _iter_rows(cell.results_path):
            if row is not None:
                rows.append(row)
            elif row_error != "incomplete":
                malformed.append({"line": line_number, "error": row_error})
        return {
            "sweep": cell.sweep_id,
            "cell": cell.cell_id,
            "meta": self.cell_progress(cell),
            "count": len(rows),
            "malformed": malformed,
            "rows": rows,
        }


class DashboardServer(ThreadingHTTPServer):
    """HTTP server carrying immutable dashboard state."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        state: DashboardState,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.state = state


class DashboardHandler(BaseHTTPRequestHandler):
    """Strict routing layer: no generic filesystem serving is available."""

    server: DashboardServer
    protocol_version = "HTTP/1.1"

    def version_string(self) -> str:
        return "PACT-progress-viewer"

    def _common_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )

    def _send_bytes(
        self,
        status: HTTPStatus,
        content_type: str,
        body: bytes,
        *,
        disposition: str | None = None,
    ) -> None:
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, status: HTTPStatus, value: Any) -> None:
        try:
            body = json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError):
            body = b'{"error":"Could not serialize the response."}'
            status = HTTPStatus.INTERNAL_SERVER_ERROR
        self._send_bytes(
            status, "application/json; charset=utf-8", body
        )

    def _send_error_json(self, error: DashboardError) -> None:
        self._send_json(
            error.status,
            {"error": error.message, "status": int(error.status)},
        )

    @staticmethod
    def _one_query_value(
        query: dict[str, list[str]], key: str
    ) -> str | None:
        values = query.get(key)
        if values is None:
            return None
        if len(values) != 1 or not values[0]:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST,
                f"Query parameter '{key}' must appear exactly once.",
            )
        return values[0]

    def _parse_request(self) -> tuple[str, dict[str, list[str]]]:
        if len(self.path) > MAX_QUERY_LENGTH:
            raise DashboardError(
                HTTPStatus.REQUEST_URI_TOO_LONG, "Request URI is too long."
            )
        parsed = urlsplit(self.path)
        try:
            query = parse_qs(
                parsed.query,
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=20,
            )
        except ValueError as error:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST, "Malformed query string."
            ) from error
        return parsed.path, query

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            path, query = self._parse_request()
            if path in {"/", "/index.html"}:
                self._serve_index(query)
            elif path == "/api/progress":
                self._serve_progress(query)
            elif path == "/api/sweeps":
                self._serve_sweeps(query)
            elif path in {"/api/results", "/api/rows"}:
                self._serve_results(query)
            elif path in {"/raw", "/api/raw"}:
                self._serve_raw(query)
            elif path == "/favicon.ico":
                self._send_bytes(
                    HTTPStatus.NO_CONTENT,
                    "image/x-icon",
                    b"",
                )
            else:
                raise DashboardError(
                    HTTPStatus.NOT_FOUND, "No such dashboard route."
                )
        except DashboardError as error:
            self._send_error_json(error)
        except (OSError, RuntimeError) as error:
            self._send_error_json(
                DashboardError(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    f"Could not read local sweep state: {error}.",
                )
            )

    def _serve_index(self, query: dict[str, list[str]]) -> None:
        if query:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST,
                "The dashboard page does not accept query parameters.",
            )
        if (
            INDEX_FILE.is_symlink()
            or not INDEX_FILE.is_file()
            or INDEX_FILE.resolve().parent != VIEWER_DIR
        ):
            raise DashboardError(
                HTTPStatus.NOT_FOUND,
                "Dashboard index.html is not installed.",
            )
        try:
            body = INDEX_FILE.read_bytes()
        except OSError as error:
            raise DashboardError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                f"Could not read dashboard index.html: {error.strerror}.",
            ) from error
        self._send_bytes(
            HTTPStatus.OK, "text/html; charset=utf-8", body
        )

    def _serve_progress(self, query: dict[str, list[str]]) -> None:
        unknown = set(query) - {"sweep"}
        if unknown:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST, "Unknown progress query parameter."
            )
        sweep_id = self._one_query_value(query, "sweep")
        self._send_json(
            HTTPStatus.OK, self.server.state.progress(sweep_id)
        )

    def _serve_sweeps(self, query: dict[str, list[str]]) -> None:
        if query:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST,
                "The sweeps endpoint does not accept query parameters.",
            )
        sweeps = self.server.state.list_sweeps()
        selected = self.server.state.selected_sweep(None, sweeps)
        self._send_json(
            HTTPStatus.OK,
            {
                "selectedSweep": selected.sweep_id if selected else None,
                "sweeps": [sweep.public() for sweep in sweeps],
            },
        )

    def _serve_results(self, query: dict[str, list[str]]) -> None:
        unknown = set(query) - {"cell", "sweep"}
        if unknown:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST, "Unknown results query parameter."
            )
        cell_id = self._one_query_value(query, "cell")
        sweep_id = self._one_query_value(query, "sweep")
        result = self.server.state.parsed_results(cell_id, sweep_id)
        self._send_json(HTTPStatus.OK, result)

    def _serve_raw(self, query: dict[str, list[str]]) -> None:
        unknown = set(query) - {"cell", "sweep"}
        if unknown:
            raise DashboardError(
                HTTPStatus.BAD_REQUEST, "Unknown raw query parameter."
            )
        cell_id = self._one_query_value(query, "cell")
        sweep_id = self._one_query_value(query, "sweep")
        cell = self.server.state.resolve_cell(cell_id, sweep_id)
        try:
            body = cell.results_path.read_bytes()
        except OSError as error:
            raise DashboardError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                f"Could not read the selected result artifact: {error.strerror}.",
            ) from error
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", cell.name).strip(".-")
        if not safe_name:
            safe_name = "cell"
        self._send_bytes(
            HTTPStatus.OK,
            "application/x-ndjson; charset=utf-8",
            body,
            disposition=f'attachment; filename="{safe_name}-results.jsonl"',
        )

    def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send_json(
            HTTPStatus.METHOD_NOT_ALLOWED,
            {"error": "Only GET requests are supported.", "status": 405},
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send_json(
            HTTPStatus.METHOD_NOT_ALLOWED,
            {"error": "The dashboard is read-only.", "status": 405},
        )

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST

    def log_message(self, message_format: str, *args: Any) -> None:
        sys.stderr.write(
            f"[{self.log_date_time_string()}] "
            f"{self.client_address[0]} "
            f"{message_format % args}\n"
        )


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be an integer") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Serve the local PACT rebuttal progress dashboard. The server "
            "binds only to 127.0.0.1 and never starts experiment/model calls."
        ),
        epilog=(
            "Examples:\n"
            "  python3 rebuttal/viewer/server.py\n"
            "  python3 rebuttal/viewer/server.py --port 8877\n"
            "  python3 rebuttal/viewer/server.py "
            "--sweep-id 20260728T022550Z-f0b73e4d"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--port",
        type=_port,
        default=DEFAULT_PORT,
        help=f"loopback TCP port (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--sweep-id",
        help=(
            "initial sweep to display; by default the newest production-style "
            "20YYYYMMDDTHHMMSSZ-id directory is selected"
        ),
    )
    return parser.parse_args()


def main() -> int:
    arguments = _arguments()
    state = DashboardState(OUT_ROOT, arguments.sweep_id)
    sweeps = state.list_sweeps()
    if arguments.sweep_id:
        try:
            state.selected_sweep(arguments.sweep_id, sweeps)
        except DashboardError as error:
            print(f"error: {error.message}", file=sys.stderr)
            return 2

    if not INDEX_FILE.is_file():
        print(
            f"warning: {INDEX_FILE} does not exist yet; APIs will still work.",
            file=sys.stderr,
        )
    server = DashboardServer(
        (LOOPBACK_HOST, arguments.port), DashboardHandler, state
    )
    selected = state.selected_sweep(None, sweeps)
    print(
        f"PACT progress viewer {APP_VERSION}: "
        f"http://{LOOPBACK_HOST}:{arguments.port}/",
        flush=True,
    )
    print(
        f"Output root: {OUT_ROOT} | "
        f"selected sweep: {selected.sweep_id if selected else 'none'}",
        flush=True,
    )
    print("Read-only local server; press Ctrl-C to stop.", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nStopping viewer.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
