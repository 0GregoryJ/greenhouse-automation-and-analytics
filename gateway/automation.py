"""
Local MQTT controller for the Shelly fan and pump.

Fan turns on at 24°C and off at 21°C.
Pump runs for 6 seconds after three consecutive dry readings, at least
6720 seconds since the last attempt, and fewer than 8 attempts in 24 hours.
A dry reading is a 10-sample window with calibrated moisture below 40%.
If soil telemetry stops, each missing sample counts as dry, so unplugging
the probe can start a run.

Relay changes come from Shelly NotifyStatus only. The controller does not
poll switch status, so a stale poll cannot close a pump cycle early.
The plug's own auto-off is the hardware backstop.
"""

import json
import logging
import math
import os
import sqlite3
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import paho.mqtt.client as mqtt
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT") or "1883")
TELEMETRY_TOPIC = os.getenv("MQTT_SENSOR_TOPIC") or "greenhouse/telemetry"
EVENT_TOPIC = os.getenv("MQTT_AUTOMATION_TOPIC") or "greenhouse/automation/events"

SHELLY = {
    "fan": os.environ["SHELLY_FAN_ID"],
    "pump": os.environ["SHELLY_PUMP_ID"],
}

RPC_SOURCE = "greenhouse/controller"
RPC_RESPONSE_TOPIC = f"{RPC_SOURCE}/rpc"
TEMP_TYPE = "air_temperature"
MOISTURE_TYPE = "soil_moisture"

FAN_ON_TEMP = 24
FAN_OFF_TEMP = 21
FAN_COMMAND_GAP = 30

PUMP_AUTO_ENABLED = True
PUMP_MOISTURE_THRESHOLD = 40
MOISTURE_WINDOW_SIZE = 10
PUMP_RUN_SECONDS = 6
PUMP_COOLDOWN = 6720
PUMP_MAX_CYCLES = 8
PUMP_REQUIRED_LOW_READINGS = 3
MOISTURE_SENSOR_ID = "soil-001"
# The probe publishes about every 5 seconds. After this long with no soil
# reading, later gaps are counted as dry samples at the same pace.
SOIL_GAP_SECONDS = 15
SOIL_SAMPLE_SECONDS = 5

MAX_READING_AGE = 90
EVENT_RETRY_SECONDS = 8.0
EVENT_ACK_TIMEOUT_SECONDS = 30.0
MAX_EVENT_INFLIGHT = 20

STATE_DB_PATH = ROOT / "gateway" / "data" / "automation_state.db"

if FAN_OFF_TEMP >= FAN_ON_TEMP:
    raise ValueError("FAN_OFF_TEMP must be lower than FAN_ON_TEMP")
if not 0 < PUMP_RUN_SECONDS <= 10:
    raise ValueError("PUMP_RUN_SECONDS must be > 0 and <= 10")
if not 0 < PUMP_MOISTURE_THRESHOLD < 100:
    raise ValueError("Moisture threshold must lie strictly between 0 and 100")
if PUMP_COOLDOWN < 0 or PUMP_MAX_CYCLES < 1 or PUMP_REQUIRED_LOW_READINGS < 1:
    raise ValueError("Invalid pump cooldown, cycle limit, or reading count")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def parse_timestamp(event):
    """Return a timezone-aware timestamp, or None when the event has none."""
    raw = None
    for field in ("timestamp_utc", "timestamp", "observed_at", "measured_at"):
        if event.get(field) is not None:
            raw = event[field]
            break
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        return None
    return value.astimezone(timezone.utc)


def transform_moisture_readings(readings):
    """Calibrated moisture: percent of the window whose raw value is at least 990."""
    qty_above_990 = sum(1 for reading in readings if reading >= 990)
    calibrated_pct = int(100 * (np.round((qty_above_990 / len(readings)), 2)))
    state = "wet-like" if calibrated_pct >= 40 else "dry-like"
    return (calibrated_pct, state)


class AutomationController:
    def __init__(self, db_path=STATE_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self.lock = threading.RLock()
        self.client = None
        self.connected = False
        self.subscribed = False
        self.fan_on = None
        self.fan_command_at = 0.0
        self.fan_status_request = None
        self.last_output = {"fan": None, "pump": None}
        self.temperature_c = None
        self.moisture_history = deque(maxlen=MOISTURE_WINDOW_SIZE)
        self.dry_streak = 0
        self.last_soil_at = None
        self.last_gap_sample_at = 0.0
        self.current_pump_cycle = None
        self.seen_sensor_ids = deque(maxlen=256)
        self.event_inflight = {}
        self.event_attempts = {}

    def _db(self):
        conn = sqlite3.connect(self.db_path, timeout=20)
        conn.execute("PRAGMA busy_timeout=20000")
        return conn

    def _init_db(self):
        with self._db() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("""CREATE TABLE IF NOT EXISTS pump_attempts (
                cycle_id TEXT PRIMARY KEY,
                attempted_at REAL NOT NULL,
                run_seconds REAL NOT NULL
            )""")
            conn.execute("""CREATE TABLE IF NOT EXISTS event_outbox (
                event_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            )""")
            conn.execute("""CREATE INDEX IF NOT EXISTS idx_pump_attempt_time
                            ON pump_attempts(attempted_at)""")

    def record_pump_attempt(self, cycle_id):
        now = time.time()
        with self._db() as conn:
            conn.execute(
                "INSERT INTO pump_attempts (cycle_id, attempted_at, run_seconds) "
                "VALUES (?, ?, ?)",
                (cycle_id, now, PUMP_RUN_SECONDS),
            )

    def pump_block_reason(self):
        """None when a new attempt is allowed."""
        now = time.time()
        with self._db() as conn:
            count, most_recent = conn.execute(
                "SELECT COUNT(*), MAX(attempted_at) FROM pump_attempts "
                "WHERE attempted_at > ?",
                (now - 86400,),
            ).fetchone()
        if count >= PUMP_MAX_CYCLES:
            return f"{int(count)} cycles in the last 24h"
        if most_recent is not None and now - most_recent < PUMP_COOLDOWN:
            remaining = int(PUMP_COOLDOWN - (now - most_recent))
            return f"cooldown {remaining}s left"
        return None

    def pump_budget_available(self):
        return self.pump_block_reason() is None

    def emit(self, actuator, event_type, **details):
        """Store first; retry publishing until the broker acknowledges."""
        event = {
            "schema_version": 1,
            "event_id": str(uuid.uuid4()),
            "timestamp_utc": utc_now(),
            "actuator": actuator,
            "event_type": event_type,
            **details,
        }
        if self.temperature_c is not None:
            event["temperature_c"] = self.temperature_c
        with self._db() as conn:
            conn.execute(
                "INSERT INTO event_outbox (event_id, payload, created_at) "
                "VALUES (?, ?, ?)",
                (event["event_id"], json.dumps(event), event["timestamp_utc"]),
            )
        logging.info("%s %s %s", actuator, event_type, details)
        return event["event_id"]

    def flush_events(self):
        if not self.connected:
            return
        now = time.monotonic()
        for mid, (event_id, sent_at) in list(self.event_inflight.items()):
            if now - sent_at > EVENT_ACK_TIMEOUT_SECONDS:
                logging.warning("Event PUBACK timed out; will retry %s", event_id)
                self.event_inflight.pop(mid, None)
        available = MAX_EVENT_INFLIGHT - len(self.event_inflight)
        if available <= 0:
            return
        with self._db() as conn:
            rows = conn.execute(
                "SELECT event_id, payload FROM event_outbox "
                "ORDER BY created_at LIMIT 100"
            ).fetchall()
        for event_id, payload in rows:
            if available <= 0:
                break
            if any(inflight_id == event_id for inflight_id, _ in self.event_inflight.values()):
                continue
            if time.monotonic() - self.event_attempts.get(event_id, -1e9) < EVENT_RETRY_SECONDS:
                continue
            info = self.client.publish(EVENT_TOPIC, payload, qos=1, retain=False)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                logging.warning("MQTT event publication could not be queued: %s", info.rc)
                break
            self.event_inflight[info.mid] = (event_id, time.monotonic())
            self.event_attempts[event_id] = time.monotonic()
            available -= 1

    def on_publish(self, client, userdata, mid, reason_code, properties):
        with self.lock:
            inflight = self.event_inflight.pop(mid, None)
            if inflight is None:
                return
            event_id, _ = inflight
            if reason_code.is_failure:
                logging.warning("Broker rejected event %s", event_id)
                self.event_attempts.pop(event_id, None)
                return
            with self._db() as conn:
                conn.execute("DELETE FROM event_outbox WHERE event_id=?", (event_id,))
            self.event_attempts.pop(event_id, None)

    def set_switch(self, actuator, turn_on, reason, cycle_id=None, duration=None):
        if not self.connected or not self.subscribed:
            return False
        request_id = uuid.uuid4().hex
        params = {"id": 0, "on": turn_on, "tag": "automation"}
        if duration is not None:
            params["toggle_after"] = duration
        payload = {
            "id": request_id,
            "src": RPC_SOURCE,
            "method": "Switch.Set",
            "params": params,
        }
        # QoS 0: a reconnect must not replay a pump ON.
        info = self.client.publish(
            f"{SHELLY[actuator]}/rpc", json.dumps(payload), qos=0, retain=False
        )
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            logging.error("Could not queue %s command", actuator)
            return False
        details = {
            "command_id": request_id,
            "desired_state": turn_on,
            "reason": reason,
        }
        if cycle_id:
            details["cycle_id"] = cycle_id
        self.emit(actuator, "command_issued", **details)
        return True

    def request_fan_status(self):
        """Learn the fan relay once at startup. Pump state comes from notifications."""
        if not self.connected or not self.subscribed:
            return
        request_id = uuid.uuid4().hex
        payload = {
            "id": request_id,
            "src": RPC_SOURCE,
            "method": "Switch.GetStatus",
            "params": {"id": 0},
        }
        info = self.client.publish(
            f"{SHELLY['fan']}/rpc", json.dumps(payload), qos=1, retain=False
        )
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            logging.error("Could not queue fan status")
            return
        self.fan_status_request = request_id

    def handle_rpc_response(self, data):
        if data.get("id") != self.fan_status_request:
            return
        if data.get("src") != SHELLY["fan"]:
            return
        self.fan_status_request = None
        result = data.get("result")
        if not isinstance(result, dict) or type(result.get("output")) is not bool:
            logging.warning("Invalid fan status response: %s", data)
            return
        if self.last_output["fan"] is not None:
            return
        state = result["output"]
        self.fan_on = state
        self.last_output["fan"] = state
        logging.info("fan initial state: %s", "on" if state else "off")

    def evaluate_fan(self, temperature):
        if not self.connected or not self.subscribed:
            logging.info("fan skip: mqtt down")
            return
        if self.fan_on is None:
            logging.info("fan skip: relay state unknown (%.1fC)", temperature)
            return
        now = time.monotonic()
        if (not self.fan_on and temperature >= FAN_ON_TEMP) or (
            self.fan_on and temperature <= FAN_OFF_TEMP
        ):
            if now - self.fan_command_at < FAN_COMMAND_GAP:
                return
            turn_on = temperature >= FAN_ON_TEMP
            reason = "temperature_high" if turn_on else "temperature_normal"
            self.fan_command_at = now
            if self.set_switch("fan", turn_on, reason):
                logging.info("fan %s: %.1fC", "on" if turn_on else "off", temperature)

    def _timestamp_is_stale(self, event):
        timestamp = parse_timestamp(event)
        if timestamp is None:
            return False
        age = (datetime.now(timezone.utc) - timestamp).total_seconds()
        return age > MAX_READING_AGE

    def _decide_pump(self, raw_value):
        """Log exactly one reason, then start the pump when every rule passes."""
        if not PUMP_AUTO_ENABLED:
            logging.info("pump skip: automation disabled")
            return
        if not self.connected or not self.subscribed:
            logging.info("pump skip: mqtt down")
            return
        size = len(self.moisture_history)
        if size < MOISTURE_WINDOW_SIZE:
            logging.info("pump skip: window %d/%d", size, MOISTURE_WINDOW_SIZE)
            return
        calibrated, state = transform_moisture_readings(list(self.moisture_history))
        if calibrated >= PUMP_MOISTURE_THRESHOLD:
            self.dry_streak = 0
            logging.info(
                "pump skip: moisture %.0f%% (%s), raw %.0f",
                calibrated,
                state,
                raw_value,
            )
            return
        self.dry_streak += 1
        if self.dry_streak < PUMP_REQUIRED_LOW_READINGS:
            logging.info(
                "pump skip: dry streak %d/%d (moisture %.0f%%, raw %.0f)",
                self.dry_streak,
                PUMP_REQUIRED_LOW_READINGS,
                calibrated,
                raw_value,
            )
            return
        blocked = self.pump_block_reason()
        if blocked:
            logging.info("pump skip: %s (moisture %.0f%%)", blocked, calibrated)
            return
        cycle_id = uuid.uuid4().hex
        self.record_pump_attempt(cycle_id)
        self.current_pump_cycle = cycle_id
        self.dry_streak = 0
        if self.set_switch(
            "pump",
            True,
            "soil_moisture_low",
            cycle_id=cycle_id,
            duration=PUMP_RUN_SECONDS,
        ):
            logging.info("pump start: %ss cycle %s", PUMP_RUN_SECONDS, cycle_id)
        else:
            logging.error(
                "pump start failed to queue; attempt %s still counted", cycle_id
            )

    def note_missing_soil(self):
        """Count a stopped soil sensor as a stream of dry samples."""
        if not PUMP_AUTO_ENABLED or not self.connected or not self.subscribed:
            return
        if self.last_soil_at is None:
            return
        now = time.monotonic()
        if now - self.last_soil_at < SOIL_GAP_SECONDS:
            return
        if now - self.last_gap_sample_at < SOIL_SAMPLE_SECONDS:
            return
        self.last_gap_sample_at = now
        self.moisture_history.append(0.0)
        logging.info(
            "pump: no soil reading for %.0fs; counting it as a dry sample",
            now - self.last_soil_at,
        )
        self._decide_pump(0.0)

    def handle_telemetry(self, event, retained=False):
        if retained:
            return
        kind = event.get("measurement_type")
        if kind not in (TEMP_TYPE, MOISTURE_TYPE):
            return
        event_id = event.get("event_id")
        if event_id is not None and event_id in self.seen_sensor_ids:
            return
        try:
            value = float(event["value"])
        except (KeyError, TypeError, ValueError):
            return
        if not math.isfinite(value):
            return
        if self._timestamp_is_stale(event):
            label = "pump" if kind == MOISTURE_TYPE else "fan"
            logging.info("%s skip: stale timestamp", label)
            return
        if event_id is not None:
            self.seen_sensor_ids.append(event_id)
        if kind == TEMP_TYPE:
            if not -20 <= value <= 70:
                logging.info("fan skip: temperature %.1f out of range", value)
                return
            self.temperature_c = value
            self.evaluate_fan(value)
            return
        if MOISTURE_SENSOR_ID and event.get("sensor_id") != MOISTURE_SENSOR_ID:
            logging.info("pump skip: sensor %s", event.get("sensor_id"))
            return
        self.moisture_history.append(value)
        self.last_soil_at = time.monotonic()
        self._decide_pump(value)

    def handle_notify(self, actuator, state):
        """Record a relay change reported by the plug itself."""
        if actuator not in self.last_output or type(state) is not bool:
            return
        previous = self.last_output[actuator]
        self.last_output[actuator] = state
        if actuator == "fan":
            self.fan_on = state
        if previous == state or (previous is None and state is False):
            return
        details = {"observed_state": state, "reason": "shelly_status"}
        if actuator == "pump" and self.current_pump_cycle:
            details["cycle_id"] = self.current_pump_cycle
            if state is False:
                self.current_pump_cycle = None
        self.emit(actuator, "state_changed", **details)

    def on_connect(self, client, userdata, flags, reason_code, properties):
        with self.lock:
            if reason_code.is_failure:
                logging.error("Mosquitto refused connection: %s", reason_code)
                return
            self.connected = True
            self.subscribed = False
            self.fan_on = None
            self.fan_status_request = None
            self.last_output["fan"] = None
            topics = [(TELEMETRY_TOPIC, 1), (RPC_RESPONSE_TOPIC, 1)]
            topics.extend(
                (f"{shelly_id}/events/rpc", 1) for shelly_id in SHELLY.values()
            )
            rc, _ = client.subscribe(topics)
            if rc != mqtt.MQTT_ERR_SUCCESS:
                logging.error("Could not request MQTT subscriptions: %s", rc)
            logging.info("Connected to Mosquitto")

    def on_subscribe(self, client, userdata, mid, reason_codes, properties):
        with self.lock:
            if any(code.is_failure for code in reason_codes):
                logging.error("MQTT subscription rejected: %s", reason_codes)
                return
            self.subscribed = True
            self.request_fan_status()

    def on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        with self.lock:
            self.connected = False
            self.subscribed = False
            self.event_inflight.clear()
            logging.warning("MQTT disconnected: %s", reason_code)

    def on_message(self, client, userdata, message):
        with self.lock:
            try:
                data = json.loads(message.payload.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                logging.warning("Ignoring invalid MQTT JSON on %s", message.topic)
                return
            if not isinstance(data, dict):
                return
            topic = message.topic
            if topic == TELEMETRY_TOPIC:
                self.handle_telemetry(data, retained=message.retain)
            elif topic == RPC_RESPONSE_TOPIC:
                self.handle_rpc_response(data)
            else:
                self._handle_shelly_event(topic, data)

    def _handle_shelly_event(self, topic, data):
        for actuator, shelly_id in SHELLY.items():
            if topic != f"{shelly_id}/events/rpc":
                continue
            if data.get("src") != shelly_id or data.get("method") != "NotifyStatus":
                return
            params = data.get("params")
            switch = params.get("switch:0", {}) if isinstance(params, dict) else {}
            if isinstance(switch, dict) and type(switch.get("output")) is bool:
                self.handle_notify(actuator, switch["output"])
            return

    def tick(self):
        with self.lock:
            self.note_missing_soil()
            self.flush_events()


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    controller = AutomationController()
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="pi-greenhouse-controller",
        protocol=mqtt.MQTTv311,
        clean_session=True,
    )
    client.username_pw_set(os.getenv("MQTT_USERNAME"), os.getenv("MQTT_PASSWORD"))
    controller.client = client
    client.on_connect = controller.on_connect
    client.on_subscribe = controller.on_subscribe
    client.on_disconnect = controller.on_disconnect
    client.on_message = controller.on_message
    client.on_publish = controller.on_publish
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()
    logging.info("Starting local automation (pump auto=%s)", PUMP_AUTO_ENABLED)
    try:
        while True:
            controller.tick()
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        client.disconnect()
        client.loop_stop()


if __name__ == "__main__":
    main()
