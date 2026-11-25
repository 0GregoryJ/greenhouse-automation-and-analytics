"""
Read-only HTTP API for greenhouse sensor measurements.

Live data:
    Kafka -> Redis -> FastAPI

Historical data:
    Kafka -> S3 -> Snowflake -> FastAPI

The API serves both live and historical measurements without
directly consuming Kafka events.
"""

import json
import logging
import os
from contextlib import asynccontextmanager

import redis
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field


from api.routes.history import router as history_router
from api.routes.environment import router as environment_router
from api.routes.metrics import router as metrics_router
from api.services.moisture_reading_transform import transform_moisture_readings
from api.services.analyst import GreenhouseAnalyst, AnalystError


# ---------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("greenhouse-api")


# ---------------------------------------------------------------------
# Redis connection
# ---------------------------------------------------------------------

redis_client = redis.Redis(
    host=os.getenv("REDIS_HOST", "redis"),
    port=int(os.getenv("REDIS_PORT", "6379")),
    decode_responses=True,
    socket_connect_timeout=3,
    socket_timeout=3,
)


# ---------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    redis_client.ping()
    app.state.redis_client = redis_client

    logger.info("Connected to Redis")

    try:
        yield
    finally:
        redis_client.close()
        logger.info("Redis connection closed")


# ---------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------

app = FastAPI(
    title="Greenhouse Monitoring API",
    description=(
        "Read-only API serving live greenhouse sensor measurements "
        "from Redis and historical analytics from Snowflake."
    ),
    version="0.2.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------
# CORS configuration
# ---------------------------------------------------------------------

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------
# Register routers
# ---------------------------------------------------------------------

app.include_router(history_router)
app.include_router(environment_router)
app.include_router(metrics_router)

# ---------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------

@app.get("/health")
def health():
    """
    Verify Redis connectivity, not just API process availability.

    Snowflake is not included in this health check because
    historical queries are performed on demand.
    """
    try:
        redis_client.ping()
        return {"status": "ok"}

    except redis.RedisError:
        logger.exception("Redis health check failed")
        raise HTTPException(
            status_code=503,
            detail="Redis is unavailable",
        )


# ---------------------------------------------------------------------
# Live sensor measurements
# ---------------------------------------------------------------------

@app.get("/api/v1/sensors/latest")
def get_latest_readings():
    """
    Return the latest measurement for each sensor and metric.

    Soil moisture measurements are enriched using the
    10 most recent raw readings stored in Redis.
    """
    try:
        readings = []
        cursor = 0

        while True:
            cursor, keys = redis_client.scan(
                cursor=cursor,
                match="greenhouse:latest:*",
                count=100,
            )

            if keys:
                pipeline = redis_client.pipeline(transaction=False)

                for key in keys:
                    pipeline.hgetall(key)

                results = pipeline.execute()

                for record in results:
                    if not record:
                        continue

                    measurement_type = record.get("measurement_type")
                    raw_value = float(record["value"])

                    reading = {
                        "gateway_id": record.get("gateway_id"),
                        "sensor_id": record.get("sensor_id"),
                        "measurement_type": measurement_type,
                        "raw_value": raw_value,
                        "unit": record.get("unit"),
                        "timestamp": record.get("timestamp"),
                        "event_id": record.get("event_id"),
                    }

                    # Apply calibration only to soil moisture.
                    if measurement_type == "soil_moisture":

                        history_key = (
                            f"greenhouse:history:{record['gateway_id']}:"
                            f"{record['sensor_id']}:{measurement_type}"
                        )

                        history = redis_client.lrange(
                            history_key, 0, 9
                        )

                        values = [
                            float(json.loads(event)["value"])
                            for event in history
                        ]

                        # Fallback if history is empty.
                        if not values:
                            values = [raw_value]

                        calibrated_pct, state = transform_moisture_readings(
                            values
                        )

                        reading["calibrated_pct"] = calibrated_pct
                        reading["state"] = state

                    readings.append(reading)

            if cursor == 0:
                break

        readings.sort(
            key=lambda reading: (
                reading["gateway_id"] or "",
                reading["sensor_id"] or "",
                reading["measurement_type"] or "",
            )
        )

        return {
            "count": len(readings),
            "readings": readings,
        }

    except (redis.RedisError, ValueError, KeyError, TypeError):
        logger.exception("Unable to retrieve latest readings")
        raise HTTPException(
            status_code=503,
            detail="Sensor readings are temporarily unavailable",
        )
# ---------------------------------------------------------------------
# Live automation events (most recent 10)
# ---------------------------------------------------------------------

@app.get("/api/v1/automation/events/recent")
def get_recent_automation_events():
    """Return the latest 10 automation events from Redis."""

    try:
        events = redis_client.lrange(
            "greenhouse:automation:recent",
            0,
            9,
        )

        parsed_events = [json.loads(event) for event in events]

        return {
            "count": len(parsed_events),
            "events": parsed_events,
        }

    except (redis.RedisError, ValueError, TypeError):
        logger.exception("Unable to retrieve automation events")

        raise HTTPException(
            status_code=503,
            detail="Automation events are temporarily unavailable",
        )

# ---------------------------------------------------------------------
#  AI Analyst questions POST
# ---------------------------------------------------------------------
class AnalystRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1000)


@app.post("/api/analyst/query")
async def analyst_query(request: AnalystRequest):
    try:
        result = await run_in_threadpool(
            GreenhouseAnalyst().ask,
            request.question
        )
        return result
    except AnalystError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc)
        )