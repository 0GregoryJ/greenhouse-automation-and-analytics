{{ config(materialized='table') }}

-- Daily Pacific time spine for MetricFlow (zero-filling and date-spine joins).
-- Starts before the first recorded greenhouse data and stops at the current
-- America/Los_Angeles date so an unfiltered query never zero-fills into the
-- future. The bound is not CURRENT_DATE(): that follows the Snowflake session
-- time zone.
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
WHERE date_day <= TO_DATE(CONVERT_TIMEZONE('America/Los_Angeles', CURRENT_TIMESTAMP()))