"""
Subscribes to the greenhouse/telemetry MQTT topic, validates incoming events
against the JSON schema, and inserts valid, non-duplicate events into SQLite.

Initializes the database and table if they don't exist.
Provides a persistent buffer between MQTT ingestion and the Kafka producer.

Intended to run continuously on the Raspberry Pi.
"""

import json
import os
import sqlite3
import logging
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt
from dotenv import load_dotenv
from jsonschema import ValidationError, validate

# Configuration
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "gateway" / "data" / "sensor_events.db"

load_dotenv(ROOT / ".env")

# Ingest runs on the same host as Mosquitto, so it always connects to localhost.
# Port and topic can be overridden in .env; a blank value uses the default.
MQTT_HOST = "localhost"
MQTT_PORT = int(os.getenv("MQTT_PORT") or 1883)
MQTT_SENSOR_TOPIC = (
    os.getenv("MQTT_SENSOR_TOPIC")
    or "greenhouse/telemetry"
)

MQTT_AUTOMATION_TOPIC = (
    os.getenv("MQTT_AUTOMATION_TOPIC")
    or "greenhouse/automation/events"
)

SENSOR_SCHEMAS = {
    1: json.load(open(ROOT / "schemas" / "sensor_event.v1.schema.json")),
    2: json.load(open(ROOT / "schemas" / "sensor_event.v2.schema.json"))
}

AUTOMATION_SCHEMAS = {
    1: json.load(open(ROOT / "schemas" / "automation_event.v1.schema.json"))
}


# Creates SQLite database and table.
def initialize_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA synchronous = FULL")
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sensor_events (
                event_id TEXT PRIMARY KEY,
                event_json TEXT NOT NULL,
                received_at TEXT NOT NULL,
                kafka_published_at TEXT
            );

            CREATE TABLE IF NOT EXISTS automation_events (
                event_id TEXT PRIMARY KEY,
                event_json TEXT NOT NULL,
                timestamp_utc TEXT NOT NULL,
                received_at TEXT NOT NULL,
                actuator TEXT NOT NULL,
                event_type TEXT NOT NULL,
                command_id TEXT,
                cycle_id TEXT,
                kafka_published_at TEXT
            )
        """)

# Subscribes to greenhouse/telemetry MQTT topic. Runs when connected to Mosquitto.
def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        print(f"Connection failed: {reason_code}")
        return

    client.subscribe([
        (MQTT_SENSOR_TOPIC, 1),
        (MQTT_AUTOMATION_TOPIC, 1)
    ])

    print(f"Subscribed to {MQTT_SENSOR_TOPIC}")
    print(f"Subscribed to {MQTT_AUTOMATION_TOPIC}")

# Validates events.
def validate_event(event, event_kind):
    version = event.get("schema_version")

    schemas = (
        SENSOR_SCHEMAS
        if event_kind == "sensor"
        else AUTOMATION_SCHEMAS
    )

    if version not in schemas:
        raise ValueError(f"Unsupported schema version: {version}")

    validate(instance=event, schema=schemas[version])

# Decodes JSON, validates against schema, inserts into SQLite table. Runs when Mosquitto delivers an event.
def on_message(client, userdata, message):
    topic = message.topic

    if topic == MQTT_SENSOR_TOPIC:
        event_kind = "sensor"
    elif topic == MQTT_AUTOMATION_TOPIC:
        event_kind = "automation"
    else:
        logging.warning("Unexpected MQTT topic: %s", topic)
        return

    try:
        event = json.loads(message.payload.decode("utf-8"))
        validate_event(event, event_kind)

    except (ValueError, ValidationError, UnicodeDecodeError) as error:
        logging.warning("Invalid %s event: %s", event_kind, error)

        rc = client.ack(message.mid, message.qos)
        if rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"MQTT acknowledgment failed: {rc}")
        return

    received_at = datetime.now(timezone.utc).isoformat()

    try:
        with sqlite3.connect(DB_PATH, timeout=30) as conn:

            if event_kind == "sensor":
                result = conn.execute(
                    """
                    INSERT OR IGNORE INTO sensor_events
                        (event_id, event_json, received_at)
                    VALUES (?, ?, ?)
                    """,
                    (
                        event["event_id"],
                        json.dumps(event),
                        received_at
                    )
                )

            else:
                result = conn.execute(
                    """
                    INSERT OR IGNORE INTO automation_events
                        (
                            event_id,
                            event_json,
                            timestamp_utc,
                            received_at,
                            actuator,
                            event_type,
                            command_id,
                            cycle_id
                        )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event["event_id"],
                        json.dumps(event),
                        event["timestamp_utc"],
                        received_at,
                        event["actuator"],
                        event["event_type"],
                        event.get("command_id"),
                        event.get("cycle_id")
                    )
                )

            inserted = result.rowcount == 1

    except sqlite3.Error:
        logging.exception("SQLite persistence failed")
        raise

    # Acknowledge only after successful database commit.
    rc = client.ack(message.mid, message.qos)

    if rc != mqtt.MQTT_ERR_SUCCESS:
        raise RuntimeError(f"MQTT acknowledgment failed: {rc}")

    if inserted:
        print(f"Saved {event_kind} event: {event['event_id']}")
    else:
        print(f"Duplicate ignored: {event['event_id']}")

# Main service
def main():

    # Create database and table if they don't already exist.
    initialize_database()

    # Connect to Mosquitto, subscribe to greenhouse/telemetry topic, insert events into SQLite table.
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="pi-sqlite-ingestor",
        protocol=mqtt.MQTTv311,
        clean_session=False,
        manual_ack=True,
    )

    client.username_pw_set(
        os.getenv("MQTT_USERNAME"),
        os.getenv("MQTT_PASSWORD")
    )

    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)

    print("Starting SQLite ingestion...")
    client.loop_forever()


if __name__ == "__main__":
    main()
