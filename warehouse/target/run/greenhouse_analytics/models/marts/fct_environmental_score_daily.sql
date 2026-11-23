
  
    

create or replace transient table GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_marts.fct_environmental_score_daily
    
    
    
    
    

    as (

SELECT
    TO_DATE(measurement_hour_utc)
        AS measurement_date_utc,

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

FROM GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_marts.fct_environmental_score_hourly

GROUP BY 1, 2, 3
    )
;


  