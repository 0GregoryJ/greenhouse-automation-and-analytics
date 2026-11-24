-- A completed cycle cannot end before it starts.
SELECT *
FROM {{ ref('fct_actuator_cycles') }}
WHERE duration_seconds < 0
   OR ended_at_utc < started_at_utc
