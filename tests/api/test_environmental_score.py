import json
from pathlib import Path

import pytest

from api.services.environmental_score import (
    component_score,
    calculate_environmental_score,
)


ROOT = Path(__file__).resolve().parents[2]

CONFIG = json.loads(
    (
        ROOT / "config/environmental_score.v1.json"
    ).read_text()
)


@pytest.mark.parametrize(
    "value,expected",
    [
        (600, 100),
        (450, 100),
        (800, 100),
        (300, 40),
        (1000, 100 / 3),
        (200, 0),
        (24, None),
    ],
)
def test_soil_score(value, expected):
    rule = CONFIG["metrics"]["soil_moisture"]

    result = component_score(value, rule)

    if expected is None:
        assert result is None
    else:
        assert result == pytest.approx(expected)


def test_perfect_conditions():
    readings = {
        "air_temperature": 24,
        "relative_humidity": 60,
        "soil_moisture": 600,
    }

    result = calculate_environmental_score(
        readings, CONFIG
    )

    assert result["score"] == 100
    assert result["status"] == "complete"


def test_score_with_dry_soil():
    readings = {
        "air_temperature": 24,
        "relative_humidity": 60,
        "soil_moisture": 300,
    }

    result = calculate_environmental_score(
        readings, CONFIG
    )

    assert result["score"] == 79


def test_suspect_soil_returns_incomplete():
    readings = {
        "air_temperature": 24,
        "relative_humidity": 60,
        "soil_moisture": 24,
    }

    result = calculate_environmental_score(
        readings, CONFIG
    )

    assert result["score"] is None
    assert "soil_moisture" in result["invalid_measurements"]
