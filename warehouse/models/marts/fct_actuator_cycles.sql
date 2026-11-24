{{ config(materialized='table') }}

WITH state_events AS (
    SELECT
        event_id,
        actuator,
        cycle_id,
        observed_state,
        reason,
        temperature_c,
        soil_moisture_pct,
        CONVERT_TIMEZONE(
            'UTC',
            measured_at
        )::TIMESTAMP_NTZ AS measured_at_utc

    FROM {{ ref('stg_automation_events') }}

    WHERE event_type = 'state_changed'
      AND observed_state IS NOT NULL
      AND actuator IS NOT NULL
      AND measured_at IS NOT NULL
),

-- Completed cycles that share an explicit cycle_id (typical pump runs).
cycle_id_ons AS (
    SELECT *
    FROM state_events
    WHERE observed_state = TRUE
      AND cycle_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY actuator, cycle_id
        ORDER BY measured_at_utc ASC, event_id ASC
    ) = 1
),

cycle_id_offs AS (
    SELECT *
    FROM state_events
    WHERE observed_state = FALSE
      AND cycle_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY actuator, cycle_id
        ORDER BY measured_at_utc DESC, event_id DESC
    ) = 1
),

cycles_with_id AS (
    SELECT
        o.cycle_id,
        o.actuator,
        o.event_id AS on_event_id,
        f.event_id AS off_event_id,
        o.measured_at_utc AS started_at_utc,
        f.measured_at_utc AS ended_at_utc,
        DATEDIFF(
            'second',
            o.measured_at_utc,
            f.measured_at_utc
        ) AS duration_seconds,
        o.reason AS on_reason,
        f.reason AS off_reason,
        o.temperature_c AS on_temperature_c,
        o.soil_moisture_pct AS on_soil_moisture_pct,
        'cycle_id' AS pairing_method

    FROM cycle_id_ons AS o
    INNER JOIN cycle_id_offs AS f
        ON o.actuator = f.actuator
       AND o.cycle_id = f.cycle_id
       AND f.measured_at_utc >= o.measured_at_utc
),

-- Fans and other transitions without cycle_id: pair each ON with the next OFF.
no_cycle_events AS (
    SELECT *
    FROM state_events
    WHERE cycle_id IS NULL
),

ordered AS (
    SELECT
        *,
        LEAD(observed_state) OVER (
            PARTITION BY actuator
            ORDER BY measured_at_utc, event_id
        ) AS next_state,
        LEAD(event_id) OVER (
            PARTITION BY actuator
            ORDER BY measured_at_utc, event_id
        ) AS next_event_id,
        LEAD(measured_at_utc) OVER (
            PARTITION BY actuator
            ORDER BY measured_at_utc, event_id
        ) AS next_measured_at_utc,
        LEAD(reason) OVER (
            PARTITION BY actuator
            ORDER BY measured_at_utc, event_id
        ) AS next_reason

    FROM no_cycle_events
),

cycles_sequential AS (
    SELECT
        event_id AS cycle_id,
        actuator,
        event_id AS on_event_id,
        next_event_id AS off_event_id,
        measured_at_utc AS started_at_utc,
        next_measured_at_utc AS ended_at_utc,
        DATEDIFF(
            'second',
            measured_at_utc,
            next_measured_at_utc
        ) AS duration_seconds,
        reason AS on_reason,
        next_reason AS off_reason,
        temperature_c AS on_temperature_c,
        soil_moisture_pct AS on_soil_moisture_pct,
        'sequential_state' AS pairing_method

    FROM ordered

    WHERE observed_state = TRUE
      AND next_state = FALSE
      AND next_event_id IS NOT NULL
      AND next_measured_at_utc IS NOT NULL
)

SELECT *
FROM cycles_with_id

UNION ALL

SELECT *
FROM cycles_sequential
