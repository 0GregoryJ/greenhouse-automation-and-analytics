-- Latency exists only for acknowledged commands and is never negative.
SELECT *
FROM {{ ref('fct_automation_commands') }}
WHERE (acknowledgment_latency_seconds IS NOT NULL AND NOT is_acknowledged)
   OR acknowledgment_latency_seconds < 0
