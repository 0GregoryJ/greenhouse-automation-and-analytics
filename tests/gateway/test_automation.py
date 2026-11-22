"""Tests for gateway/automation.py (place this file in tests/gateway/)."""
import importlib.util
import json
import os
import sqlite3
import sys
import time
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


class FakePublish:
    def __init__(self, mid):
        self.mid = mid
        self.rc = 0


class FakeClient:
    def __init__(self):
        self.sent = []
        self._mid = 0

    def publish(self, topic, payload, **kwargs):
        self._mid += 1
        self.sent.append((topic, json.loads(payload), kwargs, self._mid))
        return FakePublish(self._mid)


class Accepted:
    is_failure = False


@pytest.fixture
def module(monkeypatch):
    monkeypatch.setenv("SHELLY_FAN_ID", "fan-test")
    monkeypatch.setenv("SHELLY_PUMP_ID", "pump-test")
    monkeypatch.setenv("PUMP_AUTO_ENABLED", "true")
    monkeypatch.setenv("PUMP_COOLDOWN_SECONDS", "43200")
    monkeypatch.setenv("PUMP_MAX_CYCLES_24H", "1")
    monkeypatch.setenv("PUMP_MOISTURE_THRESHOLD", "600")
    monkeypatch.setenv("PUMP_MIN_VALID_RAW", "450")
    monkeypatch.setenv("PUMP_MAX_VALID_RAW", "1200")
    monkeypatch.setenv("PUMP_REQUIRED_LOW_READINGS", "3")
    monkeypatch.setenv("MOISTURE_SENSOR_ID", "")
    monkeypatch.setenv("MAX_READING_AGE_SECONDS", "90")
    module_path = Path(os.getenv("AUTOMATION_MODULE_PATH", ""))
    if not module_path.is_file():
        module_path = Path(__file__).resolve().parents[2] / "gateway" / "automation.py"

    # Normal CI installs paho-mqtt. Provide a tiny import stub when running
    # these tests in an isolated environment without MQTT dependencies.
    try:
        import paho.mqtt.client  # noqa: F401
    except ImportError:
        paho = types.ModuleType("paho")
        paho_mqtt = types.ModuleType("paho.mqtt")
        paho_client = types.ModuleType("paho.mqtt.client")
        paho_client.MQTT_ERR_SUCCESS = 0
        paho.mqtt = paho_mqtt
        paho_mqtt.client = paho_client
        monkeypatch.setitem(sys.modules, "paho", paho)
        monkeypatch.setitem(sys.modules, "paho.mqtt", paho_mqtt)
        monkeypatch.setitem(sys.modules, "paho.mqtt.client", paho_client)

    spec = importlib.util.spec_from_file_location(
        f"automation_test_{uuid.uuid4().hex}", module_path
    )
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


@pytest.fixture
def ctl(tmp_path, module):
    controller = module.AutomationController(tmp_path / "controller.db")
    controller.client = FakeClient()
    controller.connected = True
    controller.subscribed = True
    controller.observed = {"fan": False, "pump": False}
    return controller


def reading(module, measurement_type, value, event_id=None, timestamp=None):
    return {
        "event_id": event_id or str(uuid.uuid4()),
        "sensor_id": "soil-001",
        "measurement_type": measurement_type,
        "value": value,
        "timestamp_utc": timestamp or module.utc_now(),
    }


def pump_on_commands(ctl):
    return [
        (topic, payload, options)
        for topic, payload, options, _ in ctl.client.sent
        if topic == "pump-test/rpc"
        and payload["method"] == "Switch.Set"
        and payload["params"]["on"] is True
    ]


def test_pump_requires_three_separate_fresh_low_readings(module, ctl):
    for i in range(2):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 580))
    assert not pump_on_commands(ctl)
    ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 580))
    ons = pump_on_commands(ctl)
    assert len(ons) == 1
    assert ons[0][1]["params"]["toggle_after"] == module.PUMP_RUN_SECONDS
    assert ons[0][2]["qos"] == 0  # Do not replay ON after a reconnect.


def test_bad_or_stale_moisture_cannot_activate_pump(module, ctl):
    for _ in range(5):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 300))
    assert not pump_on_commands(ctl)
    assert ctl.low_moisture_count == 0
    old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    for _ in range(5):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 575, timestamp=old))
    assert not pump_on_commands(ctl)


def test_duplicate_event_id_is_not_three_independent_low_readings(module, ctl):
    event = reading(module, module.MOISTURE_TYPE, 575, "duplicate-123")
    for _ in range(3):
        ctl.handle_telemetry(event)
    assert ctl.low_moisture_count == 1
    assert not pump_on_commands(ctl)


def test_pump_attempt_budget_survives_restart(module, ctl):
    for _ in range(3):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 575))
    assert len(pump_on_commands(ctl)) == 1
    restarted = module.AutomationController(ctl.db_path)
    assert not restarted.pump_budget_available()


def test_event_outbox_is_durable_and_ack_deletes_only_broker_confirmed(module, ctl):
    event_id = ctl.emit("fan", "command_issued", command_id="rpc-123",
                        desired_state=True, reason="temperature_high")
    with sqlite3.connect(ctl.db_path) as con:
        assert con.execute("SELECT COUNT(*) FROM event_outbox").fetchone()[0] == 1
    restarted = module.AutomationController(ctl.db_path)
    restarted.client = ctl.client
    restarted.connected = True
    restarted.flush_events()
    published = [s for s in ctl.client.sent if s[0] == module.EVENT_TOPIC]
    assert len(published) == 1
    assert published[0][1]["event_id"] == event_id
    assert published[0][2]["qos"] == 1
    with sqlite3.connect(ctl.db_path) as con:
        assert con.execute("SELECT COUNT(*) FROM event_outbox").fetchone()[0] == 1
    restarted.on_publish(ctl.client, None, published[0][3], Accepted(), None)
    with sqlite3.connect(ctl.db_path) as con:
        assert con.execute("SELECT COUNT(*) FROM event_outbox").fetchone()[0] == 0


def test_unexpected_pump_on_generates_emergency_off(module, ctl):
    ctl.handle_shelly_state("pump", True)
    offs = [p for t, p, _o, _m in ctl.client.sent
            if t == "pump-test/rpc"
            and p["method"] == "Switch.Set"
            and p["params"]["on"] is False]
    assert offs


def test_fan_turns_on_when_fresh_temperature_exceeds_threshold(module, ctl):
    ctl.handle_telemetry(reading(module, module.TEMP_TYPE, 25))
    ons = [p for t, p, _o, _m in ctl.client.sent
           if t == "fan-test/rpc" and p["method"] == "Switch.Set"]
    assert len(ons) == 1
    assert ons[0]["params"]["on"] is True


def test_pump_stays_off_when_automation_is_disabled(module, ctl, monkeypatch):
    monkeypatch.setattr(module, "PUMP_AUTO_ENABLED", False)
    for _ in range(5):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 575))
    assert not pump_on_commands(ctl)


def test_unconfirmed_pump_on_is_followed_by_safety_off(module, ctl):
    for _ in range(3):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 575))
    assert len(pump_on_commands(ctl)) == 1
    # Previous reported relay state may still be OFF, but ON could have executed.
    assert ctl.observed["pump"] is False
    ctl.pump_command_at = time.monotonic() - module.PUMP_RUN_SECONDS - module.PUMP_GRACE_SECONDS - 2
    ctl.tick()
    assert any(
        t == "pump-test/rpc"
        and p["method"] == "Switch.Set"
        and p["params"]["on"] is False
        for t, p, _o, _m in ctl.client.sent
    )


def test_command_timeout_does_not_retry_uncertain_pump_on(module, ctl):
    for _ in range(3):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 575))
    assert len(pump_on_commands(ctl)) == 1
    req_id = ctl.pending["pump"]["id"]
    ctl.rpc_requests[req_id]["sent_at"] = time.monotonic() - module.RPC_TIMEOUT - 1
    ctl.tick()
    assert ctl.pending["pump"] is None or ctl.pending["pump"]["desired"] is False
    for _ in range(3):
        ctl.handle_telemetry(reading(module, module.MOISTURE_TYPE, 565))
    assert len(pump_on_commands(ctl)) == 1
    assert not ctl.pump_budget_available()