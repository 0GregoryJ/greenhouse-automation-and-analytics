

WITH readings AS (
    SELECT *
    FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_intermediate.int_sensor_readings
),

-- One target/validity rule per measurement type and unit (the latest
-- score_version), so the join below can never multiply readings.
rules AS (
    SELECT
        measurement_type,
        unit,
        target_min,
        target_max,
        valid_min,
        valid_max
    FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT.environmental_score_rules
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY measurement_type, unit
        ORDER BY score_version DESC
    ) = 1
),

-- reporting_value is the value the marts publish: calibrated percent for
-- soil moisture, the raw measurement for everything else.
readings_with_rules AS (
    SELECT
        r.*,
        IFF(
            r.measurement_type = 'soil_moisture',
            'percent',
            r.unit
        ) AS reporting_unit,
        IFF(
            r.measurement_type = 'soil_moisture',
            r.calibrated_moisture,
            r.value
        ) AS reporting_value,
        ru.target_min,
        ru.target_max,
        ru.valid_min,
        ru.valid_max

    FROM readings AS r
    LEFT JOIN rules AS ru
        ON r.measurement_type = ru.measurement_type
       AND IFF(
            r.measurement_type = 'soil_moisture',
            'percent',
            r.unit
       ) = ru.unit
),

hourly AS (
    SELECT
        measurement_hour_utc,
        gateway_id,
        sensor_id,
        measurement_type,
        reporting_unit AS unit,

        COUNT(*) AS reading_count,
        AVG(reporting_value) AS avg_value,
        MIN(reporting_value) AS min_value,
        MAX(reporting_value) AS max_value,
        STDDEV_SAMP(reporting_value) AS stddev_value,

        MIN(measured_at_utc) AS first_measured_at_utc,
        MAX(measured_at_utc) AS last_measured_at_utc,

        -- Reading-level compliance counts (used by the semantic layer).
        -- They are NULL-safe: readings without a rule for their
        -- measurement type and unit, or outside the rule's valid range,
        -- are excluded from every compliance count.
        COUNT_IF(
            reporting_value BETWEEN valid_min AND valid_max
        ) AS valid_range_reading_count,

        COUNT_IF(
            reporting_value BETWEEN valid_min AND valid_max
            AND reporting_value BETWEEN target_min AND target_max
        ) AS in_target_range_reading_count,

        COUNT_IF(
            reporting_value BETWEEN valid_min AND valid_max
            AND reporting_value < target_min
        ) AS below_target_min_reading_count

    FROM readings_with_rules

    GROUP BY
        measurement_hour_utc,
        gateway_id,
        sensor_id,
        measurement_type,
        reporting_unit
)

SELECT *
FROM hourly