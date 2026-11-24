# Environmental Conditions Score — `conditions-v2`

## Purpose

The Environmental Conditions Score is a rules-based indicator of how closely monitored greenhouse conditions align with a generalized set of growing-environment targets.

It combines air temperature, relative humidity, and calibrated soil moisture (percent) into a normalized score between 0 and 100.

A higher score indicates that the measured environment is closer to the configured target ranges.

**This score is not a direct plant-health measurement, a survival probability, a validated agronomic index, or a machine-learning prediction.**

It does not measure plant nutrition, photosynthesis, light exposure, pests, diseases, or plant growth.

Canonical configuration: [`config/environmental_score.v1.json`](../config/environmental_score.v1.json) (`score_version`: `conditions-v2`; the filename predates the version bump). Live scoring runs in FastAPI ([`api/services/environmental_score.py`](../api/services/environmental_score.py)). Historical scoring runs in dbt ([`warehouse/models/marts/fct_environmental_score_hourly.sql`](../warehouse/models/marts/fct_environmental_score_hourly.sql)).

## Input measurements

| Measurement | Unit | Target interval | Weight | Penalty reaches zero |
|---|---|---|---:|---|
| Air temperature | °C | 20–26 | 0.40 | At or below 12, or at or above 34 |
| Relative humidity | % | 85–97 | 0.20 | At or below 50, or at or above 100 |
| Soil moisture (calibrated) | % | 40–80 | 0.40 | At or below 0, or at or above 100 |

Temperature targets are a generalized warm-growing default. The humidity band (85–97 %) is high and has only 3 points of tolerance above it, so near-saturated air is penalized quickly. None of these targets are species-specific requirements.

Valid ranges (`valid_min` / `valid_max`) reject impossible readings: -10 to 60 °C, 0 to 100 % humidity, 0 to 100 % soil moisture. A reading outside its valid range makes the whole score unavailable rather than zero.

Atmospheric pressure is available as a sensor measurement but excluded from the composite score because it is not sufficiently actionable as a standalone measure of plant suitability.

### Soil-moisture calibration

The capacitive soil sensor's raw output (`raw_capacitance`, emitted unchanged in events and the S3 archive) is noisy and not a direct water-content measure. The score instead uses a calibrated percentage:

> the share of the 10 most recent raw readings at or above **990**, as a percent (rounded to a whole percent)

At 40 % or more the soil is labelled `wet-like`; below that, `dry-like`. The calibrated value is a **proxy for how consistently the sensor reads wet**, not volumetric water content.

The same transform runs in three places and must stay in step:

| Where | Implementation |
|---|---|
| Pi automation controller | `transform_moisture_readings` in [`gateway/automation.py`](../gateway/automation.py) over a rolling window of the last 10 telemetry readings |
| Live API | `transform_moisture_readings` in [`api/services/moisture_reading_transform.py`](../api/services/moisture_reading_transform.py) (a copy of the same function) over the Redis list `greenhouse:history:*` (10 newest raw events per sensor); falls back to the single latest reading |
| dbt | `calibrated_moisture` in [`int_sensor_readings`](../warehouse/models/intermediate/int_sensor_readings.sql), a 10-row window per gateway and sensor |

Hourly and daily marts aggregate the calibrated value. The same value drives pump automation (irrigation when it stays below 40 %), so the score and the actuator react to the same signal.

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
S=0.40S_T+0.20S_H+0.40S_M
\]

Where:

- \(S_T\) is temperature suitability.
- \(S_H\) is humidity suitability.
- \(S_M\) is soil moisture suitability.

All three components must be available and valid for a complete score.

Weights are design assumptions, not experimentally determined plant-response coefficients.

## Soil-moisture limitations

The calibration is an engineering heuristic fitted to this sensor and substrate, not a laboratory calibration. The 990 threshold, the 10-reading window, and the 40–80 % target should be revisited against known dry and saturated substrate conditions or if the sensor or soil changes.

A window of 10 readings at the 5 s sampling interval covers under a minute, so the calibrated value can jump between coarse steps (multiples of 10 %). The score therefore changes in steps as the window fills and clears. Early in an outage or restart, with fewer than 10 raw readings available, the percentage is computed from whatever readings exist.

Changes to calibration, weights, or scoring thresholds should produce a new score version so historical values remain interpretable. Moving from `conditions-v1` (raw soil units, different weights and humidity band) to `conditions-v2` was such a change: any score recorded or exported under v1 is not comparable with v2. The dbt marts are rebuilt from raw events with the current seed, so warehouse history reflects the current version.

## Live calculations

Live scores are calculated by FastAPI using the latest measurements available through Redis (`GET /api/v1/environment/score/current`).

The service validates the required measurement types and units, verifies reading freshness and timestamp alignment (`max_reading_age_seconds`, `max_sensor_skew_seconds` in the config), and returns either a complete score or an explicit incomplete/unavailable status.

The React frontend displays the score returned by the backend; it does not independently calculate the score.

## Historical calculations

Historical scores are calculated using dbt models in Snowflake:

- `fct_environmental_score_hourly` — scores hourly average temperature, humidity, and calibrated soil moisture before combining them into an hourly composite.
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

- Validate the soil-moisture calibration against known substrate conditions, or move to a volumetric calibration.
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
