# Data contracts

The sensor and automation event schemas, where they are enforced, and how to change them without breaking ingestion or downstream consumers.

Related documents: [Architecture](architecture.md) · [Adding a sensor](adding-a-sensor.md) · [Deployment](deployment.md) · [Operations](operations.md)

## Schema versions

Two event streams have separate schemas, MQTT topics, SQLite tables, and Kafka topics.

### Sensor events

| Version | Schema | Example | Emitted by | Accepted by gateway |
| --- | --- | --- | --- | --- |
| 1 | [`sensor_event.v1.schema.json`](../schemas/sensor_event.v1.schema.json) | [`sensor_event.v1.example.json`](../schemas/sensor_event.v1.example.json) | Simulator | Yes |
| 2 | [`sensor_event.v2.schema.json`](../schemas/sensor_event.v2.schema.json) | [`sensor_event.v2.example.json`](../schemas/sensor_event.v2.example.json) | ESP32 firmware (`SCHEMA_VERSION = 2` in `main.py`) | Yes |

Both are JSON Schema draft 2020-12. The gateway selects the schema from the event's `schema_version`; any other value is rejected as unsupported. v2 is a superset of v1: it adds `atmospheric_pressure` and `hpa`, and pins `atmospheric_pressure` to `hpa`. Validation is otherwise identical.

### Automation events

| Version | Schema | Emitted by | Accepted by gateway |
| --- | --- | --- | --- |
| 1 | [`automation_event.v1.schema.json`](../schemas/automation_event.v1.schema.json) | Automation controller ([`gateway/automation.py`](../gateway/automation.py)) | Yes |

Details are in [Automation events](#automation-events).

## Sensor event fields

All eight fields are required in both versions. `additionalProperties` is `false`, so unknown fields are rejected.

| Field | Type | Constraint | Notes |
| --- | --- | --- | --- |
| `schema_version` | integer | `const`: 1 or 2 | Selects the validation schema |
| `event_id` | string | `format: uuid` | Deduplication key: SQLite primary key and Kafka message key. The firmware generates UUIDv4 |
| `sensor_id` | string | `minLength: 1` | Identifies the physical sensor, e.g. `bme280-001` |
| `gateway_id` | string | `minLength: 1` | Set by the ESP32 from `config.GATEWAY_ID`, e.g. `pi-001` |
| `timestamp` | string | `format: date-time` | UTC time of the sample. The firmware emits `YYYY-MM-DDTHH:MM:SSZ` |
| `measurement_type` | string | enum (below) | |
| `value` | number | `type: number` | Integers and floats are accepted. Booleans and strings are rejected |
| `unit` | string | enum (below) | |

### Measurement types and units

| `measurement_type` | v1 | v2 | Unit as emitted today | Source |
| --- | --- | --- | --- | --- |
| `air_temperature` | yes | yes | `celsius` | BME280 |
| `relative_humidity` | yes | yes | `percent` | BME280 |
| `atmospheric_pressure` | no | yes | `hpa` (enforced) | BME280 |
| `soil_moisture` | yes | yes | `raw_capacitance` (uncalibrated; calibrated percent is derived downstream) | STEMMA soil sensor |
| `soil_temperature` | yes | yes | not emitted by the current firmware | Schema only |

Permitted `unit` values: `raw_capacitance`, `celsius`, `percent` (v1 and v2), plus `hpa` (v2 only).

Events always carry the raw soil reading. The calibrated percentage (share of the last 10 readings at or above 990) is computed by the automation controller, the API, and dbt; it is not a new event field or unit. See [Environmental Conditions Score](environmental-conditions-score.md#soil-moisture-calibration).

The schema pairs units with measurement types in one case: in v2, `atmospheric_pressure` must use `hpa` (an `allOf`/`if`/`then` rule). For other types, pairing is the producer's responsibility, so the firmware sets the unit for each measurement type.

## Examples

Schema v1, from [`sensor_event.v1.example.json`](../schemas/sensor_event.v1.example.json):

```json
{
  "schema_version": 1,
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "sensor_id": "soil-001",
  "gateway_id": "pi-001",
  "timestamp": "2026-10-20T19:30:00Z",
  "measurement_type": "soil_moisture",
  "value": 475,
  "unit": "raw_capacitance"
}
```

Schema v2, from [`sensor_event.v2.example.json`](../schemas/sensor_event.v2.example.json):

```json
{
  "schema_version": 2,
  "event_id": "550e8400-e29b-41d4-a716-446655440003",
  "sensor_id": "bme280-001",
  "gateway_id": "pi-001",
  "timestamp": "2026-10-27T05:30:00Z",
  "measurement_type": "atmospheric_pressure",
  "value": 1013.2,
  "unit": "hpa"
}
```

## Automation events

One event per actuator action, published by the controller to `MQTT_AUTOMATION_TOPIC` (default `greenhouse/automation/events`) and carried through the same SQLite → Kafka → Redis/S3 path as sensor events, on the Kafka topic `KAFKA_AUTOMATION_TOPIC` (default `greenhouse.automation.events.v1`). `additionalProperties` is `false`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | integer, const `1` | yes | |
| `event_id` | string, non-empty | yes | UUIDv4 from the controller. Deduplication key and Kafka key |
| `timestamp_utc` | string, `date-time` | yes | Controller clock, timezone-aware ISO 8601 |
| `actuator` | enum `fan`, `pump` | yes | |
| `event_type` | enum | yes | `command_issued`, `command_acknowledged`, `command_failed`, `state_changed` |
| `command_id` | string | no | Shelly RPC request id; links a command to its acknowledgment or failure |
| `cycle_id` | string | no | Groups the events of one pump run (set for pump commands and state changes during a run) |
| `desired_state`, `observed_state` | boolean | no | Commanded relay state; relay state seen from Shelly status |
| `reason` | string | no | For example `temperature_high`, `temperature_normal`, `soil_moisture_low`, `shelly_status`, `rpc_timeout_outcome_unknown`, `unexpected_pump_on`, `pump_runtime_exceeded`, `pump_command_runtime_exceeded` |
| `temperature_c` | number | no | Air temperature when the event was emitted, if a fresh reading was available |
| `soil_moisture_pct` | number | no | Declared in the schema and read by dbt, but not emitted by the controller yet |

Meaning of the event types:

| `event_type` | Emitted when |
| --- | --- |
| `command_issued` | A `Switch.Set` RPC was sent |
| `command_acknowledged` | The device answered the RPC without an error |
| `command_failed` | The device returned an error, or the RPC timed out (`rpc_timeout_outcome_unknown`: the command may still have taken effect) |
| `state_changed` | The relay's observed state changed (not emitted for the first observation after a connect) |

In the warehouse, `FCT_ACTUATOR_CYCLES` pairs `state_changed` ON/OFF events: by `cycle_id` where present (pump), otherwise ON with the next OFF (fan). An ON without a matching OFF is not a completed cycle.

Example:

```json
{
  "schema_version": 1,
  "event_id": "7d0c2a5e-0f4b-4a51-9c64-3a8e0f3b6f10",
  "timestamp_utc": "2026-11-20T19:30:12.345678+00:00",
  "actuator": "pump",
  "event_type": "command_issued",
  "command_id": "e3f1c0d8a9b24c7aa1d2f0c4b5e6a7d8",
  "cycle_id": "b1c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
  "desired_state": true,
  "reason": "soil_moisture_low",
  "temperature_c": 22.4
}
```

## One measurement per event

Each event carries exactly one `(sensor_id, measurement_type, value, unit)`. A BME280 cycle therefore produces three events that share a `timestamp`; the soil sensor adds a fourth.

Why it works for this pipeline:

- A new measurement type is a new enum value, not a new field or a wider event shape.
- `event_id` deduplicates at measurement granularity, so partial retries are safe.
- The Redis key `greenhouse:latest:{gateway_id}:{sensor_id}:{measurement_type}` maps one-to-one to events, so the consumer needs no per-sensor logic.
- The producer, consumer, and API are agnostic to which sensors exist.

Volume is 48 messages per minute at a 5 s interval with the current sensors. Readings from one cycle share a timestamp but are separate events, so they can arrive independently and a failed sensor drops out without affecting the others.

## Where validation happens

| Stage | What is checked | Notes |
| --- | --- | --- |
| ESP32 (`main.py`) | Nothing against the schema | Builds events from constants and `float(value)`; publishes only when the clock is year 2025 or later |
| Simulator | Schema v1 with `FormatChecker` | Stops on any invalid event it generates |
| Automation controller | Event is built in code; telemetry it consumes is checked for freshness, numeric range, and duplicates | Does not validate its own events against the schema |
| Mosquitto | Authentication only | No payload validation |
| **Gateway ingest** | Full JSON Schema by topic and `schema_version` (sensor v1/v2, automation v1), **without** a format checker | The authoritative gate. `format` keywords (`uuid`, `date-time`) are annotations here, not checked |
| Kafka producer | Nothing | Forwards the stored JSON unchanged |
| Kafka | Nothing | No schema registry |
| Live consumer | Sensor events: presence of `event_id`, `sensor_id`, `gateway_id`, `measurement_type`, `timestamp`, `value`, `unit`; timestamp parses with `datetime.fromisoformat` and has a timezone; `value` is `int` or `float`. Automation events: the five required fields, `schema_version == 1`, known `actuator` and `event_type`, timezone-aware `timestamp_utc` | Checks timestamps more strictly than the gateway; ignores enums and extra fields on sensor events |
| Historical consumer | Required fields per topic, `schema_version` is an integer, `event_id` is a non-empty string; automation string fields are non-empty | Failures are quarantined to S3, not archived |
| API | `float(record["value"])`; soil-moisture history entries are parsed as JSON | Failure returns HTTP 503 |
| Dashboard | Unit-based formatting; unknown types get a generic label | No validation |

## How invalid events are handled

| Where | Condition | Behavior | Event kept? |
| --- | --- | --- | --- |
| Ingest | Malformed JSON, non-UTF-8, unsupported `schema_version`, or schema violation (either topic) | Logs `Invalid sensor event: <error>` or `Invalid automation event: <error>` and acknowledges the MQTT message so it is not redelivered | No. The error is logged; the payload is not stored |
| Live consumer | Missing field, unparsable or timezone-less timestamp, non-numeric value, unknown actuator or event type | Logs `Skipping malformed event topic=… partition=… offset=…` and commits the offset | Kept in Kafka until retention expires |
| Historical consumer | Same class of problems, on either topic | Flushes valid events already buffered for that partition, writes the raw message to `raw/quarantine/<topic>/partition=N/offset-<n>.json` (error, offset, base64 payload), then commits past it. If the quarantine upload fails, nothing is committed and the consumer retries | Yes, in the quarantine prefix and in Kafka until retention |

Storing rejected events is on the [roadmap](../README.md#roadmap).

## Compatibility rules

Terms used here:

- **Additive**: existing valid events stay valid under the changed schema, and components that have not been updated keep working on existing traffic.
- **Breaking**: some existing valid event becomes invalid, or the meaning of existing data changes.

Because the gateway schema is closed (`additionalProperties: false`, fixed enums), **any new field or enum value is rejected by a gateway that has not been updated**. "Additive" therefore does not mean "deploy in any order". The gateway must be updated before any producer emits the new shape.

| Change | Class | Needs a new `schema_version`? | Notes |
| --- | --- | --- | --- |
| New `measurement_type` or `unit` value | Additive | Recommended | Precedent: v2 added `atmospheric_pressure` and `hpa` as a new version, leaving v1 untouched |
| New optional field | Additive | Yes | Must be added to `properties` but not `required`. Downstream ignores it until consumer/API are updated |
| New required field | Breaking for producers | Yes | Events of the old version must still be accepted until every producer is upgraded |
| Remove or rename a field | Breaking | Yes | The live consumer reads seven sensor fields (five automation fields) by name; dbt staging reads event fields by name |
| Change a field's type or format | Breaking | Yes | |
| Narrow an enum or tighten a constraint | Breaking | Yes | |
| Change units or semantics of an existing type (for example calibrating `soil_moisture`) | Breaking (semantic) | Prefer a new `unit` value, or a new `measurement_type` | Redis holds one value per key; mixed meanings under one key are indistinguishable. `raw_capacitance` must stay raw. Calibration is therefore derived downstream (see [Environmental Conditions Score](environmental-conditions-score.md#soil-moisture-calibration)) |
| Change timestamp format | Breaking | Yes | Consumer and dashboard parse ISO 8601 |
| Change what `event_id` means | Breaking | Yes | Deduplication and Kafka key depend on it |
| Change `sensor_id`/`gateway_id`/`measurement_type` values for existing devices | Breaking (data) | n/a | Changes Redis keys; the old keys remain as stale cards |

Rules for a new version:

1. Add `schemas/sensor_event.vN.schema.json` and `schemas/sensor_event.vN.example.json`. Keep earlier versions unchanged while any producer or stored event uses them.
2. Register it in the `SENSOR_SCHEMAS` (or `AUTOMATION_SCHEMAS`) dict in [`gateway/ingest.py`](../gateway/ingest.py). Schemas are loaded at process start, so ingest must be restarted. A new automation version needs `schemas/automation_event.vN.schema.json` and the same consumer and dbt checks.
3. Bump `SCHEMA_VERSION` in the firmware's `main.py` only after the gateway accepts the new version.
4. Do not retire a version while old events may still be in an MQTT queue, the SQLite outbox, or Kafka (168 h by default). The producer and consumer do not look at `schema_version`, so retained events of old versions still flow.
5. Aggregating consumers and warehouse models (dbt staging already deduplicates on `event_id`; Flink, if added, must do the same) handle every version present in retained data.

## What to check after a contract change

| Component | Check | Needed when |
| --- | --- | --- |
| `schemas/` | Schema, example, `$schema` valid | Always |
| [`gateway/ingest.py`](../gateway/ingest.py) | Version registered in `SENSOR_SCHEMAS` / `AUTOMATION_SCHEMAS`; service restarted | New version |
| Firmware [`main.py`](../firmware/esp32/main.py), [`sensors.py`](../firmware/esp32/sensors.py) | `SCHEMA_VERSION`, event fields, measurement types, units | Producer-side change |
| Simulator | Pinned to v1 (`schema_version: 1`, `schemas/sensor_event.v1.schema.json`) | If the simulator should emit the new shape |
| SQLite outbox | Stores the event as a JSON string. No column change | Never for content changes. Only if outbox columns change |
| [`gateway/kafka_producer.py`](../gateway/kafka_producer.py) | Forwards JSON unchanged | Never for content changes |
| Kafka topic | No registry; key is `event_id` | Only if key or topic design changes |
| [`consumers/live/consumer.py`](../consumers/live/consumer.py), [`consumers/historical/consumer.py`](../consumers/historical/consumer.py) | Live reads seven sensor fields (automation: `parse_automation_event` accepts only `schema_version` 1); historical checks `REQUIRED_FIELDS` per topic | Only if the live view needs a new field, the Redis key structure changes, or an automation version is added |
| Redis | New keys appear automatically | Only if key structure or stored fields change. Old keys need manual cleanup |
| [`api/main.py`](../api/main.py) | Builds the live response from fixed hash fields; `value` must be numeric | Only if the live response shape changes |
| [`api/repositories/snowflake.py`](../api/repositories/snowflake.py) / dbt marts | History, score, and automation endpoints read fixed columns; `stg_automation_events` reads event fields by name | Only if mart grain or column names change, or an event field is added or renamed |
| [`dashboard/src/lib/metrics.js`](../dashboard/src/lib/metrics.js), [`format.js`](../dashboard/src/lib/format.js) | Label and order in `METRICS`; `formatValue` for the unit (used by Live and History) | Optional for new types (generic fallback exists); needed for a unit that requires special formatting |
| `tests/` | Extend `tests/schemas/` (and `tests/gateway/test_ingest.py` for gateway behavior) | Schema or code changes |
| `docs/` | This file, [Adding a sensor](adding-a-sensor.md), the root README | Always |

## Testing a schema change before deployment

CI runs the whole `tests/` tree on every push and pull request ([Deployment](deployment.md#running-the-tests-locally)). There is no separate staging environment.

**1. Validate schemas and examples locally** (same validation settings as the gateway; run from the repository root with the gateway dependencies installed):

```bash
.venv/bin/python - <<'EOF'
import json
from pathlib import Path
from jsonschema import Draft202012Validator

for v in (1, 2):  # add your new version
    schema = json.loads(Path(f"schemas/sensor_event.v{v}.schema.json").read_text())
    example = json.loads(Path(f"schemas/sensor_event.v{v}.example.json").read_text())
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(example)
    print(f"v{v}: schema valid, example accepted")
EOF
```

**2. Extend the schema tests.** [`tests/schemas/test_sensor_events.py`](../tests/schemas/test_sensor_events.py) loads each version into a `SCHEMAS` dict (sensor events only) and validates with `FormatChecker`. Add the new version there, with cases that an old-version event still passes its own version, a new-only value is rejected by the old version, and an extra field is rejected. Existing cases cover v1 and v2 acceptance, v1 rejecting `atmospheric_pressure`, a missing `event_id`, an extra field, and a wrong unit.

**3. Run the tests:**

```bash
TEST_REDIS_URL=redis://localhost:6379/15 .venv/bin/python -m pytest tests/ -v
# without Redis: schema and gateway tests only
.venv/bin/python -m pytest tests/schemas tests/gateway -v
```

**4. Replicate firmware output.** Run a representative event from `create_event()` in `main.py` through the validator. The firmware is MicroPython, so test the dictionary shape on the host or review it by hand.

**5. After deploying the gateway**, publish one clearly labelled test event on the Pi and confirm it reaches SQLite. This event also flows to Kafka, Redis, and the dashboard, so use a dedicated `sensor_id` and delete its Redis key afterwards. Commands are in [Adding a sensor](adding-a-sensor.md#test-the-gateway-with-a-synthetic-event).

For rollout order across components, see [Deployment](deployment.md#coordinated-changes-and-schema-migrations).
