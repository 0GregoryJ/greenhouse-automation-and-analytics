# Greenhouse Monitoring API

Read-only FastAPI service on the serving host. Live data comes from Redis; historical series and environmental scores come from Snowflake dbt marts. Public HTTPS is terminated by Caddy.

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

Returns the latest Redis hash for every `greenhouse:latest:*` key.

**200**

```json
{
  "count": 1,
  "readings": [
    {
      "gateway_id": "pi-001",
      "sensor_id": "bme280-001",
      "measurement_type": "air_temperature",
      "value": 22.4,
      "unit": "celsius",
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

## Historical sensor series

### `GET /api/v1/history/series`

| Query | Required | Notes |
| --- | --- | --- |
| `sensor_id` | yes | Sensor identifier |
| `measurement_type` | yes | e.g. `air_temperature` |
| `period` | no | `24h`, `7d` (default), or `30d` |

Resolution: hourly mart for `24h`/`7d`, daily mart for `30d`.

**200** — `points[]` with `timestamp`, `avg`, `min`, `max`, `count`, `unit`. Empty `points` with `count: 0` is success with no rows.

**422** — invalid `period` or missing params.  
**503** — Snowflake unavailable / query failure.

```bash
curl -s "https://api.gregoryjoshua.com/api/v1/history/series?sensor_id=bme280-001&measurement_type=air_temperature&period=7d" \
  | python3 -m json.tool
```

---

## Environmental Conditions Score

Methodology: [Environmental Conditions Score](environmental-conditions-score.md). Versioned rules live in [`config/environmental_score.v1.json`](../config/environmental_score.v1.json).

### Live — `GET /api/v1/environment/score/current`

| Query | Required | Notes |
| --- | --- | --- |
| `gateway_id` | yes | Gateway whose latest Redis readings are scored |

Data source: Redis latest hashes for that gateway. Scoring runs in-process (Python), not in Snowflake.

**Complete score (200)**

```json
{
  "gateway_id": "pi-001",
  "score": 91.25,
  "score_version": "conditions-v1",
  "status": "complete",
  "invalid_measurements": [],
  "components": {
    "air_temperature": 100,
    "relative_humidity": 85,
    "soil_moisture": 90
  },
  "readings": {
    "air_temperature": 23.1,
    "relative_humidity": 58.0,
    "soil_moisture": 610.0
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
