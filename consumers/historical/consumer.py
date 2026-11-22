"""Persist sensor and automation Kafka events as gzipped JSONL in S3.

Contract:
- Subscribe to both event topics with the EXISTING historical consumer group.
- Validate each topic's required event fields independently.
- Batch per (topic, partition), upload, then synchronously commit offsets.
- Persist malformed messages to a separate S3 quarantine prefix BEFORE
  committing past them; no silent message loss.
- If an upload or commit fails, leave offsets uncommitted for replay.

Delivery is at-least-once. S3 may contain duplicates after replay; downstream
analyses should deduplicate by (topic, partition, offset) or event_id.
"""

import base64
import gzip
import json
import logging
import os
import signal
import time
from datetime import datetime, timezone

import boto3
from confluent_kafka import Consumer, KafkaException, TopicPartition


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("greenhouse-historical-consumer")

BATCH_SIZE = int(os.getenv("HISTORICAL_BATCH_SIZE", "240"))
FLUSH_SECONDS = float(os.getenv("HISTORICAL_FLUSH_SECONDS", "300"))

S3_BUCKET = os.environ["S3_BUCKET"]
S3_PREFIX = os.getenv("S3_PREFIX", "raw/sensor_events").strip("/")
S3_AUTOMATION_PREFIX = os.getenv(
    "S3_AUTOMATION_PREFIX", "raw/automation_events"
).strip("/")
S3_QUARANTINE_PREFIX = os.getenv(
    "S3_QUARANTINE_PREFIX", "raw/quarantine"
).strip("/")

# KAFKA_TOPIC remains the existing sensor topic setting.
SENSOR_TOPIC = os.getenv("KAFKA_TOPIC", "greenhouse.sensor-readings")
AUTOMATION_TOPIC = os.getenv(
    "KAFKA_AUTOMATION_TOPIC", "greenhouse.automation.events.v1"
)

if BATCH_SIZE < 1 or FLUSH_SECONDS <= 0:
    raise ValueError("Invalid historical batching configuration")
if SENSOR_TOPIC == AUTOMATION_TOPIC:
    raise ValueError("Sensor and automation Kafka topics must differ")

REQUIRED_FIELDS = {
    SENSOR_TOPIC: (
        "schema_version",
        "event_id",
        "sensor_id",
        "gateway_id",
        "timestamp",
        "measurement_type",
        "value",
        "unit",
    ),
    AUTOMATION_TOPIC: (
        "schema_version",
        "event_id",
        "timestamp_utc",
        "actuator",
        "event_type",
    ),
}

running = True


def shutdown(signum, frame):
    """Request a graceful stop from the poll loop."""
    global running
    running = False
    logger.info("Historical consumer shutdown requested")


def parse_event(raw_value, topic=None):
    """Validate required fields, preserving the original event body.

    topic=None defaults to the old sensor format for backward compatibility
    with code/tests calling parse_event(raw_value).
    """
    topic = SENSOR_TOPIC if topic is None else topic
    if topic not in REQUIRED_FIELDS:
        raise ValueError(f"Unexpected Kafka topic: {topic}")

    event = json.loads(raw_value)
    if not isinstance(event, dict):
        raise ValueError("Event must be a JSON object")

    for field in REQUIRED_FIELDS[topic]:
        if field not in event or event[field] is None:
            raise ValueError(f"Missing required field: {field}")

    if type(event["schema_version"]) is not int:
        raise ValueError("schema_version must be an integer")
    if not isinstance(event["event_id"], str) or not event["event_id"].strip():
        raise ValueError("event_id must be a nonempty string")

    if topic == AUTOMATION_TOPIC:
        for field in ("timestamp_utc", "actuator", "event_type"):
            if not isinstance(event[field], str) or not event[field].strip():
                raise ValueError(f"{field} must be a nonempty string")

    return event


def prefix_for_topic(topic):
    if topic == SENSOR_TOPIC:
        return S3_PREFIX
    if topic == AUTOMATION_TOPIC:
        return S3_AUTOMATION_PREFIX
    raise ValueError(f"Unexpected Kafka topic: {topic}")


def make_s3_key(batch):
    """Build the existing per-partition Kafka offset-range object key."""
    first = batch["records"][0]
    last = batch["records"][-1]
    year, month, day = batch["created_at"].strftime("%Y/%m/%d").split("/")
    prefix = prefix_for_topic(batch["topic"])

    return (
        f"{prefix}/"
        f"year={year}/month={month}/day={day}/"
        f"{batch['topic']}/"
        f"partition={batch['partition']}/"
        f"offsets-{first['offset']:020d}-{last['offset']:020d}.jsonl.gz"
    )


def upload_batch(s3, batch):
    """Upload one partition batch and return its S3 key."""
    lines = []
    for record in batch["records"]:
        output = dict(record["event"])
        output["_kafka_topic"] = batch["topic"]
        output["_kafka_partition"] = batch["partition"]
        output["_kafka_offset"] = record["offset"]
        lines.append(json.dumps(output, separators=(",", ":")))

    compressed = gzip.compress(("\n".join(lines) + "\n").encode("utf-8"))
    key = make_s3_key(batch)

    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=compressed,
        ContentType="application/x-ndjson",
        ContentEncoding="gzip",
    )

    logger.info(
        "Uploaded %d %s events to s3://%s/%s",
        len(batch["records"]), batch["topic"], S3_BUCKET, key,
    )
    return key


def commit_next_offset(kafka, topic, partition, next_offset):
    """Only call after corresponding data has been persisted to S3."""
    outcome = kafka.commit(
        offsets=[TopicPartition(topic, partition, next_offset)],
        asynchronous=False,
    )
    # Most failures raise KafkaException; inspect per-partition errors too.
    for committed_partition in outcome or []:
        error = getattr(committed_partition, "err", None)
        if error is not None:
            raise KafkaException(error)


def flush_partition(kafka, s3, batches, partition_key):
    """Upload a partition batch, commit its offset, then remove it."""
    batch = batches.get(partition_key)
    if not batch or not batch["records"]:
        return

    # This upload MUST succeed before the offset can be committed.
    upload_batch(s3, batch)
    last_offset = batch["records"][-1]["offset"]
    commit_next_offset(kafka, batch["topic"], batch["partition"], last_offset + 1)
    logger.info(
        "Committed topic=%s partition=%s next_offset=%s",
        batch["topic"], batch["partition"], last_offset + 1,
    )
    del batches[partition_key]


def flush_all(kafka, s3, batches):
    for partition_key in list(batches):
        flush_partition(kafka, s3, batches, partition_key)


def quarantine_bad_record(s3, message, error):
    """Store the original malformed Kafka payload before allowing its skip.

    A stable topic/partition/offset key makes repeated attempts overwrite the
    same quarantine object rather than generate new quarantine objects.
    """
    key = (
        f"{S3_QUARANTINE_PREFIX}/"
        f"{message.topic()}/partition={message.partition()}/"
        f"offset-{message.offset():020d}.json"
    )
    raw = message.value()
    payload = {
        "_kafka_topic": message.topic(),
        "_kafka_partition": message.partition(),
        "_kafka_offset": message.offset(),
        "quarantined_at": datetime.now(timezone.utc).isoformat(),
        "error": str(error),
        "raw_value_base64": base64.b64encode(raw or b"").decode("ascii"),
    }
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
    )
    logger.error("Quarantined invalid event: topic=%s partition=%s offset=%s key=%s",
                 message.topic(), message.partition(), message.offset(), key)
    return key


def process_message(kafka, s3, batches, message):
    """Process one message, keeping offsets independent per topic/partition."""
    key = (message.topic(), message.partition())
    try:
        event = parse_event(message.value(), message.topic())
    except (ValueError, TypeError, KeyError, UnicodeDecodeError) as exc:
        # Flush valid events already buffered from this partition, then
        # quarantine this record. Never commit invalid bytes before the
        # quarantine upload succeeds.
        flush_partition(kafka, s3, batches, key)
        quarantine_bad_record(s3, message, exc)
        commit_next_offset(kafka, message.topic(), message.partition(), message.offset() + 1)
        return

    if key not in batches:
        batches[key] = {
            "topic": message.topic(),
            "partition": message.partition(),
            "created_at": datetime.now(timezone.utc),
            "started": time.monotonic(),
            "records": [],
        }

    batches[key]["records"].append({
        "offset": message.offset(),
        "event": event,
    })

    if len(batches[key]["records"]) >= BATCH_SIZE:
        flush_partition(kafka, s3, batches, key)


def main():
    kafka = Consumer({
        "bootstrap.servers": os.environ["KAFKA_BOOTSTRAP_SERVERS"],
        "group.id": os.getenv(
            "HISTORICAL_KAFKA_CONSUMER_GROUP", "greenhouse-historical"
        ),
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
        "enable.auto.offset.store": False,
        "client.id": "greenhouse-historical-consumer",
    })
    s3 = boto3.client("s3")
    batches = {}

    def on_revoke(consumer, partitions):
        # Persist the pending batches for partitions still owned.
        for partition in partitions:
            key = (partition.topic, partition.partition)
            flush_partition(consumer, s3, batches, key)

    def on_lost(consumer, partitions):
        # May no longer own them: don't commit; broker will replay.
        for partition in partitions:
            batches.pop((partition.topic, partition.partition), None)

    kafka.subscribe(
        [SENSOR_TOPIC, AUTOMATION_TOPIC],
        on_revoke=on_revoke,
        on_lost=on_lost,
    )
    logger.info(
        "Historical consumer started: sensor=%s automation=%s",
        SENSOR_TOPIC, AUTOMATION_TOPIC,
    )

    try:
        while running:
            message = kafka.poll(1.0)
            if message is not None:
                if message.error():
                    raise KafkaException(message.error())
                process_message(kafka, s3, batches, message)

            now = time.monotonic()
            for key in list(batches):
                if now - batches[key]["started"] >= FLUSH_SECONDS:
                    flush_partition(kafka, s3, batches, key)
    finally:
        # If upload failed, don't force additional commits: replay on restart.
        try:
            if running is False:
                flush_all(kafka, s3, batches)
        finally:
            kafka.close()
            logger.info("Historical consumer stopped")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    main()
