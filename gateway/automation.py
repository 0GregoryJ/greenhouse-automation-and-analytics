
"""
Greenhouse automation controller.

Subscribes to telemetry, evaluates fan and pump rules,
controls Shelly plugs via MQTT, and publishes automation
events for SQLite ingestion.
"""

import os
import json
import time
import uuid
import logging
import math
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt
from dotenv import load_dotenv


# ============================================================
# CONFIGURATION
# ============================================================

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT") or 1883)

TELEMETRY_TOPIC = os.getenv(
    "MQTT_SENSOR_TOPIC", "greenhouse/telemetry"
)
EVENT_TOPIC = "greenhouse/automation/events"

SHELLY = {
    "fan": os.environ["SHELLY_FAN_ID"],
    "pump": os.environ["SHELLY_PUMP_ID"]
}

RPC_SOURCE = "greenhouse/controller"
RPC_RESPONSE_TOPIC = f"{RPC_SOURCE}/rpc"

TEMP_TYPE = "air_temperature"
MOISTURE_TYPE = "soil_moisture"

FAN_ON_TEMP = 10
FAN_OFF_TEMP = 7

PUMP_AUTO_ENABLED = False
PUMP_MOISTURE_THRESHOLD=35
PUMP_RUN_SECONDS=3
PUMP_COOLDOWN=1800
PUMP_MAX_CYCLES=4

MAX_READING_AGE = 90

# Set a conservative maximum for initial testing.
if not 0 < PUMP_RUN_SECONDS <= 10:
    raise ValueError("Pump runtime must be between 0 and 10 seconds")

if FAN_OFF_TEMP >= FAN_ON_TEMP:
    raise ValueError("Fan OFF threshold must be below ON threshold")


# ============================================================
# CONTROLLER STATE
# ============================================================

# None means device state has not yet been confirmed.
observed = {"fan": None, "pump": None}

# Tracks commands awaiting confirmation.
pending = {"fan": None, "pump": None}

# Maps RPC request IDs to commands/status requests.
rpc_requests = {}

# Latest values and arrival timestamps.
readings = {}

# Prevents repeated watering.
pump_cycles = deque()

# Initial cooldown after a controller restart.
last_pump_start = time.monotonic()

active_pump_cycle = None


# ============================================================
# EVENT LOGGING
# ============================================================

def publish_event(client, actuator, event_type, **details):
    event = {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "actuator": actuator,
        "event_type": event_type,
        **details
    }

    if TEMP_TYPE in readings:
        event["temperature_c"] = readings[TEMP_TYPE]["value"]

    if MOISTURE_TYPE in readings:
        event["soil_moisture_pct"] = readings[MOISTURE_TYPE]["value"]

    result = client.publish(
        EVENT_TOPIC,
        json.dumps(event),
        qos=1,
        retain=False
    )

    if result.rc != mqtt.MQTT_ERR_SUCCESS:
        logging.error("Could not queue automation event")

    logging.info("%s: %s", actuator, event_type)


# ============================================================
# SHELLY COMMUNICATION
# ============================================================

def send_rpc(client, actuator, method, params, metadata):
    request_id = uuid.uuid4().hex

    payload = {
        "id": request_id,
        "src": RPC_SOURCE,
        "method": method,
        "params": params
    }

    result = client.publish(
        f"{SHELLY[actuator]}/rpc",
        json.dumps(payload),
        qos=1,
        retain=False
    )

    if result.rc != mqtt.MQTT_ERR_SUCCESS:
        logging.error("Failed to queue RPC for %s", actuator)
        return None

    rpc_requests[request_id] = {
        "actuator": actuator,
        **metadata
    }

    return request_id


def request_status(client, actuator):
    send_rpc(
        client,
        actuator,
        "Switch.GetStatus",
        {"id": 0},
        {"kind": "status"}
    )


def set_switch(client, actuator, turn_on, reason,
               duration=None, cycle_id=None):

    if pending[actuator] is not None:
        return False

    params = {
        "id": 0,
        "on": turn_on,
        "tag": "automation"
    }

    # Pump uses a Shelly-side automatic OFF timer.
    if duration is not None:
        params["toggle_after"] = duration

    request_id = send_rpc(
        client,
        actuator,
        "Switch.Set",
        params,
        {
            "kind": "command",
            "desired": turn_on,
            "cycle_id": cycle_id
        }
    )

    if request_id is None:
        return False

    pending[actuator] = {
        "id": request_id,
        "desired": turn_on
    }

    details = {
        "command_id": request_id,
        "desired_state": turn_on,
        "reason": reason
    }

    if cycle_id:
        details["cycle_id"] = cycle_id

    publish_event(
        client, actuator, "command_issued", **details
    )

    return True


# ============================================================
# SENSOR FRESHNESS
# ============================================================

def source_timestamp_is_recent(event):
    # Adjust these fields if your sensor schema uses
    # another timestamp name.
    raw = event.get("timestamp_utc") or event.get("timestamp")

    if not isinstance(raw, str):
        return False

    try:
        source_time = datetime.fromisoformat(
            raw.replace("Z", "+00:00")
        )

        if source_time.tzinfo is None:
            return False

        age = (
            datetime.now(timezone.utc) - source_time
        ).total_seconds()

        return -5 <= age <= MAX_READING_AGE

    except ValueError:
        return False


def get_reading(measurement_type, require_source_time=False):
    reading = readings.get(measurement_type)

    if reading is None:
        return None

    if time.monotonic() - reading["received_at"] > MAX_READING_AGE:
        return None

    if require_source_time and not reading["source_fresh"]:
        return None

    return reading["value"]


# ============================================================
# FAN AUTOMATION
# ============================================================

def evaluate_fan(client):
    temperature = get_reading(TEMP_TYPE)

    if temperature is None:
        return

    if observed["fan"] is None or pending["fan"] is not None:
        return

    # Hysteresis: different thresholds for ON and OFF.
    if not observed["fan"] and temperature >= FAN_ON_TEMP:
        set_switch(
            client, "fan", True, "temperature_high"
        )

    elif observed["fan"] and temperature <= FAN_OFF_TEMP:
        set_switch(
            client, "fan", False, "temperature_normal"
        )


# ============================================================
# PUMP AUTOMATION
# ============================================================

def evaluate_pump(client):
    global last_pump_start, active_pump_cycle

    if not PUMP_AUTO_ENABLED:
        return

    # Require a timestamped, fresh moisture measurement.
    moisture = get_reading(
        MOISTURE_TYPE, require_source_time=True
    )

    if moisture is None:
        return

    if observed["pump"] is not False:
        return

    if pending["pump"] is not None:
        return

    now = time.monotonic()

    # Remove cycles older than 24 hours.
    while pump_cycles and now - pump_cycles[0] >= 86400:
        pump_cycles.popleft()

    if len(pump_cycles) >= PUMP_MAX_CYCLES:
        return

    if now - last_pump_start < PUMP_COOLDOWN:
        return

    if moisture >= PUMP_MOISTURE_THRESHOLD:
        return

    cycle_id = str(uuid.uuid4())

    success = set_switch(
        client,
        actuator="pump",
        turn_on=True,
        reason="soil_moisture_low",
        duration=PUMP_RUN_SECONDS,
        cycle_id=cycle_id
    )

    if success:
        last_pump_start = now
        pump_cycles.append(now)
        active_pump_cycle = cycle_id


# ============================================================
# SHELLY STATE FEEDBACK
# ============================================================

def handle_shelly_state(client, actuator, state):
    global active_pump_cycle

    if not isinstance(state, bool):
        return

    previous = observed[actuator]
    observed[actuator] = state

    # Record confirmed relay state changes.
    if previous is not None and previous != state:
        details = {"observed_state": state}

        if actuator == "pump" and active_pump_cycle:
            details["cycle_id"] = active_pump_cycle

        publish_event(
            client, actuator, "state_changed", **details
        )

    # Clear pending command when desired state is observed.
    command = pending[actuator]

    if command and command["desired"] == state:
        pending[actuator] = None

    # Safety: do not inherit an active pump on startup.
    if actuator == "pump" and previous is None and state:
        set_switch(
            client, "pump", False, "startup_safety"
        )
        return

    if actuator == "pump" and previous is True and not state:
        active_pump_cycle = None

    if actuator == "fan":
        evaluate_fan(client)
    else:
        evaluate_pump(client)


def handle_rpc_response(client, data):
    request_id = data.get("id")
    request = rpc_requests.get(request_id)

    if request is None:
        return

    actuator = request["actuator"]

    # Confirm response originated from the expected plug.
    if data.get("src") != SHELLY[actuator]:
        return

    rpc_requests.pop(request_id, None)

    if request["kind"] == "status":
        state = data.get("result", {}).get("output")

        if isinstance(state, bool):
            handle_shelly_state(client, actuator, state)
        return

    if "error" in data:
        publish_event(
            client,
            actuator,
            "command_failed",
            command_id=request_id,
            reason=str(data["error"])
        )

        if (
            pending[actuator]
            and pending[actuator]["id"] == request_id
        ):
            pending[actuator] = None

    else:
        details = {
            "command_id": request_id,
            "desired_state": request["desired"]
        }

        if request.get("cycle_id"):
            details["cycle_id"] = request["cycle_id"]

        publish_event(
            client, actuator, "command_acknowledged", **details
        )

    # Always verify the resulting relay state.
    request_status(client, actuator)


# ============================================================
# MQTT CALLBACKS
# ============================================================

def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        logging.error("MQTT connection failed: %s", reason_code)
        return

    # Device state must be rediscovered after reconnecting.
    for actuator in observed:
        observed[actuator] = None
        pending[actuator] = None

    rpc_requests.clear()

    topics = [
        (TELEMETRY_TOPIC, 1),
        (RPC_RESPONSE_TOPIC, 1)
    ]

    for shelly_id in SHELLY.values():
        topics.append((f"{shelly_id}/events/rpc", 1))

    client.subscribe(topics)
    logging.info("Automation connected to Mosquitto")


def on_subscribe(client, userdata, mid, reason_codes, properties):
    if any(code.is_failure for code in reason_codes):
        logging.error("MQTT subscription rejected")
        return

    for actuator in SHELLY:
        request_status(client, actuator)


def on_message(client, userdata, message):
    try:
        data = json.loads(message.payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logging.warning("Invalid MQTT message")
        return

    topic = message.topic

    # Incoming ESP32 telemetry
    if topic == TELEMETRY_TOPIC:
        if message.retain or not isinstance(data, dict):
            return

        kind = data.get("measurement_type")

        if kind not in (TEMP_TYPE, MOISTURE_TYPE):
            return

        try:
            value = float(data["value"])
        except (KeyError, ValueError, TypeError):
            return

        if not math.isfinite(value):
            return

        if kind == MOISTURE_TYPE and not 0 <= value <= 100:
            return

        # Reject outdated timestamped messages.
        source_fresh = source_timestamp_is_recent(data)

        if (
            (data.get("timestamp_utc") or data.get("timestamp"))
            and not source_fresh
        ):
            return

        readings[kind] = {
            "value": value,
            "received_at": time.monotonic(),
            "source_fresh": source_fresh
        }

        if kind == TEMP_TYPE:
            evaluate_fan(client)
        else:
            evaluate_pump(client)

    # Shelly RPC responses
    elif topic == RPC_RESPONSE_TOPIC:
        if isinstance(data, dict):
            handle_rpc_response(client, data)

    # Shelly status notifications
    else:
        for actuator, shelly_id in SHELLY.items():
            if topic != f"{shelly_id}/events/rpc":
                continue

            if data.get("src") != shelly_id:
                return

            if data.get("method") not in (
                "NotifyStatus", "NotifyFullStatus"
            ):
                return

            switch = data.get("params", {}).get("switch:0", {})

            if "output" in switch:
                handle_shelly_state(
                    client, actuator, switch["output"]
                )

            return


# ============================================================
# MAIN
# ============================================================

def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s"
    )

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="pi-greenhouse-controller",
        protocol=mqtt.MQTTv311
    )

    client.username_pw_set(
        os.getenv("MQTT_USERNAME"),
        os.getenv("MQTT_PASSWORD")
    )

    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message

    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)

    logging.info("Starting greenhouse automation...")
    client.loop_forever()


if __name__ == "__main__":
    main()