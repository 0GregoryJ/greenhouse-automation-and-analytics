-- Each completed cycle must appear once per actuator, otherwise semantic-layer
-- cycle counts and runtimes would be inflated.
SELECT
    actuator,
    cycle_id,
    COUNT(*) AS row_count

FROM {{ ref('fct_actuator_cycles') }}

GROUP BY actuator, cycle_id
HAVING COUNT(*) > 1
