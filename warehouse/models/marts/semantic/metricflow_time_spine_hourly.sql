{{ config(materialized='table') }}

-- Hourly UTC time spine for MetricFlow. Same bounds as the daily spine
-- (up to the current UTC hour).
SELECT date_hour
FROM (
    SELECT
        DATEADD(
            'hour',
            ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1,
            '2026-10-01 00:00:00'::TIMESTAMP_NTZ
        ) AS date_hour
    FROM TABLE(GENERATOR(ROWCOUNT => 87600))
)
WHERE date_hour <= DATE_TRUNC('hour', CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ)