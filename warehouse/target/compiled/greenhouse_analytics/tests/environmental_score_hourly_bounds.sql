SELECT *
FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_marts.fct_environmental_score_hourly
WHERE
    environmental_score < 0
    OR environmental_score > 100
    OR temperature_score < 0
    OR temperature_score > 100
    OR humidity_score < 0
    OR humidity_score > 100
    OR soil_score < 0
    OR soil_score > 100