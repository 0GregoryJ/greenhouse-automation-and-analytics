{{ config(materialized='table') }}

-- Hourly Pacific wall-clock spine for MetricFlow. Values are TIMESTAMP_NTZ
-- in America/Los_Angeles, matching measurement_hour_pt, and stop at the
-- current Pacific hour.
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
WHERE date_hour <= DATE_TRUNC(
    'hour',
    CONVERT_TIMEZONE('America/Los_Angeles', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ
)