import { formatAge, formatChartTooltipTime, PERIOD_LABELS } from "../../lib/format.js";

function formatScore(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  return Number(value).toFixed(1);
}

export function ScoreHistorySummary({
  summary,
  period,
  resolution,
  scoreVersion,
  now,
}) {
  const countLabel =
    resolution === "day"
      ? "Scored hours"
      : "Valid scored hours";

  const countHint =
    resolution === "day"
      ? `${summary.daysWithScore ?? 0} days with scores · weighted by scored hours`
      : `of ${summary.intervalCount} hourly intervals · unweighted mean of valid hours`;

  const cards = [
    {
      key: "avg",
      label: "Period average",
      hint:
        resolution === "day"
          ? "Weighted by scored_hours"
          : "Mean of valid hourly scores",
      value: summary.average,
    },
    {
      key: "min",
      label: "Lowest",
      hint: resolution === "day" ? "Daily min across period" : "Lowest hourly score",
      value: summary.min,
    },
    {
      key: "max",
      label: "Highest",
      hint: resolution === "day" ? "Daily max across period" : "Highest hourly score",
      value: summary.max,
    },
    {
      key: "count",
      label: countLabel,
      hint: countHint,
      value: summary.validCount,
      raw: true,
    },
  ];

  const latestLabel = summary.latestTimestamp
    ? formatChartTooltipTime(summary.latestTimestamp, resolution)
    : null;
  const latestAge = summary.latestTimestamp
    ? formatAge(Math.max(0, now - new Date(summary.latestTimestamp).getTime()))
    : null;

  return (
    <div className="history-summary">
      <div className="summary-grid">
        {cards.map((card) => (
          <article className="summary-card" key={card.key}>
            <h3>{card.label}</h3>
            <p className="value">
              <span className="number summary-number">
                {card.raw
                  ? Number(card.value ?? 0).toLocaleString()
                  : formatScore(card.value)}
              </span>
            </p>
            <p className="summary-hint">{card.hint}</p>
          </article>
        ))}
      </div>

      <div className="summary-meta">
        <p>
          Showing {PERIOD_LABELS[period] ?? period} environmental scores
          {resolution === "day" ? " (daily averages of hourly scores)" : " (hourly)"}.
          Warehouse scores may lag live calculations.
          {scoreVersion ? ` Version ${scoreVersion}.` : ""}
        </p>
        {latestLabel && (
          <p>
            Latest scored interval: <strong>{latestLabel}</strong>
            {latestAge ? ` (${latestAge})` : ""}.
          </p>
        )}
      </div>
    </div>
  );
}
