{{ config(materialized='table') }}

-- Daily UTC time spine for MetricFlow (zero-filling and date-spine joins).
-- Starts before the first recorded greenhouse data and stops at the UTC build
-- date so an unfiltered query never zero-fills into the future. The bound is
-- UTC on purpose: CURRENT_DATE() would use the Snowflake session time zone and
-- could drop the newest UTC day.
SELECT date_day
FROM (
    SELECT
        DATEADD(
            'day',
            ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1,
            '2026-10-01'::DATE
        ) AS date_day
    FROM TABLE(GENERATOR(ROWCOUNT => 3650))
)
WHERE date_day <= TO_DATE(CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP()))