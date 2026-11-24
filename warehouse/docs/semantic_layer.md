# Semantic layer (dbt MetricFlow)

A governed set of metrics and dimensions over the existing Snowflake marts. It is the foundation for a future natural-language analyst: the analyst discovers metrics, queries them with filters and groupings, and shows the SQL MetricFlow generated. Nothing here calls an LLM, the API, or the dashboard.

- Spec: dbt's legacy semantic-model YAML (`semantic_models:` with `measures:`), the format supported by the installed dbt Core 1.12.7 and MetricFlow 0.214.0.
- Definitions: [`models/marts/semantic/`](../models/marts/semantic/).
- Everything is **UTC**. MetricFlow does not shift time zones, so day, week (Monday start) and month boundaries are UTC boundaries.
- Data freshness equals the last `dbt build` (scheduled 00:30, 06:30, 12:30, 18:30 UTC). MetricFlow reads the marts; it does not touch the raw tables.

## 1. Architecture

```text
RAW.SENSOR_EVENTS ─► stg_sensor_events ─► int_sensor_readings ─► fct_sensor_hourly ─┬─► sensor_hourly            (A, B)
                                                                                    └─► fct_environmental_score_hourly ─► environmental_score_hourly (B)
RAW.AUTOMATION_EVENTS ─► stg_automation_events ─┬─► fct_actuator_cycles ──────────► actuator_cycles             (C)
                                                └─► fct_automation_events ─┬──────► automation_events           (D)
                                                                           └─► fct_automation_commands ─► automation_commands (D)
```

Design choices:

- **One semantic model per grain.** Hourly sensor facts, hourly scores, cycles, events and commands each have their own. No fact is modelled twice: the daily sensor and score marts are exact rollups of the hourly ones, so MetricFlow aggregates the hourly tables to any coarser grain instead.
- **Reading-weighted averages.** `fct_sensor_hourly.avg_value` is an average, so averaging it gives every hour equal weight regardless of how many readings it holds. Every sensor average is `sum(avg_value × reading_count) / sum(reading_count)`, which equals the average over the underlying readings. A dbt test (`assert_sensor_hourly_matches_daily`) checks the weighted rollup against `fct_sensor_daily`, which is aggregated straight from readings.
- **No fan-out.** `gateway` and `sensor` are *foreign* entities, and no two foreign entities join. The only cross-model join is `automation_events.command` (foreign) → `automation_commands.command` (primary, unique per `command_id`), which is many-to-one. Metrics from different models are combined on shared dimensions (`metric_time`), never by joining fact tables.
- **Calibrated soil moisture only.** The marts already publish soil moisture as the calibrated percent (unit `percent`); raw capacitance never appears.
- **Zero-filling.** Count and runtime metrics are filled with `0` against a UTC time spine, so a day with no pump runs returns `0`, not a missing row. Averages, maxima and rates stay `NULL` when there is nothing to average.

### Supporting models added

| Model | Why it was necessary |
| --- | --- |
| `fct_automation_commands` | Correct acknowledgment metrics need one row per command. Counting `command_acknowledged` events would be keyed to the wrong time and inflate on retries or duplicates. |
| `metricflow_time_spine_daily`, `metricflow_time_spine_hourly` | MetricFlow needs a time spine for zero-filling. None existed. Both are tables, because the dbt role can create tables but not views in the marts schema. They run from 2026-10-01 to the current UTC date/hour. |
| 3 columns on `fct_sensor_hourly` (`valid_range_reading_count`, `in_target_range_reading_count`, `below_target_min_reading_count`) | Reading-level target-range compliance cannot be recovered from hourly averages. Grain is unchanged, the columns are appended, and targets come from the `environmental_score_rules` seed so thresholds are not duplicated. |

## 2. Semantic models

| Semantic model | Source | Grain | Time axis (`metric_time`) | Primary entity | Foreign entities |
| --- | --- | --- | --- | --- | --- |
| `sensor_hourly` | `fct_sensor_hourly` | UTC hour × gateway × sensor × measurement type × unit | `measurement_hour_utc` (hour) | `sensor_hour` | `gateway`, `sensor` |
| `environmental_score_hourly` | `fct_environmental_score_hourly` | UTC hour × gateway × score version | `measurement_hour_utc` (hour) | `score_hour` | `gateway` |
| `actuator_cycles` | `fct_actuator_cycles` | one completed ON→OFF cycle | `started_at_utc` (hour) | `actuator_cycle` | none |
| `automation_events` | `fct_automation_events` | one event | `measured_at_utc` (hour) | `automation_event` | `command` |
| `automation_commands` | `fct_automation_commands` | one command issued | `issued_at_utc` (hour) | `command` | none |

Primary entities of the composite-grain models are concatenated keys; uniqueness is enforced by dbt tests on the underlying tables.

**Not implemented: automation impact.** There is no `mart_automation_impact` (or any pre/post-actuation analysis model) in this project, so metrics such as moisture change after irrigation or the share of cycles with enough measurements are omitted rather than invented. See [section 10](#10-notes-for-the-ai-analyst).

## 3. Metric catalog

Metric names are the identifiers to pass to MetricFlow. "Building block" metrics exist only to compose others (they are tagged `meta.role: building_block`) and should not be offered to users.

### A. Environmental conditions (`sensor_hourly`)

| Metric | Definition | Unit |
| --- | --- | --- |
| `avg_temperature_c` | Reading-weighted average air temperature | °C |
| `min_temperature_c` | Lowest air temperature reading | °C |
| `max_temperature_c` | Highest air temperature reading | °C |
| `temperature_range_c` | `max_temperature_c − min_temperature_c` within the grouping (derived) | °C |
| `temperature_reading_count` | Valid air temperature readings | count |
| `avg_humidity_pct` | Reading-weighted average relative humidity | % (0–100) |
| `avg_soil_moisture_pct` | Reading-weighted average calibrated soil moisture | % (0–100) |
| `min_soil_moisture_pct` | Lowest calibrated soil moisture reading | % |
| `max_soil_moisture_pct` | Highest calibrated soil moisture reading | % |
| `soil_moisture_reading_count` | Valid soil moisture readings | count |
| `sensor_reading_count` | Building block: all readings, any type | count |
| `sensor_value_sum` | Building block: `avg_value × reading_count` | mixed |

### B. Environmental health

| Metric | Source | Definition | Unit |
| --- | --- | --- | --- |
| `avg_environmental_score` | `environmental_score_hourly` | Average of non-null hourly composite scores | score 0–100 |
| `min_environmental_score` | same | Lowest hourly composite score | score 0–100 |
| `avg_temperature_score` | same | Average hourly temperature component score | score 0–100 |
| `avg_humidity_score` | same | Average hourly humidity component score | score 0–100 |
| `avg_moisture_score` | same | Average hourly soil moisture component score | score 0–100 |
| `scored_hour_count` | same | Hours with a complete composite score | count |
| `environmental_score_coverage_pct` | same | Scored hours ÷ hourly score rows (derived) | % |
| `pct_temperature_readings_in_range` | `sensor_hourly` | Valid temperature readings inside 20–26 °C ÷ valid readings (derived) | % |
| `pct_humidity_readings_in_range` | `sensor_hourly` | Valid humidity readings inside 85–97 % ÷ valid readings (derived) | % |
| `pct_moisture_readings_below_threshold` | `sensor_hourly` | Valid calibrated moisture readings below 40 % ÷ valid readings (derived) | % |
| `environmental_score_hour_count`, `valid_range_reading_count`, `in_target_range_reading_count`, `below_target_min_reading_count` | | Building blocks for the derived metrics above | count |

Target limits come from [`config/environmental_score.v1.json`](../../config/environmental_score.v1.json) via the `environmental_score_rules` seed (limits inclusive). The irrigation threshold of 40 % equals both the soil moisture lower target and the controller's `PUMP_MOISTURE_THRESHOLD`; they are configured separately, so check both if either changes.

### C. Automation activity (`actuator_cycles`, attributed to cycle **start** time)

| Metric | Definition | Unit |
| --- | --- | --- |
| `fan_cycle_count` | Completed fan cycles | count |
| `pump_cycle_count` | Completed, controller-verified (`cycle_id`) irrigation cycles | count |
| `total_fan_runtime_seconds` | Summed duration of completed fan cycles | seconds |
| `total_fan_runtime_hours` | Same, in hours (derived) | hours |
| `total_pump_runtime_seconds` | Summed duration of verified pump cycles | seconds |
| `avg_fan_cycle_duration_seconds` | Mean fan cycle duration | seconds |
| `avg_pump_cycle_duration_seconds` | Mean verified pump cycle duration | seconds |
| `max_fan_cycle_duration_seconds` | Longest fan cycle | seconds |
| `max_pump_cycle_duration_seconds` | Longest verified pump cycle | seconds |

Pairing decision: the fan only ever has `sequential_state` pairs (each ON with the next OFF), so all fan cycles qualify. Pump cycles qualify only with `pairing_method = 'cycle_id'`, because a shared controller cycle id verifies the ON and OFF belong together. Pump pairs without a `cycle_id` (for example a manual activation) are excluded from the `pump_*` metrics. Cycles still ON are never counted.

### D. Automation reliability

| Metric | Source | Definition | Unit |
| --- | --- | --- | --- |
| `automation_event_count` | `automation_events` | Distinct events, all types, by event time | count |
| `state_change_count` | same | `state_changed` events excluding `initial_observation` | count |
| `command_issued_count` | `automation_commands` | Distinct commands issued, by issue time | count |
| `command_acknowledged_count` | same | Commands issued in the period acknowledged at least once | count |
| `command_failure_count` | same | Commands issued in the period with a `command_failed` event (error or timeout) | count |
| `command_timeout_count` | same | Subset of failures that were RPC timeouts (`rpc_timeout_outcome_unknown`) | count |
| `unexpected_pump_on_command_count` | same | Pump OFF commands issued with reason `unexpected_pump_on` | count |
| `command_acknowledgment_rate_pct` | same | Acknowledged ÷ issued, as a cohort by issue time (derived) | % |
| `avg_command_acknowledgment_latency_seconds` | same | Mean seconds from issue to first acknowledgment | seconds |

Totals: 38 reportable metrics plus 6 building blocks (44 in `mf list metrics`).

## 4. Dimensions and time grains

`metric_time` is available on every metric. Grains: `hour`, `day`, `week`, `month`, `quarter`, `year` (not finer: see limitations). Query as `metric_time__day`, `metric_time__week`, and so on. MetricFlow's `extract_*` date parts are not available in this version; use the explicit dimensions below for hour-of-day and weekday.

| Semantic model | Dimension prefix | Dimensions |
| --- | --- | --- |
| `sensor_hourly` | `sensor_hour__` | `measurement_type`, `unit`, `gateway_id`, `sensor_id`, `hour_of_day_utc` (0–23), `day_of_week_utc` (1 = Monday … 7), `measurement_hour_utc` |
| `environmental_score_hourly` | `score_hour__` | `gateway_id`, `score_version`, `status` (`complete` / `incomplete`), `hour_of_day_utc`, `measurement_hour_utc` |
| `actuator_cycles` | `actuator_cycle__` | `actuator` (`fan`, `pump`), `pairing_method` (`cycle_id`, `sequential_state`), `on_reason`, `off_reason`, `start_hour_of_day_utc`, `started_at_utc`, `ended_at_utc` |
| `automation_events` | `automation_event__` | `actuator`, `event_type`, `reason`, `desired_state`, `observed_state`, `is_initial_observation`, `measured_at_utc` |
| `automation_commands` | `command__` | `actuator`, `reason`, `desired_state`, `is_acknowledged`, `is_failed`, `is_timeout_outcome_unknown`, `failure_reason`, `issued_at_utc` |

Event metrics also accept `command__…` dimensions through the `command` entity.

Values seen in the data today:

- Event types: `command_issued`, `command_acknowledged`, `command_failed`, `state_changed` (the only values the schema allows).
- Command reasons: `temperature_high`, `temperature_normal` (fan), `soil_moisture_low` (pump). The controller can also issue `unexpected_pump_on`, `pump_command_runtime_exceeded` and `pump_runtime_exceeded` safety OFFs; none have occurred yet.
- State-change reasons: `shelly_status`, `initial_observation`, and `NULL` on older rows.

## 5. Limitations and measurement caveats

**Sensors**

- Calibrated moisture is `100 × share of the last 10 raw readings ≥ 990`, computed per gateway and sensor in `int_sensor_readings`. It is a proxy for how consistently the sensor reads wet, not volumetric water content. Values move in steps of 10. The first 9 readings of a sensor use a partial window, and the window does not reset across gaps or implausible raw values the way the Pi controller's does.
- Hourly marts keep readings that are plausible only by non-null checks. Outliers are not removed (except in compliance percentages, which use the scoring rules' valid ranges).
- `min_*`/`max_*` are exact single-reading extremes, so one noisy reading widens `temperature_range_c`.
- The minimum grain is the hour. Per-reading or sub-hour questions cannot be answered.
- Pressure is in the hourly mart but has no metric; add one if needed.
- Variability is limited to range. Standard deviation is not exposed because pooling it from hourly values needs extra columns.

**Environmental health**

- Scores are computed from **hourly average** readings, not every reading, and indicate alignment with configured targets, not plant health.
- Incomplete hours have a `NULL` composite score and are excluded from averages, never counted as zero. Use `environmental_score_coverage_pct` to see how many hours were excluded. Hours with no sensor data at all have no row and are invisible to that metric.
- `pct_*_readings_*` count **readings**, not elapsed time. Uneven sampling or outages bias them. They are not "time in range".
- If a second `score_version` is ever added, averages would mix versions. `assert_single_score_version` warns when that happens; add a version filter to the metrics first.

**Automation activity**

- Everything is attributed to the cycle start. A cycle crossing midnight belongs wholly to the starting day, so runtime is "runtime of cycles started in the period", not seconds the actuator was ON in the period. No duty-cycle percentage is offered because its denominator and boundary handling are not defined by this model.
- Durations are whole seconds (`DATEDIFF('second')`), so an 8-second pump run carries up to about ±1 s error.
- Fan cycles are inferred from adjacent state changes, not verified by an id.
- `actuator_cycle__on_reason` and `off_reason` are often `NULL`.

**Automation reliability**

- Acknowledged means the device accepted the RPC. It does **not** prove the relay changed state, and no success rate is derived from state changes.
- `command_failed` includes RPC timeouts whose outcome is unknown: the relay may have switched. Compare `command_failure_count` with `command_timeout_count`.
- `unexpected_pump_on_command_count` counts the controller's responses. Retries every few seconds are separate commands, so it overstates the number of distinct unexpected activations.
- Command metrics use the issue time. A command from late on one day acknowledged the next still counts on the first day. Commands issued very recently may not yet show an acknowledgment because of load lag.
- At the time of writing the data set is small (5 commands, 3 pump ON events of which 2 are completed cycles, 1 fan cycle), so rates and averages are not statistically meaningful yet.

**Querying**

- Put the date range in its own `--where` that references only `metric_time` at the grain you group by (`TimeDimension('metric_time', 'day')`, inclusive on both ends). MetricFlow pushes such a filter into the time spine. If it is combined with another dimension in the same `--where`, the whole spine (from 2026-10-01) is zero-filled; pass two `--where` flags instead.
- **Do not use `--end-time`** for whole-day ranges. This MetricFlow version renders the bound as a date (`BETWEEN '2026-11-20' AND '2026-11-23'`), which compares as midnight and silently drops all of the last day's data, even with `--end-time 2026-11-23T23:59:59`. `--start-time` alone is safe.
- The spine ends at the build time; the newest day may be partial until the next build.

## 6. Install and run locally

```bash
# from the repository root
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements/metricflow.txt     # dbt-snowflake (pinned) + dbt-metricflow

cd warehouse
export DBT_PROFILES_DIR=~/.dbt     # mf looks in the current directory by default; dbt looks in ~/.dbt
# Snowflake profile "warehouse" must exist (see docs/snowflake-setup.md)

dbt build                          # builds marts, spines and tests; run once so the tables exist
mf list metrics
mf validate-configs
```

`dbt parse` already validates the semantic manifest (names, entities, filters, derived inputs). `mf validate-configs` additionally checks every semantic model, dimension, entity, measure and metric against the live warehouse.

GitHub Actions needs no change: the `dbt build --target prod` step parses and validates the semantic YAML and builds the new models. `requirements/dbt.txt` is unchanged; MetricFlow's CLI is only needed for interactive use, via `requirements/metricflow.txt`. Optionally add a `pip install -r requirements/metricflow.txt && mf validate-configs` step.

## 7. Example queries

```bash
# First query: pump runs per day over a date range (the date filter is its own --where)
mf query --metrics pump_cycle_count --group-by metric_time__day \
  --where "{{ TimeDimension('metric_time', 'day') }} >= '2026-11-17' AND {{ TimeDimension('metric_time', 'day') }} <= '2026-11-23'"

# Environmental metric, weekly
mf query --metrics avg_temperature_c,max_temperature_c --group-by metric_time__week

# Categorical grouping: soil moisture by UTC hour of day
mf query --metrics avg_soil_moisture_pct --group-by sensor_hour__hour_of_day_utc --order sensor_hour__hour_of_day_utc

# Environmental health with a date filter
mf query --metrics avg_environmental_score,environmental_score_coverage_pct \
  --group-by metric_time__day --order metric_time__day \
  --where "{{ TimeDimension('metric_time', 'day') }} >= '2026-11-01'"

# Cross-domain: daily temperature next to fan cycle length (joined on metric_time)
mf query --metrics avg_temperature_c,avg_fan_cycle_duration_seconds,fan_cycle_count \
  --group-by metric_time__day --order metric_time__day \
  --where "{{ TimeDimension('metric_time', 'day') }} >= '2026-11-15'"

# Ratio/derived metric by actuator
mf query --metrics command_issued_count,command_acknowledgment_rate_pct --group-by command__actuator

# Date filter plus a dimension filter (two --where flags keep the date filter pushed into the spine)
mf query --metrics automation_event_count --group-by metric_time__day \
  --where "{{ Dimension('automation_event__actuator') }} = 'pump'" \
  --where "{{ TimeDimension('metric_time', 'day') }} >= '2026-11-22'"

# Discovery
mf list metrics
mf list dimensions --metrics fan_cycle_count
```

## 8. Inspecting generated SQL

Add `--explain` to any query (it compiles without running):

```bash
mf query --metrics pump_cycle_count --group-by metric_time__day --explain
mf query --metrics avg_temperature_c --group-by metric_time__day --show-dataflow-plan --explain
```

The reading-weighted average compiles to `SUM(avg_value * reading_count)` divided by `NULLIF(SUM(reading_count), 0)`. Count metrics left-join the time spine and wrap the result in `COALESCE(..., 0)`. For a "See SQL" feature, call the same explain path programmatically or run the CLI with `--explain` and capture the SQL.

## 9. Adding a metric

1. Find the semantic model whose grain matches the question (section 2). Do not add a new model if one fits.
2. If the needed column is not a measure yet, add a `measures:` entry (`agg: sum | average | min | max | count | count_distinct | sum_boolean`) and any new `dimensions:`.
3. Add the metric to the domain's YAML file with a description that states what it measures, its unit, when to use it, and its limits. Use `type: simple` for one measure, `ratio` for a fraction of two filtered metrics, and `derived` for arithmetic. Write percentages as `100.0 * a / NULLIF(b, 0)` so zero denominators produce `NULL`.
4. For counts and sums, add `fill_nulls_with: 0` and `join_to_timespine: true` so empty days read `0`.
5. Never average an average: carry a count and divide a sum by it.
6. Run `dbt parse`, `mf validate-configs`, then query it and compare with a direct SQL aggregation.
7. If the measure needs a column the marts lack, extend the mart with an appended column and add a dbt test. Do not change grains.

## 10. Notes for the AI analyst

- **Discovery:** list metrics, but hide those with `config.meta.role == building_block`. Descriptions and `label` are written for an LLM. Pull dimensions per metric with `mf list dimensions --metrics <name>` and do not offer dimensions from a different model, since MetricFlow will reject them.
- **Always express the date range as its own `metric_time` filter at the grouping grain** (never `end_time`; see section 5) and group by `metric_time__<grain>`. Resolve "yesterday", "this week" and "last month" to UTC dates before calling MetricFlow.
- **Surface caveats:** quote the metric's description limits (reading-based percentages, attributed to cycle start, acknowledgment is not success).
- **Prefer cohort and coverage context:** pair averages with `*_reading_count` or `environmental_score_coverage_pct`; with a small data set, state the sample size.
- **Refuse or reframe** causal questions (does irrigation raise moisture?) until an impact model exists. See next steps.
- **Show the SQL** with `--explain`.
- **Next steps:** (1) add an automation impact mart, one row per analysed cycle with pre/post windows and a coverage flag, then expose `avg_*_change` and coverage metrics; (2) expose the semantic layer through the dbt Semantic Layer or MetricFlow's Python API behind a read-only service role (SELECT on `GREENHOUSE_DBT_MARTS`), not the existing FastAPI service; (3) add saved queries for the common dashboard questions; (4) add an evaluation set of the questions below with expected metric and grouping.

### Representative questions

| Question | Metrics and grouping |
| --- | --- |
| What was the average greenhouse temperature yesterday? | `avg_temperature_c` by `metric_time__day`, date range of yesterday |
| How has average soil moisture changed over the last week? | `avg_soil_moisture_pct` by `metric_time__day` |
| What time of day is the greenhouse hottest? | `avg_temperature_c` (and `max_temperature_c`) by `sensor_hour__hour_of_day_utc`. Hours are UTC. |
| Which days had the greatest temperature extremes? | `temperature_range_c`, `max_temperature_c`, `min_temperature_c` by `metric_time__day`, ordered descending |
| How does moisture vary by hour of day? | `avg_soil_moisture_pct` by `sensor_hour__hour_of_day_utc` |
| Is humidity rising or falling? | `avg_humidity_pct` by `metric_time__day` or `metric_time__week` |
| How many times did the pump run yesterday? | `pump_cycle_count` by `metric_time__day` (returns `0` if none) |
| How many hours did the fan run this week? | `total_fan_runtime_hours` by `metric_time__week` |
| Are fan cycles getting longer? | `avg_fan_cycle_duration_seconds` and `fan_cycle_count` by `metric_time__week` |
| Does irrigation usually happen at the same time of day? | `pump_cycle_count` by `actuator_cycle__start_hour_of_day_utc` |
| Which days had the most fan or pump activity? | `fan_cycle_count`, `pump_cycle_count`, `total_fan_runtime_seconds` by `metric_time__day` |
| What percentage of temperature readings were within the target range? | `pct_temperature_readings_in_range` (reading-based, not time-based) |
| What percentage of moisture readings were below the irrigation threshold? | `pct_moisture_readings_below_threshold` by `metric_time__day` |
| What was the average environmental score last month? | `avg_environmental_score` with `environmental_score_coverage_pct`, `metric_time__month` |
| Which part of the score is dragging it down? | `avg_temperature_score`, `avg_humidity_score`, `avg_moisture_score` by `metric_time__week` |
| How often are automation commands acknowledged? | `command_acknowledgment_rate_pct`, `command_issued_count` by `command__actuator` |
| How many commands failed or timed out? | `command_failure_count`, `command_timeout_count` by `metric_time__week` and `command__actuator` |
| Did the pump ever turn on unexpectedly? | `unexpected_pump_on_command_count` by `metric_time__day` (counts safety responses, not distinct activations) |
| Are fan cycles longer on hotter days? | `avg_fan_cycle_duration_seconds` with `avg_temperature_c` by `metric_time__day` (correlation only) |
| How does daily moisture compare with daily irrigation frequency? | `avg_soil_moisture_pct` with `pump_cycle_count` by `metric_time__day` |
| What temperature changes occur during fan cycles? | **Not supported yet.** Needs an automation impact model. |
| How much does soil moisture change after irrigation? | **Not supported yet.** Needs an automation impact model. |
| What percentage of irrigation cycles have enough measurements to assess their effect? | **Not supported yet.** Needs an automation impact model. |
