import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatAnalystNumber,
  formatAxisNumber,
  formatCell,
  formatTimeLabel,
  formatTimeTick,
  humanizeKey,
  isTimeColumn,
  prepareVisualization,
  unitForKey,
} from "../../lib/analystViz.js";

const SERIES_COLORS = [
  "var(--accent)",
  "var(--stale)",
  "var(--muted)",
  "var(--offline)",
];

const NARROW_QUERY = "(max-width: 520px)";
const HORIZONTAL_BAR_THRESHOLD = 8;

function useIsNarrow() {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(NARROW_QUERY).matches
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = (event) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return narrow;
}

function AnalystTooltip({ active, payload, label, formatX, series }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-time">{formatX(label)}</p>
      <dl className="chart-tooltip-stats">
        {series.map((item) => {
          const entry = payload.find((p) => p.dataKey === item.dataKey);
          return (
            <div key={item.dataKey}>
              <dt>{item.label}</dt>
              <dd>{formatAnalystNumber(entry?.value ?? null, item.unit)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function KpiValues({ viz }) {
  const row = viz.rows[0];
  return (
    <dl className="ai-kpis">
      {viz.series.map((item) => (
        <div key={item.dataKey} className="ai-kpi">
          <dt>{item.label}</dt>
          <dd>{formatAnalystNumber(row[item.dataKey], item.unit)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DataTable({ viz }) {
  const numericKeys = new Set(viz.series.map((item) => item.dataKey));
  const columns = viz.columns.map((key) => ({
    key,
    label: humanizeKey(key),
    unit: unitForKey(key),
    numeric: numericKeys.has(key),
    isTime: isTimeColumn(viz.rows, key),
  }));

  return (
    <div className="ai-table-wrap" tabIndex={0} role="region" aria-label={`${viz.title || "Query result"} table`}>
      <table className="ai-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className={col.numeric ? "is-numeric" : undefined}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {viz.rows.map((row, index) => (
            <tr key={index}>
              {columns.map((col) => (
                <td key={col.key} className={col.numeric ? "is-numeric" : undefined}>
                  {formatCell(row[col.key], {
                    isTime: col.isTime,
                    granularity: col.key === viz.xKey ? viz.granularity : null,
                    unit: col.unit,
                    numeric: col.numeric,
                  })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalystChart({ visualization }) {
  const narrow = useIsNarrow();
  const viz = useMemo(() => prepareVisualization(visualization), [visualization]);

  if (viz.mode === "none") {
    return (
      <p className="ai-viz-empty">
        No data was returned for this query, so there is nothing to chart.
      </p>
    );
  }

  const heading = viz.title ? <h3 className="ai-viz-title">{viz.title}</h3> : null;

  if (viz.mode === "kpi") {
    return (
      <figure className="ai-viz">
        {heading}
        <KpiValues viz={viz} />
      </figure>
    );
  }

  if (viz.mode === "table") {
    return (
      <figure className="ai-viz">
        {heading}
        <DataTable viz={viz} />
      </figure>
    );
  }

  const formatTick = viz.isTime
    ? (value) => formatTimeTick(value, viz.granularity)
    : (value) => formatCell(value);
  const formatTooltipLabel = viz.isTime
    ? (value) => formatTimeLabel(value, viz.granularity)
    : (value) => formatCell(value);

  const sharedUnit = viz.series.every((item) => item.unit === viz.series[0].unit)
    ? viz.series[0].unit
    : null;
  const showLegend = viz.series.length > 1;
  const horizontal = viz.mode === "bar" && viz.rows.length > HORIZONTAL_BAR_THRESHOLD;
  const frameStyle = horizontal
    ? { height: `${Math.min(viz.rows.length, 60) * 28 + (showLegend ? 72 : 48)}px` }
    : undefined;

  const tick = { fill: "var(--muted)", fontSize: narrow ? 10 : 11 };
  const margin = { top: 8, right: narrow ? 8 : 16, left: 0, bottom: 4 };
  const tooltip = (
    <Tooltip
      cursor={viz.mode === "bar" ? { fill: "var(--selected)", opacity: 0.5 } : { stroke: "var(--border)" }}
      content={<AnalystTooltip formatX={formatTooltipLabel} series={viz.series} />}
    />
  );
  const legend = showLegend ? (
    <Legend
      verticalAlign="top"
      height={28}
      iconType="plainline"
      wrapperStyle={{ fontSize: "0.78rem", color: "var(--muted)" }}
    />
  ) : null;
  const valueAxisProps = {
    tick,
    axisLine: false,
    tickLine: false,
    tickFormatter: formatAxisNumber,
    width: narrow ? 40 : 52,
  };
  const categoryAxisProps = {
    dataKey: viz.xKey,
    tick,
    tickFormatter: formatTick,
    axisLine: { stroke: "var(--border)" },
    tickLine: false,
  };

  const description = `${viz.title || "Query result"}: ${viz.series
    .map((item) => item.label)
    .join(", ")} by ${humanizeKey(viz.xKey)}${sharedUnit ? ` (${sharedUnit})` : ""}`;

  return (
    <figure className="ai-viz">
      {heading}
      <div
        className={horizontal ? "ai-viz-frame is-sized" : "ai-viz-frame"}
        style={frameStyle}
        role="img"
        aria-label={description}
      >
        <ResponsiveContainer width="100%" height="100%">
          {viz.mode === "line" ? (
            <LineChart data={viz.rows} margin={margin}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis {...categoryAxisProps} minTickGap={narrow ? 36 : 48} interval="preserveStartEnd" />
              <YAxis {...valueAxisProps} domain={["auto", "auto"]} />
              {tooltip}
              {legend}
              {viz.series.map((item, index) => (
                <Line
                  key={item.dataKey}
                  type="monotone"
                  dataKey={item.dataKey}
                  name={item.label}
                  stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                  strokeWidth={2.25}
                  dot={viz.rows.length <= 31 ? { r: 2.5 } : false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          ) : (
            <BarChart
              data={viz.rows}
              margin={margin}
              layout={horizontal ? "vertical" : "horizontal"}
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 3"
                horizontal={!horizontal}
                vertical={horizontal}
              />
              {horizontal ? (
                <>
                  <XAxis type="number" {...valueAxisProps} />
                  <YAxis
                    type="category"
                    {...categoryAxisProps}
                    interval={0}
                    width={narrow ? 84 : 120}
                  />
                </>
              ) : (
                <>
                  <XAxis {...categoryAxisProps} minTickGap={narrow ? 12 : 20} interval="preserveStartEnd" />
                  <YAxis {...valueAxisProps} />
                </>
              )}
              {tooltip}
              {legend}
              {viz.series.map((item, index) => (
                <Bar
                  key={item.dataKey}
                  dataKey={item.dataKey}
                  name={item.label}
                  fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                  radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                  maxBarSize={36}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {viz.isTime && viz.granularity === "hour" && (
        <figcaption className="ai-viz-note">Times shown in UTC.</figcaption>
      )}
    </figure>
  );
}
