
import os
from datetime import date, datetime, timezone, time
from contextlib import closing


import snowflake.connector


# Only these period values are allowed.
# The table name and time interval are selected by our code,
# never supplied directly by the frontend.
PERIOD_CONFIG = {
    "24h": {
        "table": "FCT_SENSOR_HOURLY",
        "time_column": "MEASUREMENT_HOUR_UTC",
        "hours": 24,
        "resolution": "hour",
    },
    "7d": {
        "table": "FCT_SENSOR_HOURLY",
        "time_column": "MEASUREMENT_HOUR_UTC",
        "hours": 168,
        "resolution": "hour",
    },
    "30d": {
        "table": "FCT_SENSOR_DAILY",
        "time_column": "MEASUREMENT_DATE_UTC",
        "hours": 720,
        "resolution": "day",
    },
}

SCORE_PERIODS = {
    "24h": {
        "table": "FCT_ENVIRONMENTAL_SCORE_HOURLY",
        "hours": 24,
        "resolution": "hour",
    },
    "7d": {
        "table": "FCT_ENVIRONMENTAL_SCORE_HOURLY",
        "hours": 168,
        "resolution": "hour",
    },
    "30d": {
        "table": "FCT_ENVIRONMENTAL_SCORE_DAILY",
        "hours": 720,
        "resolution": "day",
    },
}

# Automation analytics: sensor series from int_sensor_readings + cycle markers.
AUTOMATION_ACTUATORS = {
    "pump": {
        "measurement_type": "soil_moisture",
        "value_expr": "CALIBRATED_MOISTURE",
        "unit": "percent",
    },
    "fan": {
        "measurement_type": "air_temperature",
        "value_expr": "VALUE",
        "unit": "celsius",
    },
}

AUTOMATION_PERIODS = {
    "24h": {"hours": 24, "resolution": "hour", "trunc": "HOUR"},
    "7d": {"hours": 168, "resolution": "hour", "trunc": "HOUR"},
    "30d": {"hours": 720, "resolution": "day", "trunc": "DAY"},
}

INTERMEDIATE_SCHEMA = "GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_INTERMEDIATE"
MARTS_SCHEMA = "GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS"


def get_connection():
    """Open a connection using the API service user's RSA key."""
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.getenv("SNOWFLAKE_USER", "GREENHOUSE_API"),
        role=os.getenv("SNOWFLAKE_ROLE", "GREENHOUSE_API_READER"),
        warehouse=os.getenv("SNOWFLAKE_WAREHOUSE", "GREENHOUSE_WH"),
        database=os.getenv("SNOWFLAKE_DATABASE", "GREENHOUSE_ANALYTICS"),
        schema=os.getenv("SNOWFLAKE_SCHEMA", "GREENHOUSE_DBT_MARTS"),
        authenticator="SNOWFLAKE_JWT",
        private_key_file=os.environ["SNOWFLAKE_PRIVATE_KEY_PATH"],
        private_key_file_pwd=os.environ["SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"],
        login_timeout=15,
        network_timeout=30,
    )


def get_sensor_history(sensor_id, measurement_type, period):
    """Query the appropriate mart and return timestamped readings."""

    config = PERIOD_CONFIG[period]
    table = config["table"]
    time_column = config["time_column"]
    hours = config["hours"]

    # Table and column names come from our fixed allowlist above.
    sql = f"""
        SELECT
            {time_column} AS POINT_TIME,
            AVG_VALUE,
            MIN_VALUE,
            MAX_VALUE,
            READING_COUNT,
            UNIT
        FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS.{table}
        WHERE SENSOR_ID = %s
          AND MEASUREMENT_TYPE = %s
          AND {time_column} >= DATEADD(
              'HOUR', -{hours}, CURRENT_TIMESTAMP()
          )
        ORDER BY {time_column}
    """

    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql, (sensor_id, measurement_type))
            rows = cursor.fetchall()

    points = []

    for timestamp, avg, minimum, maximum, count, unit in rows:
        # Snowflake TIMESTAMP_NTZ is stored as UTC in our dbt marts.
        if isinstance(timestamp, datetime):
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        elif isinstance(timestamp, date):
            timestamp = datetime(
                timestamp.year, timestamp.month, timestamp.day,
                tzinfo=timezone.utc,
            )

        points.append({
            "timestamp": timestamp.isoformat().replace("+00:00", "Z"),
            "avg": float(avg),
            "min": float(minimum),
            "max": float(maximum),
            "count": int(count),
            "unit": unit,
        })

    return points, config["resolution"]

# Historical Environmental Conditions Score
def to_utc_iso(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
    elif isinstance(value, date):
        value = datetime.combine(
            value, time.min, tzinfo=timezone.utc
        )
    else:
        raise TypeError(f"Unexpected timestamp: {type(value)}")

    return value.isoformat().replace("+00:00", "Z")


def optional_float(value):
    return float(value) if value is not None else None


def get_environmental_score_history(
    gateway_id: str,
    period: str,
):
    if period not in SCORE_PERIODS:
        raise ValueError("Unsupported period")

    config = SCORE_PERIODS[period]
    table = config["table"]

    if config["resolution"] == "hour":
        query = f"""
            SELECT
                MEASUREMENT_HOUR_UTC,
                ENVIRONMENTAL_SCORE,
                TEMPERATURE_SCORE,
                HUMIDITY_SCORE,
                SOIL_SCORE,
                STATUS,
                SCORE_VERSION
            FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS.{table}
            WHERE GATEWAY_ID = %s
              AND MEASUREMENT_HOUR_UTC >=
                  DATEADD('HOUR', -{config["hours"]},
                          CURRENT_TIMESTAMP())
            ORDER BY MEASUREMENT_HOUR_UTC
        """
    else:
        query = f"""
            SELECT
                MEASUREMENT_DATE_UTC,
                AVG_ENVIRONMENTAL_SCORE,
                MIN_ENVIRONMENTAL_SCORE,
                MAX_ENVIRONMENTAL_SCORE,
                SCORED_HOURS,
                HOURS_WITH_DATA,
                SCORE_VERSION
            FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS.{table}
            WHERE GATEWAY_ID = %s
              AND MEASUREMENT_DATE_UTC >=
                  DATEADD('DAY', -30, CURRENT_DATE())
            ORDER BY MEASUREMENT_DATE_UTC
        """

    with closing(get_connection()) as conn:
        with closing(conn.cursor()) as cursor:
            cursor.execute(query, (gateway_id,))
            rows = cursor.fetchall()

    points = []
    versions = set()

    for row in rows:
        if config["resolution"] == "hour":
            (
                timestamp,
                score,
                temp_score,
                humidity_score,
                soil_score,
                status,
                version,
            ) = row

            points.append({
                "timestamp": to_utc_iso(timestamp),
                "score": optional_float(score),
                "temperature_score": optional_float(temp_score),
                "humidity_score": optional_float(humidity_score),
                "soil_score": optional_float(soil_score),
                "status": status,
            })

        else:
            (
                timestamp,
                avg_score,
                min_score,
                max_score,
                scored_hours,
                hours_with_data,
                version,
            ) = row

            points.append({
                "timestamp": to_utc_iso(timestamp),
                "score": optional_float(avg_score),
                "min_score": optional_float(min_score),
                "max_score": optional_float(max_score),
                "scored_hours": int(scored_hours),
                "hours_with_data": int(hours_with_data),
            })

        versions.add(version)

    return {
        "gateway_id": gateway_id,
        "period": period,
        "resolution": config["resolution"],
        "score_version": (
            next(iter(versions)) if len(versions) == 1
            else None
        ),
        "count": len(points),
        "points": points,
    }


def get_automation_history(gateway_id: str, actuator: str, period: str):
    """Sensor series from int_sensor_readings with actuator cycle markers."""

    if actuator not in AUTOMATION_ACTUATORS:
        raise ValueError("Unsupported actuator")
    if period not in AUTOMATION_PERIODS:
        raise ValueError("Unsupported period")

    actuator_config = AUTOMATION_ACTUATORS[actuator]
    period_config = AUTOMATION_PERIODS[period]
    measurement_type = actuator_config["measurement_type"]
    value_expr = actuator_config["value_expr"]
    unit = actuator_config["unit"]
    trunc = period_config["trunc"]
    hours = period_config["hours"]

    series_sql = f"""
        SELECT
            DATE_TRUNC('{trunc}', MEASURED_AT_UTC) AS POINT_TIME,
            AVG({value_expr}) AS AVG_VALUE,
            MIN({value_expr}) AS MIN_VALUE,
            MAX({value_expr}) AS MAX_VALUE,
            COUNT(*) AS READING_COUNT
        FROM {INTERMEDIATE_SCHEMA}.INT_SENSOR_READINGS
        WHERE GATEWAY_ID = %s
          AND MEASUREMENT_TYPE = %s
          AND MEASURED_AT_UTC >= DATEADD(
              'HOUR', -{hours}, CURRENT_TIMESTAMP()
          )
          AND {value_expr} IS NOT NULL
        GROUP BY 1
        ORDER BY 1
    """

    cycles_sql = f"""
        SELECT
            CYCLE_ID,
            ACTUATOR,
            STARTED_AT_UTC,
            ENDED_AT_UTC,
            DURATION_SECONDS,
            ON_REASON
        FROM {MARTS_SCHEMA}.FCT_ACTUATOR_CYCLES
        WHERE ACTUATOR = %s
          AND STARTED_AT_UTC >= DATEADD(
              'HOUR', -{hours}, CURRENT_TIMESTAMP()
          )
        ORDER BY STARTED_AT_UTC
    """

    with closing(get_connection()) as conn:
        with closing(conn.cursor()) as cursor:
            cursor.execute(series_sql, (gateway_id, measurement_type))
            series_rows = cursor.fetchall()

            cursor.execute(cycles_sql, (actuator,))
            cycle_rows = cursor.fetchall()

    points = []
    for timestamp, avg, minimum, maximum, count in series_rows:
        points.append({
            "timestamp": to_utc_iso(timestamp),
            "avg": float(avg),
            "min": float(minimum),
            "max": float(maximum),
            "count": int(count),
            "unit": unit,
        })

    cycles = []
    for (
        cycle_id,
        cycle_actuator,
        started_at,
        ended_at,
        duration_seconds,
        on_reason,
    ) in cycle_rows:
        cycles.append({
            "cycle_id": str(cycle_id),
            "actuator": cycle_actuator,
            "started_at": to_utc_iso(started_at),
            "ended_at": to_utc_iso(ended_at) if ended_at is not None else None,
            "duration_seconds": (
                int(duration_seconds)
                if duration_seconds is not None
                else None
            ),
            "reason": on_reason,
        })

    return {
        "gateway_id": gateway_id,
        "actuator": actuator,
        "measurement_type": measurement_type,
        "period": period,
        "resolution": period_config["resolution"],
        "unit": unit,
        "count": len(points),
        "points": points,
        "cycles": cycles,
    }