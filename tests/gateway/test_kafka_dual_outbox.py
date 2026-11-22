"""Unit tests for the dual-outbox Kafka producer (no live broker needed)."""

import importlib.util
import os
import sqlite3
import sys
import types
from pathlib import Path

import pytest

# Load module even when confluent-kafka is not available in a local test environment.
sys.modules.setdefault("confluent_kafka", types.SimpleNamespace(Producer=object))
os.environ.setdefault("KAFKA_BOOTSTRAP_SERVERS", "broker:9092")
# Works beside the downloaded file or under tests/gateway/ in the repo.
repo_candidate = Path(__file__).resolve().parents[2] / "gateway" / "kafka_producer.py"
local_candidate = Path(__file__).resolve().with_name("kafka_producer.py")
source = repo_candidate if repo_candidate.exists() else local_candidate
spec = importlib.util.spec_from_file_location("kafka_producer_under_test", source)
producer_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer_module)


class Message:
    def __init__(self, key):
        self._key = key

    def key(self):
        return self._key


class FakeProducer:
    def __init__(self, failures=()):
        self.messages = []
        self.pending = []
        self.failures = set(failures)

    def produce(self, *, topic, key, value, callback):
        self.messages.append((topic, key, value))
        self.pending.append((topic, key, callback))

    def poll(self, timeout):
        return 0

    def flush(self, timeout):
        for topic, key, callback in self.pending:
            failure = RuntimeError("offline") if (topic, key) in self.failures else None
            callback(failure, Message(key))
        self.pending.clear()
        return 0


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:")
    for name in ("sensor_events", "automation_events"):
        conn.execute(f"""
            CREATE TABLE {name} (
                event_id TEXT PRIMARY KEY,
                event_json TEXT NOT NULL,
                received_at TEXT NOT NULL,
                kafka_published_at TEXT
            )
        """)
    conn.execute("INSERT INTO sensor_events VALUES (?, ?, ?, NULL)", ("same-id", '{"type":"sensor"}', "2026-01-01T00:00:00Z"))
    conn.execute("INSERT INTO automation_events VALUES (?, ?, ?, NULL)", ("same-id", '{"type":"automation"}', "2026-01-01T00:00:00Z"))
    conn.commit()
    yield conn
    conn.close()


def check_marked(db, table):
    return db.execute(f"SELECT kafka_published_at FROM {table} WHERE event_id='same-id'").fetchone()[0]


def test_automation_topic_and_only_automation_outbox_marked(db):
    fake = FakeProducer()
    rows = producer_module.fetch_pending(db, "automation")
    assert producer_module.publish_batch(fake, db, rows, "automation")
    assert fake.messages == [
        (producer_module.KAFKA_AUTOMATION_TOPIC, b"same-id", b'{"type":"automation"}')
    ]
    assert check_marked(db, "automation_events") is not None
    assert check_marked(db, "sensor_events") is None


def test_default_sensor_behavior_unchanged(db):
    fake = FakeProducer()
    rows = producer_module.fetch_pending(db)
    assert producer_module.publish_batch(fake, db, rows)
    assert fake.messages[0][0] == producer_module.KAFKA_TOPIC
    assert check_marked(db, "sensor_events") is not None
    assert check_marked(db, "automation_events") is None


def test_failed_kafka_delivery_remains_pending(db):
    fake = FakeProducer(failures={(producer_module.KAFKA_AUTOMATION_TOPIC, b"same-id")})
    rows = producer_module.fetch_pending(db, "automation")
    assert not producer_module.publish_batch(fake, db, rows, "automation")
    assert check_marked(db, "automation_events") is None


def test_unsupported_event_kind_rejected(db):
    with pytest.raises(ValueError):
        producer_module.fetch_pending(db, "garbage")
    with pytest.raises(ValueError):
        producer_module.kafka_topic("garbage")
