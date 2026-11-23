
from api.repositories.snowflake import get_sensor_history


def display_unit(measurement_type, unit):
    """Historical soil moisture is calibrated percent in the warehouse marts."""
    if measurement_type == "soil_moisture":
        return "percent"
    return unit


def fetch_history(sensor_id, measurement_type, period):
    points, resolution = get_sensor_history(
        sensor_id=sensor_id,
        measurement_type=measurement_type,
        period=period,
    )

    normalized = []
    for point in points:
        unit = display_unit(measurement_type, point.get("unit"))
        normalized.append({**point, "unit": unit})

    units = {point["unit"] for point in normalized}

    return {
        "sensor_id": sensor_id,
        "measurement_type": measurement_type,
        "period": period,
        "resolution": resolution,
        "unit": next(iter(units)) if len(units) == 1 else None,
        "count": len(normalized),
        "points": normalized,
    }
