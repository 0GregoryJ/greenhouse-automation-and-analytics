# ADR 0015: Automation events as a second stream, with quarantine in the archive

**Status:** Accepted
**Recorded:** 2026-11-23

## Context

Actuator activity (commands, acknowledgments, failures, relay state changes) needs the same guarantees as sensor data: durable buffering on the Pi, Kafka replay, a live view for the dashboard, and a permanent archive for analytics such as "did irrigation raise soil moisture". Its shape differs from a sensor reading (no `sensor_id`, `value`, or `unit`), so reusing the sensor schema would weaken it. Adding a second stream also makes the earlier "a malformed message stops the historical consumer" behavior ([ADR 0012](0012-historical-archive-to-s3.md)) more costly, because one bad message on either topic would stall both.

## Decision

- **Separate contract and topics.** Automation events have their own closed JSON Schema ([`automation_event.v1.schema.json`](../../schemas/automation_event.v1.schema.json)), MQTT topic (`MQTT_AUTOMATION_TOPIC`), SQLite table (`automation_events`, in the same database), and Kafka topic (`KAFKA_AUTOMATION_TOPIC`, default `greenhouse.automation.events.v1`).
- **Shared machinery.** Ingest routes by topic and validates against the matching schema set (`SENSOR_SCHEMAS`, `AUTOMATION_SCHEMAS`). The producer loops over an allow-listed map of outbox tables and publishes one batch per stream per pass so a sensor backlog cannot starve actuator events. Delivery remains at-least-once with `event_id` deduplication.
- **Live view.** The live consumer subscribes to both topics. It stores the latest readings and the last 10 raw readings per sensor (needed to calibrate soil moisture), and keeps the 10 most recent automation events in a capped Redis list with duplicate suppression by `event_id`.
- **Archive.** The historical consumer subscribes to both topics in one group and writes separate S3 prefixes (`raw/sensor_events/`, `raw/automation_events/`). Batches are per topic and partition, with the same upload-then-commit rule.
- **Quarantine.** A message that fails validation is written to `raw/quarantine/<topic>/partition=N/offset-<n>.json` (error, offset, base64 payload), then its offset is committed. If the quarantine upload fails, nothing is committed and the message is retried. This replaces the stop-on-bad-message behavior of ADR 0012.
- **Warehouse.** A second raw table (`RAW.AUTOMATION_EVENTS`) feeds `stg_automation_events`, `fct_automation_events`, and `fct_actuator_cycles`, which pairs ON and OFF state changes into cycles.

## Consequences

- The dashboard can show recent cycles within seconds (Redis) and analyse them against sensor series (Snowflake) using the same pipeline operators already know.
- A malformed message no longer halts archiving; it is visible under `raw/quarantine/` and in the consumer log. The instance profile also needs `s3:PutObject` on the new prefixes, and quarantined messages are not loaded into Snowflake.
- Two topics double the operational surface: another topic to create, a second Snowflake load task, and per-topic lag.
- `compose.yaml` forwards `KAFKA_AUTOMATION_TOPIC` to the live consumer only; the historical consumer's automation topic and S3 prefixes run on their defaults unless Compose is changed.
- The `automation_events` outbox table is not covered by `cleanup.py` or `health.py` yet.
- A new schema version needs the same registration, consumer, and dbt changes as a sensor version ([Data contracts](../data-contracts.md#compatibility-rules)).

## Related

[Data contracts: automation events](../data-contracts.md#automation-events), [Architecture](../architecture.md#event-flow), [`gateway/kafka_producer.py`](../../gateway/kafka_producer.py), [`consumers/historical/consumer.py`](../../consumers/historical/consumer.py), [ADR 0003](0003-at-least-once-delivery-with-event-id-deduplication.md), [ADR 0012](0012-historical-archive-to-s3.md), [ADR 0014](0014-local-automation-controller-with-persistent-safety-ledger.md)
