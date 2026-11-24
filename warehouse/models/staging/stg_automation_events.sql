with source_events as (
    select
        EVENT:event_id::VARCHAR as event_id,
        EVENT:command_id::VARCHAR AS command_id,
        EVENT:cycle_id::VARCHAR AS cycle_id,
        
        EVENT:schema_version::INTEGER AS schema_version,
        EVENT:actuator::VARCHAR as actuator,
        EVENT:event_type::VARCHAR as event_type,
        TRY_TO_BOOLEAN(
            EVENT:desired_state::VARCHAR
        ) AS desired_state,
        TRY_TO_BOOLEAN(
            EVENT:observed_state::VARCHAR
        ) AS observed_state,
        EVENT:reason::VARCHAR as reason,
        EVENT:temperature_c::FLOAT as temperature_c,
        EVENT:soil_moisture_pct::FLOAT as soil_moisture_pct,
        TRY_TO_TIMESTAMP_TZ(EVENT:timestamp_utc::VARCHAR) AS measured_at,

        EVENT:_kafka_topic::VARCHAR AS kafka_topic,
        EVENT:_kafka_partition::INTEGER AS kafka_partition,
        EVENT:_kafka_offset::BIGINT AS kafka_offset,

        SOURCE_FILE AS source_file,
        SOURCE_FILE_ROW AS source_file_row,
        LOADED_AT AS loaded_at
    from {{ source('raw', 'automation_events') }}
),

deduplicated AS (
    SELECT *
    FROM source_events
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY event_id
        ORDER BY loaded_at DESC, source_file DESC, source_file_row DESC
    ) = 1
)

SELECT *
FROM deduplicated