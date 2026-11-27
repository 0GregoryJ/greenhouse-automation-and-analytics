{{ config(materialized='table') }}

SELECT
    TO_DATE(measurement_hour_pt)
        AS measurement_date_pt,

    gateway_id,
    score_version,

    ROUND(
        AVG(environmental_score), 2
    ) AS avg_environmental_score,

    MIN(environmental_score)
        AS min_environmental_score,

    MAX(environmental_score)
        AS max_environmental_score,

    COUNT(environmental_score)
        AS scored_hours,

    COUNT(*)
        AS hours_with_data

FROM {{ ref('fct_environmental_score_hourly') }}

GROUP BY 1, 2, 3
