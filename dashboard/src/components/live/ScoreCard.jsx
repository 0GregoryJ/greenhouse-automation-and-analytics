import {
  ageMs,
  formatAge,
  formatChartTooltipTime,
} from "../../lib/format.js";
import {
  COMPONENT_LABELS,
  scoreCategory,
} from "../../lib/scoreStats.js";

function componentRows(components) {
  const order = ["air_temperature", "relative_humidity", "soil_moisture"];
  return order
    .filter((key) => components && key in components)
    .map((key) => ({
      key,
      label: COMPONENT_LABELS[key] ?? key,
      value: components[key],
    }));
}

export function ScoreCard({
  scorePayload,
  status,
  error,
  gatewayId,
  gateways,
  onGatewayChange,
  now,
}) {
  const score =
    scorePayload?.score === null || scorePayload?.score === undefined
      ? null
      : Number(scorePayload.score);
  const category = scoreCategory(score);
  const available = score !== null && Number.isFinite(score);
  const measuredAt = scorePayload?.measured_at;
  const age = measuredAt ? formatAge(ageMs(measuredAt, now)) : null;
  const components = componentRows(scorePayload?.components ?? {});
  const gaugeWidth = available ? Math.min(100, Math.max(0, score)) : 0;

  return (
    <article
      className={`score-card score-${category.key}`}
      aria-label="Environmental conditions score"
    >
      <header className="score-card-head">
        <div>
          <p className="score-eyebrow">Environmental conditions</p>
          <h2 className="score-title">Conditions score</h2>
        </div>

        {gateways.length > 1 && (
          <label className="control score-gateway">
            <span className="control-label">Gateway</span>
            <select
              value={gatewayId ?? ""}
              onChange={(event) => onGatewayChange(event.target.value)}
            >
              {gateways.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {status === "loading" && !scorePayload && (
        <p className="score-muted">Loading score…</p>
      )}

      {error && !scorePayload && (
        <p className="score-muted" role="status">
          Score unavailable right now. Live readings below are unaffected.
        </p>
      )}

      {scorePayload && (
        <>
          <div className="score-main">
            <p className="score-value">
              {available ? (
                <>
                  <span className="score-number">{Math.round(score)}</span>
                  <span className="score-denom">/100</span>
                </>
              ) : (
                <span className="score-number score-unavailable-text">—</span>
              )}
            </p>
            <div className="score-meta-block">
              <span className={`pill pill-score-${category.key}`}>
                <span className="pill-dot" />
                {available
                  ? category.label
                  : scorePayload.status === "stale_or_unsynchronized"
                    ? "Stale or unsynchronized"
                    : "Insufficient data"}
              </span>
              {scorePayload.score_version && (
                <span className="score-version">{scorePayload.score_version}</span>
              )}
            </div>
          </div>

          <div
            className="score-gauge"
            role="img"
            aria-label={
              available
                ? `Score ${Math.round(score)} out of 100`
                : "Score unavailable"
            }
          >
            <span
              className={available ? "is-filled" : "is-empty"}
              style={{ width: `${gaugeWidth}%` }}
            />
          </div>

          {components.length > 0 && (
            <ul className="score-components">
              {components.map((row) => (
                <li key={row.key}>
                  <span>{row.label}</span>
                  <strong>
                    {row.value === null || row.value === undefined
                      ? "—"
                      : Math.round(Number(row.value))}
                  </strong>
                </li>
              ))}
            </ul>
          )}

          <p className="score-footnote">
            Suitability vs configured targets — not verified plant health.
            Soil moisture calibration is provisional.
            {measuredAt && (
              <>
                {" "}
                Measured {formatChartTooltipTime(measuredAt, "hour")}
                {age ? ` (${age})` : ""}.
              </>
            )}
            {gateways.length === 1 && gatewayId && (
              <> Gateway {gatewayId}.</>
            )}
          </p>
        </>
      )}
    </article>
  );
}
