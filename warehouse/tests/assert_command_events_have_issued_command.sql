{{ config(severity='warn') }}

-- Command metrics are keyed on the command_issued event. An acknowledgment or
-- failure whose command was never recorded as issued would be invisible to
-- command_acknowledged_count and command_failure_count. Warn-level because the
-- issue event can be loaded after its outcome event.
SELECT
    e.event_id,
    e.event_type,
    e.actuator,
    e.command_id

FROM {{ ref('fct_automation_events') }} AS e

LEFT JOIN {{ ref('fct_automation_commands') }} AS c
    ON e.actuator = c.actuator
   AND e.command_id = c.command_id

WHERE e.event_type IN ('command_acknowledged', 'command_failed')
  AND e.command_id IS NOT NULL
  AND c.command_id IS NULL
