"""Offline tests for the historical Kafka -> S3 consumer (no AWS/Kafka needed)."""
import base64
import gzip
import importlib.util
import json
import os
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

PATH = (
    Path(__file__).resolve().parents[2]
    / "consumers"
    / "historical"
    / "consumer.py"
)


class TopicPartition:
    def __init__(self, topic, partition, offset):
        self.topic, self.partition, self.offset = topic, partition, offset
        self.err = None


class KafkaException(Exception):
    pass


class FakeConsumer:
    def __init__(self, config):
        self.config = config
        self.commits = []
        self.subscriptions = []
        self.closed = False

    def subscribe(self, topics, **kwargs):
        self.subscriptions.append((topics, kwargs))

    def commit(self, offsets, asynchronous):
        assert asynchronous is False
        self.commits.append(offsets[0])
        return offsets

    def close(self):
        self.closed = True


class FakeS3:
    def __init__(self, fail=False, history=None):
        self.objects = {}
        self.fail = fail
        self.history = history

    def put_object(self, **kwargs):
        if self.fail:
            raise RuntimeError("S3 unavailable")
        self.objects[kwargs["Key"]] = kwargs
        if self.history is not None:
            self.history.append("s3")


class FakeMessage:
    def __init__(self, topic, partition, offset, event):
        self._topic = topic
        self._partition = partition
        self._offset = offset
        self._raw = event if isinstance(event, bytes) else json.dumps(event).encode()

    def topic(self):
        return self._topic

    def partition(self):
        return self._partition

    def offset(self):
        return self._offset

    def value(self):
        return self._raw

    def error(self):
        return None


@pytest.fixture
def module(monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "test-bucket")
    monkeypatch.setenv("KAFKA_TOPIC", "greenhouse.sensor-readings")
    monkeypatch.setenv("KAFKA_AUTOMATION_TOPIC", "greenhouse.automation.events.v1")
    stub = types.ModuleType("confluent_kafka")
    stub.Consumer = FakeConsumer
    stub.KafkaException = KafkaException
    stub.TopicPartition = TopicPartition
    monkeypatch.setitem(sys.modules, "confluent_kafka", stub)
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = lambda service: FakeS3()
    monkeypatch.setitem(sys.modules, "boto3", boto3_stub)
    spec = importlib.util.spec_from_file_location("historical_consumer_under_test", PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def sensor():
    return {
        "schema_version": 2, "event_id": "sensor-01", "sensor_id": "bme280",
        "gateway_id": "pi-1", "timestamp": "2026-11-21T12:00:00+00:00",
        "measurement_type": "air_temperature", "value": 21.0, "unit": "C",
    }


@pytest.fixture
def automation():
    return {
        "schema_version": 1, "event_id": "auto-01",
        "timestamp_utc": "2026-11-21T12:00:00+00:00", "actuator": "fan",
        "event_type": "state_changed", "observed_state": True,
    }


def test_parse_preserves_existing_sensor_default(module, sensor):
    assert module.parse_event(json.dumps(sensor).encode()) == sensor


def test_parse_accepts_automation_by_topic(module, automation):
    assert module.parse_event(json.dumps(automation).encode(), module.AUTOMATION_TOPIC) == automation


def test_rejects_wrong_event_type_for_topic(module, automation):
    with pytest.raises(ValueError, match="sensor_id"):
        module.parse_event(json.dumps(automation).encode(), module.SENSOR_TOPIC)


def test_rejects_unknown_topic(module, sensor):
    with pytest.raises(ValueError, match="Unexpected Kafka topic"):
        module.parse_event(json.dumps(sensor).encode(), "unknown.topic")


def test_rejects_bad_automation_id(module, automation):
    automation["event_id"] = ""
    with pytest.raises(ValueError, match="event_id"):
        module.parse_event(json.dumps(automation).encode(), module.AUTOMATION_TOPIC)


def test_both_streams_have_separate_s3_paths(module, sensor, automation):
    base = {"partition": 1, "created_at": datetime(2026, 11, 21, tzinfo=timezone.utc)}
    sensor_batch = {**base, "topic": module.SENSOR_TOPIC,
                    "records": [{"offset": 12, "event": sensor}]}
    automation_batch = {**base, "topic": module.AUTOMATION_TOPIC,
                        "records": [{"offset": 12, "event": automation}]}
    assert module.make_s3_key(sensor_batch).startswith("raw/sensor_events/")
    assert module.make_s3_key(automation_batch).startswith("raw/automation_events/")
    assert "partition=1/offsets-" in module.make_s3_key(automation_batch)


def test_upload_before_offset_commit(module, automation):
    history = []
    s3 = FakeS3(history=history)
    kafka = FakeConsumer({})
    original_commit = kafka.commit

    def commit(offsets, asynchronous):
        history.append("commit")
        return original_commit(offsets=offsets, asynchronous=asynchronous)

    kafka.commit = commit
    key = (module.AUTOMATION_TOPIC, 0)
    batches = {key: {
        "topic": key[0], "partition": 0, "started": 1,
        "created_at": datetime(2026, 11, 21, tzinfo=timezone.utc),
        "records": [{"offset": 9, "event": automation}],
    }}
    module.flush_partition(kafka, s3, batches, key)
    assert history == ["s3", "commit"]
    assert not batches
    assert kafka.commits[0].offset == 10
    obj = next(iter(s3.objects.values()))
    record = json.loads(gzip.decompress(obj["Body"]).decode().strip())
    assert record["_kafka_topic"] == module.AUTOMATION_TOPIC
    assert record["_kafka_partition"] == 0
    assert record["_kafka_offset"] == 9
    assert record["event_type"] == "state_changed"


def test_s3_failure_never_commits(module, sensor):
    kafka = FakeConsumer({})
    key = (module.SENSOR_TOPIC, 0)
    batches = {key: {
        "topic": key[0], "partition": 0,
        "created_at": datetime.now(timezone.utc),
        "records": [{"offset": 42, "event": sensor}],
    }}
    with pytest.raises(RuntimeError, match="S3 unavailable"):
        module.flush_partition(kafka, FakeS3(fail=True), batches, key)
    assert kafka.commits == []
    assert key in batches


def test_quarantine_invalid_before_commit(module):
    s3 = FakeS3()
    kafka = FakeConsumer({})
    message = FakeMessage(module.AUTOMATION_TOPIC, 2, 15, b"not-json")
    module.process_message(kafka, s3, {}, message)
    assert kafka.commits[0].offset == 16
    key = next(iter(s3.objects))
    assert key.startswith("raw/quarantine/")
    body = json.loads(s3.objects[key]["Body"])
    assert base64.b64decode(body["raw_value_base64"]) == b"not-json"


def test_quarantine_failure_never_commits(module):
    kafka = FakeConsumer({})
    message = FakeMessage(module.SENSOR_TOPIC, 0, 5, b"bad")
    with pytest.raises(RuntimeError):
        module.process_message(kafka, FakeS3(fail=True), {}, message)
    assert kafka.commits == []


def test_both_topics_in_same_consumer_group(module, monkeypatch):
    class StopAfterPollConsumer(FakeConsumer):
        instance = None

        def __init__(self, cfg):
            super().__init__(cfg)
            StopAfterPollConsumer.instance = self

        def poll(self, timeout):
            module.running = False
            return None

    monkeypatch.setattr(module, "Consumer", StopAfterPollConsumer)
    monkeypatch.setattr(module.boto3, "client", lambda service: FakeS3())
    monkeypatch.setenv("KAFKA_BOOTSTRAP_SERVERS", "broker:9092")
    module.main()
    consumer = StopAfterPollConsumer.instance
    assert consumer.config["group.id"] == "greenhouse-historical"
    assert consumer.subscriptions[0][0] == [module.SENSOR_TOPIC, module.AUTOMATION_TOPIC]
    assert consumer.closed


def test_partition_separation(module, sensor, automation):
    kafka, s3, batches = FakeConsumer({}), FakeS3(), {}
    module.BATCH_SIZE = 10
    module.process_message(kafka, s3, batches, FakeMessage(module.SENSOR_TOPIC, 0, 2, sensor))
    module.process_message(kafka, s3, batches, FakeMessage(module.AUTOMATION_TOPIC, 0, 7, automation))
    assert len(batches) == 2
    module.flush_all(kafka, s3, batches)
    assert len(s3.objects) == 2
    assert sorted(tp.offset for tp in kafka.commits) == [3, 8]
