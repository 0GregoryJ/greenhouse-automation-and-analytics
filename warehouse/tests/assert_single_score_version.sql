{{ config(severity='warn') }}

-- The semantic layer averages scores across every score_version it finds.
-- If a second rule version is ever added, those averages would silently mix
-- incomparable scores; fail loudly (warn) so a version filter is added to the
-- metrics first.
SELECT COUNT(DISTINCT score_version) AS score_version_count
FROM {{ ref('fct_environmental_score_hourly') }}
HAVING COUNT(DISTINCT score_version) > 1
