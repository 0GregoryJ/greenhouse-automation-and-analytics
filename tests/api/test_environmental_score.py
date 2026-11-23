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
        (60, 100),
        (40, 100),
        (80, 100),
        (20, 50),
        (90, 50),
        (0, 0),
        (100, 0),
        (101, None),
    ],
)
def test_soil_score(value, expected):
    rule = CONFIG["metrics"]["soil_moisture"]

    result = component_score(value, rule)

    if expected is None:
        assert result is None
    else:
        assert result == pytest.approx(expected)


@pytest.mark.parametrize(
    "value,expected",
    [
        (90, 100),
        (85, 100),
        (97, 100),
        (100, 0),
        (50, 0),
        (70, pytest.approx(100 * (1 - (85 - 70) / 35))),
    ],
)
def test_humidity_score(value, expected):
    rule = CONFIG["metrics"]["relative_humidity"]
    result = component_score(value, rule)
    assert result == pytest.approx(expected)


def test_perfect_conditions():
    readings = {
        "air_temperature": 24,
        "relative_humidity": 90,
        "soil_moisture": 60,
    }

    result = calculate_environmental_score(
        readings, CONFIG
    )

    assert result["score"] == 100
    assert result["status"] == "complete"
    assert result["score_version"] == "conditions-v2"


def test_score_with_dry_soil():
    readings = {
        "air_temperature": 24,
        "relative_humidity": 90,
        "soil_moisture": 20,
    }

    result = calculate_environmental_score(
        readings, CONFIG
    )

    # 0.4*100 + 0.2*100 + 0.4*50
    assert result["score"] == 80


def test_suspect_soil_returns_incomplete():
    readings = {
        "air_temperature": 24,
        "relative_humidity": 90,
        "soil_moisture": 140,
    }

    result = calculate_environmental_score(
        readings, CONFIG
    )

    assert result["score"] is None
    assert "soil_moisture" in result["invalid_measurements"]
