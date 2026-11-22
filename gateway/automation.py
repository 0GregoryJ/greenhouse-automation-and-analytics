"""
Local MQTT greenhouse controller for Shelly Gen2+ fan and pump plugs.

Sensor data -> rules -> Shelly RPC -> observed relay status -> automation events.
A local SQLite safety ledger survives service restarts, and a durable event
outbox retries QoS 1 publications until the MQTT broker acknowledges them.

IMPORTANT: Set Shelly pump power-restore state to OFF and configure a device-side
AUTO-OFF safety limit. The Python controller cannot protect against an offline
Shelly plug, broken Wi-Fi, or a Pi without power.
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
TEMP_TYPE = "air_temperature"  # Matches your current telemetry
MOISTURE_TYPE = "soil_moisture"

FAN_ON_TEMP = 24
FAN_OFF_TEMP = 21

PUMP_AUTO_ENABLED = True
PUMP_MOISTURE_THRESHOLD = 600
PUMP_RUN_SECONDS = 5
PUMP_COOLDOWN = 43200
PUMP_MAX_CYCLES = 1
PUMP_MIN_VALID_RAW = 450
PUMP_MAX_VALID_RAW = 1200
PUMP_REQUIRED_LOW_READINGS = 3
MOISTURE_SENSOR_ID = "soil-001"

MAX_READING_AGE = 90
RPC_TIMEOUT = 10
STATUS_POLL_INTERVAL = 10
PUMP_GRACE_SECONDS = 3.0  # Additional delay before emergency OFF
EMERGENCY_OFF_RETRY_SECONDS = 5.0
EVENT_RETRY_SECONDS = 8.0
EVENT_ACK_TIMEOUT_SECONDS = 30.0
MAX_EVENT_INFLIGHT = 20

STATE_DB_PATH = ROOT / "gateway" / "data" / "automation_state.db"

if FAN_OFF_TEMP >= FAN_ON_TEMP:
    raise ValueError("FAN_OFF_TEMP must be lower than FAN_ON_TEMP")
if not 0 < PUMP_RUN_SECONDS <= 10:
    raise ValueError("PUMP_RUN_SECONDS must be > 0 and <= 10")
if not PUMP_MIN_VALID_RAW < PUMP_MOISTURE_THRESHOLD < PUMP_MAX_VALID_RAW:
    raise ValueError("Moisture threshold must lie strictly within plausible raw range")
if PUMP_COOLDOWN < 0 or PUMP_MAX_CYCLES < 1 or PUMP_REQUIRED_LOW_READINGS < 1:
    raise ValueError("Invalid pump cooldown, cycle limit, or reading count")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def parse_timestamp(event):
    """Accept timezone-aware source timestamps; missing/invalid => stale."""
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


def source_is_recent(event):
    timestamp = parse_timestamp(event)
    if timestamp is None:
        return False
    age = (datetime.now(timezone.utc) - timestamp).total_seconds()
    return -5 <= age <= MAX_READING_AGE


class AutomationController:
    def __init__(self, db_path=STATE_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
        self.lock = threading.RLock()
        self.client = None
        self.connected = False
        self.subscribed = False
        self.observed = {"fan": None, "pump": None}
        self.observed_at = {"fan": 0.0, "pump": 0.0}
        self.pending = {"fan": None, "pump": None}
        self.rpc_requests = {}
        self.readings = {}
        self.seen_sensor_ids = deque(maxlen=256)
        self.low_moisture_count = 0
        self.active_pump_cycle = None
        self.pump_on_at = None
        self.pump_command_at = None
        self.last_status_request = {"fan": 0.0, "pump": 0.0}
        self.last_emergency_off = -1e9
        self.event_inflight = {}  # MQTT packet id -> (event id, sent monotonic)
        self.event_attempts = {}  # event id -> monotonic timestamp

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

    # This is an operational SQLite database, separate from the analytics
    # SQLite database written by gateway/ingest.py.
    def record_pump_attempt(self, cycle_id):
        """Reserve cooldown/budget BEFORE sending a possibly uncertain ON command."""
        now = time.time()
        with self._db() as conn:
            conn.execute(
                "INSERT INTO pump_attempts (cycle_id, attempted_at, run_seconds) "
                "VALUES (?, ?, ?)", (cycle_id, now, PUMP_RUN_SECONDS)
            )

    def pump_budget_available(self):
        now = time.time()
        with self._db() as conn:
            count, most_recent = conn.execute(
                "SELECT COUNT(*), MAX(attempted_at) FROM pump_attempts "
                "WHERE attempted_at > ?", (now - 86400,)
            ).fetchone()
            # Treat future-dated records as suspicious; do not water.
            future = conn.execute(
                "SELECT COUNT(*) FROM pump_attempts WHERE attempted_at > ?",
                (now + 5,)
            ).fetchone()[0]
        if future or count >= PUMP_MAX_CYCLES:
            return False
        return most_recent is None or now - most_recent >= PUMP_COOLDOWN

    def emit(self, actuator, event_type, **details):
        """Store first; independently retry publishing to the ingestion service."""
        event = {
            "schema_version": 1,
            "event_id": str(uuid.uuid4()),
            "timestamp_utc": utc_now(),
            "actuator": actuator,
            "event_type": event_type,
            **details,
        }
        temperature = self.get_reading(TEMP_TYPE)
        if temperature is not None:
            event["temperature_c"] = temperature
        # Do not label the raw ~600-800 moisture reading as a percentage.
        # For now the exact raw reading remains in sensor telemetry. Add
        # soil_moisture_raw to the automation JSON schema before emitting it.
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

    def send_rpc(self, actuator, method, params, metadata):
        if not self.connected or not self.subscribed:
            return None
        request_id = uuid.uuid4().hex
        payload = {"id": request_id, "src": RPC_SOURCE,
                   "method": method, "params": params}
        self.rpc_requests[request_id] = {
            "actuator": actuator,
            "sent_at": time.monotonic(),
            **metadata,
        }
        # Switch.Set uses QoS 0 deliberately: Paho can retransmit unacknowledged
        # QoS 1 publishes after reconnect, which is dangerous for pump ON.
        # We detect uncertain command outcomes via RPC timeouts/status polling.
        # GetStatus is safe to repeat, so it uses QoS 1.
        qos = 0 if method == "Switch.Set" else 1
        info = self.client.publish(
            f"{SHELLY[actuator]}/rpc", json.dumps(payload), qos=qos, retain=False
        )
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            self.rpc_requests.pop(request_id, None)
            logging.error("Could not queue %s RPC for %s", method, actuator)
            return None
        return request_id

    def request_status(self, actuator):
        # Avoid overlapping status requests on the same device.
        if any(r["actuator"] == actuator and r["kind"] == "status"
               for r in self.rpc_requests.values()):
            return
        request_id = self.send_rpc(
            actuator, "Switch.GetStatus", {"id": 0}, {"kind": "status"}
        )
        if request_id is not None:
            self.last_status_request[actuator] = time.monotonic()

    def set_switch(self, actuator, turn_on, reason, cycle_id=None, duration=None,
                   emergency=False):
        if self.pending[actuator] is not None and not emergency:
            return False
        params = {"id": 0, "on": turn_on, "tag": "automation"}
        if duration is not None:
            params["toggle_after"] = duration
        req_id = self.send_rpc(
            actuator, "Switch.Set", params,
            {"kind": "command", "desired": turn_on, "cycle_id": cycle_id},
        )
        if req_id is None:
            return False
        self.pending[actuator] = {"id": req_id, "desired": turn_on,
                                  "cycle_id": cycle_id}
        details = {"command_id": req_id, "desired_state": turn_on, "reason": reason}
        if cycle_id:
            details["cycle_id"] = cycle_id
        self.emit(actuator, "command_issued", **details)
        return True

    def emergency_pump_off(self, reason):
        # Ignore pending ON commands; a safety OFF always takes precedence.
        now = time.monotonic()
        if now - self.last_emergency_off < EMERGENCY_OFF_RETRY_SECONDS:
            return
        if self.set_switch("pump", False, reason, emergency=True):
            self.last_emergency_off = now

    def get_reading(self, measurement_type, require_source_time=False):
        reading = self.readings.get(measurement_type)
        if reading is None:
            return None
        if time.monotonic() - reading["received_at"] > MAX_READING_AGE:
            return None
        if require_source_time and not reading["source_fresh"]:
            return None
        return reading["value"]

    def evaluate_fan(self):
        temperature = self.get_reading(TEMP_TYPE)
        if temperature is None or not self.connected or not self.subscribed:
            return
        if self.observed["fan"] is None or self.pending["fan"] is not None:
            return
        if not self.observed["fan"] and temperature >= FAN_ON_TEMP:
            self.set_switch("fan", True, "temperature_high")
        elif self.observed["fan"] and temperature <= FAN_OFF_TEMP:
            self.set_switch("fan", False, "temperature_normal")

    def evaluate_pump(self):
        if not PUMP_AUTO_ENABLED or not self.connected or not self.subscribed:
            return
        moisture = self.get_reading(MOISTURE_TYPE, require_source_time=True)
        if moisture is None or self.low_moisture_count < PUMP_REQUIRED_LOW_READINGS:
            return
        if not self.pump_budget_available():
            return
        if self.observed["pump"] is not False or self.pending["pump"] is not None:
            return
        if self.active_pump_cycle is not None:
            return
        if moisture >= PUMP_MOISTURE_THRESHOLD:
            return  # Higher readings tentatively mean wetter soil.
        cycle_id = uuid.uuid4().hex
        # Reserve an attempt durably BEFORE publishing an ON command.
        self.record_pump_attempt(cycle_id)
        self.low_moisture_count = 0
        # Save cycle ID before sending: fast status events can arrive immediately.
        self.active_pump_cycle = cycle_id
        self.pump_command_at = time.monotonic()
        result = self.set_switch(
            "pump", True, "soil_moisture_low", cycle_id=cycle_id,
            duration=PUMP_RUN_SECONDS,
        )
        if not result:
            # The attempt remains counted: we cannot rule out an uncertain send.
            self.active_pump_cycle = None
            self.pump_command_at = None
            logging.error("Pump ON not queued; conservative budget reserved")

    def handle_shelly_state(self, actuator, state):
        if type(state) is not bool:
            return
        now = time.monotonic()
        previous = self.observed[actuator]
        self.observed[actuator] = state
        self.observed_at[actuator] = now
        if previous is None or previous != state:
            # 'initial_observation' marks a baseline, not necessarily a transition.
            reason = "initial_observation" if previous is None else "shelly_status"
            details = {"observed_state": state, "reason": reason}
            if actuator == "pump" and self.active_pump_cycle:
                details["cycle_id"] = self.active_pump_cycle
            self.emit(actuator, "state_changed", **details)
        current = self.pending[actuator]
        if current is not None and current["desired"] == state:
            self.pending[actuator] = None

        if actuator == "pump":
            if state:
                if self.active_pump_cycle is None:
                    self.emergency_pump_off("unexpected_pump_on")
                elif self.pump_on_at is None:
                    self.pump_on_at = now
            else:
                self.pump_on_at = None
                if (self.active_pump_cycle is not None
                        and (self.pump_on_at is not None
                             or (self.pump_command_at is not None
                                 and now - self.pump_command_at >= PUMP_RUN_SECONDS))):
                    # Ignore a potentially old OFF status that races with ON.
                    self.active_pump_cycle = None
                    self.pump_command_at = None
                    self.low_moisture_count = 0
            # Do not immediately re-evaluate the pump from status feedback.
            # Only a *new* moisture measurement may trigger another cycle.
        else:
            self.evaluate_fan()

    def handle_rpc_response(self, data):
        request_id = data.get("id")
        request = self.rpc_requests.get(request_id)
        if request is None:
            return
        actuator = request["actuator"]
        if data.get("src") != SHELLY[actuator]:
            return
        self.rpc_requests.pop(request_id, None)
        if request["kind"] == "status":
            status = data.get("result")
            if isinstance(status, dict) and type(status.get("output")) is bool:
                self.handle_shelly_state(actuator, status["output"])
            else:
                logging.warning("Invalid status response for %s: %s", actuator, data)
            return
        details = {"command_id": request_id, "desired_state": request["desired"]}
        if request.get("cycle_id"):
            details["cycle_id"] = request["cycle_id"]
        if "error" in data:
            self.emit(actuator, "command_failed", reason=str(data["error"]), **details)
            if self.pending[actuator] and self.pending[actuator]["id"] == request_id:
                self.pending[actuator] = None
        else:
            self.emit(actuator, "command_acknowledged", **details)
        self.request_status(actuator)  # Confirm actual relay output separately.

    def on_connect(self, client, userdata, flags, reason_code, properties):
        with self.lock:
            if reason_code.is_failure:
                logging.error("Mosquitto refused connection: %s", reason_code)
                return
            self.connected = True
            self.subscribed = False
            for actuator in SHELLY:
                self.observed[actuator] = None
                self.observed_at[actuator] = 0
                self.pending[actuator] = None
            self.rpc_requests.clear()
            self.readings.clear()
            self.low_moisture_count = 0
            self.seen_sensor_ids.clear()
            self.active_pump_cycle = None
            self.pump_on_at = None
            self.pump_command_at = None
            self.event_inflight.clear()
            self.event_attempts.clear()
            topics = [(TELEMETRY_TOPIC, 1), (RPC_RESPONSE_TOPIC, 1)]
            topics.extend((f"{shelly_id}/events/rpc", 1)
                          for shelly_id in SHELLY.values())
            rc, _ = client.subscribe(topics)
            if rc != mqtt.MQTT_ERR_SUCCESS:
                logging.error("Could not request MQTT subscriptions: %s", rc)
            logging.info("Connected to Mosquitto; reconciling devices")

    def on_subscribe(self, client, userdata, mid, reason_codes, properties):
        with self.lock:
            if any(code.is_failure for code in reason_codes):
                logging.error("MQTT subscription rejected: %s", reason_codes)
                return
            self.subscribed = True
            for actuator in SHELLY:
                self.request_status(actuator)

    def on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        with self.lock:
            self.connected = False
            self.subscribed = False
            self.observed = {"fan": None, "pump": None}
            self.pending = {"fan": None, "pump": None}
            self.rpc_requests.clear()
            self.readings.clear()
            self.active_pump_cycle = None
            self.pump_on_at = None
            self.pump_command_at = None
            self.low_moisture_count = 0
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
                for actuator, shelly_id in SHELLY.items():
                    if topic != f"{shelly_id}/events/rpc":
                        continue
                    if data.get("src") != shelly_id:
                        return
                    if data.get("method") not in ("NotifyStatus", "NotifyFullStatus"):
                        return
                    params = data.get("params")
                    switch = params.get("switch:0", {}) if isinstance(params, dict) else {}
                    if isinstance(switch, dict) and "output" in switch:
                        self.handle_shelly_state(actuator, switch["output"])
                    return

    def handle_telemetry(self, event, retained=False):
        if retained:
            return
        kind = event.get("measurement_type")
        if kind not in (TEMP_TYPE, MOISTURE_TYPE):
            return
        event_id = event.get("event_id")
        if event_id is not None and event_id in self.seen_sensor_ids:
            return  # QoS 1 can redeliver a measurement.
        try:
            value = float(event["value"])
        except (KeyError, TypeError, ValueError):
            return
        if not math.isfinite(value):
            return
        timestamp_ok = source_is_recent(event)
        # Reject stale source-timestamped data, even if it just arrived.
        if any(event.get(k) is not None for k in
               ("timestamp_utc", "timestamp", "observed_at", "measured_at")) and not timestamp_ok:
            return
        if kind == MOISTURE_TYPE:
            if MOISTURE_SENSOR_ID and event.get("sensor_id") != MOISTURE_SENSOR_ID:
                return
            # ~300 in air is considered invalid, never an irrigation trigger.
            if not PUMP_MIN_VALID_RAW <= value <= PUMP_MAX_VALID_RAW:
                self.low_moisture_count = 0
                logging.warning("Implausible moisture reading %.1f: watering inhibited", value)
                return
            if not timestamp_ok:
                self.low_moisture_count = 0
                logging.warning("Moisture lacks fresh source timestamp; watering inhibited")
                return
            if value < PUMP_MOISTURE_THRESHOLD:
                self.low_moisture_count += 1
            else:
                self.low_moisture_count = 0
        else:
            if not -20 <= value <= 70:
                return  # Celsius range; adjust if needed.
        if event_id is not None:
            self.seen_sensor_ids.append(event_id)
        self.readings[kind] = {"value": value, "received_at": time.monotonic(),
                               "source_fresh": timestamp_ok}
        if kind == TEMP_TYPE:
            self.evaluate_fan()
        else:
            self.evaluate_pump()

    def tick(self):
        """Periodic watchdog: no sleeps inside MQTT callbacks."""
        with self.lock:
            now = time.monotonic()
            for request_id, request in list(self.rpc_requests.items()):
                if now - request["sent_at"] < RPC_TIMEOUT:
                    continue
                self.rpc_requests.pop(request_id, None)
                actuator = request["actuator"]
                if request["kind"] == "command":
                    # A timeout does NOT prove the command failed.
                    details = {"command_id": request_id,
                               "desired_state": request["desired"],
                               "reason": "rpc_timeout_outcome_unknown"}
                    if request.get("cycle_id"):
                        details["cycle_id"] = request["cycle_id"]
                    self.emit(actuator, "command_failed", **details)
                    if self.pending[actuator] and self.pending[actuator]["id"] == request_id:
                        self.pending[actuator] = None
                logging.warning("RPC timeout: %s %s", actuator, request["kind"])
                self.observed[actuator] = None
                self.observed_at[actuator] = 0
            if not self.connected or not self.subscribed:
                return
            for actuator in SHELLY:
                if (now - self.last_status_request[actuator] > STATUS_POLL_INTERVAL
                        and not any(r["actuator"] == actuator and r["kind"] == "status"
                                    for r in self.rpc_requests.values())):
                    self.request_status(actuator)
            # Even without ON status feedback, an unverified pump command
            # must be followed by a safety OFF after its maximum runtime.
            if (self.active_pump_cycle is not None
                    and self.pump_command_at is not None
                    and now - self.pump_command_at > PUMP_RUN_SECONDS + PUMP_GRACE_SECONDS):
                self.emergency_pump_off("pump_command_runtime_exceeded")
            # If a pump is still on after its timer, force OFF.
            if self.observed["pump"] is True:
                if self.active_pump_cycle is None:
                    self.emergency_pump_off("unexpected_pump_on")
                elif (self.pump_on_at is not None
                      and now - self.pump_on_at > PUMP_RUN_SECONDS + PUMP_GRACE_SECONDS):
                    self.emergency_pump_off("pump_runtime_exceeded")
            self.flush_events()


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    controller = AutomationController()
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="pi-greenhouse-controller",
        protocol=mqtt.MQTTv311,
        clean_session=True,  # Fresh subscriptions; Switch.Set uses QoS 0.
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
