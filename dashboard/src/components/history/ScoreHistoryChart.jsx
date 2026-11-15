import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  chartXAxisInterval,
  formatChartTick,
  formatChartTooltipTime,
} from "../../lib/format.js";
import { COMPONENT_LABELS } from "../../lib/scoreStats.js";

function ScoreTooltip({ active, payload, resolution, scoreVersion }) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  if (!row || row.missing || row.score === null || row.score === undefined) {
    return (
      <div className="chart-tooltip">
        <p className="chart-tooltip-time">
          {row?.timestamp
            ? formatChartTooltipTime(row.timestamp, resolution)
            : "Unknown"}
        </p>
        <p className="chart-tooltip-empty">No complete score for this interval</p>
      </div>
    );
  }

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-time">
        {formatChartTooltipTime(row.timestamp, resolution)}
      </p>
      <dl className="chart-tooltip-stats">
        <div>
          <dt>{resolution === "day" ? "Daily average" : "Score"}</dt>
          <dd>{Number(row.score).toFixed(1)}</dd>
        </div>
        {resolution === "day" && row.min_score != null && (
          <div>
            <dt>Min</dt>
            <dd>{Number(row.min_score).toFixed(1)}</dd>
          </div>
        )}
        {resolution === "day" && row.max_score != null && (
          <div>
            <dt>Max</dt>
            <dd>{Number(row.max_score).toFixed(1)}</dd>
          </div>
        )}
        {resolution === "day" && row.scored_hours != null && (
          <div>
            <dt>Scored hours</dt>
            <dd>
              {row.scored_hours}
              {row.hours_with_data != null
                ? ` / ${row.hours_with_data} with data`
                : ""}
            </dd>
          </div>
        )}
        {resolution === "hour" && row.temperature_score != null && (
          <div>
            <dt>{COMPONENT_LABELS.temperature_score}</dt>
            <dd>{Number(row.temperature_score).toFixed(1)}</dd>
          </div>
        )}
        {resolution === "hour" && row.humidity_score != null && (
          <div>
            <dt>{COMPONENT_LABELS.humidity_score}</dt>
            <dd>{Number(row.humidity_score).toFixed(1)}</dd>
          </div>
        )}
        {resolution === "hour" && row.soil_score != null && (
          <div>
            <dt>{COMPONENT_LABELS.soil_score}</dt>
            <dd>{Number(row.soil_score).toFixed(1)}</dd>
          </div>
        )}
        {scoreVersion && (
          <div>
            <dt>Version</dt>
            <dd>{scoreVersion}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function ScoreHistoryChart({
  data,
  resolution,
  period,
  scoreVersion,
  status,
}) {
  const rows = data ?? [];
  const present = rows.filter((row) => !row.missing);
  const tickEvery = chartXAxisInterval(period, resolution);
  const showRange = resolution === "day";

  if (status === "loading") {
    return (
      <div className="chart-shell chart-shell-loading" aria-busy="true">
        <div className="chart-skeleton" />
        <p>Loading environmental score trend…</p>
      </div>
    );
  }

  if (status === "error") {
    return null;
  }

  if (present.length === 0) {
    return (
      <div className="chart-shell chart-shell-empty">
        <p>No complete environmental scores for this selection.</p>
        <p className="muted">
          Incomplete hours stay blank — they are not plotted as zero.
        </p>
      </div>
    );
  }

  return (
    <div className="chart-shell">
      <div className="chart-head">
        <h3 className="section-heading">Environmental conditions over time</h3>
        <p className="chart-legend">
          <span className="legend-swatch legend-avg" /> Score
          {showRange && (
            <>
              <span className="legend-swatch legend-range" /> Daily min–max
            </>
          )}
        </p>
      </div>

      <div
        className="chart-frame"
        role="img"
        aria-label="Environmental conditions score trend"
      >
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
          >
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(value) =>
                formatChartTick(value, resolution, period)
              }
              minTickGap={48}
              interval={tickEvery}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              domain={[0, 100]}
              width={40}
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={
                <ScoreTooltip
                  resolution={resolution}
                  scoreVersion={scoreVersion}
                />
              }
            />
            {showRange && (
              <>
                <Area
                  type="monotone"
                  dataKey="rangeBase"
                  stackId="band"
                  stroke="none"
                  fill="transparent"
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="rangeSpan"
                  stackId="band"
                  stroke="none"
                  fill="var(--accent)"
                  fillOpacity={0.18}
                  connectNulls={false}
                  isAnimationActive={false}
                  name="Range"
                />
              </>
            )}
            <Line
              type="monotone"
              dataKey="score"
              stroke="var(--accent)"
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4, fill: "var(--accent)" }}
              connectNulls={false}
              isAnimationActive={false}
              name="Score"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="chart-note">
        Gaps are intervals without a complete score. The score measures
        environmental suitability against configured targets, not plant health.
      </p>
    </div>
  );
}
