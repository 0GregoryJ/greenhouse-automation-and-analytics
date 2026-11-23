import math


def component_score(value, rule):
    """
    Return suitability from 0 to 100.

    Return None for missing, non-finite or out-of-bounds
    readings.
    """
    if value is None:
        return None

    try:
        value = float(value)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(value):
        return None

    if not rule["valid_min"] <= value <= rule["valid_max"]:
        return None

    low = rule["target_min"]
    high = rule["target_max"]

    if low > high:
        raise ValueError("Invalid target interval")

    if value < low:
        tolerance = rule["tolerance_below"]
        distance = low - value
    elif value > high:
        tolerance = rule["tolerance_above"]
        distance = value - high
    else:
        return 100.0

    if tolerance <= 0:
        raise ValueError("Tolerance must be positive")

    return 100.0 * max(
        0.0,
        1.0 - distance / tolerance,
    )


def calculate_environmental_score(readings, config):
    """
    readings example:
        {
            "air_temperature": 24.0,
            "relative_humidity": 90.0,
            "soil_moisture": 60.0,  # calibrated percent
        }
    """
    components = {}
    weighted_sum = 0.0
    total_weight = 0.0
    invalid = []

    for name, rule in config["metrics"].items():
        score = component_score(readings.get(name), rule)

        if score is None:
            invalid.append(name)
            continue

        components[name] = round(score, 2)
        weighted_sum += score * rule["weight"]
        total_weight += rule["weight"]

    if invalid:
        return {
            "score": None,
            "score_version": config["version"],
            "status": "incomplete",
            "invalid_measurements": invalid,
            "components": components,
        }

    if total_weight <= 0:
        raise ValueError("Total weight must be positive")

    return {
        "score": round(weighted_sum / total_weight, 2),
        "score_version": config["version"],
        "status": "complete",
        "invalid_measurements": [],
        "components": components,
    }
