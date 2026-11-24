# Snowflake warehouse setup

Operator runbook for the Snowflake side of historical analytics: S3 load of sensor and automation events into `RAW`, dbt transforms into marts, and JWT service users for the API and GitHub Actions.

Secrets (private keys, passphrases, account passwords) and RSA public key material are **not** stored in this repository. Register keys in Snowflake and keep PEMs only on the serving host / in CI secrets.

Related: [Warehouse (dbt)](../warehouse/README.md) · [API reference](api.md) · [Environmental Conditions Score](environmental-conditions-score.md) · [Operations](operations.md#historical-api-and-snowflake) · [ADR 0013](decisions/0013-snowflake-history-api-with-jwt-key.md)

## Object map

| Object | Purpose |
| --- | --- |
| Database `GREENHOUSE_ANALYTICS` | Analytics database |
| Warehouse `GREENHOUSE_WH` | Shared X-Small compute (`AUTO_SUSPEND = 60`) |
| Schema `RAW` | Landing zone from S3 |
| Table `RAW.SENSOR_EVENTS` | Sensor events: gzip JSON lines as `VARIANT` plus load metadata |
| Table `RAW.AUTOMATION_EVENTS` | Automation (actuator) events, same shape. The dbt source `automation_events` points here |
| Storage integration `GREENHOUSE_S3_INTEGRATION` | IAM role trust for the telemetry bucket prefix |
| Stage `RAW.GREENHOUSE_S3_STAGE` | External stage over `raw/sensor_events/` |
| Stage for `raw/automation_events/` | Second external stage with the same format (suggested name `RAW.GREENHOUSE_AUTOMATION_S3_STAGE`) |
| File format `RAW.SENSOR_JSON_FORMAT` | `TYPE = JSON`, `COMPRESSION = GZIP` |
| Task `RAW.LOAD_SENSOR_EVENTS` | Scheduled `COPY INTO` from the sensor stage |
| Task for automation events | Scheduled `COPY INTO RAW.AUTOMATION_EVENTS` (suggested name `RAW.LOAD_AUTOMATION_EVENTS`) |
| Schemas `GREENHOUSE_DBT_STAGING`, `GREENHOUSE_DBT_INTERMEDIATE`, `GREENHOUSE_DBT_MARTS` | dbt layers (plus dbt’s working schema `GREENHOUSE_DBT` for seeds/ephemeral objects in CI) |
| Role / user `GREENHOUSE_API_READER` / `GREENHOUSE_API` | Read-only mart access for FastAPI |
| Role / user `GREENHOUSE_DBT_TRANSFORMER` / `GREENHOUSE_DBT_SERVICE` | dbt builds from GitHub Actions |

S3 prefixes written by the historical consumer (bucket name matches the serving-host `S3_BUCKET`):

| Prefix | Loaded into |
| --- | --- |
| `s3://<telemetry-bucket>/raw/sensor_events/` | `RAW.SENSOR_EVENTS` |
| `s3://<telemetry-bucket>/raw/automation_events/` | `RAW.AUTOMATION_EVENTS` |
| `s3://<telemetry-bucket>/raw/quarantine/` | Not loaded. Rejected messages for manual review |

The automation objects below mirror the sensor ones; the names are suggestions, and dbt only requires the table `RAW.AUTOMATION_EVENTS` with the columns shown.

## 1. Database and warehouse

Run as a privileged role (for example `ACCOUNTADMIN` during bootstrap):

```sql
CREATE DATABASE IF NOT EXISTS GREENHOUSE_ANALYTICS;

CREATE SCHEMA IF NOT EXISTS GREENHOUSE_ANALYTICS.RAW;

CREATE WAREHOUSE IF NOT EXISTS GREENHOUSE_WH
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE
    INITIALLY_SUSPENDED = TRUE;

USE WAREHOUSE GREENHOUSE_WH;
USE DATABASE GREENHOUSE_ANALYTICS;
USE SCHEMA RAW;
```

## 2. S3 storage integration and stage

1. Create an AWS IAM role that can read the telemetry prefix (this project uses a dedicated read role for Snowflake).
2. Create the Snowflake storage integration pointing at that role and prefix.
3. `DESC INTEGRATION GREENHOUSE_S3_INTEGRATION` and finish the IAM trust with the Snowflake **AWS IAM user ARN** and **external ID** Snowflake returns.
4. Create the file format and external stage.

```sql
CREATE STORAGE INTEGRATION IF NOT EXISTS GREENHOUSE_S3_INTEGRATION
    TYPE = EXTERNAL_STAGE
    STORAGE_PROVIDER = 'S3'
    ENABLED = TRUE
    STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::<account-id>:role/<SnowflakeS3ReadRole>'
    STORAGE_ALLOWED_LOCATIONS = (
        's3://<telemetry-bucket>/raw/sensor_events/',
        's3://<telemetry-bucket>/raw/automation_events/'
    );

DESC INTEGRATION GREENHOUSE_S3_INTEGRATION;

CREATE FILE FORMAT IF NOT EXISTS SENSOR_JSON_FORMAT
    TYPE = JSON
    COMPRESSION = GZIP;

CREATE STAGE IF NOT EXISTS GREENHOUSE_S3_STAGE
    URL = 's3://<telemetry-bucket>/raw/sensor_events/'
    STORAGE_INTEGRATION = GREENHOUSE_S3_INTEGRATION
    FILE_FORMAT = SENSOR_JSON_FORMAT;

CREATE STAGE IF NOT EXISTS GREENHOUSE_AUTOMATION_S3_STAGE
    URL = 's3://<telemetry-bucket>/raw/automation_events/'
    STORAGE_INTEGRATION = GREENHOUSE_S3_INTEGRATION
    FILE_FORMAT = SENSOR_JSON_FORMAT;
```

Widen the IAM role's read policy to include `raw/automation_events/*`. If the integration already existed, `ALTER STORAGE INTEGRATION GREENHOUSE_S3_INTEGRATION SET STORAGE_ALLOWED_LOCATIONS = (…)` with both prefixes.

## 3. Raw table and load task

```sql
CREATE TABLE IF NOT EXISTS GREENHOUSE_ANALYTICS.RAW.SENSOR_EVENTS (
    EVENT VARIANT,
    SOURCE_FILE VARCHAR,
    SOURCE_FILE_ROW NUMBER,
    LOADED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);
```

Initial load (and the same `COPY` shape used by the task):

```sql
COPY INTO GREENHOUSE_ANALYTICS.RAW.SENSOR_EVENTS
    (EVENT, SOURCE_FILE, SOURCE_FILE_ROW)
FROM (
    SELECT
        $1,
        METADATA$FILENAME,
        METADATA$FILE_ROW_NUMBER
    FROM @GREENHOUSE_S3_STAGE
)
FILE_FORMAT = (FORMAT_NAME = SENSOR_JSON_FORMAT)
ON_ERROR = 'ABORT_STATEMENT';
```

Automated loads run on a Snowflake task. Production schedule is four times daily UTC so loads finish before the scheduled dbt job:

```sql
CREATE TASK IF NOT EXISTS GREENHOUSE_ANALYTICS.RAW.LOAD_SENSOR_EVENTS
    WAREHOUSE = GREENHOUSE_WH
    SCHEDULE = 'USING CRON 0 0,6,12,18 * * * UTC'
AS
COPY INTO GREENHOUSE_ANALYTICS.RAW.SENSOR_EVENTS
    (EVENT, SOURCE_FILE, SOURCE_FILE_ROW)
FROM (
    SELECT
        $1,
        METADATA$FILENAME,
        METADATA$FILE_ROW_NUMBER
    FROM @GREENHOUSE_ANALYTICS.RAW.GREENHOUSE_S3_STAGE
)
FILE_FORMAT = (
    FORMAT_NAME = GREENHOUSE_ANALYTICS.RAW.SENSOR_JSON_FORMAT
)
ON_ERROR = 'ABORT_STATEMENT';

ALTER TASK GREENHOUSE_ANALYTICS.RAW.LOAD_SENSOR_EVENTS RESUME;
```

Automation events use the same pattern: a second table, stage, and task on the same schedule.

```sql
CREATE TABLE IF NOT EXISTS GREENHOUSE_ANALYTICS.RAW.AUTOMATION_EVENTS (
    EVENT VARIANT,
    SOURCE_FILE VARCHAR,
    SOURCE_FILE_ROW NUMBER,
    LOADED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE TASK IF NOT EXISTS GREENHOUSE_ANALYTICS.RAW.LOAD_AUTOMATION_EVENTS
    WAREHOUSE = GREENHOUSE_WH
    SCHEDULE = 'USING CRON 0 0,6,12,18 * * * UTC'
AS
COPY INTO GREENHOUSE_ANALYTICS.RAW.AUTOMATION_EVENTS
    (EVENT, SOURCE_FILE, SOURCE_FILE_ROW)
FROM (
    SELECT
        $1,
        METADATA$FILENAME,
        METADATA$FILE_ROW_NUMBER
    FROM @GREENHOUSE_ANALYTICS.RAW.GREENHOUSE_AUTOMATION_S3_STAGE
)
FILE_FORMAT = (
    FORMAT_NAME = GREENHOUSE_ANALYTICS.RAW.SENSOR_JSON_FORMAT
)
ON_ERROR = 'ABORT_STATEMENT';

ALTER TASK GREENHOUSE_ANALYTICS.RAW.LOAD_AUTOMATION_EVENTS RESUME;
```

To change a schedule later: `SUSPEND` the task, `ALTER TASK … SET SCHEDULE = …`, then `RESUME`.

Snowflake stages skip already-loaded files for the same path by default; reprocessing needs a force option or path change.

## 4. dbt schemas and transformer role

Create the dbt layer schemas (or let the first successful `dbt build` create them if `CREATE SCHEMA` is granted), then grant the transformer role.

```sql
USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS GREENHOUSE_DBT_TRANSFORMER;

GRANT USAGE ON WAREHOUSE GREENHOUSE_WH
    TO ROLE GREENHOUSE_DBT_TRANSFORMER;

GRANT USAGE ON DATABASE GREENHOUSE_ANALYTICS
    TO ROLE GREENHOUSE_DBT_TRANSFORMER;

GRANT USAGE ON SCHEMA GREENHOUSE_ANALYTICS.RAW
    TO ROLE GREENHOUSE_DBT_TRANSFORMER;

GRANT SELECT ON TABLE GREENHOUSE_ANALYTICS.RAW.SENSOR_EVENTS
    TO ROLE GREENHOUSE_DBT_TRANSFORMER;

GRANT SELECT ON TABLE GREENHOUSE_ANALYTICS.RAW.AUTOMATION_EVENTS
    TO ROLE GREENHOUSE_DBT_TRANSFORMER;

GRANT CREATE SCHEMA ON DATABASE GREENHOUSE_ANALYTICS
    TO ROLE GREENHOUSE_DBT_TRANSFORMER;
```

Per-schema grants used in this project:

| Schema | Grants to `GREENHOUSE_DBT_TRANSFORMER` |
| --- | --- |
| `GREENHOUSE_DBT_STAGING` | `USAGE`, `CREATE VIEW` (and ownership of staging views as needed) |
| `GREENHOUSE_DBT_INTERMEDIATE` | `USAGE`, `CREATE VIEW` |
| `GREENHOUSE_DBT_MARTS` | `USAGE`, `CREATE TABLE` (ownership of mart tables as needed) |

Service user for CI:

```sql
CREATE USER IF NOT EXISTS GREENHOUSE_DBT_SERVICE
    TYPE = SERVICE
    DEFAULT_ROLE = GREENHOUSE_DBT_TRANSFORMER
    DEFAULT_WAREHOUSE = GREENHOUSE_WH
    DEFAULT_NAMESPACE = 'GREENHOUSE_ANALYTICS.GREENHOUSE_DBT';

GRANT ROLE GREENHOUSE_DBT_TRANSFORMER
    TO USER GREENHOUSE_DBT_SERVICE;

-- Register the dbt CI public key (paste the key material in Snowflake only):
-- ALTER USER GREENHOUSE_DBT_SERVICE SET RSA_PUBLIC_KEY = '<public-key-without-pem-headers>';
```

GitHub Actions job `dbt` authenticates as this user (`SNOWFLAKE_DBT_*` secrets/vars), regenerates `environmental_score_rules`, and runs `dbt build --target prod`. Profile schema in CI is `GREENHOUSE_DBT`; marts are built into `GREENHOUSE_DBT_MARTS` per the dbt project layout.

After adding new marts (for example environmental score or actuator-cycle tables), ensure the transformer role owns or can replace them, and that the API reader can `SELECT` them (future grants below cover new tables).

## 5. API reader role and user

FastAPI queries marts only (never `RAW`) with JWT key-pair auth.

```sql
USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS GREENHOUSE_API_READER;

GRANT USAGE ON WAREHOUSE GREENHOUSE_WH
    TO ROLE GREENHOUSE_API_READER;

GRANT USAGE ON DATABASE GREENHOUSE_ANALYTICS
    TO ROLE GREENHOUSE_API_READER;

GRANT USAGE ON SCHEMA GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS
    TO ROLE GREENHOUSE_API_READER;

GRANT SELECT ON ALL TABLES IN SCHEMA
    GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS
    TO ROLE GREENHOUSE_API_READER;

GRANT SELECT ON FUTURE TABLES IN SCHEMA
    GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS
    TO ROLE GREENHOUSE_API_READER;

-- Intermediate views used by automation analytics (int_sensor_readings)
GRANT USAGE ON SCHEMA GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_INTERMEDIATE
    TO ROLE GREENHOUSE_API_READER;

GRANT SELECT ON ALL VIEWS IN SCHEMA
    GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_INTERMEDIATE
    TO ROLE GREENHOUSE_API_READER;

GRANT SELECT ON FUTURE VIEWS IN SCHEMA
    GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_INTERMEDIATE
    TO ROLE GREENHOUSE_API_READER;

CREATE USER IF NOT EXISTS GREENHOUSE_API
    TYPE = SERVICE
    DEFAULT_ROLE = GREENHOUSE_API_READER
    DEFAULT_WAREHOUSE = GREENHOUSE_WH
    DEFAULT_NAMESPACE = 'GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS';

GRANT ROLE GREENHOUSE_API_READER TO USER GREENHOUSE_API;

-- Register the API host public key in Snowflake only:
-- ALTER USER GREENHOUSE_API SET RSA_PUBLIC_KEY = '<public-key-without-pem-headers>';

SELECT CURRENT_ORGANIZATION_NAME(), CURRENT_ACCOUNT_NAME();
```

Tables/views the API reads today ([`api/repositories/snowflake.py`](../api/repositories/snowflake.py)):

- `FCT_SENSOR_HOURLY`, `FCT_SENSOR_DAILY`
- `FCT_ENVIRONMENTAL_SCORE_HOURLY`, `FCT_ENVIRONMENTAL_SCORE_DAILY`
- `FCT_ACTUATOR_CYCLES`
- `GREENHOUSE_DBT_INTERMEDIATE.INT_SENSOR_READINGS` (automation overlay chart)

`SELECT ON FUTURE TABLES` / `FUTURE VIEWS` covers new models after `dbt build` without re-running grants.

## 6. Serving host and CI wiring

**API container (serving EC2)** — from [`.env.example`](../.env.example):

| Variable | Typical value |
| --- | --- |
| `SNOWFLAKE_ACCOUNT` | `org-account` from `SELECT CURRENT_ORGANIZATION_NAME(), CURRENT_ACCOUNT_NAME()` |
| `SNOWFLAKE_USER` | `GREENHOUSE_API` |
| `SNOWFLAKE_ROLE` | `GREENHOUSE_API_READER` |
| `SNOWFLAKE_WAREHOUSE` | `GREENHOUSE_WH` |
| `SNOWFLAKE_DATABASE` | `GREENHOUSE_ANALYTICS` |
| `SNOWFLAKE_SCHEMA` | `GREENHOUSE_DBT_MARTS` |
| `SNOWFLAKE_KEY_HOST_PATH` | Host path to the API private key PEM |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | Key passphrase |

Compose mounts the PEM at `/run/secrets/snowflake_api_key.pem`. The API image also includes [`config/`](../config/) for live scoring.

**dbt CI** — secrets/vars: `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_DBT_USER` (`GREENHOUSE_DBT_SERVICE`), `SNOWFLAKE_DBT_ROLE` (`GREENHOUSE_DBT_TRANSFORMER`), `SNOWFLAKE_DBT_PRIVATE_KEY`, `SNOWFLAKE_DBT_KEY_PASSPHRASE`.

## 7. Verification

```sql
-- Task running?
SHOW TASKS IN SCHEMA GREENHOUSE_ANALYTICS.RAW;

-- Recent loads
SELECT COUNT(*), MAX(LOADED_AT)
FROM GREENHOUSE_ANALYTICS.RAW.SENSOR_EVENTS;

SELECT COUNT(*), MAX(LOADED_AT)
FROM GREENHOUSE_ANALYTICS.RAW.AUTOMATION_EVENTS;

-- Marts visible to the API role (run as GREENHOUSE_API_READER)
SHOW TABLES IN SCHEMA GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_MARTS;
```

```bash
# On the serving host
curl -s http://127.0.0.1:8000/health
curl -s "http://127.0.0.1:8000/api/v1/history/series?sensor_id=bme280-001&measurement_type=air_temperature&period=24h"
curl -s "http://127.0.0.1:8000/api/v1/environment/score/history?gateway_id=pi-001&period=24h"
curl -s "http://127.0.0.1:8000/api/v1/history/automations?gateway_id=pi-001&actuator=pump&period=24h"
```

`/health` does not check Snowflake. History, score-history, and automation-history return HTTP 503 if JWT auth, grants, or marts are wrong; live Redis endpoints can still be healthy.

## 8. Operational notes

- **Load vs dbt timing.** The `COPY` tasks run at `00:00`, `06:00`, `12:00`, and `18:00` UTC. Schedule or trigger `dbt build` after a successful load when you need fresh marts.
- **Key rotation.** Generate a new key pair, `ALTER USER … SET RSA_PUBLIC_KEY`, update the PEM on the host or in GitHub secrets, then recreate/restart the API or re-run CI. Do not commit key material.
- **Score rules.** Change [`config/environmental_score.v1.json`](../config/environmental_score.v1.json), regenerate the seed (`python warehouse/scripts/generate_score_seed.py`), bump `version` when semantics change (the current version is `conditions-v2`, with soil moisture in calibrated `percent`), and `dbt build`.
- **Bootstrap ownership.** Early `GRANT OWNERSHIP` statements on specific views/tables are one-time bootstrap aids after the first dbt run; day-to-day replaces are done by the transformer role.
