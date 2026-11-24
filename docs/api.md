# Greenhouse Monitoring API

Read-only FastAPI service on the serving host. Live readings, the live score, and recent automation events come from Redis; historical series, score history, and automation history come from Snowflake dbt models. Public HTTPS is terminated by Caddy.

Base URL (production): `https://api.gregoryjoshua.com`

CORS allow-list: `CORS_ORIGINS` (see [`.env.example`](../.env.example)).

## Health

### `GET /health`

Pings Redis only. Does **not** check Snowflake.

**200**

```json
{ "status": "ok" }
```

**503** — Redis unavailable.

```bash
curl -s https://api.gregoryjoshua.com/health
```

---

## Live sensor readings

### `GET /api/v1/sensors/latest`

Returns the latest Redis hash for every `greenhouse:latest:*` key. The response has `raw_value` (the stored value, unchanged), not `value`.

**Soil moisture** readings are enriched with a calibrated percentage: the share of the last 10 raw readings (`greenhouse:history:*`) at or above 990, and a `state` of `wet-like` (40 % or more) or `dry-like`. If no history exists yet, the single latest reading is used.

**200**

```json
{
  "count": 2,
  "readings": [
    {
      "gateway_id": "pi-001",
      "sensor_id": "bme280-001",
      "measurement_type": "air_temperature",
      "raw_value": 22.4,
      "unit": "celsius",
      "timestamp": "2026-11-14T20:00:00Z",
      "event_id": "…"
    },
    {
      "gateway_id": "pi-001",
      "sensor_id": "soil-001",
      "measurement_type": "soil_moisture",
      "raw_value": 1010.0,
      "calibrated_pct": 70,
      "state": "wet-like",
      "unit": "raw_capacitance",
      "timestamp": "2026-11-14T20:00:00Z",
      "event_id": "…"
    }
  ]
}
```

**503** — Redis error or non-numeric stored value.

```bash
curl -s https://api.gregoryjoshua.com/api/v1/sensors/latest | python3 -m json.tool
```

---

## Live automation events

### `GET /api/v1/automation/events/recent`

Returns up to 10 of the most recent automation events (newest first) from `greenhouse:automation:recent`, as written by the live consumer. Event fields follow the [automation event schema](data-contracts.md#automation-events).

**200**

```json
{
  "count": 1,
  "events": [
    {
      "schema_version": 1,
      "event_id": "…",
      "timestamp_utc": "2026-11-14T20:01:12.345678+00:00",
      "actuator": "pump",
      "event_type": "state_changed",
      "observed_state": true,
      "reason": "shelly_status",
      "cycle_id": "…",
      "temperature_c": 23.1
    }
  ]
}
```

**503** — Redis error (`Automation events are temporarily unavailable`).

```bash
curl -s https://api.gregoryjoshua.com/api/v1/automation/events/recent | python3 -m json.tool
```

---

## Historical sensor series

### `GET /api/v1/history/series`

| Query | Required | Notes |
| --- | --- | --- |
| `sensor_id` | yes | Sensor identifier |
| `measurement_type` | yes | e.g. `air_temperature` |
| `period` | no | `24h`, `7d` (default), or `30d` |

Resolution: hourly mart for `24h`/`7d`, daily mart for `30d`.

**200** — `points[]` with `timestamp`, `avg`, `min`, `max`, `count`, `unit`. Empty `points` with `count: 0` is success with no rows. Soil moisture history is the calibrated percentage (`unit: percent`), not raw capacitance.

**422** — invalid `period` or missing params.  
**503** — Snowflake unavailable / query failure.

```bash
curl -s "https://api.gregoryjoshua.com/api/v1/history/series?sensor_id=bme280-001&measurement_type=air_temperature&period=7d" \
  | python3 -m json.tool
```

---

### `GET /api/v1/history/automations`

Sensor series with actuator cycles, for the dashboard's automation overlay.

| Query | Required | Notes |
| --- | --- | --- |
| `gateway_id` | yes | Gateway whose readings are charted |
| `actuator` | no | `pump` (default) or `fan` |
| `period` | no | `24h`, `7d` (default), or `30d` |

The series is the metric the actuator controls: calibrated soil moisture (`percent`) for the pump, air temperature (`celsius`) for the fan. It is aggregated from `INT_SENSOR_READINGS` per hour for `24h`/`7d` and per day for `30d`. Cycles come from `FCT_ACTUATOR_CYCLES` for the same window.

**200**

```json
{
  "gateway_id": "pi-001",
  "actuator": "pump",
  "measurement_type": "soil_moisture",
  "period": "7d",
  "resolution": "hour",
  "unit": "percent",
  "count": 1,
  "points": [
    { "timestamp": "2026-11-14T20:00:00Z", "avg": 45.0, "min": 30.0, "max": 60.0, "count": 720, "unit": "percent" }
  ],
  "cycles": [
    {
      "cycle_id": "…",
      "actuator": "pump",
      "started_at": "2026-11-14T20:01:12Z",
      "ended_at": "2026-11-14T20:01:18Z",
      "duration_seconds": 6,
      "reason": "soil_moisture_low"
    }
  ]
}
```

`ended_at` and `duration_seconds` may be `null`. Cycles are not filtered by gateway.

**422** — invalid `actuator` or `period`.  
**503** — Snowflake unavailable (`Automation history temporarily unavailable`).

```bash
curl -s "https://api.gregoryjoshua.com/api/v1/history/automations?gateway_id=pi-001&actuator=pump&period=7d" \
  | python3 -m json.tool
```

---

## Environmental Conditions Score

Methodology: [Environmental Conditions Score](environmental-conditions-score.md). Versioned rules (currently `conditions-v2`) live in [`config/environmental_score.v1.json`](../config/environmental_score.v1.json).

### Live — `GET /api/v1/environment/score/current`

| Query | Required | Notes |
| --- | --- | --- |
| `gateway_id` | yes | Gateway whose latest Redis readings are scored |

Data source: Redis latest hashes for that gateway; soil moisture is scored as calibrated percent from the last 10 raw readings. Scoring runs in-process (Python), not in Snowflake.

**Complete score (200)**

```json
{
  "gateway_id": "pi-001",
  "score": 93.33,
  "score_version": "conditions-v2",
  "status": "complete",
  "invalid_measurements": [],
  "components": {
    "air_temperature": 100,
    "relative_humidity": 66.67,
    "soil_moisture": 100
  },
  "readings": {
    "air_temperature": 23.1,
    "relative_humidity": 98.0,
    "soil_moisture": 70.0
  },
  "measured_at": "2026-11-14T20:00:05+00:00"
}
```

**Incomplete / stale (200 with `score: null`)**

Statuses include `incomplete` (missing/invalid metrics) and `stale_or_unsynchronized` (age or skew limits). A null score means insufficient data — **never treat it as zero**.

**503** — Redis unavailable (`Live sensor data unavailable`).

```bash
curl -s "https://api.gregoryjoshua.com/api/v1/environment/score/current?gateway_id=pi-001" \
  | python3 -m json.tool
```

### Historical — `GET /api/v1/environment/score/history`

| Query | Required | Notes |
| --- | --- | --- |
| `gateway_id` | yes | Gateway id in the score marts |
| `period` | no | `24h`, `7d` (default), or `30d` |

Data source: Snowflake `FCT_ENVIRONMENTAL_SCORE_HOURLY` (`24h`/`7d`) or `FCT_ENVIRONMENTAL_SCORE_DAILY` (`30d`).

**Hourly point fields:** `timestamp`, `score` (nullable), `temperature_score`, `humidity_score`, `soil_score`, `status`.

**Daily point fields:** `timestamp`, `score` (avg of valid hours, nullable), `min_score`, `max_score`, `scored_hours`, `hours_with_data`.

Response also includes `resolution`, `score_version` (single version across points, else `null`), and `count`.

**422** — invalid period.  
**503** — Snowflake unavailable (`Historical environmental scores unavailable`).

```bash
curl -s "https://api.gregoryjoshua.com/api/v1/environment/score/history?gateway_id=pi-001&period=7d" \
  | python3 -m json.tool
```

---

## Related

- [Operations](operations.md)
- [Snowflake setup](snowflake-setup.md) — S3 load task, marts schema, API reader and dbt service users
- [Environmental Conditions Score](environmental-conditions-score.md)
- [Architecture](architecture.md)
