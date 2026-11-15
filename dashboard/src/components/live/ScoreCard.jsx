import {
  ageMs,
  formatAge,
  formatChartTooltipTime,
} from "../../lib/format.js";
import {
  describeComponent,
  limitingFactor,
} from "../../lib/scoreDisplay.js";
import { scoreCategory } from "../../lib/scoreStats.js";

const COMPONENT_ORDER = [
  "air_temperature",
  "relative_humidity",
  "soil_moisture",
];

function buildComponentRows(components, readings) {
  return COMPONENT_ORDER.filter(
    (key) => components && key in components
  ).map((key) =>
    describeComponent({
      metric: key,
      reading: readings?.[key],
      score: components[key],
    })
  );
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
  const components = buildComponentRows(
    scorePayload?.components ?? {},
    scorePayload?.readings ?? {}
  );
  const gaugeWidth = available ? Math.min(100, Math.max(0, score)) : 0;
  const limiting = limitingFactor(scorePayload?.components ?? {});

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

          {available && limiting && (
            <p className="score-insight">{limiting}</p>
          )}

          {components.length > 0 && (
            <>
              <p className="score-components-hint">
                Factor scores are suitability out of 100, not the sensor
                reading.
              </p>
              <ul className="score-components">
                {components.map((row) => {
                  const width =
                    row.suitability === null
                      ? 0
                      : Math.min(100, Math.max(0, row.suitability));

                  return (
                    <li key={row.metric} className={`band-${row.bandKey}`}>
                      <div className="score-component-head">
                        <span className="score-component-label">{row.label}</span>
                        <span className="score-component-suitability">
                          {row.suitabilityLabel}
                        </span>
                      </div>
                      <p className="score-component-reading">
                        <span>{row.readingLabel}</span>
                        <span className="score-component-band">
                          {row.bandLabel}
                        </span>
                      </p>
                      <div
                        className="score-component-meter"
                        role="img"
                        aria-label={`${row.label} suitability ${row.suitabilityLabel}`}
                      >
                        <span style={{ width: `${width}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
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
