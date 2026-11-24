# ADR 0014: Local automation controller with a persistent safety ledger

**Status:** Accepted
**Recorded:** 2026-11-23

## Context

The greenhouse has a fan and an irrigation pump on Shelly Gen2 smart plugs. Actuation must keep working when the WAN, Kafka, or the cloud is down, and a mistake costs more than a stale chart: a pump that stays on floods the bed. MQTT QoS 1 can redeliver a message after a reconnect, which is harmless for telemetry and dangerous for a "pump ON" command. A command timeout does not prove the command failed.

## Decision

[`gateway/automation.py`](../../gateway/automation.py) runs on the Pi as `greenhouse-automation.service`. It subscribes to the same telemetry topic as ingest and commands the plugs over the Shelly MQTT RPC interface on the local broker. It does not depend on Kafka, Redis, or the internet.

- **Rules.** The fan uses hysteresis (on at 24 °C, off at 21 °C). The pump runs for 6 s when the calibrated soil-moisture percentage is below 40 % for 3 consecutive fresh readings, from a rolling window of the last 10 raw readings of sensor `soil-001`.
- **Persistent ledger.** The attempt is written to SQLite (`gateway/data/automation_state.db`) **before** the ON command is sent, so an uncertain send still consumes the 112-minute cooldown and the 8-runs-per-24-h budget, and both survive restarts. Future-dated ledger rows block watering.
- **Safe command semantics.** `Switch.Set` is published at QoS 0 so Paho cannot replay a pump start after a reconnect; status queries use QoS 1. Command outcomes are confirmed by observing relay status, not by the RPC reply. An RPC timeout is recorded as `command_failed` / `rpc_timeout_outcome_unknown` and the pump ON is never retried.
- **Fail-safe watchdog.** A pump that is on without an active cycle, or beyond its 6 s run plus a grace period, receives an emergency OFF, retried every 5 s.
- **Input checks.** Telemetry must be fresh (90 s), carry a timezone-aware timestamp for moisture, be finite and plausible, and not repeat an `event_id`. A bad or stale reading resets the window and inhibits watering.
- **Events.** Every command, acknowledgment, failure, and observed state change becomes an automation event ([schema v1](../data-contracts.md#automation-events)), stored in an `event_outbox` table and published at QoS 1 until the broker's PUBACK, then handled by ingest like any event ([ADR 0015](0015-automation-events-as-a-second-stream.md)).
- The plugs must be set to power-restore OFF with a device-side auto-off; software on the Pi cannot protect against an offline plug.

## Consequences

- Irrigation and cooling continue during WAN, Kafka, and cloud outages.
- After a controller restart, no pump run can start until a fresh 10-reading window and 3 low readings arrive, which is deliberate.
- Thresholds are constants in the source, so changing them is a code change, a deploy, and a restart.
- The controller accepts `air_temperature` from any sensor, so a simulator or a second temperature sensor on the same topic influences the fan. Only `soil-001` is accepted for moisture.
- The soil-moisture transform exists in the controller, the API, and dbt; the three must change together ([score documentation](../environmental-conditions-score.md#soil-moisture-calibration)).
- CI restarts the service on deploy but does not assert it is active, and `install-pi-services.sh` does not install the unit yet.
- The controller is tested with fakes for MQTT ([`tests/gateway/test_automation.py`](../../tests/gateway/test_automation.py)); there is no hardware-in-the-loop test.

## Related

[Architecture: automation loop](../architecture.md#automation-loop), [Deployment: automation controller](../deployment.md#automation-controller), [Operations: automation controller](../operations.md#automation-controller), [ADR 0002](0002-sqlite-outbox-on-the-gateway.md), [ADR 0003](0003-at-least-once-delivery-with-event-id-deduplication.md)
