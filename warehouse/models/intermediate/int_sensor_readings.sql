{{ config(materialized='view') }}

WITH staged AS (
    SELECT *
    FROM {{ ref('stg_sensor_events') }}
),

validated AS (
    SELECT
        event_id,
        schema_version,
        gateway_id,
        sensor_id,

        measured_at,

        CONVERT_TIMEZONE(
            'UTC',
            measured_at
        )::TIMESTAMP_NTZ AS measured_at_utc,

        measurement_type,
        value,
        unit,

        kafka_topic,
        kafka_partition,
        kafka_offset,
        source_file,
        source_file_row,
        loaded_at

    FROM staged

    WHERE event_id IS NOT NULL
      AND gateway_id IS NOT NULL
      AND sensor_id IS NOT NULL
      AND measured_at IS NOT NULL
      AND measurement_type IS NOT NULL
      AND value IS NOT NULL
      AND unit IS NOT NULL
),

including_calibrated_moisure as (
    select
        *,
        100 * AVG(
            IFF(value >= 990, 1.0, 0.0)
        ) OVER (
            PARTITION BY gateway_id, sensor_id
            ORDER BY measured_at_utc, event_id
            ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
        ) as calibrated_moisture
    from validated
),

final AS (
    SELECT
        *,

        DATE_TRUNC(
            'HOUR',
            measured_at_utc
        ) AS measurement_hour_utc,

        TO_DATE(
            measured_at_utc
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
        ) AS measurement_date_pt

    FROM including_calibrated_moisure
)

SELECT *
FROM final
