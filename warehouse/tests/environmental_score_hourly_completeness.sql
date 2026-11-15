SELECT *
FROM {{ ref('fct_environmental_score_hourly') }}
WHERE
    (status = 'complete' AND environmental_score IS NULL)
    OR
    (status = 'incomplete' AND environmental_score IS NOT NULL)