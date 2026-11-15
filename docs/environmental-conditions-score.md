# Environmental Conditions Score — Version 1

## Purpose

The Environmental Conditions Score is a rules-based indicator of how closely monitored greenhouse conditions align with a generalized set of growing-environment targets.

It combines air temperature, relative humidity, and raw capacitive soil moisture readings into a normalized score between 0 and 100.

A higher score indicates that the measured environment is closer to the configured target ranges.

**This score is not a direct plant-health measurement, a survival probability, a validated agronomic index, or a machine-learning prediction.**

It does not measure plant nutrition, photosynthesis, light exposure, pests, diseases, or plant growth.

Canonical configuration: [`config/environmental_score.v1.json`](../config/environmental_score.v1.json) (`score_version`: `conditions-v1`). Live scoring runs in FastAPI ([`api/services/environmental_score.py`](../api/services/environmental_score.py)). Historical scoring runs in dbt ([`warehouse/models/marts/fct_environmental_score_hourly.sql`](../warehouse/models/marts/fct_environmental_score_hourly.sql)).

## Input measurements

| Measurement | Target interval | Weight | Penalty reaches zero |
|---|---|---:|---|
| Air temperature | 20–26°C | 0.40 | At or below 12°C, or at or above 34°C |
| Relative humidity | 50–70% | 0.25 | At or below 25%, or at or above 95% |
| Soil moisture (raw units) | 450–800 | 0.35 | At or below 200, or at or above 1100 |

Temperature and humidity targets are generalized warm-growing greenhouse defaults, not species-specific requirements.

Soil thresholds are provisional engineering estimates based on observed sensor measurements, not calibrated volumetric water content.

The soil sensor has recently reported values ranging from 24 to 1000, with an average around 600. Readings below 150 are treated as suspect under the initial data-quality rules (`valid_min`).

Atmospheric pressure is available as a sensor measurement but excluded from the composite score because it is not sufficiently actionable as a standalone measure of plant suitability.

The configured soil unit is `raw_capacitance`, matching the event schema and firmware.

## Component scoring

Each measurement is assigned an individual score from 0 to 100.

Measurements inside their target interval receive 100 points.

Outside the target interval, the score declines linearly with distance from the nearest boundary.

For a reading \(x\), target interval \([L,U]\), lower tolerance \(T_L\), and upper tolerance \(T_U\):

\[
s(x)=
\begin{cases}
100\max(0,1-(L-x)/T_L), & x<L\\
100, & L\leq x\leq U\\
100\max(0,1-(x-U)/T_U), & x>U
\end{cases}
\]

This makes deviations proportionate rather than using abrupt binary thresholds.

The score is bounded between 0 and 100.

## Composite formula

\[
S=0.40S_T+0.25S_H+0.35S_M
\]

Where:

- \(S_T\) is temperature suitability.
- \(S_H\) is humidity suitability.
- \(S_M\) is soil moisture suitability.

All three components must be available and valid for a complete score.

Weights are design assumptions, not experimentally determined plant-response coefficients.

## Soil-moisture limitations

The capacitive soil sensor provides a raw relative measurement. The score does not interpret this as a percentage of soil water content.

The initial target interval of 450–800 raw units is provisional and should be revisited following calibration against known dry and moist substrate conditions.

Readings below 150 are flagged as suspect by the initial quality rules. This threshold is a heuristic, not a manufacturer-defined failure boundary.

Changes to calibration, weights, or scoring thresholds should produce a new score version so historical values remain interpretable.

## Live calculations

Live scores are calculated by FastAPI using the latest measurements available through Redis (`GET /api/v1/environment/score/current`).

The service validates the required measurement types and units, verifies reading freshness and timestamp alignment (`max_reading_age_seconds`, `max_sensor_skew_seconds` in the config), and returns either a complete score or an explicit incomplete/unavailable status.

The React frontend displays the score returned by the backend; it does not independently calculate the score.

## Historical calculations

Historical scores are calculated using dbt models in Snowflake:

- `fct_environmental_score_hourly` — scores hourly average temperature, humidity, and soil moisture before combining them into an hourly composite.
- `fct_environmental_score_daily` — summarizes valid hourly scores (avg/min/max, scored hours).

Rules are loaded from the `environmental_score_rules` seed, generated from the same JSON config by [`warehouse/scripts/generate_score_seed.py`](../warehouse/scripts/generate_score_seed.py).

This methodology does not detect every short-lived extreme and is not equivalent to calculating a suitability score for each synchronized raw event.

Historical scores may lag behind live conditions because S3 ingestion, Snowflake loading, and dbt transformations occur on schedules.

## Interpretation

A score of 100 indicates that all three observed measurements are within their configured target intervals.

A lower score indicates deviation from one or more targets.

A score of 0 indicates that the weighted suitability calculations have reached their zero limits; it does not mean the plant is dead or that conditions are universally fatal.

A missing score (`null`) indicates insufficient or invalid data and should not be interpreted as a poor environmental condition. The dashboard must not display null as zero.

Historical scores should only be compared directly when they use compatible scoring specifications and calibration versions.

## Future improvements

- Calibrate soil moisture against known substrate conditions.
- Introduce crop-specific and growth-stage-specific target profiles.
- Evaluate vapor pressure deficit as an alternative atmospheric indicator.
- Improve historical scoring using synchronized, finer-grained events.
- Version the scoring methodology and preserve historical comparability.
- Add configurable environmental alerts based on user-selected thresholds.

## Related

- [API reference](api.md#environmental-conditions-score)
- [Warehouse (dbt)](../warehouse/README.md)
- [Snowflake setup](snowflake-setup.md)
- [Architecture](architecture.md)
