"""
Maintain the latest greenhouse sensor readings in Redis.

Kafka remains the source of the event stream.
Redis serves as a low-latency, rebuildable materialized view.

Processing contract:
1. Poll an event from Kafka.
2. Validate the fields required for the live view.
3. Atomically update Redis if the event is not older than its current state.
4. Commit the Kafka offset only after Redis acknowledges the operation.

This provides at-least-once processing with idempotent state updates.
"""

import json
import logging
import os
import signal
from datetime import datetime, timezone

import redis
from confluent_kafka import Consumer, KafkaException


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("greenhouse-live-consumer")

running = True


def shutdown(signum, frame):
    """Request a graceful shutdown after the current operation."""
    global running
    running = False


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)


# Confit and Lua scripts
UPDATE_LATEST = """
local current = redis.call("HGET", KEYS[1], "timestamp_ms")
local incoming = tonumber(ARGV[1])

if current and tonumber(current) > incoming then
    return 0
end

redis.call(
    "HSET", KEYS[1],
    "timestamp_ms", ARGV[1],
    "value", ARGV[2],
    "unit", ARGV[3],
    "timestamp", ARGV[4],
    "event_id", ARGV[5],
    "sensor_id", ARGV[6],
    "gateway_id", ARGV[7],
    "measurement_type", ARGV[8]
)

return 1
"""


WRITE_AUTOMATION_EVENT = """
local existing = redis.call("LRANGE", KEYS[1], 0, -1)

for _, value in ipairs(existing) do
    local event = cjson.decode(value)

    if event.event_id == ARGV[1] then
        return 0
    end
end

redis.call("LPUSH", KEYS[1], ARGV[2])
redis.call("LTRIM", KEYS[1], 0, tonumber(ARGV[3]) - 1)

return 1
"""

AUTOMATION_EVENTS_KEY = "greenhouse:automation:recent"
MAX_AUTOMATION_EVENTS = 10

AUTOMATION_EVENT_TYPES = {
    "command_issued",
    "command_acknowledged",
    "command_failed",
    "state_changed",
}

AUTOMATION_ACTUATORS = {"fan", "pump"}

def parse_automation_event(raw_value):
    """Decode and validate an automation event for the live view."""

    event = json.loads(raw_value)

    if not isinstance(event, dict):
        raise ValueError("Automation event must be a JSON object")

    required = (
        "schema_version",
        "event_id",
        "timestamp_utc",
        "actuator",
        "event_type",
    )

    for field in required:
        if field not in event:
            raise ValueError(f"Missing required field: {field}")

    if type(event["schema_version"]) is not int or event["schema_version"] != 1:
        raise ValueError("Unsupported automation schema version")

    if not isinstance(event["event_id"], str) or not event["event_id"]:
        raise ValueError("Invalid event_id")

    if event["actuator"] not in AUTOMATION_ACTUATORS:
        raise ValueError("Invalid actuator")

    if event["event_type"] not in AUTOMATION_EVENT_TYPES:
        raise ValueError("Invalid event_type")

    event_time = datetime.fromisoformat(
        event["timestamp_utc"].replace("Z", "+00:00")
    )

    if event_time.utcoffset() is None:
        raise ValueError("Timestamp must include a timezone")

    return event

def parse_event(raw_value):
    """Decode and validate the fields needed for the live view."""
    event = json.loads(raw_value)

    required = (
        "event_id",
        "sensor_id",
        "gateway_id",
        "measurement_type",
        "timestamp",
        "value",
        "unit",
    )

    for field in required:
        if field not in event:
            raise ValueError(f"Missing required field: {field}")

    # Parse the event-time timestamp, not the ingestion time.
    event_time = datetime.fromisoformat(
        event["timestamp"].replace("Z", "+00:00")
    )

    if event_time.utcoffset() is None:
        raise ValueError("Timestamp must include a timezone")

    timestamp_ms = int(
        event_time.astimezone(timezone.utc).timestamp() * 1000
    )

    if not isinstance(event["value"], (int, float)):
        raise ValueError("Measurement value must be numeric")

    return event, timestamp_ms


def write_latest(redis_client, event, timestamp_ms):
    """Update the materialized view without overwriting newer data."""
    key = (
        f"greenhouse:latest:{event['gateway_id']}:"
        f"{event['sensor_id']}:{event['measurement_type']}"
    )

    updated = redis_client.eval(
        UPDATE_LATEST,
        1,
        key,
        timestamp_ms,
        str(event["value"]),
        event["unit"],
        event["timestamp"],
        event["event_id"],
        event["sensor_id"],
        event["gateway_id"],
        event["measurement_type"],
    )

    return key, bool(updated)

def write_history(redis_client, event):
    """Store the 10 most recent events for a sensor and measurement."""

    key = (
        f"greenhouse:history:{event['gateway_id']}:"
        f"{event['sensor_id']}:{event['measurement_type']}"
    )

    pipe = redis_client.pipeline()

    pipe.lpush(key, json.dumps(event))
    pipe.ltrim(key, 0, 9)

    pipe.execute()

    return key


def write_automation_event(redis_client, event):
    """Store up to 10 recent automation events without duplicates."""

    return bool(
        redis_client.eval(
            WRITE_AUTOMATION_EVENT,
            1,
            AUTOMATION_EVENTS_KEY,
            event["event_id"],
            json.dumps(event),
            MAX_AUTOMATION_EVENTS,
        )
    )

def main():
    kafka_servers = os.environ["KAFKA_BOOTSTRAP_SERVERS"]
    kafka_topic = os.environ["KAFKA_TOPIC"]
    automation_topic = os.environ["KAFKA_AUTOMATION_TOPIC"]
    redis_host = os.environ["REDIS_HOST"]
    consumer_group = os.environ["LIVE_KAFKA_CONSUMER_GROUP"]

    redis_client = redis.Redis(
        host=redis_host,
        port=6379,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )

    # Verify Redis before consuming Kafka messages.
    redis_client.ping()

    consumer = Consumer({
        "bootstrap.servers": kafka_servers,
        "group.id": consumer_group,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
        "enable.auto.offset.store": False,
        "client.id": "greenhouse-live-consumer",
    })

    consumer.subscribe([kafka_topic, automation_topic])

    logger.info(
        "Subscribed to Kafka topics: %s, %s",
        kafka_topic,
        automation_topic,
    )

    try:
        while running:
            message = consumer.poll(1.0)

            if message is None:
                continue

            if message.error():
                raise KafkaException(message.error())

            try:
                # ---------------------------------------------
                # Automation events
                # ---------------------------------------------
                if message.topic() == automation_topic:
                    event = parse_automation_event(message.value())

                    inserted = write_automation_event(
                        redis_client,
                        event,
                    )

                    logger.info(
                        "Processed automation event=%s actuator=%s "
                        "type=%s inserted=%s",
                        event["event_id"],
                        event["actuator"],
                        event["event_type"],
                        inserted,
                    )

                # ---------------------------------------------
                # Sensor events
                # ---------------------------------------------
                elif message.topic() == kafka_topic:
                    event, timestamp_ms = parse_event(message.value())

                    key, updated = write_latest(
                        redis_client,
                        event,
                        timestamp_ms,
                    )

                    if updated:
                        write_history(redis_client, event)

                    logger.info(
                        "Processed sensor event=%s key=%s updated=%s",
                        event["event_id"],
                        key,
                        updated,
                    )

                # ---------------------------------------------
                # Unexpected topics
                # ---------------------------------------------
                else:
                    logger.warning(
                        "Unexpected Kafka topic: %s",
                        message.topic(),
                    )
                    continue

            except (ValueError, TypeError, KeyError) as exc:
                logger.warning(
                    "Skipping malformed event topic=%s "
                    "partition=%s offset=%s: %s",
                    message.topic(),
                    message.partition(),
                    message.offset(),
                    exc,
                )

            # ---------------------------------------------
            # Commit Kafka offset
            # ---------------------------------------------
            # Commit only after Redis processing succeeds,
            # or after explicitly skipping invalid data.
            # Redis failures propagate without a commit.

            consumer.commit(
                message=message,
                asynchronous=False,
            )

    finally:
        logger.info("Closing Kafka consumer")
        consumer.close()
        redis_client.close()


if __name__ == "__main__":
    main()