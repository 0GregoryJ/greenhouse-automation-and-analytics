{{ config(severity='warn') }}

-- The semantic layer rolls fct_sensor_hourly up to days with reading-weighted
-- averages. That rollup must reproduce fct_sensor_daily, which is aggregated
-- straight from the readings; otherwise a reading was dropped or counted
-- twice. Warn-level because the two tables are built a few seconds apart and
-- a late-arriving event can land between them.
WITH hourly_rolled_up AS (
    SELECT
        TO_DATE(measurement_hour_utc) AS measurement_date_utc,
        gateway_id,
        sensor_id,
        measurement_type,
        unit,
        SUM(reading_count) AS reading_count,
        SUM(avg_value * reading_count)
            / NULLIF(SUM(reading_count), 0) AS avg_value,
        MIN(min_value) AS min_value,
        MAX(max_value) AS max_value

    FROM {{ ref('fct_sensor_hourly') }}

    GROUP BY 1, 2, 3, 4, 5
)

SELECT
    COALESCE(h.measurement_date_utc, d.measurement_date_utc)
        AS measurement_date_utc,
    COALESCE(h.measurement_type, d.measurement_type) AS measurement_type,
    h.reading_count AS hourly_reading_count,
    d.reading_count AS daily_reading_count,
    h.avg_value AS hourly_weighted_avg,
    d.avg_value AS daily_avg

FROM hourly_rolled_up AS h

FULL OUTER JOIN {{ ref('fct_sensor_daily') }} AS d
    ON h.measurement_date_utc = d.measurement_date_utc
   AND h.gateway_id = d.gateway_id
   AND h.sensor_id = d.sensor_id
   AND h.measurement_type = d.measurement_type
   AND h.unit = d.unit

WHERE h.reading_count IS DISTINCT FROM d.reading_count
   OR ABS(h.avg_value - d.avg_value) > 1e-6
   OR ABS(h.min_value - d.min_value) > 1e-6
   OR ABS(h.max_value - d.max_value) > 1e-6
