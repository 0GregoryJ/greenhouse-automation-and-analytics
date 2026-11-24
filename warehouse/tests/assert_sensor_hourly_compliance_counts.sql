-- Compliance counts must nest: in-range + below-minimum cannot exceed the
-- valid-range readings, which cannot exceed all readings. A violation would
-- mean the rule join multiplied readings or a count is mis-specified.
SELECT *
FROM {{ ref('fct_sensor_hourly') }}
WHERE valid_range_reading_count > reading_count
   OR in_target_range_reading_count + below_target_min_reading_count
        > valid_range_reading_count
   OR LEAST(
        valid_range_reading_count,
        in_target_range_reading_count,
        below_target_min_reading_count
      ) < 0
