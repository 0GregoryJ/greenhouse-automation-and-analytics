{{ config(materialized='table') }}

WITH rules AS (
    SELECT *
    FROM {{ ref('environmental_score_rules') }}
),

hourly_readings AS (
    SELECT
        measurement_hour_utc,
        gateway_id,
        measurement_type,
        unit,
        avg_value
    FROM {{ ref('fct_sensor_hourly') }}
),

components AS (
    SELECT
        h.measurement_hour_utc,
        h.gateway_id,
        h.measurement_type,
        r.score_version,
        r.weight,

        IFF(
            h.avg_value IS NULL
            OR h.avg_value < r.valid_min
            OR h.avg_value > r.valid_max,
            NULL,
            100.0 * GREATEST(
                0.0,
                1.0 - CASE
                    WHEN h.avg_value < r.target_min
                    THEN
                        (r.target_min - h.avg_value)
                        / NULLIF(r.tolerance_below, 0)

                    WHEN h.avg_value > r.target_max
                    THEN
                        (h.avg_value - r.target_max)
                        / NULLIF(r.tolerance_above, 0)

                    ELSE 0.0
                END
            )
        ) AS component_score

    FROM hourly_readings h

    INNER JOIN rules r
        ON h.measurement_type = r.measurement_type
       AND h.unit = r.unit
),

hourly_scores AS (
    SELECT
        measurement_hour_utc,
        gateway_id,
        score_version,

        COUNT(*) AS component_rows,
        COUNT(DISTINCT measurement_type) AS metric_count,
        COUNT(component_score) AS valid_component_count,

        ROUND(
            SUM(component_score * weight)
            / NULLIF(SUM(IFF(component_score IS NOT NULL, weight, 0)), 0),
            2
        ) AS calculated_score,

        MAX(
            IFF(measurement_type = 'air_temperature',
                component_score, NULL)
        ) AS temperature_score,

        MAX(
            IFF(measurement_type = 'relative_humidity',
                component_score, NULL)
        ) AS humidity_score,

        MAX(
            IFF(measurement_type = 'soil_moisture',
                component_score, NULL)
        ) AS soil_score

    FROM components

    GROUP BY 1, 2, 3
)

SELECT
    measurement_hour_utc,
    gateway_id,
    score_version,

    IFF(
        metric_count = 3
        AND component_rows = 3
        AND valid_component_count = 3,
        calculated_score,
        NULL
    ) AS environmental_score,

    temperature_score,
    humidity_score,
    soil_score,

    metric_count,
    valid_component_count,

    IFF(
        metric_count = 3
        AND component_rows = 3
        AND valid_component_count = 3,
        'complete',
        'incomplete'
    ) AS status

FROM hourly_scores
