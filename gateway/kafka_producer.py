"""SQLite-to-Kafka publisher for the Raspberry Pi gateway.

Publishes both sensor and automation event outboxes.

Guarantees:
- Events are selected from the local SQLite outbox.
- Only Kafka-acknowledged events are marked delivered.
- No new batch starts while a previous batch has in-flight messages.
- Failed and unconfirmed events remain in SQLite for future retries.
- Delivery is at-least-once, not exactly-once.
"""

import logging
import os
import signal
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from confluent_kafka import Producer
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "gateway" / "data" / "sensor_events.db"

load_dotenv(ROOT / ".env")

KAFKA_SERVERS = os.environ["KAFKA_BOOTSTRAP_SERVERS"]

KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "greenhouse.sensor-readings")
KAFKA_AUTOMATION_TOPIC = os.getenv(
    "KAFKA_AUTOMATION_TOPIC", "greenhouse.automation.events.v1"
)

# Fixed, allowlisted table names; never interpolate a user-supplied table name.
OUTBOX_TABLES = {
    "sensor": "sensor_events",
    "automation": "automation_events",
}

BATCH_SIZE = int(os.getenv("KAFKA_BATCH_SIZE", "100"))
RETRY_SECONDS = float(os.getenv("KAFKA_RETRY_SECONDS", "5"))
DELIVERY_TIMEOUT_MS = int(os.getenv("KAFKA_DELIVERY_TIMEOUT_MS", "60000"))

if BATCH_SIZE < 1 or RETRY_SECONDS <= 0 or DELIVERY_TIMEOUT_MS < 1000:
    raise ValueError("Invalid Kafka producer configuration")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("greenhouse.kafka_producer")

running = True


def request_shutdown(signum, frame):
    global running
    running = False
    logger.info("Shutdown requested")


signal.signal(signal.SIGTERM, request_shutdown)
signal.signal(signal.SIGINT, request_shutdown)


def outbox_table(event_kind):
    """Map a known event kind to its corresponding SQLite outbox."""
    try:
        return OUTBOX_TABLES[event_kind]
    except KeyError as exc:
        raise ValueError(f"Unknown event kind: {event_kind}") from exc


def kafka_topic(event_kind):
    """Keep topic configuration dynamic for backwards-compatible tests."""
    if event_kind == "sensor":
        return KAFKA_TOPIC
    if event_kind == "automation":
        return KAFKA_AUTOMATION_TOPIC
    raise ValueError(f"Unknown event kind: {event_kind}")


def fetch_pending(conn, event_kind="sensor"):
    """Fetch the oldest undelivered events in a bounded batch."""
    table = outbox_table(event_kind)
    return conn.execute(
        f"""
        SELECT event_id, event_json
        FROM {table}
        WHERE kafka_published_at IS NULL
        ORDER BY received_at, event_id
        LIMIT ?
        """,
        (BATCH_SIZE,),
    ).fetchall()


def mark_delivered(conn, event_ids, event_kind="sensor"):
    """Atomically mark only Kafka-acknowledged events as published."""
    if not event_ids:
        return

    table = outbox_table(event_kind)
    published_at = datetime.now(timezone.utc).isoformat()

    with conn:
        conn.executemany(
            f"""
            UPDATE {table}
            SET kafka_published_at = ?
            WHERE event_id = ?
              AND kafka_published_at IS NULL
            """,
            [(published_at, event_id) for event_id in event_ids],
        )


def publish_batch(producer, conn, rows, event_kind="sensor"):
    """Publish and resolve a single stream's batch before returning.

    All delivery callbacks for this batch complete before the next batch.
    Defaults to the sensor stream for existing callers/tests.
    """
    topic = kafka_topic(event_kind)
    acknowledged = set()
    failed = set()
    queued = 0
    enqueue_interrupted = False

    def delivery_callback(err, msg):
        event_id = msg.key().decode("utf-8")
        if err is not None:
            failed.add(event_id)
            logger.error(
                "Kafka delivery failed topic=%s event_id=%s: %s",
                topic, event_id, err,
            )
        else:
            acknowledged.add(event_id)

    for event_id, event_json in rows:
        if not running:
            enqueue_interrupted = True
            break

        try:
            producer.produce(
                topic=topic,
                key=event_id.encode("utf-8"),
                value=event_json.encode("utf-8"),
                callback=delivery_callback,
            )
            queued += 1
        except BufferError:
            logger.warning("Producer queue full for topic=%s", topic)
            enqueue_interrupted = True
            break
        except Exception:
            logger.exception(
                "Unable to enqueue topic=%s event_id=%s", topic, event_id
            )
            enqueue_interrupted = True
            break

        producer.poll(0)

    # Wait for all queued messages to receive delivery reports.
    # delivery.timeout.ms bounds delivery attempts by the Kafka client.
    while producer.flush(timeout=1.0) > 0:
        if not running:
            logger.info("Shutdown requested; waiting for in-flight deliveries")

    # Commit only successful delivery reports, to the right SQLite table.
    mark_delivered(conn, acknowledged, event_kind)

    logger.info(
        "Batch complete: stream=%s topic=%s fetched=%d queued=%d "
        "acknowledged=%d failed=%d enqueue_interrupted=%s",
        event_kind, topic, len(rows), queued, len(acknowledged),
        len(failed), enqueue_interrupted,
    )

    return (
        len(acknowledged) == len(rows)
        and not failed
        and not enqueue_interrupted
    )


def main():
    producer = Producer({
        "bootstrap.servers": KAFKA_SERVERS,
        "security.protocol": "PLAINTEXT",
        "acks": "all",
        "enable.idempotence": True,
        "delivery.timeout.ms": DELIVERY_TIMEOUT_MS,
        "client.id": "greenhouse-pi-001",
    })

    logger.info("Kafka servers: %s", KAFKA_SERVERS)
    logger.info("Sensor topic: %s", KAFKA_TOPIC)
    logger.info("Automation topic: %s", KAFKA_AUTOMATION_TOPIC)

    with closing(sqlite3.connect(DB_PATH, timeout=30)) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA synchronous = FULL")

        # Ingest.py must create both outbox tables before this service starts.
        while running:
            found_any = False
            all_success = True

            try:
                # One batch per stream per pass prevents sensor backlogs
                # from indefinitely starving automation events.
                for event_kind in OUTBOX_TABLES:
                    if not running:
                        break

                    rows = fetch_pending(conn, event_kind)
                    if not rows:
                        continue

                    found_any = True
                    success = publish_batch(producer, conn, rows, event_kind)
                    if not success:
                        all_success = False

                if not found_any:
                    producer.poll(0)
                    time.sleep(1)
                elif not all_success and running:
                    logger.warning(
                        "Incomplete batch; retrying in %s seconds", RETRY_SECONDS
                    )
                    time.sleep(RETRY_SECONDS)

            except sqlite3.Error:
                logger.exception(
                    "SQLite failure; terminating for systemd recovery"
                )
                raise

    logger.info("Kafka publisher stopped")


if __name__ == "__main__":
    main()
