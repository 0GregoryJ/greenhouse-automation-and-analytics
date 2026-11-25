"""
Safe, self-hosted MetricFlow adapter for the greenhouse AI analyst.

Requires an ``mf`` executable inside the API runtime and an up-to-date dbt
semantic manifest (run ``dbt parse`` after semantic YAML changes).

Environment:
    DBT_PROJECT_DIR: project directory containing dbt_project.yml
    DBT_PROFILES_DIR: directory containing profiles.yml
    DBT_TARGET: optional dbt target (e.g. prod)
    MF_EXECUTABLE: CLI path/name (default: mf)
    MF_TIMEOUT_SECONDS: execution timeout (default: 90)
    MF_CATALOG_TTL_SECONDS: metadata cache TTL (default: 300)
    DBT_LOG_PATH: writable log directory (default: /tmp/greenhouse-dbt-logs)
"""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_DIR = Path(os.getenv("DBT_PROJECT_DIR", str(REPO_ROOT / "warehouse")))
PROFILES_DIR = Path(os.getenv("DBT_PROFILES_DIR", str(Path.home() / ".dbt")))
MF_EXECUTABLE = os.getenv("MF_EXECUTABLE", "mf")
MF_TIMEOUT = int(os.getenv("MF_TIMEOUT_SECONDS", "90"))
CATALOG_TTL = int(os.getenv("MF_CATALOG_TTL_SECONDS", "300"))
LOG_PATH = Path(os.getenv("DBT_LOG_PATH", "/tmp/greenhouse-dbt-logs"))
MAX_ROWS = 500
MAX_METRICS = 5
MAX_GROUP_BYS = 5
MAX_DATE_RANGE_DAYS = 366
NAME_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*?(?:__[a-zA-Z0-9_]+)*$")
BULLET_PATTERN = re.compile(r"^\s*[-*•]\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)")


class MetricFlowError(Exception):
    """MetricFlow execution, configuration, or output error."""


class MetricFlowValidationError(MetricFlowError):
    """User-supplied metric query cannot be executed safely."""


@dataclass(frozen=True)
class MetricQuery:
    metrics: list[str]
    group_by: list[str] = field(default_factory=list)
    start_time: str | None = None
    end_time: str | None = None
    limit: int = 100
    order_by: list[str] = field(default_factory=list)


_cache_lock = threading.RLock()
_metric_cache: tuple[float, list[dict[str, Any]]] | None = None
_dimension_cache: dict[tuple[str, ...], tuple[float, list[str]]] = {}


def _mf_env() -> dict[str, str]:
    if not (PROJECT_DIR / "dbt_project.yml").is_file():
        raise MetricFlowError(f"dbt_project.yml not found under {PROJECT_DIR}")
    if not (PROFILES_DIR / "profiles.yml").is_file():
        raise MetricFlowError(f"profiles.yml not found under {PROFILES_DIR}")
    LOG_PATH.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["DBT_PROFILES_DIR"] = str(PROFILES_DIR)
    env["DBT_LOG_PATH"] = str(LOG_PATH)
    env["NO_COLOR"] = "1"
    return env


def run_mf(args: list[str]) -> str:
    """Run a trusted MetricFlow command; never invoke a shell."""
    if not args or args[0] not in {"list", "query"}:
        raise MetricFlowError("Unsupported MetricFlow operation")
    try:
        completed = subprocess.run(
            [MF_EXECUTABLE, *args],
            cwd=str(PROJECT_DIR),
            env=_mf_env(),
            capture_output=True,
            text=True,
            timeout=MF_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise MetricFlowError(f"MetricFlow timed out after {MF_TIMEOUT}s") from exc
    except OSError as exc:
        raise MetricFlowError(f"Cannot start MetricFlow: {exc}") from exc
    if completed.returncode != 0:
        # Log full stderr server-side if needed; don't return DB URLs/credentials to clients.
        raise MetricFlowError(
            f"MetricFlow exited with code {completed.returncode}; check API service logs"
        )
    return completed.stdout


def _names_from_bullets(output: str) -> list[str]:
    """Parse CLI bullet entries; reject unknown formats rather than inventing catalog entries."""
    return list(dict.fromkeys(
        match.group(1)
        for line in output.splitlines()
        if (match := BULLET_PATTERN.match(line)) is not None
    ))


def _manifest_descriptions() -> dict[str, str]:
    """Optional descriptions from dbt-generated semantic manifest."""
    path = PROJECT_DIR / "target" / "semantic_manifest.json"
    if not path.is_file():
        return {}
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    descriptions: dict[str, str] = {}
    for metric in content.get("metrics", []):
        if isinstance(metric, dict):
            name, description = metric.get("name"), metric.get("description")
            if isinstance(name, str) and isinstance(description, str):
                descriptions[name] = description
    return descriptions


def list_metrics(*, refresh: bool = False) -> list[dict[str, Any]]:
    """Return the MetricFlow catalog, with descriptions where available."""
    global _metric_cache
    with _cache_lock:
        if not refresh and _metric_cache and time.monotonic() < _metric_cache[0]:
            return [item.copy() for item in _metric_cache[1]]
    names = _names_from_bullets(run_mf(["list", "metrics", "--show-all-dimensions"]))
    if not names:
        raise MetricFlowError("Could not parse 'mf list metrics' output; inspect CLI version")
    descriptions = _manifest_descriptions()
    catalog = [{"name": name, "description": descriptions.get(name, "")} for name in names]
    with _cache_lock:
        _metric_cache = (time.monotonic() + CATALOG_TTL, catalog)
    return [item.copy() for item in catalog]


def _check_identifier(name: str) -> None:
    if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
        raise MetricFlowValidationError(f"Invalid metric or dimension identifier: {name!r}")


def _metric_names(metrics: list[str]) -> None:
    if not metrics or len(metrics) > MAX_METRICS or len(metrics) != len(set(metrics)):
        raise MetricFlowValidationError(f"Select 1 to {MAX_METRICS} unique metrics")
    for name in metrics:
        _check_identifier(name)
    known = {m["name"] for m in list_metrics()}
    unknown = sorted(set(metrics) - known)
    if unknown:
        raise MetricFlowValidationError(f"Unknown metrics: {', '.join(unknown)}")


def list_dimensions(metrics: list[str], *, refresh: bool = False) -> list[str]:
    """MetricFlow returns the common, queryable dimensions of these metrics."""
    _metric_names(metrics)
    key = tuple(sorted(metrics))
    with _cache_lock:
        cached = _dimension_cache.get(key)
        if not refresh and cached and time.monotonic() < cached[0]:
            return list(cached[1])
    output = run_mf(["list", "dimensions", "--metrics", ",".join(metrics)])
    dimensions = _names_from_bullets(output)
    # The CLI may show 'metric_time' and other dimension names as bullet entries.
    # A zero-dimension response is valid, but an unrecognized nonempty format is not.
    if not dimensions and "no dimension" not in output.lower():
        raise MetricFlowError("Could not parse 'mf list dimensions' output; inspect CLI version")
    with _cache_lock:
        _dimension_cache[key] = (time.monotonic() + CATALOG_TTL, dimensions)
    return list(dimensions)


def _parse_day(value: str | None, field_name: str) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise MetricFlowValidationError(f"{field_name} must be YYYY-MM-DD") from exc


def validate_query(query: MetricQuery) -> None:
    _metric_names(query.metrics)
    if len(query.group_by) > MAX_GROUP_BYS or len(set(query.group_by)) != len(query.group_by):
        raise MetricFlowValidationError(f"Use at most {MAX_GROUP_BYS} unique dimensions")
    if isinstance(query.limit, bool) or not isinstance(query.limit, int) or not 1 <= query.limit <= MAX_ROWS:
        raise MetricFlowValidationError(f"limit must be between 1 and {MAX_ROWS}")
    for name in query.group_by:
        _check_identifier(name)
    allowed = set(list_dimensions(query.metrics))
    # MetricFlow permits standard grains of the global metric_time dimension.
    if "metric_time" in allowed:
        allowed |= {f"metric_time__{grain}" for grain in ("day", "week", "month", "quarter", "year")}
    invalid = sorted(set(query.group_by) - allowed)
    if invalid:
        raise MetricFlowValidationError(f"Unsupported dimensions for requested metrics: {', '.join(invalid)}")

    for column in query.order_by:
        if not isinstance(column, str):
            raise MetricFlowValidationError("order_by values must be strings")
        if column.startswith("--"):
            raise MetricFlowValidationError("Invalid order_by field")
        _check_identifier(column.lstrip("-"))
        if column.lstrip("-") not in set(query.metrics) | set(query.group_by):
            raise MetricFlowValidationError(f"Cannot order by unselected field: {column}")
    start = _parse_day(query.start_time, "start_time")
    end = _parse_day(query.end_time, "end_time")
    if start is None or end is None:
        raise MetricFlowValidationError("Both start_time and end_time are required")
    if end < start or (end - start).days > MAX_DATE_RANGE_DAYS:
        raise MetricFlowValidationError(f"Date range must be 0-{MAX_DATE_RANGE_DAYS} days")
    if end > date.today():
        raise MetricFlowValidationError("end_time cannot be in the future")


def _convert_cell(value: str | None) -> Any:
    if value is None or value == "":
        return None
    value = value.strip()
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    # Preserve date strings and IDs, especially numbers with leading zeros.
    if re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value):
        try:
            return float(value) if "." in value else int(value)
        except ValueError:
            pass
    return value


def parse_results(csv_path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    """Read MetricFlow's self-hosted --csv output."""
    if not csv_path.is_file():
        raise MetricFlowError("MetricFlow completed without writing the expected CSV")
    try:
        with csv_path.open(newline="", encoding="utf-8-sig") as stream:
            reader = csv.DictReader(stream)
            columns = reader.fieldnames or []
            if not columns:
                raise MetricFlowError("MetricFlow returned a CSV without headers")
            rows = [
                {key: _convert_cell(value) for key, value in row.items()}
                for row in reader
            ]
    except (OSError, csv.Error) as exc:
        raise MetricFlowError("Could not parse MetricFlow CSV") from exc
    return columns, rows


def query_metrics(query: MetricQuery) -> dict[str, Any]:
    """Run a validated governed query in Snowflake and return JSON-ready rows."""
    validate_query(query)
    with tempfile.TemporaryDirectory(prefix="greenhouse-mf-") as temp_dir:
        csv_path = Path(temp_dir) / "results.csv"
        args = ["query", "--metrics", ",".join(query.metrics)]
        if query.group_by:
            args += ["--group-by", ",".join(query.group_by)]
        args += [
            "--start-time", query.start_time,
            "--end-time", query.end_time,
            "--limit", str(query.limit),
        ]
        if query.order_by:
            args += ["--order-by", ",".join(query.order_by)]
        args += ["--csv", str(csv_path)]
        run_mf(args)
        columns, rows = parse_results(csv_path)
    return {
        "metrics": list(query.metrics),
        "group_by": list(query.group_by),
        "start_time": query.start_time,
        "end_time": query.end_time,
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "limit": query.limit,
    }

def compile_metricflow_sql(query: dict) -> str:
    """Compile a validated MetricFlow query to SQL.

    The caller must validate metrics, dimensions,
    date boundaries and limits before calling.
    """
    cmd = [
        "mf", "query",
        "--metrics", ",".join(query["metrics"]),
        "--start-time", query["start_time"],
        "--end-time", query["end_time"],
        "--limit", str(query["limit"]),
        "--explain",
    ]

    if query["group_by"]:
        cmd.extend([
            "--group-by", ",".join(query["group_by"])
        ])

    result = subprocess.run(
        cmd,
        cwd=os.getenv("METRICFLOW_PROJECT_DIR", "/app/warehouse"),
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(
            f"MetricFlow compilation failed: "
            f"{result.stderr[-1000:]}"
        )

    # Strip terminal color codes.
    output = re.sub(
        r"\x1b\[[0-9;]*m", "", result.stdout
    )

    # MetricFlow's explain output contains a SQL marker.
    marker = re.search(
        r"SQL\s*\(.*?\)\s*:",
        output,
        flags=re.IGNORECASE,
    )
    if not marker:
        raise RuntimeError(
            "MetricFlow did not return recognizable SQL output"
        )

    sql = output[marker.end():].strip()

    if not sql.lower().startswith(("select", "with")):
        raise RuntimeError(
            "Compiled output is not recognized as SQL"
        )

    return sql
