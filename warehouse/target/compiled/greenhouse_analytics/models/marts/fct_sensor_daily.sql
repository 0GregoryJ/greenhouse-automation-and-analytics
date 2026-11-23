

WITH readings AS (
    SELECT *
    FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_intermediate.int_sensor_readings
),

daily AS (
    SELECT
        measurement_date_utc,
        gateway_id,
        sensor_id,
        measurement_type,
        IFF(
            measurement_type = 'soil_moisture',
            'percent',
            unit
        ) AS unit,

        COUNT(*) AS reading_count,

        CASE
            WHEN measurement_type = 'soil_moisture'
                THEN AVG(calibrated_moisture)
            ELSE AVG(value)
        END AS avg_value,
        CASE
            WHEN measurement_type = 'soil_moisture'
                THEN MIN(calibrated_moisture)
            ELSE MIN(value)
        END AS min_value,
        CASE
            WHEN measurement_type = 'soil_moisture'
                THEN MAX(calibrated_moisture)
            ELSE MAX(value)
        END AS max_value,
        CASE
            WHEN measurement_type = 'soil_moisture'
                THEN STDDEV_SAMP(calibrated_moisture)
            ELSE STDDEV_SAMP(value)
        END AS stddev_value,

        MIN(measured_at_utc) AS first_measured_at_utc,
        MAX(measured_at_utc) AS last_measured_at_utc

    FROM readings

    GROUP BY
        measurement_date_utc,
        gateway_id,
        sensor_id,
        measurement_type,
        IFF(
            measurement_type = 'soil_moisture',
            'percent',
            unit
        )
)

SELECT *
FROM daily