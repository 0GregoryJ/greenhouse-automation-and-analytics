<p align="center">
  <img src="docs/assets/header.png" alt="Greenhouse IoT Streaming Pipeline" width="100%">
</p>

<p align="center">
  <img alt="ESP32" src="https://img.shields.io/badge/ESP32-E7352C?style=for-the-badge&logo=espressif&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white">
  <img alt="Mosquitto" src="https://img.shields.io/badge/Mosquitto-3C5280?style=for-the-badge&logo=eclipsemosquitto&logoColor=white">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white">
  <img alt="Kafka" src="https://img.shields.io/badge/Kafka-231F20?style=for-the-badge&logo=apachekafka&logoColor=white">
  <img alt="Redis" src="https://img.shields.io/badge/Redis-FF4438?style=for-the-badge&logo=redis&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white">
  <img alt="Caddy" src="https://img.shields.io/badge/Caddy-1F88C0?style=for-the-badge&logo=caddy&logoColor=white">
  <img alt="AWS" src="docs/assets/badges/aws.svg">
  <img alt="dbt" src="docs/assets/badges/dbt.svg">
  <img alt="Tailscale" src="https://img.shields.io/badge/Tailscale-242424?style=for-the-badge&logo=tailscale&logoColor=white">
  <img alt="GitHub Actions" src="https://img.shields.io/badge/GitHub%20Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white">
</p>

# Greenhouse IoT Streaming Pipeline

An end-to-end streaming pipeline for greenhouse temperature, humidity, atmospheric pressure, and soil moisture. Sensors on an ESP32 publish readings over MQTT to a Raspberry Pi, which validates and buffers them in SQLite before forwarding them to Kafka on AWS. A live consumer keeps the latest values in Redis for a React dashboard served by FastAPI. A historical consumer archives every event to S3; tested dbt models in Snowflake power analytics for raw readings and a calcutated conditions score, and summarize by hour and day.

**Live:** [Dashboard](https://greenhouse.gregoryjoshua.com) · [API health](https://api.gregoryjoshua.com/health)

## Architecture

```mermaid
flowchart LR
  sensors["BME280 + soil sensor"] --> esp["ESP32<br/>MicroPython"]

  subgraph pi["Raspberry Pi"]
    mqtt["Mosquitto"] --> ingest["Ingest<br/>schema validation"]
    ingest --> sqlite[("SQLite outbox")]
    sqlite --> prod["Kafka producer"]
  end

  subgraph aws["AWS EC2"]
    kafka["Kafka"]
    consumer["Live consumer"] --> redis[("Redis")]
    redis --> api["FastAPI + Caddy"]
    hist["Historical consumer"] --> s3[("S3<br/>JSON Lines, gzip")]
  end

  snow[("Snowflake")]
  dbt["dbt marts<br/>incl. env. score"]
  cfg["config/environmental_score.v1.json"]
  dash["React dashboard"]

  esp -->|"MQTT QoS 1"| mqtt
  prod -->|"Tailscale"| kafka
  kafka -->|"Tailscale"| consumer
  kafka -->|"Tailscale"| hist
  s3 --> snow
  snow --> dbt
  dbt --> api
  cfg --> api
  cfg --> dbt
  redis -->|"live score"| api
  dash -->|"HTTPS · live, history, score"| api

  ingest -.-> dlq[("Rejected events")]
  kafka -.-> flink["Flink rolling metrics"]

  classDef planned fill:#fff,stroke:#999,stroke-dasharray:5 5,color:#777;
  class dlq,flink planned;
```

Solid boxes are implemented. Dashed boxes are on the [roadmap](#roadmap). Details: [Architecture](docs/architecture.md).

## Data flow

1. The ESP32 reads the sensors and publishes one JSON event per measurement over MQTT (QoS 1) to Mosquitto on the Pi.
2. The Pi validates each event against its schema version, commits it to SQLite, and only then acknowledges the MQTT message.
3. A producer sends pending rows to Kafka and marks a row delivered only after Kafka acknowledges it.
4. The live consumer updates the latest reading per sensor and measurement in Redis, committing its Kafka offset after the write.
5. The historical consumer, in its own consumer group, batches events into gzip-compressed JSON Lines objects in S3 and commits only after the upload succeeds.
6. A Snowflake task loads new S3 objects into `RAW.SENSOR_EVENTS`. dbt builds staging, intermediate, and mart models (including environmental scores) with `event_id` deduplication.
7. FastAPI serves live readings and the live conditions score from Redis, plus historical sensor series and score history from Snowflake marts. The React dashboard shows Live and History views.

Delivery is at-least-once, with deduplication by `event_id`.

## Analytics

### Environmental Conditions Score

The primary analytics product is a versioned, rules-based **0–100** suitability score (`conditions-v1`) from air temperature, relative humidity, and soil moisture. It measures alignment with configured growing-environment targets — **not** verified plant health.

| Path | Computation |
| --- | --- |
| Live | FastAPI scores the latest Redis readings for a gateway (`GET /api/v1/environment/score/current`) |
| Historical | dbt hourly/daily score marts in Snowflake; FastAPI reads them (`GET /api/v1/environment/score/history`) |

Shared rules live in [`config/environmental_score.v1.json`](config/environmental_score.v1.json) and feed both the Python scorer and the dbt seed. The Live dashboard leads with the score; History charts score trends (or individual sensors).

Methodology: [Environmental Conditions Score](docs/environmental-conditions-score.md) · Warehouse bootstrap: [Snowflake setup](docs/snowflake-setup.md) · API shapes: [API reference](docs/api.md)

### Historical sensor series

Hourly and daily aggregates for each sensor and measurement (`GET /api/v1/history/series`, periods `24h` / `7d` / `30d`). The History tab plots averages with min–max bands and weighted period summaries from warehouse marts. Loads and dbt runs are scheduled; charts can lag live data.

### Live readings

`GET /api/v1/sensors/latest` from Redis. The Live tab polls every 3 seconds and marks readings older than 30 seconds as stale. Individual cards stay available even if the score endpoint is incomplete or down.

## What this demonstrates

- **Durable edge buffering.** SQLite outbox with acknowledge-after-commit ingestion through Kafka and network outages.
- **Delivery semantics.** Persistent MQTT QoS 1, idempotent Kafka producer, manual offset commits, Redis timestamp guard.
- **Versioned data contracts.** JSON Schema v1 and v2 at the gateway.
- **Replayable streaming.** Dual Kafka consumer groups: live Redis view and durable S3 archive.
- **Warehouse analytics.** S3 → Snowflake task → dbt marts → FastAPI, including the Environmental Conditions Score.
- **Operations and CI/CD.** systemd, Compose, pytest, dashboard lint/test/build, Tailscale/SSH deploys on `main`, scheduled dbt.
- **Decision records.** [ADRs](docs/decisions/README.md) for the main design choices.

## Roadmap

- **Reliability.** Rejected-event / DLQ path; historical consumer quarantine for bad Kafka messages; gateway input hardening.
- **Security.** TLS for MQTT and Kafka; tighter MQTT ACLs.
- **Observability.** External alerting, consumer-lag metrics, end-to-end synthetic probe.
- **Score and sensors.** Calibrate soil moisture and crop-specific profiles (bump `score_version`); optional new measurement types (e.g. light, CO₂).
- **Infrastructure as code.** Terraform for hosts/DNS; deploy verification and rollback in CI.

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Components, event flow, data stores, delivery guarantees |
| [API reference](docs/api.md) | Live, history, and environmental-score endpoints |
| [Environmental Conditions Score](docs/environmental-conditions-score.md) | Scoring methodology, inputs, limitations |
| [Snowflake setup](docs/snowflake-setup.md) | Warehouse bootstrap, S3 load task, roles, JWT users |
| [Data contracts](docs/data-contracts.md) | Schemas, validation points, safe schema evolution |
| [Adding a sensor](docs/adding-a-sensor.md) | Step-by-step guide and checklist |
| [Deployment](docs/deployment.md) | CI/CD, setup, updates, verification, and rollback |
| [Operations](docs/operations.md) | Health checks, logs, troubleshooting |
| [Decision records](docs/decisions/README.md) | ADRs for the main design choices |
| [ESP32 firmware](firmware/esp32/README.md) | Hardware, MicroPython flashing, wiring, configuration |
| [Infrastructure](infrastructure/README.md) | Component-level infrastructure notes |
| [Warehouse (dbt)](warehouse/README.md) | Staging, intermediate, score marts, seed generation |

Configuration templates: [`.env.example`](.env.example), [`firmware/esp32/config.example.py`](firmware/esp32/config.example.py). Schemas: [`schemas/`](schemas/).

## Repository layout

```text
firmware/esp32/      MicroPython sensor firmware
sensor_simulator/    Synthetic MQTT event generator
gateway/             Raspberry Pi ingest, producer, cleanup, health, migrations
schemas/             Versioned event schemas and examples
consumers/live/      Kafka to Redis consumer
consumers/historical/ Kafka to S3 archive consumer
api/                 FastAPI service (live Redis + Snowflake history/scores)
config/              Versioned environmental score rules (JSON)
warehouse/           dbt project (staging, intermediate, marts, score seed)
dashboard/           React / Vite dashboard (Live + History tabs)
infrastructure/      systemd, Mosquitto, Kafka, Caddy config and scripts
tests/               pytest suites (schemas, gateway, consumer, API)
.github/workflows/   CI and deployment workflow
requirements/        Dependencies per deployment role
compose.yaml         Consumers, Redis, and API containers
docs/                Architecture, API, scoring, Snowflake, operations (+ assets/)
```
