# Warehouse (dbt)

dbt project over Snowflake `GREENHOUSE_ANALYTICS`. Staging deduplicates raw S3-loaded sensor and automation events on `event_id`; intermediate and mart models power the history, environmental-score, and automation APIs.

## Layers

| Layer | Models | Notes |
| --- | --- | --- |
| Sources | `RAW.SENSOR_EVENTS`, `RAW.AUTOMATION_EVENTS` | Loaded from S3 by Snowflake tasks ([Snowflake setup](../docs/snowflake-setup.md)) |
| Staging (views) | `stg_sensor_events`, `stg_automation_events` | Parse the `VARIANT`, keep the latest loaded row per `event_id` |
| Intermediate (views) | `int_sensor_readings`, `int_sensor_event_audit` | `int_sensor_readings` validates readings, derives UTC hour and date, and adds `calibrated_moisture`; `int_sensor_event_audit` feeds the quality mart |
| Marts (tables) | Listed below | Built by `dbt build` |

`calibrated_moisture` is the percent of the last 10 readings per gateway and sensor (ordered by time, `event_id`) with raw value at or above 990. It is the same transform the Pi controller and API apply ([methodology](../docs/environmental-conditions-score.md#soil-moisture-calibration)). Sensor marts report soil moisture in this calibrated value with unit `percent`; raw capacitance stays available in the intermediate and staging layers.

## Models of interest

| Model | Grain | Role |
| --- | --- | --- |
| `fct_sensor_hourly` | gateway × sensor × measurement × UTC hour | Sensor history (`24h` / `7d`) |
| `fct_sensor_daily` | gateway × sensor × measurement × UTC date | Sensor history (`30d`) |
| `fct_environmental_score_hourly` | gateway × UTC hour | Environmental score history (`24h` / `7d`) |
| `fct_environmental_score_daily` | gateway × UTC date | Environmental score history (`30d`) |
| `fct_sensor_quality_daily` | gateway × sensor × measurement × UTC date | Data-quality counts |
| `fct_automation_events` | one row per automation event | Fan/pump command and state history (validated, with UTC hour and date) |
| `fct_actuator_cycles` | one completed ON→OFF cycle | Actuator run start, end, duration, reasons, and pairing method (`/api/v1/history/automations`) |

The API also reads `int_sensor_readings` directly for automation overlays, so its role needs `SELECT` on the intermediate schema.

`fct_actuator_cycles` pairs `state_changed` events two ways: by shared `cycle_id` (pump runs) and, for events without one (fan), each ON with the next OFF for that actuator. Cycles that have not yet seen an OFF are not listed.

Hourly environmental scores apply the versioned rules to **hourly average** temperature, humidity, and soil moisture from `fct_sensor_hourly`, then form a weighted composite when all three components are valid. That is **not** the same as scoring every synchronized raw event.

Daily environmental scores average valid hourly composites and expose `avg` / `min` / `max` plus `scored_hours` and `hours_with_data`.

Schema docs and tests: [`models/staging/staging.yml`](models/staging/staging.yml), [`models/marts/marts.yml`](models/marts/marts.yml) (not-null, unique, and accepted-values tests on keys, actuators, and event types). Custom SQL tests:

- [`tests/environmental_score_hourly_bounds.sql`](tests/environmental_score_hourly_bounds.sql)
- [`tests/environmental_score_hourly_completeness.sql`](tests/environmental_score_hourly_completeness.sql)
- [`tests/assert_unique_hourly_grain.sql`](tests/assert_unique_hourly_grain.sql), [`tests/assert_unique_daily_grain.sql`](tests/assert_unique_daily_grain.sql)

## Scoring rules seed

[`seeds/environmental_score_rules.csv`](seeds/environmental_score_rules.csv) is generated from [`config/environmental_score.v1.json`](../config/environmental_score.v1.json):

```bash
# from repository root
python warehouse/scripts/generate_score_seed.py
```

Do not edit the CSV by hand. Change the JSON, regenerate, commit both, and bump `version` when rules change meaning. The current version is `conditions-v2`.

The hourly score model joins mart readings to the seed on `measurement_type` **and** `unit` (soil moisture uses calibrated `percent`).

## Scheduled builds

GitHub Actions job `dbt` on `main` (schedule or `workflow_dispatch`) installs dbt, regenerates the seed (diff must be clean), runs `dbt debug`, then `dbt build --target prod`. See [Deployment](../docs/deployment.md) and [Snowflake setup](../docs/snowflake-setup.md).

S3 → Snowflake loading is done by Snowflake tasks (for example `RAW.LOAD_SENSOR_EVENTS`, cron `0 0,6,12,18 * * * UTC`, plus an equivalent task for automation events), not an API container job. dbt assumes `RAW.SENSOR_EVENTS` and `RAW.AUTOMATION_EVENTS` are already populated. Bootstrap SQL patterns for the database, stage, task, and service users are documented in [Snowflake setup](../docs/snowflake-setup.md) (without key material).

## Related

- [Environmental Conditions Score](../docs/environmental-conditions-score.md)
- [API reference](../docs/api.md)
- [Architecture](../docs/architecture.md)
