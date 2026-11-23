# Warehouse (dbt)

dbt project over Snowflake `GREENHOUSE_ANALYTICS`. Staging deduplicates raw S3-loaded events on `event_id`; intermediate and mart models power the history and environmental-score APIs.

## Models of interest

| Model | Grain | Role |
| --- | --- | --- |
| `fct_sensor_hourly` | gateway × sensor × measurement × UTC hour | Sensor history (`24h` / `7d`) |
| `fct_sensor_daily` | gateway × sensor × measurement × UTC date | Sensor history (`30d`) |
| `fct_environmental_score_hourly` | gateway × UTC hour | Environmental score history (`24h` / `7d`) |
| `fct_environmental_score_daily` | gateway × UTC date | Environmental score history (`30d`) |

Hourly environmental scores apply the versioned rules to **hourly average** temperature, humidity, and soil moisture from `fct_sensor_hourly`, then form a weighted composite when all three components are valid. That is **not** the same as scoring every synchronized raw event.

Daily environmental scores average valid hourly composites and expose `avg` / `min` / `max` plus `scored_hours` and `hours_with_data`.

Schema docs and tests: [`models/marts/marts.yml`](models/marts/marts.yml). Custom SQL tests:

- [`tests/environmental_score_hourly_bounds.sql`](tests/environmental_score_hourly_bounds.sql)
- [`tests/environmental_score_hourly_completeness.sql`](tests/environmental_score_hourly_completeness.sql)

## Scoring rules seed

[`seeds/environmental_score_rules.csv`](seeds/environmental_score_rules.csv) is generated from [`config/environmental_score.v1.json`](../config/environmental_score.v1.json):

```bash
# from repository root
python warehouse/scripts/generate_score_seed.py
```

Do not edit the CSV by hand. Change the JSON, regenerate, commit both, and bump `version` when rules change meaning.

The hourly score model joins mart readings to the seed on `measurement_type` **and** `unit` (soil moisture uses calibrated `percent`).


## Scheduled builds

GitHub Actions job `dbt` on `main` (schedule or `workflow_dispatch`) installs dbt, regenerates the seed (diff must be clean), runs `dbt debug`, then `dbt build --target prod`. See [Deployment](../docs/deployment.md) and [Snowflake setup](../docs/snowflake-setup.md).

S3 → Snowflake loading is a Snowflake task (`RAW.LOAD_SENSOR_EVENTS`, cron `0 0,6,12,18 * * * UTC`), not an API container job. dbt assumes `RAW.SENSOR_EVENTS` is already populated. Bootstrap SQL patterns for the database, stage, task, and service users are documented in [Snowflake setup](../docs/snowflake-setup.md) (without key material).

## Related

- [Environmental Conditions Score](../docs/environmental-conditions-score.md)
- [API reference](../docs/api.md)
- [Architecture](../docs/architecture.md)
