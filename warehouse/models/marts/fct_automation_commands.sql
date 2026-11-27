{{ config(materialized='table') }}

-- One row per actuator command issued by the controller, with the outcome
-- events (acknowledgment, explicit failure) collapsed onto it. This keeps
-- the acknowledgment rate a cohort measure (of the commands issued in a
-- period, how many were acknowledged) and prevents duplicate
-- acknowledgments or failure events from inflating counts.

WITH command_events AS (
    SELECT
        event_id,
        command_id,
        actuator,
        event_type,
        desired_state,
        reason,
        cycle_id,
        measured_at_utc

    FROM {{ ref('fct_automation_events') }}

    WHERE command_id IS NOT NULL
),

issued AS (
    SELECT
        command_id,
        actuator,
        event_id AS issued_event_id,
        measured_at_utc AS issued_at_utc,
        desired_state,
        reason,
        cycle_id

    FROM command_events

    WHERE event_type = 'command_issued'

    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY actuator, command_id
        ORDER BY measured_at_utc ASC, event_id ASC
    ) = 1
),

acknowledgments AS (
    SELECT
        actuator,
        command_id,
        MIN(measured_at_utc) AS first_acknowledged_at_utc

    FROM command_events

    WHERE event_type = 'command_acknowledged'

    GROUP BY actuator, command_id
),

failures AS (
    SELECT
        actuator,
        command_id,
        MIN(measured_at_utc) AS first_failed_at_utc,
        MIN_BY(reason, measured_at_utc) AS failure_reason

    FROM command_events

    WHERE event_type = 'command_failed'

    GROUP BY actuator, command_id
)

SELECT
    i.command_id,
    i.actuator,
    i.issued_event_id,
    i.issued_at_utc,
    CONVERT_TIMEZONE('UTC', 'America/Los_Angeles', i.issued_at_utc) AS issued_at_pt,
    TO_DATE(i.issued_at_utc) AS issued_date_utc,
    TO_DATE(CONVERT_TIMEZONE('UTC', 'America/Los_Angeles', i.issued_at_utc)) AS issued_date_pt,
    i.desired_state,
    i.reason,
    i.cycle_id,

    a.command_id IS NOT NULL AS is_acknowledged,
    a.first_acknowledged_at_utc,
    IFF(
        a.first_acknowledged_at_utc >= i.issued_at_utc,
        DATEDIFF(
            'millisecond',
            i.issued_at_utc,
            a.first_acknowledged_at_utc
        ) / 1000.0,
        NULL
    ) AS acknowledgment_latency_seconds,

    f.command_id IS NOT NULL AS is_failed,
    f.first_failed_at_utc,
    f.failure_reason,

    -- The controller emits command_failed with this reason when no RPC
    -- response arrived in time. The relay may still have switched.
    COALESCE(f.failure_reason = 'rpc_timeout_outcome_unknown', FALSE)
        AS is_timeout_outcome_unknown

FROM issued AS i

LEFT JOIN acknowledgments AS a
    ON i.actuator = a.actuator
   AND i.command_id = a.command_id

LEFT JOIN failures AS f
    ON i.actuator = f.actuator
   AND i.command_id = f.command_id
