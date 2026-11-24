import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  chartXAxisInterval,
  formatChartTick,
  formatChartTooltipTime,
  formatValue,
} from "../../lib/format.js";
import { formatDurationSeconds } from "../../lib/automationCycles.js";
import { formatActuatorLabel } from "../../lib/automationDisplay.js";
import { metricInfo } from "../../lib/metrics.js";

function AutomationTooltip({ active, payload, resolution, unit, actuator }) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  if (!row || row.missing) {
    return (
      <div className="chart-tooltip">
        <p className="chart-tooltip-time">
          {row?.timestamp
            ? formatChartTooltipTime(row.timestamp, resolution)
            : "Unknown"}
        </p>
        <p className="chart-tooltip-empty">No readings in this interval</p>
      </div>
    );
  }

  const avg = formatValue({ value: row.avg, unit: unit ?? row.unit });

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-time">
        {formatChartTooltipTime(row.timestamp, resolution)}
      </p>
      <dl className="chart-tooltip-stats">
        <div>
          <dt>Average</dt>
          <dd>
            {avg.number}
            {avg.suffix ? ` ${avg.suffix}` : ""}
          </dd>
        </div>
        <div>
          <dt>Actuator</dt>
          <dd>{formatActuatorLabel(actuator)}</dd>
        </div>
      </dl>
    </div>
  );
}

function toEpoch(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function AutomationHistoryChart({
  data,
  cycles,
  resolution,
  period,
  unit,
  measurementType,
  actuator,
  status,
}) {
  const label = metricInfo(measurementType).label;
  const actuatorLabel = formatActuatorLabel(actuator);
  const rows = useMemo(
    () =>
      (data ?? [])
        .map((row) => {
          const t = toEpoch(row.timestamp);
          if (t == null) return null;
          return { ...row, t };
        })
        .filter(Boolean),
    [data]
  );
  const present = rows.filter((row) => !row.missing && row.avg != null);
  const tickEvery = chartXAxisInterval(period, resolution);

  const cycleMarkers = useMemo(
    () =>
      (cycles ?? [])
        .map((cycle) => {
          const t = toEpoch(cycle.started_at);
          if (t == null) return null;
          return { ...cycle, t };
        })
        .filter(Boolean),
    [cycles]
  );

  if (status === "loading") {
    return (
      <div className="chart-shell chart-shell-loading" aria-busy="true">
        <div className="chart-skeleton" />
        <p>Loading automation history…</p>
      </div>
    );
  }

  if (status === "error") {
    return null;
  }

  if (present.length === 0 && cycleMarkers.length === 0) {
    return (
      <div className="chart-shell chart-shell-empty">
        <p>No automation history for this selection.</p>
        <p className="muted">
          Try another period, or confirm the gateway reported during the window.
        </p>
      </div>
    );
  }

  const domain = (() => {
    const values = [
      ...present.map((row) => row.t),
      ...cycleMarkers.map((cycle) => cycle.t),
    ];
    if (values.length === 0) return ["auto", "auto"];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max((max - min) * 0.02, 60_000);
    return [min - pad, max + pad];
  })();

  return (
    <div className="chart-shell">
      <div className="chart-head">
        <h3 className="section-heading">
          {label} with {actuatorLabel.toLowerCase()} runs
        </h3>
        <p className="chart-legend">
          <span className="legend-swatch legend-avg" /> {label}
          <span className="legend-swatch legend-cycle" /> {actuatorLabel} run
        </p>
      </div>

      <div
        className="chart-frame"
        role="img"
        aria-label={`${label} with ${actuatorLabel} cycle markers`}
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
              dataKey="t"
              type="number"
              domain={domain}
              tickFormatter={(value) =>
                formatChartTick(new Date(value).toISOString(), resolution, period)
              }
              minTickGap={48}
              interval={tickEvery}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              width={56}
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => {
                const formatted = formatValue({ value, unit });
                return formatted.number;
              }}
            />
            <Tooltip
              content={
                <AutomationTooltip
                  resolution={resolution}
                  unit={unit}
                  actuator={actuator}
                />
              }
            />
            <Line
              type="monotone"
              dataKey="avg"
              stroke="var(--accent)"
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4, fill: "var(--accent)" }}
              connectNulls={false}
              isAnimationActive={false}
              name={label}
            />
            {cycleMarkers.map((cycle) => {
              const duration = formatDurationSeconds(cycle.duration_seconds);
              return (
                <ReferenceLine
                  key={cycle.cycle_id}
                  x={cycle.t}
                  stroke="var(--stale)"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={{
                    value: duration ? `${duration}` : actuatorLabel,
                    position: "insideTopRight",
                    fill: "var(--muted)",
                    fontSize: 10,
                  }}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="chart-note">
        Dashed markers show when the {actuatorLabel.toLowerCase()} ran.
        {measurementType === "soil_moisture"
          ? " The line is calibrated soil moisture."
          : " The line is air temperature."}
      </p>
    </div>
  );
}
