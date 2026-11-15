import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from api.repositories.snowflake import (
    get_environmental_score_history,
)

import redis
from fastapi import APIRouter, HTTPException, Query, Request

from api.services.environmental_score import (
    calculate_environmental_score,
)

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/v1/environment",
    tags=["Environmental Conditions"],
)

ROOT = Path(__file__).resolve().parents[2]

CONFIG = json.loads(
    (ROOT / "config/environmental_score.v1.json").read_text()
)


def parse_timestamp(value):
    dt = datetime.fromisoformat(
        value.replace("Z", "+00:00")
    )
    if dt.tzinfo is None:
        raise ValueError("Timezone is required")
    return dt.astimezone(timezone.utc)


def fetch_latest_for_gateway(client, gateway_id):
    """
    Retrieve the newest reading of each required metric
    for a single gateway.
    """
    latest = {}

    for key in client.scan_iter(
        match=f"greenhouse:latest:{gateway_id}:*",
        count=100,
    ):
        record = client.hgetall(key)
        metric = record.get("measurement_type")

        if metric not in CONFIG["metrics"]:
            continue

        rule = CONFIG["metrics"][metric]

        if record.get("unit") != rule["unit"]:
            continue

        try:
            timestamp = parse_timestamp(record["timestamp"])
            value = float(record["value"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue

        if (
            metric not in latest
            or timestamp > latest[metric]["timestamp"]
        ):
            latest[metric] = {
                "value": value,
                "timestamp": timestamp,
                "sensor_id": record.get("sensor_id"),
            }

    return latest


@router.get("/score/current")
def get_current_score(
    request: Request,
    gateway_id: str = Query(min_length=1, max_length=128),
):

    client = getattr(request.app.state, "redis_client", None)
    if client is None:
        from api.main import redis_client as client

    try:
        records = fetch_latest_for_gateway(client, gateway_id)

        required = CONFIG["metrics"]
        missing = [
            name for name in required
            if name not in records
        ]

        if missing:
            return {
                "gateway_id": gateway_id,
                "score": None,
                "score_version": CONFIG["version"],
                "status": "incomplete",
                "invalid_measurements": missing,
                "components": {},
            }

        timestamps = [
            record["timestamp"]
            for record in records.values()
        ]

        now = datetime.now(timezone.utc)
        ages = [
            (now - ts).total_seconds()
            for ts in timestamps
        ]

        skew = (
            max(timestamps) - min(timestamps)
        ).total_seconds()

        if (
            any(
                age < -30
                or age > CONFIG["max_reading_age_seconds"]
                for age in ages
            )
            or skew > CONFIG["max_sensor_skew_seconds"]
        ):
            return {
                "gateway_id": gateway_id,
                "score": None,
                "score_version": CONFIG["version"],
                "status": "stale_or_unsynchronized",
                "components": {},
            }

        readings = {
            name: records[name]["value"]
            for name in required
        }

        result = calculate_environmental_score(
            readings, CONFIG
        )

        return {
            "gateway_id": gateway_id,
            **result,
            "readings": readings,
            "measured_at": max(timestamps).isoformat(),
        }

    except redis.RedisError:
        logger.exception("Redis unavailable for score")
        raise HTTPException(
            status_code=503,
            detail="Live sensor data unavailable",
        )


@router.get("/score/history")
def get_historical_score(
    gateway_id: str = Query(min_length=1, max_length=128),
    period: Literal["24h", "7d", "30d"] = "7d",
):
    try:
        return get_environmental_score_history(
            gateway_id=gateway_id,
            period=period,
        )

    except Exception:
        logger.exception(
            "Historical score query failed for gateway=%s",
            gateway_id,
        )
        raise HTTPException(
            status_code=503,
            detail="Historical environmental scores unavailable",
        )
