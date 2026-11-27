{{ config(materialized='table') }}

WITH staged AS (
    SELECT *
    FROM {{ ref('stg_automation_events') }}
),

validated AS (
    SELECT
        event_id,
        command_id,
        cycle_id,
        schema_version,
        actuator,
        event_type,
        desired_state,
        observed_state,
        reason,
        temperature_c,
        soil_moisture_pct,
        measured_at,

        CONVERT_TIMEZONE(
            'UTC',
            measured_at
        )::TIMESTAMP_NTZ AS measured_at_utc,

        DATE_TRUNC(
            'HOUR',
            CONVERT_TIMEZONE('UTC', measured_at)::TIMESTAMP_NTZ
        ) AS measurement_hour_utc,

        TO_DATE(
            CONVERT_TIMEZONE('UTC', measured_at)::TIMESTAMP_NTZ
        ) AS measurement_date_utc,

        CONVERT_TIMEZONE(
            'America/Los_Angeles',
            measured_at
        )::TIMESTAMP_NTZ AS measured_at_pt,

        DATE_TRUNC(
            'HOUR',
            CONVERT_TIMEZONE('America/Los_Angeles', measured_at)::TIMESTAMP_NTZ
        ) AS measurement_hour_pt,

        TO_DATE(
            CONVERT_TIMEZONE('America/Los_Angeles', measured_at)::TIMESTAMP_NTZ
        ) AS measurement_date_pt,

        kafka_topic,
        kafka_partition,
        kafka_offset,
        source_file,
        source_file_row,
        loaded_at

    FROM staged

    WHERE event_id IS NOT NULL
      AND actuator IS NOT NULL
      AND event_type IS NOT NULL
      AND measured_at IS NOT NULL
)

SELECT *
FROM validated
